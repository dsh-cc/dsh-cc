/**
 * Per-session pinned-message ring (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Capture).
 *
 * Every entry stores the WHOLE `user/message` payload **by reference** — the
 * captured object is the exact object the session published, never a clone and
 * never a destructured projection. That is load-bearing beyond capture: the
 * restore half re-appends the stored object verbatim, so structure the capture
 * never removed cannot be lost on the way back (§Capture, r1 MAJOR #10).
 *
 * Caps are FIFO: adding an entry that pushes the ring past `maxPinned` entries
 * or past `maxPinnedBytes` evicts oldest-first until both hold. Evictions bump
 * the process-wide `evicted` health counter.
 *
 * BYTE ESTIMATOR: `JSON.stringify(message).length` — a cheap upper-ish bound on
 * the UTF-16 code units the message occupies, deliberately not a token count
 * and not `Buffer.byteLength` (UTF-8) so the number stays allocation-free and
 * provider-agnostic. It over-counts multi-byte text slightly (code units ≤
 * bytes for the ASCII-heavy governance messages this ring holds) and it counts
 * JSON scaffolding, which is exactly the conservative direction a cap wants.
 * A message that cannot be stringified (cyclic, BigInt) falls back to the sum
 * of its text-block lengths.
 *
 * @module
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { bumpPinningHealth } from './health.ts'

/** One pinned message: the capture event's coordinates plus the payload itself. */
export interface PinRingEntry {
  /** Session log seq of the captured `user/message` event (the restore key). */
  readonly seq: number
  /** The whole `UserMessage` event payload, by reference (§Capture verbatim rule). */
  readonly message: UserMessage
  /** Unix epoch ms of the capturing event. */
  readonly ts: number
}

/** Ring bounds; supplied from the hot-read settings at capture time. */
export interface PinRingOptions {
  /** Maximum entries retained (oldest evicted first). */
  maxPinned: number
  /** Maximum estimated bytes retained (oldest evicted first). */
  maxPinnedBytes: number
}

/** The per-session ring face the capture and restore halves share. */
export interface PinRing {
  /**
   * Store one entry verbatim, then FIFO-evict until both caps hold.
   * @param entry - the captured entry (the message is kept by reference).
   * @returns `true` when stored; `false` when refused because this single
   *   message alone exceeds `maxPinnedBytes` (the ring never holds an
   *   over-cap entry — the caller records the drop).
   */
  add(entry: PinRingEntry): boolean
  /** Whether a captured seq is currently pinned. */
  has(seq: number): boolean
  /** Captured seqs, oldest first. */
  keys(): number[]
  /** The entry for one captured seq, or `undefined`. */
  get(seq: number): PinRingEntry | undefined
  /** Every entry, oldest first (a snapshot array; the entries are the live objects). */
  entries(): PinRingEntry[]
  /** Drop every entry. */
  clear(): void
  /** Live entry count. */
  readonly size: number
  /** Live estimated bytes. */
  readonly bytes: number
  /**
   * Re-apply hot-read caps (settings can change mid-session), evicting
   * oldest-first until the ring fits.
   * @returns the number of evictions performed.
   */
  setCaps(maxPinned: number, maxPinnedBytes: number): number
}

/** A positive integer cap, or the fallback when the value is unusable. */
function normalizeCap(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) return fallback
  return Math.trunc(value)
}

/**
 * Estimated bytes of one message (see the module doc for the estimator and its
 * deliberate conservatism). Never throws.
 * @param message - the captured message.
 * @returns estimated size in UTF-16 code units of the JSON rendering.
 */
export function estimateMessageBytes(message: UserMessage): number {
  try {
    return JSON.stringify(message)?.length ?? 0
  } catch {
    // Unserializable payload: fall back to text-block lengths rather than
    // letting the estimate (and the caller's cap) evaporate.
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) return 0
    return content.reduce((total, block) => {
      const text = (block as { text?: unknown } | null)?.text
      return total + (typeof text === 'string' ? text.length : 0)
    }, 0)
  }
}

/**
 * Create one session's ring.
 * @param options - initial caps (hot-read from settings at creation).
 * @returns the ring face.
 */
export function createPinRing(options: PinRingOptions): PinRing {
  let maxPinned = normalizeCap(options.maxPinned, 1)
  let maxPinnedBytes = normalizeCap(options.maxPinnedBytes, 1)
  /** Live entries with their pre-measured size (measured once, at add time). */
  const items: { entry: PinRingEntry; bytes: number }[] = []
  let bytes = 0

  /** Drop the oldest entry; `false` when the ring is already empty. */
  const evictOldest = (): boolean => {
    const oldest = items.shift()
    if (oldest === undefined) return false
    bytes -= oldest.bytes
    bumpPinningHealth('evicted')
    return true
  }

  /** FIFO-evict until both caps hold; returns the eviction count. */
  const fit = (): number => {
    let evicted = 0
    while (items.length > maxPinned) {
      if (!evictOldest()) break
      evicted += 1
    }
    while (bytes > maxPinnedBytes) {
      if (!evictOldest()) break
      evicted += 1
    }
    return evicted
  }

  return {
    add(entry: PinRingEntry): boolean {
      const entryBytes = estimateMessageBytes(entry.message)
      // A single message larger than the whole byte budget is refused outright:
      // accepting it would leave the ring permanently over its cap.
      if (entryBytes > maxPinnedBytes) return false
      items.push({ entry, bytes: entryBytes })
      bytes += entryBytes
      fit()
      return true
    },
    has: (seq: number): boolean => items.some((item) => item.entry.seq === seq),
    keys: (): number[] => items.map((item) => item.entry.seq),
    get: (seq: number): PinRingEntry | undefined =>
      items.find((item) => item.entry.seq === seq)?.entry,
    entries: (): PinRingEntry[] => items.map((item) => item.entry),
    clear: (): void => {
      items.length = 0
      bytes = 0
    },
    get size(): number {
      return items.length
    },
    get bytes(): number {
      return bytes
    },
    setCaps(nextMaxPinned: number, nextMaxPinnedBytes: number): number {
      maxPinned = normalizeCap(nextMaxPinned, maxPinned)
      maxPinnedBytes = normalizeCap(nextMaxPinnedBytes, maxPinnedBytes)
      return fit()
    },
  }
}
