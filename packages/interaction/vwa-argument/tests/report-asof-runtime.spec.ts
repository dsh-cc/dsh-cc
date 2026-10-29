/** As-of reports freeze every runtime input except the human adjudication ledger. */
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyAdjudicationOverlay, evaluationPath, loadEvaluation, persistEvaluation } from '../src/report-asof.ts'
import { appendAdjudication, VwaArgumentService, type FrozenEvaluation } from '../src/report.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { disagreementAdjudication, reviewedFixture, withDisagreement } from './review-helpers.ts'

async function freeze() {
  const f = await reviewedFixture()
  const service = new VwaArgumentService({ root: f.root })
  const handle = await service.checkForDelivery(f.projectId, f.artifactId)
  const frozen = loadEvaluation(f.root, f.projectId, handle.evaluationId)!
  return { f, service, frozen }
}

function admission(f: Awaited<ReturnType<typeof reviewedFixture>>, runId: string, skipAudit: boolean) {
  const store = new ReviewRunStore(f.root, f.projectId)
  store.initRun(runId)
  store.writeRequest(runId, {
    schemaVersion: 1, requestId: runId, runId, stage: 'claims', targetClaimIds: [f.claim.id],
    artifactId: f.artifactId, status: 'completed', calls: 0, inputTokens: 0, outputTokens: 0,
    startedAt: skipAudit ? '2098-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
    skipAudit, artifactHash: f.snapshot.artifacts[0]!.contentHash, entityVersion: 1,
  })
}

async function render(state: Awaited<ReturnType<typeof freeze>>) {
  return state.service.renderReportAsOf(state.f.projectId, state.f.artifactId, state.frozen.evaluationId, 'json')
}

describe('frozen runtime replay', () => {
  it('ignores an audit skip admitted after E and creates no evaluation', async () => {
    const state = await freeze()
    const { f, frozen } = state
    expect(frozen.check.eligibleForReviewed).toBe(true)
    const before = await render(state)
    const path = evaluationPath(f.root, f.projectId, frozen.evaluationId)
    const bytes = readFileSync(path, 'utf8')
    admission(f, 'run_later_skip', true)
    const after = await render(state)
    expect(after.text).toBe(before.text)
    expect(after.eligible).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    expect(readdirSync(join(f.root, '.dsh', 'vwa', f.projectId, 'evaluations'))).toEqual([`${frozen.evaluationId}.json`])
  })

  it('retains a frozen skip after a later non-skip admission revokes it', async () => {
    const f = await reviewedFixture()
    admission(f, 'run_skip', true)
    const service = new VwaArgumentService({ root: f.root })
    const handle = await service.checkForDelivery(f.projectId, f.artifactId)
    expect(handle.check.auditSkip).toEqual({ runId: 'run_skip' })
    const before = await service.renderReportAsOf(f.projectId, f.artifactId, handle.evaluationId, 'json')
    admission(f, 'run_unskip', false)
    const after = await service.renderReportAsOf(f.projectId, f.artifactId, handle.evaluationId, 'json')
    expect(after.text).toBe(before.text)
    expect(after.eligible).toBe(false)
    expect(JSON.parse(after.text).auditSkip).toEqual({ runId: 'run_skip' })
  })

  it.each(['deleted', 'corrupt'])('keeps findings and identity frozen when source bytes are %s', async (mutation) => {
    const state = await freeze()
    const before = await render(state)
    const sourcePath = join(state.f.root, state.f.snapshot.sources[0]!.snapshotPath)
    if (mutation === 'deleted') rmSync(sourcePath)
    else writeFileSync(sourcePath, 'corrupt source bytes')
    const after = await render(state)
    expect(after.text).toBe(before.text)
    expect(after.eligible).toBe(true)
    expect(applyAdjudicationOverlay(state.f.root, state.frozen, []).dependencyDigest).toBe(state.frozen.check.dependencyDigest)
  })

  it('retains a frozen source failure after source bytes are repaired', async () => {
    const f = await reviewedFixture()
    const sourcePath = join(f.root, f.snapshot.sources[0]!.snapshotPath)
    const bytes = readFileSync(sourcePath, 'utf8')
    writeFileSync(sourcePath, 'corrupt at freeze')
    const service = new VwaArgumentService({ root: f.root })
    const handle = await service.checkForDelivery(f.projectId, f.artifactId)
    expect(handle.check.findings.some((finding) => finding.code === 'EVID-01')).toBe(true)
    const before = await service.renderReportAsOf(f.projectId, f.artifactId, handle.evaluationId, 'json')
    writeFileSync(sourcePath, bytes)
    const after = await service.renderReportAsOf(f.projectId, f.artifactId, handle.evaluationId, 'json')
    expect(after.text).toBe(before.text)
    expect(after.eligible).toBe(false)
  })

  it('ignores HEAD, rebindings and audit ledger removal while hashing current artifact bytes', async () => {
    const state = await freeze()
    const { f, frozen } = state
    const changed = `${f.body}\nRewritten after E.\n`
    writeFileSync(join(f.root, 'report.md'), changed)
    const updated = f.store.withTransaction({
      expectedRevision: f.snapshot.revision, requestId: randomUUID(), payloadHash: 'rebind',
      applyFn(snapshot) {
        snapshot.artifacts[0]!.entityVersion += 1
        snapshot.artifacts[0]!.path = 'another.md'
        snapshot.contract.reviewSettings = { ...snapshot.contract.reviewSettings, disagreementPolicy: 'deferred' } as never
        return { result: {} }
      },
    })
    expect(updated.ok).toBe(true)
    rmSync(join(f.root, '.dsh', 'vwa', f.projectId, 'review-runs'), { recursive: true })
    const rendered = await render(state)
    expect(rendered.eligible).toBe(true)
    expect(rendered.revision).toBe(frozen.snapshot.revision)
    expect(rendered.asOf.diverged).toBe(true)
    expect(rendered.asOf.reviewedArtifactHash).toBe(frozen.check.artifactHash)
    expect(JSON.parse(rendered.text).checks).toEqual(frozen.check.checks)
  })

  it.each(['accept', 'reject'] as const)('still applies live %s adjudications after source deletion and new skips', async (decision) => {
    const f = await reviewedFixture()
    const d = withDisagreement(f, f.records)
    rmSync(join(f.root, '.dsh', 'vwa', f.projectId, 'review-runs'), { recursive: true })
    const store = new ReviewRunStore(f.root, f.projectId)
    for (const record of d.records) store.writeRecord(record.runId, record)
    const service = new VwaArgumentService({ root: f.root })
    const handle = await service.checkForDelivery(f.projectId, f.artifactId)
    expect(handle.check.checks.argument).toBe('needs-review')
    rmSync(join(f.root, f.snapshot.sources[0]!.snapshotPath))
    admission(f, 'run_post_freeze_skip', true)
    appendAdjudication(f.root, f.projectId, disagreementAdjudication(f, d.records, d.findingId, decision,
      decision === 'reject' ? d.passRunId : d.failRunId,
      decision === 'reject' ? d.failRunId : d.passRunId))
    const rendered = await service.renderReportAsOf(f.projectId, f.artifactId, handle.evaluationId, 'json')
    const report = JSON.parse(rendered.text)
    expect(report.checks.mechanical).toBe('pass')
    expect(report.checks.argument).toBe(decision === 'reject' ? 'pass' : 'fail')
    expect(report.auditSkip).toBeUndefined()
    expect(rendered.eligible).toBe(decision === 'reject')
  })

  it('keeps legacy frozen results when replay records are absent', async () => {
    const state = await freeze()
    const legacy = structuredClone(state.frozen) as Partial<FrozenEvaluation>
    delete legacy.records
    delete (legacy as Record<string, unknown>).runtime
    persistEvaluation(state.f.root, state.f.projectId, legacy as FrozenEvaluation)
    const rendered = await render(state)
    expect(rendered.eligible).toBe(true)
    const report = JSON.parse(rendered.text)
    expect(report.checks).toEqual(state.frozen.check.checks)
    expect(report.metrics).toEqual(state.frozen.check.metrics)
    expect(report.reviewRunIds).toEqual(state.frozen.check.reviewRunIds)
  })
  it('does not filter frozen reviews using unrelated historical reviewer configurations', async () => {
    const f = await reviewedFixture()
    const store = new ReviewRunStore(f.root, f.projectId)
    const stale = { ...structuredClone(f.records[0]!), runId: 'run_stale', reviewerConfigHash: 'a'.repeat(64) }
    store.writeRecord(stale.runId, stale)
    const service = new VwaArgumentService({ root: f.root })
    const frozen = await service.checkForDelivery(f.projectId, f.artifactId)
    expect(frozen.check.eligibleForReviewed).toBe(true)
    const rendered = await service.renderReportAsOf(f.projectId, f.artifactId, frozen.evaluationId, 'json')
    expect(rendered.eligible).toBe(true)
  })

})
