/**
 * Capability route resolution for the SystemOne decision service (design
 * §"Public interface", §"Settings and capability declaration").
 *
 * A usable decision route is: alias → a concrete `protocol === 'systemone'`
 * route (via @dsh-cc/model-aliases) → exactly one exact `(provider, model)`
 * row in the trusted `capabilities` table → positive safe-integer bounds →
 * provider connection facts (baseURL, optional apiKey) from the trusted
 * `llm-pi-ai` provider record. Everything is fail-closed: any miss,
 * ambiguity or invalid bound resolves to `undefined` (the runner's
 * `unconfigured`), never to a guessed value.
 *
 * @module @dsh-cc/decision-usage/route
 */

import type { DecisionRouteResolution } from '@dsh-cc/systemone'
import { MAX_ACTUAL_MODEL_ID_CHARS } from './settings.ts'

/** One validated capability row (camelCase, internal interface). */
export interface DecisionCapability {
  provider: string
  model: string
  revision: string
  /** The only model id a response may report; run-side secret (never surfaced). */
  actualModelId: string
  perRequestTokens: number
  perQuestionTokens: number
  maxOutputTokens: number
  maxQuestions: number
}

/** Provider connection facts lifted from the trusted `llm-pi-ai` record. */
export interface DecisionRouteConnection {
  baseURL: string
  apiKey?: string
}

/** The concrete-route face a model-alias resolution projects. */
export interface DecisionAliasRoute {
  provider?: string | undefined
  model?: string | undefined
  protocol?: string | undefined
}

/** Injectable seams: alias resolution and provider connection lookup. */
export interface DecisionRouteDeps {
  /** Resolve one alias to its concrete route (resolveDetailedAlias(...).route). */
  resolveAlias(alias: string): DecisionAliasRoute | undefined
  /** Connection facts for one provider key; undefined when unresolvable. */
  connection(provider: string): DecisionRouteConnection | undefined
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const isSafePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

/**
 * Validate one raw capability row into the internal camelCase shape. Every
 * token/question bound must be a positive safe integer (deployment contract —
 * never guessed), actual-model-id non-empty and at most 256 characters.
 * Returns undefined for any violation.
 */
export function toDecisionCapability(raw: unknown): DecisionCapability | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const provider = row.provider
  const model = row.model
  const revision = row.revision
  const actualModelId = row['actual-model-id']
  const perRequestTokens = row['per-request-tokens']
  const perQuestionTokens = row['per-question-tokens']
  const maxOutputTokens = row['max-output-tokens']
  const maxQuestions = row['max-questions']
  if (!isNonEmptyString(provider) || !isNonEmptyString(model) || !isNonEmptyString(revision)) return undefined
  if (!isNonEmptyString(actualModelId) || actualModelId.length > MAX_ACTUAL_MODEL_ID_CHARS) return undefined
  if (!isSafePositive(perRequestTokens) || !isSafePositive(perQuestionTokens)) return undefined
  if (!isSafePositive(maxOutputTokens) || !isSafePositive(maxQuestions)) return undefined
  return {
    provider,
    model,
    revision,
    actualModelId,
    perRequestTokens,
    perQuestionTokens,
    maxOutputTokens,
    maxQuestions,
  }
}

/**
 * Exact `(provider, model)` match over validated capability rows. More than
 * one row matching is an invalid configuration: the route is unusable
 * (undefined), never first-wins.
 */
export function matchDecisionCapability(
  rows: readonly unknown[],
  provider: string,
  model: string,
): DecisionCapability | undefined {
  const matches: DecisionCapability[] = []
  for (const raw of rows) {
    const capability = toDecisionCapability(raw)
    if (capability === undefined) continue
    if (capability.provider === provider && capability.model === model) matches.push(capability)
  }
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Resolve a route alias into the full run-side route resolution. Only
 * concrete `protocol === 'systemone'` routes qualify — there is no chat
 * fallback. Undefined whenever the alias is not concrete, the protocol is
 * wrong, the capability row is missing/ambiguous/invalid, or the provider
 * connection facts are unavailable.
 */
export function resolveDecisionRoute(
  alias: string,
  capabilityRows: readonly unknown[],
  deps: DecisionRouteDeps,
): DecisionRouteResolution | undefined {
  try {
    const route = deps.resolveAlias(alias)
    if (route === undefined || route.protocol !== 'systemone') return undefined
    const provider = route.provider
    const model = route.model
    if (!isNonEmptyString(provider) || !isNonEmptyString(model)) return undefined
    const capability = matchDecisionCapability(capabilityRows, provider, model)
    if (capability === undefined) return undefined
    const connection = deps.connection(provider)
    if (connection === undefined || !isNonEmptyString(connection.baseURL)) return undefined
    return {
      provider,
      model,
      actualModelId: capability.actualModelId,
      baseURL: connection.baseURL,
      ...(connection.apiKey !== undefined ? { apiKey: connection.apiKey } : {}),
      revision: capability.revision,
      perRequestTokens: capability.perRequestTokens,
      perQuestionTokens: capability.perQuestionTokens,
      maxOutputTokens: capability.maxOutputTokens,
      maxQuestions: capability.maxQuestions,
    }
  } catch {
    // Resolution is read-only over settings seams; any fault is `unconfigured`.
    return undefined
  }
}
