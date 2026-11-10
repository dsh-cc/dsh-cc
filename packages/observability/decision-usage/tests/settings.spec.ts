/**
 * Settings parse tests (design C2/C5): the tri-state contract — `absent` keeps
 * defaults, `valid` carries the parsed section, and `invalid` fails the WHOLE
 * section closed. The retired `capabilities` table fails closed loudly (a
 * config written against it must never silently run unpinned), while route ROW
 * content is left to the resolver.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DECISION_SETTINGS,
  DEFAULT_MAX_ATTEMPTS_PER_SESSION,
  DEFAULT_MAX_RETRIES,
  decisionMaxRetries,
  decisionSessionLimits,
  decisionSettingsOf,
  parseDecisionSettings,
} from '../src/settings.ts'

function section(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'max-attempts-per-session': 10,
    'max-input-tokens-per-session': 100_000,
    'max-output-tokens-per-session': 10_000,
    'max-retries': 0,
    'ledger-max-bytes': 1_048_576,
    ...over,
  }
}

describe('tri-state parse', () => {
  it('an absent section is absent, never a silently defaulted section', () => {
    expect(parseDecisionSettings(undefined)).toEqual({ status: 'absent' })
  })

  it('a valid section keeps its quota keys and routes', () => {
    const parsed = parseDecisionSettings(section({ routes: { gauge: { revision: 'rev-1' } } }))
    expect(parsed.status).toBe('valid')
    if (parsed.status !== 'valid') return
    expect(parsed.settings['max-attempts-per-session']).toBe(10)
    expect(parsed.settings.routes).toEqual({ gauge: { revision: 'rev-1' } })
  })

  it('routes defaults to an empty dict when the key is absent', () => {
    const parsed = parseDecisionSettings(section())
    expect(parsed.status).toBe('valid')
    expect(decisionSettingsOf(parsed)?.routes).toEqual({})
  })

  it('route ROW content is not judged here (per-alias, at resolution time)', () => {
    const parsed = parseDecisionSettings(section({ routes: { gauge: { 'per-request-tokens': 0 } } }))
    expect(parsed.status).toBe('valid')
    expect(decisionSettingsOf(parsed)?.routes).toEqual({ gauge: { 'per-request-tokens': 0 } })
  })
})

describe('invalid sections fail closed', () => {
  it('every malformed quota key invalidates the section', () => {
    const invalid: Record<string, unknown>[] = [
      section({ 'max-attempts-per-session': -1 }),
      section({ 'max-attempts-per-session': 1.5 }),
      section({ 'max-input-tokens-per-session': 'many' }),
      section({ 'max-output-tokens-per-session': null }),
      section({ 'max-retries': 3 }),
      section({ 'ledger-max-bytes': 1 }),
    ]
    for (const raw of invalid) expect(parseDecisionSettings(raw)).toEqual({ status: 'invalid' })
  })

  it('routes must be a plain object when present', () => {
    for (const routes of [[], 'gauge', 7, null]) {
      expect(parseDecisionSettings(section({ routes }))).toEqual({ status: 'invalid' })
    }
  })

  it('a non-object section is invalid, never absent', () => {
    for (const raw of [null, 7, 'section', []]) expect(parseDecisionSettings(raw)).toEqual({ status: 'invalid' })
  })

  it('a leftover non-empty capabilities table fails the section closed', () => {
    const legacy = section({ capabilities: [{ provider: 'pi', model: 'm' }] })
    expect(parseDecisionSettings(legacy)).toEqual({ status: 'invalid' })
    // Not an array at all is equally invalid.
    expect(parseDecisionSettings(section({ capabilities: {} }))).toEqual({ status: 'invalid' })
    expect(parseDecisionSettings(section({ capabilities: undefined }))).toEqual({ status: 'invalid' })
  })

  it('an empty leftover capabilities array is tolerated (inert)', () => {
    expect(parseDecisionSettings(section({ capabilities: [] })).status).toBe('valid')
  })
})

describe('valid-or-absent adapters', () => {
  it('decisionSettingsOf drops absent and invalid sections', () => {
    expect(decisionSettingsOf({ status: 'absent' })).toBeUndefined()
    expect(decisionSettingsOf({ status: 'invalid' })).toBeUndefined()
    expect(decisionSettingsOf({ status: 'valid', settings: DEFAULT_DECISION_SETTINGS })).toBe(DEFAULT_DECISION_SETTINGS)
  })

  it('quota limits and retries fall back to ship defaults when absent', () => {
    const limits = decisionSessionLimits(undefined)
    expect(limits.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS_PER_SESSION)
    expect(decisionMaxRetries(undefined)).toBe(DEFAULT_MAX_RETRIES)
  })

  it('quota limits read a valid section verbatim', () => {
    const parsed = decisionSettingsOf(parseDecisionSettings(section()))
    expect(decisionSessionLimits(parsed)).toEqual({
      maxAttempts: 10,
      maxInputTokens: 100_000,
      maxOutputTokens: 10_000,
      ledgerMaxBytes: 1_048_576,
    })
    expect(decisionMaxRetries(parsed)).toBe(0)
  })
})
