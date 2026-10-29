/**
 * Feature 4 §5.2 — explicit audit skip: the one shared predicate, admission
 * estimate zeroing, the mutually exclusive stage declaration, rebind expiry,
 * and the truthful report rendering that still succeeds.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { artifactBinding, auditSkipInEffect } from '../src/audit-skip.ts'
import { admissionRequestRecord, estimateReviewCalls, skipAuditRefusal } from '../src/feasibility.ts'
import { freezeReviewSettings } from '../src/review-config.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { VwaArgumentService } from '../src/report.ts'
import { ProjectStore } from '../src/store.ts'
import { initWorkspace } from './helpers.ts'
import { makeSnapshot } from './review-helpers.ts'
import type { ProjectSnapshot } from '../src/types.ts'

const workspace = () => mkdtempSync(join(tmpdir(), 'vwa-audit-skip-'))
const ARTIFACT = '# Title\n\n' + 'The policy shipped on 2026-10-16 with coverage at 90%.\n\n'.repeat(80)

function withArtifact(): { root: string; snapshot: ProjectSnapshot; artifactId: string; text: string } {
  const root = workspace()
  const artifactId = `art_${randomUUID()}`
  const artifact = {
    id: artifactId, entityVersion: 1, createdAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z',
    path: 'docs/a.md', contentHash: createHash('sha256').update(ARTIFACT, 'utf8').digest('hex'),
    occurrences: [], outline: [],
  } as ProjectSnapshot['artifacts'][number]
  const snapshot = makeSnapshot({ projectId: 'prj_skip', artifacts: [artifact] })
  return { root, snapshot, artifactId, text: ARTIFACT }
}

function admission(
  store: ReviewRunStore, snapshot: ProjectSnapshot, artifactId: string, runId: string,
  startedAt: string, extra: Record<string, unknown>,
): void {
  store.initRun(runId)
  store.writeRequest(runId, {
    schemaVersion: 1, requestId: runId, runId, stage: 'all', targetClaimIds: [], artifactId,
    status: 'completed', calls: 0, inputTokens: 0, outputTokens: 0, startedAt, ...extra,
  })
}

function auditRecord(runId: string, stage: 'extract' | 'align', artifactHash: string, startedAt: string, artifactId = 'art_default') {
  return {
    runId, stage, artifactHash, startedAt, endedAt: startedAt, status: 'completed',
    targetRefs: [{ id: artifactId, entityVersion: 1 }], dependencyDigest: 'a'.repeat(64),
    contractHash: 'b'.repeat(64), policyHash: 'c'.repeat(64), reviewerConfigHash: 'd'.repeat(64),
    promptHash: 'e'.repeat(64), inputHash: 'f'.repeat(64), inputTokens: 1, outputTokens: 1,
    response: stage === 'extract' ? { items: [] } : {
      stage: 'align', rubricVersion: 'humanities-v1', findings: [], alignment: [],
      targets: [{ targetId: artifactId, checks: ['AUDIT-01', 'AUDIT-02', 'AUDIT-03', 'AUDIT-04', 'AUDIT-05'].map((ruleId) => ({ ruleId, result: 'pass', rationale: 'checked', evidenceIds: [] })) }],
    },
  } as Parameters<ReviewRunStore['writeRecord']>[1]
}

describe('§5.2 explicit audit skip', () => {
  it('skipAudit + an explicit stage:audit is SCHEMA_INVALID; stage all is allowed', () => {
    expect(skipAuditRefusal('audit', { skipAudit: true })?.code).toBe('SCHEMA_INVALID')
    expect(skipAuditRefusal('all', { skipAudit: true })).toBeUndefined()
    expect(skipAuditRefusal('claims', { skipAudit: true })).toBeUndefined()
    expect(skipAuditRefusal('all', { skipAudit: 'yes' })?.code).toBe('SCHEMA_INVALID')
  })

  it('uses the proposed declaration for the audit estimate, defaulting a later admission to false', () => {
    const { root, snapshot, artifactId, text } = withArtifact()
    const store = new ReviewRunStore(root, snapshot.projectId)
    const base = {
      root, snapshot, stages: ['audit'] as const, targetClaimIds: [],
      artifact: { id: artifactId, text }, budget: freezeReviewSettings().budget,
      contractHash: 'c'.repeat(64), adapter: { configFingerprint: () => ({}) }, continueMode: false,
    }
    const full = estimateReviewCalls({ ...base, stages: ['audit'] })
    expect(full.plannedCalls.audit).toBeGreaterThan(0)
    expect(estimateReviewCalls({ ...base, stages: ['audit'], skipAudit: true }).plannedCalls.audit).toBe(0)
    const binding = artifactBinding(snapshot, { id: artifactId, text })
    admission(store, snapshot, artifactId, 'run_skip', '2026-10-28T00:00:00.000Z',
      { skipAudit: true, artifactHash: binding.artifactHash, entityVersion: 1 })
    // This prospective ordinary admission revokes the old declaration.
    expect(estimateReviewCalls({ ...base, stages: ['audit'] }).plannedCalls.audit).toBeGreaterThan(0)
  })

  it.each([undefined, false])('persists a default-false declaration for every bound admission (%s)', (skipAudit) => {
    const { root, snapshot, artifactId, text } = withArtifact()
    const record = admissionRequestRecord({
      root, snapshot, artifact: { id: artifactId, text }, stages: ['audit'],
      review: { adapter: { configFingerprint: () => ({}) }, budget: freezeReviewSettings().budget } as never,
      body: { skipAudit }, requestId: 'plain', runId: 'run_plain', taskId: 'task', payloadHash: 'payload',
    })
    expect(record).toMatchObject({ skipAudit: false, artifactHash: artifactBinding(snapshot, { id: artifactId, text }).artifactHash, entityVersion: 1 })
  })

  it.each([
    { target: 'other', version: 1, status: 'completed' },
    { target: 'same', version: 2, status: 'completed' },
    { target: 'same', version: 1, status: 'error' },
    { target: 'same', version: 1, status: 'completed' }, // malformed payloads
  ])('keeps skip for unrelated, stale, failed or invalid audit rows: %j', ({ target, version, status }) => {
    const { root, snapshot, artifactId, text } = withArtifact()
    const store = new ReviewRunStore(root, snapshot.projectId)
    const binding = artifactBinding(snapshot, { id: artifactId, text })
    admission(store, snapshot, artifactId, 'run_skip', '2026-10-28T00:00:00.000Z', { ...binding, skipAudit: true })
    admission(store, snapshot, target === 'same' ? artifactId : 'art_00000000-0000-4000-8000-000000000002', 'run_00000000-0000-4000-8000-000000000001', '2026-10-28T00:01:00.000Z', {})
    for (const stage of ['extract', 'align'] as const) store.writeRecord('run_00000000-0000-4000-8000-000000000001', {
      ...auditRecord('run_00000000-0000-4000-8000-000000000001', stage, binding.artifactHash, '2026-10-28T00:01:01.000Z', target === 'same' ? artifactId : 'art_00000000-0000-4000-8000-000000000002'),
      ...(target === 'same' && version === 1 && status === 'completed' ? { response: {} } : {}),
      targetRefs: [{ id: target === 'same' ? artifactId : 'art_00000000-0000-4000-8000-000000000002', entityVersion: version }], status,
    } as never)
    expect(auditSkipInEffect(root, snapshot.projectId, artifactId, binding.artifactHash, 1)).toEqual({ runId: 'run_skip' })
  })

  it('a later non-skip admission, a rebind, or a later complete audit flips the skip back', () => {
    {
      const { root, snapshot, artifactId, text } = withArtifact()
      const store = new ReviewRunStore(root, snapshot.projectId)
      const binding = artifactBinding(snapshot, { id: artifactId, text })
      admission(store, snapshot, artifactId, 'run_skip', '2026-10-28T00:00:00.000Z',
        { skipAudit: true, artifactHash: binding.artifactHash, entityVersion: 1 })
      expect(auditSkipInEffect(root, snapshot.projectId, artifactId, binding.artifactHash, 1)).toEqual({ runId: 'run_skip' })
      admission(store, snapshot, artifactId, 'run_plain', '2026-10-28T00:01:00.000Z',
        { artifactHash: binding.artifactHash, entityVersion: 1 })
      expect(auditSkipInEffect(root, snapshot.projectId, artifactId, binding.artifactHash, 1)).toBeUndefined()
    }
    {
      // Rebind: the old declaration is bound to entityVersion 1 and auto-expires.
      const { root, snapshot, artifactId, text } = withArtifact()
      const store = new ReviewRunStore(root, snapshot.projectId)
      const binding = artifactBinding(snapshot, { id: artifactId, text })
      admission(store, snapshot, artifactId, 'run_skip', '2026-10-28T00:00:00.000Z',
        { skipAudit: true, artifactHash: binding.artifactHash, entityVersion: 1 })
      expect(auditSkipInEffect(root, snapshot.projectId, artifactId, binding.artifactHash, 2)).toBeUndefined()
    }
    {
      // A complete audit (extract + align in one run) AFTER the declaration.
      const { root, snapshot, artifactId, text } = withArtifact()
      const store = new ReviewRunStore(root, snapshot.projectId)
      const binding = artifactBinding(snapshot, { id: artifactId, text })
      admission(store, snapshot, artifactId, 'run_skip', '2026-10-28T00:00:00.000Z',
        { skipAudit: true, artifactHash: binding.artifactHash, entityVersion: 1 })
      // The audit run predates the skip binding fields on its own request, so
      // only its COMPLETE records (extract + align in one run) can lift the skip.
      store.initRun('run_00000000-0000-4000-8000-000000000001')
      store.writeRequest('run_00000000-0000-4000-8000-000000000001', {
        schemaVersion: 1, requestId: 'run_00000000-0000-4000-8000-000000000001', runId: 'run_00000000-0000-4000-8000-000000000001', stage: 'audit', targetClaimIds: [],
        status: 'completed', calls: 1, inputTokens: 1, outputTokens: 1, startedAt: '2026-10-28T00:01:00.000Z',
      })
      store.writeRecord('run_00000000-0000-4000-8000-000000000001', auditRecord('run_00000000-0000-4000-8000-000000000001', 'extract', binding.artifactHash, '2026-10-28T00:01:01.000Z', artifactId))
      expect(auditSkipInEffect(root, snapshot.projectId, artifactId, binding.artifactHash, 1)).toEqual({ runId: 'run_skip' })
      store.writeRecord('run_00000000-0000-4000-8000-000000000001', auditRecord('run_00000000-0000-4000-8000-000000000001', 'align', binding.artifactHash, '2026-10-28T00:01:02.000Z', artifactId))
      expect(auditSkipInEffect(root, snapshot.projectId, artifactId, binding.artifactHash, 1)).toBeUndefined()
    }
  })

  it('a report with the skip in effect succeeds, renders SKIPPED, and is never reviewed-eligible', async () => {
    const made = initWorkspace()
    writeFileSync(join(made.root, 'docs/a.md'), ARTIFACT, 'utf8')
    const artifactId = `art_${randomUUID()}`
    const artifactHash = createHash('sha256').update(ARTIFACT, 'utf8').digest('hex')
    const store = new ProjectStore(made.root, made.projectId)
    const applied = store.withTransaction<void>({
      expectedRevision: 1,
      requestId: `bind-${randomUUID()}`,
      payloadHash: randomUUID(),
      applyFn: (snapshot) => {
        snapshot.artifacts.push({
          id: artifactId, entityVersion: 1, createdAt: '', updatedAt: '',
          path: 'docs/a.md', contentHash: artifactHash, occurrences: [], outline: [],
        })
        return { result: undefined }
      },
    })
    expect(applied.ok).toBe(true)
    const runStore = new ReviewRunStore(made.root, made.projectId)
    runStore.initRun('run_skip')
    runStore.writeRequest('run_skip', {
      schemaVersion: 1, requestId: 'run_skip', runId: 'run_skip', stage: 'all', targetClaimIds: [],
      artifactId, status: 'completed', calls: 1, inputTokens: 1, outputTokens: 1,
      skipAudit: true, artifactHash, entityVersion: 1, startedAt: '2026-10-28T00:00:00.000Z',
    })
    const service = new VwaArgumentService({ root: made.root })
    const handle = await service.checkForDelivery(made.projectId, artifactId)
    expect(handle.check.auditSkip).toEqual({ runId: 'run_skip' })
    expect(handle.check.eligibleForReviewed).toBe(false)
    const { text } = await service.renderReport(made.projectId, artifactId, handle.evaluationId, 'markdown')
    expect(text).toContain('audit: SKIPPED (declared at run_skip)')
    expect(text).toContain('not-run (skipped by request run_skip)')
  })
})
