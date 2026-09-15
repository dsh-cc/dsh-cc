/**
 * Settings namespace registration for `cc-tool-use-summary` (design doc §5.5).
 *
 * ONE defaults module for the namespace: the TUS producer plugin AND the
 * compaction-micro consumer both read through `registerTusSettings`, which is
 * idempotent per settings provider (WeakMap) so a second caller gets the
 * already-registered scope instead of failing the duplicate registration.
 * Consumers without a settings provider run on the schema defaults.
 *
 * @module @dsh-cc/tool-use-summary/settings
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace, SettingsProvider } from '@deepseek-ai/dsh-settings'

/** The settings namespace carrying the TUS pipeline settings. */
export const SETTINGS_NAMESPACE = 'cc-tool-use-summary' as SettingsNamespace

/** Resolved (defaults-applied) TUS settings. */
export interface TusSettings {
  enabled: boolean
  topLevelOnly: boolean
  minResultBytes: number
  maxSummariesPerSession: number
  maxTokens: number
  timeoutMs: number
  alias: string
  excludeTools: string[]
  retentionDays: number
  /** Consumer A gate: micro placeholders upgrade to TUS digests when true. */
  upgradeMicroPlaceholders: boolean
}

export const DEFAULT_SETTINGS: TusSettings = {
  enabled: true,
  topLevelOnly: true,
  minResultBytes: 4096,
  maxSummariesPerSession: 200,
  maxTokens: 256,
  timeoutMs: 5000,
  alias: 'haiku',
  excludeTools: ['structured_output'],
  retentionDays: 7,
  upgradeMicroPlaceholders: true,
}

export const SettingsSchema: z<TusSettings> = z.object({
  enabled: z.boolean().default(true),
  topLevelOnly: z.boolean().default(true),
  minResultBytes: z.number().default(4096),
  maxSummariesPerSession: z.number().default(200),
  maxTokens: z.number().default(256),
  timeoutMs: z.number().default(5000),
  alias: z.string().default('haiku'),
  excludeTools: z.array(z.string()).default(['structured_output']),
  retentionDays: z.number().default(7),
  upgradeMicroPlaceholders: z.boolean().default(true),
})

type SettingsScope = { get?: () => unknown }
const scopes = new WeakMap<object, SettingsScope | undefined>()

/**
 * Register the namespace once per settings provider and return the live
 * settings reader. Idempotent: callers after the first (the compaction-micro
 * consumer reads the same namespace) receive the same scope. Without a
 * settings provider the reader returns the schema defaults.
 * @param ctx - the host context.
 * @returns a per-use settings reader (never undefined).
 */
export function registerTusSettings(ctx: Context): () => TusSettings {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return () => ({ ...DEFAULT_SETTINGS })
  if (!scopes.has(settings)) {
    const scope = settings.register(SETTINGS_NAMESPACE, SettingsSchema) as SettingsScope | undefined
    scopes.set(settings, scope)
  }
  const scope = scopes.get(settings)
  return () => {
    const value = scope?.get?.() as Partial<TusSettings> | undefined
    return { ...DEFAULT_SETTINGS, ...value }
  }
}
