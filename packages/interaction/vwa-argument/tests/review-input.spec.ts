/**
 * Slice-1 spec: semantic record hashing and deduplication (§A.3.3) and the
 * taskDependencyDigest stability guarantee under record reuse.
 * @module tests/review-input
 */

import { describe, expect, it } from 'vitest'
import { buildReverseIndex, type ReverseIndex } from '../src/dependencies.ts'
import { deduplicateBySemanticHash, semanticRecordHash, taskDependencyDigest } from '../src/review-input.ts'
import { fitSourceText, isStructuredData, reviewContext, taskEnvelope } from '../src/review-input.ts'
import { ReviewContextError } from '../src/review-call.ts'
import { planStage } from '../src/review-plan.ts'
import type { ProjectSnapshot, ReviewRecord, ReviewTask, SemanticReviewRecord } from '../src/types.ts'
import { makeClaim, makeEvidence, makeGroup, makeSnapshot, makeSource, NOW } from './review-helpers.ts'

function makeRecord(overrides: Partial<SemanticReviewRecord> = {}): SemanticReviewRecord {
  return {
    runId: 'run_a',
    stage: 'sources',
    targetRefs: [{ id: 'src_x', entityVersion: 1 }],
    dependencyDigest: 'd'.repeat(64),
    contractHash: 'c'.repeat(64),
    policyHash: 'p'.repeat(64),
    reviewerConfigHash: 'r'.repeat(64),
    promptHash: 'm'.repeat(64),
    inputHash: 'i'.repeat(64),
    status: 'completed',
    inputTokens: 100,
    outputTokens: 50,
    startedAt: NOW,
    endedAt: NOW,
    ...overrides,
  }
}

describe('semanticRecordHash (§A.3.3)', () => {
  it('is invariant to run metadata: runId, timestamps, kind, errorCode, token counts', () => {
    const base = makeRecord()
    const copy = makeRecord({
      runId: 'run_other',
      startedAt: '2026-10-17T00:00:00.000Z',
      endedAt: '2026-10-18T00:00:00.000Z',
      kind: 'disagreement',
      errorCode: 'TIMEOUT',
      inputTokens: 999,
      outputTokens: 888,
    })
    expect(semanticRecordHash(copy as ReviewRecord)).toBe(semanticRecordHash(base as ReviewRecord))
  })

  it('changes when semantic content (status, response) differs', () => {
    expect(semanticRecordHash(makeRecord({ status: 'error' }) as ReviewRecord)).not.toBe(
      semanticRecordHash(makeRecord() as ReviewRecord),
    )
  })
})

describe('deduplicateBySemanticHash (§A.3.3)', () => {
  it('collapses semantically identical records (original + reused copy)', () => {
    const original = makeRecord()
    const copy = makeRecord({ runId: 'run_next', inputTokens: 0, outputTokens: 0 })
    const other = makeRecord({ targetRefs: [{ id: 'src_y', entityVersion: 1 }], inputHash: 'f'.repeat(64) })
    const out = deduplicateBySemanticHash([original, copy, other].map((r) => r as ReviewRecord))
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(original)
  })
})

describe('taskDependencyDigest under record reuse (§A.3.3)', () => {
  it('is unchanged when a reused copy of an upstream record is added', () => {
    const claim = makeClaim('fact')
    const source = makeSource()
    const evidence = makeEvidence(source)
    const snapshot = makeSnapshot({
      sources: [source],
      evidence: [evidence],
      claims: [{ ...claim, scope: { ...claim.scope, corpus: [source.id] } }],
      groups: [makeGroup(claim.id, [evidence.id])],
    })
    const index = buildReverseIndex(snapshot)
    const task = planStage({ stage: 'claims', snapshot, index, targetClaimIds: [claim.id], core: new Set() })[0]!
    expect(task).toBeDefined()
    const sourceHash = 'a'.repeat(64)
    const original = makeRecord({
      stage: 'sources',
      targetRefs: [{ id: source.id, entityVersion: source.entityVersion }],
      contractHash: sourceHash,
    })
    // Reuse copy: same semantic content, new runId and run timestamps.
    const copy = makeRecord({
      stage: 'sources',
      targetRefs: [{ id: source.id, entityVersion: source.entityVersion }],
      contractHash: sourceHash,
      runId: 'run_next',
      startedAt: '2026-10-17T00:00:00.000Z',
      endedAt: '2026-10-18T00:00:00.000Z',
      inputTokens: 0,
      outputTokens: 0,
    })
    const digest = taskDependencyDigest(index, task, [original as ReviewRecord])
    expect(taskDependencyDigest(index, task, [original, copy] as ReviewRecord[])).toBe(digest)
  })
})

// Feature E slice 1: large-source compaction (structured-data detection and
// measured sources-stage envelope windowing, E.2.1/E.2.2/E.4).

const LIMIT = 5000

/** One prose source + one claim over it, planned as a real sources-stage task. */
function sourcesFixture(text: string, extra: Partial<ProjectSnapshot> = {}): {
  snapshot: ProjectSnapshot
  index: ReverseIndex
  task: ReviewTask
  source: ReturnType<typeof makeSource>
} {
  const source = makeSource()
  const claim = makeClaim('fact')
  const snapshot = makeSnapshot({
    sources: [source],
    claims: [{ ...claim, scope: { ...claim.scope, corpus: [source.id] } }],
    ...extra,
  })
  const index = buildReverseIndex(snapshot)
  const task = planStage({ stage: 'sources', snapshot, index, targetClaimIds: [claim.id], core: new Set() })[0]!
  return { snapshot, index, task, source }
}

function contextText(input: { snapshot: ProjectSnapshot; task: ReviewTask; text: string; maxContextChars?: number }) {
  return reviewContext({
    snapshot: input.snapshot,
    task: input.task,
    records: [],
    readSnapshot: () => input.text,
    ...(input.maxContextChars === undefined ? {} : { maxContextChars: input.maxContextChars }),
  }) as { sources: Array<{ id: string; text?: string; windowing?: { totalChars: number; headChars: number; tailChars: number } }> }
}

describe('isStructuredData (E.2.1)', () => {
  it('rejects prose whose first line has commas but inconsistent cross-line field counts', () => {
    expect(
      isStructuredData(
        'It was the best of times, it was the worst of times, it was the age of wisdom.\n' +
          'In short, the period was so far like the present period.',
      ),
    ).toBe(false)
  })
})

describe('sources-stage compaction (E.2.2/E.4)', () => {
  const structuredCases: Array<[string, string]> = [
    ['JSON', '{"a": 1, "items": ["xxxxxxxxxx"]}'],
    ['JSONL', '{"a": 1}\n{"b": 2}'],
    ['XML', '<?xml version="1.0"?>\n<root><item>xxxxxxxxxx</item></root>'],
  ]
  for (const [label, small] of structuredCases) {
    const text = small.padEnd(20_000, 'x')
    it(`throws CONTEXT_TOO_LARGE pointer for a large ${label} source, without windowing`, () => {
      const { snapshot, task, source } = sourcesFixture(text)
      try {
        contextText({ snapshot, task, text, maxContextChars: LIMIT })
        throw new Error('expected ReviewContextError')
      } catch (error) {
        expect(error).toBeInstanceOf(ReviewContextError)
        expect((error as Error).message).toContain(source.id)
        expect((error as Error).message).toContain('structured data')
        expect((error as Error).message).toContain('lineage.parentSourceIds')
      }
    })
  }

  it('detects CSV with spaces in headers', () => {
    expect(isStructuredData('First Name, Last Name\nAda, Lovelace')).toBe(true)
  })

  it('throws for a large two-column CSV source', () => {
    const { snapshot, task, source } = sourcesFixture('a,b\n' + 'x,y\n'.repeat(4000))
    expect(() => contextText({ snapshot, task, text: 'a,b\n' + 'x,y\n'.repeat(4000), maxContextChars: LIMIT })).toThrow(
      new RegExp(`${source.id}.*structured data`),
    )
  })

  it('throws for a large CSV with an empty first field', () => {
    const { snapshot, task, source } = sourcesFixture(',value\n' + 'x,y\n'.repeat(4000))
    expect(() => contextText({ snapshot, task, text: ',value\n' + 'x,y\n'.repeat(4000), maxContextChars: LIMIT })).toThrow(
      new RegExp(`${source.id}.*structured data`),
    )
  })

  it('windows a large prose source and the serialized envelope fits the limit', () => {
    const text = 'x'.repeat(20_000)
    const { snapshot, task } = sourcesFixture(text)
    const ctx = contextText({ snapshot, task, text, maxContextChars: LIMIT })
    const entry = ctx.sources[0]!
    expect(entry.text).toContain('chars omitted ...]')
    expect(entry.windowing).toBeDefined()
    expect(entry.windowing!.totalChars).toBe(20_000)
    expect(entry.windowing!.headChars + entry.windowing!.tailChars).toBeLessThan(20_000)
    expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(LIMIT)
  })

  it('keeps full text for a prose source within the limit (measured, no windowing)', () => {
    const text = 'y'.repeat(3000)
    const { snapshot, task } = sourcesFixture(text)
    const ctx = contextText({ snapshot, task, text, maxContextChars: LIMIT })
    expect(ctx.sources[0]!.text).toBe(text)
    expect(ctx.sources[0]!.windowing).toBeUndefined()
  })

  it('shrinks the window after measure-and-retry for newline-heavy prose', () => {
    // Mild JSON-escaping expansion (one newline per ten chars): the first
    // windowed candidate overshoots slightly, the retry must land under LIMIT.
    const text = 'xxxxxxxxx\n'.repeat(30_000)
    const { snapshot, task } = sourcesFixture(text)
    const ctx = contextText({ snapshot, task, text, maxContextChars: LIMIT })
    expect(ctx.sources[0]!.windowing).toBeDefined()
    expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(LIMIT)
  })

  it('shrinks the window to accommodate fat evidence context slices', () => {
    const { snapshot: base, task, source } = sourcesFixture('x'.repeat(20_000))
    const evidence = { ...makeEvidence(source), contextSpan: { start: 0, end: 3000 } }
    const snapshot = { ...base, evidence: [evidence] }
    const ctx = contextText({ snapshot, task, text: 'x'.repeat(20_000), maxContextChars: 8000 })
    expect(ctx.sources[0]!.windowing).toBeDefined()
    expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(8000)
  })

  it('throws the insufficient-room message when overhead alone exceeds the limit', () => {
    const { snapshot: base, task, source } = sourcesFixture('x'.repeat(20_000))
    const evidence = { ...makeEvidence(source), contextSpan: { start: 0, end: 10_000 } }
    const snapshot = { ...base, evidence: [evidence] }
    try {
      contextText({ snapshot, task, text: 'x'.repeat(20_000), maxContextChars: LIMIT })
      throw new Error('expected ReviewContextError')
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewContextError)
      expect((error as Error).message).toContain('insufficient room')
    }
  })

  it('taskEnvelope with maxContextChars yields a windowed envelope within the limit', () => {
    const { snapshot, task } = sourcesFixture('x'.repeat(20_000))
    const envelope = taskEnvelope({
      stage: 'sources',
      runId: 'run_1',
      task,
      snapshot,
      records: [],
      maxOutputTokens: 3000,
      readSnapshot: () => 'x'.repeat(20_000),
      maxContextChars: LIMIT,
    }) as { context: { sources: Array<{ windowing?: unknown }> } }
    expect(envelope.context.sources[0]!.windowing).toBeDefined()
    expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(LIMIT)
  })

  it('without maxContextChars, legacy behavior inlines full text with no windowing', () => {
    const text = 'x'.repeat(20_000)
    const { snapshot, task } = sourcesFixture(text)
    const ctx = contextText({ snapshot, task, text })
    expect(ctx.sources[0]!.text).toBe(text)
    expect(ctx.sources[0]!.windowing).toBeUndefined()
  })

  it('fitSourceText returns full text unchanged when the measured candidate fits', () => {
    const out = fitSourceText('abc', { context: {} }, 100_000)
    expect(out).toEqual({ text: 'abc' })
  })
})
