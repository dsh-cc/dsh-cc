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
import { ReviewInvalidError, createReviewAdapter, validateTaskResponse } from '../src/review-adapter.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ReviewLlmFace } from '../src/review-adapter.ts'
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
 * Entries return a response (optionally asynchronously), or throw.
 */
export function fakeAdapter(
  script: Array<(req: { messages: ReviewMessages; responseSchema: object; maxOutputTokens: number; signal: AbortSignal }) => Awaited<ReturnType<PreparedReviewCall['dispatch']>> | ReturnType<PreparedReviewCall['dispatch']>>,
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

/**
 * Scripted adapter that runs the REAL `createReviewAdapter` (Fix 5 §4.4): the
 * `prepareCall` fake echoes `{...config, temperature}` like the real client,
 * so the prepared config reaches `configFingerprint()` as `effectiveConfig`.
 * `fakeAdapter` returns a constant fingerprint without `effectiveConfig`,
 * which makes identity pins vacuous.
 */
export function realAdapter(
  script: Array<(req: { messages: ReviewMessages; maxOutputTokens: number }) => {
    raw: string
    inputTokens?: number
    outputTokens?: number
  }>,
  state: FakeAdapterState = { dispatches: 0, prepareCalls: 0, lastMessages: undefined, lastResponseSchema: undefined },
): ReviewModelAdapter & { state: FakeAdapterState } {
  const llm: ReviewLlmFace = {
    async prepareCall(config) {
      state.prepareCalls += 1
      return {
        config: { ...config, temperature: 0.2 },
        stream: async function* (options: GenerateOptions) {
          const index = state.dispatches
          state.dispatches += 1
          const block = options.messages[0]!.content.find((candidate) => candidate.type === 'text')
          const content = block !== undefined && block.type === 'text' ? block.text : ''
          const messages: ReviewMessages = [
            ...(options.system === undefined ? [] : [{ role: 'system' as const, content: options.system }]),
            { role: 'user' as const, content },
          ]
          state.lastMessages = messages
          const step = script[Math.min(index, script.length - 1)]!
          const result = step({ messages, maxOutputTokens: config.maxTokens ?? 0 })
          yield { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const }
          yield {
            type: 'block-end' as const, index: 0,
            block: { type: 'tool-call' as const, id: 'r', name: 'respond', arguments: result.raw },
          }
          yield {
            type: 'usage' as const,
            usage: { inputTokens: result.inputTokens ?? 5, outputTokens: result.outputTokens ?? 5 },
          }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        },
      }
    },
  }
  return { ...createReviewAdapter({ llm, route: { provider: 'fake', model: 'fake-model' } }), state }
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
