/**
 * Launcher specs (§5 launcher obligations): drive scripts/grok-review-run.mjs
 * as a REAL spawned node subprocess against a FAKE grok stub — never the
 * real CLI, never the real ~/.grok — plus injected-deps unit rows for the
 * deterministic seams (formatter, cost line, buildChildEnv, bounded prompt
 * read, sync/sweep, the §3.1-T termination machine) and real-signaling
 * subprocess rows for the group-kill ones.
 *
 * Staging contract (load-bearing): the launcher runs with cwd = <mkdtemp>/ws
 * and TMPDIR = <mkdtemp>/var, HOME = <mkdtemp>/home. Its writable-root set is
 * therefore {ws, mkdtemp/var, realpath('/tmp')} while the stub bin dir lives
 * under the repo tests dir, outside all three — which is what arms the
 * CLI-path validation. All test writes land in {repo tests/.runtime, mkdtemp}
 * so the suite stays green under the dsh workspace-write sandbox.
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  baseEnv,
  cleanupStages,
  homePathsFor,
  LAUNCHER,
  newStage,
  readCaptures,
  RUNTIME_DIR,
  spawnLauncher,
  waitFor,
} from './helpers.js'
import { buildChildEnv, sweepHome, syncCredentials } from '../scripts/lib/home.mjs'
import { costLine, formatOutput, readPromptFile, runLauncher, STDOUT_CAP, writableRoots } from '../scripts/grok-review-run.mjs'

const LONG = 90_000 // loaded full-suite runs stall process startup; keep generous

function fakeChild(): EventEmitter & { pid: number; stdout: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter }
  child.pid = 424242
  child.stdout = new EventEmitter()
  return child
}

describe('grok-review-run launcher — integration (real subprocess, staged stub)', () => {
  let stage: ReturnType<typeof newStage>

  afterEach(() => cleanupStages())
  afterAll(() => rmSync(RUNTIME_DIR, { recursive: true, force: true }))
  // TEMP CI diagnostic (PR #166 forks-worker teardown hang): dump handle
  // classes AND the leaked child process identity. Remove once root-caused.
  afterAll(() => {
    if (process.env.CI) {
      const handles = (process as never as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []
      const detail = handles.map((h) => {
        const rec = h as Record<string, unknown>
        const ctor = (h as { constructor?: { name?: string } })?.constructor?.name
        if (ctor === 'ChildProcess') {
          return { ctor, pid: rec.pid, spawnfile: rec.spawnfile, spawnargsTail: (rec.spawnargs as string[] | undefined)?.slice(-3), killed: rec.killed, exitCode: rec.exitCode ?? null }
        }
        if (ctor === 'Pipe' || ctor === 'Socket') return { ctor, fd: (rec as { fd?: unknown }).fd ?? null }
        return { ctor }
      })
      console.error('CI-HANDLE-DUMP', JSON.stringify(detail))
    }
  })

  it('happy path fresh: exact argv (no --cwd, -p prompt last), GROK_HOME shadow, spawn cwd, exit 0, .text printed, auth 0600, prompt shadow unlinked', async () => {
    stage = newStage()
    const prompt = 'review the failing spec'
    const run = await spawnLauncher(['--', prompt], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(run.code, run.stderr).toBe(0)
    const { H } = homePathsFor(stage)
    const captures = readCaptures(stage)
    expect(captures).toHaveLength(1)
    expect(captures[0].argv).toEqual([
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'json',
      '-p',
      prompt,
    ])
    expect(captures[0].cwd).toBe(realpathSync(stage.ws))
    expect(captures[0].grokHome).toBe(H)
    expect(run.stdout).toContain('REVIEW TEXT')
    expect(statSync(`${H}/auth.json`).mode & 0o777).toBe(0o600)
    expect(existsSync(`${H}/.lock`)).toBe(false) // released
    expect(existsSync(`${H}/.prompt-current.txt`)).toBe(false) // unlinked in finalize
    expect(run.stderr).toContain('grok-review: session=sess-abc123 cost_usd=0.42 turns=3')
  }, LONG)

  it('resume shape: --last produces -c between --output-format json and -p, in that order', async () => {
    stage = newStage()
    const run = await spawnLauncher(['--last', '--', 'continue the review'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(run.code, run.stderr).toBe(0)
    const argv = readCaptures(stage)[0].argv
    expect(argv.slice(-5)).toEqual(['--output-format', 'json', '-c', '-p', 'continue the review'])
  }, LONG)

  it('--prompt-file: the bridge-owned shadow path reaches grok; over-cap and symlink prompt-files fail loud', async () => {
    stage = newStage()
    const p = `${stage.ws}/p.txt`
    writeFileSync(p, 'multi\nline\nprompt\n')
    const ok = await spawnLauncher(['--prompt-file', p], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(ok.code, ok.stderr).toBe(0)
    const { H } = homePathsFor(stage)
    expect(readCaptures(stage)[0].argv.slice(-2)).toEqual(['--prompt-file', `${H}/.prompt-current.txt`])

    stage = newStage()
    const big = `${stage.ws}/big.txt`
    writeFileSync(big, 'x'.repeat(262144 + 1))
    const over = await spawnLauncher(['--prompt-file', big], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(over.code).not.toBe(0)
    expect(over.stderr).toMatch(/exceeds the 262144-byte cap/)

    stage = newStage()
    const real = `${stage.ws}/real.txt`
    const link = `${stage.ws}/link.txt`
    writeFileSync(real, 'secret\n')
    symlinkSync(real, link)
    const sym = await spawnLauncher(['--prompt-file', link], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(sym.code).not.toBe(0)
    expect(sym.stderr).toMatch(/prompt-file/)
  }, LONG)

  it('D10 child env: GROK_HOME set; scrub triple absent; XAI_API_KEY preserved; caller env object unchanged', async () => {
    stage = newStage()
    const env = baseEnv(stage, {
      GROK_SESSION_ID: 'leak-session',
      GROK_AGENT: 'leak-agent',
      GROK_SANDBOX: 'bogus-name',
      XAI_API_KEY: 'xai-live-key',
    })
    const run = await spawnLauncher(['--', 'env-proof'], { cwd: stage.ws, env }).done
    expect(run.code, run.stderr).toBe(0)
    const { H } = homePathsFor(stage)
    const cap = readCaptures(stage)[0]
    expect(cap.grokHome).toBe(H)
    expect(cap.sessionIdEnv).toBeUndefined()
    expect(cap.sandboxEnv).toBeUndefined()
    expect(cap.xaiKey).toBe('xai-live-key')
    expect(env.GROK_HOME).toBeUndefined() // caller's env object untouched
    expect(env.GROK_SESSION_ID).toBe('leak-session')
  }, LONG)

  it('formatter: malformed stdout passes through verbatim; error-doc + exit 1 preserves raw bytes and the child exit code', async () => {
    stage = newStage()
    const malformed = await spawnLauncher(['--', 'm'], {
      cwd: stage.ws,
      env: baseEnv(stage, { GROK_STUB_MODE: 'malformed' }),
    }).done
    expect(malformed.stdout).toBe('not json at all\n')
    expect(malformed.stderr).not.toContain('session=')

    stage = newStage()
    const errDoc = await spawnLauncher(['--', 'e'], {
      cwd: stage.ws,
      env: baseEnv(stage, { GROK_STUB_MODE: 'error-doc' }),
    }).done
    expect(errDoc.code).toBe(1) // exit code is always the child's
    const parsed = JSON.parse(errDoc.stdout.trim()) as { type: string; message: string }
    expect(parsed.type).toBe('error')
    expect(parsed.message).toContain('FS_PERMISSION_DENIED')
  }, LONG)

  it('unit formatter table (formatOutput): parse+text / empty text / newline normalization / malformed / primitive / array / null / object-without-text', () => {
    expect(formatOutput(Buffer.from(JSON.stringify({ text: 'hello' })))).toBe('hello\n')
    expect(formatOutput(Buffer.from(JSON.stringify({ text: '' })))).toBe('\n')
    expect(formatOutput(Buffer.from(JSON.stringify({ text: 'ends\n' })))).toBe('ends\n')
    expect(formatOutput(Buffer.from('not json'))).toEqual(Buffer.from('not json'))
    expect(formatOutput(Buffer.from('42'))).toEqual(Buffer.from('42'))
    expect(formatOutput(Buffer.from('[1,2]'))).toEqual(Buffer.from('[1,2]'))
    expect(formatOutput(Buffer.from('null'))).toEqual(Buffer.from('null'))
    expect(formatOutput(Buffer.from(JSON.stringify({ other: 1 })))).toEqual(Buffer.from(JSON.stringify({ other: 1 })))
  })

  it('unit cost-line mapping: control-strip, 64-char cap, type drops', () => {
    expect(costLine({ sessionId: 's', total_cost_usd: 1.5, num_turns: 2 })).toBe(
      'grok-review: session=s cost_usd=1.5 turns=2',
    )
    // control chars stripped, capped at 64
    const longId = 'a'.repeat(70) + '\u0007x'
    const line = costLine({ sessionId: longId })!
    expect(line).toBe(`grok-review: session=${'a'.repeat(64)}`)
    expect(line).not.toContain('\u0007')
    // absent/invalid fields dropped
    expect(costLine({})).toBe(null)
    expect(costLine({ sessionId: null, total_cost_usd: 'x', num_turns: 'y' })).toBe(null)
    expect(costLine('str')).toBe(null)
  })

  it('argv-shape errors and dash-leading prompts exit 2 with usage on stderr', async () => {
    stage = newStage()
    const trailing = await spawnLauncher(['--', 'a', 'b'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(trailing.code).toBe(2)
    expect(trailing.stderr).toMatch(/usage:/)

    stage = newStage()
    const empty = await spawnLauncher(['--'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(empty.code).toBe(2)
    expect(empty.stderr).toMatch(/usage:/)

    stage = newStage()
    const dash = await spawnLauncher(['--', '-restart-from-scratch'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(dash.code).toBe(2)
    expect(dash.stderr).toMatch(/dash-leading-inline-prompt/)
  }, LONG)

  it('grok absent from PATH fails loud; a stub inside a writable root is refused; errors carry the grok-review: prefix', async () => {
    stage = newStage()
    const noPath = baseEnv(stage)
    noPath.PATH = '/nonexistent-dir'
    const absent = await spawnLauncher(['--', 'no-cli'], { cwd: stage.ws, env: noPath }).done
    expect(absent.code).not.toBe(0)
    expect(absent.stderr).toMatch(/grok-review: grok CLI not found on PATH outside the writable roots/)

    stage = newStage()
    const inRootBin = `${stage.varDir}/bin`
    mkdirSync(inRootBin)
    writeFileSync(`${inRootBin}/grok`, '#!/usr/bin/env node\n', { mode: 0o755 })
    const env = baseEnv(stage)
    env.PATH = inRootBin
    const refused = await spawnLauncher(['--', 'in-root'], { cwd: stage.ws, env }).done
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toMatch(/grok CLI/)
  }, LONG)

  it('lock: second concurrent launch fails; stale lock (>6h) is reclaimed', async () => {
    stage = newStage()
    const { H } = homePathsFor(stage)
    const sleeperEnv = baseEnv(stage, { GROK_STUB_SLEEP_MS: '2500' })
    const first = spawnLauncher(['--', 'hold'], { cwd: stage.ws, env: sleeperEnv, exitOnly: true })
    await waitFor(() => existsSync(`${H}/.lock`))
    const second = await spawnLauncher(['--', 'blocked'], { cwd: stage.ws, env: baseEnv(stage), exitOnly: true }).done
    expect(second.code).not.toBe(0)
    expect(second.stderr).toMatch(/\.lock/)
    expect((await first.done).code).toBe(0)
    await waitFor(() => !existsSync(`${H}/.lock`))

    stage = newStage()
    const staleH = homePathsFor(stage)
    mkdirSync(staleH.R, { recursive: true, mode: 0o700 })
    mkdirSync(staleH.H, { recursive: true, mode: 0o700 })
    mkdirSync(`${staleH.H}/.lock`)
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000)
    utimesSync(`${staleH.H}/.lock`, old, old)
    const reclaimed = await spawnLauncher(['--', 'after-stale'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(reclaimed.code).toBe(0)
  }, LONG)

  it('sync: tampered H copy overwritten; missing source deletes copy + warns; XAI_API_KEY suppresses the warn; symlink source fails loud', async () => {
    stage = newStage()
    const { H } = homePathsFor(stage)
    const one = await spawnLauncher(['--', 'one'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(one.code, one.stderr).toBe(0)
    writeFileSync(`${H}/auth.json`, 'TAMPERED')
    const two = await spawnLauncher(['--', 'two'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(two.code, two.stderr).toBe(0)
    expect(readFileSync(`${H}/auth.json`, 'utf8')).toBe('{"fake":"auth"}\n')

    stage = newStage()
    rmSync(`${stage.fakeHome}/.grok/auth.json`)
    const gone = await spawnLauncher(['--', 'no-auth'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(gone.code).toBe(0)
    expect(gone.stderr).toMatch(/missing\/unreadable|removed shadow copy/)
    expect(existsSync(`${homePathsFor(stage).H}/auth.json`)).toBe(false)

    stage = newStage()
    rmSync(`${stage.fakeHome}/.grok/auth.json`)
    const keyed = await spawnLauncher(['--', 'keyed'], {
      cwd: stage.ws,
      env: baseEnv(stage, { XAI_API_KEY: 'ambient' }),
    }).done
    expect(keyed.code).toBe(0)
    expect(keyed.stderr).not.toMatch(/removed shadow copy/)

    stage = newStage()
    rmSync(`${stage.fakeHome}/.grok/auth.json`)
    symlinkSync('/etc/hosts', `${stage.fakeHome}/.grok/auth.json`)
    const sym = await spawnLauncher(['--', 'sym-auth'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(sym.code).not.toBe(0)
    expect(sym.stderr).toMatch(/regular file/)
  }, LONG)

  it('D14 sweep: unknown file/dir/symlink swept; sessions symlink swept vs real dir kept; .lock survives the sweep', () => {
    stage = newStage()
    const { H } = homePathsFor(stage)
    mkdirSync(H, { recursive: true, mode: 0o700 })
    writeFileSync(`${H}/junk-file`, 'x')
    mkdirSync(`${H}/junk-dir`, { recursive: true })
    symlinkSync('/etc/hosts', `${H}/junk-link`)
    mkdirSync(`${H}/sessions`, { recursive: true }) // real dir kept
    mkdirSync(`${H}/.lock`) // the held lock survives
    sweepHome(H)
    expect(existsSync(`${H}/junk-file`)).toBe(false)
    expect(existsSync(`${H}/junk-dir`)).toBe(false)
    expect(existsSync(`${H}/junk-link`)).toBe(false)
    expect(existsSync(`${H}/sessions`)).toBe(true)
    expect(existsSync(`${H}/.lock`)).toBe(true)

    // `sessions` as a symlink (foreign type) is swept
    rmSync(`${H}/sessions`, { recursive: true })
    symlinkSync('/etc', `${H}/sessions`)
    sweepHome(H)
    expect(existsSync(`${H}/sessions`)).toBe(false)
  	rmSync(`${H}/.lock`, { recursive: true })
  })

  it('orphan-marker rows: marker present → refusal; marker + sweepable junk → refusal wins and the junk is NOT swept (step-5-before-step-6)', async () => {
    stage = newStage()
    const { H } = homePathsFor(stage)
    mkdirSync(H, { recursive: true, mode: 0o700 })
    writeFileSync(`${H}/.orphaned`, 'reap-budget-expired earlier\n', { mode: 0o600 })
    writeFileSync(`${H}/junk`, 'planted')
    const refused = await spawnLauncher(['--', 'poisoned'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(refused.code).toBe(1)
    expect(refused.stderr).toMatch(/H\/\.orphaned/)
    // the step-6 sweep never ran: the junk is still there
    expect(existsSync(`${H}/junk`)).toBe(true)
    expect(readFileSync(`${H}/.orphaned`, 'utf8')).toContain('reap-budget-expired')
  }, LONG)

  it('planted auth.json DIRECTORY is removed by the sweep, then re-synced by the run', async () => {
    stage = newStage()
    const { R, H } = homePathsFor(stage)
    mkdirSync(R, { recursive: true, mode: 0o700 })
    mkdirSync(H, { recursive: true, mode: 0o700 })
    mkdirSync(`${H}/auth.json`) // foreign type inside an already-0700 home
    const run = await spawnLauncher(['--', 'planted'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(run.code, run.stderr).toBe(0)
    expect(statSync(`${H}/auth.json`).isFile()).toBe(true)
  }, LONG)

  it('ownership/mode: H chmod 0755 fails loud; R symlink fails loud (root-guard early-return)', async () => {
    if (process.getuid?.() === 0) return
    stage = newStage()
    const { R, H } = homePathsFor(stage)
    mkdirSync(R, { recursive: true, mode: 0o700 })
    mkdirSync(H, { recursive: true, mode: 0o700 })
    chmodSync(H, 0o755)
    const bad = await spawnLauncher(['--', 'bad-mode'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toMatch(/0700|mode/)

    stage = newStage()
    const R2 = homePathsFor(stage).R
    const target = `${stage.mkd}/r-target`
    mkdirSync(target)
    rmSync(R2, { force: true })
    symlinkSync(target, R2)
    const sym = await spawnLauncher(['--', 'sym-root'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(sym.code).not.toBe(0)
    expect(sym.stderr).toMatch(/symlink/)
  }, LONG)

  it('16 MiB stdout cap: breach byte triggers termination, cap message, exit 1', async () => {
    stage = newStage()
    const run = await spawnLauncher(['--', 'big'], {
      cwd: stage.ws,
      env: baseEnv(stage, { GROK_STUB_MODE: 'big' }),
    }).done
    expect(run.code).toBe(1)
    expect(run.stderr).toContain('grok-review: grok stdout exceeded the 16 MiB capture cap')
    expect(run.stdout).toBe('')
  }, LONG)

  it('T10-class: SIGKILL of the launcher leaves the lock for stale reclaim and writes NO orphan marker', async () => {
    stage = newStage()
    const { H } = homePathsFor(stage)
    const pidFile = `${stage.mkd}/stub.pid`
    const sleeperEnv = baseEnv(stage, { GROK_STUB_SLEEP_MS: '8000', GROK_STUB_PIDFILE: pidFile })
    const victim = spawnLauncher(['--', 'killed'], { cwd: stage.ws, env: sleeperEnv, exitOnly: true })
    await waitFor(() => existsSync(`${H}/.lock`) && existsSync(pidFile))
    victim.child.kill('SIGKILL')
    const killed = await victim.done
    expect(killed.code !== null || killed.signal !== null).toBe(true)
    expect(existsSync(`${H}/.lock`)).toBe(true) // lock remains until >6h stale reclaim
    expect(existsSync(`${H}/.orphaned`)).toBe(false) // nothing observed the death
    // Hygiene, not assertion: the hard-killed launcher's group-leader stub
    // would sleep out the 8 s holding our stdout/stderr pipes open, which
    // hangs the vitest forks-pool teardown (CI red of PR #166, first run).
    // Free the streams and drain the zombie deterministically before leaving.
    victim.child.stdout?.destroy()
    victim.child.stderr?.destroy()
    const stubPid = Number(readFileSync(pidFile, 'utf8').trim())
    await waitFor(() => {
      try {
        process.kill(stubPid, 0)
        return false
      } catch {
        return true
      }
    })
  }, LONG)

  it('T5/T6 real signaling: SIGTERM to a running launcher exits 130, the TERM-ignoring stub only dies at the SIGKILL grace, and the lock is released', async () => {
    stage = newStage()
    const { H } = homePathsFor(stage)
    const pidFile = `${stage.mkd}/stub.pid`
    const sleeperEnv = baseEnv(stage, {
      GROK_STUB_SLEEP_MS: '9000',
      GROK_STUB_IGNORE_TERM: '1',
      GROK_STUB_PIDFILE: pidFile,
    })
    const victim = spawnLauncher(['--', 'sigterm-me'], { cwd: stage.ws, env: sleeperEnv, exitOnly: true })
    await waitFor(() => existsSync(`${H}/.lock`) && existsSync(`${stage.mkd}/stub.pid`))
    victim.child.kill('SIGTERM')
    const done = await victim.done
    // uniform-cancelled: 130 (deliberate, per §3.1-T T6)
    expect(done.code).toBe(130)
    // the stub (group member) was killed — the pid is gone
    const stubPid = Number(readFileSync(`${stage.mkd}/stub.pid`, 'utf8').trim())
    let alive = true
    try {
      process.kill(stubPid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
    await waitFor(() => !existsSync(`${H}/.lock`))
  }, LONG)
})

describe('grok-review-run — unit seams (injected deps)', () => {
  afterEach(() => {
    cleanupStages()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function depsFor(s: ReturnType<typeof newStage>, over: Record<string, unknown> = {}) {
    return {
      cwd: () => s.ws,
      tmpdir: () => s.varDir,
      homedir: () => s.fakeHome,
      env: { ...baseEnv(s) },
      ...over,
    }
  }

  it('buildChildEnv unit rows: scrub triple, GROK_HOME set, XAI_API_KEY preserved, no mutation', () => {
    const env = { A: '1', GROK_SESSION_ID: 's', GROK_AGENT: 'a', GROK_SANDBOX: 'x', XAI_API_KEY: 'k' }
    const built = buildChildEnv(env, '/tmp/H')
    expect(built).toEqual({ A: '1', XAI_API_KEY: 'k', GROK_HOME: '/tmp/H' })
    expect(built).not.toBe(env)
    expect(env.GROK_SESSION_ID).toBe('s') // caller object untouched
  })

  it('writableRoots: unrealpathable entries are skipped', () => {
    const roots = writableRoots('/definitely/not/here/nope', tmpdir())
    // the absent cwd root is skipped; tmp + /tmp still confine
    expect(roots.length).toBe(2)
  })

  it('readPromptFile injected ops: a file grown past the cap still dies (cap enforced by the read)', () => {
    let reads = 0
    const io = {
      openSync: () => 7,
      fstatSync: () => ({ isFile: () => true, size: 10 }),
      readSync: (_fd: number, buf: Buffer) => {
        if (reads++ < 5) {
          buf.set(Buffer.alloc(buf.length, 0x78))
          return buf.length
        }
        return 0
      },
      closeSync: () => {},
    }
    expect(() => readPromptFile('/fake', io as never)).toThrow(/exceeds the 262144-byte cap/)
  })

  it('syncCredentials injected ops: post-open fstat swap aborts; rename failure unlinks the .tmp residue; EACCES class deletes shadow (warn gating per XAI_API_KEY)', () => {
    const stage = newStage()
    const { H } = homePathsFor(stage)
    mkdirSync(homePathsFor(stage).R, { recursive: true, mode: 0o700 })
    mkdirSync(H, { recursive: true, mode: 0o700 })
    writeFileSync(join(stage.fakeHome, '.grok', 'auth.json'), '{"k":1}\n')
    const rmList: string[] = []
    const baseIo = {
      lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      openSync: () => 7,
      closeSync: () => {},
      readFileSync: () => Buffer.from('x'),
      writeSync: () => {},
      fsyncSync: () => {},
      renameSync: () => {},
      rmSync: (p: string) => rmList.push(p),
    }
    // post-open fstat recheck: the fd reports a non-regular file → abort
    expect(() =>
      syncCredentials(H, { home: stage.fakeHome, env: {}, io: { ...baseIo, fstatSync: () => ({ isFile: () => false }) } as never }),
    ).toThrow(/regular file/)

    // rename failure → the tracked .tmp path is unlinked, error aborts
    expect(() =>
      syncCredentials(H, {
        home: stage.fakeHome,
        env: {},
        io: {
          ...baseIo,
          fstatSync: () => ({ isFile: () => true }),
          renameSync: () => {
            throw new Error('rename failed')
          },
        } as never,
      }),
    ).toThrow(/rename failed/)
    expect(rmList.some((p) => p.includes('/.tmp-'))).toBe(true)

    // EACCES-class lstat failure → delete shadow + warn, proceed
    const io4 = {
      ...baseIo,
      lstatSync: () => {
        const e: NodeJS.ErrnoException = new Error('denied')
        e.code = 'EACCES'
        throw e
      },
      rmSync: (p: string, o?: never) => { rmSync(p, o ?? { force: true }) },
    }
    rmSync(`${H}/auth.json`, { force: true })
    writeFileSync(`${H}/auth.json`, 'SHADOW')
    const warns: string[] = []
    syncCredentials(H, { home: stage.fakeHome, env: {}, warn: (m: string) => warns.push(m), io: io4 as never })
    expect(existsSync(`${H}/auth.json`)).toBe(false)
    expect(warns[0]).toMatch(/removed shadow copy/)

    // XAI_API_KEY set suppresses the warn
    const warns2: string[] = []
    writeFileSync(`${H}/auth.json`, 'SHADOW2')
    syncCredentials(H, { home: stage.fakeHome, env: { XAI_API_KEY: 'k' }, warn: (m: string) => warns2.push(m), io: io4 as never })
    expect(existsSync(`${H}/auth.json`)).toBe(false)
    expect(warns2).toHaveLength(0)
  })

  it('T5 (injected): a signal with no child finalizes 130 before the home is prepared and never spawns', async () => {
    const stage = newStage()
    const exits: Array<number | undefined> = []
    let spawned = 0
    let tmpdirCalls = 0
    await runLauncher(['--', 'sig'], {
      ...depsFor(stage, {
        // Throw on the tmpdir call INSIDE the try region (prepareHome) — the
        // step-2 writableRoots call already consumed the first one.
        tmpdir: () => {
          if (tmpdirCalls++ > 0) throw new Error('blocked after registration')
          return stage.varDir
        },
      }),
      // Deliver the signal the moment registration completes (INIT state).
      onSignal: (h: () => void) => {
        h()
        return () => {}
      },
      spawn: () => {
        spawned++
        return fakeChild()
      },
      exitWith: (c: number | undefined) => exits.push(c),
    } as never)
    expect(spawned).toBe(0)
    expect(exits).toEqual([130])
  })

  it('T6 (injected): signal in RUNNING sends the group SIGTERM, exits 130, prints nothing of the capture', async () => {
    const stage = newStage()
    const child = fakeChild()
    const kills: Array<number | string> = []
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string) => {
      kills.push(sig ?? 0)
      return true
    }) as never)
    const errs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => errs.push(String(m)))
    const exits: Array<number | undefined> = []
    let signalHandler: (() => void) | null = null
    const p = runLauncher(['--', 'sig-run'], {
      ...depsFor(stage),
      onSignal: (h: () => void) => {
        signalHandler = h
        return () => {}
      },
      spawn: () => child,
      exitWith: (c: number | undefined) => exits.push(c),
    } as never)
    await Promise.resolve()
    await Promise.resolve()
    child.stdout.emit('data', Buffer.from('partial'))
    signalHandler!()
    child.emit('close', null, 'SIGTERM')
    await p
    expect(kills).toContain('SIGTERM')
    expect(exits[0]).toBe(130)
    expect(exits).toHaveLength(1)
  })

  it('T7 (injected): a second signal while terminating escalates straight to SIGKILL', async () => {
    const stage = newStage()
    const child = fakeChild()
    const kills: Array<number | string> = []
    vi.spyOn(process, 'kill').mockImplementation(((_pid: number, sig?: string) => {
      if (sig) kills.push(sig)
      return true
    }) as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exits: Array<number | undefined> = []
    let signalHandler: (() => void) | null = null
    const p = runLauncher(['--', 'double-sig'], {
      ...depsFor(stage),
      onSignal: (h: () => void) => {
        signalHandler = h
        return () => {}
      },
      spawn: () => child,
      exitWith: (c: number | undefined) => exits.push(c),
    } as never)
    await Promise.resolve()
    await Promise.resolve()
    signalHandler!()
    signalHandler!()
    expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
    child.emit('close', null, 'SIGKILL')
    await p
    expect(exits[0]).toBe(130)
  })

  it('T9 (injected, fake timers): reap budget expiry writes the orphan marker, force-finishes, keeps the initiating row code', async () => {
    vi.useFakeTimers()
    const stage = newStage()
    const child = fakeChild()
    vi.spyOn(process, 'kill').mockImplementation(() => true)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const exits: Array<number | undefined> = []
    let signalHandler: (() => void) | null = null
    const { H } = homePathsFor(stage)
    mkdirSync(homePathsFor(stage).R, { recursive: true, mode: 0o700 })
    const p = runLauncher(['--', 'budget'], {
      ...depsFor(stage),
      onSignal: (h: () => void) => {
        signalHandler = h
        return () => {}
      },
      spawn: () => child,
      exitWith: (c: number | undefined) => exits.push(c),
    } as never)
    await Promise.resolve()
    await Promise.resolve()
    signalHandler!()
    await vi.advanceTimersByTimeAsync(5000) // the 5 s total reap budget
    await p
    expect(existsSync(`${H}/.orphaned`)).toBe(true)
    expect(readFileSync(`${H}/.orphaned`, 'utf8')).toContain('reap-budget-expired')
    expect(exits[0]).toBe(130)
    // and the next launch is refused by the marker (step-5 gate)
    const exits2: Array<number | undefined> = []
    await runLauncher(['--', 'gated'], {
      ...depsFor(stage),
      spawn: () => {
        throw new Error('must not spawn past the marker gate')
      },
      exitWith: (c: number | undefined) => exits2.push(c),
    } as never)
    expect(exits2).toContain(1)
  })

  it('T3 (injected): null-code close without terminate prints the signal message and exits 1, nothing of the capture', async () => {
    const stage = newStage()
    const child = fakeChild()
    const errs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => errs.push(String(m)))
    const exits: Array<number | undefined> = []
    const p = runLauncher(['--', 'sig-close'], {
      ...depsFor(stage),
      spawn: () => child,
      exitWith: (c: number | undefined) => exits.push(c),
    } as never)
    await Promise.resolve()
    await Promise.resolve()
    child.stdout.emit('data', Buffer.from('partial capture'))
    child.emit('close', null, 'SIGKILL')
    await p
    expect(exits[0]).toBe(1)
    expect(errs.some((m) => m.includes('grok-review: grok terminated by signal SIGKILL'))).toBe(true)
  })

  it('T4 (injected): stdout-cap breach terminates the group and exits 1 with the cap message', async () => {
    const stage = newStage()
    const child = fakeChild()
    const kills: Array<number | string> = []
    vi.spyOn(process, 'kill').mockImplementation(((_pid: number, sig?: string) => {
      if (sig) kills.push(sig)
      return true
    }) as never)
    const errs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => errs.push(String(m)))
    const exits: Array<number | undefined> = []
    const p = runLauncher(['--', 'cap'], {
      ...depsFor(stage),
      spawn: () => child,
      exitWith: (c: number | undefined) => exits.push(c),
    } as never)
    await Promise.resolve()
    await Promise.resolve()
    child.stdout.emit('data', Buffer.alloc(STDOUT_CAP + 8, 0x78))
    child.emit('close', null, 'SIGTERM') // the cap reap lands as a signal close
    await p
    expect(errs.some((m) => m.includes('16 MiB capture cap'))).toBe(true)
    expect(exits[0]).toBe(1)
    expect(kills).toContain('SIGTERM')
  })

  it('T8 (injected): spawn error event → exit 1 with the grok-review: prefix', async () => {
    const stage = newStage()
    const child = fakeChild()
    const errs: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => errs.push(String(m)))
    const exits: Array<number | undefined> = []
    const p = runLauncher(['--', 'spawn-err'], {
      ...depsFor(stage),
      spawn: () => child,
      exitWith: (c: number | undefined) => exits.push(c),
    } as never)
    await Promise.resolve()
    await Promise.resolve()
    child.emit('error', new Error('boom'))
    await p
    expect(exits[0]).toBe(1)
    expect(errs.some((m) => m.includes('grok-review: spawn failed: boom'))).toBe(true)
  })

  it('T1 (injected): a lock-held launch fails closed with exit 1 and never spawns', async () => {
    const stage = newStage()
    const { R, H } = homePathsFor(stage)
    mkdirSync(R, { recursive: true, mode: 0o700 })
    mkdirSync(H, { recursive: true, mode: 0o700 })
    mkdirSync(`${H}/.lock`) // lock held by "another run" → acquireLock throws
    let spawnedCount = 0
    const exits: Array<number | undefined> = []
    await runLauncher(['--', 'x'], {
      ...depsFor(stage),
      spawn: () => {
        spawnedCount++
        return fakeChild()
      },
      exitWith: (c: number | undefined) => exits.push(c),
    } as never)
    expect(spawnedCount).toBe(0)
    expect(exits).toContain(1)
  })
})
