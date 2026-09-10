/**
 * Settings namespace registration for the `cc-handoff` overlay.
 * CCR settings.ts pattern: the namespace is registered once at mount; the
 * live scope is re-read on EVERY put so a settings write applies immediately.
 * @module @dsh-cc/handoff-store/settings
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsProvider } from '@deepseek-ai/dsh-settings'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { HandoffConfig } from './types.ts'

/** The settings namespace carrying the live handoff overlay. */
export const SETTINGS_NAMESPACE = 'cc-handoff' as SettingsNamespace

/** Defaults, also the documented advisory contract. */
export const DEFAULTS = deepFreeze({
  enabled: true,
  thresholdChars: 8192,
})

/** Settings namespace schema. */
export const SettingsSchema: z<HandoffConfig> = z.object({
  enabled: z.boolean(),
  'threshold-chars': z.number().step(1).min(1),
})

/**
 * Register the settings namespace and return a per-use reader. Graceful
 * without a settings provider: the reader resolves `undefined` and callers
 * fall back to {@link DEFAULTS}.
 * @param ctx - the plug context.
 * @returns the live scope reader.
 */
export function registerSettings(ctx: Context): () => HandoffConfig | undefined {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  const scope = settings?.register(SETTINGS_NAMESPACE, SettingsSchema)
  return () => scope?.get?.() as HandoffConfig | undefined
}

/** Effective configuration for one use: defaults overlaid by the live scope. */
export function resolveHandoffConfig(scope: HandoffConfig | undefined): {
  enabled: boolean
  thresholdChars: number
} {
  return {
    enabled: scope?.enabled ?? DEFAULTS.enabled,
    thresholdChars: scope?.['threshold-chars'] ?? DEFAULTS.thresholdChars,
  }
}
