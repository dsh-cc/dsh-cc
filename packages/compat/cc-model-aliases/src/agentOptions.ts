/**
 * Convert a resolved alias route into spawn `agentOptions` (`toAgentOptions`)
 * or a complete `{provider, model}` pair for an independent one-shot stream
 * (`toOneShotRoute`). Spawn drops `undefined` fields so per-field inheritance
 * survives; one-shots fill missing fields from a parent route and return
 * `undefined` when the pair is still incomplete.
 *
 * @module @dsh-cc/model-aliases/agentOptions
 */

import type { ResolvedRoute } from './types.ts'

/**
 * Drop `undefined` fields from a resolved route so per-field inheritance
 * survives (never set a field to `undefined` on the child request).
 * `undefined` in → `undefined` out; an all-`undefined` route → `undefined`.
 * @param route - the resolved route (or `undefined` for no override).
 * @returns the `agentOptions` record, or `undefined` for no override.
 */
export function toAgentOptions(route: ResolvedRoute | undefined): Record<string, string> | undefined {
  if (route === undefined) return undefined
  const out: Record<string, string> = {}
  if (route.provider !== undefined) out['provider'] = route.provider
  if (route.model !== undefined) out['model'] = route.model
  if (route.reasoningEffort !== undefined) out['reasoningEffort'] = route.reasoningEffort
  if (Object.keys(out).length === 0) return undefined
  return out
}

export interface OneShotParentRoute {
  readonly provider?: string
  readonly model?: string
}

/**
 * Fill a resolved alias into a complete `{provider, model}` pair for an
 * independent `ctx.llm.stream` one-shot. Alias fields win; missing fields
 * inherit from `parent`. Returns undefined when the resulting pair is
 * incomplete (no model after inherit) — callers treat that as "unconfigured".
 */
export function toOneShotRoute(
  route: ResolvedRoute | undefined,
  parent?: OneShotParentRoute,
): { provider: string; model: string } | undefined {
  if (route === undefined) return undefined
  const provider = route.provider ?? parent?.provider
  const model = route.model ?? parent?.model
  if (provider === undefined || model === undefined) return undefined
  if (provider.length === 0 || model.length === 0) return undefined
  return { provider, model }
}
