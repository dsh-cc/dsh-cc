/**
 * Extraction-window pins (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Building a
 * complete window from the event watermark" and the test table): the seq-0
 * correction is inside the first window, plugin injections are not facts, and
 * an image, an over-count window, a truncated index or a compaction overlap all
 * refuse to be treated as complete reviewed material.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DEFAULT_EXTRACTION_DECISION_SETTINGS } from '../src/extraction-settings.ts'
import {
  INDEX_CAP_LINES,
  buildExtractionWindow,
  estimateStateTokens,
  type ExtractionWindow,
  type IndexSnapshot,
} from '../src/extraction-window.ts'

/** Budgets from the shipped defaults, so the 64-event cap is pinned by the settings. */
const BUDGET = {
  maxSurfaceEvents: DEFAULT_EXTRACTION_DECISION_SETTINGS.maxSurfaceEvents,
  maxStateBytes: DEFAULT_EXTRACTION_DECISION_SETTINGS.maxStateBytes,
  maxInputTokens: DEFAULT_EXTRACTION_DECISION_SETTINGS.maxInputTokens,
}

let counter = 0
const nextId = (): string => `msg-${counter++}`

/** One surface event, shaped like the v4 log (cast: the builder reads defensively). */
function surfaceEvent(
  seq: number | string,
  type: 'user/message' | 'assistant/message' | 'tool/result',
  data: unknown,
  surfaceOp: unknown = 'append',
): SessionEvent {
  return { type, seq, time: 0, surfaceOp, data } as unknown as SessionEvent
}

function userEvent(seq: number | string, text: string, source: unknown = { kind: 'user' }): SessionEvent {
  return surfaceEvent(seq, 'user/message', {
    id: nextId(),
    role: 'user',
    content: [{ type: 'text', text }],
    ...(source === undefined ? {} : { source }),
  })
}

function assistantEvent(seq: number | string, blocks: readonly unknown[]): SessionEvent {
  return surfaceEvent(seq, 'assistant/message', {
    turn: 1,
    step: 1,
    message: { id: nextId(), role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' } },
    stream: [],
  })
}

function assistantText(seq: number | string, text: string): SessionEvent {
  return assistantEvent(seq, [{ type: 'text', text }])
}

function toolEvent(seq: number | string, text: string, isError = false): SessionEvent {
  return surfaceEvent(seq, 'tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: nextId(),
      role: 'tool',
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: 'call-1' },
      toolCallId: 'call-1',
      ...(isError ? { isError: true } : {}),
    },
  })
}

/** A non-surface log record (turn boundary, plugin notice, …). */
function logEvent(seq: number, type: string): SessionEvent {
  return { type, seq, time: 0, data: { note: 'injection' } } as unknown as SessionEvent
}

interface BuildOverrides {
  reviewedThrough?: number | string
  capturedHead?: number | string
  index?: IndexSnapshot
  maxSurfaceEvents?: number
  maxStateBytes?: number
  maxInputTokens?: number
}

function build(events: readonly SessionEvent[], overrides: BuildOverrides = {}): ExtractionWindow {
  const last = events.at(-1)
  return buildExtractionWindow({
    events,
    reviewedThrough: overrides.reviewedThrough ?? -1,
    capturedHead: overrides.capturedHead ?? ((last as { seq?: number } | undefined)?.seq ?? 0),
    index: overrides.index ?? { kind: 'absent' },
    maxSurfaceEvents: overrides.maxSurfaceEvents ?? BUDGET.maxSurfaceEvents,
    maxStateBytes: overrides.maxStateBytes ?? BUDGET.maxStateBytes,
    maxInputTokens: overrides.maxInputTokens ?? BUDGET.maxInputTokens,
  })
}

const ABSENT: IndexSnapshot = { kind: 'absent' }

describe('window bounds and roles', () => {
  it('includes a seq-0 user correction in the first window (watermark starts at -1)', () => {
    const window = build([userEvent(0, 'From now on this repo uses pnpm throughout; no npm.')])
    expect(window.fromExclusive).toBe(-1)
    expect(window.throughInclusive).toBe(0)
    expect(window.complete).toBe(true)
    expect(window.extractReason).toBeUndefined()
    expect(window.events).toEqual([
      { seq: 0, kind: 'user', text: 'From now on this repo uses pnpm throughout; no npm.' },
    ])
  })

  it('keeps only events above the watermark and at or below the head', () => {
    const events = [userEvent(3, 'reviewed'), assistantText(4, 'kept'), assistantText(5, 'past head')]
    const window = build(events, { reviewedThrough: 3, capturedHead: 4 })
    expect(window.events.map((event) => event.seq)).toEqual([4])
  })

  it('orders evidence ascending and preserves each original role', () => {
    const events = [toolEvent(6, 'command failed', true), userEvent(4, 'correction'), assistantText(5, 'ack')]
    const window = build(events, { capturedHead: 6 })
    expect(window.events.map((event) => event.kind)).toEqual(['user', 'assistant', 'tool'])
    expect(window.events.map((event) => event.seq)).toEqual([4, 5, 6])
    expect(window.events[2]).toEqual({ seq: 6, kind: 'tool', text: 'command failed', isError: true })
    expect(window.events[1]).not.toHaveProperty('isError')
  })

  it('never turns a plugin injection (source kind memory) into evidence', () => {
    const events = [
      userEvent(1, 'repo memory excerpt: the build uses pnpm', { kind: 'memory' }),
      logEvent(2, 'plugin:memory-inject'),
      userEvent(3, 'And keep the README in sync.'),
    ]
    const window = build(events, { capturedHead: 3 })
    expect(window.complete).toBe(true)
    expect(window.events).toEqual([{ seq: 3, kind: 'user', text: 'And keep the README in sync.' }])
  })

  it('does not let non-surface records advance or complete the window', () => {
    const events = [logEvent(7, 'turn/start'), userEvent(8, 'only a boundary after this')]
    const window = build(events, { capturedHead: 8 })
    expect(window.events).toHaveLength(1)
    expect(window.complete).toBe(true)
  })

  it('drops reasoning and tool-call blocks without making the window incomplete', () => {
    const window = build([
      assistantEvent(1, [
        { type: 'reasoning', text: 'private deliberation' },
        { type: 'text', text: 'pnpm will be used from here on.' },
        { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      ]),
    ])
    expect(window.complete).toBe(true)
    expect(window.events).toEqual([{ seq: 1, kind: 'assistant', text: 'pnpm will be used from here on.' }])
  })

  it('keeps multiple text blocks in order', () => {
    const window = build([userEvent(1, 'first'), assistantText(2, 'second')])
    const multi = build([
      surfaceEvent(3, 'user/message', {
        id: nextId(),
        role: 'user',
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
        source: { kind: 'user' },
      }),
    ])
    expect(window.events).toHaveLength(2)
    expect(multi.events[0]?.text).toBe('line one\nline two')
  })

  it('keeps the host seq identity (string seqs stay strings)', () => {
    const window = build([userEvent('12', 'string-keyed log'), assistantText('13', 'reply')], {
      reviewedThrough: '11',
      capturedHead: '13',
    })
    expect(window.fromExclusive).toBe('11')
    expect(window.throughInclusive).toBe('13')
    expect(window.events.map((event) => event.seq)).toEqual(['12', '13'])
    expect(window.complete).toBe(true)
  })
})

describe('incomplete windows', () => {
  it('an image block makes the window incomplete', () => {
    const window = build([
      surfaceEvent(1, 'user/message', {
        id: nextId(),
        role: 'user',
        content: [{ type: 'image', attachment: { id: 'img-1' } }],
        source: { kind: 'user' },
      }),
    ])
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('incomplete')
  })

  it('an unrecognised block makes the window incomplete', () => {
    const window = build([assistantEvent(1, [{ type: 'audio', data: 'x' }])])
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('incomplete')
  })

  it('65 surface events overflow the default 64 cap and are never sent', () => {
    const events = Array.from({ length: 65 }, (_, index) => userEvent(index, `message ${index}`))
    const window = build(events, { capturedHead: 64 })
    expect(window.events).toHaveLength(65)
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('over-budget')
  })

  it('64 surface events stay within the default cap', () => {
    const events = Array.from({ length: 64 }, (_, index) => userEvent(index, `message ${index}`))
    const window = build(events, { capturedHead: 63 })
    expect(window.complete).toBe(true)
    expect(window.extractReason).toBeUndefined()
  })

  it('a truncated index (over 200 lines) makes the window incomplete and is never injected', () => {
    const index: IndexSnapshot = {
      kind: 'text',
      text: Array.from({ length: INDEX_CAP_LINES + 50 }, (_, line) => `- topic-${line}.md`).join('\n'),
    }
    const window = build([userEvent(1, 'in range')], { index })
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('incomplete')
    expect(window.existingIndex).toBe('')
  })

  it('an index over 8 KiB makes the window incomplete', () => {
    const index: IndexSnapshot = { kind: 'text', text: `- ${'x'.repeat(9000)}` }
    const window = build([userEvent(1, 'in range')], { index })
    expect(window.complete).toBe(false)
    expect(window.existingIndex).toBe('')
  })

  it('an absent index is a complete empty index; a failed read is not complete', () => {
    expect(build([userEvent(1, 'x')], { index: ABSENT })).toMatchObject({ complete: true, existingIndex: '' })
    expect(build([userEvent(1, 'x')], { index: { kind: 'failed' } })).toMatchObject({
      complete: false,
      extractReason: 'incomplete',
      existingIndex: '',
    })
  })

  it('a missing seq on a surface event makes the window incomplete', () => {
    const broken = { type: 'user/message', time: 0, data: { content: [{ type: 'text', text: 'no seq' }] } }
    const window = build([broken as unknown as SessionEvent], { capturedHead: 1 })
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('incomplete')
  })

  it('an invalid seq on a surface event makes the window incomplete', () => {
    const window = build([userEvent(-2, 'negative')], { capturedHead: 1 })
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('incomplete')
  })
})

describe('compaction rule', () => {
  const replacement = (seq: number, startSeq: number, endSeq: number): SessionEvent =>
    surfaceEvent(
      seq,
      'user/message',
      {
        id: nextId(),
        role: 'user',
        content: [{ type: 'text', text: '<compacted-summary>body</compacted-summary>' }],
        source: { kind: 'plugin', plugin: 'compact' },
      },
      { op: 'replace', startSeq, endSeq },
    )

  it('a replace range intersecting the window makes it incomplete, and the node is never evidence', () => {
    const events = [userEvent(2, 'original'), userEvent(3, 'also original'), replacement(9, 2, 3)]
    const window = build(events, { capturedHead: 9 })
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('incomplete')
    // The summary node itself is never reviewed material.
    expect(window.events.map((event) => event.seq)).toEqual([2, 3])
  })

  it('a replace range overlapping the window from before the watermark also makes it incomplete', () => {
    const events = [replacement(6, 0, 2), userEvent(3, 'after the replaced prefix')]
    const window = build(events, { reviewedThrough: 1, capturedHead: 6 })
    expect(window.complete).toBe(false)
  })

  it('a replace range entirely past the head leaves the window complete', () => {
    const events = [userEvent(2, 'reviewable'), replacement(7, 5, 6)]
    const window = build(events, { reviewedThrough: 1, capturedHead: 3 })
    expect(window.complete).toBe(true)
    expect(window.events.map((event) => event.seq)).toEqual([2])
  })

  it('an uninterpretable replace range makes the window incomplete', () => {
    const broken = surfaceEvent(
      4,
      'user/message',
      { id: nextId(), role: 'user', content: [{ type: 'text', text: 'summary' }], source: { kind: 'user' } },
      { op: 'replace', startSeq: 'x', endSeq: 2 },
    )
    const window = build([broken], { capturedHead: 4 })
    expect(window.complete).toBe(false)
  })
})

describe('budgets and fingerprints', () => {
  it('a state over max-state-bytes is over budget, not trimmed', () => {
    const events = Array.from({ length: 4 }, (_, index) => userEvent(index, 'x'.repeat(2000)))
    const window = build(events, { capturedHead: 3, maxStateBytes: 4096 })
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('over-budget')
    expect(window.events).toHaveLength(4)
  })

  it('a state over max-input-tokens is over budget', () => {
    const events = Array.from({ length: 20 }, (_, index) => userEvent(index, 'word '.repeat(200)))
    const window = build(events, { capturedHead: 19, maxInputTokens: 512 })
    expect(window.extractReason).toBe('over-budget')
  })

  it('an unreconstructable window reports incompleteness even when it is also over budget', () => {
    const events = Array.from({ length: 65 }, (_, index) => userEvent(index, `message ${index}`))
    const withImage: SessionEvent[] = [
      ...events.slice(0, 64),
      surfaceEvent(64, 'user/message', {
        id: nextId(),
        role: 'user',
        content: [{ type: 'image', attachment: { id: 'img-1' } }],
        source: { kind: 'user' },
      }),
    ]
    const window = build(withImage, { capturedHead: 64, maxInputTokens: 512 })
    expect(window.extractReason).toBe('incomplete')
  })

  it('fingerprints the window identity and the index stably', () => {
    const events = [userEvent(1, 'one'), assistantText(2, 'two')]
    const a = build(events, { index: { kind: 'text', text: '- a.md' } })
    const b = build(events, { index: { kind: 'text', text: '- a.md' } })
    const otherIndex = build(events, { index: { kind: 'text', text: '- b.md' } })
    const otherWindow = build(events, { reviewedThrough: 0, capturedHead: 2, index: { kind: 'text', text: '- a.md' } })
    expect(a.evidenceHash).toBe(b.evidenceHash)
    expect(a.indexHash).toBe(b.indexHash)
    expect(otherIndex.evidenceHash).toBe(a.evidenceHash)
    expect(otherIndex.indexHash).not.toBe(a.indexHash)
    expect(otherWindow.evidenceHash).not.toBe(a.evidenceHash)
    expect(a.evidenceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(a.indexHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('estimates tokens monotonically for the serialized state', () => {
    expect(estimateStateTokens('')).toBe(0)
    expect(estimateStateTokens('abcd')).toBeLessThan(estimateStateTokens('abcdefgh'))
    expect(estimateStateTokens('配置文件')).toBeGreaterThan(estimateStateTokens('config'))
  })

  it('an out-of-order watermark is never treated as an empty skippable window', () => {
    const window = build([userEvent(1, 'x')], { reviewedThrough: 5, capturedHead: 2 })
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('incomplete')
  })

  it('an unusable head is never treated as a complete window', () => {
    const window = buildExtractionWindow({
      events: [userEvent(1, 'x')],
      reviewedThrough: -1,
      capturedHead: 'not-a-seq',
      index: ABSENT,
      ...BUDGET,
    })
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('incomplete')
    expect(window.events).toEqual([])
  })
})

// Snapshot-local replace exemption (issue #362): the session log is
// append-only, so the raw events at replaced seqs survive in the input —
// their types decide whether a replace destroyed reviewable material. A
// replace over non-surface nodes only (the harness system-prompt snapshot
// projection replaces its own predecessor `system/message`) exempts the
// window; a replace over surface evidence (compaction-micro / CCR) stays
// destructive; gaps, inverted ranges and string seqs fail closed.

describe('snapshot-local replace exemption (issue #362)', () => {
  /** A non-surface `system/message` node, as the runtime-context/system-prompt snapshot appends. */
  const systemNode = (seq: number, text: string): SessionEvent =>
    surfaceEvent(seq, 'system/message', { content: [{ type: 'text', text }] })

  /** A `system/message` replacer carrying a replace op (the live shape at seq 985 of the issue transcript). */
  const systemReplacement = (seq: number, startSeq: number, endSeq: number): SessionEvent =>
    surfaceEvent(seq, 'system/message', { content: [{ type: 'text', text: 'snapshot v2' }] }, { op: 'replace', startSeq, endSeq })

  it('RED-live: a snapshot replace of a non-surface system node leaves the window complete', () => {
    // The exact live shape: seq 15 is a system/message, seq 985 replaces
    // [15,15], the window is (-1, 991] with genuine user evidence present.
    const events = [
      systemNode(15, 'runtime context snapshot'),
      userEvent(16, 'genuine question'),
      assistantText(17, 'genuine answer'),
      userEvent(990, 'late question'),
      systemReplacement(985, 15, 15),
    ]
    const window = build(events, { capturedHead: 991 })
    expect(window.complete).toBe(true)
    expect(window.events.map((event) => event.seq)).toEqual([16, 17, 990])
  })

  it('evidence survives and both snapshots stay absent from the evidence list', () => {
    const events = [
      systemNode(15, 'snapshot one'),
      userEvent(16, 'question'),
      systemReplacement(985, 15, 15),
    ]
    const window = build(events, { capturedHead: 991 })
    expect(window.complete).toBe(true)
    expect(window.events.map((event) => event.seq)).toEqual([16])
    // The replaced node and the replacer are both non-surface: neither is evidence.
    expect(window.events.some((event) => event.seq === 15 || event.seq === 985)).toBe(false)
  })

  it('a compaction replace over a surface seq stays destructive even with many non-surface rows present', () => {
    // Unrelated non-surface rows defeat the count short-circuit: the exemption
    // must still be decided by membership and type, not by counts.
    const events = [
      systemNode(1, 'notice one'),
      systemNode(2, 'notice two'),
      systemNode(3, 'notice three'),
      systemNode(4, 'notice four'),
      userEvent(5, 'genuine original'),
      surfaceEvent(6, 'tool/result', { message: { content: [{ type: 'text', text: 'result body' }] } }, { op: 'replace', startSeq: 5, endSeq: 5 }),
      userEvent(7, 'after the replaced evidence'),
    ]
    const window = build(events, { capturedHead: 7 })
    expect(window.complete).toBe(false)
    expect(window.extractReason).toBe('incomplete')
  })

  it('a replace range with an interior gap stays incomplete', () => {
    // [2, 4] where seq 3 never appears in the log: fail closed.
    const events = [
      systemNode(2, 'notice'),
      systemNode(4, 'notice'),
      systemReplacement(9, 2, 4),
      userEvent(5, 'question'),
    ]
    const window = build(events, { capturedHead: 9 })
    expect(window.complete).toBe(false)
  })

  it('a multi-seq range fully non-surface is exempt', () => {
    const events = [
      systemNode(2, 'notice a'),
      systemNode(3, 'notice b'),
      systemNode(4, 'notice c'),
      systemReplacement(9, 2, 4),
      userEvent(5, 'question'),
    ]
    const window = build(events, { capturedHead: 9 })
    expect(window.complete).toBe(true)
    expect(window.events.map((event) => event.seq)).toEqual([5])
  })

  it('a mixed range containing a surface seq stays incomplete', () => {
    const events = [
      systemNode(2, 'notice'),
      userEvent(3, 'surface evidence'),
      systemNode(4, 'notice'),
      systemReplacement(9, 2, 4),
      userEvent(5, 'question'),
    ]
    const window = build(events, { capturedHead: 9 })
    expect(window.complete).toBe(false)
  })

  it('an inverted range stays destructive (no vacuous exemption)', () => {
    const events = [systemNode(15, 'notice'), systemReplacement(20, 20, 15), userEvent(5, 'question')]
    const window = build(events, { capturedHead: 25 })
    expect(window.complete).toBe(false)
  })

  it('a string-seq replaced row is never exempt', () => {
    // The replaced node carries a string seq identity: the numeric exemption
    // must not coerce through it.
    const events = [
      surfaceEvent('15', 'system/message', { content: [{ type: 'text', text: 'string-seq snapshot' }] }),
      systemReplacement(985, 15, 15),
      userEvent(16, 'question'),
    ]
    const window = build(events, { capturedHead: 991 })
    expect(window.complete).toBe(false)
  })

  it('string endpoints on the replace are not exempt (unusable range)', () => {
    const broken = surfaceEvent(4, 'system/message', { content: [{ type: 'text', text: 'x' }] }, { op: 'replace', startSeq: '15', endSeq: '15' })
    const window = build([systemNode(15, 'notice'), broken, userEvent(16, 'question')], { capturedHead: 20 })
    expect(window.complete).toBe(false)
  })

  it('a huge declared range is bounded, not enumerated', () => {
    // startSeq 0 endSeq 1e9: the count short-circuit must reject before any
    // per-seq loop; a window with only two non-surface rows cannot cover it.
    const events = [
      systemNode(1, 'notice'),
      systemNode(2, 'notice'),
      systemReplacement(9, 0, 1_000_000_000),
      userEvent(5, 'question'),
    ]
    const window = build(events, { capturedHead: 9 })
    expect(window.complete).toBe(false)
  })

  it('hash stability: a window without replaces keeps byte-identical fingerprints', () => {
    const events = [userEvent(2, 'a'), assistantText(3, 'b'), userEvent(4, 'c')]
    const before = build(events, { capturedHead: 4 })
    expect(before.complete).toBe(true)
    // Rebuilding the same input must reproduce the same hashes (the index of
    // seqs introduced by the exemption must not perturb replace-free windows).
    const again = build(events, { capturedHead: 4 })
    expect(again.evidenceHash).toBe(before.evidenceHash)
    expect(again.indexHash).toBe(before.indexHash)
  })
})
