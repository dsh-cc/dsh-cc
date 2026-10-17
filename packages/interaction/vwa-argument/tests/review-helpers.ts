/**
 * Fixtures for the slice-3 review specs (D13a/D13b/D14/D18/D19): an
 * in-memory snapshot factory, a scripted FAKE review adapter (deterministic;
 * model randomness is never used to test deterministic contracts, §22.1),
 * and runner bootstrap helpers.
 * @module tests/review-helpers
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Adequacy, Claim, Evidence, EvidenceGroup, ProjectSnapshot, ReviewRecord, ReviewResponse,
  Source, Support, Verdict,
} from '../src/types.ts'
import type {
  PreparedReviewCall, ReviewMessages, ReviewModelAdapter, ReviewTaskContract,
} from '../src/review-adapter.ts'
import { ReviewInvalidError, validateTaskResponse } from '../src/review-adapter.ts'
import { buildReverseIndex } from '../src/dependencies.ts'
import type { ReviewBudget } from '../src/review-runner.ts'

export const NOW = '2026-10-16T00:00:00.000Z'
export const uuid = randomUUID

export function makeClaim(kind: Claim['kind'] = 'fact', text = 'The document records the decision.'): Claim {
  return {
    id: `cl_${uuid()}`, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
    text, kind,
    scope: { subject: 'the decision', corpus: [], time: 'unspecified', geography: 'unspecified', exclusions: [] },
    importance: 'core', stance: 'asserted', evaluationCriteria: [],
  }
}

export function makeSource(): Source {
  return {
    id: `src_${uuid()}`, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
    snapshotPath: 'docs/vwa-sources/x.md', snapshotHash: 'a'.repeat(64),
    acquisition: { kind: 'tool-event', capturedAt: NOW },
    title: 'Minutes', creators: [], publication: 'unknown', originalLocator: 'loc', edition: 'unknown',
    language: 'en', origin: 'external', material: 'primary',
    lineage: { relation: 'unknown', parentSourceIds: [], note: 'n' },
    authenticity: 'unverified', authenticityBasisEvidenceIds: [],
  }
}

export function makeEvidence(source: Source): Evidence {
  return {
    id: `ev_${uuid()}`, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
    sourceId: source.id, sourceSnapshotHash: source.snapshotHash,
    span: { start: 0, end: 5 }, quote: 'degre', contextSpan: { start: 0, end: 10 },
    originalLocation: 'p.1', transformation: 'none', transformationNote: '',
  }
}

export function makeGroup(targetClaimId: string, evidenceIds: string[], mode: 'all' | 'any' = 'all'): EvidenceGroup {
  return {
    id: `grp_${uuid()}`, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
    targetClaimId, evidenceIds, mode, rationale: 'joint support',
  }
}

export function makeArgument(conclusionClaimId: string, premiseClaimIds: string[], evidenceGroupIds: string[]): import('../src/types.ts').Argument {
  return {
    id: `arg_${uuid()}`, entityVersion: 1, createdAt: NOW, updatedAt: NOW,
    premiseClaimIds, evidenceGroupIds, conclusionClaimId,
    scheme: 'deductive', warrant: 'recorded decisions are reliable', assumptions: [], limitations: [],
  }
}

export function makeSnapshot(parts: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    schemaVersion: 1,
    projectId: `prj_${uuid()}`,
    revision: 3,
    workspaceIdentity: 'b'.repeat(64),
    contract: {
      question: 'What does the document record?', language: 'en', domain: 'history',
      requiredQuestions: [{ id: 'q1', text: 'Is the causal account supported?' }],
      plannedCorpus: [], expectedCoreTopics: ['decision'], mode: 'draft',
    },
    sources: [], evidence: [], claims: [], groups: [], arguments: [], issues: [], searches: [], artifacts: [],
    ...parts,
  }
}

export const BUDGET: ReviewBudget = {
  maxCallsPerRun: 40, maxInputTokensPerRun: 1_000_000, maxOutputTokensPerRun: 1_000_000,
  maxOutputTokensPerCall: 3000, wallMs: 60_000, callTimeoutMs: 5_000, concurrency: 2,
}

export interface FakeAdapterState {
  dispatches: number
  prepareCalls: number
  lastMessages: ReviewMessages | undefined
  lastResponseSchema: object | undefined
}

/**
 * Scripted fake adapter: each dispatch consumes the next script entry.
 * Entries: a raw response string, an object (usage attached), or a thrower.
 */
export function fakeAdapter(
  script: Array<(req: { messages: ReviewMessages; responseSchema: object; maxOutputTokens: number; signal: AbortSignal }) => { raw: string; inputTokens?: number; outputTokens?: number } | never>,
  state: FakeAdapterState = { dispatches: 0, prepareCalls: 0, lastMessages: undefined, lastResponseSchema: undefined },
): ReviewModelAdapter & { state: FakeAdapterState } {
  return {
    state,
    async prepareReviewCall(req) {
      state.prepareCalls += 1
      state.lastMessages = req.messages
      state.lastResponseSchema = req.responseSchema
      const step = script[Math.min(state.dispatches, script.length - 1)]!
      const prepared: PreparedReviewCall = {
        describe: () => ({ modelId: 'fake-model', providerId: 'fake', version: 'unpinned', effectiveOptions: { tools: ['respond'] } }),
        dispatch: async () => {
          state.dispatches += 1
          return step(req)
        },
      }
      return prepared
    },
    async countInput(messages) {
      return { tokens: Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4), method: 'tokenizer' }
    },
    configFingerprint() {
      return { provider: 'fake', model: 'fake-model', template: 'prompts@1' }
    },
  }
}

/** A schema-valid claims-stage response over one fact claim. */
export function claimsResponse(claimId: string, result: Verdict, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    stage: 'claims', rubricVersion: 'humanities-v1', findings: [],
    targets: [{ targetId: claimId, checks: [{ ruleId: 'HIST-01', result, rationale: 'r', evidenceIds: [] }], searchSufficiency: 'checked' }],
    ...extra,
  })
}

/** Assert adapter validation rejects with the single REVIEW_INVALID code. */
export function expectReviewInvalid(response: ReviewResponse, contract: ReviewTaskContract): ReviewInvalidError {
  try {
    validateTaskResponse(response, contract)
  } catch (error) {
    if (!(error instanceof ReviewInvalidError)) throw error
    if (error.code !== 'REVIEW_INVALID') throw new Error(`expected REVIEW_INVALID, got ${error.message}`)
    return error
  }
  throw new Error('expected validateTaskResponse to reject')
}

/** Latest completed record for a target (test convenience). */
export function completedRecord(records: (ReviewRecord & { kind?: 'disagreement' })[]): ReviewRecord {
  const found = records.find((r) => r.status === 'completed')
  if (found === undefined) throw new Error(`no completed record in ${JSON.stringify(records.map((r) => [r.status, r.errorCode]))}`)
  return found
}

/** A support-stage response over one group (test convenience). */
export function supportResponse(groupId: string, evidenceIds: string[], support: Support, adequacy: Adequacy, checkResult: Verdict = 'pass'): string {
  return JSON.stringify({
    stage: 'support', rubricVersion: 'humanities-v1', findings: [],
    targets: [{
      targetId: groupId,
      checks: [{ ruleId: 'EVID-02', result: checkResult, rationale: 'r', evidenceIds: [] },
        { ruleId: 'SUP-01', result: checkResult, rationale: 'r', evidenceIds: [] },
        { ruleId: 'SUP-02', result: checkResult, rationale: 'r', evidenceIds: [] }],
      support, adequacy,
      evidenceRelations: evidenceIds.map((evidenceId) => ({ evidenceId, support: 'direct', rationale: 'r' })),
    }],
  })
}

/** Reverse index for an in-memory snapshot (test convenience). */
export function indexOf(snapshot: ProjectSnapshot): ReturnType<typeof buildReverseIndex> {
  return buildReverseIndex(snapshot)
}
