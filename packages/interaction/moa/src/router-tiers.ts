/**
 * Pure tier-routing helpers split from router.ts (size gate).
 * @module
 */

import { ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelRoutes } from '@dsh-cc/model-aliases'
import { tierAt } from './tiers.ts'

/**
 * Criteria revision, emitted on every route row (`RouteRowFields.criteriaRevision`)
 * so production traffic can be sliced across a criteria change. The legacy
 * classifier has no decision identity at all (it calls `systemoneDecide`
 * directly, never the DecisionRunner whose input hash carries a question
 * version), so without this an armed deployment could not tell pre-change rows
 * from post-change ones. Bump it whenever the criteria text changes.
 */
export const ROUTING_CRITERIA_REVISION = 'routing-criteria-v2'

/**
 * The moa-local 4-way routing question (criteria ported from the P4 corpus
 * probe). Domain-neutral: the complexity axis is stated in both coding and
 * data-analysis terms so a non-coding request is not classified by analogy
 * alone. The draft/blueprint fence is load-bearing — a draft exemplar must not
 * capture multi-source work, or a single reconciliation query would read as a
 * one-step aggregation.
 */
export const ROUTING_QUESTION = {
  type: 'choice',
  instructions: 'Classify the user request into the LOWEST capability tier that can fully handle it.',
  criteria: {
    sketch: 'trivial: typo fixes, one-line edits, simple factual questions, renames, single-command explanations, a single lookup or simple filter of one known table or metric',
    draft: 'moderate: single-function utilities, small localized feature edits, explaining short code snippets, one-step aggregation or summary over one table, a single SQL query over one table',
    blueprint: 'complex: multi-file or multi-module design, architecture proposals, root-cause analysis of subtle bugs, phased refactors, multi-source reconciliation, metric-caliber disputes, attribution analysis, a single query that joins or spans several sources',
    masterplan:
      'very hard or ambiguous: cross-cutting strategy, long-horizon multi-team planning, organization-scale tradeoff decisions, platform migrations, redesigning a metrics system across organizations',
  },
} as const

/** Plain-text projection of a message's text blocks. */
export function textOf(message: UserMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * The SHARED PURE pair helper (effective-model-truth §5.3): the tier's
 * provider/model from the resolved route — synchronous, no cache access, no
 * notice queueing. Consumed by the admission tier-`ModelSelection`
 * computation AND the resume rehydration's implied-pair resolution, so the
 * wire and the sidecar agree on every tier's pair.
 */
export function tierRouteVariables(
  tier: number,
  routes?: ModelRoutes | undefined,
): { provider: string; model: string } | undefined {
  const alias = tierAt(tier)
  const route = alias === undefined ? undefined : routes?.resolve(alias)
  if (route === undefined || route.provider === undefined || route.model === undefined) return undefined
  return { provider: route.provider as string, model: route.model as string }
}

/**
 * The tier ModelSelection computation with effort re-validation (the old
 * withTier effort half, D3.2): a carried effort the tier model supports is
 * kept; an unsupported (or unresolvable) one degrades exactly like
 * applyModelSwitch (driver-pickers.ts): bare pair + notice, warn-once per
 * (provider, model, effort).
 */
export function createEffortSelector(deps: {
  tierRoutePair: (tier: number) => { provider: string; model: string } | undefined
  resolveEfforts?: (provider: string, model: string, signal: AbortSignal) => Promise<readonly string[] | undefined> | undefined
  queueMoaRow: (row: string, ...rest: never[]) => void
}): (tier: number, carriedEffort: string | undefined, signal: AbortSignal) => Promise<{ provider: string; model: string; reasoningEffort?: ReasoningEffortId } | undefined> {
  const effortCache = new Map<string, readonly string[] | undefined>()
  const effortWarned = new Set<string>()
  return async (tier, carriedEffort, signal) => {
    const pair = deps.tierRoutePair(tier)
    if (pair === undefined) return undefined
    if (typeof carriedEffort !== 'string' || carriedEffort.length === 0) {
      return pair
    }
    const key = `${pair.provider}\u0000${pair.model}`
    let efforts = effortCache.get(key)
    if (efforts === undefined && !effortCache.has(key)) {
      efforts = await deps.resolveEfforts?.(pair.provider, pair.model, signal)?.catch(() => undefined)
      effortCache.set(key, efforts)
    }
    if (efforts !== undefined && efforts.includes(carriedEffort)) {
      return { ...pair, reasoningEffort: ReasoningEffortId(carriedEffort) }
    }
    const warnKey = `${pair.provider}\u0000${pair.model}\u0000${carriedEffort}`
    if (!effortWarned.has(warnKey)) {
      effortWarned.add(warnKey)
      deps.queueMoaRow(`Effort "${carriedEffort}" not supported by ${pair.model}; reset to default.`)
    }
    return pair
  }
}
