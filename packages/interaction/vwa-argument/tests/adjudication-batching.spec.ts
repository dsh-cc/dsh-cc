/** Human adjudications must use the same batched scope as delivery. */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { vwaAdjudicate } from '../src/commands.ts'
import { evaluateDelivery } from '../src/delivery-check.ts'
import { VwaArgumentService } from '../src/report.ts'
import type { AdjudicationRecord } from '../src/types.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { DEFAULT_VWA_ARGUMENT_SETTINGS } from '../src/settings.ts'
import { CONTRACT, makeWorkspace } from './helpers.ts'
import { claimsResponse, fakeAdapter, makeClaim, NOW } from './review-helpers.ts'

async function adjudicatedSubset() {
  const workspace = makeWorkspace()
  const frozen = freezeReviewSettings({ ...DEFAULT_VWA_ARGUMENT_SETTINGS, 'review-claims-batch-size': 2 })
  const initialized = workspace.store.init(CONTRACT, frozen)
  if (!initialized.ok) throw new Error(initialized.message)
  const claim = makeClaim('fact', 'The council closed the port in May.')
  const unused = { ...makeClaim('fact', 'The vote passed unanimously.'), importance: 'supporting' as const }
  const artifactId = `art_${randomUUID()}`
  const text = `${claim.text}\n`
  writeFileSync(join(workspace.root, 'report.md'), text)
  const updated = workspace.store.withTransaction<void>({
    expectedRevision: 1, requestId: randomUUID(), payloadHash: sha256Hex('bind subset'),
    applyFn(snapshot) {
      snapshot.claims.push(claim, unused)
      snapshot.artifacts.push({
        id: artifactId, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
        path: 'report.md', contentHash: sha256Hex(text), outline: [],
        occurrences: [{ claimId: claim.id, span: { start: 0, end: claim.text.length }, exactText: claim.text }],
      })
      return { result: undefined }
    },
  })
  if (!updated.ok) throw new Error(updated.message)
  const head = workspace.store.readHead()
  if (!head.ok) throw new Error(head.message)
  const snapshot = head.data.snapshot
  const adapter = fakeAdapter([() => ({
    raw: claimsResponse(claim.id, 'fail', { findings: [{
      id: `finding_${randomUUID()}`, code: 'HIST-01', targetIds: [claim.id], severity: 'major',
      explanation: 'The source was misread.', evidenceIds: [], artifactSpans: [], repair: 'manual-review',
    }] }),
  })])
  const outcome = await executeReviewRun({
    deps: { root: workspace.root, adapter, budget: frozen.budget, contractHash: sha256Hex(stableJson(snapshot.contract)) },
    runId: `run_${randomUUID()}`, requestId: randomUUID(), stages: ['claims'],
    targetClaimIds: [claim.id], snapshot, signal: new AbortController().signal,
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

describe('batched subset adjudications', () => {
  it('applies a human rejection to a current artifact subset without rewriting its review', async () => {
    const f = await adjudicatedSubset()
    const check = evaluateDelivery({
      ...f, pendingRunIds: [],
    })
    expect(check.checks.argument).toBe('pass')
    expect(check.findingCounts.major).toBe(0)
    const record = f.records[0]!
    if (record.stage === 'extract') throw new Error('expected a claims review')
    expect(record.response!.targets[0]!.checks[0]!.result).toBe('fail')
    expect(record.response!.findings[0]!.id).toBe(f.findingId)
  })

  it('keeps the subset adjudication active through the report service', async () => {
    const f = await adjudicatedSubset()
    const service = new VwaArgumentService({ root: f.root })
    const { check } = await service.checkForDelivery(f.projectId, f.artifactId)
    expect(check.checks.argument).toBe('pass')
    expect(check.findingCounts.major).toBe(0)
  })

  it('does not apply an old adjudication after the project inputs change', async () => {
    const f = await adjudicatedSubset()
    const snapshot = structuredClone(f.snapshot)
    snapshot.claims[0]!.text = 'The closure date is unknown.'
    snapshot.claims[0]!.entityVersion++
    const check = evaluateDelivery({
      ...f, snapshot, pendingRunIds: [],
    })
    expect(check.checks.argument).not.toBe('pass')
  })
})
