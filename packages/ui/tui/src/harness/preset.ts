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
 * throws — the TUI must not silently fall back to the host plane (that would
 * leak tools and skip CC commands).
 *
 * Harness 0.1.7-rc.2 (agent-preset registry): existence/brokenness is
 * enforced INSIDE the AgentSetup (`agentPresets.mount`), not here. The
 * registry's `resolve()`/`list()` run a diagnostic audit that can wait on
 * loader settlement, and its docstring is explicit: callers must not run
 * inside a Host row's own activation — the TUI row IS that activation
 * (self-deadlock observed: first frame never renders). A failed mount rolls
 * the whole session creation back (agents.create setup contract), so nothing
 * is lost by deferring the check.
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
  return {
    agentPreset: requested,
    setup: async (agentCtx: Context) => {
      try {
        await presets.mount(agentCtx, requested)
      } catch (error) {
        throw new Error(
          `dsh-cc-tui: agent preset "${requested}" cannot compose a session (${(error as Error).message}). `
            + `Re-install dsh-cc (npm install -g @dsh-cc/cli) so the bundled CC preset declaration ships intact.`,
        )
      }
    },
  }
}
