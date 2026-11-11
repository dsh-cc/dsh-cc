// CC-only module (issue #380), no upstream counterpart — see DIVERGENCE.md.
// Size-budget extraction from index.ts (the `src/lifecycle.ts` pattern):
// the per-use preset-roster resolver and the session-admission settlement
// gate that together replaced the apply-time roster capture.
import type { Context } from '@deepseek-ai/cordis'
import type { RequestError } from '@agentclientprotocol/sdk'
import type { AcpPresetsService } from './session.ts'

/**
 * Build the per-use roster resolver for the agent-preset registry.
 *
 * The registry is a LOADER GROUP SIBLING of this plugin: `EntryGroup.update`
 * mounts the profile's rows concurrently (`Promise.all`), and strict
 * `ctx.get` reads a LOADING sibling as `undefined` — an eager apply-time read
 * raced the registry's async `Service.init` and killed the whole ACP lane
 * whenever it lost (issue #380). Resolving per use — behind the admission
 * gate from {@link settleComposition} — observes the registry's final state
 * and survives a registry restart without re-applying this plugin.
 *
 * The service is deliberately NOT inject-declared: inject couples this
 * plugin's fiber lifecycle to the registry's, and a registry restart would
 * re-apply us and drop every live ACP session.
 * @param ctx - Plugin context whose scope reads the roster service.
 * @param internalError - Wrapper preserving the diagnostic on the wire
 * (plain `Error`s are masked by the SDK's generic internal error).
 * @returns A resolver throwing a wire-preserving error when the registry is
 * absent — a mis-composed profile fails its first session admission loudly.
 */
export function presetRosterResolver(
  ctx: Context,
  internalError: (detail: string) => RequestError,
): () => AcpPresetsService {
  return () => {
    const roster = ctx.get('agentPresets')
    if (roster === undefined) {
      throw internalError(
        'acp-cc requires an agent-preset registry in the composition (the cc-acp profile provides it via @dsh-cc/bundle-acp row B)',
      )
    }
    return roster
  }
}

/**
 * Wait for the loader tree to settle before admitting a session.
 *
 * `app.connect` runs at the end of `apply` while `boot()` is still inside
 * `loader.await()`, so an early `initialize` round trip does not prove tree
 * settlement — a client can race its first `session/new` past a LOADING
 * registry. Awaiting the loader here uses the same settlement primitive
 * `boot()` itself uses, with no new timeout budget. Absent in the in-process
 * test rig (no loader service) the gate is a no-op.
 * @param ctx - Plugin context whose scope reads the loader service.
 * @returns A function that settles before a session admission proceeds.
 */
export function settleComposition(ctx: Context): () => Promise<void> {
  return async () => {
    const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
    if (loader !== undefined) await loader.await()
  }
}
