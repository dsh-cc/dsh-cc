/**
 * Settings namespace registration for the `cc-reasoning-fold` probe.
 * Handoff-store settings.ts pattern: the namespace is registered once at
 * mount; the live scope is re-read on EVERY stream invocation so a settings
 * write applies immediately (while a call already in flight keeps the
 * decision pinned at its start).
 * @module @dsh-cc/reasoning-fold/settings
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsProvider } from '@deepseek-ai/dsh-settings'

/** The settings namespace carrying the probe flag. */
export const SETTINGS_NAMESPACE = 'cc-reasoning-fold' as SettingsNamespace

/**
 * Schema. Stage-0 carries ONLY `probe`; the Stage-1 keys
 * (`providers` / `head-chars` / `tail-chars` / `floor-chars`) are documented
 * in the README as inert/future and are deliberately NOT declared here —
 * schema keys without a consumption chain fail the capability manifest audit.
 */
export const SettingsSchema: z<{ probe: boolean }> = z.object({
  probe: z.boolean().default(true),
})

/**
 * Register the settings namespace and return the live probe reader.
 * @param ctx - the plug context.
 * @returns a per-use probe reader, or `undefined` when the host has no
 *   settings provider (the plugin then registers nothing).
 */
export function registerProbeSetting(ctx: Context): (() => boolean) | undefined {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return undefined
  const scope = settings.register(SETTINGS_NAMESPACE, SettingsSchema)
  return () => (scope?.get?.() as { probe?: boolean } | undefined)?.probe ?? true
}
