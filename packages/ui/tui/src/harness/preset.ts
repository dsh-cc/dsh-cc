/**
 * Compose an unpublished agent from the CC preset. Call from `agents.create`
 * / `resume` `setup` so a failed mount rolls the whole creation back.
 *
 * Resolution (VWA design doc §3.3): a single `resolvePresetId` shared by the
 * create and resume closures.
 *  - fresh create → `vwa-preset.selectedDefault` (this repo's persisted
 *    selection) → `config.agentPreset` (deployment default) → `'cc'`
 *  - resume → the session projection's `agentPreset` state → the same
 *    fresh-create chain (legacy transcripts carry no recorded preset)
 *
 * `stateOf` is only callable inside setup AFTER the transcript persistence
 * load completes (agent-preset-registry session.ts precedent), so the
 * resume-side read runs in the agent's setup, before mount.
 * @module @dsh-cc/tui/harness/preset
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentSetup } from '@deepseek-ai/dsh-agent'
import { readUserSection } from '@dsh-cc/settings-ns'

const DEFAULT_PRESET = 'cc'

/** The settings namespace carrying the persisted default agent preset. */
export const VWA_PRESET_NAMESPACE = 'vwa-preset'

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
 * Read the persisted `vwa-preset.selectedDefault` through the user's raw
 * settings section (`settings.describe()` -> user layer), NOT the registered
 * namespace's resolved value. A registration-dependent read is structurally
 * wrong for this boot path: the host-side settings provider may not even
 * have the namespace registered (the /preset command registers from inside
 * its preset scope, which re-composes a scope-local provider copy), so the
 * host read stays blind exactly when it matters (acceptance S2). The raw
 * user section is where `/preset`'s settings-provider update lands, and no
 * composition-layer default for this namespace exists, so a user-layer read
 * covers the full persisted surface (same seam permission-rules uses for
 * `llm-pi-ai`, gauge-backend.ts).
 */
export function readSelectedDefault(ctx: Context): string | undefined {
  const settings = ctx.get('settings') as { describe?: () => unknown } | undefined
  const section = readUserSection(settings as never, VWA_PRESET_NAMESPACE)
  const value = section?.selectedDefault
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The session-projection face `resolvePresetId`'s resume leg reads. */
type SessionProjectionsLike = {
  stateOf(session: unknown, key: string): unknown
}

/**
 * The recorded preset of a (loaded) session, read through the session
 * projection. Only legal inside setup after the transcript persistence load;
 * `null` when no projection service is composed or the transcript is legacy.
 */
export function recordedPresetOf(agentCtx: Context, session: unknown): string | null {
  const projections = agentCtx.get('sessionProjections') as SessionProjectionsLike | undefined
  if (projections === undefined) return null
  const state = projections.stateOf(session, 'agentPreset')
  return typeof state === 'string' ? state : null
}

/** Inputs of the shared preset-id resolution chain. */
export interface PresetIdSource {
  /** Resume only: the session projection's recorded preset (null = legacy). */
  readonly recorded?: string | null
  /** The persisted default (`vwa-preset.selectedDefault`). */
  readonly selectedDefault?: string | undefined
  /** The deployment default (`config.agentPreset`). */
  readonly configPreset?: string | undefined
}

/**
 * The shared resolution chain (doc §3.3): a recorded preset wins (resume);
 * then the persisted selection, the deployment default, and finally `'cc'`.
 * Create and resume closures both call this — there is exactly one chain.
 */
export function resolvePresetId(source: PresetIdSource): string {
  return source.recorded ?? source.selectedDefault ?? source.configPreset ?? DEFAULT_PRESET
}

/**
 * Whether a mount failure names a preset that no longer exists
 * (`agent-preset/not-found`). Duck-typed: the registry raises a RemoteError
 * carrying `code`, and composePreset rewraps the message verbatim.
 */
export function isPresetNotFound(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'agent-preset/not-found'
    || (error instanceof Error && error.message.includes('agent-preset/not-found'))
}

/** The driver-facing deps of the bound resolution (all driver-owned seams). */
export interface PresetResolutionDeps {
  /** The deployment default (`config.agentPreset`). */
  readonly configPreset?: string | undefined
  /** The notice channel for the not-found remount report. */
  readonly showNotice: (text: string) => void
  /** Runs after a successful mount (model-selection install). */
  readonly afterMount?: (agentCtx: Context) => void
}

/** The loud report when a resumed session's recorded preset no longer exists. */
export const RESUME_PRESET_NOT_FOUND_NOTICE = (recorded: string, fallback: string): string =>
  `Recorded agent preset "${recorded}" no longer exists; this session remounted "${fallback}" (re-select with /preset)`

/**
 * Bind the shared resolution to a driver instance. Returns the fresh-create
 * id reader and the create/resume setup closure. Fresh-create resolution
 * happens per create call (hot activation of a `/preset` write); the resume
 * id resolves inside setup, where `stateOf` is legal after the transcript
 * persistence load (registry session.ts precedent). The composition is
 * recomposed only when the resolved id differs from the cached id.
 */
/** Bounded wait for the host settings provider during boot (ms). */
export const SETTINGS_BOOT_WINDOW_MS = 5_000



/**
 * Bind the shared resolution to a driver instance. Returns the fresh-create
 * id reader and the split create/resume setup closures. Fresh-create
 * resolution happens per create call (hot activation of a `/preset` write);
 * the resume id resolves inside setup, where `stateOf` is legal after the
 * transcript persistence load (registry session.ts precedent). The
 * composition is recomposed only when the resolved id differs from the
 * cached id.
 */
export async function bindPresetResolution(
  ctx: Context,
  deps: PresetResolutionDeps,
): Promise<{ freshPresetId(): string; setupForCreate: AgentSetup; setupForResume: AgentSetup }> {
  // NO host-plane namespace registration is attempted here: the driver only
  // READS the persisted default, and the read above goes through the raw
  // user section (registration-independent). The namespace's registrar stays
  // with the /preset command, whose settings-provider write is the only path
  // that requires a registered namespace.
  const freshPresetId = (): string =>
    resolvePresetId({ selectedDefault: readSelectedDefault(ctx), configPreset: deps.configPreset })
  let composition = await composePreset(ctx, freshPresetId())
  const composeFor = async (id: string): Promise<PresetComposition> => {
    if (composition.agentPreset === id) return composition
    composition = await composePreset(ctx, id)
    return composition
  }
  const mount = async (id: string, agentCtx: Context, agent: Parameters<AgentSetup>[1]): Promise<void> => {
    const presetSetup = (await composeFor(id)).setup
    if (presetSetup !== undefined) await presetSetup(agentCtx, agent)
  }
  const setupForCreate: AgentSetup = async (agentCtx, agent) => {
    // Chain pin: a FRESH create never reads the recorded projection — the
    // agentPreset projection seeds from the creation header, which
    // createArgs just wrote from freshPresetId() itself; reading it back
    // here would be self-referential (acceptance S2: an early-read 'cc'
    // header claimed the session even though the persisted default was vwa).
    // The header read itself can still land before settings settle (the boot
    // mount sweep race); when the setup-time resolution disagrees with the
    // header, write the honest switch record so projection consumers never
    // learn "created under cc but ran vwa".
    const id = resolvePresetId({ selectedDefault: readSelectedDefault(ctx), configPreset: deps.configPreset })
    await mount(id, agentCtx, agent)
    const session = (agent as { session?: { append?: (type: string, data: unknown) => unknown } }).session
    const seeded = recordedPresetOf(agentCtx, session)
    if (seeded !== null && seeded !== id && typeof session?.append === 'function') {
      try {
        session.append('agent-preset/selected', { agentPreset: id })
      } catch (error) {
        ctx.logger?.warn?.(`preset record write failed; transcript may carry a stale header preset: ${String(error)}`)
      }
    }
    deps.afterMount?.(agentCtx)
  }
  const setupForResume: AgentSetup = async (agentCtx, agent) => {
    const id = resolvePresetId({
      recorded: recordedPresetOf(agentCtx, agent.session),
      selectedDefault: readSelectedDefault(ctx),
      configPreset: deps.configPreset,
    })
    try {
      await mount(id, agentCtx, agent)
    } catch (error) {
      if (!isPresetNotFound(error)) throw error
      // RESUME-GAP FIX (doc §3.3): the recorded preset is missing/invalid
      // (agent-preset/not-found). Keep the resume target — the caller's
      // handleResumeFailure (fresh-session fallback) never runs for this
      // class — remount down the default chain, and report loudly.
      const fallback = freshPresetId()
      if (fallback === id) throw error
      deps.showNotice(RESUME_PRESET_NOT_FOUND_NOTICE(id, fallback))
      await mount(fallback, agentCtx, agent)
    }
    deps.afterMount?.(agentCtx)
  }
  return { freshPresetId, setupForCreate, setupForResume }
}

/**
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
