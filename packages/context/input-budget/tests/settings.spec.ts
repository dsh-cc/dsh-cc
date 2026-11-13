/**
 * Settings surface (plan §"Settings — `cc-input-budget`"): the four-surface
 * default discipline — schema defaults and bounds, the `DEFAULT_` constants,
 * the raw reader's fail-soft behaviour, and the wiring fallback (the slice-5
 * mount) — plus the namespace registration no-op on a bare context and the
 * "no settings file → observe mode runs" contract.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_INPUT_BUDGET_SETTINGS,
  MAX_ADVISORY_BUDGET_BYTES,
  MAX_DEFER_TTL_STEPS,
  MAX_ENTER_BUDGET_BYTES,
  MAX_MEMORY_BUDGET_BYTES,
  MIN_ADVISORY_BUDGET_BYTES,
  MIN_DEFER_TTL_STEPS,
  MIN_ENTER_BUDGET_BYTES,
  MIN_MEMORY_BUDGET_BYTES,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  govern,
  readUserSettings,
  readUserSettingsSync,
  registerSettings,
} from '../src/index.ts'
import { messageOf } from './rig.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'input-budget-settings-'))
  homes.push(home)
  return home
}

function writeSettings(home: string, document: unknown): void {
  writeFileSync(join(home, 'settings.json'), JSON.stringify(document), 'utf8')
}

describe('defaults', () => {
  it('the constant surface matches the design table', () => {
    expect(SETTINGS_NAMESPACE).toBe('cc-input-budget')
    expect(DEFAULT_INPUT_BUDGET_SETTINGS).toEqual({
      enabled: true,
      mode: 'observe',
      'enter-budget-bytes': 24_576,
      'advisory-budget-bytes': 8192,
      'memory-budget-bytes': 16_384,
      'defer-ttl-steps': 3,
    })
    expect([MIN_ENTER_BUDGET_BYTES, MAX_ENTER_BUDGET_BYTES]).toEqual([4096, 262_144])
    expect([MIN_ADVISORY_BUDGET_BYTES, MAX_ADVISORY_BUDGET_BYTES]).toEqual([512, 65_536])
    expect([MIN_MEMORY_BUDGET_BYTES, MAX_MEMORY_BUDGET_BYTES]).toEqual([1024, 131_072])
    expect([MIN_DEFER_TTL_STEPS, MAX_DEFER_TTL_STEPS]).toEqual([1, 16])
  })

  it('the schema materializes the same defaults for an empty section', () => {
    const resolved = SettingsSchema({}) as unknown as Record<string, unknown>
    expect(resolved).toMatchObject(DEFAULT_INPUT_BUDGET_SETTINGS)
  })

  it('the schema rejects values outside the documented bounds', () => {
    expect(() => SettingsSchema({ 'enter-budget-bytes': MIN_ENTER_BUDGET_BYTES - 1 })).toThrow()
    expect(() => SettingsSchema({ 'enter-budget-bytes': MAX_ENTER_BUDGET_BYTES + 1 })).toThrow()
    expect(() => SettingsSchema({ 'advisory-budget-bytes': MIN_ADVISORY_BUDGET_BYTES - 1 })).toThrow()
    expect(() => SettingsSchema({ 'advisory-budget-bytes': MAX_ADVISORY_BUDGET_BYTES + 1 })).toThrow()
    expect(() => SettingsSchema({ 'memory-budget-bytes': MIN_MEMORY_BUDGET_BYTES - 1 })).toThrow()
    expect(() => SettingsSchema({ 'memory-budget-bytes': MAX_MEMORY_BUDGET_BYTES + 1 })).toThrow()
    expect(() => SettingsSchema({ 'defer-ttl-steps': 0 })).toThrow()
    expect(() => SettingsSchema({ 'defer-ttl-steps': MAX_DEFER_TTL_STEPS + 1 })).toThrow()
    expect(() => SettingsSchema({ mode: 'half-on' })).toThrow()
  })

  it('an absent namespace stays absent (no defaults injected into the cascade)', () => {
    expect(SettingsSchema(undefined)).toBeUndefined()
  })
})

describe('raw user-layer reader', () => {
  it('reads the kebab section of <dshHome>/settings.json', async () => {
    const home = tempHome()
    writeSettings(home, {
      'cc-input-budget': {
        enabled: false,
        mode: 'enforce',
        'enter-budget-bytes': 32768,
        'advisory-budget-bytes': 4096,
        'memory-budget-bytes': 8192,
        'defer-ttl-steps': 5,
      },
    })
    const expected = {
      enabled: false,
      mode: 'enforce',
      'enter-budget-bytes': 32_768,
      'advisory-budget-bytes': 4096,
      'memory-budget-bytes': 8192,
      'defer-ttl-steps': 5,
    }
    await expect(readUserSettings(home)).resolves.toEqual(expected)
    expect(readUserSettingsSync(home)).toEqual(expected)
  })

  it('falls back to the ship defaults when the file is absent', async () => {
    const home = tempHome()
    await expect(readUserSettings(home)).resolves.toEqual(DEFAULT_INPUT_BUDGET_SETTINGS)
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_INPUT_BUDGET_SETTINGS)
  })

  it('falls back to the ship defaults on malformed JSON or a non-object section', async () => {
    const home = tempHome()
    writeFileSync(join(home, 'settings.json'), '{ not json', 'utf8')
    await expect(readUserSettings(home)).resolves.toEqual(DEFAULT_INPUT_BUDGET_SETTINGS)
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_INPUT_BUDGET_SETTINGS)

    writeSettings(home, { 'cc-input-budget': 'nope' })
    await expect(readUserSettings(home)).resolves.toEqual(DEFAULT_INPUT_BUDGET_SETTINGS)
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_INPUT_BUDGET_SETTINGS)
  })

  it('clamps out-of-bounds integers instead of throwing', () => {
    const home = tempHome()
    writeSettings(home, {
      'cc-input-budget': {
        'enter-budget-bytes': 1,
        'advisory-budget-bytes': 10_000_000,
        'memory-budget-bytes': 0,
        'defer-ttl-steps': 99,
      },
    })
    expect(readUserSettingsSync(home)).toEqual({
      ...DEFAULT_INPUT_BUDGET_SETTINGS,
      'enter-budget-bytes': MIN_ENTER_BUDGET_BYTES,
      'advisory-budget-bytes': MAX_ADVISORY_BUDGET_BYTES,
      'memory-budget-bytes': MIN_MEMORY_BUDGET_BYTES,
      'defer-ttl-steps': MAX_DEFER_TTL_STEPS,
    })
  })

  it('ignores non-boolean values and unknown modes', () => {
    const home = tempHome()
    writeSettings(home, {
      'cc-input-budget': { enabled: 'yes', mode: 'turbo', 'enter-budget-bytes': 'wide' },
    })
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_INPUT_BUDGET_SETTINGS)
  })
})

describe('namespace registration', () => {
  it('is a no-op when the host has no settings provider', () => {
    const ctx = { get: vi.fn(() => undefined) }
    expect(() => registerSettings(ctx as never)).not.toThrow()
    expect(ctx.get).toHaveBeenCalledWith('settings')
  })
})

describe('no settings file means observe mode runs', () => {
  it('resolves to observe mode and leaves the batch untouched', () => {
    const home = tempHome()
    const settings = readUserSettingsSync(home)
    expect(settings).toEqual(DEFAULT_INPUT_BUDGET_SETTINGS)
    expect(settings.mode).toBe('observe')

    const messages = [messageOf('advisor', 9000), messageOf('memory', 20_000)]
    const result = govern({ messages, settings })
    expect(result.messages).toEqual(messages)
    expect(result.backlog).toEqual([])
    expect(result.decision.mode).toBe('observe')
  })
})
