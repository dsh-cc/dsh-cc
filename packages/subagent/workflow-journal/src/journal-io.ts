/**
 * Journal fs discipline (resume-journal design §3.3): canonical request
 * hashing, the atomic whole-file journal writer (tmp+rename + fsync, the
 * resume-pins discipline), and the boot TTL sweep. The line format itself
 * lives in `@dsh-cc/tool-workflow` (`journal-lines.ts`) — this module only
 * frames and stores serialized lines.
 * @module @dsh-cc/workflow-journal/journal-io
 */

import { mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, closeSync, fsyncSync, writeSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { serializeJournalLine, type JournalLine } from '@dsh-cc/tool-workflow'

/**
 * Canonical JSON: object keys sorted by code point, `undefined` object
 * entries dropped, arrays order-preserving (undefined array holes become
 * `null`, per JSON.stringify semantics), numbers/booleans/strings via
 * JSON.stringify semantics. Throws on any non-JSON value (functions,
 * symbols, bigint, class instances, `undefined` at the root).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      // JSON.stringify semantics: NaN/Infinity serialize as null.
      return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map(item => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`
      }
      // Plain objects only: anything else (Date, Map, class instance) is not
      // a JSON value under the strict reading this hash exists to protect.
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('canonicalJson: non-plain object is not a JSON value')
      }
      const keys = Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined)
      keys.sort(compareCodePoints)
      return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
    }
    default:
      throw new Error(`canonicalJson: ${typeof value} is not a JSON value`)
  }
}

/** Code-point (not code-unit) ordering, so keys beyond the BMP sort stably. */
function compareCodePoints(a: string, b: string): number {
  const ai = Array.from(a)
  const bi = Array.from(b)
  const len = Math.min(ai.length, bi.length)
  for (let i = 0; i < len; i++) {
    const ca = ai[i]!.codePointAt(0)!
    const cb = bi[i]!.codePointAt(0)!
    if (ca !== cb) return ca < cb ? -1 : 1
  }
  return ai.length - bi.length
}

/** 32-bit FNV-1a over the UTF-8 bytes of `text`, as 8 lowercase hex digits. */
export function fnv1a32hex(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)
    // UTF-8 encode astral code units the same way an encoder would; the
    // hash only needs stability, but byte fidelity is free here.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    if (code < 0x80) {
      hash ^= code
      hash = Math.imul(hash, 0x01000193) >>> 0
    } else {
      const bytes = code < 0x800 ? [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
        : code < 0x10000 ? [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
          : [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
      for (const byte of bytes) {
        hash ^= byte
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
    }
  }
  return hash.toString(16).padStart(8, '0')
}

/** The full-request cache key: hash of the canonicalized {prompt, outputSchema, agentOptions} triple. */
export function hashSubagentRequest(request: { prompt: unknown; outputSchema?: unknown; agentOptions?: unknown }): string {
  return fnv1a32hex(canonicalJson({
    prompt: request.prompt,
    outputSchema: request.outputSchema ?? null,
    agentOptions: request.agentOptions ?? null,
  }))
}

/**
 * One run's journal file: `<sessionDir>/<runId>.jsonl`, rewritten whole on
 * every flush (the cap is 8 MiB) through tmp+rename with fsync of the file
 * and (best-effort, platform-allowing) its directory — the resume-pins
 * atomicity discipline.
 *
 * `record` buffers by index; `drain` flushes only the contiguous prefix from
 * the next unflushed index, so an out-of-order settlement blocks later lines
 * only until the gap fills. `close` applies the terminal-gap rule: the
 * contiguous prefix is flushed, everything beyond the first permanent gap is
 * discarded, and later `record` calls are no-ops. Every `drain` resolves — a
 * write failure marks the writer unusable (further appends dropped) and warns
 * once through the injected warn callback; the run itself is never failed by
 * journaling.
 */
export class JournalWriter {
  /** Serialized lines 1..lastFlushed, in order (whole-file rewrite source of truth). */
  private flushed: string[] = []
  /** Buffered not-yet-flushed lines keyed by index. */
  private readonly buffered = new Map<number, string>()
  /** Next index a flush would emit. */
  private nextFlush = 1
  private bytesUsed = 0
  private closed = false
  private unusable = false
  private byteCapped = false
  private warned = false
  private chain: Promise<void> = Promise.resolve()
  private readonly tmpStem: string

  constructor(
    readonly journalPath: string,
    private readonly options: { maxBytes: number; warn: (message: string) => void },
  ) {
    this.tmpStem = `${journalPath}.tmp-${process.pid}`
    this.bytesUsed = existsSize(journalPath)
  }

  private warnOnce(message: string): void {
    if (this.warned) return
    this.warned = true
    this.options.warn(message)
  }

  /**
   * Buffer one line at `index`. Out-of-order is fine — the contiguous prefix
   * flushes on the next drain. Past the byte cap, or after close/failure,
   * recording stops (the run is unaffected; those seqs simply re-run live on
   * resume).
   */
  record(index: number, line: JournalLine): void {
    if (this.closed || this.unusable || this.byteCapped) return
    const serialized = serializeJournalLine(line)
    if (this.bytesUsed + bufferedBytes(this.buffered) + serialized.length + 1 > this.options.maxBytes) {
      this.byteCapped = true
      this.warnOnce(`cc-workflow-journal: journal ${this.journalPath} reached its byte cap; later agents will re-run live on resume`)
      return
    }
    this.buffered.set(index, serialized)
  }

  /** Whether the writer can still accept and flush lines. */
  get usable(): boolean {
    return !this.unusable && !this.closed
  }

  /**
   * Serialize flushes through one promise chain. Always resolves: a write
   * failure marks the writer unusable and warns once.
   */
  drain(): Promise<void> {
    const run = this.chain.then(() => this.flush(this.takeContiguous()))
    this.chain = run.catch(() => {})
    return run
  }

  /**
   * Terminal flush (design terminal-gap rule): drain the contiguous settled
   * prefix, then discard every buffered line beyond the first permanent gap
   * (children in flight at cancel time never settle, and any line after the
   * gap would resurface stale results under the fresh prefix pairing).
   * After close, `record` is a no-op.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    // Snapshot the contiguous prefix synchronously, BEFORE the buffered tail
    // is discarded — a later drain() must still write it.
    const pending = this.takeContiguous()
    const run = this.chain.then(() => this.flush(pending))
    this.chain = run.catch(() => {})
    this.buffered.clear()
  }

  /** Detach the contiguous buffered prefix starting at the next unflushed index. */
  private takeContiguous(): string[] {
    const pending: string[] = []
    while (this.buffered.has(this.nextFlush)) {
      pending.push(this.buffered.get(this.nextFlush)!)
      this.buffered.delete(this.nextFlush)
      this.nextFlush++
    }
    return pending
  }

  /** Atomic whole-file rewrite of `flushed` plus the detached `pending` lines. */
  private flush(pending: readonly string[]): void {
    if (this.unusable || pending.length === 0) return
    const lines = [...this.flushed, ...pending]
    const text = `${lines.join('\n')}\n`
    try {
      mkdirSync(dirname(this.journalPath), { recursive: true })
      // Atomic whole-file rewrite: tmp+rename, fsync of the file and (when
      // the platform allows opening a directory) its parent — resume-pins.
      const tmp = `${this.tmpStem}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      const fd = openSync(tmp, 'w')
      try {
        writeSync(fd, text)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.journalPath)
      fsyncDir(dirname(this.journalPath))
    } catch (error) {
      this.unusable = true
      this.buffered.clear()
      this.warnOnce(`cc-workflow-journal: journal write for ${this.journalPath} failed (${String(error)}); further appends dropped, the run is unaffected`)
      return
    }
    this.flushed = lines
    this.bytesUsed = text.length
  }
}

function bufferedBytes(buffered: Map<number, string>): number {
  let total = 0
  for (const line of buffered.values()) total += line.length + 1
  return total
}

function existsSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Best-effort directory fsync; unsupported platforms (or fd types) are fine. */
function fsyncDir(path: string): void {
  try {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    /* directory fsync is a durability nicety, never a requirement */
  }
}

/**
 * Boot sweep (design §3.3 retention): remove direct child directories of
 * `runsRootDir` whose mtime is older than `ttlMs`. Best-effort everywhere —
 * a missing root, an unreadable entry, or a failed delete never throws.
 */
export function sweepExpiredSessionDirs(runsRootDir: string, ttlMs: number, now: number = Date.now()): { removed: string[] } {
  const removed: string[] = []
  let names: string[]
  try {
    names = readdirSync(runsRootDir)
  } catch {
    return { removed }
  }
  for (const name of names) {
    const path = join(runsRootDir, name)
    try {
      if (!statSync(path).isDirectory()) continue
      if (now - statSync(path).mtimeMs < ttlMs) continue
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    } catch {
      /* leave what cannot be inspected or removed */
    }
  }
  return { removed }
}

/** Test/inspection helper: write a journal file directly (used by callers seeding a resume). */
export function writeJournalFile(journalPath: string, lines: readonly JournalLine[]): void {
  mkdirSync(dirname(journalPath), { recursive: true })
  writeFileSync(journalPath, lines.map(line => `${serializeJournalLine(line)}\n`).join(''))
}
