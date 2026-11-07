/**
 * Tests for `stampedEffortOf`: read the alias-stamped reasoning effort off a
 * child agent's options. Since harness-0.2.2 (D3.6) the stamp is applied
 * DURABLY at child publication (`subagent/start` → `agent.model.select`),
 * replacing the request-time overlay the upstream model-identity guard now
 * rejects; the wire-level regression live in integration.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { stampedEffortOf } from '../src/effort.ts'

describe('stampedEffortOf', () => {
  it('reads a non-empty string stamp off agent options', () => {
    expect(stampedEffortOf({ provider: 'mock', model: 'm', reasoningEffort: 'max' })).toBe('max')
  })

  it('returns undefined for absent, blank, or non-string stamps', () => {
    expect(stampedEffortOf({ provider: 'mock', model: 'm' })).toBeUndefined()
    expect(stampedEffortOf({ reasoningEffort: '' })).toBeUndefined()
    expect(stampedEffortOf({ reasoningEffort: 3 })).toBeUndefined()
    expect(stampedEffortOf(undefined)).toBeUndefined()
    expect(stampedEffortOf(null)).toBeUndefined()
  })
})
