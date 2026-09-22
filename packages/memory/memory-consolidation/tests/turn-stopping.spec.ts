import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
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

function mount(config: { memoryHome: string; dreamEnabled?: boolean; extractEnabled?: boolean; fs?: unknown; sessionsRoot?: string }) {
  const ctx = new Context()
  const jobs = { start: vi.fn() }
  const subagents = { start: vi.fn() }
  const fs = config.fs ?? makeFsMock()
  // No `sessions` service mock: the gates scan a REAL tmp sessions root on
  // disk via config.sessionsRoot (plan §5). The in-memory fs fake stays only
  // for the marker/lock/dir machinery.
  ctx.provide('jobs' as never, jobs as never)
  ctx.provide('subagents' as never, subagents as never)
  ctx.provide('fs' as never, fs as never)
  apply(ctx, config)
  return { ctx, jobs, subagents, fs }
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

/**
 * Real tmp sessions root (plan §5): each test seeds actual directories with
 * real zstd-compressed v3 header lines so the node:fs/zlib scanner reads them.
 */
let tmpRoot = ''
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'dream-sessions-'))
})
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

/** Seed one session directory with a zstd-compressed v3 header line. */
async function seedSession(
  root: string,
  id: string,
  createdAt: number,
  opts: { sub?: boolean; legacy?: boolean } = {},
): Promise<void> {
  const dir = join(root, 'proj', id)
  await mkdir(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session', version: 3, id, createdAt, cwd: '/x',
    delegationDepth: opts.sub ? 1 : 0, isSeeded: false,
  })
  const name = opts.legacy ? 'session.jsonl.zstd' : 'session.v3.jsonl.zstd'
  await writeFile(join(dir, name), zstdCompressSync(Buffer.from(`${header}\n`)))
}

/** Seed N fresh top-level sessions (ids s1..sN). */
async function seedFresh(root: string, n: number, startAt = Date.now()): Promise<void> {
  for (let i = 1; i <= n; i++) await seedSession(root, `s${i}`, startAt + i)
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

describe('dream sessions gate (scanned session store)', () => {
  const NOW = 2_000_000_000_000
  // The dream agent's cwd is '/mem', so its workspace memory dir is here.
  const LOCK = '/mem/projects/mem/.consolidation-lock'

  function dreamPromptOf(subagents: { start: ReturnType<typeof vi.fn> }): string {
    const call = subagents.start.mock.calls.find((c) => c[1]?.label === 'memory-consolidation')
    return call ? call[1].prompt[0].text : ''
  }

  it('spawns the dream once five or more new sessions exist since lastAt; prompt carries hint ids and the sessions root', async () => {
    await seedSession(tmpRoot, 'old', 100)
    await seedSession(tmpRoot, 'sub', NOW, { sub: true })
    await seedFresh(tmpRoot, 5, NOW)
    // lastAt = 1000: only sessions created after it qualify.
    const { ctx, subagents } = mount({ memoryHome: '/mem', fs: makeFsMock({ [LOCK]: '1\n1000\n' }), sessionsRoot: tmpRoot })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))

    await vi.waitFor(() =>
      expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1),
      { timeout: 2000 },
    )
    const prompt = dreamPromptOf(subagents)
    expect(prompt).toContain(tmpRoot)
    for (let i = 1; i <= 5; i++) expect(prompt).toContain(`s${i}`)
    // Excluded: older than lastAt, or a delegated session.
    expect(prompt).not.toContain('- old')
    expect(prompt).not.toContain('- sub')
    expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1)
  })

  it('an empty store blocks the dream', async () => {
    await mkdir(tmpRoot, { recursive: true })
    const { ctx, subagents } = mount({ memoryHome: '/mem', sessionsRoot: tmpRoot })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await new Promise(r => setTimeout(r, 30))

    expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(0)
  })

  it('a missing sessionsRoot blocks the dream and warns once per process', async () => {
    const missing = join(tmpRoot, 'absent')
    const { ctx, subagents } = mount({ memoryHome: '/mem', sessionsRoot: missing })
    const warnSpy = vi.spyOn(ctx.logger, 'warn')
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await new Promise(r => setTimeout(r, 30))

    expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain(missing)
  })

  it('dream is single-flight across interleaved turn-stopping dispatches', async () => {
    await seedFresh(tmpRoot, 5)
    // Keep the first dream pending (deferred stat) so the flag stays set when
    // the second dispatch fires.
    const dreamStat = deferred<unknown>()
    const base = makeFsMock({ [LOCK]: '1\n1000\n' })
    const fs = {
      ...base,
      async stat(target: unknown) {
        const key = String((target as { targetKey: unknown }).targetKey)
        if (key.endsWith('/.consolidation-lock')) return dreamStat.promise
        return base.stat(target)
      },
    }
    const { ctx, subagents } = mount({ memoryHome: '/mem', fs, sessionsRoot: tmpRoot })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await stopTurn(ctx, fakeAgent('/mem'))
    dreamStat.resolve(undefined)

    await vi.waitFor(() =>
      expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1),
      { timeout: 2000 },
    )
  })

  it('scan is memoized within the window; a second repo reuses the raw list with its own filter', async () => {
    // Repo A has no lock (lastAt = 0): all six sessions qualify. Repo B
    // consolidated at 1000: only the five fresh ones do. If the memo cached a
    // pre-filtered result (cold-review major #3), ONE of these prompts would
    // carry the other repo's window.
    await seedSession(tmpRoot, 'old', 100)
    await seedFresh(tmpRoot, 5, NOW)
    const { ctx, jobs, subagents } = mount({
      memoryHome: '/mem',
      sessionsRoot: tmpRoot,
      fs: makeFsMock({ ['/mem/projects/mem2/.consolidation-lock']: '1\n1000\n' }),
    })
    const debugSpy = vi.spyOn(ctx.logger, 'debug')
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1), { timeout: 2000 })
    // Let the first dream settle (dream single-flight), then repo B's own
    // turn-end reuses the memoized raw list for its own lastAt window.
    await vi.waitFor(() => expect(controlsOf(jobs, 'memory-consolidation').length).toBe(1), { timeout: 2000 })
    await expect(controlsOf(jobs, 'memory-consolidation')[0].done).resolves.toEqual({ status: 'completed' })
    await stopTurn(ctx, fakeAgent('/mem2'))
    await vi.waitFor(() => expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(2), { timeout: 2000 })

    const scans = debugSpy.mock.calls.filter((c) => (c[0] as { event?: string })?.event === 'memory:scan')
    const memoHits = debugSpy.mock.calls.filter((c) => (c[0] as { event?: string })?.event === 'memory:scan-memo-hit')
    expect(scans.length).toBe(1)
    expect(memoHits.length).toBe(1)

    const dreamPrompts = subagents.start.mock.calls
      .filter((c) => c[1]?.label === 'memory-consolidation')
      .map((c) => c[1].prompt[0].text as string)
    expect(dreamPrompts.length).toBe(2)
    expect(dreamPrompts[0]).toContain('- old')
    for (let i = 1; i <= 5; i++) expect(dreamPrompts[1]).toContain(`s${i}`)
    expect(dreamPrompts[1]).not.toContain('- old')
  })
})

describe('dream pressure marker (forced consolidation)', () => {
  const DIR = '/mem/projects/mem'
  const PRESSURE = `${DIR}/.consolidation-needed`
  const COOLDOWN_MS = 60 * 60 * 1000

  /** The dream agent's memory dir; the marker/lock machinery uses the fs mock. */
  function pressureMount(marker: string, extra: Record<string, string> = {}) {
    return mount({ memoryHome: '/mem', fs: makeFsMock({ [PRESSURE]: marker, ...extra }), sessionsRoot: tmpRoot })
  }

  async function spawnDream(ctx: Context, subagents: { start: ReturnType<typeof vi.fn> }): Promise<void> {
    subagents.start.mockImplementation(async () => ({
      result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }),
    }))
    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1), { timeout: 2000 })
  }

  it('an armed marker spawns even when both periodic gates would fail', async () => {
    await seedFresh(tmpRoot, 1) // below minSessions; the time gate is also open too briefly to matter
    const marker = `${Date.now() - COOLDOWN_MS - 1000}\n0\n`
    const { ctx, subagents } = pressureMount(marker)

    await spawnDream(ctx, subagents)
  })

  it('stamps lastForcedAt BEFORE the lock attempt: a held lock still consumes the cooldown', async () => {
    await seedFresh(tmpRoot, 1)
    const marker = `${Date.now() - COOLDOWN_MS - 1000}\n0\n`
    const writes: string[] = []
    const base = makeFsMock({
      [PRESSURE]: marker,
      // A fresh lock: tryAcquireLock must return null (held, not stale).
      [`${DIR}/.consolidation-lock`]: `1\n${Date.now()}\n`,
    })
    const fs = {
      ...base,
      async writeText(target: unknown, content: string) {
        writes.push(String((target as { targetKey: unknown }).targetKey))
        return base.writeText(target, content)
      },
    }
    const { ctx, subagents } = mount({ memoryHome: '/mem', fs, sessionsRoot: tmpRoot })

    await stopTurn(ctx, fakeAgent('/mem'))
    await new Promise(r => setTimeout(r, 20))

    // No spawn (lock held), but the marker was stamped: the write to the
    // pressure file happened before any lock write could, and armedAt survived.
    expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(0)
    expect(writes.filter(k => k.endsWith('.consolidation-needed')).length).toBe(1)
    expect(writes.some(k => k.endsWith('.consolidation-lock'))).toBe(false)
    const [armedAt, lastForcedAt] = (base.backing.get(PRESSURE) ?? '').trim().split('\n').map(Number)
    expect(armedAt).toBe(Number(marker.trim().split('\n')[0]))
    expect(lastForcedAt).toBeGreaterThan(0)
  })

  it('within the cooldown: no spawn AND no lock attempt', async () => {
    const marker = `${Date.now()}\n${Date.now() - 1000}\n`
    const base = makeFsMock({ [PRESSURE]: marker })
    const writeSpy = vi.spyOn(base, 'writeText')
    const { ctx, subagents } = mount({ memoryHome: '/mem', fs: base, sessionsRoot: tmpRoot })

    await stopTurn(ctx, fakeAgent('/mem'))
    await new Promise(r => setTimeout(r, 20))

    expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(0)
    expect(writeSpy).not.toHaveBeenCalled()
    expect(base.backing.get(PRESSURE)).toBe(marker)
  })

  it('a successful forced dream tombs the marker', async () => {
    await seedFresh(tmpRoot, 1)
    const marker = `${Date.now() - COOLDOWN_MS - 1000}\n0\n`
    const { ctx, subagents, fs } = pressureMount(marker)

    await spawnDream(ctx, subagents)

    await vi.waitFor(() => {
      const tomb = (fs.backing.get(PRESSURE) ?? '').trim().split('\n').map(Number)
      expect(tomb[0]).toBe(0)
      expect(tomb[1]).toBeGreaterThan(0)
    })
  })

  it('a failed forced dream keeps the marker with its fresh stamp', async () => {
    await seedFresh(tmpRoot, 1)
    const marker = `${Date.now() - COOLDOWN_MS - 1000}\n0\n`
    const { ctx, subagents, fs } = pressureMount(marker)
    subagents.start.mockImplementation(async () => ({
      result: Promise.resolve({ structured: undefined, stopReason: 'error' }),
    }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await new Promise(r => setTimeout(r, 50))

    const [armedAt, lastForcedAt] = (fs.backing.get(PRESSURE) ?? '').trim().split('\n').map(Number)
    expect(armedAt).toBe(Number(marker.trim().split('\n')[0]))
    expect(lastForcedAt).toBeGreaterThan(0)
  })

  it('a scan-zero pressure run does NOT tomb the marker (retry next window, plan §3.3)', async () => {
    const marker = `${Date.now() - COOLDOWN_MS - 1000}\n0\n`
    const base = makeFsMock({ [PRESSURE]: marker })
    const writeSpy = vi.spyOn(base, 'writeText')
    const { ctx, subagents } = mount({ memoryHome: '/mem', fs: base, sessionsRoot: join(tmpRoot, 'absent') })

    await stopTurn(ctx, fakeAgent('/mem'))
    await new Promise(r => setTimeout(r, 30))

    // No spawn, no lock, no tomb: the marker keeps its armedAt (next window retries).
    expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(0)
    const lockWrites = writeSpy.mock.calls.filter((c) =>
      String((c[0] as { targetKey?: { targetKey?: string } })?.targetKey?.targetKey).endsWith('.consolidation-lock'))
    expect(lockWrites.length).toBe(0)
    const [armedAt, lastForcedAt] = (base.backing.get(PRESSURE) ?? '').trim().split('\n').map(Number)
    expect(armedAt).toBe(Number(marker.trim().split('\n')[0]))
    expect(lastForcedAt).toBeGreaterThan(0)
  })

  it('a successful periodic dream also clears a pending marker', async () => {
    await seedFresh(tmpRoot, 5)
    const marker = `${Date.now()}\n0\n`
    const { ctx, subagents, fs } = pressureMount(marker)

    await spawnDream(ctx, subagents)

    await vi.waitFor(() => {
      const tomb = (fs.backing.get(PRESSURE) ?? '').trim().split('\n').map(Number)
      expect(tomb[0]).toBe(0)
      expect(tomb[1]).toBeGreaterThan(0)
    })
  })

  it('a marker armed while a dream is in flight spawns no second dream', async () => {
    await seedFresh(tmpRoot, 1)
    const dreamStat = deferred<unknown>()
    const base = makeFsMock({ [PRESSURE]: `${Date.now() - COOLDOWN_MS - 1000}\n0\n` })
    const fs = {
      ...base,
      async stat(target: unknown) {
        const key = String((target as { targetKey: unknown }).targetKey)
        if (key.endsWith('/.consolidation-lock')) return dreamStat.promise
        return base.stat(target)
      },
    }
    const { ctx, subagents } = mount({ memoryHome: '/mem', fs, sessionsRoot: tmpRoot })
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await stopTurn(ctx, fakeAgent('/mem'))
    dreamStat.resolve(undefined)

    await vi.waitFor(() =>
      expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1),
      { timeout: 2000 },
    )
    expect(startsWithLabel(subagents, 'memory-consolidation')).toBe(1)
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

  it('keeps buildConsolidationPrompt byte-equal (re-recorded golden, plan §3.6)', () => {
    const expected = [
      'You are consolidating persistent memory from past sessions. Distill durable facts and rewrite the memory directory `/mem`.',
      'The memory directory contains MEMORY.md (an index of topic files) and topic `.md` files with YAML frontmatter (name, description, type).',
      'Return the complete rewritten file set via the `structured_output` tool as `{ "writes": [{ "path", "content" }] }` — flat `.md` filenames with complete bodies. Only the files you return are written; omitted files stay unchanged on disk.',
      'Work in this order:',
      `1. Orient: list \`/mem\`, then read MEMORY.md and the topic files it points at — that is your primary review material.`,
      `2. Verify against reality: the fork's working directory IS the session's workspace. Before keeping any load-bearing fact, check it against the current codebase (paths, commands, behavior) with read/grep/glob. On a contradiction between two memories, fix the wrong side. Delete facts referencing things that no longer exist.`,
      `3. Normalize dates: convert every relative date ("yesterday", "last week") to the absolute date it referred to.`,
      `4. Treat the session hints below as provenance only: they mark which sessions the consolidation window covers. The fork cannot read transcripts (zstd) — never attempt to open or grep them.`,
      `5. Prune and index: rewrite MEMORY.md as one line per topic, targeting under 140 lines (an index over 200 lines / 25 KB is rejected host-side, so stay well under). Move detail into topic files, organized by semantic topic, and keep still-true load-bearing facts.`,
      `You may use only: ${MEMORY_AGENT_TOOLS.join(', ')}.`,
      '',
      'Session provenance hints (ids under `/sessions-root`):',
      '- s1',
      '- s2',
    ].join('\n')
    const prompt = buildConsolidationPrompt('/mem', '/sessions-root', ['s1', 's2'])
    expect(prompt).toBe(expected)
    expect(prompt).toContain('/sessions-root')
    expect(prompt).not.toContain('grep them only')
  })
})

/**
 * Design §2.4: the write-side entrypoint gate (in @dsh-cc/memory) rejects an
 * over-limit `MEMORY.md` batch. Plain rejection would fail the dream job,
 * roll back the lock, and retry every turn-end forever — so the done handler
 * applies a fallback: over-limit entrypoint content is replaced with the
 * deterministic truncation output before validation/write, and the job
 * completes. A compliant batch passes through untouched.
 */
describe('memory write fallback (entrypoint gate livelock, design §2.4)', () => {
  const MEM = '/mem'
  // resolveWorkspaceMemoryDir(home, cwd): home + /projects/<slug>.
  const MEM_DIR = '/mem/projects/mem'
  const topicWrite = { path: 'topic-a.md', content: '# Topic A\n\nsome durable fact\n' }

  it('an over-limit MEMORY.md batch is truncated, written, and completes the job', async () => {
    const fs = makeFsMock()
    const { ctx, jobs, subagents } = mount({ memoryHome: MEM, dreamEnabled: false, fs })
    const overLimit = Array.from({ length: 500 }, (_, i) => `- [topic-${i}]: detail ${i}`).join('\n')
    subagents.start.mockImplementation(async () => ({
      result: Promise.resolve({
        structured: { writes: [topicWrite, { path: 'MEMORY.md', content: overLimit }] },
        stopReason: 'completed',
      }),
    }))

    await stopTurn(ctx, fakeAgent(MEM))
    await vi.waitFor(() => expect(controlsOf(jobs, 'extract-memories').length).toBe(1))
    await expect(controlsOf(jobs, 'extract-memories')[0].done).resolves.toEqual({ status: 'completed' })

    const written = fs.backing.get(`${MEM_DIR}/MEMORY.md`)
    // 500-line index was replaced by the capped truncation output, not dropped.
    expect(written).toBeDefined()
    expect(written!.split('\n').length).toBeLessThan(500)
    expect(written).toContain('WARNING')
    // Topic file from the same batch was preserved.
    expect(fs.backing.get(`${MEM_DIR}/topic-a.md`)).toBe(topicWrite.content)
  })

  it('a compliant batch passes through untouched (no fallback applied)', async () => {
    const fs = makeFsMock()
    const { ctx, jobs, subagents } = mount({ memoryHome: MEM, dreamEnabled: false, fs })
    const compliantIndex = '- [topic-a]: see topic-a.md\n- [topic-b]: fine\n'
    subagents.start.mockImplementation(async () => ({
      result: Promise.resolve({
        structured: { writes: [{ path: 'MEMORY.md', content: compliantIndex }, topicWrite] },
        stopReason: 'completed',
      }),
    }))

    await stopTurn(ctx, fakeAgent(MEM))
    await vi.waitFor(() => expect(controlsOf(jobs, 'extract-memories').length).toBe(1))
    await expect(controlsOf(jobs, 'extract-memories')[0].done).resolves.toEqual({ status: 'completed' })

    expect(fs.backing.get(`${MEM_DIR}/MEMORY.md`)).toBe(compliantIndex)
  })
})
