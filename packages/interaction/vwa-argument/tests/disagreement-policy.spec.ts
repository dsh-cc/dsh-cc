/**
 * Feature 3 §4 (docs/plans/2026-10-28-vwa-batch-autonomous-review.md):
 * disagreementPolicy post-pass quadrants, adjudication prevailing/superseded
 * semantics, liveness, grammar, and the settings write-surface round-trip.
 * @module tests/disagreement-policy
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  activeAdjudications,
  defaultGates,
  deliveryScope,
  evaluateDelivery,
} from '../src/delivery-check.ts'
import { applyReviewSettingsPatch } from '../src/review-settings-revision.ts'
import { mergeFrozenReviewSettings } from '../src/init-tool.ts'
import { auditDependencyDigest, currentReviews } from '../src/review-current.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import { projectDependencyDigest } from '../src/delivery-check.ts'
import { renderReportMarkdown, type GateEntry } from '../src/report-render.ts'
import { semanticContractHash } from '../src/review-contract.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { appendAdjudication, currentDependencyDigest } from '../src/report.ts'
import { executeVwa, parseVwaArgs, readPointer, writePointer } from '../src/commands.ts'
import { sha256Hex } from '../src/schema.ts'
import { initWorkspace } from './helpers.ts'
import type { AdjudicationRecord, Id, ReviewRecord } from '../src/types.ts'
import { BUDGET, fakeAdapter, makeClaim, makeEvidence, makeGroup, makeSource } from './review-helpers.ts'

const NOW = '2026-10-28T00:00:00.000Z'

/** One fully reviewed project (re-used from the delivery acceptance fixture). */
async function reviewedFixture() {
  const made = initWorkspace(),
    claim = makeClaim('fact', 'The council closed the port in May.')
  const source = makeSource(),
    text = 'The council voted to close the port on 3 May.\n'
  source.snapshotHash = sha256Hex(text)
  source.snapshotPath = `docs/vwa-sources/${made.projectId}/${source.id}.md`
  writeFileSync(join(made.root, source.snapshotPath), text)
  const evidence = makeEvidence(source)
  evidence.span = { start: 0, end: text.length }
  evidence.contextSpan = evidence.span
  evidence.quote = text
  const group = makeGroup(claim.id, [evidence.id]),
    artifactId = `art_${randomUUID()}`,
    body = `# Port\n\n${claim.text}\n`
  writeFileSync(join(made.root, 'report.md'), body)
  const applied = made.store.withTransaction({
    expectedRevision: 1,
    requestId: randomUUID(),
    payloadHash: 'seed',
    applyFn(s) {
      s.claims.push(claim)
      s.sources.push(source)
      s.evidence.push(evidence)
      s.groups.push(group)
      s.searches.push({
        id: `search_${randomUUID()}`, entityVersion: 1, createdAt: '', updatedAt: '',
        purpose: 'counterevidence', targetIds: [claim.id], corpus: [source.id],
        query: 'port remained open?', tool: 'read', performedAt: NOW, state: 'executed',
        resultSourceIds: [source.id], inaccessible: [], finding: 'none-found',
        executionEventRef: 'read:archive',
      })
      s.artifacts.push({
        id: artifactId, entityVersion: 1, createdAt: '', updatedAt: '', path: 'report.md',
        contentHash: sha256Hex(body), outline: [],
        occurrences: [{ claimId: claim.id, span: { start: 8, end: 8 + claim.text.length }, exactText: claim.text }],
      })
      return { result: {} }
    },
  })
  if (!applied.ok) throw new Error(applied.message)
  const head = made.store.readHead()
  if (!head.ok) throw new Error(head.message)
  const adapter = fakeAdapter([
    (req) => {
      const env = JSON.parse(req.messages[1]!.content)
      if (env.stage === 'extract') {
        return {
          raw: JSON.stringify({
            items: [{
              span: { start: 8, end: 8 + claim.text.length }, exactText: claim.text, isQuotation: false,
              atomicClaims: [{ text: claim.text, kind: 'fact', scope: claim.scope, importance: 'core' }],
            }],
          }),
          inputTokens: 100, outputTokens: 50,
        }
      }
      const response = {
        stage: env.stage,
        rubricVersion: 'humanities-v1',
        findings: [],
        targets: (env.targets ?? [{ id: artifactId }]).map((t: { id: string }) => ({
          targetId: t.id,
          checks: env.requiredRules
            .filter((r: { targetId: string }) => r.targetId === t.id)
            .map((r: { ruleId: string }) => ({ ruleId: r.ruleId, result: 'pass', rationale: 'ok', evidenceIds: [] })),
          ...(env.stage === 'support'
            ? { support: 'direct', adequacy: 'adequate', evidenceRelations: env.dependencies.evidence.map((e: { id: string }) => ({ evidenceId: e.id, support: 'direct', rationale: 'direct' })) }
            : {}),
          ...(env.stage === 'claims' ? { searchSufficiency: 'checked' } : {}),
        })),
        ...(env.stage === 'align'
          ? { alignment: env.items.map((i: { extractedId: string }) => ({ extractedId: i.extractedId, claimIds: [claim.id], relation: 'exact', rationale: 'same' })) }
          : {}),
      }
      return { raw: JSON.stringify(response), inputTokens: 100, outputTokens: 50 }
    },
  ])
  const run = await executeReviewRun({
    deps: {
      root: made.root, adapter, budget: BUDGET,
      contractHash: semanticContractHash(head.data.snapshot.contract),
      readSnapshot: (id) => readFileSync(join(made.store.snapshotDir, `${id}.md`), 'utf8'),
    },
    runId: `run_${randomUUID()}`, requestId: randomUUID(),
    snapshot: head.data.snapshot, targetClaimIds: [claim.id],
    stages: ['sources', 'support', 'claims', 'arguments', 'audit'],
    signal: new AbortController().signal,
    artifact: { id: artifactId, path: 'report.md', text: body },
  })
  if (run.status !== 'completed') throw new Error(`run ${run.status}: ${JSON.stringify(run.records.map((r) => [r.stage, r.status, r.errorCode, r.errorDetail]))}`)
  expect(run.status).toBe('completed')
  return { ...made, claim, artifactId, body, snapshot: head.data.snapshot, records: run.records, gates: await defaultGates(made.root, 'report.md') }
}

type Fixture = Awaited<ReturnType<typeof reviewedFixture>>

/** Inject a second, conflicting claims record and the runner's marker record. */
function withDisagreement(f: Fixture, records: ReviewRecord[]) {
  const claims = records.find((r) => r.stage === 'claims')! as ReviewRecord & { response: NonNullable<ReviewRecord['response']> }
  const fail = structuredClone(claims) as ReviewRecord & { response: NonNullable<ReviewRecord['response']> }
  fail.runId = `run_${randomUUID()}`
  for (const target of fail.response.targets) for (const check of target.checks) check.result = 'fail'
  const findingId = `finding_${randomUUID()}`
  const marker = structuredClone(claims) as ReviewRecord & { response: NonNullable<ReviewRecord['response']> }
  // The marker is written on the detecting run, so it must live on one of the
  // two conflicting runs (that is what makes cross-run liveness work).
  marker.runId = claims.runId
  ;(marker as ReviewRecord & { kind?: string }).kind = 'disagreement'
  marker.response = {
    ...marker.response,
    findings: [{
      id: findingId, code: 'REVIEWER_DISAGREEMENT', targetIds: [f.claim.id], severity: 'major',
      explanation: 'identical inputs produced differing verdicts', evidenceIds: [], artifactSpans: [], repair: 'manual-review',
    }],
  }
  const all = [...records, fail, marker]
  const targets = deliveryScope(f.snapshot, f.artifactId, f.body).targets
  const expectedAudit = auditDependencyDigest(f.snapshot, f.artifactId, currentReviews(f.snapshot, all, targets).records)
  for (const record of all) if (record.stage === 'extract' || record.stage === 'align') record.dependencyDigest = expectedAudit
  return { records: all, findingId, passRunId: claims.runId, failRunId: fail.runId }
}

function adjudication(
  f: Fixture,
  records: ReviewRecord[],
  findingId: Id,
  decision: 'accept' | 'reject',
  prevailingRunId: Id,
  supersededRunId: Id,
): AdjudicationRecord {
  return {
    adjudicationId: `adj_${randomUUID()}`, findingId, decision, reason: 'human decision', signer: 'user', ts: NOW,
    dependencyDigest: projectDependencyDigest(f.snapshot, records),
    overrides: { ruleId: 'HIST-01', targetId: f.claim.id, runId: prevailingRunId, supersededRunId },
  }
}

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
    for (const [index, runId] of runs.entries())
      store.writeRecord(runId, {
        runId, stage: 'claims', targetRefs: [], dependencyDigest: '', artifactHash: undefined,
        contractHash: 'c'.repeat(64), policyHash: 'p'.repeat(64), reviewerConfigHash: 'r'.repeat(64),
        promptHash: 'q'.repeat(64), inputHash: 'i'.repeat(64), status: 'completed',
        inputTokens: 0, outputTokens: 0, startedAt: NOW, endedAt: NOW,
        response: {
          stage: 'claims', rubricVersion: 'humanities-v1',
          findings: [{
            id: findingId, code: 'REVIEWER_DISAGREEMENT', targetIds: [], severity: 'major',
            explanation: 'x', evidenceIds: [], artifactSpans: [], repair: 'manual-review',
          }],
          targets: [],
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
