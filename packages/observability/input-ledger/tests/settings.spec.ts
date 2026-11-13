/**
 * Settings surface (plan §"Settings — `cc-input-ledger`"): the four-surface
 * default discipline — schema defaults and bounds, the `DEFAULT_` constants,
 * the raw reader's fail-soft behaviour, and the wiring fallback exercised in
 * `mount.spec.ts` — plus the namespace registration no-op on a bare context.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_INPUT_LEDGER_SETTINGS,
  DEFAULT_MAX_ROWS_PER_FILE,
  MAX_ROWS_PER_FILE,
  MAX_SECTIONS_PER_ROW,
  MIN_ROWS_PER_FILE,
  MIN_SECTIONS_PER_ROW,
  readUserSettings,
  readUserSettingsSync,
  registerSettings,
  SETTINGS_NAMESPACE,
  SettingsSchema,
} from '../src/index.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'input-ledger-settings-'))
  homes.push(home)
  return home
}

function writeSettings(home: string, document: unknown): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify(document), 'utf8')
}

describe('defaults', () => {
  it('the constant surface matches the design table', () => {
    expect(SETTINGS_NAMESPACE).toBe('cc-input-ledger')
    expect(DEFAULT_INPUT_LEDGER_SETTINGS).toEqual({
      enabled: true,
      'include-subagents': true,
      'max-sections-per-row': 64,
      'max-rows-per-file': DEFAULT_MAX_ROWS_PER_FILE,
    })
    expect([MIN_SECTIONS_PER_ROW, MAX_SECTIONS_PER_ROW]).toEqual([8, 256])
    expect([MIN_ROWS_PER_FILE, MAX_ROWS_PER_FILE]).toEqual([100, 100_000])
  })

  it('the schema materializes the same defaults for an empty section', () => {
    const resolved = SettingsSchema({}) as unknown as Record<string, unknown>
    expect(resolved).toMatchObject(DEFAULT_INPUT_LEDGER_SETTINGS)
  })

  it('the schema rejects values outside the documented bounds', () => {
    expect(() => SettingsSchema({ 'max-sections-per-row': MIN_SECTIONS_PER_ROW - 1 })).toThrow()
    expect(() => SettingsSchema({ 'max-sections-per-row': MAX_SECTIONS_PER_ROW + 1 })).toThrow()
    expect(() => SettingsSchema({ 'max-rows-per-file': MIN_ROWS_PER_FILE - 1 })).toThrow()
    expect(() => SettingsSchema({ 'max-rows-per-file': MAX_ROWS_PER_FILE + 1 })).toThrow()
  })

  it('an absent namespace stays absent (no defaults injected into the cascade)', () => {
    expect(SettingsSchema(undefined)).toBeUndefined()
  })
})

describe('raw user-layer reader', () => {
  it('reads the kebab section of <dshHome>/settings.json', async () => {
    const home = tempHome()
    writeSettings(home, {
      'cc-input-ledger': {
        enabled: false,
        'include-subagents': false,
        'max-sections-per-row': 16,
        'max-rows-per-file': 500,
      },
    })
    await expect(readUserSettings(home)).resolves.toEqual({
      enabled: false,
      'include-subagents': false,
      'max-sections-per-row': 16,
      'max-rows-per-file': 500,
    })
    expect(readUserSettingsSync(home)).toEqual({
      enabled: false,
      'include-subagents': false,
      'max-sections-per-row': 16,
      'max-rows-per-file': 500,
    })
  })

  it('falls back to the ship defaults when the file is absent', async () => {
    const home = tempHome()
    await expect(readUserSettings(home)).resolves.toEqual(DEFAULT_INPUT_LEDGER_SETTINGS)
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_INPUT_LEDGER_SETTINGS)
  })

  it('falls back to the ship defaults on malformed JSON or a non-object section', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'settings.json'), '{ not json', 'utf8')
    await expect(readUserSettings(home)).resolves.toEqual(DEFAULT_INPUT_LEDGER_SETTINGS)
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_INPUT_LEDGER_SETTINGS)

    writeSettings(home, { 'cc-input-ledger': 'nope' })
    await expect(readUserSettings(home)).resolves.toEqual(DEFAULT_INPUT_LEDGER_SETTINGS)
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_INPUT_LEDGER_SETTINGS)
  })

  it('clamps out-of-bounds integers instead of throwing', () => {
    const home = tempHome()
    writeSettings(home, {
      'cc-input-ledger': { 'max-sections-per-row': 1, 'max-rows-per-file': 10_000_000 },
    })
    expect(readUserSettingsSync(home)).toEqual({
      ...DEFAULT_INPUT_LEDGER_SETTINGS,
      'max-sections-per-row': MIN_SECTIONS_PER_ROW,
      'max-rows-per-file': MAX_ROWS_PER_FILE,
    })
  })

  it('ignores non-boolean and non-numeric values', () => {
    const home = tempHome()
    writeSettings(home, {
      'cc-input-ledger': {
        enabled: 'yes',
        'include-subagents': 0,
        'max-sections-per-row': 'wide',
        'max-rows-per-file': null,
      },
    })
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_INPUT_LEDGER_SETTINGS)
  })
})

describe('namespace registration', () => {
  it('is a no-op when the host has no settings provider', () => {
    const ctx = { get: vi.fn(() => undefined) }
    expect(() => registerSettings(ctx as never)).not.toThrow()
    expect(ctx.get).toHaveBeenCalledWith('settings')
  })
})
