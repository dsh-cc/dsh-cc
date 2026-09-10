/**
 * Content-addressed, project-keyed store for crushed tool-output originals.
 *
 * Layout: `<root>/<projectKey>/<hash16>` where hash16 = sha256(original
 * utf8).slice(0,16) and projectKey = sha256(session cwd).slice(0,16) — the
 * worktree path divergence from the TUI's project-root convention is accepted
 * here: the store is self-consistent (writers and `context_retrieve` both key
 * off the session cwd). Files are plain UTF-8 JSON envelopes
 * `{v, ts, text}`; writes are atomic (temp file + rename). LRU 200 entries
 * and TTL 3600s are hard-coded constants; the sweep is invoked fire-and-forget
 * after a store write. Corrupt/expired entries fail closed on retrieve.
 *
 * @module @dsh-cc/context-crusher/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RetrieveError } from './types.ts'

export const STORE_MAX_ENTRIES = 200
export const STORE_TTL_MS = 3600_000
const HASH_RE = /^[0-9a-f]{16}$/

/** sha256 hex, first 16 chars — the shared content/project key shape. */
export function shortHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 16)
}

/** Injectable clock signature (tests pass a fake; never sleep in tests). */
export type NowFn = () => number

interface Envelope {
  v: 1
  ts: number
  text: string
}

export type RetrieveResult =
  | { ok: true; text: string }
  | { ok: false; error: RetrieveError }

/**
 * The crusher store. One instance per mounted plugin; `root` is
 * `dshHomePath('ccr')`. All I/O errors during sweep are swallowed
 * (fire-and-forget); retrieve errors are typed, never thrown.
 */
export class CrusherStore {
  private readonly entries = new Map<string, number>() // `${projectKey}/${hash}` → lastAccess
  private readonly now: NowFn

  readonly root: string

  constructor(root: string, now: NowFn = Date.now) {
    this.root = root
    this.now = now
  }

  /** Persist one original atomically; returns its content hash. */
  async put(projectKey: string, text: string): Promise<string> {
    const hash = shortHash(text)
    const key = `${projectKey}/${hash}`
    const file = join(this.root, projectKey, hash)
    const envelope: Envelope = { v: 1, ts: this.now(), text }
    const body = JSON.stringify(envelope)
    await mkdir(join(this.root, projectKey), { recursive: true })
    // Atomic write: same-directory temp file + rename, so a reader never
    // observes a partial file.
    const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, file)
    this.touch(key)
    this.evictOverCap()
    void this.sweep() // sweep-on-write, fire-and-forget (D6)
    return hash
  }

  /** Retrieve one original, failing closed on unknown/expired/corrupt. */
  async get(projectKey: string, hash: string): Promise<RetrieveResult> {
    if (!HASH_RE.test(hash)) return { ok: false, error: 'unknown_hash' }
    const key = `${projectKey}/${hash}`
    const file = join(this.root, projectKey, hash)
    let body: string
    try {
      body = await readFile(file, 'utf8')
    } catch {
      return { ok: false, error: 'unknown_hash' }
    }
    let envelope: Envelope
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed !== 'object' || parsed === null
        || (parsed as Envelope).v !== 1 || typeof (parsed as Envelope).ts !== 'number'
        || typeof (parsed as Envelope).text !== 'string') throw new Error('shape')
      envelope = parsed as Envelope
    } catch {
      return { ok: false, error: 'corrupt' }
    }
    if (this.now() - envelope.ts > STORE_TTL_MS) return { ok: false, error: 'expired' }
    this.touch(key)
    return { ok: true, text: envelope.text }
  }

  /**
   * Fire-and-forget hygiene: drop expired files and LRU-overflow beyond
   * {@link STORE_MAX_ENTRIES}. Never throws.
   */
  async sweep(): Promise<void> {
    try {
      const now = this.now()
      for (const [key, ts] of this.entries) {
        if (now - ts > STORE_TTL_MS) this.entries.delete(key)
      }
      this.evictOverCap()
    } catch {
      // Sweep is best-effort hygiene; a failure must never reach the listener.
    }
  }

  /** Drop the LRU overflow synchronously (in-memory); files go fire-and-forget. */
  private evictOverCap(): void {
    while (this.entries.size > STORE_MAX_ENTRIES) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1] - b[1])[0]
      if (oldest === undefined) break
      const [key] = oldest
      this.entries.delete(key)
      const [projectKey, hash] = key.split('/')
      if (projectKey === undefined || hash === undefined) continue
      // Synchronous single-file delete: eviction is rare and bounded, and a
      // sync delete keeps the LRU/file state coherent without async bookkeeping.
      try {
        rmSync(join(this.root, projectKey, hash), { force: true })
      } catch {
        // best-effort
      }
    }
  }

  private touch(key: string): void {
    this.entries.delete(key)
    this.entries.set(key, this.now())
  }
}
