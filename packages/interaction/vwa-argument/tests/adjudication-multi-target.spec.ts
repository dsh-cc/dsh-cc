/** Rejecting a shared finding applies to every reviewed target in that finding. */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { semanticContractHash } from '../src/review-contract.ts'
import { describe, expect, it } from 'vitest'
import { vwaAdjudicate } from '../src/commands.ts'
import { evaluateDelivery } from '../src/delivery-check.ts'
import { VwaArgumentService } from '../src/report.ts'
import type { AdjudicationRecord, Finding } from '../src/types.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { DEFAULT_VWA_ARGUMENT_SETTINGS } from '../src/settings.ts'
import { CONTRACT, makeWorkspace } from './helpers.ts'
import { claimsResponse, fakeAdapter, makeClaim, NOW } from './review-helpers.ts'

async function adjudicatedBatch(keepAdditionalFinding = false) {
  const workspace = makeWorkspace()
  const frozen = freezeReviewSettings({ ...DEFAULT_VWA_ARGUMENT_SETTINGS, 'review-claims-batch-size': 2 })
  const initialized = workspace.store.init(CONTRACT, frozen)
  if (!initialized.ok) throw new Error(initialized.message)
  const claim = makeClaim('fact', 'The council closed the port in May.')
  const other = { ...makeClaim('fact', 'The vote passed unanimously.'), importance: 'supporting' as const }
  const artifactId = `art_${randomUUID()}`
  const text = `${claim.text}\n${other.text}\n`
  const otherStart = claim.text.length + 1
  writeFileSync(join(workspace.root, 'report.md'), text)
  const updated = workspace.store.withTransaction<void>({
    expectedRevision: 1, requestId: randomUUID(), payloadHash: sha256Hex('bind batch'),
    applyFn(snapshot) {
      snapshot.claims.push(claim, other)
      snapshot.artifacts.push({
        id: artifactId, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
        path: 'report.md', contentHash: sha256Hex(text), outline: [],
        occurrences: [
          { claimId: claim.id, span: { start: 0, end: claim.text.length }, exactText: claim.text },
          { claimId: other.id, span: { start: otherStart, end: otherStart + other.text.length }, exactText: other.text },
        ],
      })
      return { result: undefined }
    },
  })
  if (!updated.ok) throw new Error(updated.message)
  const head = workspace.store.readHead()
  if (!head.ok) throw new Error(head.message)
  const snapshot = head.data.snapshot
  const finding: Finding = {
    id: `finding_${randomUUID()}`, code: 'HIST-01', targetIds: [claim.id, other.id], severity: 'major',
    explanation: 'The source was misread.', evidenceIds: [], artifactSpans: [], repair: 'manual-review',
  }
  const findings = keepAdditionalFinding
    ? [finding, { ...finding, id: `finding_${randomUUID()}`, targetIds: [other.id], explanation: 'Another unresolved issue.' }]
    : [finding]
  const adapter = fakeAdapter([() => ({
    raw: claimsResponse(claim.id, 'fail', {
      targets: [claim, other].map((c) => ({
        targetId: c.id, searchSufficiency: 'checked',
        checks: [{ ruleId: 'HIST-01', result: 'fail', rationale: 'The shared finding applies.', evidenceIds: [] }],
      })),
      findings,
    }),
  })])
  const outcome = await executeReviewRun({
    deps: { root: workspace.root, adapter, budget: frozen.budget, contractHash: semanticContractHash(snapshot.contract) },
    runId: `run_${randomUUID()}`, requestId: randomUUID(), stages: ['claims'],
    targetClaimIds: [claim.id, other.id], snapshot, signal: new AbortController().signal,
  })
  expect(outcome.status).toBe('completed')
  const record = outcome.records[0]!
  if (record.stage === 'extract') throw new Error('expected a claims review')
  const findingId = record.response!.findings[0]!.id
  const adjudicated = await vwaAdjudicate(workspace.root, workspace.projectId, findingId, 'reject', 'The source explicitly records the closure.')
  expect(adjudicated.kind).toBe('success')
  const { adjudications } = JSON.parse(readFileSync(
    join(workspace.root, '.dsh', 'vwa', workspace.projectId, 'adjudications.json'), 'utf8',
  )) as { adjudications: AdjudicationRecord[] }
  return { ...workspace, snapshot, artifactId, text, records: outcome.records, findingId, adjudications }
}

describe('multi-target adjudications', () => {
  it('clears the failed rule for every target of a rejected shared finding', async () => {
    const f = await adjudicatedBatch()
    const check = evaluateDelivery({ ...f, pendingRunIds: [] })
    expect(check.findingCounts.major).toBe(0)
    expect(check.checks.argument).toBe('pass')
    // Delivery changes its effective copy, preserving the original review ledger.
    for (const record of f.records) {
      if (record.stage === 'extract') throw new Error('expected a claims review')
      expect(record.response!.targets.every((t) => t.checks.every((c) => c.result === 'fail'))).toBe(true)
      expect(record.response!.findings.map((finding) => finding.id)).toContain(f.findingId)
    }
  })

  it('applies the shared rejection through the report service', async () => {
    const f = await adjudicatedBatch()
    const service = new VwaArgumentService({ root: f.root })
    const { check } = await service.checkForDelivery(f.projectId, f.artifactId)
    expect(check.findingCounts.major).toBe(0)
    expect(check.checks.argument).toBe('pass')
  })

  it('retains failure when another finding on the same rule and target remains active', async () => {
    const f = await adjudicatedBatch(true)
    const check = evaluateDelivery({ ...f, pendingRunIds: [] })
    expect(check.findingCounts.major).toBe(1)
    expect(check.checks.argument).toBe('fail')
  })
})
