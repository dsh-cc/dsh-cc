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

describe('frozen cascade sections (issue #373)', () => {
  /** Deep-freeze the resolved shape the cascade read-through actually serves. */
  function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === 'object') {
      Object.freeze(value)
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    }
    return value
  }

  it('a deep-frozen section with a non-empty routes dict parses valid (the regression)', () => {
    const frozen = deepFreeze(structuredClone(section({ routes: { gauge: { 'max-output-tokens': 4096 } } })))
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen((frozen as Record<string, { routes: unknown }>).routes)).toBe(true)
    const parsed = parseDecisionSettings(frozen)
    expect(parsed.status).toBe('valid')
    if (parsed.status !== 'valid') return
    expect(parsed.settings.routes).toEqual({ gauge: { 'max-output-tokens': 4096 } })
  })

  it('a rule-invalid frozen section stays invalid (freeze never masks rules)', () => {
    const frozen = deepFreeze(structuredClone(section({ 'max-retries': 'nope' as unknown as number })))
    expect(parseDecisionSettings(frozen).status).toBe('invalid')
  })

  it('freeze-equivalence: parse(x) deep-equals parse(deepFreeze(x)) for representative inputs', () => {
    const inputs: unknown[] = [
      undefined,
      section(),
      section({ routes: { gauge: { 'max-output-tokens': 4096 } } }),
      section({ routes: { gauge: null } }),
      section({ routes: { gauge: { 'per-request-tokens': 0 }, other: { revision: 'r' } } }),
      section({ unknownExtra: 'kept' }),
      section({ 'max-retries': 'nope' as unknown as number }),
      section({ capabilities: { any: true } }),
      'not-an-object',
    ]
    for (const input of inputs) {
      const unfrozen = structuredClone(input)
      const frozen = deepFreeze(structuredClone(input))
      expect(parseDecisionSettings(frozen)).toEqual(parseDecisionSettings(unfrozen))
    }
  })

  it('parse never writes into the caller object', () => {
    const input = structuredClone(section({ routes: { gauge: { 'max-output-tokens': 4096 } } }))
    const before = structuredClone(input)
    parseDecisionSettings(input)
    expect(input).toEqual(before)
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
    // Type faults carry 'quota-key-type'; range/step faults surface through
    // the schema itself as 'schema'. Every case carries a reason either way.
    for (const raw of invalid) {
      const parsed = parseDecisionSettings(raw)
      expect(parsed.status).toBe('invalid')
      if (parsed.status === 'invalid') expect(typeof parsed.reason).toBe('string')
    }
    expect(parseDecisionSettings(section({ 'max-retries': 'nope' as unknown as number }))).toEqual({ status: 'invalid', reason: 'quota-key-type' })
  })

  it('routes must be a plain object when present', () => {
    for (const routes of [[], 'gauge', 7, null]) {
      expect(parseDecisionSettings(section({ routes }))).toEqual({ status: 'invalid', reason: 'routes-shape' })
    }
  })

  it('a non-object section is invalid, never absent', () => {
    for (const raw of [null, 7, 'section', []]) expect(parseDecisionSettings(raw)).toEqual({ status: 'invalid', reason: 'not-an-object' })
  })

  it('a leftover non-empty capabilities table fails the section closed', () => {
    const legacy = section({ capabilities: [{ provider: 'pi', model: 'm' }] })
    expect(parseDecisionSettings(legacy)).toEqual({ status: 'invalid', reason: 'legacy-capabilities' })
    // Not an array at all is equally invalid.
    expect(parseDecisionSettings(section({ capabilities: {} }))).toEqual({ status: 'invalid', reason: 'legacy-capabilities' })
    expect(parseDecisionSettings(section({ capabilities: undefined }))).toEqual({ status: 'invalid', reason: 'legacy-capabilities' })
  })

  it('an empty leftover capabilities array is tolerated (inert)', () => {
    expect(parseDecisionSettings(section({ capabilities: [] })).status).toBe('valid')
  })
})

describe('valid-or-absent adapters', () => {
  it('decisionSettingsOf drops absent and invalid sections', () => {
    expect(decisionSettingsOf({ status: 'absent' })).toBeUndefined()
    expect(decisionSettingsOf({ status: 'invalid', reason: 'schema' })).toBeUndefined()
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
