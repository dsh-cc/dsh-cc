/**
 * Moa routing-tier tap for the statusline (feature: `moa:<alias>` segment +
 * `moa: {tier}` payload field). Subscribes the shared `session/event` tap and
 * mirrors the CURRENT session's latest moa routing tier (from a `user/message`
 * notice with `source.kind === 'moa'`) into a mutable ref the built-in
 * statusline (driver-hud) and the custom payload (statusline-wiring) both read.
 * The free-form `summary` is never parsed — only the numeric `tier` index is
 * trusted, resolved through moa's TIER_ALIASES. Honest absence: moa off or no
 * route yet → the ref stays undefined and both surfaces omit the field.
 *
 * Effective pair (effective-model-truth §5.4): a moa notice may also carry the
 * effective model id (`source.model`) the overlay resolves to; the ref keeps
 * both and `renderMoaTier` renders `<model-id> ◂ <tier-alias>`, falling back
 * to the plain tier alias when no model is known.
 *
 * Inactive transition: a TRUE switch-away `user/message` notice with
 * `source.kind === 'model-selection'` (the sanitizer keeps only the true ones)
 * clears the ref — moa's disarm itself emits no moa event. The wiring's
 * selection emit-diff (model change → clear) is the primary rule; this
 * subscription is the consistency backstop for switch-away notices.
 *
 * Known staleness (accepted): disabling moa emits no event, so the ref holds
 * its last value until a rebind or a model-selection change clears it.
 *
 * Unarmed state (scope-aware-listeners §4): an enabled-but-unarmed moa (routes
 * unavailable, degenerate ladder, judge-route failure) is invisible otherwise —
 * the only signal was a TUI-invisible stderr warn. The tap therefore also
 * carries `unarmed` — the reason re-read from moa's shared arming validation
 * (`moaUnarmedReason`) on every event, rendered as `unarmed — <reason>` and
 * carried in the payload as `moa: {unarmed}`. It clears when an armed notice
 * arrives or arming succeeds, and is NEVER set for `moa disabled`.
 * @module @dsh-cc/tui/harness/statusline-moa
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TIER_ALIASES, moaUnarmedReason } from '@dsh-cc/moa'

/**
 * Moa value the ref carries: an armed tier alias (+ optional effective model
 * id), or — when moa is enabled but not armed — the reason it refused to arm.
 * The two states are exclusive: an unarmed write replaces the tier.
 */
export interface MoaTierValue {
  tier?: string
  model?: string
  unarmed?: string
}

/** Shared mutable moa-tier store (written by the tap, read by both statuslines). */
export type MoaTierRef = { value: MoaTierValue | undefined }

/**
 * The built-in segment text for a ref value: `<model-id> ◂ <tier-alias>` when
 * the effective model is known, the plain tier alias otherwise; `unarmed —
 * <reason>` while moa is enabled but cannot arm; undefined for an unset ref
 * (the segment is omitted).
 */
export function renderMoaTier(value: MoaTierValue | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.unarmed !== undefined) return `unarmed — ${value.unarmed}`
  if (value.tier === undefined) return undefined
  return value.model === undefined ? value.tier : `${value.model} ◂ ${value.tier}`
}

/** Same fields? (tier + model + unarmed) — used to skip no-op ref writes. */
function sameValue(a: MoaTierValue | undefined, b: MoaTierValue | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.tier === b.tier && a.model === b.model && a.unarmed === b.unarmed
}

/**
 * Subscribe the session/event tap (same pattern as the transcript mirror in
 * statusline-wiring.ts, same session-id guard) and keep `ref` pointing at the
 * latest routed tier (alias + optional effective model) — or, while moa is
 * enabled but unarmed, at the reason arming refused (§4). `onChange` fires once
 * per actual value change so the caller can trigger a re-render. Returns the
 * unsubscribe handle.
 */
export function subscribeMoaTier(
  ctx: Context,
  current: { agent: Agent },
  ref: MoaTierRef,
  onChange: () => void,
): () => void {
  const write = (next: MoaTierValue | undefined): void => {
    if (sameValue(ref.value, next)) return
    ref.value = next
    onChange()
  }
  return ctx.on('session/event', (session, event) => {
    // Guard against late events from a disposed/rebound session.
    if (String((session as { id?: unknown })?.id) !== String(current.agent.session.id)) return
    const e = event as { type?: unknown; data?: { source?: { kind?: unknown; tier?: unknown; model?: unknown } } }
    if (e?.type === 'user/message') {
      const source = e.data?.source
      // Switch-away transition: the sanitizer keeps only TRUE model-selection
      // notices, so one of these means moa (if it was overlaying) is no longer
      // serving the boot selection — clear the stale tier (§5.4 "otherwise").
      if (source?.kind === 'model-selection') {
        write(undefined)
      } else if (source?.kind === 'moa') {
        const tier = source.tier
        if (typeof tier === 'number' && Number.isInteger(tier)) {
          const alias = TIER_ALIASES[tier]
          if (alias !== undefined) {
            const model = typeof source.model === 'string' && source.model.length > 0 ? source.model : undefined
            write({ tier: alias, ...(model === undefined ? {} : { model }) })
          }
        }
      }
    }
    // Unarmed visibility (§4): the shared arming validation changes without
    // emitting any session event, so the reason is re-read on every event this
    // tap sees (no new event type — the poisons-reopen red line). An armed
    // notice above has already replaced it; arming success clears it here.
    const unarmed = moaUnarmedReason()
    if (unarmed !== undefined) write({ unarmed })
    else if (ref.value?.unarmed !== undefined) write(undefined)
  })
}
