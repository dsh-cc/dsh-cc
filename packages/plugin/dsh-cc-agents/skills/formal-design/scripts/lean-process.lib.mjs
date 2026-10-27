import { spawn as nodeSpawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { join, resolve } from 'node:path'
import { hashFile } from './lean-fingerprint.lib.mjs'
import { leanEnvironment } from './lean-preflight.mjs'

// Child process lifecycle for Lean phases (design section 6). Mirrors the TLC
// runner's cancellation semantics (process.lib.mjs): direct spawn with explicit
// argv arrays and no shell, SIGTERM then SIGKILL, and no unbounded phase.
// Differences required by the Lean path: each stream is capped separately (not
// the phase total), and the phase budget covers process startup.
export const STREAM_LIMIT = 50 * 1024 * 1024
const KILL_GRACE_MS = 2000
const CLOSE_GRACE_MS = 2000

// design section 6: inherit PATH and standard locale variables only, clear every
// Lean/tool override, and point LEAN_PATH at the absolute fresh workspace so
// freshly compiled modules resolve while bundled libraries still load from the
// sysroot.
export function leanChildEnvironment(workspace, base = process.env) {
  return { ...leanEnvironment(base), LEAN_PATH: resolve(workspace) }
}

async function artifact(path) {
  const stat = await fs.stat(path)
  return { bytes: stat.size, sha256: await hashFile(path) }
}

/**
 * Run one phase. The two stream artifacts always exist afterwards: a silent
 * child leaves a zero-length file with the SHA-256 of empty input.
 */
export async function runLeanPhase(argv, options = {}) {
  // `stdin` is the optional stdin payload for the corpus protocol (design section
  // 7); when absent the child's stdin is ignored exactly as before.
  const { cwd, env, timeoutMs, signal, dir, io = fs, spawn = nodeSpawn, streamLimit = STREAM_LIMIT, stdin } = options
  await io.mkdir(dir, { recursive: true })
  const stdoutPath = join(dir, 'stdout.log')
  const stderrPath = join(dir, 'stderr.log')
  const handles = []
  try {
    handles.push(await io.open(stdoutPath, 'wx'))
    handles.push(await io.open(stderrPath, 'wx'))
  } catch (error) {
    for (const handle of handles) await handle.close().catch(() => {})
    throw error
  }

  const started = performance.now()
  const flags = { timedOut: false, cancelled: false, overflowed: false, spawnFailed: false, lostOutput: false }
  // Writes are chained so a slow disk cannot reorder or drop bytes.
  let queue = Promise.resolve()
  let interruption = null
  const outcome = await new Promise(resolveRun => {
    let child
    let closed = false
    let timer, killTimer, closeTimer
    const totals = [0, 0]
    const settle = value => {
      if (closed) return
      closed = true
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer)
      signal?.removeEventListener('abort', cancel)
      resolveRun(value)
    }
    // One kill ladder for timeout, cancellation and stream overflow.
    const stop = reason => {
      if (closed) return
      if (!interruption) interruption = reason
      if (reason === 'timeout') flags.timedOut = true
      if (reason === 'cancelled') flags.cancelled = true
      if (reason === 'stream-limit') flags.overflowed = true
      if (killTimer) return
      try { child.kill('SIGTERM') } catch { flags.lostOutput = true }
      killTimer = setTimeout(() => {
        if (closed) return
        try { child.kill('SIGKILL') } catch { flags.lostOutput = true }
        closeTimer = setTimeout(() => settle({ exitCode: null, termSignal: null }), CLOSE_GRACE_MS)
      }, KILL_GRACE_MS)
    }
    const cancel = () => stop('cancelled')
    const onData = (index, chunk) => {
      const room = Math.max(0, streamLimit - totals[index])
      const kept = Buffer.from(chunk.subarray(0, room))
      totals[index] += chunk.length
      if (kept.length) {
        // Writes are chained so a slow disk cannot reorder or drop bytes.
        queue = queue.then(async () => {
          let offset = 0
          while (offset < kept.length) {
            const { bytesWritten } = await handles[index].write(kept, offset, kept.length - offset)
            if (!bytesWritten) throw new Error('zero-byte log write')
            offset += bytesWritten
          }
        }).catch(() => { flags.lostOutput = true; stop('io') })
      }
      if (kept.length < chunk.length) stop('stream-limit')
    }
    if (signal?.aborted) {
      interruption = 'cancelled'
      flags.cancelled = true
      settle({ exitCode: null, termSignal: null })
      return
    }
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, shell: false, env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    } catch {
      flags.spawnFailed = true
      settle({ exitCode: null, termSignal: null })
      return
    }
    if (stdin !== undefined) {
      // A child that exits early closes the pipe; that surfaces as a short output
      // stream (a protocol failure), never as a runner crash.
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }
    child.stdout.on('data', chunk => onData(0, chunk))
    child.stderr.on('data', chunk => onData(1, chunk))
    // The phase budget covers startup, so it starts before the `spawn` event.
    timer = setTimeout(() => stop('timeout'), Math.max(0, timeoutMs))
    child.once('error', () => {
      flags.spawnFailed = true
      settle({ exitCode: null, termSignal: null })
    })
    child.once('close', (exitCode, termSignal) => settle({ exitCode, termSignal }))
    signal?.addEventListener('abort', cancel, { once: true })
  })

  await queue
  for (const handle of handles) {
    try { await handle.sync() } catch { /* surfaced by the read below */ }
    try { await handle.close() } catch { /* surfaced by the read below */ }
  }
  let stdout, stderr
  try {
    stdout = await artifact(stdoutPath)
    stderr = await artifact(stderrPath)
  } catch {
    throw Object.assign(new Error('phase stream persistence failed'), { code: 'io', detail: 'phase stream persistence failed', lostOutput: true })
  }
  return {
    argv: [...argv],
    exitCode: outcome.exitCode,
    termSignal: outcome.termSignal,
    timedOut: flags.timedOut,
    cancelled: flags.cancelled,
    overflowed: flags.overflowed,
    spawnFailed: flags.spawnFailed,
    interrupted: interruption,
    lostOutput: flags.lostOutput,
    elapsedMs: Math.max(0, Math.floor(performance.now() - started)),
    stdoutPath,
    stderrPath,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutSha256: stdout.sha256,
    stderrSha256: stderr.sha256,
  }
}
