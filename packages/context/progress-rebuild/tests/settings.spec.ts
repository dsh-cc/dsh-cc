/**
 * Settings default pins for the 2026-10-16 default-flip: the DEFAULT constant
 * and the schemastery schema must both resolve `enabled: true` — these are the
 * assertions that fail loudly if someone reverts one surface incompletely.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_PROGRESS_REBUILD_SETTINGS, SettingsSchema } from '../src/settings.ts'

describe('progress-rebuild defaults (2026-10-16 flip)', () => {
  it('DEFAULT_PROGRESS_REBUILD_SETTINGS.enabled is true', () => {
    expect(DEFAULT_PROGRESS_REBUILD_SETTINGS.enabled).toBe(true)
  })

  it('schema materializes enabled: true for an empty section (absence → default ON)', () => {
    const resolved = SettingsSchema({} as unknown as Record<string, never>) as Record<string, unknown>
    expect(resolved.enabled).toBe(true)
  })

  it('schema honors an explicit enabled: false (the opt-out path is untouched)', () => {
    const resolved = SettingsSchema({ enabled: false } as unknown as Record<string, never>) as Record<string, unknown>
    expect(resolved.enabled).toBe(false)
  })

  it('preserves absence like the cascade does (z.const(undefined) union)', () => {
    expect(SettingsSchema(undefined as unknown as Record<string, never>)).toBeUndefined()
  })
})
