/**
 * Settings namespace for the next-prompt suggestion feature.
 * Reasoning-fold settings.ts pattern: the namespace is registered once at
 * mount; the live scope is re-read on EVERY turn-stop so a settings write
 * applies immediately.
 * @module @dsh-cc/prompt-suggest/settings
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsProvider } from '@deepseek-ai/dsh-settings'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the feature flag and cheap-lane knobs. */
export const SETTINGS_NAMESPACE = 'cc-prompt-suggest' as SettingsNamespace

/** Resolved settings shape. */
export interface PromptSuggestSettings {
  enabled: boolean
  alias: string
  timeoutMs: number
  maxTokens: number
}

/**
 * Schema. DEFAULT OFF (opt-in): a user who never enables the feature sees
 * zero adapter calls and zero suggestion items.
 */
export const SettingsSchema: z<PromptSuggestSettings> = z.object({
  enabled: z.boolean().default(false),
  alias: z.string().default('haiku'),
  timeoutMs: z.number().default(4000),
  maxTokens: z.number().default(128),
})

/**
 * Register the settings namespace and return the live settings reader.
 * @param ctx - the plug context.
 * @returns a per-use settings reader, or `undefined` when the host has no
 *   settings provider (the plugin then registers nothing).
 */
export function registerSettings(ctx: Context): (() => PromptSuggestSettings) | undefined {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return undefined
  const read = registerNamespaceSafe<PromptSuggestSettings>(ctx, SETTINGS_NAMESPACE, SettingsSchema)
  const fallback: PromptSuggestSettings = { enabled: false, alias: 'haiku', timeoutMs: 4000, maxTokens: 128 }
  return () => ({ ...fallback, ...read() })
}
