/**
 * Capture stdio MCP server stderr so it cannot inherit the parent TTY.
 * SDK default is `stderr: 'inherit'`; piping is mandatory for a TUI host.
 *
 * @module
 */

import { createWriteStream, mkdirSync, openSync, renameSync, statSync, type WriteStream } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

/** Ring capacity for the in-memory tail used in connection-failure warns. */
export const STDERR_TAIL_CAPACITY = 4 * 1024
/** Max characters of that tail embedded in a single-line `ctx.logger.warn`. */
export const STDERR_WARN_CAPACITY = 1024
/** Default size cap for the stdio stderr log; ONE backup generation is kept. */
export const STDIO_LOG_MAX_BYTES = 4 * 1024 * 1024

const tails = new WeakMap<Transport, BoundedTail>()

/**
 * Append-only ring of the newest `capacity` characters. Used so a noisy
 * server cannot grow memory without bound while still leaving a crash banner
 * for the supervisor's warn line.
 */
export class BoundedTail {
  private buffer = ''
  constructor(private readonly capacity: number) {}

  push(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity)
    }
  }

  snapshot(): string {
    return this.buffer
  }
}

/**
 * Default directory for captured stdio stderr.
 * `$DSH_HOME/mcp-logs`, falling back to `~/.dsh/mcp-logs`.
 */
function defaultStdioLogDir(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'mcp-logs')
}

/**
 * Last ≤1 KB of a captured tail, newlines collapsed, for a one-line logger.
 * @returns `undefined` when the tail is empty so callers can omit the suffix.
 */
export function formatStdioStderrForWarn(tail: string): string | undefined {
  const collapsed = tail.trim().replace(/\r?\n/g, '⏎')
  if (collapsed.length === 0) return undefined
  return collapsed.length > STDERR_WARN_CAPACITY
    ? collapsed.slice(collapsed.length - STDERR_WARN_CAPACITY)
    : collapsed
}

/** Snapshot of the ring attached to `transport`, or `''` when none. */
export function stdioStderrTail(transport: Transport): string {
  return tails.get(transport)?.snapshot() ?? ''
}

/**
 * Pipe `transport.stderr`, drain into a 4 KB ring, and append raw bytes to
 * `$DSH_HOME/mcp-logs/<serverName>.log` (or `logDir` when given), rotating at
 * `maxBytes` (default {@link STDIO_LOG_MAX_BYTES}; `maxBytes <= 0` disables)
 * into a single `<serverName>.log.1` backup generation, both at open time and
 * mid-stream.
 *
 * Must run before `start()`: SDK 1.29 creates the PassThrough in the
 * constructor when `stderr: 'pipe'`. An undrained pipe back-pressures the
 * child until it blocks in `write(2)`.
 *
 * No-ops when `stderr` is missing so `vi.fn()` SDK mocks stay constructible.
 *
 * ponytail: rotation is size-based with one backup generation (the previous
 * `.log.1` is discarded on each rotation); concurrent dsh-cc sessions sharing
 * a serverName may interleave (session header marks each generation);
 * WriteStream buffer grows if the disk stalls — log must never block MCP.
 * Documented rotation edges: (a) bytes buffered in the old stream at rotation
 * time flush into `.log.1` after the rename — a crash between rename and
 * flush loses at most one stream buffer; (b) another session holding the
 * renamed `.log.1` writes into an anonymous inode whose bytes vanish on
 * close — worst-case extra disk ≈ maxBytes × live sessions. A failed
 * rotation rename (e.g. `.log.1` is a directory) sets `rotationDisabled` so
 * appending cannot become a rename-retry storm per chunk; appending then
 * grows unbounded, which is exactly the pre-rotation worst case.
 *
 * INVARIANT: all rotation fs ops (`statSync`/`renameSync`/`createWriteStream`)
 * are SYNCHRONOUS and run inside the `data` handler / open path. PassThrough
 * `data` events cannot interleave, and the `end` handler cannot fire
 * mid-rotation; async fs here would reintroduce real races.
 */
export function attachStdioStderrDrain(
  transport: StdioClientTransport,
  serverName: string,
  logDir?: string,
  maxBytes: number = STDIO_LOG_MAX_BYTES,
): void {
  const stream = transport.stderr
  if (stream === null || stream === undefined) return
  const tail = new BoundedTail(STDERR_TAIL_CAPACITY)
  tails.set(transport, tail)
  const sink = createStdioStderrSink(join(logDir ?? defaultStdioLogDir(), `${serverName}.log`), maxBytes)
  stream.on('data', (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    tail.push(bytes.toString('utf8'))
    sink.write(bytes)
  })
  // SDK close() does not destroy the PassThrough; the child's stderr `end`
  // does. Keep the data listener through SIGTERM grace so the last crash
  // line lands in both the ring and the file.
  stream.on('end', () => sink.close())
}

export interface StdioStderrSink {
  /** Append one pipe chunk: lazy-open, write, rotate when the tally crosses the cap. */
  write(chunk: Buffer | string): void
  /**
   * End every generation stream; resolves after their fds are closed (all
   * buffered bytes flushed), so deterministic tests can await it.
   */
  close(): Promise<void>
}

/**
 * Deterministic seam for the byte-routing/rotation decision: the exact
 * production routing a live pipe chunk receives, but chunk boundaries are
 * caller-driven inputs instead of OS-scheduling artifacts (delayed pipe
 * consumption coalesces 60ms-spaced child writes). `attachStdioStderrDrain`
 * delegates every `data` event here, so tests drive coalesced or per-chunk
 * input deterministically without changing production behavior.
 *
 * ponytail: rotation is size-based with one backup generation (the previous
 * `.log.1` is discarded on each rotation); concurrent dsh-cc sessions sharing
 * a serverName may interleave (session header marks each generation);
 * WriteStream buffer grows if the disk stalls — log must never block MCP.
 * Documented rotation edges: (a) bytes buffered in the old stream at rotation
 * time flush into `.log.1` after the rename — a crash between rename and
 * flush loses at most one stream buffer; (b) another session holding the
 * renamed `.log.1` writes into an anonymous inode whose bytes vanish on
 * close — worst-case extra disk ≈ maxBytes × live sessions. A failed
 * rotation rename (e.g. `.log.1` is a directory) sets `rotationDisabled` so
 * appending cannot become a rename-retry storm per chunk; appending then
 * grows unbounded, which is exactly the pre-rotation worst case.
 *
 * INVARIANT: all rotation fs ops (`statSync`/`renameSync`/`createWriteStream`)
 * are SYNCHRONOUS and run inside `write`. PassThrough `data` events cannot
 * interleave, and the `end` handler cannot fire mid-rotation; async fs here
 * would reintroduce real races.
 */
export function createStdioStderrSink(path: string, maxBytes: number = STDIO_LOG_MAX_BYTES): StdioStderrSink {
  let rotationDisabled = maxBytes <= 0
  let file: WriteStream | undefined
  // Byte tally for the currently open generation, reset to the just-opened
  // file's size on every open (0 after a rotation, pre-existing size
  // otherwise). The `--- dsh-cc pid … ---` session header bytes are
  // deliberately NOT counted: the cap governs captured server output, not
  // our bookkeeping lines.
  let tally = 0
  // Resolved when a generation's fd is closed (buffered bytes flushed).
  let flushes: Promise<unknown>[] = []
  const endStream = (stream: WriteStream): void => {
    flushes.push(new Promise((resolve) => { stream.once('close', () => resolve(undefined)); stream.end() }))
  }
  const open = (): void => {
    file = openLogFile(path, rotationDisabled ? 0 : maxBytes, (seed) => { tally = seed })
  }
  return {
    write(chunk) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      if (file === undefined) open() // lazy: a silent server leaves no file
      if (file === undefined) return
      file.write(bytes)
      tally += bytes.length
      if (!rotationDisabled && tally >= maxBytes) {
        let renamed = false
        try {
          // Rename WHILE the old stream is open: POSIX keeps the open fd on the
          // inode, so buffered bytes flush into `.log.1` — no loss. The chunk
          // that crossed the boundary stays in the old file; never split it.
          renameSync(path, `${path}.1`)
          renamed = true
        } catch {
          // Unrenamable backup path (EISDIR/EPERM/…): stop trying, or every
          // subsequent chunk retriggers the same doomed rename.
          rotationDisabled = true
        }
        if (renamed) {
          endStream(file)
          open()
        }
      }
    },
    close() {
      if (file !== undefined) endStream(file)
      file = undefined
      const done = Promise.all(flushes)
      flushes = []
      return done.then(() => undefined)
    },
  }
}

/**
 * Open (lazily) the generation log file: rotate an oversized existing file to
 * `<path>.1` first, seed the caller's byte tally from the file's size, then
 * append a fresh session header. Never throws.
 */
function openLogFile(path: string, maxBytes: number, seedTally: (size: number) => void): WriteStream | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true })
    if (maxBytes > 0 && fileSizeOrZero(path) >= maxBytes) {
      try {
        renameSync(path, `${path}.1`)
      } catch {
        // Leave the oversized file in place and keep appending; the mid-stream
        // path disables rotation on the same condition via its own flag.
      }
    }
    seedTally(maxBytes > 0 ? fileSizeOrZero(path) : 0)
    // openSync binds the fd to the inode NOW: a mid-stream renameSync then
    // keeps this fd on the renamed `.1`, so bytes queued before the rename
    // still flush into the old generation. A lazily-opened WriteStream would
    // resolve its open AFTER the rename and recreate `path` — splitting one
    // chunk batch across generations.
    const file = createWriteStream(path, { fd: openSync(path, 'a') })
    file.on('error', () => { /* disk-full / EACCES must not kill the host */ })
    file.write(`--- dsh-cc pid ${process.pid} ${new Date().toISOString()} ---\n`)
    return file
  } catch {
    return undefined
  }
}

/** File size, or 0 when missing (ENOENT is the common first-run path). */
function fileSizeOrZero(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
