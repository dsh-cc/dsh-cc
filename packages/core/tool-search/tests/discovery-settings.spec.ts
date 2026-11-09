/**
 * The `cc-tool-discovery` settings contract (design
 * `docs/plans/2026-11-02-systemone-05-tool-discovery.md` § "Settings"): the
 * thirteen rows of the table, `off` by default, every range rejected rather
 * than clamped, unknown keys ignored, and the fail-soft gate — invalid settings
 * mean the runner is never called, the lexical path runs, and the failure is
 * reported exactly once.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DISCOVERY_SETTINGS,
  SETTINGS_NAMESPACE,
  createWarnOnce,
  describeDiscoverySettingsProblems,
  parseDiscoverySettings,
  resolveDiscoverySettings,
} from '../src/discovery-settings.ts'

/** Parse a section that is known to be valid, failing loudly when it is not. */
function settingsOf(raw: Record<string, unknown>) {
  const parsed = parseDiscoverySettings(raw)
  if (!parsed.ok) throw new Error(`expected valid settings, got ${JSON.stringify(parsed.problems)}`)
  return parsed.settings
}

/** The raw keys of every rejected parse, in report order. */
function rejectedKeys(raw: Record<string, unknown>): string[] {
  const parsed = parseDiscoverySettings(raw)
  if (parsed.ok) throw new Error('expected the section to be rejected')
  return parsed.problems.map(problem => problem.key)
}

describe('cc-tool-discovery settings table', () => {
  it('uses the design namespace', () => {
    expect(SETTINGS_NAMESPACE).toBe('cc-tool-discovery')
  })

  it('resolves an absent section to the documented defaults (mode off)', () => {
    expect(parseDiscoverySettings(undefined)).toEqual({ ok: true, settings: DEFAULT_DISCOVERY_SETTINGS })
    expect(parseDiscoverySettings(null)).toEqual({ ok: true, settings: DEFAULT_DISCOVERY_SETTINGS })
    expect(parseDiscoverySettings({})).toEqual({ ok: true, settings: DEFAULT_DISCOVERY_SETTINGS })
    expect(DEFAULT_DISCOVERY_SETTINGS).toEqual({
      mode: 'off',
      routeAlias: 'gauge',
      timeoutMs: 1200,
      maxInputTokens: 4096,
      maxCandidates: 64,
      batchSize: 8,
      maxQueryChars: 2048,
      maxMetadataChars: 2048,
      minRelevanceIndex: 3,
      minDirectFit: 0.75,
      maxActivations: 3,
      cacheEntries: 128,
      cacheTtlMs: 60000,
    })
  })

  it('maps kebab-case raw keys onto the camelCase internal shape', () => {
    const settings = settingsOf({
      mode: 'shadow',
      'route-alias': 'gauge-alt',
      'timeout-ms': 900,
      'max-input-tokens': 2048,
      'max-candidates': 12,
      'batch-size': 4,
      'max-query-chars': 512,
      'max-metadata-chars': 256,
      'min-relevance-index': 2.5,
      'min-direct-fit': 0.5,
      'max-activations': 2,
      'cache-entries': 0,
      'cache-ttl-ms': 5000,
    })
    expect(settings).toEqual({
      mode: 'shadow',
      routeAlias: 'gauge-alt',
      timeoutMs: 900,
      maxInputTokens: 2048,
      maxCandidates: 12,
      batchSize: 4,
      maxQueryChars: 512,
      maxMetadataChars: 256,
      minRelevanceIndex: 2.5,
      minDirectFit: 0.5,
      maxActivations: 2,
      cacheEntries: 0,
      cacheTtlMs: 5000,
    })
  })

  it('ignores unknown keys instead of rejecting the section', () => {
    expect(settingsOf({ mode: 'active', 'not-a-real-key': 'whatever' }).mode).toBe('active')
  })

  it('rejects a non-object section', () => {
    expect(rejectedKeys([] as unknown as Record<string, unknown>)).toEqual([SETTINGS_NAMESPACE])
    expect(parseDiscoverySettings('nope')).toMatchObject({ ok: false })
  })
})

describe('mode and route-alias rows', () => {
  it('rejects a mode outside off|shadow|active', () => {
    expect(rejectedKeys({ mode: 'on' })).toEqual(['mode'])
    expect(rejectedKeys({ mode: 1 })).toEqual(['mode'])
  })

  it('rejects an empty or non-string route-alias, and trims a valid one', () => {
    expect(rejectedKeys({ 'route-alias': '' })).toEqual(['route-alias'])
    expect(rejectedKeys({ 'route-alias': '   ' })).toEqual(['route-alias'])
    expect(rejectedKeys({ 'route-alias': 7 })).toEqual(['route-alias'])
    expect(settingsOf({ 'route-alias': ' gauge ' }).routeAlias).toBe('gauge')
  })
})

describe('integer rows reject out-of-range and non-integer values', () => {
  const rows: ReadonlyArray<readonly [string, number, number]> = [
    ['timeout-ms', 100, 5000],
    ['max-input-tokens', 512, 16384],
    ['max-candidates', 1, 128],
    ['batch-size', 1, 16],
    ['max-query-chars', 64, 8192],
    ['max-metadata-chars', 128, 8192],
    ['max-activations', 1, 20],
    ['cache-entries', 0, 1024],
    ['cache-ttl-ms', 0, 300000],
  ]

  for (const [key, min, max] of rows) {
    it(`rejects ${key} below ${min}, above ${max}, and as a non-integer`, () => {
      expect(rejectedKeys({ [key]: min - 1 })).toEqual([key])
      expect(rejectedKeys({ [key]: max + 1 })).toEqual([key])
      expect(rejectedKeys({ [key]: Number.NaN })).toEqual([key])
    })

    it(`accepts the boundary values of ${key}`, () => {
      expect(settingsOf({ [key]: min })[camelOf(key)]).toBe(min)
      expect(settingsOf({ [key]: max })[camelOf(key)]).toBe(max)
    })
  }

  it('rejects a fractional value where an integer is required', () => {
    expect(rejectedKeys({ 'timeout-ms': 1200.5 })).toEqual(['timeout-ms'])
  })

  it('rejects a numeric string', () => {
    expect(rejectedKeys({ 'batch-size': '8' })).toEqual(['batch-size'])
  })

  it('accepts cache-entries 0 (storage disabled) and rejects negatives', () => {
    expect(settingsOf({ 'cache-entries': 0 }).cacheEntries).toBe(0)
    expect(rejectedKeys({ 'cache-entries': -1 })).toEqual(['cache-entries'])
  })
})

describe('threshold rows', () => {
  it('accepts fractional thresholds and rejects out-of-range values', () => {
    expect(settingsOf({ 'min-relevance-index': 0, 'min-direct-fit': 0 })).toMatchObject({
      minRelevanceIndex: 0,
      minDirectFit: 0,
    })
    expect(settingsOf({ 'min-relevance-index': 4, 'min-direct-fit': 1 })).toMatchObject({
      minRelevanceIndex: 4,
      minDirectFit: 1,
    })
    expect(rejectedKeys({ 'min-relevance-index': 4.5 })).toEqual(['min-relevance-index'])
    expect(rejectedKeys({ 'min-relevance-index': -0.5 })).toEqual(['min-relevance-index'])
    expect(rejectedKeys({ 'min-direct-fit': 1.01 })).toEqual(['min-direct-fit'])
    expect(rejectedKeys({ 'min-direct-fit': -0.01 })).toEqual(['min-direct-fit'])
  })

  it('rejects non-finite thresholds', () => {
    expect(rejectedKeys({ 'min-direct-fit': Number.POSITIVE_INFINITY })).toEqual(['min-direct-fit'])
    expect(rejectedKeys({ 'min-relevance-index': Number.NaN })).toEqual(['min-relevance-index'])
  })
})

describe('fail-soft gate: invalid settings never reach the runner', () => {
  it('reports every problem at once, in table order', () => {
    const parsed = parseDiscoverySettings({ 'timeout-ms': 1, 'batch-size': 99, mode: 'on' })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error('unreachable')
    expect(parsed.problems.map(problem => problem.key)).toEqual(['mode', 'timeout-ms', 'batch-size'])
    expect(parsed.problems[1]).toMatchObject({ key: 'timeout-ms', value: 1, expected: 'integer in 100..5000' })
  })

  it('an invalid configuration resolves to undefined, so the caller keeps the lexical path', () => {
    // The shape the wiring layer relies on: `undefined` ⇒ no runner call.
    const runner = vi.fn()
    const settings = resolveDiscoverySettings({ mode: 'active', 'timeout-ms': 5001 })
    if (settings !== undefined) runner()
    expect(settings).toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
  })

  it('a valid configuration resolves to the settings and leaves the runner path open', () => {
    const runner = vi.fn()
    const settings = resolveDiscoverySettings({ mode: 'active' })
    expect(settings).toMatchObject({ mode: 'active', timeoutMs: 1200 })
    if (settings !== undefined && settings.mode !== 'off') runner()
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('renders one operator-facing line naming the namespace and the bad key', () => {
    const message = describeDiscoverySettingsProblems([{ key: 'timeout-ms', value: 1, expected: 'integer in 100..5000' }])
    expect(message).toContain(SETTINGS_NAMESPACE)
    expect(message).toContain('timeout-ms')
    expect(message).toContain('lexical path')
  })
})

describe('warn-once reporting', () => {
  it('warns once for a repeated invalid configuration', () => {
    const warn = vi.fn()
    const reporter = createWarnOnce(warn)
    const raw = { 'timeout-ms': 1 }
    expect(resolveDiscoverySettings(raw, reporter)).toBeUndefined()
    expect(resolveDiscoverySettings(raw, reporter)).toBeUndefined()
    expect(resolveDiscoverySettings({ 'timeout-ms': 1 }, reporter)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('timeout-ms')
  })

  it('warns again when the invalid configuration changes', () => {
    const warn = vi.fn()
    const reporter = createWarnOnce(warn)
    resolveDiscoverySettings({ 'timeout-ms': 1 }, reporter)
    resolveDiscoverySettings({ 'timeout-ms': 2 }, reporter)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('never warns for a valid configuration, and can be reset', () => {
    const warn = vi.fn()
    const reporter = createWarnOnce(warn)
    expect(resolveDiscoverySettings({ mode: 'active' }, reporter)).toBeDefined()
    expect(warn).not.toHaveBeenCalled()
    resolveDiscoverySettings({ 'batch-size': 0 }, reporter)
    reporter.reset()
    resolveDiscoverySettings({ 'batch-size': 0 }, reporter)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

/** camelCase field for a kebab raw key, so the table above stays single-sourced. */
function camelOf(key: string): keyof typeof DEFAULT_DISCOVERY_SETTINGS {
  const [head, ...rest] = key.split('-')
  const camel = `${head ?? ''}${rest.map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('')}`
  return camel as keyof typeof DEFAULT_DISCOVERY_SETTINGS
}
