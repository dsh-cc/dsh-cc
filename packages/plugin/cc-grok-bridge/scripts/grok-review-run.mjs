#!/usr/bin/env node
/**
 * §3.1 launcher for the cc-grok-bridge.
 *
 *   grok-review-run.mjs [--last] -- <single-line prompt>        # first char
 *                                                               # not '-'; no \n or \r
 *   grok-review-run.mjs [--last] --prompt-file <path>
 *
 * Redirects GROK_HOME to a per-cwd shadow home under the canonical tmpdir
 * (§3.1 steps 5–6, scripts/lib/home.mjs: D14 allowlist sweep then D19
 * credential sync), resolves and validates the grok CLI, spawns
 * `grok --permission-mode bypassPermissions --output-format json` with the
 * prompt as the final `-p` argv value (or the bridge-owned
 * H/.prompt-current.txt via native `--prompt-file`, unlinked in finalize),
 * and prints the JSON document's `.text` (raw captured bytes on formatter
 * fallthrough). The termination contract is the §3.1-T state machine:
 * memoized `finalize()` / `terminate(reason)`, ordered group reap with a
 * 2 s SIGKILL grace inside a 5 s total reap budget, and an `H/.orphaned`
 * poison marker on budget expiry gating the next launch.
 *
 * Testability seam: `runLauncher(argv, deps?)` — `deps` carries every
 * nondeterministic collaborator (fs-level ops, `spawn`, `now`, signal
 * registration, `exitWith`) with production defaults.
 */
import { spawn as nodeSpawn } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { parseArgv } from './lib/argv.mjs'
import { acquireLock, buildChildEnv, prepareHome, syncCredentials, sweepHome } from './lib/home.mjs'

const USAGE =
  'usage: grok-review-run.mjs [--last] -- <single-line prompt>\n' +
  '       grok-review-run.mjs [--last] --prompt-file <path>'

const PROMPT_CAP = 262144 // 256 KiB; the read itself enforces cap+1
export const STDOUT_CAP = 16 * 1024 * 1024 // capture buffer cap; breach byte terminates
const REAP_GRACE_MS = 2_000 // TERM → SIGKILL escalation
const REAP_BUDGET_MS = 5_000 // total reap budget → H/.orphaned + proceed
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']

const die = (msg, code = 1) => {
  const e = new Error(`grok-review: ${msg}`)
  e.exitCode = code
  throw e
}

/** Canonicalized outer writable roots: {cwd, tmpdir, /tmp}. */
export function writableRoots(cwd = process.cwd(), tmp = os.tmpdir()) {
  const roots = []
  for (const p of [cwd, tmp, '/tmp']) {
    try {
      roots.push(realpathSync(p))
    } catch {
      /* absent root — nothing to confine against */
    }
  }
  return roots
}

const outsideRoots = (p, roots) => !roots.some((r) => p === r || p.startsWith(r + path.sep))

/** PATH scan + realpath; first hit outside every writable root wins. */
export function resolveGrok(roots, env = process.env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    let real
    try {
      real = realpathSync(path.join(dir, 'grok'))
    } catch {
      continue
    }
    // The executed binary must sit outside every canonicalized writable
    // root: nothing the model can write may become the CLI.
    if (!outsideRoots(real, roots)) continue
    return real
  }
  die('grok CLI not found on PATH outside the writable roots')
}

const fsIo = { openSync, fstatSync, readSync, closeSync }

/**
 * --prompt-file: O_NOFOLLOW open, fstat regular-file, bounded read of at
 * most PROMPT_CAP + 1 bytes from THAT same fd — the cap is enforced by the
 * read itself (a file grown past the cap between fstat and read still
 * dies). The check→open ancestor-swap race is the §4 accepted residual —
 * this channel is hygiene-only (prompt text the model could already read
 * and inline itself), data egress into a networked model run, not an
 * egress gate.
 */
export function readPromptFile(p, io = fsIo) {
  let fd
  try {
    fd = io.openSync(p, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (e) {
    die(`prompt-file unreadable: ${e.message}`)
  }
  try {
    if (!io.fstatSync(fd).isFile()) die('prompt-file is not a regular file')
    const chunks = []
    let total = 0
    const buf = Buffer.alloc(65536)
    for (;;) {
      const n = io.readSync(fd, buf, 0, buf.length, null)
      if (n === 0) break
      if (total + n > PROMPT_CAP) die(`prompt-file exceeds the ${PROMPT_CAP}-byte cap`)
      chunks.push(Buffer.from(buf.subarray(0, n)))
      total += n
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Atomic 0600 write into the shadow home; temp residue never survives. */
export function writePromptShadow(H, data) {
  const finalPath = path.join(H, '.prompt-current.txt')
  const tmpPath = path.join(H, `.tmp-${randomBytes(8).toString('hex')}`)
  let fd
  try {
    fd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)
    writeSync(fd, Buffer.from(data, 'utf8'))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmpPath, finalPath)
  } catch (e) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
    try { rmSync(tmpPath, { force: true }) } catch { /* best-effort */ }
    throw e
  }
  return finalPath
}

/**
 * Output formatter (§10): a parsed document with a string `.text` (empty
 * qualifies) prints as `.text` with newline normalization; EVERYTHING else
 * — parse failure, primitives, arrays, null, object without string `.text`
 * — passes the captured buffer through verbatim.
 */
export function formatOutput(captured) {
  let doc
  try {
    doc = JSON.parse(captured.toString('utf8'))
  } catch {
    doc = undefined
  }
  if (doc !== null && typeof doc === 'object' && !Array.isArray(doc) && typeof doc.text === 'string') {
    return doc.text.endsWith('\n') ? doc.text : doc.text + '\n'
  }
  return captured
}

/**
 * Success-path stderr cost summary — the durable cost record (P14). Fields
 * are type-checked, control-stripped, and capped; absent/invalid fields are
 * dropped. The `grok-review:` prefix marks launcher-authorship by
 * CONVENTION, not proof (the child stderr shares the stream).
 */
export function costLine(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return null
  const parts = []
  if (doc.sessionId !== undefined && doc.sessionId !== null) {
    const s = String(doc.sessionId)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, 64)
    if (s !== '') parts.push(`session=${s}`)
  }
  if (typeof doc.total_cost_usd === 'number') parts.push(`cost_usd=${doc.total_cost_usd}`)
  if (typeof doc.num_turns === 'number') parts.push(`turns=${doc.num_turns}`)
  return parts.length > 0 ? `grok-review: ${parts.join(' ')}` : null
}

/**
 * The launcher body (§3.1 steps 1–11 + §3.1-T). `deps` injects every
 * nondeterministic collaborator; production defaults are the real ones.
 */
export async function runLauncher(argv = process.argv.slice(2), deps = {}) {
  const d = {
    spawn: nodeSpawn,
    now: Date.now,
    exitWith: (code) => {
      process.exitCode = code
    },
    onSignal: (handler) => {
      for (const sig of SIGNALS) process.on(sig, handler)
      return () => {
        for (const sig of SIGNALS) process.off(sig, handler)
      }
    },
    platform: process.platform,
    cwd: () => process.cwd(),
    tmpdir: os.tmpdir,
    homedir: os.homedir,
    env: process.env,
    io: fsIo,
    ...deps,
  }

  // Step 1: platform gate (arming refuses win32 too — D17).
  if (d.platform === 'win32') die('unsupported platform win32')

  // Step 2: writable roots.
  const roots = writableRoots(d.cwd(), d.tmpdir())

  // Step 3: self-assert — the interpreter must sit outside every writable
  // root (defense-in-depth against a mismatched/PATH-swapped node).
  const selfNode = realpathSync(process.execPath)
  if (!outsideRoots(selfNode, roots)) {
    die('node interpreter sits inside a canonicalized writable root')
  }

  // Step 4: parse own argv with the shared grammar (D9/D13). Real argv has
  // no shell quoting left: map each arg to { text, expansion: false }.
  const launcherPath = realpathSync(fileURLToPath(import.meta.url))
  const words = [
    { text: selfNode, expansion: false },
    { text: launcherPath, expansion: false },
    ...argv.map((a) => ({ text: a, expansion: false })),
  ]
  const parsed = parseArgv(words, { node: selfNode, launcher: launcherPath })
  if (!parsed.ok) die(`invalid invocation (${parsed.reason})\n${USAGE}`, 2)
  const { last, prompt } = parsed.value

  // The §3.1-T state machine's mutable shell.
  let H = null
  let releaseLock = () => {}
  let child = null
  let closed = false
  let closeInfo = null
  let spawnError = null
  let terminateCalled = false
  let terminateReason = null
  let capBreached = false
  let finalizeDone = false
  let orphanWritten = false
  let graceTimer = null
  let budgetTimer = null
  let resolveClose = null
  const detachRef = { fn: () => {} }

  const promptShadowPath = () => path.join(H, '.prompt-current.txt')
  const orphanMarkerPath = () => path.join(H, '.orphaned')

  const writeOrphanMarker = () => {
    if (orphanWritten) return
    orphanWritten = true
    try {
      writeFileSync(orphanMarkerPath(), `reap-budget-expired ${new Date().toISOString()}\n`, { mode: 0o600 })
    } catch {
      /* best-effort — the marker gates the NEXT launch, not this one */
    }
  }

  const killGroup = (sig) => {
    if (child && child.pid) {
      try {
        process.kill(-child.pid, sig)
      } catch {
        /* ESRCH — group already gone */
      }
    }
  }

  const clearReapTimers = () => {
    if (graceTimer) clearTimeout(graceTimer)
    if (budgetTimer) clearTimeout(budgetTimer)
    graceTimer = budgetTimer = null
  }

  /** T9: reap budget expiry — poison marker, forced kill, stop waiting. */
  const onReapBudgetExpiry = () => {
    writeOrphanMarker()
    killGroup('SIGKILL')
    if (resolveClose) resolveClose({ code: null, signal: null, forced: true })
  }

  /**
   * Memoized terminate (T4/T6/T8): TERM → 2 s SIGKILL grace, 5 s total
   * reap budget → `.orphaned` + proceed.
   */
  const terminate = (reason) => {
    if (terminateCalled) return
    terminateCalled = true
    terminateReason = reason
    if (child === null || closed) return
    killGroup('SIGTERM')
    graceTimer = setTimeout(() => killGroup('SIGKILL'), REAP_GRACE_MS)
    budgetTimer = setTimeout(onReapBudgetExpiry, REAP_BUDGET_MS)
  }

  /** Memoized finalize: unlink shadow prompt → release → detach → exit. */
  const finalize = (code) => {
    if (finalizeDone) return
    finalizeDone = true
    clearReapTimers()
    try {
      if (H !== null) unlinkSync(promptShadowPath())
    } catch {
      /* best-effort — the prompt bytes never persist */
    }
    try {
      releaseLock()
    } catch {
      /* best-effort */
    }
    try {
      detachRef.fn()
    } catch {
      /* best-effort */
    }
    d.exitWith(code)
  }

  const onSignal = () => {
    if (finalizeDone) return
    if (child === null || closed) {
      // T5: signal in INIT (no child) — uniform 130, deliberate.
      finalize(130)
      return
    }
    if (terminateCalled) {
      // T7: second signal while TERMINATING — immediate SIGKILL, no budget extension.
      killGroup('SIGKILL')
      return
    }
    // T6: signal in RUNNING.
    terminate('signal')
  }

  const awaitClose = () =>
    new Promise((resolve) => {
      const finish = (info) => {
        resolveClose = null
        closed = true
        clearReapTimers()
        resolve(info)
      }
      resolveClose = finish
      child.on('error', (e) => {
        spawnError = e
        finish({ code: null, signal: null })
      })
      child.on('close', (code, signal) => {
        closeInfo = { code, signal }
        finish({ code, signal })
      })
    })

  try {
    // Step 5: shadow state root. Signal handlers registered FIRST (before
    // acquireLock) — no signal window can strand the lock: a pre-lock
    // signal hits the guarded finalize with nothing to reap/release.
    detachRef.fn = d.onSignal(onSignal)
    ;({ H } = prepareHome({ cwd: d.cwd(), tmpdir: d.tmpdir() }))
    // Orphan marker check (codex-R5 B3): STRICTLY precedes the step-6
    // sweep, and `.orphaned` is never in the sweep allowlist — the poison
    // marker survives until a human removes it.
    if (existsSync(orphanMarkerPath())) {
      die(
        'previous run left a live child after the reap budget (H/.orphaned) — inspect processes and remove the marker to re-enable this lane',
      )
    }
    releaseLock = acquireLock(H)

    // Step 6: sweep BEFORE credentials, inside the lock (order closes the
    // planted-destination DoS). Sweep failure of any entry is fail-closed.
    sweepHome(H)
    syncCredentials(H, { home: d.homedir(), env: d.env })

    // Step 7: resolve the grok CLI.
    const grok = resolveGrok(roots, d.env)

    // Step 8: prompt materialization (write-through; only bridge-owned
    // paths reach Grok).
    let promptArg
    if (prompt.kind === 'inline') {
      promptArg = ['-p', prompt.text]
    } else {
      const text = readPromptFile(prompt.path, d.io)
      const shadow = writePromptShadow(H, text)
      promptArg = ['--prompt-file', shadow]
    }

    // Step 9: spawn — group leader (detached) so termination reaches grok +
    // group-resident descendants. No --cwd flag: spawn-cwd inheritance is
    // the resume surface. Env = buildChildEnv(process.env, H):
    // { ...env, GROK_HOME: H } minus GROK_SESSION_ID, GROK_AGENT,
    // GROK_SANDBOX (D10) — process.env itself is never mutated.
    const args = ['--permission-mode', 'bypassPermissions', '--output-format', 'json']
    if (last) args.push('-c')
    args.push(...promptArg)
    const env = buildChildEnv(d.env, H)
    child = d.spawn(grok, args, {
      cwd: realpathSync(d.cwd()),
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
      detached: true,
    })

    // Step 10: capture with the 16 MiB + 1 byte cap (discard after breach).
    let captured = Buffer.alloc(0)
    child.stdout?.on('data', (chunk) => {
      if (capBreached) return // post-breach chunks are discarded, never appended
      if (captured.length + chunk.length > STDOUT_CAP) {
        capBreached = true
        captured = Buffer.concat([captured, chunk.subarray(0, STDOUT_CAP - captured.length + 1)])
        terminate('stdout-cap')
        return
      }
      captured = Buffer.concat([captured, chunk])
    })

    await awaitClose()
    clearReapTimers()

    // Step 10/11: output contract + exit-code mapping (§3.1-T rows T2–T4, T8, T9).
    let exitCode
    if (spawnError) {
      // T8: spawn error — memoized terminate's group-kill best-effort.
      terminate('spawn-error')
      console.error(`grok-review: spawn failed: ${spawnError.message}`)
      exitCode = 1
    } else if (capBreached) {
      console.error('grok-review: grok stdout exceeded the 16 MiB capture cap')
      exitCode = 1
    } else if (closeInfo !== null && closeInfo.code !== null && !terminateCalled) {
      // T2: normal close — formatter + cost line; exit code is the child's.
      const out = formatOutput(captured)
      if (Buffer.isBuffer(out)) process.stdout.write(out)
      else process.stdout.write(out, 'utf8')
      let doc
      try {
        doc = JSON.parse(captured.toString('utf8'))
      } catch {
        doc = undefined
      }
      const line = costLine(doc)
      if (line !== null) console.error(line)
      exitCode = closeInfo.code
    } else if (closeInfo !== null && closeInfo.code === null && !terminateCalled) {
      // T3: genuine signal close without a launcher-initiated terminate —
      // the formatter is bypassed entirely, nothing of the partial capture prints.
      console.error(`grok-review: grok terminated by signal ${closeInfo.signal ?? 'UNKNOWN'}`)
      exitCode = 1
    } else {
      // T4/T6/T9: the initiating row's code (cap → 1, signal → 130).
      exitCode = terminateReason === 'signal' ? 130 : 1
    }
    finalize(exitCode)
    return exitCode
  } catch (e) {
    // T1: sync failure in INIT — the finally below still runs finalize's
    // cleanup half (prompt-file safety even when spawn never happens).
    if (!finalizeDone) {
      console.error(e?.message ?? e)
      finalize(e?.exitCode ?? 1)
    }
  } finally {
    // The whole-region try/finally: the memoized finalize runs on EVERY
    // path — this call is a cleanup no-op whenever the body already
    // finalized (T1 included).
    finalize(undefined)
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  runLauncher(process.argv.slice(2)).then(
    (code) => {
      if (typeof code === 'number') process.exitCode = code
    },
    (e) => {
      console.error(e?.message ?? e)
      process.exitCode = e?.exitCode ?? 1
    },
  )
}
