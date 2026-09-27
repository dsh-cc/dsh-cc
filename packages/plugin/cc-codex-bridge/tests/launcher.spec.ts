/**
 * Launcher specs (§5 launcher obligations): drive scripts/codex-rescue-run.mjs
 * as a REAL spawned node subprocess against a FAKE codex stub — never the
 * real CLI, never the real ~/.codex.
 *
 * Staging contract (load-bearing): the launcher runs with cwd = <mkdtemp>/ws
 * and TMPDIR = <mkdtemp>/var, HOME = <mkdtemp>/home. Its writable-root set is
 * therefore {ws, mkdtemp/var, realpath('/tmp')} while the stub bin dir lives
 * under the repo tests dir, outside all three — which is what arms the
 * CLI-path validation. All test writes land in {repo tests/.runtime, mkdtemp}
 * so the suite stays green under the dsh workspace-write sandbox.
 */
import { existsSync, mkdirSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
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
  type Stage,
} from './helpers.js'

const LONG = 90_000 // loaded full-suite runs stall process startup; keep generous (presubmit flake evidence 2026-09-26)

describe('codex-rescue-run launcher', () => {
  let stage: Stage

  afterEach(() => cleanupStages())
  afterAll(() => rmSync(RUNTIME_DIR, { recursive: true, force: true }))

  it('happy path fresh: exact argv, stdin EOF, CODEX_HOME, exit 0, last-message printed, creds synced 0600', async () => {
    stage = newStage()
    const prompt = '-top-priority: fix the failing spec'
    const run = await spawnLauncher(['--', prompt], {
      cwd: stage.ws,
      env: baseEnv(stage),
    }).done
    expect(run.code).toBe(0)
    const { H } = homePathsFor(stage)
    const captures = readCaptures(stage)
    expect(captures).toHaveLength(1)
    expect(captures[0].argv).toEqual([
      'exec',
      '--sandbox',
      'danger-full-access',
      '--cd',
      realpathSync(stage.ws),
      '-o',
      `${H}/last-message.txt`,
      '-',
    ])
    expect(captures[0].stdin).toBe(prompt)
    expect(captures[0].codexHome).toBe(H)
    expect(run.stdout).toContain('STUB LAST MESSAGE')
    expect(statSync(`${H}/auth.json`).mode & 0o777).toBe(0o600)
    expect(readFileSync(`${H}/config.toml`, 'utf8')).toBe('fake = true\n')
    expect(existsSync(`${H}/.lock`)).toBe(false) // released
  }, LONG)

  it('resume shape: --last produces `resume --last -` in that order at the end', async () => {
    stage = newStage()
    const run = await spawnLauncher(['--last', '--', 'continue'], {
      cwd: stage.ws,
      env: baseEnv(stage),
    }).done
    expect(run.code).toBe(0)
    const argv = readCaptures(stage)[0].argv
    expect(argv.slice(-3)).toEqual(['resume', '--last', '-'])
  }, LONG)

  it('--prompt-file: content reaches stdin; over-cap and symlink prompt-files fail loud', async () => {
    stage = newStage()
    const p = `${stage.ws}/p.txt`
    writeFileSync(p, 'multi\nline\nprompt\n')
    const ok = await spawnLauncher(['--prompt-file', p], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(ok.code).toBe(0)
    expect(readCaptures(stage)[0].stdin).toBe('multi\nline\nprompt\n')

    stage = newStage()
    const big = `${stage.ws}/big.txt`
    writeFileSync(big, 'x'.repeat(256 * 1024 + 1))
    const over = await spawnLauncher(['--prompt-file', big], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(over.code).not.toBe(0)
    expect(over.stderr).toMatch(/exceeds/)

    stage = newStage()
    const real = `${stage.ws}/real.txt`
    const link = `${stage.ws}/link.txt`
    writeFileSync(real, 'secret\n')
    symlinkSync(real, link)
    const sym = await spawnLauncher(['--prompt-file', link], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(sym.code).not.toBe(0)
    expect(sym.stderr).toMatch(/prompt-file/)
  }, LONG)

  it('lock: second concurrent launch fails; stale lock (>6h) is reclaimed; SIGTERM releases .lock', async () => {
    // (a) concurrent
    stage = newStage()
    const { H } = homePathsFor(stage)
    const sleeperEnv = baseEnv(stage, { CODEX_STUB_SLEEP_MS: '2500' })
    const first = spawnLauncher(['--', 'hold'], { cwd: stage.ws, env: sleeperEnv, exitOnly: true })
    await waitFor(() => existsSync(`${H}/.lock`))
    const second = await spawnLauncher(['--', 'blocked'], {
      cwd: stage.ws,
      env: baseEnv(stage),
      exitOnly: true,
    }).done
    expect(second.code).not.toBe(0)
    expect(second.stderr).toMatch(/\.lock/)
    expect((await first.done).code).toBe(0)
    await waitFor(() => !existsSync(`${H}/.lock`))

    // (b) stale reclaim: backdate a pre-existing .lock beyond 6h
    stage = newStage()
    const staleH = homePathsFor(stage)
    mkdirSync(staleH.R, { recursive: true, mode: 0o700 })
    mkdirSync(staleH.H, { recursive: true, mode: 0o700 })
    mkdirSync(`${staleH.H}/.lock`)
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000)
    utimesSync(`${staleH.H}/.lock`, old, old)
    const reclaimed = await spawnLauncher(['--', 'after-stale'], {
      cwd: stage.ws,
      env: baseEnv(stage),
    }).done
    expect(reclaimed.code).toBe(0)

    // (c) SIGTERM to the sleeping launcher releases .lock
    stage = newStage()
    const sigH = homePathsFor(stage)
    const victim = spawnLauncher(['--', 'sigterm-me'], {
      cwd: stage.ws,
      env: baseEnv(stage, { CODEX_STUB_SLEEP_MS: '6000' }),
      exitOnly: true,
    })
    await waitFor(() => existsSync(`${sigH.H}/.lock`))
    victim.child.kill('SIGTERM')
    await waitFor(() => !existsSync(`${sigH.H}/.lock`))
    expect((await victim.done).code).not.toBe(0)
  }, LONG)

  it('sync: tampered H copy is overwritten; missing source deletes copy + warns; symlink source fails loud', async () => {
    // tampered residue overwritten on the next run
    stage = newStage()
    const { H } = homePathsFor(stage)
    const one = await spawnLauncher(['--', 'one'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(one.code, one.stderr).toBe(0)
    writeFileSync(`${H}/auth.json`, 'TAMPERED')
    const two = await spawnLauncher(['--', 'two'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(two.code, two.stderr).toBe(0)
    expect(readFileSync(`${H}/auth.json`, 'utf8')).toBe('{"fake":"auth"}\n')

    // source removed → H copy deleted + stderr warning, launch still proceeds
    stage = newStage()
    rmSync(`${stage.fakeHome}/.codex/auth.json`)
    const gone = await spawnLauncher(['--', 'no-auth'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(gone.code).toBe(0)
    expect(gone.stderr).toMatch(/missing\/unreadable|removed shadow copy/)
    expect(existsSync(`${homePathsFor(stage).H}/auth.json`)).toBe(false)

    // symlink source → fail loud (O_NOFOLLOW + lstat regular-file check)
    // Replace the staged regular file (symlinkSync is exclusive-create);
    // target '/etc/hosts' exists on both darwin and linux.
    stage = newStage()
    rmSync(`${stage.fakeHome}/.codex/auth.json`)
    symlinkSync('/etc/hosts', `${stage.fakeHome}/.codex/auth.json`)
    const sym = await spawnLauncher(['--', 'sym-auth'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(sym.code).not.toBe(0)
    expect(sym.stderr).toMatch(/regular file/)
  }, LONG)

  it('ownership/mode: H chmod 0755 fails loud; R symlink fails loud (root-guard early-return)', async () => {
    // chmod is a no-op against root's permission bypass — skip expectations
    if (process.getuid?.() === 0) return

    stage = newStage()
    const { R, H } = homePathsFor(stage)
    mkdirSync(R, { recursive: true, mode: 0o700 })
    mkdirSync(H, { recursive: true, mode: 0o700 })
    const { chmodSync } = await import('node:fs')
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

  it('codex absent from PATH fails loud; a stub inside a writable root is refused', async () => {
    stage = newStage()
    const noPath = baseEnv(stage)
    noPath.PATH = '/nonexistent-dir'
    const absent = await spawnLauncher(['--', 'no-cli'], { cwd: stage.ws, env: noPath }).done
    expect(absent.code).not.toBe(0)
    expect(absent.stderr).toMatch(/codex CLI/)

    // negative anchoring row: candidate CLI under the canonicalized TMPDIR
    stage = newStage()
    const inRootBin = `${stage.varDir}/bin`
    mkdirSync(inRootBin)
    writeFileSync(`${inRootBin}/codex`, '#!/usr/bin/env node\n', { mode: 0o755 })
    const { chmodSync } = await import('node:fs')
    chmodSync(`${inRootBin}/codex`, 0o755)
    const env = baseEnv(stage)
    env.PATH = inRootBin
    const refused = await spawnLauncher(['--', 'in-root'], { cwd: stage.ws, env }).done
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toMatch(/codex CLI/)
  }, LONG)

  it('child-scope env: CODEX_HOME reaches the child only; the parent env is unchanged', async () => {
    stage = newStage()
    const env = baseEnv(stage, { CODEX_HOME: 'PARENT-VALUE' })
    const run = await spawnLauncher(['--', 'env-proof'], { cwd: stage.ws, env }).done
    expect(run.code).toBe(0)
    const { H } = homePathsFor(stage)
    expect(readCaptures(stage)[0].codexHome).toBe(H) // child saw the shadow home
    expect(process.env.CODEX_HOME).not.toBe(H) // launcher never leaked upward
    expect(env.CODEX_HOME).toBe('PARENT-VALUE') // caller's env object untouched
  }, LONG)

  it('argv-shape errors exit 2 with usage on stderr', async () => {
    stage = newStage()
    const trailing = await spawnLauncher(['--', 'a', 'b'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(trailing.code).toBe(2)
    expect(trailing.stderr).toMatch(/usage:/)

    stage = newStage()
    const empty = await spawnLauncher(['--'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(empty.code).toBe(2)
    expect(empty.stderr).toMatch(/usage:/)

    stage = newStage()
    const dup = await spawnLauncher(['--last', '--last', '--', 'x'], { cwd: stage.ws, env: baseEnv(stage) }).done
    expect(dup.code).toBe(2)
  }, LONG)
})
