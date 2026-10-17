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
  prepareCall(config: { provider: string; model: string; maxTokens?: number }, signal?: AbortSignal): Promise<PreparedLlmCall>
}

/** A resolved one-shot route for reviewer calls. */
export interface ReviewerRoute {
  provider: string
  model: string
}

/** The messages input of Appendix A. */
export type ReviewMessages = { role: 'system' | 'user'; content: string }[]

/** Adapter validation / schema failure — never cached, retryable once (§13). */
export class ReviewInvalidError extends Error {
  readonly code = 'REVIEW_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'ReviewInvalidError'
  }
}

/** Appendix A PreparedReviewCall. */
export interface PreparedReviewCall {
  describe(): { modelId: string; providerId: string; version: string; effectiveOptions: Record<string, unknown> }
  dispatch(): Promise<{ raw: string; inputTokens?: number; outputTokens?: number }>
}

/** Appendix A ReviewModelAdapter. */
export interface ReviewModelAdapter {
  prepareReviewCall(input: {
    messages: ReviewMessages
    responseSchema: object
    maxOutputTokens: number
    signal: AbortSignal
  }): Promise<PreparedReviewCall>
  countInput(messages: ReviewMessages): Promise<{ tokens: number; method: 'tokenizer' | 'bytes-upper-bound' }>
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
}): ReviewModelAdapter {
  const tokenizerAvailable = options.tokenizerAvailable ?? true
  const toWire = (messages: ReviewMessages) => ({
    ...(messages.some((m) => m.role === 'system')
      ? { system: messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n') }
      : {}),
    messages: messages.filter((m) => m.role !== 'system').map((m) => createUserMessage({
      content: [{ type: 'text', text: m.content }],
      source: { kind: 'user' as const },
    })),
  })
  return {
    async prepareReviewCall(input) {
      const prepared: PreparedLlmCall = await options.llm.prepareCall(
        { provider: options.route.provider, model: options.route.model, maxTokens: input.maxOutputTokens },
        input.signal,
      )
      const wire = toWire(input.messages)
      const requestOptions: GenerateOptions = {
        provider: prepared.config.provider,
        model: prepared.config.model,
        messages: wire.messages,
        tools: forcedRespondTools(input.responseSchema),
        maxTokens: input.maxOutputTokens,
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
            // Transient transport failure: the runner retries once (§13).
            throw new Error(`review dispatch failed: ${finish.kind}`)
          }
          // Prefer the forced `respond` tool call; fall back to raw text.
          const call = assembler.blocks().find((block) => block.type === 'tool-call') as { type: 'tool-call'; arguments: string } | undefined
          const raw = call !== undefined ? call.arguments
            : assembler.blocks().filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('')
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
      return {
        provider: options.route.provider,
        model: options.route.model,
        promptTemplates: TEMPLATE_VERSION,
        tokenizer: tokenizerAvailable ? 'tokenizer' : 'bytes-upper-bound',
      }
    },
    async countInput(messages) {
      if (tokenizerAvailable) {
        const chars = messages.reduce((sum, m) => sum + m.content.length, 0)
        return { tokens: Math.ceil(chars / 4), method: 'tokenizer' }
      }
      const bytes = Buffer.from(messages.map((m) => m.content).join(''), 'utf8').length
      return { tokens: bytes, method: 'bytes-upper-bound' }
    },
  }
}

/** Parse and Ajv-validate a raw model response into a ReviewResponse (§13). */
export function parseReviewResponse(raw: string): ReviewResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ReviewInvalidError('response is not valid JSON')
  }
  if (!validateReviewResponse(parsed)) {
    throw new ReviewInvalidError(`response schema mismatch: ${ajvErrors(validateReviewResponse)}`)
  }
  return parsed as ReviewResponse
}

/** §8 rule ids + the runtime-only finding codes (§11.4). */
const KNOWN_RULES = new Set([
  'SOURCE-01', 'SOURCE-02', 'SOURCE-03', 'EVID-01', 'EVID-02', 'SUP-01', 'SUP-02',
  'ARG-01', 'ARG-02', 'HIST-01', 'CAUSE-01', 'INTENT-01', 'INTERP-01', 'EVAL-01',
  'ISSUE-01', 'AUDIT-01', 'AUDIT-02', 'AUDIT-03', 'AUDIT-04', 'AUDIT-05',
])
const FINDING_CODES = new Set([...KNOWN_RULES, 'AUDIT_NEW_CLAIM', 'AUDIT_STRONGER', 'AUDIT_BROADER', 'REVIEWER_DISAGREEMENT'])

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
  for (const target of response.targets) {
    if (!contract.targetIds.has(target.targetId)) {
      throw new ReviewInvalidError(`fabricated target id ${target.targetId}`)
    }
    const required = contract.requiredRules.get(target.targetId) ?? new Set<string>()
    const seen = new Set<string>()
    for (const check of target.checks) {
      if (!KNOWN_RULES.has(check.ruleId)) throw new ReviewInvalidError(`unknown rule ${check.ruleId}`)
      if (!required.has(check.ruleId)) throw new ReviewInvalidError(`rule ${check.ruleId} not required for target ${target.targetId}`)
      seen.add(check.ruleId)
      for (const evidenceId of check.evidenceIds) {
        if (!contract.knownEvidenceIds.has(evidenceId)) throw new ReviewInvalidError(`fabricated evidence id ${evidenceId}`)
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
      if (expected.some((id) => !covered.has(id)) || covered.size !== expected.length) {
        throw new ReviewInvalidError(`evidenceRelations for ${target.targetId} must cover exactly the group's evidenceIds`)
      }
      for (const relation of target.evidenceRelations) {
        if (!contract.knownEvidenceIds.has(relation.evidenceId)) throw new ReviewInvalidError(`fabricated evidence id ${relation.evidenceId}`)
      }
    }
    if (response.stage === 'arguments' && !('adequacy' in target) && !('issueImpact' in target)) {
      throw new ReviewInvalidError(`arguments target ${target.targetId} must carry adequacy or issueImpact/issueResolution`)
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
    if (!FINDING_CODES.has(finding.code)) throw new ReviewInvalidError(`unknown finding code ${finding.code}`)
    for (const id of finding.targetIds) {
      if (!contract.targetIds.has(id) && !contract.knownEvidenceIds.has(id)) throw new ReviewInvalidError(`fabricated finding target ${id}`)
    }
    for (const id of finding.evidenceIds) {
      if (!contract.knownEvidenceIds.has(id)) throw new ReviewInvalidError(`fabricated finding evidence ${id}`)
    }
  }
}
