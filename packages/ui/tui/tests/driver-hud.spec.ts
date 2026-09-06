import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver, gitBranchOf } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Fake sessionProjections service: `stateOf` reads a per-session key→state
 * map (keyed by session id) and `onChanged` listeners are drivable by hand.
 * Mirrors the harness registry shape the driver consumes structurally.
 */
type ProjectionListener = (session: { id: string }, key: string, value: unknown, seq: number) => void

function makeProjections(statesBySession: Record<string, Record<string, unknown>> = {}) {
  const listeners = new Set<ProjectionListener>()
  const service = {
    onChanged(listener: ProjectionListener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    stateOf(session: { id: string }, key: string): unknown {
      return statesBySession[session.id]?.[key]
    },
  }
  const fire = (sessionId: string, key: string, value: unknown): void => {
    for (const listener of listeners) listener({ id: sessionId }, key, value, 0)
  }
  return { service, fire }
}

interface FakeSession {
  id: string
  events?: unknown[]
  status?: string
  cwd?: string
}

/**
 * Minimal ctx stub with a sessionProjections service and switchable agents.
 * The branch probe is injected via DriverConfig (not the ctx), so tests pass
 * it straight to createDriver — no real git subprocess runs here.
 */
function makeHudCtx(opts: {
  projections?: ReturnType<typeof makeProjections>
  createSession?: FakeSession
  resumeSessions?: Record<string, FakeSession>
}) {
  const disposed: string[] = []
  const createSession = opts.createSession ?? { id: 's-a', events: [], status: 'idle' }

  const makeAgent = (s: FakeSession): Record<string, unknown> => ({
    options: {},
    session: {
      id: s.id,
      header: s.cwd === undefined ? {} : { cwd: s.cwd },
      events: s.events ?? [],
    },
    id: `agent-${s.id}`,
    status: s.status ?? 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  })
  const makeHandle = (s: FakeSession) => ({
    agent: makeAgent(s),
    dispose: async () => { disposed.push(s.id) },
  })

  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'sessionProjections') return opts.projections?.service
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async () => makeHandle(createSession),
      resume: async (req: { resumeSessionId: string }) => {
        const s = opts.resumeSessions?.[req.resumeSessionId]
        if (s === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
        return makeHandle(s)
      },
    },
  }
  return { ctx, disposed }
}

const usageState = (input: number, output: number) => ({
  totals: { uncachedInputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 },
  last: null,
})

describe('createDriver hud (sessionProjections feed)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-hud-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('folds tokenUsage changes for our session into hud.tokens and the statusline', async () => {
    const projections = makeProjections()
    const { ctx } = makeHudCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    expect(driver.state.hud).toBeUndefined()

    projections.fire('s-a', 'tokenUsage', usageState(1234, 345))
    expect(driver.state.hud?.tokens).toEqual({ input: 1234, output: 345 })
    expect(driver.statusLine).toContain('↑1.2k ↓345 tok')
  })

  it('folds contextPressure changes into hud.contextPercent (projected occupancy)', async () => {
    const projections = makeProjections()
    const { ctx } = makeHudCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-a', 'contextPressure', {
      contextWindow: 100_000,
      pressureTokens: 41_500,
      surfaceTokens: 0,
      sampledSurfaceTokens: 0,
    })
    expect(driver.state.hud?.contextPercent).toBe(42)
    expect(driver.statusLine).toContain('ctx 42%')

    // projected occupancy: pressure + surface movement since the sample
    projections.fire('s-a', 'contextPressure', {
      contextWindow: 1000,
      pressureTokens: 100,
      surfaceTokens: 350,
      sampledSurfaceTokens: 200,
    })
    expect(driver.state.hud?.contextPercent).toBe(25)
  })

  it('exposes raw occupancy tokens next to the percent (anchor-adjusted)', async () => {
    const projections = makeProjections()
    const { ctx } = makeHudCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-a', 'contextPressure', {
      contextWindow: 200_000,
      pressureTokens: 85_000,
      surfaceTokens: 3_000,
      sampledSurfaceTokens: 2_000,
    })
    // Numerator is the raw projected count (sample + surface movement), never
    // back-derived from the rounded percent.
    expect(driver.state.hud?.contextTokens).toEqual({ used: 86_000, window: 200_000 })
    expect(driver.state.hud?.contextPercent).toBe(43)
    expect(driver.statusLine).toContain('ctx 43% (86k/200k)')
  })

  it('falls back to the bare sample for raw tokens when no anchor exists', async () => {
    const projections = makeProjections()
    const { ctx } = makeHudCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-a', 'contextPressure', {
      contextWindow: 100_000,
      pressureTokens: 41_500,
    })
    expect(driver.state.hud?.contextTokens).toEqual({ used: 41_500, window: 100_000 })
    expect(driver.state.hud?.contextPercent).toBe(42)
  })

  it('keeps raw tokens without a window and omits the percent', async () => {
    const projections = makeProjections()
    const { ctx } = makeHudCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-a', 'contextPressure', { pressureTokens: 500 })
    expect(driver.state.hud?.contextTokens).toEqual({ used: 500, window: undefined })
    expect(driver.state.hud?.contextPercent).toBeUndefined()
    expect(driver.statusLine).not.toContain('ctx')
  })

  it('ignores projection changes for another session id', async () => {
    const projections = makeProjections()
    const { ctx } = makeHudCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-other', 'tokenUsage', usageState(99, 99))
    projections.fire('s-other', 'contextPressure', { contextWindow: 10, pressureTokens: 5, surfaceTokens: 0 })
    expect(driver.state.hud).toBeUndefined()
    expect(driver.statusLine).not.toContain('tok')
    expect(driver.statusLine).not.toContain('ctx')
  })

  it('seeds hud from stateOf at boot (resume may already have projections)', async () => {
    const projections = makeProjections({
      's-a': {
        tokenUsage: usageState(5000, 40),
        contextPressure: { contextWindow: 10_000, pressureTokens: 1000, surfaceTokens: 0, sampledSurfaceTokens: 0 },
      },
    })
    const { ctx } = makeHudCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    expect(driver.state.hud?.tokens).toEqual({ input: 5000, output: 40 })
    expect(driver.state.hud?.contextPercent).toBe(10)
    expect(driver.statusLine).toContain('ctx 10%')
    expect(driver.statusLine).toContain('↑5k ↓40 tok')
  })

  it('does not emit when a projection event carries the same values', async () => {
    const projections = makeProjections()
    const { ctx } = makeHudCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-a', 'tokenUsage', usageState(1, 2))
    const afterFirst = driver.state
    projections.fire('s-a', 'tokenUsage', usageState(1, 2))
    expect(driver.state).toBe(afterFirst)
  })

  it('switchSession re-seeds hud from the new session and clears it when absent', async () => {
    const projections = makeProjections({
      's-a': { tokenUsage: usageState(5000, 40) },
      's-b': { contextPressure: { contextWindow: 200, pressureTokens: 50, surfaceTokens: 0, sampledSurfaceTokens: 0 } },
      's-c': {},
    })
    const { ctx } = makeHudCtx({
      projections,
      resumeSessions: {
        's-b': { id: 's-b', events: [], status: 'idle' },
        's-c': { id: 's-c', events: [], status: 'idle' },
      },
    })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    expect(driver.state.hud?.tokens).toEqual({ input: 5000, output: 40 })

    await driver.switchSession('s-b')
    // s-b has pressure but no usage: tokens must not leak from s-a.
    expect(driver.state.hud?.tokens).toBeUndefined()
    expect(driver.state.hud?.contextPercent).toBe(25)

    await driver.switchSession('s-c')
    expect(driver.state.hud).toBeUndefined()
  })

  it('late projection events from the disposed session are dropped after a switch', async () => {
    const projections = makeProjections({ 's-a': {} })
    const { ctx } = makeHudCtx({
      projections,
      resumeSessions: { 's-b': { id: 's-b', events: [], status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    await driver.switchSession('s-b')

    projections.fire('s-a', 'tokenUsage', usageState(7, 8))
    expect(driver.state.hud).toBeUndefined()
  })
})

describe('createDriver branch probe', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-branch-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('probes the boot cwd and lands the branch in the statusline', async () => {
    const probeCalls: string[] = []
    const { ctx } = makeHudCtx({})
    const driver = await createDriver(ctx as never, {
      cwd: '/w/proj',
      branchProbe: async (dir) => {
        probeCalls.push(dir)
        return 'main'
      },
    })

    expect(probeCalls).toEqual(['/w/proj'])
    await vi.waitFor(() => expect(driver.statusLine).toContain('[main]'))
  })

  it('re-probes with the new session cwd after switchSession', async () => {
    const probeCalls: string[] = []
    const { ctx } = makeHudCtx({
      resumeSessions: { 's-b': { id: 's-b', events: [], status: 'idle', cwd: '/other/dir' } },
    })
    const driver = await createDriver(ctx as never, {
      cwd: '/w/proj',
      branchProbe: async (dir) => {
        probeCalls.push(dir)
        return dir === '/other/dir' ? 'release' : 'main'
      },
    })
    await vi.waitFor(() => expect(driver.statusLine).toContain('[main]'))

    await driver.switchSession('s-b')
    await vi.waitFor(() => expect(probeCalls).toContain('/other/dir'))
    await vi.waitFor(() => expect(driver.statusLine).toContain('[release]'))
    expect(driver.statusLine).not.toContain('[main]')
  })

  it('a failed probe leaves the statusline branchless (never throws)', async () => {
    const { ctx } = makeHudCtx({})
    const driver = await createDriver(ctx as never, {
      cwd: '/w/proj',
      branchProbe: async () => {
        throw new Error('no git here')
      },
    })
    await vi.waitFor(() => expect(driver.statusLine).toContain('shift+tab'))
    expect(driver.statusLine).not.toContain('[')
  })
})

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('gitBranchOf (real probe)', () => {
  it.skipIf(!gitAvailable)('reads the checked-out branch from a real tmpdir repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-branch-real-'))
    execFileSync('git', ['-C', dir, 'init'], { stdio: 'ignore' })
    execFileSync('git', ['-C', dir, 'checkout', '-b', 'tui-probe-branch'], { stdio: 'ignore' })
    execFileSync(
      'git',
      ['-C', dir, '-c', 'user.email=tui@test', '-c', 'user.name=tui', 'commit', '--allow-empty', '-m', 'init'],
      { stdio: 'ignore' },
    )
    expect(await gitBranchOf(dir)).toBe('tui-probe-branch')
  })

  it.skipIf(!gitAvailable)('returns undefined outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-branch-none-'))
    expect(await gitBranchOf(dir)).toBeUndefined()
  })
})
