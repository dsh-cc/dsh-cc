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
 * Known staleness (accepted): disabling moa emits no event, so the ref holds
 * its last value until a rebind or a model-selection change clears it.
 * @module @dsh-cc/tui/harness/statusline-moa
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { TIER_ALIASES } from '@dsh-cc/moa'

/** Shared mutable moa-tier store (written by the tap, read by both statuslines). */
export type MoaTierRef = { value: string | undefined }

/**
 * Subscribe the session/event tap (same pattern as the transcript mirror in
 * statusline-wiring.ts, same session-id guard) and keep `ref` pointing at the
 * latest routed tier alias. `onChange` fires once per actual value change so
 * the caller can trigger a re-render. Returns the unsubscribe handle.
 */
export function subscribeMoaTier(
  ctx: Context,
  current: { agent: Agent },
  ref: MoaTierRef,
  onChange: () => void,
): () => void {
  return ctx.on('session/event', (session, event) => {
    // Guard against late events from a disposed/rebound session.
    if (String((session as { id?: unknown })?.id) !== String(current.agent.session.id)) return
    const e = event as { type?: unknown; data?: { source?: { kind?: unknown; tier?: unknown } } }
    if (e?.type !== 'user/message') return
    const source = e.data?.source
    if (source?.kind !== 'moa') return
    const tier = source.tier
    if (typeof tier !== 'number' || !Number.isInteger(tier)) return
    const alias = TIER_ALIASES[tier]
    if (alias === undefined || ref.value === alias) return
    ref.value = alias
    onChange()
  })
}
