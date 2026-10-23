/**
 * Review model adapter (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §13, §11.2, Appendix A): the host model seam for review tasks.
 *
 * Built on the harness LLM service's `prepareCall` (`PreparedLlmCall`):
 * prepare FIRST (resolving configuration and freezing the adapter
 * registration together), derive `describe()` from the prepared call, and
 * always dispatch through the same prepared handle (§11.2; R1-07 — there is
 * no standalone synchronous describe()).
 *
 * Structured output uses the forced single-tool `respond` form: one tool
 * whose `parameters` is the stage's response schema, no other tools. The
 * response is validated client-side with Ajv (schema.ts) plus the §6/§8.2
 * adapter checks; one repair retry within budget, then REVIEW_INVALID.
 *
 * @module @dsh-cc/vwa-argument/review-adapter
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, PreparedLlmCall, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { ajvErrors, validateReviewResponse } from './schema.ts'
import type { Id, ReviewResponse } from './types.ts'

/** The harness `llm` service face this adapter needs (no hard service import). */
export interface ReviewLlmFace {
  prepareCall(
    config: { provider: string; model: string; maxTokens?: number },
    signal?: AbortSignal,
  ): Promise<PreparedLlmCall>
}

/** A resolved one-shot route for reviewer calls. */
export interface ReviewerRoute {
  provider: string
  model: string
}

/** The messages input of Appendix A. */
export type ReviewMessages = { role: 'system' | 'user'; content: string }[]

/** Optional structured diagnostics attached to adapter failures (B.2.2). */
export interface ReviewErrorDetail {
  message: string
  httpStatus?: number
  providerCode?: string
  providerRetryAfterMs?: number
  rawResponseTail?: string
}

/** Adapter validation / schema failure — never cached, retryable once (§13). */
export class ReviewInvalidError extends Error {
  readonly code = 'REVIEW_INVALID'
  /** Last 2000 chars of the model raw output, when a raw response exists (B.2.2). */
  rawResponse?: string
  constructor(message: string) {
    super(message)
    this.name = 'ReviewInvalidError'
  }
}

/** Output cap hit mid-response — truncated JSON can never parse; permanent (B.2.4). */
export class ReviewTruncatedError extends Error {
  readonly code = 'REVIEW_TRUNCATED'
  constructor() {
    super('review response truncated: max output tokens reached')
    this.name = 'ReviewTruncatedError'
  }
}

/** Reviewer configuration changed mid-run — permanent, not a model error (B.2.4). */
export class ReviewConfigDriftError extends Error {
  readonly code = 'REVIEW_CONFIG_DRIFT'
  constructor(message = 'reviewer configuration changed during the run') {
    super(message)
    this.name = 'ReviewConfigDriftError'
  }
}

/** Appendix A PreparedReviewCall. */
export interface PreparedReviewCall {
  describe(): { modelId: string; providerId: string; version: string; effectiveOptions: Record<string, unknown> }
  dispatch(): Promise<{ raw: string; inputTokens?: number; outputTokens?: number }>
}

/** Appendix A ReviewModelAdapter. */
export interface ReviewModelAdapter {
  /** Freeze provider registration and effective configuration before hashing. */
  initialize?(maxOutputTokens: number, signal: AbortSignal): Promise<void>
  prepareReviewCall(input: {
    messages: ReviewMessages
    responseSchema: object
    maxOutputTokens: number
    signal: AbortSignal
  }): Promise<PreparedReviewCall>
  countInput(messages: ReviewMessages): Promise<{ tokens: number; method: 'tokenizer' | 'bytes/3-estimate' }>
  /** §11.2: the effective configuration facts that enter reviewerConfigHash. */
  configFingerprint(): Record<string, unknown>
}

/** Bumped whenever a prompt template's normative content changes. */
const TEMPLATE_VERSION = 'prompts@1'

const RESPOND_TOOL: ToolSchema = {
  name: 'respond',
  description: 'Return the completed review response for the assigned task, exactly matching the required schema.',
  parameters: {},
}

/** §11.2 forced-tool-call form: a single `respond` tool carrying the response schema. */
export function forcedRespondTools(responseSchema: object): ToolSchema[] {
  return [{ ...RESPOND_TOOL, parameters: responseSchema as ToolSchema['parameters'] }]
}

/** Host token meter: chars/4 heuristic when available, else UTF-8 byte upper bound (§13). */
export function createReviewAdapter(options: {
  llm: ReviewLlmFace
  route: ReviewerRoute
  /** true (default): host token-meter heuristic chars/4 labeled 'tokenizer'; false: byte count. */
  tokenizerAvailable?: boolean
  countTokens?(messages: ReviewMessages): Promise<number>
}): ReviewModelAdapter {
  const tokenizerAvailable = options.countTokens !== undefined
  let pending: PreparedLlmCall | undefined
  let effectiveConfig: Record<string, unknown> | undefined
  const freeze = async (maxTokens: number, signal: AbortSignal): Promise<PreparedLlmCall> => {
    const call = await options.llm.prepareCall(
      { provider: options.route.provider, model: options.route.model, maxTokens },
      signal,
    )
    const config = JSON.parse(JSON.stringify(call.config)) as Record<string, unknown>
    if (effectiveConfig && JSON.stringify(config) !== JSON.stringify(effectiveConfig))
      throw new ReviewConfigDriftError()
    effectiveConfig = config
    return call
  }
  const toWire = (messages: ReviewMessages) => ({
    ...(messages.some((m) => m.role === 'system')
      ? {
          system: messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n\n'),
        }
      : {}),
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) =>
        createUserMessage({
          content: [{ type: 'text', text: m.content }],
          source: { kind: 'user' as const },
        }),
      ),
  })
  return {
    async initialize(maxTokens, signal) {
      pending ??= await freeze(maxTokens, signal)
    },
    async prepareReviewCall(input) {
      const reserved = pending
      pending = undefined
      const prepared = reserved ?? (await freeze(input.maxOutputTokens, input.signal))
      const wire = toWire(input.messages)
      const requestOptions: GenerateOptions = {
        ...prepared.config,
        provider: prepared.config.provider,
        model: prepared.config.model,
        messages: wire.messages,
        tools: forcedRespondTools(input.responseSchema),
        maxTokens: prepared.config.maxTokens ?? input.maxOutputTokens,
        ...(wire.system === undefined ? {} : { system: wire.system }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }
      return {
        describe() {
          // Derived from the prepared call (R1-07): model identity + effective options.
          const config = prepared.config
          return {
            modelId: config.model,
            providerId: config.provider,
            version: config.reasoningEffort === undefined ? 'unpinned' : String(config.reasoningEffort),
            effectiveOptions: {
              maxTokens: config.maxTokens,
              ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
              ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
              tools: ['respond'],
            },
          }
        },
        async dispatch() {
          const assembler = new BlockAssembler()
          for await (const chunk of prepared.stream(requestOptions) as AsyncIterable<StreamChunk>) {
            assembler.push(chunk)
          }
          const finish = assembler.finish
          if (finish.kind === 'error' || finish.kind === 'aborted') {
            // Transport/provider failure: attach the LlmFailure facts as detail (B.2.2).
            const err: Error & { detail?: ReviewErrorDetail } = new Error(
              `review dispatch failed: ${finish.failure.message}`,
            )
            err.detail = {
              message: finish.failure.message.slice(0, 500),
              ...(finish.failure.status === undefined ? {} : { httpStatus: finish.failure.status }),
              providerCode: finish.failure.code,
              ...(finish.failure.providerRetryAfterMs === undefined
                ? {}
                : { providerRetryAfterMs: finish.failure.providerRetryAfterMs }),
            }
            throw err
          }
          // Truncation is permanent (B.2.4): the response can never parse.
          if (finish.kind === 'max-tokens') throw new ReviewTruncatedError()
          const calls = assembler.blocks().filter((block) => block.type === 'tool-call') as {
            name: string
            arguments: string
          }[]
          if (calls.length !== 1 || calls[0]!.name !== 'respond')
            throw new ReviewInvalidError('expected exactly one respond tool call')
          const raw = calls[0]!.arguments
          if (raw.length === 0) throw new ReviewInvalidError('empty review response')
          const usage = assembler.usage
          return {
            raw,
            ...(usage?.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
            ...(usage?.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
          }
        },
      }
    },
    configFingerprint() {
      // F5: budget facts are not review semantics (same principle as
      // semanticContractHash, F3.1). The mid-run drift check in freeze() keeps
      // comparing the FULL config. Denylist, not allowlist: unknown future
      // keys hash (over-invalidation) instead of silently dropping
      // (under-invalidation → stale records reused as current).
      const { maxTokens: _budget, ...semanticConfig } = effectiveConfig ?? {}
      // F6: how input was COUNTED is a budget-accounting fact — it changes
      // reservations, never review content — so it is not record identity.
      return {
        provider: options.route.provider,
        model: options.route.model,
        promptTemplates: TEMPLATE_VERSION,
        ...(effectiveConfig ? { effectiveConfig: semanticConfig } : {}),
      }
    },
    async countInput(messages) {
      if (tokenizerAvailable) {
        return { tokens: await options.countTokens!(messages), method: 'tokenizer' }
      }
      const bytes = Buffer.from(messages.map((m) => m.content).join(''), 'utf8').length
      // F6: approximate accounting, NOT an upper bound. UTF-8 reviewer envelopes
      // run ~2.2 (token-dense CJK) to ~6.5 (ASCII/JSON) bytes per token; bytes/3
      // keeps the reproduction's 6.5x inflation down to ~1.9x while
      // under-reserving at most ~1.4x per call on the densest realistic mix.
      return { tokens: Math.ceil(bytes / 3), method: 'bytes/3-estimate' }
    },
  }
}

/** Parse and Ajv-validate a raw model response into a ReviewResponse (§13). */
export function parseReviewResponse(raw: string): ReviewResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const err = new ReviewInvalidError('response is not valid JSON')
    err.rawResponse = raw.slice(-2000)
    throw err
  }
  if (!validateReviewResponse(parsed)) {
    const err = new ReviewInvalidError(`response schema mismatch: ${ajvErrors(validateReviewResponse)}`)
    err.rawResponse = raw.slice(-2000)
    throw err
  }
  return parsed as ReviewResponse
}

/** §8 rule ids + the runtime-only finding codes (§11.4). */
const KNOWN_RULES = new Set([
  'SOURCE-01',
  'SOURCE-02',
  'SOURCE-03',
  'EVID-01',
  'EVID-02',
  'SUP-01',
  'SUP-02',
  'ARG-01',
  'ARG-02',
  'HIST-01',
  'CAUSE-01',
  'INTENT-01',
  'INTERP-01',
  'EVAL-01',
  'ISSUE-01',
  'AUDIT-01',
  'AUDIT-02',
  'AUDIT-03',
  'AUDIT-04',
  'AUDIT-05',
])
const FINDING_CODES = new Set([
  ...KNOWN_RULES,
  'AUDIT_NEW_CLAIM',
  'AUDIT_STRONGER',
  'AUDIT_BROADER',
  'REVIEWER_DISAGREEMENT',
])

/** One dispatched task's validation inputs (the envelope the task was sent with). */
export interface ReviewTaskContract {
  stage: ReviewResponse['stage']
  /** Ids the response may reference as targets (§6: only input IDs may be cited). */
  targetIds: ReadonlySet<string>
  /** requiredRules as dispatched: every entry MUST appear (R1-03). */
  requiredRules: ReadonlyMap<Id, ReadonlySet<string>>
  /** Evidence ids that exist in the task input (hallucinated evidence invalidates). */
  knownEvidenceIds: ReadonlySet<string>
  /** Group membership for evidenceRelations coverage (support stage). */
  groupEvidenceIds?: ReadonlyMap<Id, readonly Id[]>
}

/**
 * Adapter validation beyond Ajv (§6, §8.2, §7.1):
 * - every requiredRules entry present (missing → REVIEW_INVALID, R1-03);
 * - no unknown rule ids; no rules outside the target's required set;
 * - no fabricated target/evidence ids;
 * - no contradictory combos (fail + adequacy robust/adequate on the same target);
 * - evidenceRelations cover exactly the group's evidenceIds.
 */
export function validateTaskResponse(response: ReviewResponse, contract: ReviewTaskContract): void {
  if (response.stage !== contract.stage) {
    throw new ReviewInvalidError(`stage mismatch: expected ${contract.stage}, got ${response.stage}`)
  }
  const seenTargets = new Set<string>()
  for (const target of response.targets) {
    if (seenTargets.has(target.targetId)) throw new ReviewInvalidError(`duplicate target ${target.targetId}`)
    seenTargets.add(target.targetId)
    if (!contract.requiredRules.has(target.targetId))
      throw new ReviewInvalidError(`unexpected response target ${target.targetId}`)
    if (!contract.targetIds.has(target.targetId)) {
      throw new ReviewInvalidError(`fabricated target id ${target.targetId}`)
    }
    const required = contract.requiredRules.get(target.targetId) ?? new Set<string>()
    const seen = new Set<string>()
    for (const check of target.checks) {
      if (!KNOWN_RULES.has(check.ruleId)) throw new ReviewInvalidError(`unknown rule ${check.ruleId}`)
      if (!required.has(check.ruleId))
        throw new ReviewInvalidError(`rule ${check.ruleId} not required for target ${target.targetId}`)
      if (seen.has(check.ruleId)) throw new ReviewInvalidError(`duplicate rule ${check.ruleId}`)
      seen.add(check.ruleId)
      for (const evidenceId of check.evidenceIds) {
        if (!contract.knownEvidenceIds.has(evidenceId))
          throw new ReviewInvalidError(`fabricated evidence id ${evidenceId}`)
      }
    }
    // Contradictory combo (§7.1): fail together with adequacy robust/adequate.
    const hasFail = target.checks.some((c) => c.result === 'fail')
    const adequacy = 'adequacy' in target ? (target.adequacy as string | undefined) : undefined
    if (hasFail && (adequacy === 'robust' || adequacy === 'adequate')) {
      throw new ReviewInvalidError(`contradictory response on ${target.targetId}: fail with adequacy ${adequacy}`)
    }
    if (response.stage === 'support') {
      if (!('support' in target) || !('adequacy' in target) || !Array.isArray(target.evidenceRelations)) {
        throw new ReviewInvalidError(`support target ${target.targetId} missing support/adequacy/evidenceRelations`)
      }
      const expected = contract.groupEvidenceIds?.get(target.targetId) ?? []
      const covered = new Set(target.evidenceRelations.map((r) => r.evidenceId))
      if (
        expected.some((id) => !covered.has(id)) ||
        covered.size !== expected.length ||
        target.evidenceRelations.length !== expected.length
      ) {
        throw new ReviewInvalidError(
          `evidenceRelations for ${target.targetId} must cover exactly the group's evidenceIds`,
        )
      }
      for (const relation of target.evidenceRelations) {
        if (!contract.knownEvidenceIds.has(relation.evidenceId))
          throw new ReviewInvalidError(`fabricated evidence id ${relation.evidenceId}`)
      }
    }
    if (response.stage === 'arguments' && target.targetId.startsWith('arg_') && !('adequacy' in target))
      throw new ReviewInvalidError('argument target requires adequacy')
    if (
      response.stage === 'arguments' &&
      target.targetId.startsWith('iss_') &&
      (!('issueImpact' in target) || !('issueResolution' in target) || 'adequacy' in target)
    )
      throw new ReviewInvalidError('issue target requires impact and resolution only')
    if (
      response.stage === 'arguments' &&
      'issueImpact' in target &&
      target.issueImpact === 'invalidate' &&
      target.checks.every((c) => c.evidenceIds.length === 0) &&
      !response.findings.some(
        (f) => f.targetIds.includes(target.targetId) && (f.evidenceIds.length > 0 || f.explanation.trim().length > 0),
      )
    )
      throw new ReviewInvalidError('decisive issue requires located evidence or an explicit inference contradiction')
    if (response.stage === 'arguments' && !('adequacy' in target) && !('issueImpact' in target)) {
      throw new ReviewInvalidError(
        `arguments target ${target.targetId} must carry adequacy or issueImpact/issueResolution`,
      )
    }
  }
  // Required-rule closure (R1-03): every dispatched rule must appear exactly
  // in some target's checks.
  for (const [targetId, rules] of contract.requiredRules) {
    const responder = response.targets.find((t) => t.targetId === targetId)
    for (const ruleId of rules) {
      if (responder === undefined || !responder.checks.some((c) => c.ruleId === ruleId)) {
        throw new ReviewInvalidError(`missing required rule ${ruleId} for target ${targetId}`)
      }
    }
  }
  for (const finding of response.findings) {
    if ('kind' in finding || finding.code === 'REVIEWER_DISAGREEMENT')
      throw new ReviewInvalidError('reviewer disagreement is runtime-generated only')
    if (!FINDING_CODES.has(finding.code)) throw new ReviewInvalidError(`unknown finding code ${finding.code}`)
    for (const id of finding.targetIds) {
      if (!contract.targetIds.has(id) && !contract.knownEvidenceIds.has(id))
        throw new ReviewInvalidError(`fabricated finding target ${id}`)
    }
    for (const id of finding.evidenceIds) {
      if (!contract.knownEvidenceIds.has(id)) throw new ReviewInvalidError(`fabricated finding evidence ${id}`)
    }
  }
}
