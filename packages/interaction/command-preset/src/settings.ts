/**
 * The `vwa-preset` settings namespace: this host's persisted default agent
 * preset. Schema-first via `registerNamespaceSafe` with the absence-preserving
 * union idiom (packages/settings/settings-cascade/src/auto-mode.ts): an absent
 * key stays absent, no empty-string sentinel is materialized.
 *
 * The upstream `agent-preset-registry` settings namespace is NOT borrowed: in
 * this host nothing registers it and the settings-provider's `configure`
 * compatibility facade is a deliberate general no-op, so a write to it would
 * silently do nothing (VWA design doc §3.2).
 * @module @dsh-cc/command-preset/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import { registerNamespaceSafe, type SettingsReader } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the persisted default agent preset. */
export const VWA_PRESET_NAMESPACE = 'vwa-preset' as SettingsNamespace

/** The `vwa-preset` settings shape. */
export interface VwaPresetSettings {
  /** Preset id new sessions start with; absent ⇒ the deployment default. */
  readonly selectedDefault?: string
}

/** Schemastery schema for the `vwa-preset` section. */
export const VwaPresetSettingsSchema: z<VwaPresetSettings> = z.object({
  // Absence-preserving union: an unset `selectedDefault` stays absent and the
  // consumer chain falls through to the deployment default ('cc').
  selectedDefault: z.union([z.string(), z.const(undefined)]),
}) as unknown as z<VwaPresetSettings>

/**
 * Register the `vwa-preset` namespace and return a live reader. Duplicate
 * registration (another mount or module copy owning the namespace) degrades
 * to live reads per the `registerNamespaceSafe` contract.
 * @param ctx - the mount context.
 */
export function registerVwaPresetSettings(ctx: Context): SettingsReader<VwaPresetSettings> {
  return registerNamespaceSafe<VwaPresetSettings>(ctx, VWA_PRESET_NAMESPACE, VwaPresetSettingsSchema)
}
