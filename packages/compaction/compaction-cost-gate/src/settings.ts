/**
 * Settings namespace `cc-compaction-cost-gate` (design §3.6), registered
 * idempotently through the `@dsh-cc/settings-ns` safe helpers (PR #82
 * collision rules — mounted inside the cc preset beside ten other settings
 * users). Without a settings provider the schema defaults apply.
 * @module @dsh-cc/compaction-cost-gate/settings
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ModelPrice } from '@dsh-cc/command-cost'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'
import type { CostGateSettings } from './types.ts'

/** The settings namespace carrying the cost-gate settings. */
export const SETTINGS_NAMESPACE = 'cc-compaction-cost-gate' as SettingsNamespace

export const DEFAULT_SETTINGS: CostGateSettings = {
  enabled: false,
  mode: 'dry-run',
  margin: 1.0,
  cooldownMs: 600_000,
}

export const SettingsSchema: z<CostGateSettings> = z.object({
  enabled: z.boolean().default(false),
  mode: z.union(['dry-run', 'on'] as unknown as [('dry-run' | 'on'), ...('dry-run' | 'on')[]]).default('dry-run'),
  margin: z.number().default(1.0),
  'cooldown-ms': z.number().default(600_000),
  'window-pressure-tokens': z.number(),
  'model-table': z.any(),
}) as unknown as z<CostGateSettings>

/**
 * Register the namespace and return the live settings reader. Idempotent
 * through the shared `registerNamespaceSafe` helper: a duplicate mount under
 * the /clear create-before-dispose overlap window degrades to a live read of
 * the already-registered namespace instead of failing the preset mount.
 * @param ctx - the host context.
 * @returns a per-use settings reader (never undefined); hyphenated settings
 * keys are mapped onto the camelCase resolved shape.
 */
export function registerCostGateSettings(ctx: Context): () => CostGateSettings {
  const read = registerNamespaceSafe<Record<string, unknown>>(
    ctx,
    SETTINGS_NAMESPACE,
    SettingsSchema as unknown as z<Record<string, unknown>>,
  )
  return () => {
    const raw = read()
    if (raw === undefined) return { ...DEFAULT_SETTINGS }
    return {
      enabled: raw.enabled === true,
      mode: raw.mode === 'on' ? 'on' : 'dry-run',
      margin: typeof raw.margin === 'number' ? raw.margin : DEFAULT_SETTINGS.margin,
      cooldownMs: typeof raw['cooldown-ms'] === 'number'
        ? raw['cooldown-ms']
        : DEFAULT_SETTINGS.cooldownMs,
      ...(typeof raw['window-pressure-tokens'] === 'number'
        ? { windowPressureTokens: raw['window-pressure-tokens'] as number }
        : {}),
      ...(Array.isArray(raw['model-table'])
        ? { modelTable: raw['model-table'] as ModelPrice[] }
        : {}),
    }
  }
}
