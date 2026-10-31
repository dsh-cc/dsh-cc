/**
 * Dispatch contract for the dream lane at rc.5: `startMemoryJob` drives
 * `subagents.startActivation` (provider 'fork', delivery 'caller', the
 * outputSchema contract) end-to-end. The pre-rc.5 restrict-resilience helper
 * (warn + reduced-filter retry) was removed with the rc.5 migration — its
 * only trigger (a `tools.restrict()` throw on a toolFilter passed through
 * `subagents.start`) cannot occur once nothing passes toolFilter through the
 * start request — so these tests pin what replaced it: result collection,
 * the one-shot dispose policy, and job-abort semantics.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@dsh-cc/memory'
import { startMemoryJob } from '../src/memory-job.ts'

interface ActivationSpec {
  provider: string
  label: string
  request: Record<string, unknown>
  signal: AbortSignal
  delivery: string
}

/** Activation-shaped fake seam: records specs, returns caller-controlled result; counts disposals. */
function activationSubagents(result: Promise<unknown>) {
  const calls: ActivationSpec[] = []
  let disposed = 0
  return {
    calls,
    get disposed() { return disposed },
    async startActivation(spec: ActivationSpec) {
      calls.push(spec)
      return {
        childId: 'job-child',
        messageId: 'job-m',
        result,
        dispose: () => { disposed++; return Promise.resolve() },
      }
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

describe('startMemoryJob dispatch (rc.5 activation contract)', () => {
  it('dispatches provider/label/schema through startActivation and reaches write-back, then disposes the one-shot fork', async () => {
    const ctx = new Context()
    const subagents = activationSubagents(Promise.resolve({ structured: { writes: [{ path: 'topic-a.md', content: 'fact\n' }] }, stopReason: 'completed' }))
    const fs = makeFsMock()
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, fs as never)

    const job = await startMemoryJob(ctx, agent, '/mem', 'fork', 'dream', 'prompt')
    const outcome = await job.done
    expect(outcome).toEqual({ status: 'completed' })
    expect(await job.settled).toBe(true)
    expect(subagents.calls).toHaveLength(1)
    const spec = subagents.calls[0]!
    expect(spec.provider).toBe('fork')
    expect(spec.label).toBe('dream')
    expect(spec.delivery).toBe('caller')
    expect(spec.request['maxDepth']).toBe(1)
    expect(spec.request['outputSchema']).toBeDefined()
    // rc.5: no toolFilter on the start request (composition seam applies it).
    expect(spec.request['toolFilter']).toBeUndefined()
    // One-shot dispose policy: the settled fork must not stay resident.
    expect(subagents.disposed).toBe(1)
  })

  it('propagates a startActivation throw unchanged (the dream-side catch turns it into dispatch-throw)', async () => {
    const ctx = new Context()
    const subagents = {
      calls: [] as ActivationSpec[],
      async startActivation(spec: ActivationSpec) {
        this.calls.push(spec)
        throw new Error('boom')
      },
    }
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, makeFsMock() as never)

    await expect(startMemoryJob(ctx, agent, '/mem', 'fork', 'dream', 'prompt')).rejects.toThrow('boom')
    expect(subagents.calls).toHaveLength(1)
  })

  it('abort() kills the running fork through dispose and resolves killed', async () => {
    const ctx = new Context()
    const pending = Promise.withResolvers<never>()
    const subagents = activationSubagents(pending.promise)
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, makeFsMock() as never)

    const job = await startMemoryJob(ctx, agent, '/mem', 'fork', 'dream', 'prompt')
    expect(subagents.disposed).toBe(0)
    job.abort('test kill')
    // The activation signal covers pre-publication only at rc.5; the execution
    // abort goes through dispose — and the pre-publication signal still fires.
    expect(subagents.disposed).toBe(1)
    expect(subagents.calls[0]!.signal.aborted).toBe(true)
    pending.reject(new Error('cancelled'))
    await expect(job.done).resolves.toEqual({ status: 'killed' })
  })
})
