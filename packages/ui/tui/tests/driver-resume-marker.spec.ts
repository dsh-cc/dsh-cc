import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import {
  readResumeTarget,
  resumeMarkerFile,
  writeResumeTarget,
} from '@dsh-cc/tui/resume-target.ts'

/**
 * Fake session shape — one entry per persisted session the harness knows.
 */
interface FakeSession {
  id: string
  cwd?: string
  events?: unknown[]
  status?: string
  provider?: string
  model?: string
}

/**
 * Minimal ctx stub (same pattern as driver-session.spec.ts) that also counts
 * `agents.create` calls so the stale-marker degrade path can assert a fresh
 * session was created after a failed resume.
 */
function makeSwitchableCtx(opts: {
  createSession?: FakeSession
  resumeSessions?: Record<string, FakeSession>
  sessionList?: { id: string; cwd?: string; createdAt: number }[]
}): {
  ctx: Record<string, unknown>
  disposed: string[]
  resumeCalls: { resumeSessionId: string }[]
  createCalls: unknown[]
} {
  const disposed: string[] = []
  const resumeCalls: { resumeSessionId: string }[] = []
  const createCalls: unknown[] = []
  const createSession = opts.createSession ?? { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' }

  const makeAgent = (s: FakeSession): Record<string, unknown> => ({
    options: s.provider !== undefined && s.model !== undefined
      ? { provider: s.provider, model: s.model }
      : {},
    session: { id: s.id, header: s.cwd === undefined ? {} : { cwd: s.cwd }, events: s.events ?? [] , snapshotEvents() { return this.events } },
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
      if (key === 'sessionPersistence') {
        return { list: async () => opts.sessionList ?? [] }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async (req: unknown) => {
        createCalls.push(req)
        return makeHandle(createSession)
      },
      resume: async (req: { resumeSessionId: string }) => {
        resumeCalls.push(req)
        const s = opts.resumeSessions?.[req.resumeSessionId]
        if (s === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
        return makeHandle(s)
      },
    },
  }

  return { ctx, disposed, resumeCalls, createCalls }
}

/**
 * Resume-marker semantics: the marker is written only when the session has
 * real content — an empty boot must never steal the marker from the previous
 * real session, or the launcher's auto-resume channel is lost forever.
 * DSH_HOME isolation is mandatory: resume-target has no injection point, so
 * every test pins process.env.DSH_HOME at a fresh tmp dir.
 */
describe('createDriver resume marker', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-resume-marker-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('fresh boot does not touch the marker (pre-seeded marker survives)', async () => {
    writeResumeTarget('s-old')
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
    })
    const driver = await createDriver(ctx as never, {})
    expect(readResumeTarget()).toBe('s-old')
    await driver.dispose()
    expect(readResumeTarget()).toBe('s-old')
  })

  it('resumed boot writes the marker to the resumed id (self-heal)', async () => {
    writeResumeTarget('s-old')
    const { ctx, resumeCalls } = makeSwitchableCtx({
      resumeSessions: { 's-b': { id: 's-b', events: [], snapshotEvents() { return this.events }, status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { sessionId: 's-b' })
    expect(resumeCalls).toHaveLength(1)
    expect(readResumeTarget()).toBe('s-b')
    await driver.dispose()
    expect(readResumeTarget()).toBe('s-b')
  })

  it('fresh boot + first real prompt writes the marker to the new id', async () => {
    writeResumeTarget('s-old')
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
    })
    const driver = await createDriver(ctx as never, {})
    expect(readResumeTarget()).toBe('s-old') // prompt not yet sent
    await driver.submit('hello there')
    expect(readResumeTarget()).toBe('s-a')
    await driver.dispose()
  })

  it('fresh boot + dispose without any prompt leaves the marker untouched', async () => {
    writeResumeTarget('s-old')
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
    })
    const driver = await createDriver(ctx as never, {})
    await driver.dispose()
    expect(readResumeTarget()).toBe('s-old')
  })

  it('content then dispose writes the marker to the current id', async () => {
    writeResumeTarget('s-old')
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('real prompt')
    expect(readResumeTarget()).toBe('s-a')
    await driver.dispose()
    expect(readResumeTarget()).toBe('s-a')
  })

  it('content then /quit (bypasses driver.dispose) still writes the marker', async () => {
    writeResumeTarget('s-old')
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('real prompt')
    expect(readResumeTarget()).toBe('s-a')
    await driver.submit('/quit')
    expect(readResumeTarget()).toBe('s-a')
  })

  it('switchSession writes the new id; a later prompt keeps the marker on the current session', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
      resumeSessions: { 's-b': { id: 's-b', events: [], snapshotEvents() { return this.events }, status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, {})
    await driver.submit('first prompt on s-a')
    expect(readResumeTarget()).toBe('s-a')

    await driver.switchSession('s-b')
    expect(readResumeTarget()).toBe('s-b')

    await driver.submit('prompt on the new session')
    expect(readResumeTarget()).toBe('s-b')
    await driver.dispose()
    expect(readResumeTarget()).toBe('s-b')
  })

  it('stale marker self-heal: failed boot resume clears the marker, degrades to a fresh session, and surfaces a notice', async () => {
    writeResumeTarget('s-gone')
    const { ctx, resumeCalls, createCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
      resumeSessions: {}, // 's-gone' not registered → resume throws
    })
    const driver = await createDriver(ctx as never, { sessionId: 's-gone' })

    expect(resumeCalls).toHaveLength(1)
    expect(createCalls).toHaveLength(1)
    expect(readResumeTarget()).toBeUndefined()
    expect(driver.state.notice).toMatch(/已失效/)
    expect(driver.state.notice).toMatch(/\/resume/)
    await driver.dispose()
    expect(readResumeTarget()).toBeUndefined()
  })

  // --- autoResume / continueRequested boot state machine (§2.3) ------------

  it('regression lock: autoResume false/undefined does not read the marker', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-resume-noread-'))
    writeResumeTarget('s-old', { cwd })
    const { ctx, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd })
    expect(resumeCalls).toHaveLength(0)
    expect(readResumeTarget({ cwd })).toBe('s-old')
    await driver.dispose()
  })

  it('autoResume true + marker hit resumes that session', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-resume-hit-'))
    writeResumeTarget('s-b', { cwd })
    const { ctx, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
      resumeSessions: { 's-b': { id: 's-b', events: [], snapshotEvents() { return this.events }, status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { cwd, autoResume: true })
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-b')
    await driver.dispose()
  })

  it('autoResume true + no marker + continueRequested -> fresh + notice', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-resume-nomarker-'))
    const { ctx, resumeCalls, createCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd, autoResume: true, continueRequested: true })
    expect(resumeCalls).toHaveLength(0)
    expect(createCalls).toHaveLength(1)
    expect(driver.state.notice).toMatch(/没有可继续/)
    expect(driver.state.notice).toMatch(/\/resume/)
    await driver.dispose()
  })

  it('autoResume true + no marker + continueRequested false -> fresh, no notice', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-resume-nomarker2-'))
    const { ctx, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd, autoResume: true })
    expect(resumeCalls).toHaveLength(0)
    expect(driver.state.notice).toBeUndefined()
    await driver.dispose()
  })

  it("sessionId '' (explicit --new) beats the marker even with autoResume true", async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-resume-new-'))
    writeResumeTarget('s-b', { cwd })
    const { ctx, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
      resumeSessions: { 's-b': { id: 's-b', events: [], snapshotEvents() { return this.events }, status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { cwd, sessionId: '', autoResume: true })
    expect(resumeCalls).toHaveLength(0)
    await driver.dispose()
  })

  it('stale marker with autoResume: clear the project marker, degrade to fresh', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-resume-stale-'))
    writeResumeTarget('s-gone', { cwd })
    const { ctx, resumeCalls, createCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], snapshotEvents() { return this.events }, status: 'idle' },
      resumeSessions: {},
    })
    const driver = await createDriver(ctx as never, { cwd, autoResume: true })

    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-gone')
    expect(createCalls).toHaveLength(1)
    expect(driver.state.notice).toMatch(/已失效/)
    const home = join(tempHome, 'tui')
    expect(readFileSync(resumeMarkerFile({ home, cwd }), 'utf8')).toBe('')
    await driver.dispose()
  })

  it("write-key fix: marker lands in the session's project bucket", async () => {
    const bootCwd = mkdtempSync(join(tmpdir(), 'dsh-resume-wk-boot-'))
    const sessionCwd = mkdtempSync(join(tmpdir(), 'dsh-resume-wk-sess-'))
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', cwd: sessionCwd, events: [], snapshotEvents() { return this.events }, status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd: bootCwd })
    await driver.submit('real prompt')

    const home = join(tempHome, 'tui')
    expect(readFileSync(resumeMarkerFile({ home, cwd: sessionCwd }), 'utf8').trim())
      .toBe('s-a')
    await driver.dispose()
  })
})
