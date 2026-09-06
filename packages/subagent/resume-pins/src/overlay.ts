/**
 * Request-time overlay (plan §4.8): apply one pin's pinned runtime tuple onto
 * a resolved request config AFTER the waterfall's `next()`, with explicit
 * presence semantics — a pinned non-`null` field is SET, a pinned `null`
 * field's key is REMOVED (assigning `null` is not absence: `prepareCall`
 * would keep filling its adapter default), and a degraded pin touches only
 * explicitly-present fields.
 *
 * Pure: no cordis, no IO. The `agent/request` listener calls this per turn of
 * a pinned child, so options cannot revert to current defaults on any resume
 * path, including ones that bypass the gate.
 *
 * @module @dsh-cc/subagent-resume-pins/overlay
 */

import type { OverlayTuple, ResumePin } from './pin.ts'

/** Thrown when a request is built for a blocked child (defense-in-depth). */
export class PinBlockedError extends Error {
  constructor(reason: string) {
    super(`resume pin blocked: ${reason}`)
    this.name = 'PinBlockedError'
  }
}

/**
 * Apply one tuple with presence semantics onto a shallow copy of `resolved`.
 * @param resolved - the config produced by the `agent/request` waterfall.
 * @param tuple - the pinned (or gate-evaluated route-current) tuple.
 */
function applyTuple<T extends Record<string, unknown>>(resolved: T, tuple: OverlayTuple): T {
  const out: Record<string, unknown> = { ...resolved }
  for (const [key, value] of Object.entries(tuple)) {
    if (value === null) delete out[key]
    else out[key] = value
  }
  return out as T
}

/** The pinned tuple a complete pin contributes (its `effective`, verbatim). */
function pinnedTuple(pin: ResumePin): OverlayTuple {
  return {
    provider: pin.effective.provider,
    model: pin.effective.model,
    reasoningEffort: pin.effective.reasoningEffort,
    maxTokens: pin.effective.maxTokens,
  }
}

/**
 * Overlay the pin onto one resolved request config.
 * - `resume.state === 'blocked'` → throws {@link PinBlockedError}: an
 *   unmonitored resume of a blocked child fails visibly instead of silently
 *   substituting.
 * - `resume.overlay` present (gate-evaluated route-current) → applied with
 *   the same presence semantics; it is a cache recomputed on every gate
 *   evaluation, never authoritative on its own.
 * - Complete pin → the whole pinned tuple, absence included (a pinned-`null`
 *   key is removed, not nulled).
 * - Degraded pin (`complete:false`) → only explicitly-present pinned fields.
 * @param resolved - the resolved request config.
 * @param pin - the child's pin.
 * @returns a shallow copy carrying the pin (input untouched — the seed may be
 *   frozen), or the input object when the pin contributes nothing.
 */
export function applyPinOverlay<T extends Record<string, unknown>>(resolved: T, pin: ResumePin): T {
  if (pin.resume.state === 'blocked') {
    throw new PinBlockedError(pin.resume.reason ?? 'blocked by the resume gate')
  }
  if (pin.resume.overlay !== undefined) return applyTuple(resolved, pin.resume.overlay)
  if (pin.effective.complete) return applyTuple(resolved, pinnedTuple(pin))
  // Degraded: set only the fields the spawn explicitly carried.
  const out: Record<string, unknown> = { ...resolved }
  out['provider'] = pin.effective.provider
  out['model'] = pin.effective.model
  if (pin.effective.reasoningEffort !== null) out['reasoningEffort'] = pin.effective.reasoningEffort
  if (pin.effective.maxTokens !== null) out['maxTokens'] = pin.effective.maxTokens
  return out as T
}
