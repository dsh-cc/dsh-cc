/**
 * Pre-first-step pin application (harness-0.2.2 D3.5 — replaces the
 * request-time overlay, which was step-fatally rejected by `agent/request`'s
 * model-identity guard): the pinned provider/model/effort triple is selected
 * DURABLY via `agent.model.select(...)` at child publication (spawn AND cold
 * resume, before the first step's freeze), and `maxTokens` — a legal sampling
 * control on the waterfall — keeps its request-time presence overlay.
 *
 * Presence semantics are unchanged: a pinned non-`null` field is SET, a
 * pinned `null` field's key is REMOVED (assigning `null` is not absence), and
 * a degraded pin touches only explicitly-present fields.
 *
 * Pure: no cordis, no IO.
 *
 * @module @dsh-cc/subagent-resume-pins/overlay
 */

import type { ResumePin } from './pin.ts'

/**
 * Thrown when a resume is built for a blocked child. Since D3.5 the fail-closed
 * duty lives at the PRE-SPAWN GATE (the `tools/pre-execute` send_message gate
 * denies before any model call); the class stays exported for the gate tests
 * and defense-in-depth callers.
 */
export class PinBlockedError extends Error {
  constructor(reason: string) {
    super(`resume pin blocked: ${reason}`)
    this.name = 'PinBlockedError'
  }
}

/**
 * The pinned provider/model/effort triple for the pre-first-step durable
 * select (D3.5), with the gate-overlay precedence of the retired request-time
 * overlay: `resume.overlay` (gate-evaluated route-current cache) wins, then a
 * complete pin's tuple, then a degraded pin's explicitly-present fields.
 * Effort is omitted when absent (an omitted effort follows adapter defaults —
 * it is never null-pinned into a `ModelSelection`). Undefined when the pin is
 * blocked (the gate owns the visible failure) or no triple is available.
 */
export function pinnedSelectionOf(pin: ResumePin): { provider: string; model: string; reasoningEffort?: string } | undefined {
  if (pin.resume.state === 'blocked') return undefined
  if (pin.resume.overlay !== undefined) {
    const overlay = pin.resume.overlay
    return {
      provider: overlay.provider,
      model: overlay.model,
      ...(overlay.reasoningEffort === null ? {} : { reasoningEffort: overlay.reasoningEffort }),
    }
  }
  const out: { provider: string; model: string; reasoningEffort?: string } = {
    provider: pin.effective.provider,
    model: pin.effective.model,
  }
  if (pin.effective.reasoningEffort !== null) out.reasoningEffort = pin.effective.reasoningEffort
  return out
}

/**
 * Apply the pin's `maxTokens` onto one resolved request config (D3.5: the
 * ONLY surviving request-time field — a legal sampling control under
 * `agent/request`'s model-identity guard), with presence semantics: a pinned
 * non-`null` maxTokens is SET, a pinned `null` maxTokens of a COMPLETE pin is
 * REMOVED, a degraded pin sets it only when explicitly present, and a blocked
 * or corrupt-shape pin contributes nothing (the gate owns the failure mode).
 * Returns a shallow copy, or the input when the pin contributes nothing.
 * @param resolved - the config produced by the `agent/request` waterfall.
 * @param pin - the child's pin.
 */
export function applyPinnedMaxTokens<T extends Record<string, unknown>>(resolved: T, pin: ResumePin): T {
  if (pin.resume.state === 'blocked') return resolved
  const overlayMaxTokens = pin.resume.overlay?.maxTokens
  if (overlayMaxTokens !== undefined) {
    if (overlayMaxTokens === null) {
      const out = { ...resolved }
      delete out['maxTokens']
      return out
    }
    return { ...resolved, maxTokens: overlayMaxTokens }
  }
  if (pin.effective.maxTokens !== null) return { ...resolved, maxTokens: pin.effective.maxTokens }
  if (!pin.effective.complete) return resolved
  // Presence semantics for BOTH surviving sampling-adjacent fields: a pinned
  // null on a complete pin REMOVES an inner-middleware-injected key. For
  // `reasoningEffort` this is removal-back-to-the-frozen-selection (the
  // spawn-path durable select already recorded the pinned effort, so a
  // non-null pinned value set here equals the step's frozen selection and
  // passes the 0.2.2 model-identity guard; a junk-injected effort from an
  // inner listener is stripped before the guard compares).
  const out: Record<string, unknown> = { ...resolved }
  delete out['maxTokens']
  if (pin.effective.reasoningEffort !== null) {
    out['reasoningEffort'] = pin.effective.reasoningEffort
  } else {
    delete out['reasoningEffort']
  }
  return out as T
}
