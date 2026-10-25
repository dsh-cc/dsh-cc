import { spawn as nodeSpawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { FrameParser, classify } from './tlc-output.lib.mjs'
import { hashFile } from './fingerprint.lib.mjs'
import { fail } from './manifest.lib.mjs'
export function scrubEnvironment(env = process.env) {
  const clean = { ...env }
  for (const key of ['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH', 'TLA_LIBRARY']) delete clean[key]
  return clean
}
export function parseJavaVersion(text) {
  const headers = [...text.matchAll(/(?:^|\n)(?:openjdk|java) version "([^"\r\n]*)"[^\r\n]*/g)].map(m => m[1])
  if (!headers.length || new Set(headers).size !== 1 || !/^[0-9]+(?:\.[0-9]+)*(?:[-+_][A-Za-z0-9.+_-]+)?$/.test(headers[0])) fail('java-version', 'missing, malformed or conflicting Java version headers')
  const parts = headers[0].split(/[-+_]/)[0].split('.')
  const major = BigInt(parts[0]) === 1n ? parts[1] : parts[0]
  if (!major || BigInt(major) < 17n) fail('java-version', 'Java major version must be at least 17')
  return headers[0]
}
// Both callers use direct spawn, a scrubbed environment and the same kill ladder.
export async function probeJava(executable, cwd, { spawn = nodeSpawn, signal } = {}) {
  if (signal?.aborted) return { code: 'cancelled', detail: 'Java probe cancelled' }
  return new Promise(resolve => {
    let child, done = false, cause, total = 0, timer, killTimer, closeTimer
    const chunks = [[], []]
    const settle = result => {
      if (done) return
      done = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer)
      signal?.removeEventListener('abort', cancel)
      child?.stdout?.removeListener('data', stdoutData); child?.stderr?.removeListener('data', stderrData)
      resolve(result)
    }
    const stop = why => {
      if (done || cause) return
      cause = why
      try { child.kill('SIGTERM') } catch { settle({ code: signal?.aborted ? 'cancelled' : 'io', detail: 'Java probe SIGTERM failed; child termination unconfirmed' }); return }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { settle({ code: signal?.aborted ? 'cancelled' : 'io', detail: 'Java probe SIGKILL failed; child termination unconfirmed' }); return }
        closeTimer = setTimeout(() => settle({ code: signal?.aborted ? 'cancelled' : 'io', detail: 'Java probe close unconfirmed after SIGKILL' }), 2000)
      }, 2000)
    }
    const cancel = () => stop('cancelled')
    const data = (index, chunk) => {
      const keep = Math.max(0, 1048576 - total)
      if (keep) chunks[index].push(Buffer.from(chunk.subarray(0, keep)))
      total += chunk.length
      if (total > 1048576) stop('output-limit')
    }
    const stdoutData = chunk => data(0, chunk)
    const stderrData = chunk => data(1, chunk)
    try { child = spawn(executable, ['-version'], { cwd, shell: false, env: scrubEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (e) { settle({ code: e.code === 'ENOENT' ? 'java-missing' : 'io', detail: 'Java probe spawn failed' }); return }
    timer = setTimeout(() => stop('timeout'), 10000)
    child.stdout.on('data', stdoutData); child.stderr.on('data', stderrData)
    child.once('error', e => settle({ code: signal?.aborted ? 'cancelled' : e.code === 'ENOENT' ? 'java-missing' : 'io', detail: 'Java probe spawn failed' }))
    child.once('close', (exitCode, exitSignal) => {
      if (signal?.aborted || cause === 'cancelled') return settle({ code: 'cancelled', detail: 'Java probe cancelled' })
      if (cause || exitCode !== 0 || exitSignal) return settle({ code: 'java-version', detail: `Java probe failed: ${cause ?? (exitSignal ? 'signal-exit' : 'nonzero-exit')}` })
      try { settle({ version: parseJavaVersion(chunks.map(parts => Buffer.concat(parts).toString('utf8')).join('\n')) }) }
      catch (e) { settle({ code: e.code, detail: e.detail }) }
    })
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}
export async function runCase(c, argv, cwd, dir, { spawn = nodeSpawn, signal, io = fs, logLimit = 50 * 1024 * 1024 } = {}) {
  await io.mkdir(dir, { recursive: true })
  const handles = []
  try { handles.push(await io.open(join(dir, 'stdout.log'), 'wx')); handles.push(await io.open(join(dir, 'stderr.log'), 'wx')) }
  catch (e) { for (const h of handles) await h.close().catch(() => {}); throw e }
  if (signal?.aborted) {
    for (const h of handles) await h.close()
    throw Object.assign(new Error('cancelled before child spawn'), { cancelledBeforeSpawn: true })
  }
  const parsers = [new FrameParser(), new FrameParser()]
  let total = 0, lost = false, queue = Promise.resolve(), spawnFailed = false, timedOut = false, interruption
  const start = performance.now()
  const processResult = await new Promise(resolve => {
    let child, timer, killTimer, closed = false
    const stop = reason => {
      if (closed) return
      if (reason === 'cancelled' || !interruption) interruption = reason
      if (reason === 'timeout') timedOut = true
      if (killTimer) return
      try { child.kill('SIGTERM') } catch { lost = true }
      killTimer = setTimeout(() => { if (!closed) { try { child.kill('SIGKILL') } catch { lost = true } } }, 2000)
    }
    const cancel = () => stop('cancelled')
    const onData = (index, chunk) => {
      const kept = Buffer.from(chunk.subarray(0, Math.max(0, logLimit - total)))
      total += kept.length
      if (kept.length) {
        parsers[index].feed(kept)
        queue = queue.then(async () => {
          let offset = 0
          while (offset < kept.length) { const { bytesWritten } = await handles[index].write(kept, offset, kept.length - offset); if (!bytesWritten) throw new Error('zero-byte log write'); offset += bytesWritten }
        }).catch(() => { lost = true; stop('io') })
      }
      if (kept.length < chunk.length) stop('log-limit')
    }
    const finish = (exitCode, exitSignal) => {
      if (closed) return
      closed = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', cancel)
      resolve({ exitCode, signal: exitSignal })
    }
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, shell: false, env: scrubEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch { spawnFailed = true; finish(null, null); return }
    child.stdout.on('data', chunk => onData(0, chunk)); child.stderr.on('data', chunk => onData(1, chunk))
    child.once('spawn', () => { timer = setTimeout(() => stop('timeout'), c.limits.timeoutMs) })
    child.once('error', () => { spawnFailed = true; finish(null, null) })
    child.once('close', finish)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
  await queue
  for (const h of handles) {
    try { await h.sync() } catch { lost = true }
    try { await h.close() } catch { lost = true }
  }
  if (lost) throw Object.assign(new Error('child log persistence failed; no completed Evidence'), { lostOutput: true })
  let stdoutSha256, stderrSha256
  try { stdoutSha256 = await hashFile(join(dir, 'stdout.log')); stderrSha256 = await hashFile(join(dir, 'stderr.log')) }
  catch { throw Object.assign(new Error('log hash/read failed after child close'), { lostOutput: true }) }
  return { id: c.id, coverage: c.coverage, ...classify({ stdout: parsers[0].finish(), stderr: parsers[1].finish(), ...processResult, spawnFailed, timedOut, interruption }), ...processResult, timedOut, elapsedMs: Math.max(0, Math.floor(performance.now() - start)), argv, stdoutPath: join(dir, 'stdout.log'), stderrPath: join(dir, 'stderr.log'), stdoutSha256, stderrSha256 }
}
