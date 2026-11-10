/**
 * Decision-lane route resolution (design §"Public interface").
 *
 * A usable decision route is: the alias resolves (via @dsh-cc/model-aliases)
 * to a concrete `protocol === 'systemone'` route with a non-empty provider and
 * model → that alias's OPTIONAL pin row in the trusted `systemone-decisions`
 * `routes` dict → the trusted `llm-pi-ai` connection facts for the provider.
 *
 * There is no capability table, no exact `(provider, model)` match, no
 * parent-header fill and no peer fallback: the lane alias IS the route, and
 * only its own pin row can narrow it. Everything is fail-closed — a miss, a
 * folded-key invalid value or an unavailable connection resolves THAT alias to
 * `undefined` (the runner's `unconfigured`), never to a guessed value and
 * never affecting a sibling alias.
 *
 * @module @dsh-cc/decision-usage/route
 */

import {
  DEFAULT_GAUGE_CONTEXT_WINDOW,
  GAUGE_MODEL_CONTEXT_WINDOWS,
  normalizeGaugeModelId,
} from '@dsh-cc/systemone'
import type { DecisionRouteResolution } from '@dsh-cc/systemone'
import { MAX_ACTUAL_MODEL_ID_CHARS } from './settings.ts'

/**
 * Default per-attempt output reservation (anti-overrun sizing, not a
 * guarantee): each attempt reserves these bounds against the session quota
 * and an unknown-settled attempt retains them.
 */
export const DEFAULT_DECISION_MAX_OUTPUT_TOKENS = 32768

/** Default question-slot bound per request. */
export const DEFAULT_DECISION_MAX_QUESTIONS = 32

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

/** Injectable seams: alias resolution, provider connection lookup, warnings. */
export interface DecisionRouteDeps {
  /** Resolve one alias to its concrete route (resolveDetailedAlias(...).route). */
  resolveAlias(alias: string): DecisionAliasRoute | undefined
  /** Connection facts for one provider key; undefined when unresolvable. */
  connection(provider: string): DecisionRouteConnection | undefined
  /** Warn sink for a folded-key collision; wrap in {@link createWarnOnce}. */
  warn?(message: string): void
}

/** One resolved pin row (camelCase, internal interface). */
export interface DecisionRoutePin {
  revision: string
  /** Absent means "no version pin": any echoed model id is accepted. */
  actualModelId?: string
  perRequestTokens: number
  perQuestionTokens: number
  maxOutputTokens: number
  maxQuestions: number
}

/**
 * Warn-once sink (the repo's `createWarnOnce` idiom): the first occurrence of
 * one message reaches `warn`, repeats are dropped. Owned by the caller so
 * resolution itself stays a stateless pure function.
 * @param warn - the injected sink (usually `message => ctx.logger.warn(message)`).
 * @returns a sink that forwards each distinct message at most once.
 */
export function createWarnOnce(warn: (message: string) => void): (message: string) => void {
  const seen = new Set<string>()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    warn(message)
  }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const isSafePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A pin-row lookup outcome: absent rows fall through to registry defaults. */
type PinRowLookup = { status: 'absent' } | { status: 'present'; row: unknown }

/**
 * Find one alias's pin row. Dict keys are folded to lowercase and compared
 * against the folded alias, so `routes.Gauge` pins `gauge`. Two keys folding
 * onto the same name is last-wins with one warning — never a silent merge, and
 * never a reason to disable the alias.
 * @param alias - the lane alias being resolved.
 * @param routes - the parsed `routes` dict (may be absent).
 * @param warn - the injected warn-once sink.
 * @returns the row when some key folds onto the alias.
 */
export function lookupRoutePin(
  alias: string,
  routes: Record<string, unknown> | undefined,
  warn?: (message: string) => void,
): PinRowLookup {
  if (routes === undefined) return { status: 'absent' }
  const folded = alias.toLowerCase()
  let row: unknown
  let matches = 0
  for (const key of Object.keys(routes)) {
    if (key.toLowerCase() !== folded) continue
    matches += 1
    row = routes[key]
  }
  if (matches === 0) return { status: 'absent' }
  if (matches > 1) {
    warn?.(`decision-usage: route "${folded}" is pinned by ${matches} case-folded keys; the last row wins`)
  }
  return { status: 'present', row }
}

/**
 * Validate one pin row against a resolved wire model. Absent fields take their
 * defaults; a PRESENT but invalid field (`null`, `''`, `0`, a negative or
 * non-safe-integer value) makes this alias unusable (undefined). Returns the
 * resolved bounds for the alias.
 * @param row - the raw row (already known to be present).
 * @param wireModel - the resolved wire model id the defaults key on.
 * @returns the resolved pin, or undefined for an invalid present field.
 */
export function toDecisionRoutePin(row: unknown, wireModel: string): DecisionRoutePin | undefined {
  if (!isPlainObject(row)) return undefined
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(row, key)

  const revision = has('revision') ? row.revision : wireModel
  if (!isNonEmptyString(revision)) return undefined

  const rawPinnedModel = has('actual-model-id') ? row['actual-model-id'] : undefined
  if (rawPinnedModel !== undefined) {
    if (!isNonEmptyString(rawPinnedModel) || rawPinnedModel.length > MAX_ACTUAL_MODEL_ID_CHARS) return undefined
  }

  // Measured per-model window (the `llmbox_systemone/` prefix is stripped):
  // 16384 for a known model, the checkpoint window for an unknown one.
  const windowDefault = GAUGE_MODEL_CONTEXT_WINDOWS[normalizeGaugeModelId(wireModel)] ?? DEFAULT_GAUGE_CONTEXT_WINDOW

  const perRequestTokens = has('per-request-tokens') ? row['per-request-tokens'] : windowDefault
  const perQuestionTokens = has('per-question-tokens') ? row['per-question-tokens'] : windowDefault
  const maxOutputTokens = has('max-output-tokens') ? row['max-output-tokens'] : DEFAULT_DECISION_MAX_OUTPUT_TOKENS
  const maxQuestions = has('max-questions') ? row['max-questions'] : DEFAULT_DECISION_MAX_QUESTIONS
  if (!isSafePositive(perRequestTokens) || !isSafePositive(perQuestionTokens)) return undefined
  if (!isSafePositive(maxOutputTokens) || !isSafePositive(maxQuestions)) return undefined

  return {
    revision,
    ...(rawPinnedModel !== undefined ? { actualModelId: rawPinnedModel } : {}),
    perRequestTokens,
    perQuestionTokens,
    maxOutputTokens,
    maxQuestions,
  }
}

/**
 * Resolve one lane alias into the full run-side route resolution.
 *
 * Only concrete `protocol === 'systemone'` routes qualify — no chat fallback,
 * no parent-header fill, no peer fallback. Undefined whenever the alias is not
 * usable, the present pin row is invalid, or the provider connection facts are
 * unavailable.
 * @param alias - the lane alias (e.g. `DECISION_LANE_ALIAS`).
 * @param routes - the parsed `routes` dict from trusted settings.
 * @param deps - injectable alias/connection/warn seams.
 * @returns the resolution, or undefined when the route is unconfigured.
 */
export function resolveDecisionRoute(
  alias: string,
  routes: Record<string, unknown> | undefined,
  deps: DecisionRouteDeps,
): DecisionRouteResolution | undefined {
  try {
    if (!isNonEmptyString(alias)) return undefined
    const route = deps.resolveAlias(alias)
    if (route === undefined || route.protocol !== 'systemone') return undefined
    const provider = route.provider
    const model = route.model
    if (!isNonEmptyString(provider) || !isNonEmptyString(model)) return undefined
    const lookup = lookupRoutePin(alias, routes, deps.warn)
    const pin = lookup.status === 'absent'
      ? toDecisionRoutePin({}, model)
      : toDecisionRoutePin(lookup.row, model)
    if (pin === undefined) return undefined
    const connection = deps.connection(provider)
    if (connection === undefined || !isNonEmptyString(connection.baseURL)) return undefined
    return {
      provider,
      model,
      ...(pin.actualModelId !== undefined ? { actualModelId: pin.actualModelId } : {}),
      baseURL: connection.baseURL,
      ...(connection.apiKey !== undefined ? { apiKey: connection.apiKey } : {}),
      revision: pin.revision,
      perRequestTokens: pin.perRequestTokens,
      perQuestionTokens: pin.perQuestionTokens,
      maxOutputTokens: pin.maxOutputTokens,
      maxQuestions: pin.maxQuestions,
    }
  } catch {
    // Resolution is read-only over settings seams; any fault is `unconfigured`.
    return undefined
  }
}
