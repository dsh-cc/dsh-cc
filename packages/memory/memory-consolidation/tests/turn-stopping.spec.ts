import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import { buildConsolidationPrompt } from '../src/prompts.ts'
import { MEMORY_AGENT_TOOLS } from '../src/tools.ts'
import { MEMORY_WRITES_SCHEMA } from '../src/index.ts'

/**
 * Regression coverage for the turn-stopping listener. Upstream
 * `Subagents.start` is async (`Promise<SubagentRun>`), so every mock here is
 * async too — a synchronous mock is exactly what let the missing `await` on
 * `run.result` ship as "Cannot read properties of undefined (reading 'then')"
 * at the end of every turn.
 */

function fakeAgent(cwd: string, depth = 0): Agent {
  const events: unknown[] = []
  return {
    options: depth < 0 ? { subagentDepth: -1 } : {},
    session: {
      events,
      // Upstream >=0.1.3 session face: seq (next append position, so it
      // tracks growth) and snapshotEvents() instead of direct iteration.
      get seq() { return events.length },
      snapshotEvents() { return events },
      header: {
        id: `session:${cwd}`,
        cwd,
        ...depth > 0 ? { delegationDepth: depth } : {},
      },
    },
  } as unknown as Agent
}

/** A minimal filesystem seam: absent lock by default, seedable via `seed`. */
function makeFsMock(seed: Record<string, string> = {}) {
  const backing = new Map(Object.entries(seed))
  const stat = vi.fn(async (target: unknown) => {
    const key = String((target as { targetKey: unknown }).targetKey)
    const c = backing.get(key)
    return c === undefined ? undefined : { version: 'v1', type: 'file', size: c.length }
  })
  const readText = vi.fn(async (target: unknown) => {
    const key = String((target as { targetKey: unknown }).targetKey)
    const c = backing.get(key)
    if (c === undefined) throw new Error('not found')
    return c
  })
  return {
    backing,
    stat,
    readText,
    async resolve(path: string) { return { targetKey: path, displayPath: path } },
    async writeText(target: unknown, content: string) {
      backing.set(String((target as { targetKey: unknown }).targetKey), content)
      return {}
    },
    async listDir(target: unknown) {
      const root = String((target as { targetKey: unknown }).targetKey)
      const out: Array<{ name: string; type: 'file' }> = []
      for (const key of backing.keys()) {
        if (key.startsWith(`${root}/`) && !key.slice(root.length + 1).includes('/')) {
          out.push({ name: key.slice(root.length + 1), type: 'file' })
        }
      }
      return out
    },
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function mount(config: { memoryHome: string; dreamEnabled?: boolean; extractEnabled?: boolean; fs?: unknown; sessions?: unknown }) {
  const ctx = new Context()
  const jobs = { start: vi.fn() }
  const subagents = { start: vi.fn() }
  const fs = config.fs ?? makeFsMock()
  const sessions = config.sessions ?? { list: vi.fn(() => []) }
  // Provide on the root context so the plugin under test (mounted on the same
  // root) sees the services through ctx.get.
  ctx.provide('jobs' as never, jobs as never)
  ctx.provide('subagents' as never, subagents as never)
  ctx.provide('fs' as never, fs as never)
  ctx.provide('sessions' as never, sessions as never)
  apply(ctx, config)
  return { ctx, jobs, subagents, fs, sessions }
}

/** Dispatch turn-stopping the way the agent loop does: serially, awaiting listeners. */
async function stopTurn(ctx: Context, agent: Agent): Promise<void> {
  const signal = new AbortController().signal
  await ctx.serial('agent/turn-stopping' as never, { agent, signal } as never)
}

/** Count subagent starts with a given label. */
function startsWithLabel(subagents: { start: ReturnType<typeof vi.fn> }, label: string): number {
  return subagents.start.mock.calls.filter((c) => c[1]?.label === label).length
}

/** The done/cancel control captured on a jobs.start call with the given label. */
function controlsOf(
  jobs: { start: ReturnType<typeof vi.fn> },
  label: string,
): Array<{ cancel: (reason?: string) => void; done: Promise<{ status: string }> }> {
  return jobs.start.mock.calls
    .filter((c) => c[0]?.label === label)
    .map((c) => c[0].run())
}

describe('agent/turn-stopping listener', () => {
  it('awaits the async subagents.start before reading run.result', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/tmp'))

    await vi.waitFor(() => expect(jobs.start).toHaveBeenCalledTimes(1))
    expect(subagents.start).toHaveBeenCalledWith('fork', expect.objectContaining({
      label: 'extract-memories',
      parent: expect.anything(),
    }))
  })

  it('never fails the turn when the subagent run rejects', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockImplementation(async () => ({ result: Promise.reject(new Error('model exploded')) }))

    await expect(stopTurn(ctx, fakeAgent('/tmp'))).resolves.toBeUndefined()
    await vi.waitFor(() => expect(jobs.start).toHaveBeenCalledTimes(1))
  })

  it('never fails the turn when subagents.start itself rejects', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockRejectedValue(new Error('no such provider'))

    await expect(stopTurn(ctx, fakeAgent('/tmp'))).resolves.toBeUndefined()
  })
})

describe('agent/turn-stopping recursion & single-flight gates', () => {
  it('a subagent (delegationDepth 1) turn-end spawns nothing', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/tmp', 1))

    expect(subagents.start).not.toHaveBeenCalled()
    expect(jobs.start).not.toHaveBeenCalled()
  })

  it('depth gate fails closed: invalid subagentDepth spawns nothing without throwing', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))
    const agent = fakeAgent('/tmp', -1) // delegates to delegationDepthOf, which throws

    await expect(stopTurn(ctx, agent)).resolves.toBeUndefined()

    expect(subagents.start).not.toHaveBeenCalled()
    expect(jobs.start).not.toHaveBeenCalled()
  })

  it('extraction is single-flight per session', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    const agent = fakeAgent('/tmp')
    const pending = deferred<unknown>()
    subagents.start.mockImplementation(async () => ({ result: pending.promise }))

    await stopTurn(ctx, agent)
    await stopTurn(ctx, agent) // still in flight

    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalledTimes(1))
    expect(jobs.start).toHaveBeenCalledTimes(1)
    pending.resolve({ structured: { writes: [] }, stopReason: 'completed' })
  })

  it('content gate: no re-spawn on unchanged events, spawns again on growth', async () => {
    const { ctx, jobs, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    const agent = fakeAgent('/tmp')
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    // First turn: some events exist, spawns.
    agent.session.events.push({ source: 'user', message: 'a' } as never)
    await stopTurn(ctx, agent)
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(controlsOf(jobs, 'extract-memories').length).toBe(1))
    // Let the extraction settle so the in-flight flag clears.
    await vi.waitFor(() => expect(subagents.start.mock.calls.length).toBe(1))

    // Same event count again: content gate skips (no in-flight either).
    await stopTurn(ctx, agent)
    expect(subagents.start).toHaveBeenCalledTimes(1)

    // Events grew: spawns again.
    agent.session.events.push({ source: 'assistant', message: 'b' } as never)
    await stopTurn(ctx, agent)
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalledTimes(2))
  })

  it('job outcome: rejection maps to failed/killed; a completed run writes back and completes', async () => {
    // failed
    const a = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    a.subagents.start.mockImplementation(async () => ({ result: Promise.reject(new Error('boom')) }))
    await stopTurn(a.ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(a.jobs.start).toHaveBeenCalledTimes(1))
    const [failedDone] = controlsOf(a.jobs, 'extract-memories')
    await expect(failedDone.done).resolves.toEqual({ status: 'failed', detail: 'Error: boom' })

    // completed: a valid structured report is written host-side.
    const b = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    b.subagents.start.mockImplementation(async () => ({
      result: Promise.resolve({
        structured: { writes: [{ path: 'user-profile.md', content: 'body' }] },
        stopReason: 'completed',
      }),
    }))
    await stopTurn(b.ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(b.jobs.start).toHaveBeenCalledTimes(1))
    const [completedDone] = controlsOf(b.jobs, 'extract-memories')
    await expect(completedDone.done).resolves.toEqual({ status: 'completed' })
    // The write-back lands in the turning agent's workspace directory:
    // <home>/projects/<slug of the agent's cwd>.
    expect((b.fs as ReturnType<typeof makeFsMock>).backing.get('/tmp/mem/projects/tmp/user-profile.md')).toBe('body')

    // killed: aborted before the result rejects.
    const c = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    const pending = deferred<unknown>()
    c.subagents.start.mockImplementation(async () => ({ result: pending.promise }))
    await stopTurn(c.ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(c.jobs.start).toHaveBeenCalledTimes(1))
    const [cancellable] = controlsOf(c.jobs, 'extract-memories')
    cancellable.cancel('disposed')
    pending.reject(new Error('cancel'))
    await expect(cancellable.done).resolves.toEqual({ status: 'killed' })
  })

  it('job outcome: child-level failures surface as failed, not fake-completed', async () => {
    // A non-completed stopReason (e.g. outputSchema never reported → 'error').
    const a = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    a.subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ stopReason: 'error' }) }))
    await stopTurn(a.ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(a.jobs.start).toHaveBeenCalledTimes(1))
    const [errored] = controlsOf(a.jobs, 'extract-memories')
    await expect(errored.done).resolves.toEqual({ status: 'failed', detail: 'memory fork ended with stopReason error' })

    // A completed run whose payload fails validation (path escape attempt).
    const b = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    b.subagents.start.mockImplementation(async () => ({
      result: Promise.resolve({
        structured: { writes: [{ path: '../escape.md', content: 'x' }] },
        stopReason: 'completed',
      }),
    }))
    await stopTurn(b.ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(b.jobs.start).toHaveBeenCalledTimes(1))
    const [invalid] = controlsOf(b.jobs, 'extract-memories')
    const outcome = await invalid.done
    expect(outcome.status).toBe('failed')
    expect((outcome as { detail: string }).detail).toContain('invalid memory filename')
    expect((b.fs as ReturnType<typeof makeFsMock>).backing.size).toBe(0)
  })

  it('forwards maxDepth: 1 and the writes outputSchema on the subagent request', async () => {
    const { ctx, subagents } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/tmp'))
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalledTimes(1))

    expect(subagents.start.mock.calls[0][1]).toMatchObject({ maxDepth: 1 })
    expect(subagents.start.mock.calls[0][1].outputSchema).toBe(MEMORY_WRITES_SCHEMA)
  })

  it('writes back into each turning agent\'s own workspace directory', async () => {
    const { ctx, jobs, subagents, fs } = mount({ memoryHome: '/tmp/mem', dreamEnabled: false })
    subagents.start.mockImplementation(async () => ({
      result: Promise.resolve({
        structured: { writes: [{ path: 'fact.md', content: 'body' }] },
        stopReason: 'completed',
      }),
    }))

    await stopTurn(ctx, fakeAgent('/work/repo-a'))
    await stopTurn(ctx, fakeAgent('/work/repo-b'))
    await vi.waitFor(() => expect(jobs.start).toHaveBeenCalledTimes(2))
    const backing = (fs as ReturnType<typeof makeFsMock>).backing
    await vi.waitFor(() => {
      expect(backing.get('/tmp/mem/projects/work-repo-a/fact.md')).toBe('body')
      expect(backing.get('/tmp/mem/projects/work-repo-b/fact.md')).toBe('body')
    })
    // The shared home root never receives a workspace's extraction writes.
    expect(backing.get('/tmp/mem/fact.md')).toBeUndefined()
  })
})

describe('dream listNewSessions filtering', () => {
  const NOW = 2_000_000_000_000

  function dreamSessions() {
    // lastAt = 1000 => only the "old" session predates it. The dream agent's
    // cwd is '/mem', so its workspace memory dir is '/mem/projects/mem'.
    const seed = { '/mem/projects/mem/.consolidation-lock': '1\n1000\n' }
    const fs = makeFsMock(seed)
    const sessions = {
      list: vi.fn(() => [
        { id: 'old', header: { id: 'old', createdAt: 100 } },
        { id: 'depth', header: { id: 'depth', createdAt: NOW, delegationDepth: 1 } },
        { id: 'new-1', header: { id: 'new-1', createdAt: NOW } },
        { id: 'invalid', header: { id: 'invalid', createdAt: -1 } },
        { id: 'missing', header: { id: 'missing' } },
        { id: 'fill-1', header: { id: 'fill-1', createdAt: NOW + 1 } },
        { id: 'fill-2', header: { id: 'fill-2', createdAt: NOW + 2 } },
      ]),
    }
    const { ctx, jobs, subagents } = mount({ memoryHome: '/mem', fs, sessions })
    return { ctx, jobs, subagents }
  }

  function dreamPromptOf(subagents: { start: ReturnType<typeof vi.fn> }): string {
    const call = subagents.start.mock.calls.find((c) => c[1]?.label === 'memory-consolidation')
    return call ? call[1].prompt[0].text : ''
  }

  it('excludes old/delegated sessions and counts invalid/missing createdAt as new', async () => {
    const { ctx, jobs, subagents } = dreamSessions()
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))

    await vi.waitFor(() =>
      expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1),
      { timeout: 2000 },
    )
    const prompt = dreamPromptOf(subagents)
    expect(prompt).toContain('new-1')
    expect(prompt).toContain('invalid')
    expect(prompt).toContain('missing')
    expect(prompt).toContain('fill-1')
    expect(prompt).toContain('fill-2')
    // Excluded: older than lastAt, or a delegated session.
    expect(prompt).not.toContain('old')
    expect(prompt).not.toContain('depth')
    // One memory-consolidation job (extraction runs a separate one).
    expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1)
  })

  it('dream is single-flight across interleaved turn-stopping dispatches', async () => {
    // Keep the first dream pending (deferred stat) so the flag stays set when
    // the second dispatch fires.
    const dreamStat = deferred<unknown>()
    const base = makeFsMock({ '/mem/.consolidation-lock': '1\n1000\n' })
    const fs = {
      ...base,
      async stat(target: unknown) {
        const key = String((target as { targetKey: unknown }).targetKey)
        if (key.endsWith('/.consolidation-lock')) return dreamStat.promise
        return base.stat(target)
      },
    }
    const sessions = {
      list: vi.fn(() => [
        { id: 'a', header: { id: 'a', createdAt: NOW } },
        { id: 'b', header: { id: 'b', createdAt: NOW } },
        { id: 'c', header: { id: 'c', createdAt: NOW } },
        { id: 'd', header: { id: 'd', createdAt: NOW } },
        { id: 'e', header: { id: 'e', createdAt: NOW } },
      ]),
    }
    const { ctx, subagents } = mount({ memoryHome: '/mem', fs, sessions })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await stopTurn(ctx, fakeAgent('/mem'))
    dreamStat.resolve(undefined)

    await vi.waitFor(() =>
      expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1),
      { timeout: 2000 },
    )
  })
})

describe('extract-memories index injection', () => {
  const MEM = '/mem'
  // The extraction agent's cwd is MEM, so its workspace memory dir is here.
  const WS = '/mem/projects/mem'

  function extractionPromptOf(subagents: { start: ReturnType<typeof vi.fn> }): string {
    const call = subagents.start.mock.calls.find((c) => c[1]?.label === 'extract-memories')
    return call ? call[1].prompt[0].text : ''
  }

  function agentWithTypes(types: readonly string[]): Agent {
    const agent = fakeAgent(MEM)
    const events = types.map((type) => ({ type }))
    // Rebind through the session face: snapshotEvents() is the read surface
    // and seq tracks the log length (upstream >=0.1.3).
    agent.session.events = events as never
    ;(agent.session as { snapshotEvents(): unknown }).snapshotEvents = () => events
    Object.defineProperty(agent.session, 'seq', {
      get: () => events.length,
      configurable: true,
    })
    return agent
  }

  function mountExtract(fs: unknown) {
    return mount({ memoryHome: MEM, dreamEnabled: false, fs })
  }

  it('injects the MEMORY.md index into the prompt under "Existing topics:"', async () => {
    const fs = makeFsMock({ [`${WS}/MEMORY.md`]: 'topic-a.md\n  - summary of a' })
    const { ctx, subagents } = mountExtract(fs)
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent(MEM))
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalled())

    const prompt = extractionPromptOf(subagents)
    expect(prompt).toContain('Existing topics:')
    expect(prompt).toContain('topic-a.md\n  - summary of a')
  })

  it('performs the MEMORY.md read before the subagent start', async () => {
    const fs = makeFsMock({ [`${WS}/MEMORY.md`]: 'topic-a.md' })
    const { ctx, subagents } = mountExtract(fs)
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent(MEM))
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalled())

    expect(fs.stat.mock.invocationCallOrder[0]).toBeLessThan(subagents.start.mock.invocationCallOrder[0])
    expect(fs.readText.mock.invocationCallOrder[0]).toBeLessThan(subagents.start.mock.invocationCallOrder[0])
  })

  it('falls back to listing topic .md files when MEMORY.md is absent', async () => {
    const fs = makeFsMock({ [`${WS}/topic-b.md`]: 'b', [`${WS}/topic-a.md`]: 'a' })
    const { ctx, subagents } = mountExtract(fs)
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent(MEM))
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalled())

    const prompt = extractionPromptOf(subagents)
    expect(prompt).toContain('topic-a.md')
    expect(prompt).toContain('topic-b.md')

    // With neither an index nor topic files, the "(none yet)" placeholder shows.
    const fs2 = makeFsMock({})
    const c2 = mountExtract(fs2)
    c2.subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))
    await stopTurn(c2.ctx, fakeAgent(MEM))
    await vi.waitFor(() => expect(c2.subagents.start).toHaveBeenCalled())
    expect(extractionPromptOf(c2.subagents)).toContain('(none yet)')
  })

  it('caps a large index at 200 lines plus a truncation marker', async () => {
    const big = Array.from({ length: 500 }, (_, i) => `line-${i}`).join('\n')
    const fs = makeFsMock({ [`${WS}/MEMORY.md`]: big })
    const { ctx, subagents } = mountExtract(fs)
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent(MEM))
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalled())

    const prompt = extractionPromptOf(subagents)
    expect(prompt).toContain('line-0')
    expect(prompt).toContain('line-199')
    expect(prompt).not.toContain('line-200')
    expect(prompt).toContain('(index truncated; rely on MEMORY.md in-dir for the rest)')
  })

  it('contains the index read and still spawns when the fs read throws', async () => {
    const fs = makeFsMock({ [`${WS}/MEMORY.md`]: 'topic-a.md' })
    fs.readText.mockRejectedValueOnce(new Error('io gone'))
    const { ctx, jobs, subagents } = mountExtract(fs)
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await expect(stopTurn(ctx, fakeAgent(MEM))).resolves.toBeUndefined()
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalledTimes(1))

    expect(extractionPromptOf(subagents)).toContain('(none yet)')
    expect(jobs.start).toHaveBeenCalledTimes(1)
  })

  it('adds the read-scope and early-exit prompt contract lines', async () => {
    const { ctx, subagents } = mountExtract(makeFsMock())
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent(MEM))
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalled())

    const prompt = extractionPromptOf(subagents)
    expect(prompt).toContain('The conversation to review is already in your context — do not open files or browse directories outside the memory directory.')
    expect(prompt).toContain('If the reviewed messages contain no new durable fact worth remembering, return an empty `writes` array and finish immediately.')
    expect(prompt).toContain('Read only inside')
  })

  it('counts only surface events for the batch size', async () => {
    const types = [
      'user/message', 'user/message',
      'assistant/message', 'assistant/message', 'assistant/message',
      'tool/result',
      'system', 'system', 'system', 'system', 'system', 'system', 'system', 'system', 'system', 'system',
    ] as const
    const { ctx, subagents } = mountExtract(makeFsMock())
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, agentWithTypes(types))
    await vi.waitFor(() => expect(subagents.start).toHaveBeenCalled())

    expect(extractionPromptOf(subagents)).toContain('last 6 messages')
  })

  it('keeps buildConsolidationPrompt byte-equal (no collateral change)', () => {
    const expected = [
      'You are consolidating persistent memory from past sessions. Review the sessions listed below (transcripts in `/transcripts`), distill durable facts, and rewrite the memory directory `/mem`.',
      'The memory directory contains MEMORY.md (an index of topic files) and topic `.md` files with YAML frontmatter (name, description, type).',
      'Return the complete rewritten file set via the `structured_output` tool as `{ "writes": [{ "path", "content" }] }` — flat `.md` filenames with complete bodies. Only the files you return are written; omitted files stay unchanged on disk.',
      'Rewrite `MEMORY.md` to be a concise index (one line per topic) and keep topic files organized by semantic topic, not chronology.',
      'Remove memories that are wrong or outdated from the index. Do not drop a fact that is still load-bearing.',
      `You may use only: ${MEMORY_AGENT_TOOLS.join(', ')}.`,
      '',
      'Sessions since the last consolidation:',
      '- s1',
      '- s2',
    ].join('\n')
    expect(buildConsolidationPrompt('/mem', '/transcripts', ['s1', 's2'])).toBe(expected)
  })
})
