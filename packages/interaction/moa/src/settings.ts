/**
 * Settings for moa (design docs/plans/2026-10-09-moa-tiered-cascade-routing.md
 * §3.1/§3.7), the advisor-watchdog pattern
 * (packages/interaction/advisor-watchdog/src/settings.ts): namespace
 * registration via `@dsh-cc/settings-ns` for /config UX + validation, plus a
 * resolved-shape reader re-read per use so a turn never depends on cascade
 * timing.
 *
 * `maxEscalations` has a ceiling of 3 enforced at READ time, not schema time —
 * the schema accepts any number so an out-of-range value degrades (clamp)
 * instead of failing the whole namespace.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings-provider'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings-ns'

/** The settings namespace carrying the moa flags. */
export const SETTINGS_NAMESPACE = 'moa' as SettingsNamespace

/** Hard escalation ceiling (§3.4: masterplan is the hard ceiling). */
export const MAX_ESCALATIONS_CEILING = 3

/** Explicit object-form judge route (§3.6). */
export interface JudgeRouteObject {
  provider: string
  model: string
  protocol?: 'systemone' | undefined
}

/** Alias string or explicit object form. */
export type JudgeRouteSetting = string | JudgeRouteObject

/** Resolved settings shape. */
export interface MoaSettings {
  enabled: boolean
  acceptance: { enabled: boolean; shadow: boolean; tau: number }
  maxEscalations: number
  judgeRoute: JudgeRouteSetting | undefined
  classifyBudgetTokens: number
  callBudgetMs: number
}

/** Ship-dark defaults (§3.7): everything off. */
export const DEFAULT_MOA_SETTINGS: MoaSettings = {
  enabled: false,
  acceptance: { enabled: false, shadow: false, tau: 0.7 },
  maxEscalations: 1,
  judgeRoute: undefined,
  classifyBudgetTokens: 4000,
  callBudgetMs: 8000,
}

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(false),
  acceptance: z
    .object({
      enabled: z.boolean().default(false),
      shadow: z.boolean().default(false),
      tau: z.number().min(0).max(1).default(0.7),
    })
    .default({ enabled: false, shadow: false, tau: 0.7 }),
  'max-escalations': z.number().min(0).default(1),
  'judge-route': z.union([
    z.string(),
    z.object({
      provider: z.string(),
      model: z.string(),
      protocol: z.union([z.const('systemone'), z.const(undefined)]),
    }),
    z.const(undefined),
  ]),
  'classify-budget-tokens': z.number().min(1).default(4000),
  'call-budget-ms': z.number().min(1).default(8000),
})

/** Register the namespace for /config UX + validation; returns the live reader. */
export function registerSettings(ctx: Context): (() => MoaSettings) | undefined {
  const settings = ctx.get('settings') as object | undefined
  if (settings === undefined) return undefined
  const read = registerNamespaceSafe<Record<string, unknown>>(
    ctx,
    SETTINGS_NAMESPACE,
    // The z.const(undefined) union keeps a genuinely absent namespace absent
    // instead of materializing defaults into the cascade (turn-rules convention).
    z.union([SettingsObject, z.const(undefined)]) as unknown as z<Record<string, unknown>>,
  )
  // registerNamespaceSafe memoizes per provider and degrades duplicate
  // registration to a live read, so applying the plugin twice in one runtime
  // is idempotent (settings-ns contract, settings-ns/src/index.ts §Behavior).
  return () => {
    try {
      const value = read()
      if (value === undefined) return DEFAULT_MOA_SETTINGS
      return resolveSection(value as unknown as Record<string, unknown>)
    } catch {
      // Malformed live scope → ship defaults; never throw into a hot path.
      return DEFAULT_MOA_SETTINGS
    }
  }
}

/** Resolve one raw section into the settings shape with defaults. */
function resolveSection(section: Record<string, unknown>): MoaSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  const asInt = (value: unknown, fallback: number, ceiling: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
    return Math.min(Math.max(n, 0), ceiling)
  }
  const acceptance = (resolved.acceptance ?? {}) as Record<string, unknown>
  return {
    enabled: (resolved.enabled as boolean) ?? false,
    acceptance: {
      enabled: (acceptance.enabled as boolean) ?? false,
      shadow: (acceptance.shadow as boolean) ?? false,
      tau: typeof acceptance.tau === 'number' && Number.isFinite(acceptance.tau) ? acceptance.tau : 0.7,
    },
    // Ceiling 3 enforced at read time (§3.4), not schema time (see module doc).
    maxEscalations: asInt(resolved['max-escalations'], 1, MAX_ESCALATIONS_CEILING),
    judgeRoute: resolved['judge-route'] as JudgeRouteSetting | undefined,
    classifyBudgetTokens: asInt(resolved['classify-budget-tokens'], 4000, Number.MAX_SAFE_INTEGER),
    callBudgetMs: asInt(resolved['call-budget-ms'], 8000, Number.MAX_SAFE_INTEGER),
  }
}
