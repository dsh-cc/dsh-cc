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
  assertLiveCapacity,
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

  it('names the remedy and the slot rule', () => {
    expect(TASK_REFUSAL).toContain('25 live subagents')
    expect(TASK_REFUSAL).toContain('release_agent')
    expect(TASK_REFUSAL).toContain('only running children hold slots')
  })

  it('the spawn guard still throws that exact literal at the cap', async () => {
    const running = Array.from({ length: TASK_MAX }, (_, i) => ({ id: `spawned-${i}` }))
    const seam = { listChildren: async () => running }
    const parent = {
      id: 'parent-1',
      ctx: { get: () => ({ get: (id: string) => ({ status: id.startsWith('spawned-') ? 'running' : 'idle' }) }) },
    }
    await expect(
      assertLiveCapacity(seam as never, parent as never, new AbortController().signal),
    ).rejects.toThrow(TASK_REFUSAL)
  })
})
