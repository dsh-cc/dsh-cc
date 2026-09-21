/**
 * Mock-script tier composition specs (plan §3.2): scripted runs through the
 * REAL plugin stack with a MockAdapter standing in only for the LLM.
 * Asserts the wiring via the feature-owned foldCounters + capability.ok,
 * exactly as the bin `check` gate consumes them.
 */
import { describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMockTask } from '../src/mock-run.ts'
import type { TaskDescriptor } from '../src/corpus.ts'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

function descriptor(partial: Partial<TaskDescriptor>): TaskDescriptor {
  return { id: 'unknown', kind: 'mock-script', prompt: 'work the plan', ...partial } as TaskDescriptor
}

describe('mock tier runner (real plugin stack, scripted model)', () => {
  it('ccr fires: big tool output compresses → ccr.applied >= 1', async () => {
    const vector = await runMockTask(descriptor({
      id: 'mock/ccr-fires',
      counters: { expect: { 'ccr.applied': '>=1' } },
    }))
    expect(vector.capability?.ok).toBe(true)
    expect(vector.counters['ccr.applied']).toBeGreaterThanOrEqual(1)
  })

  it('ccr control: small output below min-bytes → ccr.applied = 0', async () => {
    const vector = await runMockTask(descriptor({
      id: 'mock/ccr-control',
      counters: { expect: { 'ccr.applied': '=0' } },
    }))
    expect(vector.capability?.ok).toBe(true)
    expect(vector.counters['ccr.applied']).toBe(0)
  })

  it('costgate fires: armed boundary at idle → gate row, compaction attempts E2E', async () => {
    const vector = await runMockTask(descriptor({
      id: 'mock/costgate-fires',
      counters: { expect: { 'costgate.gate': '>=1', 'costgate.compacted': '>=1' } },
    }))
    expect(vector.capability?.ok).toBe(true)
    expect(vector.counters['costgate.gate']).toBeGreaterThanOrEqual(1)
  })

  it('costgate control: gate evaluated but inequality fails → no compaction', async () => {
    const vector = await runMockTask(descriptor({
      id: 'mock/costgate-control',
      counters: { expect: { 'costgate.gate': '>=1', 'costgate.compacted': '=0' } },
    }))
    expect(vector.capability?.ok).toBe(true)
    expect(vector.counters['costgate.gate']).toBeGreaterThanOrEqual(1)
    expect(vector.counters['costgate.compacted']).toBe(0)
  })

  it('unknown mock id → loud error', async () => {
    await expect(runMockTask(descriptor({ id: 'mock/nope' }))).rejects.toThrow(/no mock scenario/i)
  })

  it('committed corpus descriptors load', async () => {
    const { loadCorpusDir } = await import('../src/corpus.ts')
    const tasks = loadCorpusDir(join(PKG_DIR, 'corpus', 'mock'))
    expect(tasks.map((t) => t.id).sort()).toEqual([
      'mock/ccr-control', 'mock/ccr-fires', 'mock/costgate-control', 'mock/costgate-fires',
    ])
  })
})
