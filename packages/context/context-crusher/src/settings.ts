/**
 * Settings namespace registration for the `cc-context-compression` overlay.
 * Model-aliases style: the namespace is registered once at mount; the live
 * scope is re-read on EVERY use so a settings write applies immediately.
 * @module @dsh-cc/context-crusher/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'
import { Config, SettingsSchema } from './config.ts'
import type { CrusherConfig, ResolvedConfig } from './types.ts'

/** The settings namespace carrying the live crusher overlay. */
export const SETTINGS_NAMESPACE = 'cc-context-compression' as SettingsNamespace

/** A live settings reader bound at mount; returns undefined without a provider. */
export type SettingsReader = () => CrusherConfig | undefined

/**
 * Register the settings namespace and return a per-use reader. Graceful
 * without a settings provider: the reader resolves `undefined` and callers
 * fall back to the config defaults.
 * @param ctx - the plug context.
 * @param base - resolved config-layer defaults (validated once here too).
 * @returns the live scope reader.
 */
export function registerSettings(ctx: Context, base: ResolvedConfig): SettingsReader {
  const read = registerNamespaceSafe<CrusherConfig>(ctx, SETTINGS_NAMESPACE, SettingsSchema, {
    validate: (value: CrusherConfig) => {
      // Re-run the same cross-field validation as the config layer so a
      // half-written scope is rejected at write time.
      const merged = { ...base, ...value } as CrusherConfig
      Config(merged)
    },
  })
  return () => {
    const value = read()
    return value === undefined ? undefined : { ...base, ...value }
  }
}
