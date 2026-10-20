/** Regression coverage for dependency sources in the real sources-stage runner. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeReviewRun } from '../src/review-runner.ts'
import { sha256Hex } from '../src/schema.ts'
import type { SourceEnvelopeEntry } from '../src/types.ts'
import { BUDGET, fakeAdapter, makeClaim, makeEvidence, makeGroup, makeSnapshot, makeSource } from './review-helpers.ts'

describe('sources-stage dependency compaction regressions', () => {
  function fixture() {
    const envelopes: Array<{ targets: Array<{ id: string }>; context: { sources: SourceEnvelopeEntry[] } }> = []
    const adapter = fakeAdapter([({ messages }) => {
      expect(messages.reduce((chars, message) => chars + message.content.length, 0)).toBeLessThanOrEqual(48_000)
      const envelope = JSON.parse(messages[1]!.content) as typeof envelopes[number] & {
        requiredRules: Array<{ targetId: string; ruleId: string }>
      }
      envelopes.push(envelope)
      return { raw: JSON.stringify({
        stage: 'sources', rubricVersion: 'humanities-v1', findings: [],
        targets: envelope.targets.map(({ id }) => ({
          targetId: id,
          checks: envelope.requiredRules.filter((rule) => rule.targetId === id).map(({ ruleId }) => ({
            ruleId, result: 'pass', rationale: 'The target and dependency metadata disclose the source limits.', evidenceIds: [],
          })),
        })),
      }) }
    }])
    return {
      envelopes, adapter,
      run(snapshot: ReturnType<typeof makeSnapshot>, texts: Map<string, string>) {
        return executeReviewRun({
          deps: {
            root: mkdtempSync(join(tmpdir(), 'vwa-source-compaction-')), adapter, budget: BUDGET,
            contractHash: 'c'.repeat(64), readSnapshot: (id) => texts.get(id),
          },
          runId: `run_${randomUUID()}`, requestId: `req-${randomUUID()}`, stages: ['sources'],
          targetClaimIds: snapshot.claims.map((claim) => claim.id), snapshot, signal: new AbortController().signal,
        })
      },
    }
  }

  it('dispatches both large sources for one claim within the whole-message budget', async () => {
    const text = 'The committee recorded its decision. '.repeat(3000)
    const sources = [makeSource(), makeSource()].map((source) => ({ ...source, snapshotHash: sha256Hex(text) }))
    const evidence = sources.map((source) => ({ ...makeEvidence(source), quote: text.slice(0, 5) }))
    const claim = makeClaim()
    const snapshot = makeSnapshot({
      sources, evidence, claims: [claim], groups: [makeGroup(claim.id, evidence.map((entry) => entry.id))],
    })
    const f = fixture()
    const outcome = await f.run(snapshot, new Map(sources.map((source) => [source.id, text])))
    expect(outcome.status).toBe('completed')
    expect(outcome.records.filter((record) => record.status === 'completed')).toHaveLength(2)
    expect(f.adapter.state.dispatches).toBe(2)
    for (const envelope of f.envelopes) {
      expect(envelope.context.sources).toHaveLength(2)
      const inlined = envelope.context.sources.filter((source) => source.text !== undefined)
      expect(inlined.map((source) => source.id)).toEqual(envelope.targets.map((target) => target.id))
      expect(inlined[0]!.windowing).toBeDefined()
    }
  })

  it('dispatches a companion review while retaining its large JSON parent as metadata', async () => {
    const parentText = JSON.stringify({ rows: 'x'.repeat(200_000) })
    const parent = { ...makeSource(), snapshotHash: sha256Hex(parentText) }
    const summary = 'The dataset has 4000 entries. This summary discloses its derivation and access limits.'
    const companion = {
      ...makeSource(), snapshotHash: sha256Hex(summary),
      lineage: { relation: 'derived' as const, parentSourceIds: [parent.id], note: 'Distilled dataset summary' },
    }
    const claim = makeClaim()
    claim.scope.corpus = [companion.id]
    const f = fixture()
    const snapshot = makeSnapshot({ sources: [parent, companion], claims: [claim] })
    const outcome = await f.run(snapshot, new Map([[parent.id, parentText], [companion.id, summary]]))
    expect(outcome.status).toBe('completed')
    expect(f.adapter.state.dispatches).toBe(1)
    expect(outcome.records[0]!.targetRefs.map((ref) => ref.id)).toEqual([companion.id])
    expect(f.envelopes[0]!.context.sources).toEqual([parent, { ...companion, text: summary }])
  })
})
