/**
 * rc.5 removal guard: `restrict-resilience.ts` (startWithFilterResilience +
 * warn-once retry) was deleted — its only trigger was a `tools.restrict()`
 * throw on a toolFilter passed through `subagents.start`, and the rc.5 seam
 * carries no toolFilter on start requests (composition owns restriction).
 * File deletion was blocked by session permissions, so the module was gutted
 * in place; this suite pins the removal (a re-added export fails loudly).
 */
import { describe, expect, it } from 'vitest'
import * as memoryIndex from '../src/index.ts'
import * as removedModule from '../src/restrict-resilience.ts'

describe('restrict-resilience removal (rc.5)', () => {
  it('the helper exports are gone from the package and the module', () => {
    expect('startWithFilterResilience' in memoryIndex).toBe(false)
    expect('resetRestrictWarnState' in memoryIndex).toBe(false)
    expect('harvestUnknownToolNames' in memoryIndex).toBe(false)
    expect(Object.keys(removedModule)).toEqual([])
  })
})
