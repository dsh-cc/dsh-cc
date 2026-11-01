/**
 * F-2 drift guard: the live-capacity refusal copy is ONE runtime literal shared
 * by the spawn lanes (`@dsh-cc/subagent-task`) and the continuation gate
 * (`@dsh-cc/subagent-resume-pins`). This test pins byte equality so the
 * user-visible remedy cannot drift apart, and pins that the cap itself agrees.
 */
import { describe, expect, it } from 'vitest'
import {
  LIVE_CAPACITY_REFUSAL as TASK_REFUSAL,
  MAX_LIVE_CONTINUABLE_CHILDREN as TASK_MAX,
  capacityErrorRefusal,
} from '../src/background-start.ts'
import {
  LIVE_CAPACITY_REFUSAL as PINS_REFUSAL,
  MAX_LIVE_CONTINUABLE_CHILDREN as PINS_MAX,
} from '@dsh-cc/subagent-resume-pins'

describe('live-capacity refusal copy', () => {
  it('is byte-identical between the spawn lanes and the continuation gate', () => {
    expect(PINS_REFUSAL).toBe(TASK_REFUSAL)
  })

  it('agrees on the cap value', () => {
    expect(PINS_MAX).toBe(TASK_MAX)
    expect(TASK_MAX).toBe(25)
  })

  it('describes the resident-cap rule and names the remedy', () => {
    // rc.5 residency semantics: running children, idle parents waiting on
    // children, and cold-resumed children hold slots; resident follow-ups do not.
    expect(TASK_REFUSAL).toContain('25 resident subagents')
    expect(TASK_REFUSAL).toContain('release_agent')
    expect(TASK_REFUSAL).toContain('cold-resumed')
    expect(TASK_REFUSAL).toContain('already-resident')
  })

  it('a pool ACTIVATION_LIMIT_REACHED throw maps onto that exact literal', () => {
    // rc.5: the capacity DECISION belongs to the harness pool; the dsh-cc
    // lanes only translate its bare throw into the D4 remedy copy.
    const poolError = Object.assign(
      new Error('subagent limit reached (active child limit: 25); wait for an existing child to finish or complete this work with the current agents'),
      { code: 'ACTIVATION_LIMIT_REACHED' },
    )
    const mapped = capacityErrorRefusal(poolError)
    expect(mapped?.message).toBe(TASK_REFUSAL)
    expect(capacityErrorRefusal(new Error('some other failure'))).toBeUndefined()
  })
})