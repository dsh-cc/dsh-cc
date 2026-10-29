/** Disagreement overrides follow the actual slot, never record enumeration or marker copies. */
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vwaAdjudicate } from '../src/adjudicate.ts'
import { effectiveReviewRecords } from '../src/delivery-adjudication.ts'
import { deliveryScope, evaluateDelivery } from '../src/delivery-check.ts'
import { auditDependencyDigest, currentReviews } from '../src/review-current.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import type { AdjudicationRecord, Finding } from '../src/types.ts'
import { disagreementAdjudication, reviewedFixture, withDisagreement } from './review-helpers.ts'

function finding(targetIds: string[], code = 'HIST-01'): Finding {
  return { id: `finding_${randomUUID()}`, code, targetIds, severity: 'major', explanation: 'A real reviewer finding.', evidenceIds: [], artifactSpans: [], repair: 'manual-review' }
}

async function fixture() {
  const f = await reviewedFixture()
  const d = withDisagreement(f, f.records)
  const actualFinding = finding([f.claim.id])
  d.fail.response!.findings.push(actualFinding)
  return { f, d, actualFinding }
}

function evaluate({ f, d }: Awaited<ReturnType<typeof fixture>>, prevailing = d.passRunId) {
  const targets = deliveryScope(f.snapshot, f.artifactId, f.body).targets
  const digest = auditDependencyDigest(f.snapshot, f.artifactId, currentReviews(f.snapshot, d.records, targets).records)
  for (const r of d.records) if (r.stage === 'extract' || r.stage === 'align') r.dependencyDigest = digest
  const adj = disagreementAdjudication(f, d.records, d.findingId, 'reject', prevailing, prevailing === d.passRunId ? d.failRunId : d.passRunId)
  return evaluateDelivery({ root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body, records: d.records, pendingRunIds: [], adjudications: [adj], gates: f.gates })
}

describe('disagreement adjudication slot identity', () => {
  for (const detectingResult of ['pass', 'fail'] as const)
    for (const detectingFirst of [true, false])
      it(`finds HIST-01 when detecting ${detectingResult} run sorts ${detectingFirst ? 'first' : 'last'}`, async () => {
        const { f, d } = await fixture()
        rmSync(join(f.root, '.dsh', 'vwa', f.projectId, 'review-runs'), { recursive: true, force: true })
        const detectingId = detectingFirst ? 'run_a' : 'run_z'
        const otherId = detectingFirst ? 'run_z' : 'run_a'
        const failId = detectingResult === 'fail' ? detectingId : otherId
        const passId = detectingResult === 'pass' ? detectingId : otherId
        for (const r of d.records) r.runId = r === d.fail ? failId : passId
        d.marker.runId = detectingId
        const detected = d.records.find((r) => r.kind !== 'disagreement' && r.stage === 'claims' && r.runId === detectingId)!
        d.marker.response!.targets = structuredClone(detected.response!.targets)
        const store = new ReviewRunStore(f.root, f.projectId)
        for (const r of d.records) store.writeRecord(r.runId, r)
        for (const prevailing of [passId, failId]) {
          const result = await vwaAdjudicate(f.root, f.projectId, d.findingId, 'reject', 'The named run prevails.', prevailing)
          expect(result.kind).toBe('success')
          const stored = JSON.parse(readFileSync(join(f.root, '.dsh', 'vwa', f.projectId, 'adjudications.json'), 'utf8')) as { adjudications: AdjudicationRecord[] }
          expect(stored.adjudications.at(-1)!.overrides).toMatchObject({ ruleId: 'HIST-01', targetId: f.claim.id, runId: prevailing, supersededRunId: prevailing === passId ? failId : passId })
        }
      })

  it('refuses an ambiguous disagreement covering multiple conflicting slots', async () => {
    const { f, d } = await fixture()
    rmSync(join(f.root, '.dsh', 'vwa', f.projectId, 'review-runs'), { recursive: true, force: true })
    for (const r of d.records) if (r.stage === 'claims' && r.response)
      r.response.targets[0]!.checks.push({ ruleId: 'OTHER-01', result: r === d.fail ? 'fail' : 'pass', rationale: 'Another conflict.', evidenceIds: [] })
    const store = new ReviewRunStore(f.root, f.projectId)
    for (const r of d.records) store.writeRecord(r.runId, r)
    const result = await vwaAdjudicate(f.root, f.projectId, d.findingId, 'reject', 'Several conflicting slots.', d.passRunId)
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/slot|rule/i)
  })

  it('refuses a disagreement without one identifiable conflicting rule slot', async () => {
    const { f, d } = await fixture()
    d.fail.response!.targets = structuredClone(d.marker.response!.targets)
    const store = new ReviewRunStore(f.root, f.projectId)
    for (const r of d.records) store.writeRecord(r.runId, r)
    const result = await vwaAdjudicate(f.root, f.projectId, d.findingId, 'reject', 'No conflicting slot.', d.passRunId)
    expect(result.kind).toBe('error')
    expect(result.text).toMatch(/slot|rule/i)
  })
})

describe('effective superseded findings', () => {
  it('removes same-slot major force, restores assessments and retains the stored ledger', async () => {
    const state = await fixture()
    const before = structuredClone(state.d.records)
    const check = evaluate(state)
    expect(check.findingCounts.major).toBe(0)
    expect(check.checks.argument).toBe('pass')
    expect(check.assessments[0]!.supportGrade).toBe('B')
    expect(check.eligibleForReviewed).toBe(true)
    // Evaluation may refresh the fixture audit digest but never semantic judgments.
    expect(state.d.fail).toEqual(before.find((r) => r.runId === state.d.failRunId))
  })

  it('does not copy a detecting fail marker back into the prevailing pass', async () => {
    const state = await fixture()
    state.d.marker.runId = state.d.failRunId
    state.d.marker.response!.targets = structuredClone(state.d.fail.response!.targets)
    const check = evaluate(state)
    expect(check.findingCounts.major).toBe(0)
    expect(check.checks.argument).toBe('pass')
    expect(check.assessments[0]!.supportGrade).toBe('B')
    expect(check.eligibleForReviewed).toBe(true)
  })

  it('retains a prevailing failing judgment and its major finding', async () => {
    const state = await fixture()
    const check = evaluate(state, state.d.failRunId)
    expect(check.findingCounts.major).toBe(1)
    expect(check.checks.argument).toBe('fail')
    expect(check.assessments[0]!.supportGrade).toBe('C')
    expect(check.eligibleForReviewed).toBe(false)
  })

  it('suppresses only the superseded target within a shared batched finding and check set', async () => {
    const { f, d, actualFinding } = await fixture()
    const otherTarget = f.snapshot.sources[0]!.id
    actualFinding.targetIds.push(otherTarget)
    const target = structuredClone(d.fail.response!.targets[0]!)
    target.targetId = otherTarget
    d.fail.response!.targets.push(target)
    const before = structuredClone(d.records)
    const adj = disagreementAdjudication(f, d.records, d.findingId, 'reject', d.passRunId, d.failRunId)
    const effective = effectiveReviewRecords(d.records, [adj], new Set([d.findingId]))
    const fail = effective.find((r) => r.runId === d.failRunId)!
    expect(fail.response!.findings.find((x) => x.id === actualFinding.id)!.targetIds).toEqual([otherTarget])
    expect(fail.response!.targets.find((x) => x.targetId === f.claim.id)!.checks[0]!.result).toBe('pass')
    expect(fail.response!.targets.find((x) => x.targetId === otherTarget)!.checks[0]!.result).toBe('fail')
    expect(d.records).toEqual(before)
  })

  for (const scope of ['another-rule', 'another-target', 'shared-targets'] as const)
    it(`keeps an unresolved finding for ${scope}`, async () => {
      const state = await fixture()
      const targets = scope === 'another-rule' ? [state.f.claim.id] : scope === 'another-target' ? [state.f.snapshot.sources[0]!.id] : [state.f.claim.id, state.f.snapshot.sources[0]!.id]
      state.d.fail.response!.findings.push(finding(targets, scope === 'another-rule' ? 'OTHER-01' : 'HIST-01'))
      const check = evaluate(state)
      expect(check.findingCounts.major).toBe(1)
      expect(check.checks.argument).toBe('fail')
      expect(check.eligibleForReviewed).toBe(false)
    })
})

it('uses frozen runtime findings, skip absence and source hashes without consulting the workspace', async () => {
  const f = await reviewedFixture()
  const sourceByteHashes = f.snapshot.sources.map((s) => s.snapshotHash)
  const input = { root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body, records: f.records, pendingRunIds: [], adjudications: [], gates: f.gates }
  const before = evaluateDelivery(input)
  for (const s of f.snapshot.sources) writeFileSync(join(f.root, s.snapshotPath), 'corrupted after freeze')
  const store = new ReviewRunStore(f.root, f.projectId)
  store.initRun('run_skip')
  store.writeRequest('run_skip', { schemaVersion: 1, requestId: 'run_skip', runId: 'run_skip', stage: 'claims', targetClaimIds: [f.claim.id], artifactId: f.artifactId, status: 'completed', calls: 0, inputTokens: 0, outputTokens: 0, startedAt: '2099-01-01T00:00:00.000Z', skipAudit: true, artifactHash: before.artifactHash, entityVersion: f.snapshot.artifacts[0]!.entityVersion })
  const frozen = evaluateDelivery({ ...input, runtime: { mechanicalFindings: [], sourceByteHashes } })
  expect(frozen.auditSkip).toBeUndefined()
  expect(frozen.findings).toEqual(before.findings)
  expect(frozen.dependencyDigest).toBe(before.dependencyDigest)
  expect(frozen.eligibleForReviewed).toBe(true)
  const fail = finding([f.claim.id], 'EVID-01')
  fail.severity = 'blocker'
  const blocked = evaluateDelivery({ ...input, runtime: { auditSkip: { runId: 'frozen-skip' }, mechanicalFindings: [fail], sourceByteHashes } })
  expect(blocked.auditSkip).toEqual({ runId: 'frozen-skip' })
  expect(blocked.checks.mechanical).toBe('fail')
  expect(blocked.eligibleForReviewed).toBe(false)
})
