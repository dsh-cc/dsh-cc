import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply, rollbackLock, tryAcquireLock, memoryWritePolicy } from '../src/index.ts'
import { startMemoryJob } from '../src/memory-job.ts'

/**
 * Observation capture-seam: the lanes no longer register on the jobs seam, so
 * abort controls are captured through startMemoryJob's returned handles.
 */
vi.mock('../src/memory-job.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/memory-job.ts')>()
  return { ...mod, startMemoryJob: vi.fn(mod.startMemoryJob) }
})

/**
 * Coverage for the dream dispatch diagnostics (plan 2026-09-22 §2.4): every
 * death mode after the lock acquire leaves a durable breadcrumb in
 * `.dream-last-error.json` and rolls the lock back, and a diagnostic write
 * failure never breaks the dream path.
 */

const DIR = '/mem/projects/mem'
const LOCK = `${DIR}/.consolidation-lock`
const DIAG = `${DIR}/.dream-last-error.json`

function fakeAgent(cwd: string): Agent {
  const events: unknown[] = []
  return {
    options: {},
    session: {
      events,
      get seq() { return events.length },
      snapshotEvents() { return events },
      header: { id: `session:${cwd}`, cwd },
    },
  } as unknown as Agent
}

/** Minimal fs seam, identical in shape to the turn-stopping spec's fake. */
function makeFsMock(seed: Record<string, string> = {}) {
  const backing = new Map(Object.entries(seed))
  return {
    backing,
    async stat(target: unknown) {
      const c = backing.get(String((target as { targetKey: unknown }).targetKey))
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
    async listDir() { return [] },
  }
}

function mount(config: { fs?: unknown; sessionsRoot?: string; withSeams?: boolean } = {}) {
  const ctx = new Context()
  const subagents = { start: vi.fn() }
  const fs = config.fs ?? makeFsMock()
  if (config.withSeams !== false) {
    ctx.provide('subagents' as never, subagents as never)
  }
  ctx.provide('fs' as never, fs as never)
  vi.mocked(startMemoryJob).mockClear()
  apply(ctx, {
    memoryHome: '/mem',
    extractEnabled: false,
    sessionsRoot: config.sessionsRoot ?? tmpRoot,
  })
  return { ctx, subagents, fs }
}

/** The settled startMemoryJob handles for one label, in call order. */
async function controlsOf(label: string): Promise<Array<{ abort: (reason?: string) => void; done: Promise<{ status: string }> }>> {
  const mock = startMemoryJob as unknown as ReturnType<typeof vi.fn>
  const out: Array<{ abort: (reason?: string) => void; done: Promise<{ status: string }> }> = []
  for (let i = 0; i < mock.mock.calls.length; i++) {
    if (mock.mock.calls[i]![4] !== label) continue
    const r = mock.mock.results[i]
    if (r.type === 'return') out.push(await r.value)
  }
  return out
}

async function stopTurn(ctx: Context, agent: Agent): Promise<void> {
  const signal = new AbortController().signal
  await ctx.serial('agent/turn-stopping' as never, { agent, signal } as never)
}

/** Parsed diagnostic entry, or a sentinel that fails assertions loudly. */
function diagnosticOf(fs: ReturnType<typeof makeFsMock>): Record<string, unknown> {
  return JSON.parse(fs.backing.get(DIAG) ?? '"MISSING"')
}

/** Real tmp sessions root: the gates scan actual seeded session dirs. */
let tmpRoot = ''
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'dream-diag-'))
})
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true })
})

async function seedFresh(root: string, n: number): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const dir = join(root, 'proj', `s${i}`)
    await mkdir(dir, { recursive: true })
    const header = JSON.stringify({ type: 'session', version: 3, id: `s${i}`, createdAt: Date.now() + i, cwd: '/x', delegationDepth: 0, isSeeded: false })
    await writeFile(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(`${header}\n`)))
  }
}

describe('dream dispatch diagnostics', () => {
  it('a dispatch throw rolls the lock back and writes a dispatch-throw breadcrumb', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, subagents, fs } = mount({ fs: makeFsMock({ [LOCK]: '1\n0\n' }) })
    const warnSpy = vi.spyOn(ctx.logger, 'warn')
    subagents.start.mockRejectedValue(new Error('boom'))

    await stopTurn(ctx, fakeAgent('/mem'))

    await vi.waitFor(() => {
      expect(fs.backing.get(LOCK)).toBe('0\n0\n')
      const entry = diagnosticOf(fs)
      expect(entry.phase).toBe('dispatch-throw')
      // Detail carries the error text AND its stack (plan §2.1 entry shape).
      expect(String(entry.detail)).toContain('boom')
      expect(String(entry.detail)).toContain('\n')
      expect(typeof entry.pid).toBe('number')
      expect(String(entry.sessionId)).toContain('session:')
      expect(typeof entry.at).toBe('number')
    })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('an outcome-failed dream (stopReason error) rolls the lock back and writes an outcome-failed breadcrumb', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, subagents, fs } = mount()
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ stopReason: 'error' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => expect(fs.backing.get(LOCK)).toBe('0\n0\n'))

    const entry = diagnosticOf(fs)
    expect(entry.phase).toBe('outcome-failed')
    expect(String(entry.detail)).toContain('stopReason error')
  })

  it('a missing subagents seam lands as outcome-failed with the seam-unavailable detail', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, fs } = mount({ withSeams: false })

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => {
      expect(diagnosticOf(fs).phase).toBe('outcome-failed')
      expect(String(diagnosticOf(fs).detail)).toContain('subagents seam unavailable')
      // The lock was never stranded: rolled back to the no-file encoding.
      expect(fs.backing.get(LOCK)).toBe('0\n0\n')
    })
  })

  it('a diagnostic write failure never breaks the dream flow (warn + rollback still happen)', async () => {
    await seedFresh(tmpRoot, 5)
    const base = makeFsMock()
    const fs = {
      ...base,
      async writeText(target: unknown, content: string) {
        const key = String((target as { targetKey: unknown }).targetKey)
        if (key.endsWith('.dream-last-error.json')) throw new Error('disk full')
        base.backing.set(key, content)
        return {}
      },
    }
    const { ctx, subagents } = mount({ fs })
    const warnSpy = vi.spyOn(ctx.logger, 'warn')
    subagents.start.mockRejectedValue(new Error('boom'))

    await expect(stopTurn(ctx, fakeAgent('/mem'))).resolves.toBeUndefined()

    // The dispatch-throw flow completed: lock rolled back, warn per failed write.
    await vi.waitFor(() => expect(base.backing.get(LOCK)).toBe('0\n0\n'))
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('dream diagnostic'))).toBe(true)
    expect(base.backing.get(DIAG)).toBeUndefined()
  })

  it('priorAt semantics (review Minor-5, existing quirk): after a dispatch-throw rollback with priorAt = now-5min, an immediate tryAcquireLock returns null', async () => {
    await seedFresh(tmpRoot, 5)
    const fs = makeFsMock()
    const now = Date.now()
    // Exactly what the dispatch-throw catch does when priorAt was now-5min.
    await rollbackLock(fs as never, DIR, now - 5 * 60_000, memoryWritePolicy(DIR))
    // The rolled-back file carries a RECENT `at` (the old consolidated epoch
    // doubles as the holder timestamp), so the held check fences re-acquisition
    // for the remainder of the stale window — documented quirk, pinned here.
    expect(await tryAcquireLock(fs as never, DIR, process.pid, now)).toBeNull()
    // And once the stale window passes, acquisition works again.
    expect(await tryAcquireLock(fs as never, DIR, process.pid, now + 60 * 60_000 + 1000)).toBe(now - 5 * 60_000)
  })

  it('a never-settling fork leaves the diagnostic at dispatch-started (hang is distinguishable)', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, subagents, fs } = mount()
    subagents.start.mockImplementation(async () => ({ result: new Promise(() => {}) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => expect(diagnosticOf(fs).phase).toBe('dispatch-started'))
    // Lock still held (never rolled back) and the breadcrumb never overwritten.
    const [holderPid, at] = (fs.backing.get(LOCK) ?? '').trim().split('\n').map(Number)
    expect(holderPid).toBe(process.pid)
    expect(at).toBeGreaterThan(0)
  })
})

/**
 * Bounded dream retry (design 2026-09-24 §4.2/§5.4): a FAILED dream outcome
 * (the never-reported prose-stop shape) gets exactly ONE immediate retry with
 * the same prompt and lock. A killed outcome never respawns; a second failure
 * rolls the lock back with no third attempt.
 */
describe('dream bounded retry (design §4.2)', () => {
  it('first attempt failed + retry completes: one lock acquire, two spawns, outcome-failed + success (marker cleared)', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, subagents, fs } = mount()
    const spawnCount = { n: 0 }
    subagents.start.mockImplementation(async () => {
      spawnCount.n += 1
      if (spawnCount.n === 1) return { result: Promise.resolve({ stopReason: 'error' }) }
      return {
        result: Promise.resolve({
          structured: { writes: [{ path: 'MEMORY.md', content: '# index\n' }, { path: 'topic-a.md', content: 'fact\n' }] },
          stopReason: 'completed',
        }),
      }
    })

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => {
      expect(fs.backing.get(LOCK)).toContain(String(process.pid))
      expect(diagnosticOf(fs).phase).toBe('outcome-failed')
    })
    // The write-back proves the retry completed the job (same lock, no re-acquire).
    expect(fs.backing.get(`${DIR}/MEMORY.md`)).toBe('# index\n')
    expect(fs.backing.get(`${DIR}/topic-a.md`)).toBe('fact\n')
    expect(fs.backing.get(DIAG)).toBeDefined()
    expect(subagents.start).toHaveBeenCalledTimes(2) // one dispatch window, two spawn calls (attempt + retry)
  })

  it('retry also fails: exactly two spawns, rollback, no third attempt', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, subagents, fs } = mount()
    subagents.start.mockImplementation(async () => ({ result: Promise.resolve({ stopReason: 'error' }) }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => expect(fs.backing.get(LOCK)).toBe('0\n0\n'))

    expect(subagents.start).toHaveBeenCalledTimes(2)
    const entry = diagnosticOf(fs)
    expect(entry.phase).toBe('outcome-failed')
    expect(String(entry.detail)).toContain('retry')
    expect(String(entry.detail)).toContain('stopReason error')
  })

  it('a retry-side dispatch throw is caught: outcome-failed (retry-tagged) + rollback, never a stranded lock', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, subagents, fs } = mount()
    let n = 0
    subagents.start.mockImplementation(async () => {
      n += 1
      if (n === 1) return { result: Promise.resolve({ stopReason: 'error' }) }
      throw new Error('retry dispatch exploded')
    })

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => expect(fs.backing.get(LOCK)).toBe('0\n0\n'))

    const entry = diagnosticOf(fs)
    expect(entry.phase).toBe('outcome-failed')
    expect(String(entry.detail)).toContain('retry')
    expect(String(entry.detail)).toContain('retry dispatch exploded')
  })

  it('no retry on killed: exactly one spawn and a plain outcome-failed breadcrumb', async () => {
    await seedFresh(tmpRoot, 5)
    const { ctx, subagents, fs } = mount()
    const pending = Promise.withResolvers<never>()
    subagents.start.mockImplementation(async () => ({ result: pending.promise }))

    await stopTurn(ctx, fakeAgent('/mem'))
    await vi.waitFor(() => expect(fs.backing.get(LOCK)).toContain(String(process.pid)))
    // Abort via the captured job handles: outcome killed, no respawn.
    const [jobControl] = await controlsOf('memory-consolidation')
    jobControl.abort('disposed')
    pending.reject(new Error('aborted'))
    await vi.waitFor(() => expect(fs.backing.get(LOCK)).toMatch(/^0\n/))
    expect(subagents.start).toHaveBeenCalledTimes(1)
    expect(String(diagnosticOf(fs).detail)).not.toContain('retry')
  })
})
