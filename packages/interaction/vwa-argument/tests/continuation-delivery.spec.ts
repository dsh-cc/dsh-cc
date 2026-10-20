import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { evaluateDelivery } from '../src/delivery-check.ts'
import { allRecords } from '../src/review-continue.ts'
import { auditDependencyDigest, currentReviews } from '../src/review-current.ts'
import { runReviewWithTimers as executeReviewRun } from './review-timer-helpers.ts'
import type { ReviewStage } from '../src/review-plan.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { BUDGET, claimsResponse, fakeAdapter, makeClaim, makeSnapshot, NOW } from './review-helpers.ts'

describe('continuation audit delivery', () => {
  it('recognizes an audit after partial completion and cross-run reuse', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vwa-continue-delivery-'))
    const a = makeClaim('fact'), b = makeClaim('fact')
    const artifact = { id: `art_${randomUUID()}`, path: 'a.md', text: 'A fact.' }
    const snapshot = makeSnapshot({
      claims: [a, b],
      artifacts: [{
        id: artifact.id, path: artifact.path, entityVersion: 1,
        createdAt: NOW, updatedAt: NOW, contentHash: sha256Hex(artifact.text),
        outline: [], occurrences: [],
      }],
    })
    const base = {
      requestId: randomUUID(), runId: `run_${randomUUID()}`,
      stages: ['sources', 'support', 'claims', 'arguments', 'audit'] as ReviewStage[],
      targetClaimIds: [a.id, b.id], snapshot, artifact,
      signal: new AbortController().signal,
    }
    const first = await executeReviewRun({
      ...base,
      deps: {
        root, budget: BUDGET, contractHash: sha256Hex(stableJson(snapshot.contract)),
        adapter: fakeAdapter([(req) => {
          const target = JSON.parse(req.messages[1]!.content).targets[0].id
          if (target === b.id) throw new Error('transport failure')
          return { raw: claimsResponse(target, 'pass'), inputTokens: 5 }
        }]),
      },
    })
    expect(first.status).toBe('incomplete')
    const auditSteps: Parameters<typeof fakeAdapter>[0] = [
      () => ({ raw: JSON.stringify({ items: [] }), inputTokens: 5 }),
      (req) => ({ raw: JSON.stringify({
        stage: 'align', rubricVersion: 'humanities-v1', findings: [], alignment: [],
        targets: [{ targetId: artifact.id, checks: JSON.parse(req.messages[1]!.content).requiredRules
          .map((r: { ruleId: string }) => ({ ruleId: r.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [] })) }],
      }), inputTokens: 5 }),
    ]
    const adapter = fakeAdapter([
      () => ({ raw: claimsResponse(b.id, 'pass'), inputTokens: 5 }), ...auditSteps,
    ])
    const second = await executeReviewRun({
      ...base, runId: `run_${randomUUID()}`, requestId: randomUUID(), continueMode: true,
      deps: { root, adapter, budget: BUDGET, contractHash: sha256Hex(stableJson(snapshot.contract)) },
    })
    expect(second.status).toBe('completed')
    expect(adapter.state.dispatches).toBe(3)
    const history = allRecords(root, snapshot.projectId)
    const selected = currentReviews(snapshot, history, [a.id, b.id]).records
    const audit = second.records.find((r) => r.stage === 'extract')!
    expect.soft(audit.dependencyDigest).toBe(auditDependencyDigest(snapshot, artifact.id, selected))
    const report = evaluateDelivery({
      root, snapshot, artifactId: artifact.id, text: artifact.text, records: history,
      pendingRunIds: [], adjudications: [],
    })
    expect(report.checks.audit).toBe('pass')

    // An audit-only continuation over unchanged inputs reuses the completed
    // audit: its cache key hashes the current historical judgments (not an
    // empty list), so it matches and nothing is re-executed.
    const continueAdapter = fakeAdapter(auditSteps)
    const auditOnly = await executeReviewRun({
      ...base, stages: ['audit'], runId: `run_${randomUUID()}`, requestId: randomUUID(), continueMode: true,
      deps: { root, adapter: continueAdapter, budget: BUDGET, contractHash: sha256Hex(stableJson(snapshot.contract)) },
    })
    expect(continueAdapter.state.dispatches).toBe(0)
    expect(auditOnly.refusal).toMatchObject({ code: 'NOTHING_TO_CONTINUE' })
    // A fresh audit-only run (no continue) also digests the historical judgments.
    const fresh = await executeReviewRun({
      ...base, stages: ['audit'], runId: `run_${randomUUID()}`, requestId: randomUUID(),
      deps: { root, adapter: fakeAdapter(auditSteps), budget: BUDGET, contractHash: sha256Hex(stableJson(snapshot.contract)) },
    })
    expect(fresh.status).toBe('completed')
    const latestAudit = fresh.records.find((r) => r.stage === 'extract')!
    expect(latestAudit.dependencyDigest).toBe(auditDependencyDigest(snapshot, artifact.id, selected))
    expect(evaluateDelivery({
      root, snapshot, artifactId: artifact.id, text: artifact.text, records: allRecords(root, snapshot.projectId),
      pendingRunIds: [], adjudications: [],
    }).checks.audit).toBe('pass')
  })
})
