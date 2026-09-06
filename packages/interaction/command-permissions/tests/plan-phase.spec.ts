/**
 * planPhaseOf contract: pending-aware plan lifecycle, mirroring the upstream
 * plan projection unit's wire view
 * (deepseek-harness/packages/plan/plan-mode/src/index.ts, stateVersion 2):
 *   pending ⇔ (running?.wanted ?? wanted) !== null && !== active
 * with a session-log fold fallback when no projection registry is composed.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { planPhaseOf, type PlanUnitStateLike } from '@dsh-cc/command-permissions'

const planEvent = (active: boolean): SessionEvent =>
  ({ type: 'plan/mode', data: { active } }) as unknown as SessionEvent

const state = (
  active: boolean,
  wanted: boolean | null,
  running: boolean | null = null,
): PlanUnitStateLike => ({
  active,
  wanted,
  running: running === null ? null : { wanted: running },
})

describe('planPhaseOf', () => {
  describe('fold fallback (no projection registry)', () => {
    it('is off on an empty log', () => {
      expect(planPhaseOf([], undefined)).toBe('off')
    })
    it('is on when the last plan/mode event activated plan', () => {
      expect(planPhaseOf([planEvent(true)], undefined)).toBe('on')
    })
    it('is off when the last plan/mode event deactivated plan', () => {
      expect(planPhaseOf([planEvent(true), planEvent(false)], undefined)).toBe('off')
    })
  })

  describe('projection-driven phases', () => {
    it('is off for a settled inactive state', () => {
      expect(planPhaseOf([], state(false, null))).toBe('off')
    })
    it('is on for a settled active state', () => {
      expect(planPhaseOf([], state(true, null))).toBe('on')
    })
    it('is entering when an entry intent is pending', () => {
      expect(planPhaseOf([], state(false, true))).toBe('entering')
    })
    it('is leaving when an exit intent is pending', () => {
      expect(planPhaseOf([], state(true, false))).toBe('leaving')
    })
    it('lets the in-flight command (running) override the settled wanted', () => {
      expect(planPhaseOf([], state(false, null, true))).toBe('entering')
      expect(planPhaseOf([], state(true, true, false))).toBe('leaving')
    })
    it('treats a wanted equal to active as settled, not pending', () => {
      expect(planPhaseOf([], state(true, true))).toBe('on')
      expect(planPhaseOf([], state(false, false))).toBe('off')
    })
    it('trusts the projection over the log when both are present', () => {
      // The projection folds the same log plus replayed command/run pairs;
      // when composed it is the authoritative read.
      expect(planPhaseOf([planEvent(true)], state(false, true))).toBe('entering')
      expect(planPhaseOf([], state(true, null))).toBe('on')
    })
  })
})
