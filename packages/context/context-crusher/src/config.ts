/**
 * Configuration resolution and schema for the CCR tool-output crusher.
 * @module @dsh-cc/context-crusher/config
 */

import z from '@deepseek-ai/schemastery'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { CrusherConfig, CrusherMode, ResolvedConfig } from './types.ts'

/**
 * Tools whose output is never crushed. Intentionally over-inclusive
 * (ponytail: structured-output and mutation-adjacent tools stay verbatim
 * until ledger data proves a narrower list is safe).
 */
export const DEFAULT_PROTECTED_TOOLS: readonly string[] = [
  'edit', 'write', 'notebook_edit', 'memory_save', 'ask_user_question',
  'enter_worktree', 'exit_worktree', 'subagent_fork', 'send_message',
  'task', 'interrupt_agent',
]

export const DEFAULTS: ResolvedConfig = deepFreeze({
  enabled: false,
  mode: 'dry-run',
  minBytes: 8192,
  minSavingsRatio: 0.4,
  protectedTools: DEFAULT_PROTECTED_TOOLS,
})

const MODES: readonly CrusherMode[] = ['dry-run', 'on']

/** Row-level deployment-default schema (cordis `static Config`). */
export const Config: z<CrusherConfig> = z.object({
  enabled: z.boolean(),
  mode: z.union(MODES as unknown as [CrusherMode, ...CrusherMode[]]),
  'min-bytes': z.number().step(1).min(1),
  'min-savings-ratio': z.number().min(0).max(1),
  'protected-tools': z.array(z.string()),
})

/** Settings namespace schema (same shape as the config layer). */
export const SettingsSchema: z<CrusherConfig> = Config

/**
 * Resolve and validate the plugin configuration over the defaults.
 * @param config - raw row config.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: CrusherConfig = {}): ResolvedConfig {
  if (config.mode !== undefined && !MODES.includes(config.mode)) {
    throw new Error(`context-crusher: mode must be one of ${MODES.join(', ')}`)
  }
  if (config['min-bytes'] !== undefined && (!Number.isFinite(config['min-bytes']) || config['min-bytes'] <= 0)) {
    throw new Error('context-crusher: min-bytes must be a positive number')
  }
  if (config['min-savings-ratio'] !== undefined
    && (!Number.isFinite(config['min-savings-ratio']) || config['min-savings-ratio'] < 0 || config['min-savings-ratio'] > 1)) {
    throw new Error('context-crusher: min-savings-ratio must be within [0, 1]')
  }
  return deepFreeze({
    enabled: config.enabled ?? DEFAULTS.enabled,
    mode: config.mode ?? DEFAULTS.mode,
    minBytes: config['min-bytes'] ?? DEFAULTS.minBytes,
    minSavingsRatio: config['min-savings-ratio'] ?? DEFAULTS.minSavingsRatio,
    protectedTools: config['protected-tools'] ?? DEFAULTS.protectedTools,
  })
}

/**
 * Overlay the live settings scope onto the config defaults. `protected-tools`
 * uses REPLACE semantics: an explicitly set settings list replaces the
 * defaults entirely (never a union).
 * @param base - resolved config-layer defaults.
 * @param scope - live settings scope value, when a provider is mounted.
 * @returns the effective configuration for one use.
 */
export function overlaySettings(base: ResolvedConfig, scope: CrusherConfig | undefined): ResolvedConfig {
  if (scope === undefined || typeof scope !== 'object') return base
  return {
    enabled: scope.enabled ?? base.enabled,
    mode: scope.mode ?? base.mode,
    minBytes: scope['min-bytes'] ?? base.minBytes,
    minSavingsRatio: scope['min-savings-ratio'] ?? base.minSavingsRatio,
    protectedTools: scope['protected-tools'] ?? base.protectedTools,
  }
}
