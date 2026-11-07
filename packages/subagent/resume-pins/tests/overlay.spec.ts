/**
 * Pure pin-application matrix (harness-0.2.2 D3.5-form): `pinnedSelectionOf`
 * computes the provider/model/effort triple the spawn/resume path selects
 * DURABLY at child publication (presence semantics; the gate-evaluated
 * `resume.overlay` tuple wins; blocked pins yield undefined). The request
 * waterfall keeps ONLY `maxTokens` (`applyPinnedMaxTokens`), still with
 * presence semantics (a pinned `null` is REMOVED — asserted absent, not
 * null) and never throwing (the fail-closed duty moved to the pre-spawn
 * gate).
 */
import { describe, expect, it } from 'vitest'
import { applyPinnedMaxTokens, pinnedSelectionOf } from '../src/overlay.ts'
import type { ResumePin } from '../src/pin.ts'

function makePin(overrides: Partial<ResumePin> = {}): ResumePin {
  return {
    version: 1,
    childId: 'child-1',
    parentSessionId: 'parent',
    label: 'research',
    mode: 'continuable-background',
    createdAt: '2026-09-04T00:00:00.000Z',
    definition: { kind: 'plain' },
    modelSelector: { raw: 'inherit', via: 'inherit' },
    effective: {
      provider: 'mock',
      model: 'mock',
      reasoningEffort: 'high',
      maxTokens: 5555,
      complete: true,
    },
    toolFilter: { allow: [], deny: [] },
    workspace: { cwd: '/ws', gitDir: '.git', gitCommonDir: '.git', branch: 'main' },
    resume: { state: 'ok' },
    ...overrides,
  }
}

describe('pinnedSelectionOf — the durable spawn/resume tuple (D3.5)', () => {
  it('a complete pin carries provider/model/effort (maxTokens is NOT a selection field)', () => {
    expect(pinnedSelectionOf(makePin())).toEqual({ provider: 'mock', model: 'mock', reasoningEffort: 'high' })
  })

  it('omits the effort for a pinned null (absence follows adapter defaults)', () => {
    const pin = makePin({ effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true } })
    expect(pinnedSelectionOf(pin)).toEqual({ provider: 'mock', model: 'mock' })
  })

  it('the gate-evaluated resume.overlay tuple wins over the pinned effective tuple', () => {
    const pin = makePin({
      resume: {
        state: 'ok',
        overlay: { provider: 'mock2', model: 'mock2', reasoningEffort: null, maxTokens: 999 },
      },
    })
    expect(pinnedSelectionOf(pin)).toEqual({ provider: 'mock2', model: 'mock2' })
  })

  it('a blocked pin yields undefined (the pre-spawn gate owns the visible failure)', () => {
    const pin = makePin({ resume: { state: 'blocked', reason: '[WORKSPACE_MISSING] gone' } })
    expect(pinnedSelectionOf(pin)).toBeUndefined()
  })
})

describe('applyPinnedMaxTokens — the surviving request-field overlay', () => {
  it('sets a pinned maxTokens on a shallow copy (input untouched)', () => {
    const resolved = { provider: 'other', model: 'other', maxTokens: 1 }
    const out = applyPinnedMaxTokens(resolved, makePin())
    expect(out).toEqual({ provider: 'other', model: 'other', maxTokens: 5555 })
    expect(resolved).toEqual({ provider: 'other', model: 'other', maxTokens: 1 })
  })

  it('REMOVES the key for a complete pin whose maxTokens is null', () => {
    const pin = makePin({ effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true } })
    // 0.2.2 (D3.5): presence semantics apply to BOTH surviving fields — a
    // complete pin with a null effort also strips an injected effort key.
    const out = applyPinnedMaxTokens({ provider: 'x', model: 'x', maxTokens: 99, reasoningEffort: 'low' }, pin)
    expect(out).toEqual({ provider: 'x', model: 'x' })
    expect(out).not.toHaveProperty('maxTokens')
    expect(out).not.toHaveProperty('reasoningEffort')
  })

  it('a degraded pin (complete:false) with a null maxTokens touches nothing', () => {
    const pin = makePin({ effective: { provider: 'mock', model: 'mock', reasoningEffort: 'high', maxTokens: null, complete: false } })
    const resolved = { provider: 'x', model: 'x', maxTokens: 42 }
    expect(applyPinnedMaxTokens(resolved, pin)).toBe(resolved)
  })

  it('the gate-evaluated overlay maxTokens wins (null overlay REMOVES the key)', () => {
    const pin = makePin({
      resume: {
        state: 'ok',
        overlay: { provider: 'mock2', model: 'mock2', reasoningEffort: null, maxTokens: 777 },
      },
    })
    expect(applyPinnedMaxTokens({ maxTokens: 1 }, pin)).toEqual({ maxTokens: 777 })
    const nullPin = makePin({
      resume: {
        state: 'ok',
        overlay: { provider: 'mock2', model: 'mock2', reasoningEffort: null, maxTokens: null },
      },
    })
    expect(applyPinnedMaxTokens({ maxTokens: 1 }, nullPin)).not.toHaveProperty('maxTokens')
  })

  it('a blocked pin contributes nothing (never throws — the gate owns fail-closed)', () => {
    const pin = makePin({ resume: { state: 'blocked', reason: '[WORKSPACE_MISSING] gone' } })
    const resolved = { maxTokens: 1 }
    expect(applyPinnedMaxTokens(resolved, pin)).toBe(resolved)
  })
})
