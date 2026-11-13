/**
 * Wiring-time boundary between the S1-12 reducer decision gate and S1-02's
 * decision runtime: the guarded dual-name host runner resolver, the session
 * watermark read, and the post-await route identity comparison.
 *
 * Structural mirror of `@dsh-cc/skill-recommender`'s `contract.ts` (deep
 * imports of another package's `src` are forbidden here, so the guarded
 * resolver shape is copied, not imported): resolution order is
 * `host.get('systemoneDecisions')` → `host.get('ccSystemoneDecisions')` (the
 * root-realm bridge the decision-usage plugin publishes for out-of-group
 * consumers) → property fallbacks; every step is individually guarded, and a
 * missing or wrong-shaped service means the gate is UNAVAILABLE — the
 * existing reducer continues unchanged.
 *
 * @module @dsh-cc/context-crusher/reducer-gate-contract
 */

import type { DecisionRunner, DecisionScope } from '@dsh-cc/systemone'

/**
 * The bound runner face the wiring layer consumes: S1-02's
 * `BoundDecisionRunner` (`ctx.systemoneDecisions.forAgent(agent)`), including
 * the `scope(originSeq)` producer.
 */
export type ReducerGateBoundRunner = Pick<DecisionRunner, 'identifyRoute' | 'run'> & {
  scope(originSeq?: number): DecisionScope
}

/** The host face the resolver reads (structurally the cordis context). */
export interface ReducerGateHostFace {
  readonly systemoneDecisions?: unknown
  readonly ccSystemoneDecisions?: unknown
  /** Optional guarded service getter (structurally cordis `ctx.get`). */
  get?(name: string): unknown
}

/** The service shape both names must carry to be usable. */
function isRunnerService(value: unknown): value is { forAgent(actor: object): ReducerGateBoundRunner } {
  return typeof value === 'object' && value !== null
    && typeof (value as { forAgent?: unknown }).forAgent === 'function'
}

/** The bound runner must answer all three calls to be usable at all. */
function isBoundRunner(value: unknown): value is ReducerGateBoundRunner {
  if (typeof value !== 'object' || value === null) return false
  const runner = value as { identifyRoute?: unknown; run?: unknown; scope?: unknown }
  return typeof runner.identifyRoute === 'function'
    && typeof runner.run === 'function'
    && typeof runner.scope === 'function'
}

/**
 * The default runner resolver: read the optional host decision service and
 * bind it to the calling actor. Never throws — any step that fails degrades
 * to the next one, and a service that refuses to bind is "unavailable", not
 * a failed tool call (the reducer continues on the original path).
 * @param host - the host context face.
 * @returns the per-actor resolver the wiring layer holds.
 */
export function hostGateRunnerResolver(
  host: ReducerGateHostFace,
): (actor: object) => ReducerGateBoundRunner | undefined {
  const viaGet = (name: string): { forAgent(actor: object): ReducerGateBoundRunner } | undefined => {
    try {
      const service = host.get?.(name)
      return isRunnerService(service) ? service : undefined
    } catch {
      return undefined
    }
  }
  return (actor) => {
    const service = viaGet('systemoneDecisions')
      ?? viaGet('ccSystemoneDecisions')
      ?? (isRunnerService(host.systemoneDecisions) ? host.systemoneDecisions : undefined)
      ?? (isRunnerService(host.ccSystemoneDecisions) ? host.ccSystemoneDecisions : undefined)
    if (service === undefined) return undefined
    try {
      const runner: unknown = service.forAgent(actor)
      return isBoundRunner(runner) ? runner : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * The persisted session watermark a judgment is anchored to:
 * `Number(agent.session.seq)` — the durable watermark, never `events.length`
 * (same read `@dsh-cc/skill-recommender` uses). A host without a usable
 * watermark yields `undefined`, which the wiring layer reports as an
 * incomplete identity (attempt on the original path) instead of inventing a
 * shared unknown key.
 * @param actor - the calling agent, structurally.
 * @returns the watermark, or `undefined` when the host exposes none.
 */
export function sessionWatermarkOf(actor: object): number | undefined {
  try {
    const session = (actor as { readonly session?: { readonly seq?: unknown } | undefined }).session
    const seq = Number(session?.seq)
    return Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
  } catch {
    return undefined
  }
}

/**
 * Full post-await route identity comparison (S1-12 § "Routing, cache and
 * lifecycle"): provider, model, revision, perRequestTokens,
 * perQuestionTokens and maxOutputTokens must ALL agree; any change drops the
 * answers gathered under the old identity.
 */
export function sameGateRouteIdentity(
  left: { provider: string; model: string; revision: string; perRequestTokens: number; perQuestionTokens: number; maxOutputTokens: number },
  right: { provider: string; model: string; revision: string; perRequestTokens: number; perQuestionTokens: number; maxOutputTokens: number },
): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.revision === right.revision
    && left.perRequestTokens === right.perRequestTokens
    && left.perQuestionTokens === right.perQuestionTokens
    && left.maxOutputTokens === right.maxOutputTokens
}
