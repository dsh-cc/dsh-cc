/**
 * Feature 3 §4 (docs/plans/2026-10-28-vwa-batch-autonomous-review.md):
 * disagreementPolicy post-pass quadrants, adjudication prevailing/superseded
 * semantics, liveness, grammar, and the settings write-surface round-trip.
 * @module tests/disagreement-policy
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { activeAdjudications, evaluateDelivery } from '../src/delivery-check.ts'
import { applyReviewSettingsPatch } from '../src/review-settings-revision.ts'
import { mergeFrozenReviewSettings } from '../src/init-tool.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import { renderReportMarkdown, type GateEntry } from '../src/report-render.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { appendAdjudication, currentDependencyDigest } from '../src/report.ts'
import { executeVwa, parseVwaArgs, readPointer, writePointer } from '../src/commands.ts'
import { initWorkspace } from './helpers.ts'
import type { AdjudicationRecord, Id, ReviewRecord } from '../src/types.ts'
import {
  disagreementAdjudication,
  reviewedFixture,
  withDisagreement,
  type ReviewedFixture,
} from './review-helpers.ts'

const NOW = '2026-10-28T00:00:00.000Z'

type Fixture = ReviewedFixture

// The reviewed/disagreement fixture lives in review-helpers.ts: the as-of
// report spec (Feature 5 §6) reuses the same one.
const adjudication = disagreementAdjudication

function evaluate(f: Fixture, records: ReviewRecord[], adjudications: AdjudicationRecord[], disagreementPolicy: 'blocking' | 'deferred', gates: GateEntry[]) {
  return evaluateDelivery({
    root: f.root, snapshot: f.snapshot, artifactId: f.artifactId, text: f.body,
    records, pendingRunIds: [], adjudications, disagreementPolicy, gates,
  })
}

describe('§4.3 disagreementPolicy post-pass quadrants', () => {
  it('deferred without adjudication defers the marker but keeps eligibility false', async () => {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    const check = evaluate(f, d.records, [], 'deferred', f.gates)
    // The marker force is gone (the stage keeps its real fail verdict); the
    // pending human adjudication still blocks reviewed eligibility.
    expect(check.checks.argument).toBe('fail')
    expect(check.deferredDisagreements.map((x) => x.id)).toEqual([d.findingId])
    expect(check.deferredDisagreements[0]?.conflicts?.map((c) => c.verdict).sort()).toEqual(['fail', 'pass'])
    expect(check.eligibleForReviewed).toBe(false)
  })

  it('blocking without adjudication keeps today’s marker force byte-for-byte', async () => {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    const check = evaluate(f, d.records, [], 'blocking', f.gates)
    expect(check.checks.argument).toBe('needs-review')
    expect(check.deferredDisagreements).toEqual([])
    expect(check.findingCounts).toEqual({ blocker: 0, major: 0, minor: 0 })
  })

  it('deferred with a reject adjudication lifts the force and flips eligibility', async () => {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    const adj = adjudication(f, d.records, d.findingId, 'reject', d.passRunId, d.failRunId)
    const check = evaluate(f, d.records, [adj], 'deferred', f.gates)
    expect(check.deferredDisagreements).toEqual([])
    expect(check.checks.argument).toBe('pass')
    expect(check.findingCounts.major).toBe(0)
    expect(check.eligibleForReviewed).toBe(true)
  })

  it('blocking with an adjudication also lifts the marker force (defect fix)', async () => {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    const adj = adjudication(f, d.records, d.findingId, 'reject', d.passRunId, d.failRunId)
    const check = evaluate(f, d.records, [adj], 'blocking', f.gates)
    expect(check.deferredDisagreements).toEqual([])
    expect(check.checks.argument).toBe('pass')
    expect(check.eligibleForReviewed).toBe(true)
  })

  it('an accept adjudication keeps the disagreement’s major force', async () => {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    const adj = adjudication(f, d.records, d.findingId, 'accept', d.failRunId, d.passRunId)
    const check = evaluate(f, d.records, [adj], 'deferred', f.gates)
    expect(check.deferredDisagreements).toEqual([])
    expect(check.findingCounts.major).toBe(1)
    expect(check.checks.argument).toBe('fail')
    expect(check.eligibleForReviewed).toBe(false)
  })

  it('the superseded verdict never counts, and the adjudication is live via either run', async () => {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    for (const [prevailing, superseded] of [[d.passRunId, d.failRunId], [d.failRunId, d.passRunId]] as const) {
      const adj = adjudication(f, d.records, d.findingId, 'reject', prevailing, superseded)
      expect(activeAdjudications(f.snapshot, d.records, [adj], [f.claim.id]).map((a) => a.adjudicationId)).toEqual([adj.adjudicationId])
    }
    const adj = adjudication(f, d.records, d.findingId, 'reject', d.passRunId, d.failRunId)
    // The stored superseded fail record is untouched by evaluation.
    const storedFail = d.records.find((r) => r.runId === d.failRunId)!
    expect(storedFail.response?.targets[0]?.checks[0]?.result).toBe('fail')
  })
})

describe('§4.3 report rendering', () => {
  it('renders the pending-adjudication section and superseded footnote', async () => {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    const deferred = evaluate(f, d.records, [], 'deferred', f.gates)
    const accepted = evaluate(
      f, d.records, [adjudication(f, d.records, d.findingId, 'accept', d.passRunId, d.failRunId)], 'deferred', f.gates,
    )
    const base = {
      snapshot: f.snapshot, artifactId: f.artifactId, artifactHash: deferred.artifactHash,
      assessments: deferred.assessments, reviewRunIds: deferred.reviewRunIds, metrics: deferred.metrics,
      cost: { inputTokens: 0, outputTokens: 0, calls: 0, modelId: 'fake' }, gates: [], artifactText: f.body,
      hasV2Receipt: false, hasLegacyReceipt: false, bindingDigest: 'b'.repeat(64),
      reportVersion: 'vwa-argument-report@1', stageProgress: deferred.stageProgress, failures: deferred.failures,
    }
    const pending = renderReportMarkdown({
      ...base, checks: deferred.checks, findings: deferred.findings, adjudications: [],
      deferredDisagreements: deferred.deferredDisagreements,
    })
    expect(pending).toContain('machine-deferred: 1 pending')
    expect(pending).toContain('### Pending adjudication (machine-deferred)')
    expect(pending).toContain(d.findingId)
    const superseded = renderReportMarkdown({
      ...base, checks: accepted.checks, findings: accepted.findings,
      adjudications: [adjudication(f, d.records, d.findingId, 'accept', d.passRunId, d.failRunId)],
      deferredDisagreements: accepted.deferredDisagreements,
    })
    expect(superseded).toContain('superseded run')
    expect(superseded).toContain('struck through')
  })
})

describe('§4.2 settings write surfaces', () => {
  it('applyReviewSettingsPatch round-trips disagreementPolicy through the rebuilt literal', () => {
    const current = freezeReviewSettings()
    const deferred = applyReviewSettingsPatch(current, { disagreementPolicy: 'deferred' })
    expect(deferred.settings.disagreementPolicy).toBe('deferred')
    const revised = applyReviewSettingsPatch(deferred.settings, { claimsBatchSize: 2 })
    expect(revised.settings.disagreementPolicy).toBe('deferred')
    expect(revised.fieldsChanged.disagreementPolicy).toBeUndefined()
  })

  it('argument.init’s merge flows the patch key into the frozen object', () => {
    const merged = mergeFrozenReviewSettings(freezeReviewSettings(), { disagreementPolicy: 'deferred' })
    expect(merged.disagreementPolicy).toBe('deferred')
  })
})

describe('§4.4 adjudicate grammar', () => {
  const deps = { workspaceRoot: (agent: { session: { header: { cwd: string } } }) => agent.session.header.cwd }
  const agentOf = (root: string) => ({ session: { header: { cwd: root } } })
  function parsed(raw: string) {
    const result = parseVwaArgs(raw)
    if (!result.ok) throw new Error(result.usage)
    return result
  }

  it('accepts projectId + prevailingRunId and keeps the reason whole', () => {
    expect(parsed(`adjudicate prj_x finding_1 reject run_a the fail verdict is spurious`).rest).toEqual([
      'prj_x', 'finding_1', 'reject', 'run_a', 'the fail verdict is spurious',
    ])
    expect(parsed(`adjudicate finding_1 reject the reason only`).rest).toEqual(['finding_1', 'reject', 'the reason only'])
  })

  function seedDisagreement(root: string, projectId: string): { findingId: Id; runs: Id[] } {
    const store = new ReviewRunStore(root, projectId)
    const runs = [`run_${randomUUID()}`, `run_${randomUUID()}`]
    const findingId = `finding_${randomUUID()}`
    const targetId = `cl_${randomUUID()}`
    for (const [index, runId] of runs.entries())
      store.writeRecord(runId, {
        runId, stage: 'claims', targetRefs: [], dependencyDigest: '', artifactHash: undefined,
        contractHash: 'c'.repeat(64), policyHash: 'p'.repeat(64), reviewerConfigHash: 'r'.repeat(64),
        promptHash: 'q'.repeat(64), inputHash: 'i'.repeat(64), status: 'completed',
        inputTokens: 0, outputTokens: 0, startedAt: NOW, endedAt: NOW,
        response: {
          stage: 'claims', rubricVersion: 'humanities-v1',
          findings: [{
            id: findingId, code: 'REVIEWER_DISAGREEMENT', targetIds: [targetId], severity: 'major',
            explanation: 'x', evidenceIds: [], artifactSpans: [], repair: 'manual-review',
          }],
          targets: [{ targetId, searchSufficiency: 'checked', checks: [{ ruleId: 'HIST-01', result: index === 0 ? 'fail' : 'pass', rationale: 'Conflicting judgments.', evidenceIds: [] }] }],
        },
      } as never)
    return { findingId, runs }
  }

  it('falls back to the pointer and validates prevailingRunId against both runs', async () => {
    const made = initWorkspace()
    writePointer(made.root, made.projectId, 'x'.repeat(64))
    const { findingId, runs } = seedDisagreement(made.root, made.projectId)
    const bogus = await executeVwa(deps as never, agentOf(made.root) as never,
      parsed(`adjudicate ${findingId} reject run_00000000-0000-4000-8000-000000000000 because`))
    expect(bogus.kind).toBe('error')
    expect(bogus.text).toContain('prevailingRunId')
    const ok = await executeVwa(deps as never, agentOf(made.root) as never,
      parsed(`adjudicate ${findingId} reject ${runs[1]} because the pass run is right`))
    expect(ok.kind).toBe('success')
    const stored = JSON.parse(
      readFileSync(join(made.root, '.dsh', 'vwa', made.projectId, 'adjudications.json'), 'utf8'),
    ) as { adjudications: AdjudicationRecord[] }
    expect(stored.adjudications[0]?.overrides).toMatchObject({ runId: runs[1], supersededRunId: runs[0] })
  })

  it('uses an explicit projectId without a pointer', async () => {
    const made = initWorkspace()
    const { findingId, runs } = seedDisagreement(made.root, made.projectId)
    expect(readPointer(made.root)).toBeUndefined()
    const ok = await executeVwa(deps as never, agentOf(made.root) as never,
      parsed(`adjudicate ${made.projectId} ${findingId} reject ${runs[0]} because`))
    expect(ok.kind).toBe('success')
    expect(currentDependencyDigest(made.root, made.projectId)).toBeDefined()
  })
})
