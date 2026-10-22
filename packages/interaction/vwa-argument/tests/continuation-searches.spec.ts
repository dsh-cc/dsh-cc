/** Search logs are model-visible audit inputs, even outside semantic task dependencies. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { semanticContractHash } from '../src/review-contract.ts'
import { describe, expect, it } from 'vitest'
import { evaluateDelivery } from '../src/delivery-check.ts'
import { allRecords, continuePreCheck } from '../src/review-continue.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import type { ReviewStage } from '../src/review-plan.ts'
import type { SearchLog } from '../src/types.ts'
import { BUDGET, claimsResponse, fakeAdapter, makeClaim, makeSnapshot, NOW } from './review-helpers.ts'

const search = (): SearchLog => ({
  id: `search_${randomUUID()}`, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
  purpose: 'Look for missing evidence', targetIds: [], corpus: [], query: 'counterevidence',
  tool: 'web', performedAt: NOW, state: 'executed', resultSourceIds: [],
  inaccessible: [], finding: 'none-found',
})

describe('audit continuation search identity', () => {
  const cases = (['add', 'edit', 'delete'] as const).flatMap((change) =>
    (['audit', 'all'] as const).map((stage) => ({ change, stage })))
  it.each(cases)('invalidates audit reuse and delivery after a search $change (stage $stage)', async ({ change, stage }) => {
    const root = mkdtempSync(join(tmpdir(), 'vwa-search-identity-'))
    const claim = makeClaim()
    const artifact = { id: `art_${randomUUID()}`, path: 'report.md', text: 'A fact.' }
    const snapshot = makeSnapshot({
      claims: [claim], searches: change === 'add' ? [] : [search()],
      artifacts: [{ id: artifact.id, path: artifact.path, entityVersion: 1,
        createdAt: NOW, updatedAt: NOW, contentHash: sha256Hex(artifact.text), outline: [], occurrences: [] }],
    })
    const observedSearches: SearchLog[][] = []
    const adapter = fakeAdapter([(req) => {
      const envelope = JSON.parse(req.messages[1]!.content)
      if (envelope.stage === 'claims') return { raw: claimsResponse(claim.id, 'pass'), inputTokens: 5 }
      if (envelope.stage === 'extract') return { raw: JSON.stringify({ items: [] }), inputTokens: 5 }
      observedSearches.push(envelope.searches)
      return { raw: JSON.stringify({
        stage: 'align', rubricVersion: 'humanities-v1', findings: [], alignment: [],
        targets: [{ targetId: artifact.id, checks: envelope.requiredRules.map((r: { ruleId: string }) => ({
          ruleId: r.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [],
        })) }],
      }), inputTokens: 5 }
    }])
    const deps = { root, adapter, budget: BUDGET, contractHash: semanticContractHash(snapshot.contract) }
    const base = { deps, snapshot, artifact, targetClaimIds: [claim.id], signal: new AbortController().signal }
    const run = (stages: ReviewStage[], continueMode = false) => executeReviewRun({
      ...base, runId: `run_${randomUUID()}`, requestId: randomUUID(), stages, continueMode,
    })
    const report = () => evaluateDelivery({ root, snapshot, artifactId: artifact.id, text: artifact.text,
      records: allRecords(root, snapshot.projectId), pendingRunIds: [], adjudications: [] })
    const check = (stages: ReviewStage[]) => continuePreCheck({
      ...base, root, adapter, contractHash: deps.contractHash, stages,
    })
    expect((await run(['claims', 'audit'])).status).toBe('completed')
    expect(report().checks.audit).toBe('pass')
    expect(check(['audit'])).toMatchObject({ code: 'NOTHING_TO_CONTINUE' })

    // No semantic task depends on this project-wide search: the audit must
    // invalidate directly, rather than rely on upstream review invalidation.
    if (change === 'add') snapshot.searches.push(search())
    else if (change === 'edit') snapshot.searches[0] = {
      ...snapshot.searches[0]!, entityVersion: 2, finding: 'inconclusive', inaccessible: ['archive'],
    }
    else snapshot.searches = []
    snapshot.revision++
    expect.soft(report().checks.audit).toBe('not-run')
    expect.soft(check(['audit'])).toBeUndefined()
    expect.soft(check(['sources', 'support', 'claims', 'arguments', 'audit'])).toBeUndefined()
    const continued = await run(stage === 'audit' ? ['audit'] : ['sources', 'support', 'claims', 'arguments', 'audit'], true)
    expect(continued.refusal).toBeUndefined()
    expect(continued.status).toBe('completed')
    expect(continued.calls).toBe(2) // Semantic tasks never re-dispatch; only extract + align do.
    expect(observedSearches).toHaveLength(2)
    expect(observedSearches[1]).toEqual(snapshot.searches)
    expect(report().checks.audit).toBe('pass')
    expect(check(['audit'])).toMatchObject({ code: 'NOTHING_TO_CONTINUE' })
  })
})
