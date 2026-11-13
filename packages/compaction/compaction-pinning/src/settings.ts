/**
 * Settings for compaction governed-message pinning (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Settings), two halves —
 * the same split as post-edit-verify / turn-rules:
 *
 * 1. namespace registration via `@dsh-cc/settings/ns` (schema uses the kebab
 *    keys users author in settings.json), for /config UX and validation only;
 * 2. a RAW user-layer read of `<dshHome>/settings.json` that bypasses the
 *    merged cascade entirely, re-read per use (a few KB) — free hot reload.
 *
 * FOUR-SURFACE DEFAULT DISCIPLINE (repo hard rule): the schema `.default()`
 * values, {@link DEFAULT_COMPACTION_PINNING_SETTINGS}, the raw reader's
 * fallbacks, and the plugin wiring all derive from the `DEFAULT_*` constants
 * below. Never restate a default as a literal anywhere else.
 *
 * @module
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@dsh-cc/settings'
import z from '@deepseek-ai/schemastery'
import { registerNamespaceSafe } from '@dsh-cc/settings/ns'

/** The settings namespace carrying the pinning flags. */
export const SETTINGS_NAMESPACE = 'cc-compaction-pinning' as SettingsNamespace

/** Resolved settings shape (camelCase internal; config keys are kebab). */
export interface CompactionPinningSettings {
  /** Capture and restore run; disabling stops both (a ring is never retroactively rebuilt, §Settings). */
  enabled: boolean
  /** Message-source kinds treated as durable behavioral constraints (§Kind defaults). */
  pinnedSourceKinds: string[]
  /** Ring entry cap (§Settings bounds `MIN_PINNED`..`MAX_PINNED`). */
  maxPinned: number
  /** Ring byte cap (§Settings bounds `MIN_PINNED_BYTES`..`MAX_PINNED_BYTES`). */
  maxPinnedBytes: number
}

// ---------------------------------------------------------------------------
// Defaults + bounds: the single source every surface (schema defaults, the
// resolved-defaults object, the raw reader, and the plugin wiring) reads.
// ---------------------------------------------------------------------------

/** Default: capture (and, once the restore half lands, restore) run. */
export const DEFAULT_ENABLED = true

/**
 * Default pinned kinds (§Kind defaults): the durable behavioral-constraint
 * producers — turn-rules reminders and post-edit-verify recovery hints. Both
 * already exist as `MessageSourceMap` producers; this package introduces no
 * source kind of its own.
 */
export const DEFAULT_PINNED_SOURCE_KINDS: readonly string[] = ['turn-rules', 'edit-recovery-hint']

/** Default ring entry cap (§Settings bounds 1..64). */
export const DEFAULT_MAX_PINNED = 16

/** Default ring byte cap (§Settings bounds 1024..262144). */
export const DEFAULT_MAX_PINNED_BYTES = 16_384

/** Lower bound of `max-pinned`. */
export const MIN_PINNED = 1
/** Upper bound of `max-pinned`. */
export const MAX_PINNED = 64
/** Lower bound of `max-pinned-bytes`. */
export const MIN_PINNED_BYTES = 1024
/** Upper bound of `max-pinned-bytes`. */
export const MAX_PINNED_BYTES = 262_144
/** Per-kind length bound of `pinned-source-kinds` entries. */
export const MAX_SOURCE_KIND_CHARS = 64

const opt = <T>(t: z<T>): z<T | undefined> => z.union([t, z.const(undefined)]) as z<T | undefined>

/** Inner object shape (kebab keys). Absence resolves to defaults via schemastery. */
const SettingsObject = z.object({
  enabled: z.boolean().default(DEFAULT_ENABLED),
  'pinned-source-kinds': z.array(z.string()).default([...DEFAULT_PINNED_SOURCE_KINDS]),
  'max-pinned': z.number().default(DEFAULT_MAX_PINNED).min(MIN_PINNED).max(MAX_PINNED).step(1),
  'max-pinned-bytes': z.number().default(DEFAULT_MAX_PINNED_BYTES).min(MIN_PINNED_BYTES).max(MAX_PINNED_BYTES).step(1),
})

/**
 * Namespace schema. Wrapped in the z.const(undefined) union (post-edit-verify
 * convention) so a genuinely absent namespace value stays absent instead of
 * materializing defaults into the cascade.
 */
export const SettingsSchema: z<Record<string, unknown>> =
  opt(SettingsObject) as unknown as z<Record<string, unknown>>

/**
 * Promoted defaults, used when the user file is absent or malformed. Every
 * value is derived from the `DEFAULT_*` constants the schema above also uses.
 */
export const DEFAULT_COMPACTION_PINNING_SETTINGS: CompactionPinningSettings = {
  enabled: DEFAULT_ENABLED,
  pinnedSourceKinds: [...DEFAULT_PINNED_SOURCE_KINDS],
  maxPinned: DEFAULT_MAX_PINNED,
  maxPinnedBytes: DEFAULT_MAX_PINNED_BYTES,
}

/**
 * Read the configured kinds defensively. Schemastery has no string-length
 * constraint, so the per-kind 64-char bound (§Settings) is applied here: invalid
 * or over-long entries are dropped. A configured list that yields no valid kind
 * falls back to the documented default pair — turning capture off is
 * `enabled: false`, not an empty list.
 */
function sourceKindsOf(value: unknown): string[] {
  const kinds = (Array.isArray(value) ? value : []).filter(
    (kind): kind is string =>
      typeof kind === 'string' && kind.length > 0 && kind.length <= MAX_SOURCE_KIND_CHARS,
  )
  return kinds.length > 0 ? kinds : [...DEFAULT_PINNED_SOURCE_KINDS]
}

/**
 * Map the kebab schema shape onto the camelCase internal shape. Out-of-range
 * numerics make schemastery throw, and every caller below contains that throw
 * and returns {@link DEFAULT_COMPACTION_PINNING_SETTINGS} (fail soft, never a
 * hot-path throw) — the diagnostic for a bad value is /config validation in the
 * namespace path.
 */
function resolveSettings(section: Record<string, unknown>): CompactionPinningSettings {
  const resolved = SettingsObject(section as unknown as Record<string, never>) as unknown as Record<string, unknown>
  return {
    enabled: resolved.enabled as boolean,
    pinnedSourceKinds: sourceKindsOf(resolved['pinned-source-kinds']),
    maxPinned: resolved['max-pinned'] as number,
    maxPinnedBytes: resolved['max-pinned-bytes'] as number,
  }
}

/**
 * Register the settings namespace (for /config UX and validation only — the
 * listeners read the raw user file). Returns the live reader, or `undefined`
 * when the host has no settings provider.
 */
export function registerSettings(ctx: Context): (() => CompactionPinningSettings) | undefined {
  const settings = ctx.get('settings') as object | undefined
  if (settings === undefined) return undefined
  const read = registerNamespaceSafe<Record<string, unknown>>(
    ctx,
    SETTINGS_NAMESPACE,
    SettingsSchema as unknown as z<Record<string, unknown>>,
  )
  return () => {
    try {
      const value = read()
      return value === undefined
        ? DEFAULT_COMPACTION_PINNING_SETTINGS
        : resolveSettings(value as unknown as Record<string, unknown>)
    } catch {
      // Malformed live scope → documented defaults; never throw into a hot path.
      return DEFAULT_COMPACTION_PINNING_SETTINGS
    }
  }
}

/**
 * Read the settings DIRECTLY from `<dshHome>/settings.json`, bypassing the
 * merged cascade (user-layer only, §Settings). Fail-soft: absent file, parse
 * error, or a malformed section yields the documented defaults. Project scope
 * is never read — invisible, not refused.
 */
export async function readUserSettings(dshHome: string): Promise<CompactionPinningSettings> {
  let text: string
  try {
    text = await readFile(join(dshHome, 'settings.json'), 'utf8')
  } catch {
    return DEFAULT_COMPACTION_PINNING_SETTINGS
  }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    return DEFAULT_COMPACTION_PINNING_SETTINGS
  }
  if (typeof root !== 'object' || root === null) return DEFAULT_COMPACTION_PINNING_SETTINGS
  const section = (root as Record<string, unknown>)[SETTINGS_NAMESPACE]
  if (typeof section !== 'object' || section === null) return DEFAULT_COMPACTION_PINNING_SETTINGS
  try {
    return resolveSettings(section as Record<string, unknown>)
  } catch {
    return DEFAULT_COMPACTION_PINNING_SETTINGS
  }
}
