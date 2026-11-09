/**
 * Canonical JSON, full-input hashing and input estimation for the SystemOne
 * decision runner (design doc 2026-11-02 §"Execution state machine" steps
 * 2-3). Pure, dependency-light: the hash runs the canonical form of
 * `{provider, model, routeRevision, state, questions, questionVersion,
 * policyVersion}` through SHA-256 — never the API key, never the baseURL.
 *
 * Canonical means: object keys sorted recursively, arrays kept in order, and
 * `JSON.stringify` number/string semantics otherwise. Callers are expected
 * to run the S1-01 request pre-check first, so the input is already
 * JSON-serializable (no cycles, BigInt, non-finite numbers or undefined
 * values); a cyclic value still throws rather than hashing silently.
 *
 * Estimation reuses the calibrated lower-bound estimator from budget.ts with
 * its doc-frozen envelope and margin constants — the same composition the
 * legacy gauge adapter uses. An over-limit estimate is a dispatch filter
 * (the runner rejects with `budget`), never a billing upper bound and never
 * a reason to truncate.
 *
 * @module @dsh-cc/systemone/decision-hash
 */

import { createHash } from 'node:crypto'

import { S1_ENVELOPE_TOKENS, S1_MARGIN_TOKENS, estimateSystemOneTokens } from './budget.ts'
import type { SystemOneQuestion } from './client.ts'

/** Deep object-key sort; arrays and primitives pass through structurally. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return sorted
  }
  return value
}

/**
 * Deterministic serialization: recursively sorted object keys over
 * `JSON.stringify` semantics. Two values equal up to key insertion order
 * produce byte-identical output, so the input hash is stable across source
 * object construction orders. The API key and baseURL are never inputs here.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

/** The identity-bearing decision input that enters the full SHA-256 hash. */
export interface DecisionHashInput {
  provider: string
  model: string
  routeRevision: string
  state: unknown
  questions: Record<string, SystemOneQuestion>
  questionVersion: string
  policyVersion: string
}

/**
 * Full SHA-256 (hex) of the canonical decision input (design step 3). Every
 * ledger row of one run carries this hash; question and policy versions are
 * hashed, and the wire model is used as-is (the trusted actual model id is
 * recorded per row separately). Contains no secrets by construction.
 */
export function inputHashForDecision(input: DecisionHashInput): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        provider: input.provider,
        model: input.model,
        routeRevision: input.routeRevision,
        state: input.state,
        questions: input.questions,
        questionVersion: input.questionVersion,
        policyVersion: input.policyVersion,
      }),
    )
    .digest('hex')
}

/** Lower-bound input estimates for the admission check of one run. */
export interface DecisionInputTokenEstimate {
  /**
   * Whole-request estimate: envelope + margin + canonical state + canonical
   * questions map, checked against the per-request window.
   */
  requestTokens: number
  /**
   * Per question id: envelope + margin + canonical state + canonical
   * singleton questions map — each state+question pair checked individually
   * against the per-question window (design step 2).
   */
  questionTokens: Record<string, number>
}

/**
 * Estimate the decision input for dispatch filtering. The composition is
 * envelope + margin on top of the calibrated codepoint estimator, matching
 * the legacy probe budget; per-question entries count the state again
 * because a singleton dispatch would carry it again.
 */
export function estimateDecisionInputTokens(
  state: unknown,
  questions: Record<string, SystemOneQuestion>,
): DecisionInputTokenEstimate {
  const stateTokens = estimateSystemOneTokens(canonicalJson(state))
  const requestTokens =
    S1_ENVELOPE_TOKENS + stateTokens + estimateSystemOneTokens(canonicalJson(questions)) + S1_MARGIN_TOKENS
  const questionTokens: Record<string, number> = Object.create(null)
  for (const [id, question] of Object.entries(questions)) {
    questionTokens[id] =
      S1_ENVELOPE_TOKENS + stateTokens + estimateSystemOneTokens(canonicalJson({ [id]: question })) + S1_MARGIN_TOKENS
  }
  return { requestTokens, questionTokens }
}
