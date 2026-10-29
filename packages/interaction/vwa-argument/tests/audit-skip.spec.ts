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
import { estimateReviewCalls, skipAuditRefusal } from '../src/feasibility.ts'
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

function auditRecord(runId: string, stage: 'extract' | 'align', artifactHash: string, startedAt: string) {
  return { runId, stage, artifactHash, startedAt, status: 'completed' } as unknown as Parameters<ReviewRunStore['writeRecord']>[1]
}

describe('§5.2 explicit audit skip', () => {
  it('skipAudit + an explicit stage:audit is SCHEMA_INVALID; stage all is allowed', () => {
    expect(skipAuditRefusal('audit', { skipAudit: true })?.code).toBe('SCHEMA_INVALID')
    expect(skipAuditRefusal('all', { skipAudit: true })).toBeUndefined()
    expect(skipAuditRefusal('claims', { skipAudit: true })).toBeUndefined()
    expect(skipAuditRefusal('all', { skipAudit: 'yes' })?.code).toBe('SCHEMA_INVALID')
  })

  it('zeroes the audit estimate for an explicit declaration and for an in-effect one', () => {
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
    // The predicate is authoritative: no explicit flag needed on a later continue.
    expect(estimateReviewCalls({ ...base, stages: ['audit'] }).plannedCalls.audit).toBe(0)
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
      store.initRun('run_audit')
      store.writeRequest('run_audit', {
        schemaVersion: 1, requestId: 'run_audit', runId: 'run_audit', stage: 'audit', targetClaimIds: [],
        status: 'completed', calls: 1, inputTokens: 1, outputTokens: 1, startedAt: '2026-10-28T00:01:00.000Z',
      })
      store.writeRecord('run_audit', auditRecord('run_audit', 'extract', binding.artifactHash, '2026-10-28T00:01:01.000Z'))
      expect(auditSkipInEffect(root, snapshot.projectId, artifactId, binding.artifactHash, 1)).toEqual({ runId: 'run_skip' })
      store.writeRecord('run_audit', auditRecord('run_audit', 'align', binding.artifactHash, '2026-10-28T00:01:02.000Z'))
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
