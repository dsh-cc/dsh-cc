/**
 * Structured progress state + post-compact context rebuild (design
 * docs/plans/2026-10-09-structured-progress-and-post-compact-rebuild.md):
 * derives a typed, per-session progress brief from already-recorded session
 * events (goal fold, todo snapshot, verified bash receipts, last user
 * message) and re-injects it into the first model request built after a
 * successful `compaction/end`.
 *
 * Slice B (derivation): registers the `progress-rebuild` Session projection
 * unit from state.ts. Slice C (delivery) lands here.
 * Ship-dark: `progress-rebuild.enabled` defaults to false.
 *
 * @module @dsh-cc/progress-rebuild
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerDelivery } from './delivery.ts'
import { DEFAULT_PROGRESS_REBUILD_SETTINGS, registerSettings } from './settings.ts'
import type { ProgressRebuildSettings } from './settings.ts'
import { progressRebuildProjection } from './state.ts'

export {
  SETTINGS_NAMESPACE,
  SettingsSchema,
  DEFAULT_PROGRESS_REBUILD_SETTINGS,
  registerSettings,
  type ProgressRebuildSettings,
} from './settings.ts'
export {
  PROGRESS_REBUILD_INJECTED_EVENT,
  appendProgressRebuildInjected,
  asInjectedEvent,
  type ProgressRebuildInjectedEventData,
} from './events.ts'
export {
  registerDelivery,
  countSections,
  PATH_STASH_CAPACITY,
  type DeliveryPath,
} from './delivery.ts'
export {
  renderBrief,
  renderGoalLine,
  applyBudget,
  truncateLine,
  STUB_MARKER_NOTE,
  NOT_VERIFIED_NOTE,
  BRIEF_HEADER,
  VERIFIED_HEADER,
  MAX_LINE_CHARS,
  BRIEF_MAX_BYTES,
  type RenderedBrief,
  type BriefOptions,
} from './brief.ts'
export {
  applyProgressRebuild,
  progressRebuildProjection,
  progressRebuildStateSchema,
  VERIFIED_RING_CAP,
  CALL_INDEX_CAP,
  FAILURE_MARKERS,
  type ProgressRebuildState,
  type VerifiedReceipt,
  type RecordedCall,
  type LastUserMessage,
} from './state.ts'

/** Cordis plugin id. */
export const name = 'progress-rebuild'

/** The projection registry this plugin registers its unit into (§3.1). */
export const inject = ['sessionProjections']

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Source kind of this package's injected post-compact rebuild brief. */
    'progress-rebuild': { kind: 'progress-rebuild' }
  }
}

/** Additive apply option (test seam). */
export interface ProgressRebuildPluginConfig {
  /** Test seam: inject a live settings reader instead of the namespace one. */
  readonly readSettings?: () => ProgressRebuildSettings
}

/**
 * Mount the plugin: register the settings namespace (for /config UX), the
 * `progress-rebuild` projection unit (slice B), and the delivery listeners
 * (slice C — Listener B, Listener C, the ACK observer; all gated on
 * `progress-rebuild.enabled`, ship-dark default false).
 * @param ctx - the plug context (declares `sessionProjections` via inject).
 * @param config - optional config seam (tests inject a settings reader).
 */
export function apply(ctx: Context, config: ProgressRebuildPluginConfig = {}): void {
  const namespaceReader = registerSettings(ctx)
  // inject: ['sessionProjections'] above; throw on absence (§3.1 explicit-fail).
  const projections = ctx.get('sessionProjections') as
    | { register(def: typeof progressRebuildProjection): unknown }
    | undefined
  if (projections === undefined) throw new Error('progress-rebuild requires the sessionProjections registry')
  projections.register(progressRebuildProjection)
  // Gate reader (§3.3 round-9): the injected test seam, else the namespace
  // reader, else ship-dark defaults (no settings provider → enabled false).
  const readSettings = config.readSettings
    ?? ((): ProgressRebuildSettings => {
      try {
        return namespaceReader?.() ?? DEFAULT_PROGRESS_REBUILD_SETTINGS
      } catch {
        return DEFAULT_PROGRESS_REBUILD_SETTINGS
      }
    })
  registerDelivery(ctx, readSettings)
}
