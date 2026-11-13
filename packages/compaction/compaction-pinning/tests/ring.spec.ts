/**
 * Capture-ring unit specs (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Verification):
 * verbatim object identity, FIFO eviction order, the entry cap, the byte cap,
 * and the eviction accounting. Pure module — no harness session involved.
 *
 * @module
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import { getPinningHealth, resetPinningHealth } from '../src/health.ts'
import { createPinRing, estimateMessageBytes, type PinRingEntry } from '../src/ring.ts'

// The two governance source kinds this feature pins already exist as
// producers; the specs declare the same merge augmentation their producers do
// (turn-rules/src/wiring.ts:62-66, post-edit-verify/src/recovery-wiring.ts:18-22)
// so the fixtures are constructed through the real typed factory.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'turn-rules': { kind: 'turn-rules' } & ContextFormed
    'edit-recovery-hint': { kind: 'edit-recovery-hint' } & ContextFormed
  }
}

/** The governance source kinds under test. */
type GovernanceKind = 'turn-rules' | 'edit-recovery-hint'

/** One captured governance message (the real producer shape: kind + text). */
function message(text: string, kind: GovernanceKind = 'turn-rules'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: kind === 'turn-rules' ? { kind: 'turn-rules' } : { kind: 'edit-recovery-hint' },
  })
}

/** One ring entry at the given seq. */
function entry(seq: number, text = `pin ${seq}`): PinRingEntry {
  return { seq, message: message(text), ts: 1_000 + seq }
}

/** Caps wide enough that only the test's own pressure evicts anything. */
const LOOSE_CAPS = { maxPinned: 64, maxPinnedBytes: 262_144 }

beforeEach(() => {
  // The health counters are process-wide — every spec starts from zero.
  resetPinningHealth()
})

describe('pin ring — verbatim capture', () => {
  it('stores the entry and its message object by reference (never cloned or destructured)', () => {
    const ring = createPinRing(LOOSE_CAPS)
    const pinned = entry(1, 'Always run the focused test first.')
    expect(ring.add(pinned)).toBe(true)

    // Identity, not equality: the ring hands back the exact captured objects, so
    // a restore can re-append the whole UserMessage with its content blocks and
    // source metadata intact (§Capture, r1 MAJOR #10).
    expect(ring.get(1)).toBe(pinned)
    expect(ring.get(1)?.message).toBe(pinned.message)
    expect(ring.get(1)?.message.content).toBe(pinned.message.content)
    expect((ring.get(1)?.message.source as { kind?: unknown } | undefined)?.kind).toBe('turn-rules')
    expect(ring.get(1)?.ts).toBe(1_001)
  })

  it('answers has/get/keys/entries/size and forgets nothing on read', () => {
    const ring = createPinRing(LOOSE_CAPS)
    ring.add(entry(3))
    ring.add(entry(7))

    expect(ring.has(3)).toBe(true)
    expect(ring.has(7)).toBe(true)
    expect(ring.has(4)).toBe(false)
    expect(ring.get(4)).toBeUndefined()
    expect(ring.keys()).toEqual([3, 7])
    expect(ring.entries().map((item) => item.seq)).toEqual([3, 7])
    expect(ring.size).toBe(2)
    expect(ring.bytes).toBe(
      estimateMessageBytes(entry(3).message) + estimateMessageBytes(entry(7).message),
    )
  })

  it('clear() drops every entry and resets the byte total', () => {
    const ring = createPinRing(LOOSE_CAPS)
    ring.add(entry(1))
    ring.add(entry(2))
    ring.clear()
    expect(ring.size).toBe(0)
    expect(ring.bytes).toBe(0)
    expect(ring.keys()).toEqual([])
  })
})

describe('pin ring — FIFO caps', () => {
  it('evicts oldest-first when the entry cap is exceeded', () => {
    const ring = createPinRing({ maxPinned: 3, maxPinnedBytes: 262_144 })
    for (const seq of [1, 2, 3, 4]) ring.add(entry(seq))

    expect(ring.keys()).toEqual([2, 3, 4])
    expect(ring.size).toBe(3)
    expect(getPinningHealth().evicted).toBe(1)
  })

  it('evicts oldest-first when the byte cap is exceeded', () => {
    const one = estimateMessageBytes(entry(1).message)
    // Room for two messages plus a few bytes: the third add must evict exactly
    // the oldest entry.
    const ring = createPinRing({ maxPinned: 64, maxPinnedBytes: one * 2 + 4 })
    for (const seq of [1, 2, 3]) ring.add(entry(seq))

    expect(ring.keys()).toEqual([2, 3])
    expect(ring.bytes).toBeLessThanOrEqual(one * 2 + 4)
    expect(getPinningHealth().evicted).toBe(1)
  })

  it('refuses a single message larger than the whole byte cap (ring never holds an over-cap entry)', () => {
    const ring = createPinRing({ maxPinned: 8, maxPinnedBytes: 1_024 })
    ring.add(entry(1, 'small pin'))

    const huge = { seq: 2, message: message('x'.repeat(4_096)), ts: 1_002 }
    expect(ring.add(huge)).toBe(false)
    expect(ring.keys()).toEqual([1])
    expect(ring.bytes).toBeLessThanOrEqual(1_024)
  })

  it('setCaps shrinks an existing ring to the new caps and counts the evictions', () => {
    const ring = createPinRing(LOOSE_CAPS)
    for (const seq of [1, 2, 3, 4, 5]) ring.add(entry(seq))
    expect(ring.size).toBe(5)

    expect(ring.setCaps(2, 262_144)).toBe(3)
    expect(ring.keys()).toEqual([4, 5])
    expect(getPinningHealth().evicted).toBe(3)
  })

  it('estimator returns a positive, non-throwing size (text-only fallback for unserializable payloads)', () => {
    expect(estimateMessageBytes(message('governance'))).toBeGreaterThan(0)
    const cyclic: Record<string, unknown> = { content: [{ type: 'text', text: 'still counted' }] }
    cyclic['self'] = cyclic
    expect(estimateMessageBytes(cyclic as unknown as UserMessage)).toBe('still counted'.length)
  })
})
