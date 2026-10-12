/**
 * Shared moa runtime state (effective-model-truth design §5.1/§5.2).
 *
 * Side-effect-free module: importing it NEVER pulls the plugin `apply()`
 * path — `@dsh-cc/moa/sanitizer` (sanitizer.ts) imports this module, and the
 * subpath export's import graph must stay free of the plugin mount. The
 * plugin `apply()` (index.ts) populates `arming`/`validation` via
 * `setRuntimeCore`; every accessor below degrades to an inert value (false /
 * undefined / no-op) while the plugin is absent, never throwing.
 *
 * DELIBERATE ASYMMETRY — do not "fix": the published per-step selection is
 * PER-AGENT (each agent's frozen `selection.assembled` snapshot is its own),
 * while the boot pair is PROCESS-GLOBAL first-wins (the arming machine's and
 * the sanitizer's shared baseline is the session's boot selection, one per
 * process). Different lifecycles, different keys (design §3/§5.1/§5.2).
 *
 * @module
 */

import { ArmingMachine, type RequestPair } from './arming.ts'

export type { RequestPair }

/** Minimal structural shape of the shared arming validation ref. */
export interface RuntimeValidation {
  ok: boolean
  reason?: string
}

let arming: ArmingMachine | undefined
let validation: RuntimeValidation | undefined
const publishedSelection = new WeakMap<object, RequestPair>()

/** Populate the live plugin core (called by `apply()` in index.ts). */
export function setRuntimeCore(parts: { arming: ArmingMachine; validation: RuntimeValidation }): void {
  arming = parts.arming
  validation = parts.validation
}

/** Drop the live plugin core (test seam / hot reload). */
export function resetRuntimeCore(): void {
  arming = undefined
  validation = undefined
}

/** First non-undefined pair wins, never overwritten (design §5.2 part 1). */
export function noteBootPair(pair: RequestPair | undefined): void {
  arming?.noteBootPair(pair)
}

/** The shared boot pair, or undefined when the plugin is not applied. */
export function moaBootDefault(): RequestPair | undefined {
  return arming?.getBootDefaultModel()
}

/** `validation.ok && arming.isArmed()`; false (never throws) when not applied. */
export function moaOverlayActive(): boolean {
  return validation?.ok === true && (arming?.isArmed() ?? false)
}

/** Publish one agent's frozen per-step selection (the sanitizer's pre-step half). */
export function publishLiveSelection(agent: unknown, pair: RequestPair): void {
  if (agent !== null && typeof agent === 'object') publishedSelection.set(agent, pair)
}

/** Read a published per-step selection; undefined in sanitizer-less deployments. */
export function readPublishedSelection(agent: unknown): RequestPair | undefined {
  return agent !== null && typeof agent === 'object' ? publishedSelection.get(agent) : undefined
}

/**
 * The sanctioned observation path (design §5.2 contract): EVERY
 * `observeRequestModel` call MUST go through here — a direct call is a
 * contract violation (the machine's `bootDefault` can only be set via
 * `noteBootPair`, which this performs first). Unconditionally notes the boot
 * baseline, then observes (the machine no-ops itself while disabled).
 */
export function observeLiveSelection(pair: RequestPair | undefined): void {
  if (pair === undefined || pair.model === undefined) return
  noteBootPair(pair)
  arming?.observeRequestModel(pair)
}

/** Structural provider/model view of a resolved config / selection snapshot. */
export function pairOf(
  source: { provider?: unknown; model?: unknown } | undefined | null,
): RequestPair | undefined {
  if (source === undefined || source === null || source.model === undefined) return undefined
  return {
    ...(source.provider === undefined ? {} : { provider: source.provider as string }),
    model: source.model as string,
  }
}
