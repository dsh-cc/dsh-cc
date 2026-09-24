/**
 * Pin for design `docs/plans/2026-09-24-memory-job-silence.md` §5: memory
 * lanes are de-registered from the jobs seam (no registry rows, no notices)
 * while the per-agent disposal guarantee is restored at the right granularity
 * (a per-agent effect that aborts and awaits the fork).
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileSystem } from '@dsh-cc/memory'
import { apply, inject } from '../src/index.ts'
import { startMemoryJob } from '../src/memory-job.ts'

const PROD_MESSAGE = 'tools.restrict() names unknown global tool "structured_output"'

/** Subagent seam that resolves immediately; the run's result is caller-controlled. */
function subagentsWith(result: Promise<unknown>) {
  return {
    calls: [] as Array<{ label?: string; signal: AbortSignal }>,
    async start(_name: string, request: { label?: string; signal: AbortSignal }) {
      this.calls.push(request)
      return { result }
    },
  }
}

/** Minimal fs seam (no writes expected in these paths). */
function fsMock() {
  return {
    async resolve(path: string) { return { targetKey: path, displayPath: path } },
    async stat() { return undefined },
    async readText() { throw new Error('not found') },
    async writeText() { return {} },
    async listDir() { return [] },
  } as unknown as FileSystem
}

/** An agent whose ctx records the per-agent effects startMemoryJob registers. */
function agentWithEffects() {
  const disposers: Array<() => void | Promise<void>> = []
  const agent = {
    options: {},
    session: { events: [], get seq() { return 0 }, snapshotEvents() { return [] }, header: { id: 'session:/ws', cwd: '/ws' } },
    ctx: {
      effect(setup: () => () => void | Promise<void>): () => void {
        const d = setup()
        disposers.push(d)
        return () => { const i = disposers.indexOf(d); if (i >= 0) disposers.splice(i, 1) }
      },
    },
  } as unknown as Agent
  return { agent, disposers }
}

/** An agent with NO ctx (the legacy test fake): effect registration must degrade to a no-op. */
function fakeAgent(): Agent {
  return {
    options: {},
    session: { events: [], get seq() { return 0 }, snapshotEvents() { return [] }, header: { id: 'session:/ws', cwd: '/ws' } },
  } as unknown as Agent
}

function deferred<T>() {
  let resolve!: (v: never) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res as never; reject = rej })
  return { promise, resolve: resolve as (v: unknown) => void, reject }
}

describe('no-registration pin (memory lanes never touch the jobs seam)', () => {
  it('startMemoryJob completes without invoking a jobs service whose start throws', async () => {
    const ctx = new Context()
    const subagents = subagentsWith(Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }))
    ctx.provide('jobs' as never, { start: () => { throw new Error('jobs.start must never be called') } } as never)
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, fsMock() as never)

    const job = await startMemoryJob(ctx, fakeAgent(), '/mem', 'fork', 'extract-memories', 'prompt')
    await expect(job.done).resolves.toEqual({ status: 'completed' })
    expect(await job.settled).toBe(true)
  })

  it('the plugin mounts and spawns with no jobs service at all', async () => {
    expect(inject).not.toContain('jobs')
    const ctx = new Context()
    const subagents = subagentsWith(Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }))
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, fsMock() as never)
    apply(ctx, { memoryHome: '/tmp/mem', dreamEnabled: false })

    const signal = new AbortController().signal
    await ctx.serial('agent/turn-stopping' as never, { agent: fakeAgent(), signal } as never)
    await vi.waitFor(() => expect(subagents.calls.length).toBe(1))
  })
})

describe('per-agent disposal guarantee', () => {
  it('disposing the agent aborts the in-flight fork with the disposal reason and awaits its settle', async () => {
    const ctx = new Context()
    const pending = deferred<unknown>()
    const subagents = subagentsWith(pending.promise)
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, fsMock() as never)
    const { agent, disposers } = agentWithEffects()

    const job = await startMemoryJob(ctx, agent, '/mem', 'fork', 'extract-memories', 'prompt')
    expect(disposers.length).toBe(1)

    // Simulate agent-fiber disposal: run the registered teardown. It aborts
    // immediately but its promise settles only after the job's own settle.
    const teardown = disposers[0]!
    const teardownSettled = Promise.resolve(teardown()).then(() => 'teardown settled')
    expect(subagents.calls[0]!.signal.aborted).toBe(true)
    expect(subagents.calls[0]!.signal.reason).toBe('agent disposed')
    pending.reject(new Error('cancelled'))
    await expect(job.done).resolves.toEqual({ status: 'killed' })
    await expect(teardownSettled).resolves.toBe('teardown settled')
    // The done chain detached the effect: no accumulated disposers.
    expect(disposers.length).toBe(0)
  })

  it('a settled job detached its disposer: agent disposal afterwards does not abort', async () => {
    const ctx = new Context()
    const subagents = subagentsWith(Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }))
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, fsMock() as never)
    const { agent, disposers } = agentWithEffects()

    const job = await startMemoryJob(ctx, agent, '/mem', 'fork', 'extract-memories', 'prompt')
    await expect(job.done).resolves.toEqual({ status: 'completed' })
    // The done chain invoked the disposer: no accumulated no-op effects.
    await expect(job.settled).resolves.toBe(true)
    expect(disposers.length).toBe(0)
  })
})
