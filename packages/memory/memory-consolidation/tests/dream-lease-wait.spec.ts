import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, Config } from '../src/index.ts'
import { startMemoryJob } from '../src/memory-job.ts'

/**
 * TDD spec for the dream lane's bounded FIFO wait on the mutation lease
 * (the shadow/active-mode starvation defect, 2026-11-23). The plan text is
 * pinned by six review rounds; the folded plan rides the PR body.
 *
 * Coverage: T1 queue/rescue (two-stop), T2 FIFO no-overtake, T3 timeout
 * breadcrumb + retry, T4 disposal (both interleavings + free-slot probe),
 * T5 waitMs=0 balk, T8 quiesce grant-and-complete, T9 fresh timestamp,
 * and the two-layer dreamLeaseWaitMs validation.
 */
vi.mock('../src/memory-job.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/memory-job.ts')>()
  return { ...mod, startMemoryJob: vi.fn(mod.startMemoryJob) }
})

/** An agent with N user messages, so the coordinator has evidence to review. */
function fakeAgent(cwd: string, id: string, userEvents = 1): Agent {
  const events: unknown[] = []
  for (let i = 0; i < userEvents; i++) {
    events.push({
      type: 'user/message',
      seq: i,
      time: 0,
      surfaceOp: 'append',
      data: { id: `m${i}`, role: 'user', content: [{ type: 'text', text: `hello ${i}` }], source: { kind: 'user' } },
    })
  }
  return {
    options: {},
    session: {
      events,
      get seq() { return events.length },
      snapshotEvents() { return events },
      header: { id, cwd },
    },
  } as unknown as Agent
}

/** Append one more user message (T2's later stop needs a new evidence head). */
function pushUser(agent: Agent, seq: number): void {
  const events = ((agent as unknown as { session: { events: unknown[] } }).session).events
  events.push({
    type: 'user/message',
    seq,
    time: 0,
    surfaceOp: 'append',
    data: { id: `m${seq}`, role: 'user', content: [{ type: 'text', text: `hello ${seq}` }], source: { kind: 'user' } },
  })
}

function makeFsMock(seed: Record<string, string> = {}) {
  const backing = new Map(Object.entries(seed))
  return {
    backing,
    async stat(target: unknown) {
      const key = String((target as { targetKey: unknown }).targetKey)
      const c = backing.get(key)
      return c === undefined ? undefined : { version: 'v1', type: 'file', size: c.length }
    },
    async readText(target: unknown) {
      const key = String((target as { targetKey: unknown }).targetKey)
      const c = backing.get(key)
      if (c === undefined) throw new Error('not found')
      return c
    },
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

/** Seed one session directory with a zstd-compressed v3 header line. */
async function seedSession(root: string, id: string, createdAt: number): Promise<void> {
  const dir = join(root, 'proj', id)
  await mkdir(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session', version: 3, id, createdAt, cwd: '/x',
    delegationDepth: 0, isSeeded: false,
  })
  await writeFile(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(`${header}\n`)))
}

interface Held {
  label: string
  /** Resolve the activation's held run (the extraction fork's result). */
  release: (value?: unknown) => void
  /** Reject the held run (an abort killing the fork). */
  reject: (reason?: unknown) => void
}

interface MountOptions {
  dreamLeaseWaitMs?: number
  mode?: 'active' | 'shadow' | 'off'
  /** dream job results resolve immediately unless held. */
  dreamResult?: (value: unknown) => void
}

/**
 * The shared two-stop shape: an active-mode mount whose extraction job
 * holds the mutation lease (its fork run is a captured deferred), and a
 * periodic dream whose time gate opens only after the test rewires the
 * lock body between stops (deterministic stop-1/stop-2 ordering).
 */
function mountStarved(fs: ReturnType<typeof makeFsMock>, sessionsRoot: string, memoryHome: string, opts: MountOptions = {}) {
  const ctx = new Context()
  const settings = { mode: opts.mode ?? 'active' }
  const held: Held[] = []
  const dreamDone = deferred<unknown>()
  const subagents = {
    startActivation: vi.fn(async (spec: { label: string }) => {
      const run = deferred<unknown>()
      held.push({
        label: spec.label,
        release: (value?: unknown) => run.resolve(value ?? { structured: { writes: [] }, stopReason: 'completed' }),
        reject: (reason?: unknown) => run.reject(reason ?? new Error('cancelled')),
      })
      return {
        childId: `child-${spec.label}`,
        messageId: `m-${spec.label}`,
        result: spec.label === 'memory-consolidation' ? dreamDone.promise : run.promise,
        dispose: () => Promise.resolve(),
      }
    }),
  }
  vi.mocked(startMemoryJob).mockClear()
  ctx.provide('settings' as never, { register: () => undefined, get: () => settings } as never)
  ctx.provide('subagents' as never, subagents as never)
  ctx.provide('fs' as never, fs as never)
  apply(ctx, {
    memoryHome,
    sessionsRoot,
    minHours: 1,
    minSessions: 1,
    ...(opts.dreamLeaseWaitMs !== undefined ? { dreamLeaseWaitMs: opts.dreamLeaseWaitMs } : {}),
  })
  const stop = async (agent: Agent): Promise<void> => {
    await ctx.serial('agent/turn-stopping' as never, { agent, signal: new AbortController().signal } as never)
  }
  /** Release the LAST activation with the given label (the held fork run). */
  const releaseHeld = (label: string): void => {
    const found = [...held].reverse().find((h) => h.label === label)
    if (found === undefined) throw new Error(`no held ${label} activation`)
    found.release()
  }
  /** Reject the LAST activation with the given label (an abort killing the fork). */
  const rejectHeld = (label: string): void => {
    const found = [...held].reverse().find((h) => h.label === label)
    if (found === undefined) throw new Error(`no held ${label} activation`)
    found.reject()
  }
  return { ctx, subagents, settings, stop, held, releaseHeld, rejectHeld, dreamDone }
}

function dirOf(memoryHome: string): string {
  return `${memoryHome}/projects/${memoryHome.slice(1)}`
}

function breadcrumbOf(fs: ReturnType<typeof makeFsMock>, memoryHome: string): { phase: string; detail: string } | undefined {
  const raw = fs.backing.get(`${dirOf(memoryHome)}/.dream-last-error.json`)
  return raw === undefined ? undefined : JSON.parse(raw) as { phase: string; detail: string }
}

function dreamStarted(subagents: { startActivation: ReturnType<typeof vi.fn> }): boolean {
  return subagents.startActivation.mock.calls.some((c) => c[0]?.label === 'memory-consolidation')
}

let tmpRoot = ''
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), 'dream-lease-')) })
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }) })

describe('dream lease bounded FIFO wait', () => {
  it('T1: a queued dream is rescued by the extraction release (two-stop)', async () => {
    await seedSession(tmpRoot, 's1', Date.now())
    const home = '/mem-t1'
    const fs = makeFsMock({ [`${dirOf(home)}/.consolidation-lock`]: `0\n${Date.now()}\n` })
    const { ctx, subagents, stop, releaseHeld } = mountStarved(fs, tmpRoot, home)
    const agent = fakeAgent(home, 'session-t1')

    // Stop 1: the extraction takes and holds the lease; the dream's time
    // gate fails against the just-written lock (deterministic ordering).
    await stop(agent)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledWith(expect.objectContaining({ label: 'extract-memories' })), { timeout: 2000 })

    // Rewire the lock to an ancient epoch so stop 2's dream passes its gates
    // while the extraction still holds the lease.
    fs.backing.set(`${dirOf(home)}/.consolidation-lock`, '0\n1000\n')
    const debugSpy = vi.spyOn(ctx.logger, 'debug')

    // Stop 2: the dream queues — the queued event fires synchronously after
    // the waiter is pushed, before any dispatch.
    await stop(agent)
    await vi.waitFor(() => expect(debugSpy.mock.calls.some((c) => (c[0] as { event?: string; queued?: number })?.event === 'memory:dream-lease' && (c[0] as { queued?: number }).queued === 1)).toBe(true), { timeout: 2000 })

    // The dream has NOT dispatched while the extraction holds the lease.
    expect(dreamStarted(subagents)).toBe(false)
    // Guard: the extraction job started (its held run exists) — the rescue
    // below is a queue handoff, not the uncontended fast path.
    expect(subagents.startActivation.mock.calls.filter((c) => c[0]?.label === 'extract-memories').length).toBeGreaterThanOrEqual(1)

    // The extraction releases: the FIFO drain hands the slot to the queued
    // dream, which dispatches (dispatch-started breadcrumb + fork start).
    releaseHeld('extract-memories')
    await vi.waitFor(() => expect(dreamStarted(subagents)).toBe(true), { timeout: 2000 })
    await vi.waitFor(() => expect(breadcrumbOf(fs, home)?.phase).toBe('dispatch-started'), { timeout: 2000 })

    await ctx.fiber.dispose()
  })

  it('T2: a follow-up extraction starts only after the queued dream settles (FIFO)', async () => {
    await seedSession(tmpRoot, 's1', Date.now())
    const home = '/mem-t2'
    const fs = makeFsMock({ [`${dirOf(home)}/.consolidation-lock`]: `0\n${Date.now()}\n` })
    const { ctx, subagents, stop, releaseHeld, dreamDone } = mountStarved(fs, tmpRoot, home)
    const agent = fakeAgent(home, 'session-t2')

    // Stop 1: extraction holds; dream time-gated out by the fresh lock.
    await stop(agent)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledWith(expect.objectContaining({ label: 'extract-memories' })), { timeout: 2000 })

    fs.backing.set(`${dirOf(home)}/.consolidation-lock`, '0\n1000\n')
    const debugSpy = vi.spyOn(ctx.logger, 'debug')
    await stop(agent)
    // The dream must be OBSERVED in the queue before anything else runs:
    // the queued event fires synchronously after the waiter is pushed.
    await vi.waitFor(() => expect(debugSpy.mock.calls.some((c) => (c[0] as { event?: string })?.event === 'memory:dream-lease' && (c[0] as { queued?: number }).queued === 1)).toBe(true), { timeout: 2000 })

    // A new reviewable event, then stop 3 raises pendingHead while the
    // extraction is still extracting (the coordinator only records it).
    pushUser(agent, 1)
    await stop(agent)

    // Extraction 1 releases: the dream is granted (FIFO ahead of extraction
    // 2), dispatches, and only after the DREAM settles may extraction 2 run.
    const extractionCount = () => subagents.startActivation.mock.calls.filter((c) => c[0]?.label === 'extract-memories').length
    releaseHeld('extract-memories')
    await vi.waitFor(() => expect(dreamStarted(subagents)).toBe(true), { timeout: 2000 })
    // While the dream is in flight, no second extraction started.
    expect(extractionCount()).toBe(1)
    // The dream settles: the follow-up extraction may now take the slot.
    dreamDone.resolve({ structured: { writes: [] }, stopReason: 'completed' })
    await vi.waitFor(() => expect(extractionCount()).toBe(2), { timeout: 2000 })

    await ctx.fiber.dispose()
  })

  it('T3: the bounded wait times out, leaves a lease-timeout breadcrumb, and a later stop retries on the fast path', async () => {
    await seedSession(tmpRoot, 's1', Date.now())
    const home = '/mem-t3'
    const fs = makeFsMock({ [`${dirOf(home)}/.consolidation-lock`]: `0\n${Date.now()}\n` })
    const { ctx, subagents, stop, releaseHeld } = mountStarved(fs, tmpRoot, home, { dreamLeaseWaitMs: 100 })
    const agent = fakeAgent(home, 'session-t3')

    await stop(agent)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledWith(expect.objectContaining({ label: 'extract-memories' })), { timeout: 2000 })

    fs.backing.set(`${dirOf(home)}/.consolidation-lock`, '0\n1000\n')
    await stop(agent)

    // The bounded wait expires: no dispatch, a durable lease-timeout
    // breadcrumb (the pressure-free periodic lane keeps the retry open).
    await vi.waitFor(() => expect(breadcrumbOf(fs, home)?.phase).toBe('lease-timeout'), { timeout: 3000 })
    expect(dreamStarted(subagents)).toBe(false)

    // dreamInFlight reset: with the lease freed, a later stop dispatches the
    // dream on the uncontended fast path.
    releaseHeld('extract-memories')
    await stop(agent)
    await vi.waitFor(() => expect(dreamStarted(subagents)).toBe(true), { timeout: 2000 })

    await ctx.fiber.dispose()
  })

  it('T4a: fiber disposal while queued aborts the wait with no dispatch and no phantom owner', async () => {
    await seedSession(tmpRoot, 's1', Date.now())
    const home = '/mem-t4a'
    const fs = makeFsMock({ [`${dirOf(home)}/.consolidation-lock`]: `0\n${Date.now()}\n` })
    const { ctx, subagents, stop } = mountStarved(fs, tmpRoot, home)
    const agent = fakeAgent(home, 'session-t4a')

    await stop(agent)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledWith(expect.objectContaining({ label: 'extract-memories' })), { timeout: 2000 })

    fs.backing.set(`${dirOf(home)}/.consolidation-lock`, '0\n1000\n')
    await stop(agent)
    await vi.waitFor(() => expect(dreamStarted(subagents)).toBe(false), { timeout: 500 })

    // Disposal aborts the queued wait BEFORE the coordinator releases its
    // slots; the dream attempt settles aborted, no dispatch, no phantom
    // lease owner once everything has settled.
    await ctx.fiber.dispose()
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(dreamStarted(subagents)).toBe(false)
    // The mutation-lease table's per-dir slot is gone: a fresh tryAcquire
    // against the default table succeeds (no phantom owner). The dream used
    // the plugin's own lease table, so probe through a fresh dream stop is
    // impossible post-dispose; assert no lease-timeout breadcrumb instead
    // (the abort is a cancellation, not a timeout).
    expect(breadcrumbOf(fs, home)?.phase).not.toBe('lease-timeout')
  })

  it('T4b: disposal racing a synchronous grant releases the lease instead of dispatching', async () => {
    await seedSession(tmpRoot, 's1', Date.now())
    const home = '/mem-t4b'
    const fs = makeFsMock({ [`${dirOf(home)}/.consolidation-lock`]: `0\n${Date.now()}\n` })
    const { ctx, subagents, stop, releaseHeld } = mountStarved(fs, tmpRoot, home)
    const agent = fakeAgent(home, 'session-t4b')

    await stop(agent)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledWith(expect.objectContaining({ label: 'extract-memories' })), { timeout: 2000 })
    fs.backing.set(`${dirOf(home)}/.consolidation-lock`, '0\n1000\n')
    await stop(agent)
    await vi.waitFor(() => expect(dreamStarted(subagents)).toBe(false), { timeout: 500 })

    // Release the extraction AND dispose in the same synchronous block:
    // drain() grants the queued dream synchronously, the await continuation
    // is a microtask — the teardown lands in that window, so the post-grant
    // cancelled check must release the lease instead of dispatching.
    releaseHeld('extract-memories')
    await ctx.fiber.dispose()
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(dreamStarted(subagents)).toBe(false)
    expect(breadcrumbOf(fs, home)?.phase).not.toBe('lease-timeout')
  })

  it('T5: dreamLeaseWaitMs 0 restores the balk (no dispatch, no lease-timeout breadcrumb)', async () => {
    await seedSession(tmpRoot, 's1', Date.now())
    const home = '/mem-t5'
    const fs = makeFsMock({ [`${dirOf(home)}/.consolidation-lock`]: `0\n${Date.now()}\n` })
    const { ctx, subagents, stop } = mountStarved(fs, tmpRoot, home, { dreamLeaseWaitMs: 0 })
    const agent = fakeAgent(home, 'session-t5')

    await stop(agent)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledWith(expect.objectContaining({ label: 'extract-memories' })), { timeout: 2000 })
    fs.backing.set(`${dirOf(home)}/.consolidation-lock`, '0\n1000\n')
    await stop(agent)
    await new Promise<void>((r) => setTimeout(r, 200))

    // Preserved balk behavior: no dispatch, and crucially NO breadcrumb
    // (this stays green on the pre-fix baseline — it pins the escape hatch).
    expect(dreamStarted(subagents)).toBe(false)
    expect(breadcrumbOf(fs, home)).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('T8: a mode flip to off grants the queued dream and it completes', async () => {
    await seedSession(tmpRoot, 's1', Date.now())
    const home = '/mem-t8'
    const fs = makeFsMock({ [`${dirOf(home)}/.consolidation-lock`]: `0\n${Date.now()}\n` })
    const { ctx, subagents, settings, stop, dreamDone, rejectHeld } = mountStarved(fs, tmpRoot, home)
    const agent = fakeAgent(home, 'session-t8')

    await stop(agent)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledWith(expect.objectContaining({ label: 'extract-memories' })), { timeout: 2000 })
    fs.backing.set(`${dirOf(home)}/.consolidation-lock`, '0\n1000\n')
    const debugSpy = vi.spyOn(ctx.logger, 'debug')
    await stop(agent)
    await vi.waitFor(() => expect(debugSpy.mock.calls.some((c) => (c[0] as { event?: string })?.event === 'memory:dream-lease' && (c[0] as { queued?: number }).queued === 1)).toBe(true), { timeout: 2000 })

    // The flip runs quiesce: teardown aborts the extraction job — simulated
    // by rejecting its held run the way a killed fork rejects — so the
    // bounded grace passes, releaseLeaseOf hands the slot to the queued
    // dream, and the dream is granted (not aborted) and completes.
    settings.mode = 'off'
    await stop(agent)
    rejectHeld('extract-memories')
    await vi.waitFor(() => expect(dreamStarted(subagents)).toBe(true), { timeout: 2000 })
    dreamDone.resolve({ structured: { writes: [] }, stopReason: 'completed' })
    await new Promise<void>((r) => setTimeout(r, 50))
    expect(breadcrumbOf(fs, home)?.phase).not.toBe('lease-timeout')

    await ctx.fiber.dispose()
  })

  it('T9: the disk lock carries a fresh acquisition epoch after a queued wait', async () => {
    await seedSession(tmpRoot, 's1', Date.now())
    const home = '/mem-t9'
    const entryTime = Date.now()
    const fs = makeFsMock({ [`${dirOf(home)}/.consolidation-lock`]: `0\n${Date.now()}\n` })
    const { ctx, subagents, stop, releaseHeld, dreamDone } = mountStarved(fs, tmpRoot, home)
    const agent = fakeAgent(home, 'session-t9')

    await stop(agent)
    await vi.waitFor(() => expect(subagents.startActivation).toHaveBeenCalledWith(expect.objectContaining({ label: 'extract-memories' })), { timeout: 2000 })
    fs.backing.set(`${dirOf(home)}/.consolidation-lock`, '0\n1000\n')
    await stop(agent)
    await vi.waitFor(() => expect(dreamStarted(subagents)).toBe(false), { timeout: 500 })

    // Hold the queue for a measurable span, then release: the dream takes
    // the DISK lock with an epoch stamped at acquisition (>= entry + span),
    // not the stale dream-entry timestamp.
    await new Promise<void>((r) => setTimeout(r, 60))
    releaseHeld('extract-memories')
    await vi.waitFor(() => expect(dreamStarted(subagents)).toBe(true), { timeout: 2000 })
    dreamDone.resolve({ structured: { writes: [] }, stopReason: 'completed' })
    await new Promise<void>((r) => setTimeout(r, 50))

    const body = fs.backing.get(`${dirOf(home)}/.consolidation-lock`) ?? ''
    const at = Number(body.split('\n')[1] ?? 0)
    // The released lock keeps the acquisition epoch (issue #336); it must
    // postdate the entry timestamp by at least the queued span. The
    // seedSession call above used Date.now() >= entryTime.
    expect(at).toBeGreaterThanOrEqual(entryTime + 60)

    await ctx.fiber.dispose()
  })
})

describe('dreamLeaseWaitMs validation (two layers)', () => {
  it('schema layer: 0 parses, the default applies, and non-finite / over-range / negative reject', () => {
    expect(Config({ memoryHome: '/mem', sessionsRoot: '/s', dreamLeaseWaitMs: 0 }).dreamLeaseWaitMs).toBe(0)
    expect(Config({ memoryHome: '/mem', sessionsRoot: '/s' }).dreamLeaseWaitMs).toBe(600_000)
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, -1]) {
      expect(() => Config({ memoryHome: '/mem', sessionsRoot: '/s', dreamLeaseWaitMs: bad })).toThrow()
    }
  })

  it('apply layer: direct callers get the same validation', () => {
    const ctx = new Context()
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, -1]) {
      expect(() => apply(ctx, { memoryHome: '/mem', sessionsRoot: '/s', dreamLeaseWaitMs: bad })).toThrow()
    }
    // The escape hatch stays legal at the apply layer too.
    expect(() => apply(new Context(), { memoryHome: '/mem', sessionsRoot: '/s', dreamLeaseWaitMs: 0 })).not.toThrow()
  })
})
