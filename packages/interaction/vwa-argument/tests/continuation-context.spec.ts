/** Regressions for continuation model inputs and scope-sensitive current judgments. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeReviewRun } from '../src/review-runner.ts'
import { allRecords, continuePreCheck } from '../src/review-continue.ts'
import { currentReviews } from '../src/review-current.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { BUDGET, claimsResponse, fakeAdapter, makeClaim, makeEvidence, makeGroup, makeSnapshot, makeSource, NOW } from './review-helpers.ts'

function world() {
  const root = mkdtempSync(join(tmpdir(), 'vwa-context-'))
  const source = makeSource(), claim = makeClaim()
  claim.scope.corpus = [source.id]
  const snapshot = makeSnapshot({ sources: [source], claims: [claim] })
  return { root, source, claim, snapshot, contractHash: sha256Hex(stableJson(snapshot.contract)) }
}

type Envelope = {
  stage: string
  targets: { id: string }[]
  requiredRules: { targetId: string; ruleId: string }[]
  context?: { currentReviews: unknown[] }
  currentReviewRecords?: { stage: string }[]
}
function sourceResponse(envelope: Envelope, result = 'pass', rationale = 'reviewed') {
  return JSON.stringify({
    stage: 'sources', rubricVersion: 'humanities-v1', findings: [],
    targets: envelope.targets.map((target) => ({
      targetId: target.id,
      checks: envelope.requiredRules.filter((r) => r.targetId === target.id)
        .map((r) => ({ ruleId: r.ruleId, result, rationale, evidenceIds: [] })),
    })),
  })
}

describe('continuation context and current review identity', () => {
  it('recovers after repeated transport failures without growing duplicate upstream context, including audit', async () => {
    const { root, source, claim, snapshot, contractHash } = world()
    const text = 'A fact.', artifact = { id: `art_${randomUUID()}`, path: 'a.md', text }
    snapshot.artifacts.push({
      id: artifact.id, path: artifact.path, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
      contentHash: sha256Hex(text), outline: [], occurrences: [],
    })
    let broken = true
    const counts: number[] = [], lengths: number[] = []
    let auditRecords: Envelope['currentReviewRecords']
    const adapter = fakeAdapter([(req) => {
      const envelope = JSON.parse(req.messages[1]!.content) as Envelope
      if (envelope.stage === 'sources')
        return { raw: sourceResponse(envelope, 'pass', 'x'.repeat(1800)), inputTokens: 1, outputTokens: 1 }
      if (envelope.stage === 'extract') return { raw: JSON.stringify({ items: [] }), inputTokens: 1, outputTokens: 1 }
      if (envelope.stage === 'align') {
        auditRecords = envelope.currentReviewRecords
        return { raw: JSON.stringify({
          stage: 'align', rubricVersion: 'humanities-v1', findings: [], alignment: [],
          targets: [{ targetId: artifact.id, checks: envelope.requiredRules.map((r) => ({
            ruleId: r.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [],
          })) }],
        }), inputTokens: 1, outputTokens: 1 }
      }
      counts.push(envelope.context!.currentReviews.length)
      lengths.push(req.messages.reduce((sum, m) => sum + m.content.length, 0))
      if (broken) throw new Error('temporary transport failure')
      return { raw: claimsResponse(claim.id, 'pass'), inputTokens: 1, outputTokens: 1 }
    }])
    for (let i = 0; i < 4; i++) {
      broken = i < 3
      const outcome = await executeReviewRun({
        deps: { root, adapter, budget: BUDGET, maxContextChars: 18_000, contractHash },
        snapshot, runId: `run_${randomUUID()}`, requestId: randomUUID(),
        stages: ['sources', 'claims'], targetClaimIds: [claim.id], continueMode: i > 0,
        signal: new AbortController().signal,
      })
      expect.soft(outcome.status).toBe(broken ? 'incomplete' : 'completed')
    }
    expect.soft(counts).toEqual([1, 1, 1, 1, 1, 1, 1])
    expect.soft(new Set(lengths).size).toBe(1)
    const audit = await executeReviewRun({
      deps: { root, adapter, budget: BUDGET, maxContextChars: 18_000, contractHash },
      snapshot, artifact, runId: `run_${randomUUID()}`, requestId: randomUUID(), stages: ['audit'],
      targetClaimIds: [claim.id], continueMode: true, signal: new AbortController().signal,
    })
    expect.soft(audit.status).toBe('completed')
    expect.soft(auditRecords?.filter((r) => r.stage === 'sources')).toHaveLength(1)
    expect.soft(auditRecords?.filter((r) => r.stage === 'claims')).toHaveLength(1)
    // Reuse still has an auditable persisted copy for each run.
    expect(allRecords(root, snapshot.projectId).filter((r) => r.stage === 'sources' && r.targetRefs[0]?.id === source.id)).toHaveLength(4)
  })

  it('keeps old-scope source checks historical after adding SOURCE-03, while preserving real same-scope disagreement', async () => {
    const { root, source, claim, snapshot, contractHash } = world()
    const other = makeClaim(), source2 = makeSource()
    other.scope.corpus = [source2.id]
    const evidence = makeEvidence(source), evidence2 = makeEvidence(source2)
    snapshot.claims.push(other)
    snapshot.sources.push(source2)
    snapshot.evidence.push(evidence, evidence2)
    snapshot.groups.push(makeGroup(claim.id, [evidence.id]), makeGroup(other.id, [evidence2.id]))
    let verdict = 'pass'
    const adapter = fakeAdapter([(req) => ({
      raw: sourceResponse(JSON.parse(req.messages[1]!.content), verdict), inputTokens: 1, outputTokens: 1,
    })])
    const targets = [claim.id, other.id]
    const run = (targetClaimIds: string[], continueMode: boolean) => executeReviewRun({
      deps: { root, adapter, budget: BUDGET, contractHash }, snapshot,
      runId: `run_${randomUUID()}`, requestId: randomUUID(), stages: ['sources'], targetClaimIds,
      continueMode, signal: new AbortController().signal,
    })
    expect((await run([claim.id], false)).status).toBe('completed')
    expect((await run(targets, true)).status).toBe('completed')
    const selected = currentReviews(snapshot, allRecords(root, snapshot.projectId), targets)
    expect.soft(selected.stages.sources).toBe('pass')
    expect.soft(selected.findings).toEqual([])
    expect.soft(selected.records).toHaveLength(2)
    expect(continuePreCheck({ root, adapter, contractHash, snapshot, stages: ['sources'], targetClaimIds: targets, budget: BUDGET }))
      .toMatchObject({ code: 'NOTHING_TO_CONTINUE' })
    // A fresh second opinion with the SAME required rules must still expose disagreement.
    verdict = 'fail'
    expect((await run(targets, false)).status).toBe('completed')
    const conflicting = currentReviews(snapshot, allRecords(root, snapshot.projectId), targets)
    expect(conflicting.stages.sources).toBe('needs-review')
    expect(conflicting.findings.some((f) => f.code === 'REVIEWER_DISAGREEMENT')).toBe(true)
    expect(conflicting.records.some((r) => r.response?.targets.some((t) => t.checks.some((c) => c.result === 'fail')))).toBe(true)
  })
})
