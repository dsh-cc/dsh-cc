/**
 * Fix 5 §4.4 + §4.6: the Issue-8 end-to-end pin and the migration pins, both
 * driven through the REAL `createReviewAdapter` (the fake adapter's constant
 * fingerprint without `effectiveConfig` makes such pins vacuous).
 *
 * - §4.4: complete the semantic stages at a 12k per-call cap, revise it to
 *   16k, and require the continue estimate to plan ZERO calls; revise back to
 *   12k and require the same. A simulated PRE-Fix-5 fingerprint (budget key
 *   re-added) is shown to plan non-zero calls, so the pin is sensitive.
 * - §4.6: an audit recorded under one cap stays reusable after the cap
 *   changes (`findReusableAudit` / `hasReusableAudit` and a real continue
 *   run), and a receipt carrying the pre-change `reviewerConfigHash` is
 *   REFUSED by `vwaSign` (commands.ts:367-373).
 * @module tests/review-identity-real
 */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildReceiptV2, receiptHashOf } from '@dsh-cc/vwa-evidence'
import { auditInputHash, findReusableAudit } from '../src/audit-reuse.ts'
import { vwaSign, type VwaArgumentService } from '../src/commands.ts'
import { evaluateDelivery } from '../src/delivery-check.ts'
import { budgetFeasibilityRefusal, estimateReviewCalls } from '../src/feasibility.ts'
import { applyMutation, GraphContext } from '../src/graph.ts'
import { allRecords } from '../src/review-continue.ts'
import { semanticContractHash } from '../src/review-contract.ts'
import { afterRevisionCommit } from '../src/review-settings-revision.ts'
import { executeReviewRun } from '../src/review-runner.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import type { ReviewModelAdapter } from '../src/review-adapter.ts'
import type { FrozenReviewSettings } from '../src/review-config.ts'
import type { ProjectSnapshot, ReviewRecord } from '../src/types.ts'
import {
  BUDGET, makeClaim, makeSnapshot, makeSource, realAdapter,
} from './review-helpers.ts'

const NOW = '2026-10-21T00:00:00.000Z'
// The stages the fixture completes. `audit` is excluded from the estimate on
// purpose: audit calls are always counted in full (not incremental), so only
// semantic stages can plan zero.
const COMPLETED_STAGES = ['claims'] as const

function settings(cap: number): FrozenReviewSettings {
  return {
    budget: { ...BUDGET, maxCallsPerRun: 10, maxOutputTokensPerRun: 100_000, maxOutputTokensPerCall: cap },
    maxArtifactChars: 120_000,
    maxContextChars: 48_000,
    claimsBatchSize: 1,
  }
}

/** Revise `budget.maxOutputTokensPerCall` through the real revision op + post-commit hook. */
function reviseCap(root: string, snapshot: ProjectSnapshot, cap: number): ProjectSnapshot {
  const graph = new GraphContext(structuredClone(snapshot), 10_000)
  const outcome = applyMutation(graph, {
    op: 'set-review-settings', reviewSettings: { budget: { maxOutputTokensPerCall: cap } },
  } as never)
  expect(outcome.contractChanged).toBe(false)
  afterRevisionCommit(root, snapshot.projectId, 'set-review-settings', { ok: true, data: outcome })
  return graph.snapshot
}

/**
 * The pre-Fix-5 fingerprint: post-fix output with the budget key re-added —
 * exactly what `configFingerprint` returned before F5.1 stripped `maxTokens`.
 */
function preFixFingerprint(adapter: ReviewModelAdapter, cap: number): Record<string, unknown> {
  const fp = adapter.configFingerprint()
  const effectiveConfig = (fp.effectiveConfig ?? {}) as Record<string, unknown>
  return { ...fp, effectiveConfig: { ...effectiveConfig, maxTokens: cap } }
}

function fingerprintHash(adapter: ReviewModelAdapter): string {
  return sha256Hex(stableJson(adapter.configFingerprint()))
}

/** Scripted responses for a claims + audit run over one bound artifact. */
function reviewScript(artifactId: string) {
  return [
    (req: { messages: { role: string; content: string }[] }) => {
      const envelope = JSON.parse(req.messages[1]!.content) as {
        stage: 'claims' | 'extract' | 'align'
        targets?: { id: string }[]
        requiredRules?: { targetId: string; ruleId: string }[]
      }
      if (envelope.stage === 'extract') return { raw: JSON.stringify({ items: [] }), inputTokens: 5 }
      if (envelope.stage === 'align') {
        return {
          raw: JSON.stringify({
            stage: 'align', rubricVersion: 'humanities-v1', findings: [], alignment: [],
            targets: [{ targetId: artifactId, checks: envelope.requiredRules!.map((rule) => ({
              ruleId: rule.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [],
            })) }],
          }),
          inputTokens: 5,
        }
      }
      return {
        raw: JSON.stringify({
          stage: 'claims', rubricVersion: 'humanities-v1', findings: [],
          targets: envelope.targets!.map((target) => ({
            targetId: target.id,
            checks: [{ ruleId: 'HIST-01', result: 'pass', rationale: 'r', evidenceIds: [] }],
            searchSufficiency: 'checked',
          })),
        }),
        inputTokens: 5,
      }
    },
  ]
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vwa-identity-real-'))
  const source = makeSource()
  const claim = makeClaim()
  claim.scope.corpus = [source.id]
  const artifact = { id: `art_${randomUUID()}`, path: 'a.md', text: 'The minutes record only the vote. ' }
  const snapshot = makeSnapshot({
    sources: [source],
    claims: [claim],
    artifacts: [{
      id: artifact.id, path: artifact.path, entityVersion: 1,
      createdAt: NOW, updatedAt: NOW, contentHash: sha256Hex(artifact.text),
      outline: [], occurrences: [],
    }],
    contract: { ...makeSnapshot().contract, reviewSettings: settings(12_000) },
  })
  writeFileSync(join(root, artifact.path), artifact.text)
  return { root, source, claim, artifact, snapshot }
}

function run(input: {
  root: string
  snapshot: ProjectSnapshot
  artifact: { id: string; text: string }
  claimId: string
  adapter: ReturnType<typeof realAdapter>
  stages: ('claims' | 'audit')[]
  continueMode?: boolean
}) {
  return executeReviewRun({
    deps: {
      root: input.root, adapter: input.adapter, budget: input.snapshot.contract.reviewSettings!.budget,
      contractHash: semanticContractHash(input.snapshot.contract),
    },
    runId: `run_${randomUUID()}`,
    requestId: randomUUID(),
    stages: input.stages,
    targetClaimIds: [input.claimId],
    snapshot: input.snapshot,
    artifact: input.artifact,
    signal: new AbortController().signal,
    ...(input.continueMode ? { continueMode: true } : {}),
  })
}

describe('§4.4 — Issue-8 repro pin through the real adapter', () => {
  it('a budget revision 12k→16k→12k plans zero continue calls for completed stages', async () => {
    const f = fixture()
    const first = await run({
      ...f, claimId: f.claim.id, stages: ['claims', 'audit'], adapter: realAdapter(reviewScript(f.artifact.id)),
    })
    expect(first.status).toBe('completed')
    expect(first.records.map((record) => record.stage).sort()).toEqual(['align', 'claims', 'extract'])

    /** Continue-mode estimate for the completed semantic stages at one cap. */
    const estimateAt = async (snapshot: ProjectSnapshot, cap: number) => {
      const adapter = realAdapter(reviewScript(f.artifact.id))
      await adapter.initialize(cap, new AbortController().signal)
      const input = {
        root: f.root, snapshot, adapter, contractHash: semanticContractHash(snapshot.contract),
        stages: [...COMPLETED_STAGES], targetClaimIds: [f.claim.id], artifact: f.artifact,
        budget: snapshot.contract.reviewSettings!.budget, continueMode: true,
      }
      return {
        adapter,
        plannedCalls: estimateReviewCalls(input).plannedCalls,
        refusal: budgetFeasibilityRefusal(input),
      }
    }

    const revised = reviseCap(f.root, f.snapshot, 16_000)
    const at16 = await estimateAt(revised, 16_000)
    expect(at16.plannedCalls).toEqual({ sources: 0, support: 0, claims: 0, arguments: 0, audit: 0 })
    expect(at16.refusal).toBeUndefined()
    // The completed records carry the SAME reviewer identity under the new cap.
    const completed = allRecords(f.root, f.snapshot.projectId).filter((record) => record.status === 'completed')
    expect(new Set(completed.map((record) => record.reviewerConfigHash)))
      .toEqual(new Set([fingerprintHash(at16.adapter)]))

    // Red demonstration without touching src: the PRE-Fix-5 fingerprint
    // (budget key re-added) yields different keys, so the pin would fail.
    const preFix = { ...at16.adapter, configFingerprint: () => preFixFingerprint(at16.adapter, 16_000) }
    expect(fingerprintHash(preFix)).not.toBe(fingerprintHash(at16.adapter))
    expect(estimateReviewCalls({
      root: f.root, snapshot: revised, adapter: preFix, contractHash: semanticContractHash(revised.contract),
      stages: [...COMPLETED_STAGES], targetClaimIds: [f.claim.id], artifact: f.artifact,
      budget: revised.contract.reviewSettings!.budget, continueMode: true,
    }).plannedCalls.claims).toBe(1)

    const back = reviseCap(f.root, revised, 12_000)
    const at12 = await estimateAt(back, 12_000)
    expect(at12.plannedCalls).toEqual({ sources: 0, support: 0, claims: 0, arguments: 0, audit: 0 })
    expect(at12.refusal).toBeUndefined()
  })
})

describe('§4.6 — migration pins: audit reuse and receipt refusal', () => {
  it('an audit completed under one cap stays reusable after the cap changes', async () => {
    const f = fixture()
    const first = await run({
      ...f, claimId: f.claim.id, stages: ['claims', 'audit'], adapter: realAdapter(reviewScript(f.artifact.id)),
    })
    expect(first.status).toBe('completed')
    const extract = first.records.find((record) => record.stage === 'extract')!
    const align = first.records.find((record) => record.stage === 'align')!

    const revised = reviseCap(f.root, f.snapshot, 16_000)
    const outside = realAdapter(reviewScript(f.artifact.id))
    await outside.initialize(16_000, new AbortController().signal)
    // Post-fix identity: identical fingerprint, so the audit key is unchanged.
    expect(align.reviewerConfigHash).toBe(fingerprintHash(outside))

    const history = allRecords(f.root, f.snapshot.projectId)
    const key = auditInputHash({
      snapshot: revised, artifact: f.artifact, records: history,
      coreClaimIds: align.coreClaimIds!, contractHash: semanticContractHash(revised.contract),
      reviewerConfigHash: fingerprintHash(outside), unitChars: 24_000,
    })
    expect(findReusableAudit(history, key)?.align.runId).toBe(align.runId)
    // Pre-Fix-5 identity would miss: the budget-carrying key finds nothing.
    const preFixKey = auditInputHash({
      snapshot: revised, artifact: f.artifact, records: history,
      coreClaimIds: align.coreClaimIds!, contractHash: semanticContractHash(revised.contract),
      reviewerConfigHash: sha256Hex(stableJson(preFixFingerprint(outside, 16_000))), unitChars: 24_000,
    })
    expect(findReusableAudit(history, preFixKey)).toBeUndefined()

    // The runner agrees: an audit-only continuation has NOTHING_TO_CONTINUE and
    // dispatches zero calls (pre-fix it would re-execute extract + align).
    const continueAdapter = realAdapter(reviewScript(f.artifact.id))
    const continued = await run({
      ...f, snapshot: revised, claimId: f.claim.id, stages: ['audit'],
      adapter: continueAdapter, continueMode: true,
    })
    expect(continueAdapter.state.dispatches).toBe(0)
    expect(continued.refusal).toMatchObject({ code: 'NOTHING_TO_CONTINUE' })
  })

  it('refuses a receipt whose reviewerConfigHash predates the identity change', async () => {
    const f = fixture()
    const adapter = realAdapter(reviewScript(f.artifact.id))
    await adapter.initialize(12_000, new AbortController().signal)
    const postFixHash = fingerprintHash(adapter)
    const preFixHash = sha256Hex(stableJson(preFixFingerprint(adapter, 12_000)))
    expect(preFixHash).not.toBe(postFixHash)

    const records: ReviewRecord[] = []
    const checkAt = (reviewerConfigHash: string) => evaluateDelivery({
      root: f.root, snapshot: f.snapshot, artifactId: f.artifact.id, text: f.artifact.text,
      records, pendingRunIds: [], adjudications: [], reviewerConfigHash,
    })
    const receipt = buildReceiptV2({
      sessionId: 'session', ts: 1, receiptId: `rec_${randomUUID()}`,
      projectId: f.snapshot.projectId, artifactPath: join(f.root, f.artifact.path),
      events: [], workspaceRoot: f.root, parentHash: '',
      report: { path: 'review.md', hash: 'c'.repeat(64) },
      check: checkAt(preFixHash), neverRun: false,
    })
    const service = {
      async checkForDelivery() {
        return { evaluationId: `eval_${randomUUID()}`, bindingDigest: 'b'.repeat(64), check: checkAt(postFixHash) }
      },
    } as unknown as VwaArgumentService

    const refused = await vwaSign(
      f.root, f.snapshot.projectId, f.artifact.id, receiptHashOf(receipt), receipt, service,
    )
    expect(refused).toEqual({
      kind: 'error', text: 'Receipt inputs are no longer current; generate a new receipt before signing.',
    })
    // The refusal is the hash gate, not some later failure: a receipt carrying
    // the current hash passes the inputs gate and only then misses its report.
    const current = { ...receipt, reviewerConfigHash: postFixHash }
    expect(await vwaSign(
      f.root, f.snapshot.projectId, f.artifact.id, receiptHashOf(current), current, service,
    )).toEqual({ kind: 'error', text: 'The receipt report is missing or changed.' })
  })
})
