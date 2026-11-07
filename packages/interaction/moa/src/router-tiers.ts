/**
 * Pure tier-routing helpers split from router.ts (size gate).
 * @module
 */

import { ReasoningEffortId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelRoutes } from '@dsh-cc/model-aliases'
import { tierAt } from './tiers.ts'

/** The moa-local 4-way routing question (criteria ported from the P4 corpus probe). */
export const ROUTING_QUESTION = {
  type: 'choice',
  instructions: 'Classify the user request into the LOWEST capability tier that can fully handle it.',
  criteria: {
    sketch: 'trivial: typo fixes, one-line edits, simple factual questions, renames, single-command explanations',
    draft: 'moderate: single-function utilities, small localized feature edits, explaining short code snippets',
    blueprint: 'complex: multi-file or multi-module design, architecture proposals, root-cause analysis of subtle bugs, phased refactors',
    masterplan:
      'very hard or ambiguous: cross-cutting strategy, long-horizon multi-team planning, organization-scale tradeoff decisions, platform migrations',
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
