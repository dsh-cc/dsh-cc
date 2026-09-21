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

/**
 * Default reducer command patterns (plan §3.2): regex sources matched
 * against the bash invocation command line. `make\b` also matches `cmake` —
 * accepted as an eligibility-only over-trigger.
 */
export const DEFAULT_REDUCER_COMMANDS: readonly string[] = [
  'pnpm .* (build|test|vitest|tsc|lint)',
  'npm (run )?(build|test)',
  'yarn (build|test)',
  'npx (vitest|jest|tsc|eslint)',
  'vitest|jest|mocha|pytest|go test|cargo test|make\\b',
]

export const DEFAULTS: ResolvedConfig = deepFreeze({
  enabled: false,
  mode: 'dry-run',
  minBytes: 8192,
  minSavingsRatio: 0.4,
  protectedTools: DEFAULT_PROTECTED_TOOLS,
  reducerEnabled: false,
  reducerCommands: DEFAULT_REDUCER_COMMANDS.map((source) => new RegExp(source)),
  reducerMaxInputTokens: 30_000,
  reducerMinSavingsRatio: 0.5,
  reducerMaxTokens: 1024,
  reducerTimeoutMs: 10_000,
  reducerAlias: 'haiku',
  deferRequests: 0,
  deferMargin: 1.5,
  deferMaxAgeMs: 1_800_000,
})

const MODES: readonly CrusherMode[] = ['dry-run', 'on']

/** Row-level deployment-default schema (cordis `static Config`). */
export const Config: z<CrusherConfig> = z.object({
  enabled: z.boolean(),
  mode: z.union(MODES as unknown as [CrusherMode, ...CrusherMode[]]),
  'min-bytes': z.number().step(1).min(1),
  'min-savings-ratio': z.number().min(0).max(1),
  'protected-tools': z.array(z.string()),
  'reducer-enabled': z.boolean(),
  'reducer-commands': z.array(z.string()),
  'reducer-max-input-tokens': z.number().step(1).min(1),
  'reducer-min-savings-ratio': z.number().min(0).max(1),
  'reducer-max-tokens': z.number().step(1).min(1),
  'reducer-timeout-ms': z.number().step(1).min(1),
  'reducer-alias': z.string(),
  'defer-requests': z.number().step(1).min(0),
  'defer-margin': z.number().min(0),
  'defer-max-age-ms': z.number().step(1).min(1),
  'defer-urgency-tokens': z.number().step(1).min(1),
})

/** Settings namespace schema (same shape as the config layer). */
export const SettingsSchema: z<CrusherConfig> = Config

/**
 * Resolve and validate the plugin configuration over the defaults.
 * @param config - raw row config.
 * @returns a detached deeply immutable configuration.
 */
export function resolveConfig(config: CrusherConfig = {}, options?: { log?: (message: string) => void }): ResolvedConfig {
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
  if (config['reducer-min-savings-ratio'] !== undefined
    && (!Number.isFinite(config['reducer-min-savings-ratio']) || config['reducer-min-savings-ratio'] < 0 || config['reducer-min-savings-ratio'] > 1)) {
    throw new Error('context-crusher: reducer-min-savings-ratio must be within [0, 1]')
  }
  for (const key of ['reducer-max-input-tokens', 'reducer-max-tokens', 'reducer-timeout-ms'] as const) {
    const value = config[key]
    if (value !== undefined && (!Number.isFinite(value) || value < 1)) {
      throw new Error(`context-crusher: ${key} must be a positive number`)
    }
  }
  // Compile command patterns once at resolve time (§3.2): an invalid user
  // regex is dropped with a debug log, never thrown and never recompiled on
  // the hot path. An empty list falls back to the defaults (schemastery
  // normalizes an ABSENT array to [] on the cordis config plane, so []
  // cannot be distinguished from unset there).
  const log = options?.log
  const rawCommands = config['reducer-commands']
  const commands = rawCommands !== undefined && rawCommands.length > 0 ? rawCommands : DEFAULT_REDUCER_COMMANDS
  const reducerCommands = commands.flatMap((source) => {
    try {
      return [new RegExp(source)]
    } catch {
      log?.(`context-crusher: invalid reducer-commands pattern dropped: ${source}`)
      return []
    }
  })
  if (config['defer-requests'] !== undefined
    && (!Number.isInteger(config['defer-requests']) || config['defer-requests'] < 0)) {
    throw new Error('context-crusher: defer-requests must be a non-negative integer')
  }
  if (config['defer-margin'] !== undefined
    && (!Number.isFinite(config['defer-margin']) || config['defer-margin'] <= 0)) {
    throw new Error('context-crusher: defer-margin must be a positive number')
  }
  if (config['defer-max-age-ms'] !== undefined
    && (!Number.isFinite(config['defer-max-age-ms']) || config['defer-max-age-ms'] <= 0)) {
    throw new Error('context-crusher: defer-max-age-ms must be a positive number')
  }
  if (config['defer-urgency-tokens'] !== undefined
    && (!Number.isFinite(config['defer-urgency-tokens']) || config['defer-urgency-tokens'] <= 0)) {
    throw new Error('context-crusher: defer-urgency-tokens must be a positive number')
  }
  return deepFreeze({
    enabled: config.enabled ?? DEFAULTS.enabled,
    mode: config.mode ?? DEFAULTS.mode,
    minBytes: config['min-bytes'] ?? DEFAULTS.minBytes,
    minSavingsRatio: config['min-savings-ratio'] ?? DEFAULTS.minSavingsRatio,
    protectedTools: config['protected-tools'] ?? DEFAULTS.protectedTools,
    reducerEnabled: config['reducer-enabled'] ?? DEFAULTS.reducerEnabled,
    reducerCommands,
    reducerMaxInputTokens: config['reducer-max-input-tokens'] ?? DEFAULTS.reducerMaxInputTokens,
    reducerMinSavingsRatio: config['reducer-min-savings-ratio'] ?? DEFAULTS.reducerMinSavingsRatio,
    reducerMaxTokens: config['reducer-max-tokens'] ?? DEFAULTS.reducerMaxTokens,
    reducerTimeoutMs: config['reducer-timeout-ms'] ?? DEFAULTS.reducerTimeoutMs,
    reducerAlias: config['reducer-alias'] ?? DEFAULTS.reducerAlias,
    deferRequests: config['defer-requests'] ?? DEFAULTS.deferRequests,
    deferMargin: config['defer-margin'] ?? DEFAULTS.deferMargin,
    deferMaxAgeMs: config['defer-max-age-ms'] ?? DEFAULTS.deferMaxAgeMs,
    ...(config['defer-urgency-tokens'] !== undefined
      ? { deferUrgencyTokens: config['defer-urgency-tokens'] }
      : {}),
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
    // Every reducer key uses REPLACE semantics (§3.6): an explicitly set
    // settings value replaces the config default wholesale (never a union).
    reducerEnabled: scope['reducer-enabled'] ?? base.reducerEnabled,
    reducerCommands: scope['reducer-commands'] !== undefined && scope['reducer-commands'].length > 0
      ? scope['reducer-commands'].flatMap((source) => {
        try {
          return [new RegExp(source)]
        } catch {
          return []
        }
      })
      : base.reducerCommands,
    reducerMaxInputTokens: scope['reducer-max-input-tokens'] ?? base.reducerMaxInputTokens,
    reducerMinSavingsRatio: scope['reducer-min-savings-ratio'] ?? base.reducerMinSavingsRatio,
    reducerMaxTokens: scope['reducer-max-tokens'] ?? base.reducerMaxTokens,
    reducerTimeoutMs: scope['reducer-timeout-ms'] ?? base.reducerTimeoutMs,
    reducerAlias: scope['reducer-alias'] ?? base.reducerAlias,
    deferRequests: scope['defer-requests'] ?? base.deferRequests,
    deferMargin: scope['defer-margin'] ?? base.deferMargin,
    deferMaxAgeMs: scope['defer-max-age-ms'] ?? base.deferMaxAgeMs,
    ...(scope['defer-urgency-tokens'] !== undefined || base.deferUrgencyTokens !== undefined
      ? { deferUrgencyTokens: scope['defer-urgency-tokens'] ?? base.deferUrgencyTokens }
      : {}),
  }
}
