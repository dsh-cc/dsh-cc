/**
 * Settings for the nested `moa.context-routing` section (design
 * docs/plans/2026-11-02-systemone-09-moa-context-routing.md §"Settings and
 * modules").
 *
 * The legacy `moa` fields stay byte-for-byte unchanged when this section is
 * absent: `resolveContextRoutingSection` then yields the ship-dark defaults
 * and nothing else in the namespace moves.
 *
 * Degrade-not-throw, per field and per the settings.ts resolveSection posture:
 * the schema accepts any number/string so an out-of-range value clamps at read
 * time instead of failing the whole namespace, and one malformed member never
 * discards its siblings.
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'

/** Routing mode: off = never call, shadow = record only, active = v2 decides. */
export type ContextRoutingMode = 'off' | 'shadow' | 'active'

/** Legal mode values, in upgrade order. */
export const CONTEXT_ROUTING_MODES = ['off', 'shadow', 'active'] as const

/** Resolved settings shape of the `moa.context-routing` section. */
export interface ContextRoutingSettings {
  mode: ContextRoutingMode
  /** Per-call decision timeout in ms. */
  timeoutMs: number
  /** Token budget for (routing state + routing question). */
  maxInputTokens: number
  /** Maximum tolerated probability mass strictly above the selected tier. */
  maxUnderTierProbability: number
  /** Below this top probability the distribution falls back to live routing. */
  minTopProbability: number
}

/** Ship-dark defaults: off, and policy defaults awaiting evaluation. */
export const DEFAULT_CONTEXT_ROUTING_SETTINGS: ContextRoutingSettings = {
  mode: 'off',
  timeoutMs: 1500,
  maxInputTokens: 4000,
  maxUnderTierProbability: 0.1,
  minTopProbability: 0.6,
}

/** Raw kebab-key defaults, for the nested schema object. */
export const DEFAULT_CONTEXT_ROUTING_SECTION = {
  mode: 'off',
  'timeout-ms': 1500,
  'max-input-tokens': 4000,
  'max-under-tier-probability': 0.1,
  'min-top-probability': 0.6,
}

/** Reads clamp to these legal windows (design §"Settings and modules"). */
const TIMEOUT_MS = { min: 100, max: 8000, fallback: 1500 } as const
const MAX_INPUT_TOKENS = { min: 512, max: 16000, fallback: 4000 } as const
const MAX_UNDER_TIER_PROBABILITY = { min: 0, max: 0.5, fallback: 0.1 } as const
const MIN_TOP_PROBABILITY = { min: 0.25, max: 1, fallback: 0.6 } as const

/**
 * The nested object schema (kebab keys, every field optional with a default).
 * No min/max here on purpose: range enforcement is a READ-time clamp, so an
 * out-of-range raw value degrades instead of rejecting the namespace.
 */
const ContextRoutingObject = z.object({
  mode: z.string().default('off'),
  'timeout-ms': z.number().default(TIMEOUT_MS.fallback),
  'max-input-tokens': z.number().default(MAX_INPUT_TOKENS.fallback),
  'max-under-tier-probability': z.number().default(MAX_UNDER_TIER_PROBABILITY.fallback),
  'min-top-probability': z.number().default(MIN_TOP_PROBABILITY.fallback),
})

/**
 * The schema embedded as `moa.context-routing`: the object above with its
 * ship-dark defaults, so an absent section never fails the namespace read.
 */
export const CONTEXT_ROUTING_SCHEMA = ContextRoutingObject.default(DEFAULT_CONTEXT_ROUTING_SECTION)

/** Truncate + clamp a finite number, or fall back per field. */
function asInt(value: unknown, bounds: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.fallback
  return Math.min(Math.max(Math.trunc(value), bounds.min), bounds.max)
}

/** Clamp a finite number, or fall back per field. */
function asFloat(value: unknown, bounds: { min: number; max: number; fallback: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.fallback
  return Math.min(Math.max(value, bounds.min), bounds.max)
}

/** True when the raw value is one of the legal modes. */
function isContextRoutingMode(value: unknown): value is ContextRoutingMode {
  return value === 'off' || value === 'shadow' || value === 'active'
}

/**
 * Resolve the RAW nested section into its settings shape. Absent (or
 * non-object) input resolves to {@link DEFAULT_CONTEXT_ROUTING_SETTINGS};
 * every member degrades independently and this never throws.
 */
export function resolveContextRoutingSection(raw: unknown): ContextRoutingSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_CONTEXT_ROUTING_SETTINGS }
  }
  const section = raw as Record<string, unknown>
  return {
    mode: isContextRoutingMode(section.mode) ? section.mode : DEFAULT_CONTEXT_ROUTING_SETTINGS.mode,
    timeoutMs: asInt(section['timeout-ms'], TIMEOUT_MS),
    maxInputTokens: asInt(section['max-input-tokens'], MAX_INPUT_TOKENS),
    maxUnderTierProbability: asFloat(section['max-under-tier-probability'], MAX_UNDER_TIER_PROBABILITY),
    minTopProbability: asFloat(section['min-top-probability'], MIN_TOP_PROBABILITY),
  }
}
