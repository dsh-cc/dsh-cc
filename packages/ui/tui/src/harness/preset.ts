/**
 * Compose an unpublished agent from the CC preset. Call from `agents.create`
 * / `resume` `setup` so a failed mount rolls the whole creation back.
 * @module @dsh-cc/tui/harness/preset
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'

const DEFAULT_PRESET = 'cc'

/** Structural face of `ctx.agentPresets` used by the TUI. */
export interface AgentPresetsLike {
  readonly defaultId: string
  resolve(id?: string): Promise<{ id: string; broken?: string }>
  mount(agentCtx: Context, id?: string): Promise<{ id: string }>
}

/** Creation inputs for `agents.create` / `resume`. */
export interface PresetComposition {
  readonly agentPreset?: string
  readonly setup?: AgentSetup
}

/** Optional-service access — a rosterless boot composes nothing. */
export function rosterOf(ctx: Context): AgentPresetsLike | undefined {
  return ctx.get('agentPresets') as AgentPresetsLike | undefined
}

/**
 * Resolve the preset a new/resumed session will run under. Missing roster
 * or unknown id throws — the TUI must not silently fall back to the host
 * plane (that would leak tools and skip CC commands).
 */
export async function composePreset(
  ctx: Context,
  requested: string = DEFAULT_PRESET,
): Promise<PresetComposition> {
  const presets = rosterOf(ctx)
  if (presets === undefined) {
    throw new Error(
      `dsh-cc-tui: agent preset roster is not mounted; cannot start CC mode. `
        + `Boot with dsh --profile tui (or run dsh-cc) so @dsh-cc/bundle-tui is composed.`,
    )
  }
  const resolved = await presets.resolve(requested)
  if (resolved.broken !== undefined) {
    throw new Error(
      `dsh-cc-tui: agent preset "${resolved.id}" cannot compose a session (${resolved.broken}). `
        + `Re-install the CC preset (dsh-cc, or bash scripts/sync-cc-preset.sh).`,
    )
  }
  return {
    agentPreset: resolved.id,
    setup: async (agentCtx: Context) => {
      await presets.mount(agentCtx, resolved.id)
    },
  }
}
