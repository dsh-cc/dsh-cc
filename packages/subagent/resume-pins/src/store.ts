/**
 * Per-child pin store: one JSON file per child under `<pinsRoot>/<childId>.json`.
 *
 * Durability and coherence contract (plan §4.1/§4.6):
 * - `write` creates a pin and fails if one already exists (preallocated ids).
 * - `update` rewrites the file atomically (temp file + rename) AND publishes
 *   the mutated pin to the store's single synchronous in-memory cache, so no
 *   stale-cache read can serve the first request after a gate mutation.
 * - `read` resolves `undefined` for an absent pin (legacy/foreign child,
 *   pass-through) and a `{kind:'corrupt'}` sentinel for a file that exists
 *   but is unparseable or unsupported-version — fail-closed callers
 *   distinguish those; it never throws.
 * - `remove` tombstone-deletes the file and the cache entry.
 * - childIds are UUID-ish; anything containing a path separator or `..` is
 *   rejected before it can traverse out of `pinsRoot`.
 *
 * @module @dsh-cc/subagent-resume-pins/store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PinParseError, parsePin, writePin, type ResumePin, type ResumePinDraft } from './pin.ts'

/** Distinguishing result for an existing-but-unreadable pin file. */
export type CorruptPin = { readonly kind: 'corrupt'; readonly reason: string }

/** The childId shape the store accepts: no separators, no `..`. */
function assertSafeChildId(childId: string): void {
  if (childId.length === 0 || childId.includes('/') || childId.includes('\\') || childId.includes('..')) {
    throw new Error(`unsafe resume-pin childId: ${JSON.stringify(childId)}`)
  }
}

/**
 * Owns the pin files under one root and the single shared in-memory cache the
 * gate and overlay listeners consult.
 */
export class PinStore {
  private readonly cache = new Map<string, ResumePin>()

  constructor(private readonly pinsRoot: string) {
    mkdirSync(this.pinsRoot, { recursive: true })
  }

  /** The on-disk path for one child's pin (validates the childId first). */
  pathFor(childId: string): string {
    assertSafeChildId(childId)
    return join(this.pinsRoot, `${childId}.json`)
  }

  /**
   * Read a pin by child id: `undefined` when absent, the corrupt sentinel when
   * the file exists but cannot be parsed. Read-through: the disk is re-read on
   * every call (files are tiny, one per model request), so a file deleted or
   * corrupted out-of-band is never served stale from the cache; the cache only
   * accelerates nothing — it exists to publish synchronous in-process updates
   * and is invalidated by any failed disk read.
   */
  read(childId: string): ResumePin | CorruptPin | undefined {
    const path = this.pathFor(childId)
    if (!existsSync(path)) {
      this.cache.delete(childId)
      return undefined
    }
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (cause) {
      this.cache.delete(childId)
      return { kind: 'corrupt', reason: `unreadable: ${String(cause)}` }
    }
    try {
      const pin = parsePin(text)
      this.cache.set(childId, pin)
      return pin
    } catch (cause) {
      this.cache.delete(childId)
      const reason = cause instanceof PinParseError ? cause.message : String(cause)
      return { kind: 'corrupt', reason }
    }
  }

  /** Read only the in-memory cache: `undefined` on miss (no disk access). */
  getCached(childId: string): ResumePin | undefined {
    return this.cache.get(childId)
  }

  /** Create the pin file; fails when a pin for this child already exists. */
  write(pin: ResumePin): void {
    const path = this.pathFor(pin.childId)
    if (existsSync(path)) {
      throw new Error(`resume pin already exists for child ${pin.childId}`)
    }
    this.atomicWrite(path, pin)
    this.cache.set(pin.childId, pin)
  }

  /**
   * Atomically rewrite a pin through `mutator` (a structural clone is handed
   * to the mutator) and publish the result to the shared cache synchronously.
   */
  update(childId: string, mutator: (draft: ResumePinDraft) => void): ResumePin {
    const current = this.read(childId)
    if (current === undefined) throw new Error(`no resume pin for child ${childId}`)
    if ('kind' in current && current.kind === 'corrupt') {
      throw new Error(`cannot update corrupt resume pin for child ${childId}`)
    }
    const draft = structuredClone(current) as ResumePinDraft
    mutator(draft)
    const updated = parsePin(writePin(draft as unknown as ResumePin))
    this.atomicWrite(this.pathFor(childId), updated)
    this.cache.set(childId, updated)
    return updated
  }

  /** Tombstone-delete the pin file and its cache entry (idempotent). */
  remove(childId: string): void {
    rmSync(this.pathFor(childId), { force: true })
    this.cache.delete(childId)
  }

  /**
   * The child ids with a pin file on disk (best-effort; used by the
   * `list_agents` annotation). Not guaranteed cached or readable.
   */
  ids(): string[] {
    try {
      return readdirSync(this.pinsRoot)
        .filter(name => name.endsWith('.json'))
        .map(name => name.slice(0, -'.json'.length))
    } catch {
      return []
    }
  }

  private atomicWrite(path: string, pin: ResumePin): void {
    const temp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    writeFileSync(temp, writePin(pin), { flag: 'wx' })
    renameSync(temp, path)
  }
}
