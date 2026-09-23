/**
 * Dispatch regression for the dream lane (§5.3): a fake SubagentService.start
 * that simulates the harness `tools.restrict()` contract drives
 * `startMemoryJob` end-to-end. Post-fix MEMORY_TOOL_FILTER is already the
 * reduced list, so the first test forces the drift (first attempt throws the
 * exact production message) to exercise the helper's warn+retry path; the
 * second asserts that a retry that still fails propagates to the dream-side
 * dispatch-throw catch after exactly one retry.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@dsh-cc/memory'
import { startMemoryJob } from '../src/memory-job.ts'
import { resetRestrictWarnState } from '@dsh-cc/memory'

const PROD_MESSAGE = 'tools.restrict() names unknown global tool "structured_output"; known global tools: read, grep, glob, read_image'

/** The host restrict contract: allow-listed non-global names throw exactly like the harness. */
const GLOBAL_TOOLS = ['read', 'read_image', 'grep', 'glob']
function restrictAwareSubagents(firstAttemptThrows: boolean) {
  const calls: Array<{ toolFilter?: { allow?: readonly string[] } }> = []
  return {
    calls,
    async start(_name: string, request: { toolFilter?: { allow?: readonly string[] } }) {
      const attempt = calls.length
      calls.push(request)
      // First attempt simulates the drift the helper exists for (post-fix the
      // shipped filter is already reduced; the fake forces the throw so the
      // retry path stays covered end-to-end).
      if (firstAttemptThrows && attempt === 0) throw new Error(PROD_MESSAGE)
      const unknown = (request.toolFilter?.allow ?? []).filter(n => !GLOBAL_TOOLS.includes(n))
      if (unknown.length > 0) {
        throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"; known global tools: ${GLOBAL_TOOLS.join(', ')}`)
      }
      return { result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }
    },
  }
}

function fakeAgent(): Agent {
  const events: unknown[] = []
  return {
    options: {},
    session: {
      events,
      get seq() { return events.length },
      snapshotEvents() { return events },
      header: { id: 'session:/ws', cwd: '/ws' },
    },
  } as unknown as Agent
}

/** Minimal fs seam: records writeText targets. */
function makeFsMock() {
  const writes: Array<[string, string]> = []
  return {
    writes,
    async resolve(path: string) { return { targetKey: path, displayPath: path } },
    async stat() { return undefined },
    async readText() { throw new Error('not found') },
    async writeText(target: unknown, content: string) {
      writes.push([String((target as { targetKey: unknown }).targetKey), content])
      return {}
    },
    async listDir() { return [] },
  } as unknown as FileSystem & { writes: Array<[string, string]> }
}

const agent = fakeAgent()

beforeEach(() => {
  resetRestrictWarnState()
})

describe('startMemoryJob dispatch resilience (dream lane)', () => {
  it('dispatches after one reduced-filter retry and reaches write-back', async () => {
    const ctx = new Context()
    const subagents = restrictAwareSubagents(true)
    const fs = makeFsMock()
    ctx.provide('jobs' as never, { start: vi.fn() } as never)
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, fs as never)

    const job = await startMemoryJob(ctx, agent, '/mem', 'fork', 'dream', 'prompt')
    const outcome = await job.done
    expect(outcome).toEqual({ status: 'completed' })
    expect(await job.settled).toBe(true)
    // Exactly one retry, carrying the reduced (host-restrictable) filter.
    expect(subagents.calls).toHaveLength(2)
    expect(subagents.calls[1]!.toolFilter?.allow).toEqual(['read', 'read_image', 'grep', 'glob'])
    expect(subagents.calls[1]!.toolFilter?.allow).not.toContain('structured_output')
  })

  it('propagates to the dispatch-throw catch after a single retry when the retry also fails', async () => {
    const ctx = new Context()
    const subagents = restrictAwareSubagents(false)
    // This deployment restricts even the reduced filter: every attempt throws.
    subagents.start = async (_name: string, request: { toolFilter?: { allow?: readonly string[] } }) => {
      subagents.calls.push(request)
      throw new Error(PROD_MESSAGE.replace('structured_output', 'read'))
    }
    ctx.provide('jobs' as never, { start: vi.fn() } as never)
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, makeFsMock() as never)

    // The rejection ESCAPES startMemoryJob (this is the input the dream-side
    // catch turns into phase `dispatch-throw`), after exactly one retry.
    await expect(startMemoryJob(ctx, agent, '/mem', 'fork', 'dream', 'prompt')).rejects.toThrow('tools.restrict()')
    expect(subagents.calls).toHaveLength(2)
  })
})
