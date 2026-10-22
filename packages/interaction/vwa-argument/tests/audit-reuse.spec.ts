/**
 * F1.2 runner-side audit reuse in continue mode: a completed extract/align
 * pair whose full audit input hash (post-semantic-stage judgment set, frozen
 * core, contract, reviewer config, unit size) is unchanged is re-recorded
 * under the new runId with zero-token usage rows instead of being
 * re-dispatched. Default (non-continue) mode never reuses — a fresh request
 * is a second opinion by contract. The reused outcome is derived by the same
 * `auditOutcomeFromRecords` the executed path uses, so needs-review new-core
 * survives reuse.
 * @module tests/audit-reuse
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { semanticContractHash } from '../src/review-contract.ts'
import { describe, expect, it } from 'vitest'
import { executeReviewRun } from '../src/review-runner.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { findReusableAudit, hasReusableAudit, auditInputHash } from '../src/audit-reuse.ts'
import { allRecords, continuePreCheck } from '../src/review-continue.ts'
import { sha256Hex, stableJson } from '../src/schema.ts'
import { BUDGET, fakeAdapter, makeClaim, makeSnapshot, makeSource, NOW } from './review-helpers.ts'
import type { AlignEnvelope, ExtractEnvelope } from '../src/audit.ts'
import type { ExtractedItem, Finding, ReviewRecord } from '../src/types.ts'

const ARTIFACT_TEXT = 'The minutes record only the vote on the proposal. '

function world() {
  const root = mkdtempSync(join(tmpdir(), 'vwa-audit-reuse-'))
  const source = makeSource()
  const claim = makeClaim()
  claim.scope.corpus = [source.id]
  const artifact = { id: `art_${randomUUID()}`, path: 'a.md', text: ARTIFACT_TEXT }
  const snapshot = makeSnapshot({
    sources: [source],
    claims: [claim],
    artifacts: [{
      id: artifact.id, path: artifact.path, entityVersion: 1,
      createdAt: NOW2(), updatedAt: NOW2(), contentHash: sha256Hex(artifact.text),
      outline: [], occurrences: [],
    }],
  })
  return {
    root, claim, artifact, snapshot,
    contractHash: semanticContractHash(snapshot.contract),
  }
}

function NOW2(): string {
  return '2026-10-21T00:00:00.000Z'
}

/** One extracted item over the artifact text (stripped coordinates = original here). */
function item(text: string, importance: 'core' | 'supporting' = 'core'): ExtractedItem {
  const start = ARTIFACT_TEXT.indexOf(text)
  if (start < 0) throw new Error(`fixture text not in artifact: ${text}`)
  return {
    span: { start, end: start + text.length },
    exactText: text,
    atomicClaims: [{
      text: `atomic:${text}`,
      kind: 'fact',
      scope: { subject: 's', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
      importance,
    }],
    isQuotation: false,
  }
}

type AlignChoice = { relation: 'exact'; claimId: string } | { relation: 'new' }

/** Fake adapter answering claims/extract/align/sources; the align reply is parameterized. */
function auditWorldAdapter(artifactId: string, items: ExtractedItem[], align: AlignChoice) {
  return fakeAdapter([
    (req) => {
      const envelope = JSON.parse(req.messages[1]!.content) as
        | (AlignEnvelope & { requiredRules: { targetId: string; ruleId: string }[] })
        | (ExtractEnvelope & Record<string, never>)
        | { stage: 'claims' | 'sources'; targets: { id: string }[]; requiredRules: { targetId: string; ruleId: string }[] }
      if (envelope.stage === 'extract') return { raw: JSON.stringify({ items }), inputTokens: 5, outputTokens: 7 }
      if (envelope.stage === 'align') {
        const alignEnvelope = envelope as AlignEnvelope & { requiredRules: { targetId: string; ruleId: string }[] }
        return {
          raw: JSON.stringify({
            stage: 'align', rubricVersion: 'humanities-v1', findings: [],
            alignment: alignEnvelope.items.map((i) => ({
              extractedId: i.extractedId,
              claimIds: align.relation === 'exact' ? [align.claimId] : [],
              relation: align.relation,
              rationale: 'r',
            })),
            targets: [...new Set(alignEnvelope.requiredRules.map((r) => r.targetId))].map((targetId) => ({
              targetId,
              checks: alignEnvelope.requiredRules
                .filter((r) => r.targetId === targetId)
                .map((r) => ({ ruleId: r.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [] })),
            })),
          }),
          inputTokens: 6, outputTokens: 8,
        }
      }
      const generic = envelope as { stage: 'claims' | 'sources'; targets: { id: string }[]; requiredRules: { targetId: string; ruleId: string }[] }
      return {
        raw: JSON.stringify({
          stage: generic.stage, rubricVersion: 'humanities-v1', findings: [],
          targets: generic.targets.map((target) => ({
            targetId: target.id,
            checks: generic.requiredRules.filter((r) => r.targetId === target.id)
              .map((r) => ({ ruleId: r.ruleId, result: 'pass', rationale: 'reviewed', evidenceIds: [] })),
            // Claims targets carry search sufficiency (§11.2 schema).
            ...(generic.stage === 'claims' ? { searchSufficiency: 'checked' } : {}),
          })),
        }),
        inputTokens: 5, outputTokens: 5,
      }
    },
  ])
}

const baseDeps = (root: string, adapter: ReturnType<typeof fakeAdapter>, contractHash: string) => ({
  root, adapter, budget: BUDGET, contractHash,
})

function run(input: {
  root: string
  adapter: ReturnType<typeof fakeAdapter>
  contractHash: string
  snapshot: ReturnType<typeof world>['snapshot']
  artifact: ReturnType<typeof world>['artifact']
  claim?: { id: string }
  claimId?: string
  stages: ('claims' | 'audit' | 'sources')[]
  continueMode?: boolean
}) {
  return executeReviewRun({
    deps: baseDeps(input.root, input.adapter, input.contractHash),
    runId: `run_${randomUUID()}`,
    requestId: `req_${randomUUID()}`,
    stages: input.stages,
    targetClaimIds: [input.claim?.id ?? input.claimId],
    snapshot: input.snapshot,
    artifact: input.artifact,
    signal: new AbortController().signal,
    ...(input.continueMode ? { continueMode: true } : {}),
  })
}

/** Findings without runtime-owned ids (ids differ between executions by design). */
function findingsWithoutIds(findings: Finding[]): Omit<Finding, 'id'>[] {
  return findings.map(({ id: _id, ...rest }) => rest)
}

describe('F1.2 — runner-side audit reuse in continue mode', () => {
  it('re-executes a legacy audit with model-owned AUDIT_NEW_CLAIM findings instead of shifting proposal spans', async () => {
    const w = world()
    // Extraction coordinates exclude claim markers; proposals must use the
    // original artifact coordinates, including this marker's width.
    const marker = `〔claim:${w.claim.id}〕`
    w.artifact.text = marker + ARTIFACT_TEXT
    w.snapshot.artifacts[0]!.contentHash = sha256Hex(w.artifact.text)
    const items = [item('minutes', 'supporting'), item('vote', 'supporting')]
    const first = await run({
      ...w, stages: ['claims', 'audit'],
      adapter: auditWorldAdapter(w.artifact.id, items, { relation: 'new' }),
    })
    expect(first.status).toBe('completed')
    const extract = first.records.find((r) => r.stage === 'extract')!
    const align = first.records.find((r) => r.stage === 'align')!
    // Freeze the PRE-VERSION key format independently of auditInputHash:
    // both records from an old installation used precisely this identity.
    const legacyHash = sha256Hex(stableJson({
      stage: 'audit', artifactHash: align.artifactHash,
      dependencyDigest: align.dependencyDigest, coreClaimIds: [...align.coreClaimIds!].sort(),
      contractHash: align.contractHash, policyHash: align.policyHash,
      reviewerConfigHash: align.reviewerConfigHash,
      promptHashes: { extract: extract.promptHash, align: align.promptHash },
      unitChars: 24_000,
    }))
    const root = mkdtempSync(join(tmpdir(), 'vwa-legacy-audit-'))
    const store = new ReviewRunStore(root, w.snapshot.projectId)
    for (const record of first.records) {
      if (record.stage === 'extract') store.writeRecord(first.runId, { ...record, inputHash: legacyHash })
      else if (record.stage === 'align') {
        const response = record.response as import('../src/types.ts').AlignResponse
        store.writeRecord(first.runId, {
          ...record, inputHash: legacyHash,
          response: {
            ...response,
            // Old executeAudit appended runtime findings AFTER model findings.
            findings: [{ ...response.findings[0]!, id: `finding_${randomUUID()}`, artifactSpans: [{ start: 0, end: 1 }] }, ...response.findings],
          },
        })
      } else store.writeRecord(first.runId, record)
    }
    const adapter = auditWorldAdapter(w.artifact.id, items, { relation: 'new' })
    // Exercise the runner even before the fix: the pending source gives the
    // continuation work independently of the audit cache decision.
    const continued = await run({ ...w, root, stages: ['audit', 'sources'], continueMode: true, adapter })
    expect(continued.newClaimProposals).toEqual(items.map((item) => ({
      text: item.atomicClaims[0]!.text, kind: 'fact', importance: 'supporting',
      span: { start: marker.length + item.span.start, end: marker.length + item.span.end },
    })))
    expect(continued.status).toBe('completed')
    expect(adapter.state.dispatches).toBe(3) // fresh extract + align, then source
    expect(store.readUsage(continued.runId).filter((row) => row.kind === 'reused')).toEqual([])
    // Admission must also see legacy audit-only work, rather than returning
    // NOTHING_TO_CONTINUE and preventing the runner from refreshing it.
    expect(continuePreCheck({
      root, snapshot: w.snapshot, adapter, contractHash: w.contractHash,
      stages: ['audit'], targetClaimIds: [w.claim.id], artifact: w.artifact,
      history: allRecords(root, w.snapshot.projectId).filter((r) => r.runId === first.runId),
    })).toBeUndefined()
  })

  it('continue mode saves reused records + zero-token usage rows and skips audit dispatch', async () => {
    const w = world()
    const firstAdapter = auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim())], { relation: 'exact', claimId: w.claim.id })
    const first = await run({ ...w, stages: ['claims', 'audit'], adapter: firstAdapter })
    expect(first.status).toBe('completed')
    const before = firstAdapter.state.dispatches
    expect(before).toBe(3) // claims + extract + align

    // Continue run: audit reuses (no dispatch), the never-reviewed source executes.
    const secondAdapter = auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim())], { relation: 'exact', claimId: w.claim.id })
    const second = await run({ ...w, stages: ['audit', 'sources'], continueMode: true, adapter: secondAdapter })
    expect(second.status).toBe('completed')
    // Only the sources call dispatched; extract+align were reused, not re-run.
    expect(secondAdapter.state.dispatches).toBe(1)

    // Reused records are persisted under THIS runId (§A.2 semantic-reuse shape).
    const store = new ReviewRunStore(w.root, w.snapshot.projectId)
    const extract = second.records.find((r) => r.stage === 'extract')!
    const alignRecord = second.records.find((r) => r.stage === 'align')!
    expect(extract.runId).toBe(second.runId)
    expect(alignRecord.runId).toBe(second.runId)
    expect(store.readRecords(second.runId).map((r) => r.stage)).toContain('extract')

    // §A.3.5: reused records appear in the ledger with zero tokens.
    const reused = store.readUsage(second.runId).filter((row) => row.kind === 'reused')
    expect(reused.map((row) => row.taskId).sort()).toEqual(['align', 'extract'])
    for (const row of reused) {
      expect(row.inputTokens).toBe(0)
      expect(row.outputTokens).toBe(0)
    }

    // Outcome fields are identical to the executed path (modulo runtime finding ids).
    const stripIds = (fs: Finding[]) => findingsWithoutIds(fs)
    expect(stripIds(second.findings as Finding[])).toEqual(stripIds(first.findings as Finding[]))
    expect(second.auditMetrics).toEqual(first.auditMetrics)
    expect(second.newClaimProposals).toEqual(first.newClaimProposals)
    expect(second.newCoreDiscovered).toBe(first.newCoreDiscovered)
    expect(second.newCoreDiscovered).toBeUndefined()
  })

  it('needs-review new-core from a relation-new core atomic survives reuse', async () => {
    const w = world()
    const first = await run({ ...w, stages: ['claims', 'audit'], adapter: auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim(), 'core')], { relation: 'new' }) })
    // §12.1: a discovered new core marks the run needs-review (incomplete).
    expect(first.status).toBe('incomplete')
    expect(first.newCoreDiscovered).toBe(true)
    const second = await run({ ...w, stages: ['audit', 'sources'], continueMode: true, adapter: auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim(), 'core')], { relation: 'new' }) })
    expect(second.status).toBe('incomplete')
    expect(second.newCoreDiscovered).toBe(true)
  })

  it('belt-and-suspenders: newCoreDiscovered in the source run outcome survives reuse even when the align record lost it', async () => {
    const w = world()
    const firstAdapter = auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim(), 'supporting')], { relation: 'exact', claimId: w.claim.id })
    const first = await run({ ...w, stages: ['claims', 'audit'], adapter: firstAdapter })
    expect(first.status).toBe('completed')
    expect(first.newCoreDiscovered).toBeUndefined()
    // Simulate the divergence the belt guards: the source run's outcome
    // recorded a needs-review new-core the align record's coreClaimIds lost.
    const store = new ReviewRunStore(w.root, w.snapshot.projectId)
    store.writeOutcome(first.runId, { ...first, newCoreDiscovered: true })
    const secondAdapter = auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim(), 'supporting')], { relation: 'exact', claimId: w.claim.id })
    const second = await run({ ...w, stages: ['audit', 'sources'], continueMode: true, adapter: secondAdapter })
    // The belt sets coreDiscovered → the run is needs-review (incomplete).
    expect(second.status).toBe('incomplete')
    expect(second.newCoreDiscovered).toBe(true)
    // Reuse actually happened: only the sources call dispatched.
    expect(secondAdapter.state.dispatches).toBe(1)
  })

  it('default (non-continue) mode NEVER reuses the audit — negative pin', async () => {
    const w = world()
    const firstAdapter = auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim())], { relation: 'exact', claimId: w.claim.id })
    await run({ ...w, stages: ['claims', 'audit'], adapter: firstAdapter })
    const before = firstAdapter.state.dispatches
    const freshAdapter = auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim())], { relation: 'exact', claimId: w.claim.id })
    const fresh = await run({ ...w, stages: ['audit'], adapter: freshAdapter })
    expect(fresh.status).toBe('completed')
    // A fresh request is a second opinion: extract + align re-dispatch in full.
    expect(freshAdapter.state.dispatches).toBe(2)
  })

  it('a disagreement-marked audit is never reused — negative pin (end to end)', async () => {
    const w = world()
    const first = await run({ ...w, stages: ['claims', 'audit'], adapter: auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim())], { relation: 'exact', claimId: w.claim.id }) })
    expect(first.status).toBe('completed')
    // Mark-only unit pin lives below; here the clean pair still exists in
    // history, so the runner reuses it while a marked copy is never a source.
    const history = allRecords(w.root, w.snapshot.projectId).filter((r) => r.stage === 'extract' || r.stage === 'align')
    const marked = history.map((r) => ({ ...r, kind: 'disagreement' as const }))
    expect(findReusableAudit(marked, marked[0]!.inputHash)).toBeUndefined()
    expect(hasReusableAudit(marked, marked[0]!.inputHash)).toBe(false)
    const secondAdapter = auditWorldAdapter(w.artifact.id, [item(ARTIFACT_TEXT.trim())], { relation: 'exact', claimId: w.claim.id })
    const second = await run({ ...w, stages: ['audit', 'sources'], continueMode: true, adapter: secondAdapter })
    expect(second.status).toBe('completed')
    // The clean align record still exists in history, so the runner reuses it —
    // the unit-level pin above covers the marked-only case.
    expect(second.records.find((r) => r.stage === 'extract')!.runId).toBe(second.runId)
    expect(secondAdapter.state.dispatches).toBe(1)
  })
})

describe('findReusableAudit eligibility', () => {
  const w = world()
  const artifactId = w.artifact.id
  const claimId = w.claim.id
  const snapshot = w.snapshot
  const contractHash = w.contractHash
  const unitChars = 48_000
  const records: ReviewRecord[] = []
  const hash = auditInputHash({
    snapshot, artifact: w.artifact, records,
    coreClaimIds: [claimId], contractHash, reviewerConfigHash: 'r'.repeat(64), unitChars,
  })
  const extract = {
    runId: 'run_src', stage: 'extract' as const, targetRefs: [{ id: artifactId, entityVersion: 1 }],
    dependencyDigest: 'd', artifactHash: sha256Hex(w.artifact.text), contractHash, policyHash: 'p'.repeat(64),
    reviewerConfigHash: 'r'.repeat(64), promptHash: 'e'.repeat(64), inputHash: hash, status: 'completed' as const,
    inputTokens: 1, outputTokens: 1, startedAt: NOW2(), endedAt: NOW2(), response: { items: [] },
  }
  const align = {
    runId: 'run_src', stage: 'align' as const, targetRefs: [{ id: artifactId, entityVersion: 1 }],
    dependencyDigest: 'd', artifactHash: sha256Hex(w.artifact.text), contractHash, policyHash: 'p'.repeat(64),
    reviewerConfigHash: 'r'.repeat(64), promptHash: 'a'.repeat(64), inputHash: hash, status: 'completed' as const,
    coreClaimIds: [claimId], inputTokens: 1, outputTokens: 1, startedAt: NOW2(), endedAt: NOW2(),
    response: {
      stage: 'align' as const, rubricVersion: 'humanities-v1', findings: [], alignment: [],
      targets: [{ targetId: artifactId, checks: ['AUDIT-01', 'AUDIT-02', 'AUDIT-03', 'AUDIT-04', 'AUDIT-05'].map((ruleId) => ({ ruleId, result: 'pass', rationale: 'r', evidenceIds: [] })) }],
    },
  }

  it('returns the completed pair from one run under the audit key', () => {
    const found = findReusableAudit([extract, align], hash)
    expect(found?.extract).toEqual(extract)
    expect(found?.align).toEqual(align)
    expect(hasReusableAudit([extract, align], hash)).toBe(true)
  })

  it('a disagreement-marked align record never qualifies', () => {
    expect(findReusableAudit([extract, { ...align, kind: 'disagreement' }], hash)).toBeUndefined()
    expect(hasReusableAudit([extract, { ...align, kind: 'disagreement' }], hash)).toBe(false)
  })

  it('an align record without a same-run completed extract never qualifies', () => {
    expect(findReusableAudit([align], hash)).toBeUndefined()
    expect(findReusableAudit([extract, { ...align, runId: 'run_other' }], hash)).toBeUndefined()
  })

  it('a different input hash never qualifies', () => {
    expect(findReusableAudit([extract, align], 'f'.repeat(64))).toBeUndefined()
  })
})
