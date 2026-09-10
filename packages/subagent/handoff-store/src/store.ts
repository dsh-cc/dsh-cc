/**
 * Content-addressed, project-keyed store for subagent handoff artifacts.
 *
 * Layout: `<root>/<projectKey>/<id>.md` where id = sha256(content
 * utf8).slice(0,16) + a 4-hex random suffix (globally unique even when two
 * children store identical content — the suffix makes every put a NEW
 * artifact), and projectKey = sha256(session cwd).slice(0,16). Flat per
 * project: no per-session subdir (session lives only in the ledger). Files
 * are plain UTF-8 JSON envelopes `{v, ts, text, label?, agent?}`; writes are
 * atomic (temp file + rename). TTL 24 h (authoritative on READ, via the
 * stored envelope ts) and an LRU cap of 500 entries — both DISK-BASED: the
 * sweep runs readdir + mtime over the projectKey dir, so a freshly spawned
 * child process (a new store instance) sees the same eviction state; there is
 * deliberately no in-memory LRU map. The sweep's TTL pass uses mtime as a
 * cheap proxy (get() bumps mtime on access); the strict ts check stays on
 * the read path. Sweep is per-project (the putting session's own bucket).
 *
 * @module @dsh-cc/handoff-store/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HandoffError, HandoffMeta } from './types.ts'

export const MAX_ENTRIES = 500
export const TTL_MS = 24 * 3600_000
const ID_RE = /^[0-9a-f]{20}$/
/** sha256 hex, first 16 chars — the shared project-key shape (CCR store.ts). */
const KEY_LEN = 16

/** sha256 hex, first 16 chars. */
export function projectKeyOf(cwd: string): string {
  return createHash('sha256').update(cwd, 'utf8').digest('hex').slice(0, KEY_LEN)
}

/** Injectable clock signature (tests pass a fake; never sleep in tests). */
export type NowFn = () => number

interface Envelope extends HandoffMeta {
  v: 1
  ts: number
  text: string
}

export type HandoffResult =
  | { ok: true; text: string; label?: string; agent?: string }
  | { ok: false; error: HandoffError }

/**
 * The handoff store. One instance per mounted plugin; `root` is
 * `dshHomePath('handoff')`. State is entirely on disk — two instances
 * (separate child processes) observe the same TTL/LRU behavior. Retrieve
 * errors are typed, never thrown; sweep never throws.
 */
export class HandoffStore {
  readonly root: string
  private readonly now: NowFn

  constructor(root: string, now: NowFn = Date.now) {
    this.root = root
    this.now = now
  }

  /** Persist one artifact atomically; returns its 20-hex id. */
  async put(projectKey: string, text: string, meta: HandoffMeta = {}): Promise<string> {
    const id = `${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, KEY_LEN)}${randomBytes(2).toString('hex')}`
    const dir = join(this.root, projectKey)
    const file = join(dir, `${id}.md`)
    const envelope: Envelope = { v: 1, ts: this.now(), text, ...meta }
    await mkdir(dir, { recursive: true })
    // Atomic write: same-directory temp file + rename (CCR store pattern).
    const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
    await writeFile(tmp, JSON.stringify(envelope), 'utf8')
    await rename(tmp, file)
    void this.sweep(projectKey) // sweep-on-put, fire-and-forget
    return id
  }

  /**
   * Retrieve one artifact, failing closed on unknown/expired/corrupt. An
   * expired entry is also deleted lazily. `id` must be exactly 20 hex and
   * resolves ONLY inside this projectKey's directory — the tool layer keys
   * projectKey off the fetching session's cwd, so a malformed or
   * cross-project id can never read outside the store root.
   */
  async get(projectKey: string, id: string): Promise<HandoffResult> {
    if (!ID_RE.test(id)) return { ok: false, error: 'unknown_id' }
    const file = join(this.root, projectKey, `${id}.md`)
    // Belt-and-suspenders against future shape changes: the id must name a
    // direct child of the project directory, never anything outside it.
    if (join(file) !== join(this.root, projectKey, `${id}.md`)) return { ok: false, error: 'unknown_id' }
    let body: string
    try {
      body = await readFile(file, 'utf8')
    } catch {
      return { ok: false, error: 'unknown_id' }
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
    if (this.now() - envelope.ts > TTL_MS) {
      try {
        rmSync(file, { force: true }) // lazy TTL delete
      } catch {
        // best-effort
      }
      return { ok: false, error: 'expired' }
    }
    // LRU touch on disk: bump mtime so the sweep keeps hot entries.
    try {
      const t = this.now() / 1000
      utimesSync(file, t, t)
    } catch {
      // best-effort
    }
    const { label, agent } = envelope
    return (label === undefined && agent === undefined)
      ? { ok: true, text: envelope.text }
      : { ok: true, text: envelope.text, ...(label === undefined ? {} : { label }), ...(agent === undefined ? {} : { agent }) }
  }

  /**
   * Disk-based hygiene for one project bucket: readdir + mtime (NO in-memory
   * bookkeeping — spawned children are separate processes). Drops entries
   * whose mtime is past the TTL (mtime is bumped on access; the strict
   * envelope-ts check remains authoritative on read), then LRU-evicts the
   * oldest by mtime beyond {@link MAX_ENTRIES}. Never throws.
   */
  async sweep(projectKey: string): Promise<void> {
    try {
      const dir = join(this.root, projectKey)
      const now = this.now()
      const aged: Array<{ name: string; mtime: number }> = []
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md') || !ID_RE.test(name.slice(0, -3))) continue
        try {
          const mtime = statSync(join(dir, name)).mtimeMs
          if (now - mtime > TTL_MS) {
            rmSync(join(dir, name), { force: true })
            continue
          }
          aged.push({ name, mtime })
        } catch {
          // lost a race with a sibling sweep; skip
        }
      }
      // ponytail: full sort of ≤500 entries per put — fine at this scale;
      // heap only if the cap grows orders of magnitude.
      aged.sort((a, b) => a.mtime - b.mtime)
      for (const entry of aged.slice(0, Math.max(0, aged.length - MAX_ENTRIES))) {
        try {
          rmSync(join(dir, entry.name), { force: true })
        } catch {
          // best-effort
        }
      }
    } catch {
      // Sweep is best-effort hygiene; a failure must never reach the tool.
    }
  }
}
