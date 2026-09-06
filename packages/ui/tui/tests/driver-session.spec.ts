import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { recordProjectSessionId } from '@dsh-cc/tui/project-sessions.ts'
import { readResumeTarget } from '@dsh-cc/tui/resume-target.ts'

/**
 * Fake session shape — one entry per persisted session the harness knows.
 */
interface FakeSession {
  id: string
  events?: unknown[]
  status?: string
  provider?: string
  model?: string
}

/**
 * Every session in this spec lives in the `/proj` project by default: the
 * resume picker filters to the cwd scope by default, so entries without a
 * cwd would drop out of the visible list.
 */
const PROJ_CWD = '/proj'

/** Fill in the default project cwd without overriding an explicit one. */
const withCwd = (s: FakeSession): FakeSession => ({ cwd: PROJ_CWD, ...s })

/**
 * Minimal ctx stub that supports in-process session switching:
 * - `agents.create` returns the boot session
 * - `agents.resume({ resumeSessionId })` returns a NEW agent for that id
 * - `dispose` on each handle is a spy so tests assert the old handle was torn down
 * - `sessionPersistence.list()` returns the configured session headers
 * - `sessionQuery` (optional) is passed through for title-decoration tests
 */
function makeSwitchableCtx(opts: {
  createSession?: FakeSession
  resumeSessions?: Record<string, FakeSession>
  sessionList?: { id: string; cwd?: string; createdAt: number; updatedAtMs?: number; parentSession?: string }[]
  sessionQuery?: unknown
}): {
  ctx: Record<string, unknown>
  disposed: string[]
  resumeCalls: { resumeSessionId: string; agentOptions?: unknown }[]
} {
  const disposed: string[] = []
  const resumeCalls: { resumeSessionId: string; agentOptions?: unknown }[] = []
  const createSession = withCwd(opts.createSession ?? { id: 's-a', events: [], status: 'idle' })

  const makeAgent = (s: FakeSession): Record<string, unknown> => ({
    options: s.provider !== undefined && s.model !== undefined
      ? { provider: s.provider, model: s.model }
      : {},
    session: { id: s.id, header: s.cwd === undefined ? {} : { cwd: s.cwd }, events: s.events ?? [] },
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
        return { list: async () => (opts.sessionList ?? []).map(e => ({ cwd: PROJ_CWD, ...e })) }
      }
      if (key === 'sessionQuery') {
        return opts.sessionQuery
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async () => makeHandle(createSession),
      resume: async (req: { resumeSessionId: string; agentOptions?: unknown }) => {
        resumeCalls.push(req)
        const raw = opts.resumeSessions?.[req.resumeSessionId]
        if (raw === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
        return makeHandle(withCwd(raw))
      },
    },
  }

  return { ctx, disposed, resumeCalls }
}

describe('createDriver switchSession', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-switch-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('disposes the old handle, resumes the new id, and rebuilds the transcript', async () => {
    const newEvents = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'switched history' }], source: { kind: 'user' } } },
    ]
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: { 's-b': { id: 's-b', events: newEvents, status: 'running' } },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    // Boot session is s-a
    expect(driver.state.rows[0]).toMatchObject({ kind: 'banner' })
    expect(driver.state.rows[1]).toMatchObject({ kind: 'status' })
    expect((driver.state.rows[1] as { text: string }).text).toMatch(/dsh cc-mode/)

    await driver.switchSession('s-b')

    // Old handle disposed
    expect(disposed).toEqual(['s-a'])
    // Resume called with the right id
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-b')
    // Transcript = banner (art + info) + folded new history
    expect(driver.state.rows[0]).toMatchObject({ kind: 'banner' })
    expect(driver.state.rows[1]).toMatchObject({ kind: 'status' })
    expect((driver.state.rows[1] as { text: string }).text).toMatch(/dsh cc-mode/)
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'switched history' })
    // Busy synced from the new agent's status
    expect(driver.state.busy).toBe(true)
    // Resume target written into the session cwd's bucket, not process.cwd().
    expect(readResumeTarget({ cwd: PROJ_CWD })).toBe('s-b')
    expect(readResumeTarget()).toBeUndefined()
  })

  it('reseeds the model from the TARGET session after the rebind (banner + statusLine follow /resume)', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', provider: 'old-p', model: 'old-m', events: [], status: 'idle' },
      resumeSessions: { 's-b': { id: 's-b', provider: 'new-p', model: 'new-m', events: [], status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    // Boot banner reflects the boot session's model.
    expect(driver.statusLine).toContain('old-m')
    const bootBanner = driver.state.rows.find(row => row.kind === 'status' && /dsh cc-mode/.test(row.text ?? ''))
    expect(bootBanner?.text).toContain('old-m')

    await driver.switchSession('s-b')

    expect(driver.statusLine).toContain('new-m')
    expect(driver.statusLine).not.toContain('old-m')
    const banner = driver.state.rows.find(row => row.kind === 'status' && /dsh cc-mode/.test(row.text ?? ''))
    expect(banner?.text).toContain('new-m')
    expect(banner?.text).not.toContain('old-m')
  })

  it('is a no-op when switching to the current session (dispose NOT called)', async () => {
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: { 's-a': { id: 's-a', events: [], status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    await driver.switchSession('s-a')

    expect(disposed).toEqual([])
    expect(resumeCalls).toHaveLength(0)
  })

  it('on a failed resume emits a notice and keeps the old session alive', async () => {
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: {}, // 's-b' not registered → resume throws
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    const originalRows = [...driver.state.rows]

    await driver.switchSession('s-b')

    // Resume was attempted
    expect(resumeCalls).toHaveLength(1)
    // Old handle NOT disposed (resume-first ordering)
    expect(disposed).toEqual([])
    // Notice row emitted
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toMatch(/Resume failed/)
    // Old transcript intact (the notice is appended, not replacing)
    expect(driver.state.rows.slice(0, originalRows.length)).toEqual(originalRows)
  })

  it('clears pending approval/question/modelPicker/queue before switching', async () => {
    // We need a ctx that can fire approval/request — but for simplicity, we
    // can set the overlay state directly via the driver and verify it clears.
    // Instead, use a ctx with session/event + approval/request handlers.
    const sessionHandlers = new Set<(session: unknown, event: unknown) => void>()
    const approvalHandlers = new Set<(req: unknown, next: () => void) => void>()
    const disposed: string[] = []
    const resumeCalls: { resumeSessionId: string }[] = []
    const createSession = { id: 's-a', events: [], status: 'idle' }
    const newSession = { id: 's-b', events: [], status: 'idle' }

    const makeAgent = (s: FakeSession): Record<string, unknown> => ({
      options: {},
      session: { id: s.id, header: {}, events: s.events ?? [] },
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
        return undefined
      },
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === 'session/event') {
          sessionHandlers.add(handler as (session: unknown, event: unknown) => void)
        } else if (event === 'approval/request') {
          approvalHandlers.add(handler as (req: unknown, next: () => void) => void)
        }
        return () => {}
      },
      agents: {
        create: async () => makeHandle(createSession),
        resume: async (req: { resumeSessionId: string }) => {
          resumeCalls.push(req)
          return makeHandle(newSession)
        },
      },
    }

    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    // Simulate a pending approval by firing the approval/request event.
    const fakeReq = {
      agent: { id: 'agent-s-a', session: { id: 's-a', events: [] } },
      toolName: 'Bash',
      callId: undefined,
      reason: undefined,
      signal: { addEventListener: () => {}, removeEventListener: () => {} },
    }
    for (const handler of approvalHandlers) {
      handler(fakeReq, () => {})
    }
    // Approval overlay should be open
    expect(driver.state.approval).toBeDefined()

    await driver.switchSession('s-b')

    // Approval cleared
    expect(driver.state.approval).toBeUndefined()
    // Old handle disposed
    expect(disposed).toEqual(['s-a'])
    // Resume called
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-b')
  })

  it('listSessions wraps sessionPersistence.list()', async () => {
    const { ctx } = makeSwitchableCtx({
      sessionList: [
        { id: 's-1', createdAt: 1000 },
        { id: 's-2', cwd: '/tmp', createdAt: 2000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    const sessions = await driver.listSessions()
    expect(sessions).toHaveLength(2)
    expect(sessions.map(s => s.id)).toEqual(['s-1', 's-2'])
    expect(sessions[1]!.cwd).toBe('/tmp')
  })

  it('listSessions returns [] when no sessionPersistence is mounted', async () => {
    const ctx: Record<string, unknown> = {
      get(key: string) {
        if (key === 'agentPresets') {
          return {
            defaultId: 'cc',
            resolve: async () => ({ id: 'cc' }),
            mount: async () => ({ id: 'cc' }),
          }
        }
        return undefined
      },
      on: () => () => {},
      agents: {
        create: async () => ({
          agent: {
            options: {},
            session: { id: 's-a', header: {}, events: [] },
            id: 'a-a',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }),
        resume: async () => ({
          agent: {
            options: {},
            session: { id: 's-a', header: {}, events: [] },
            id: 'a-a',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }),
      },
    }
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    const sessions = await driver.listSessions()
    expect(sessions).toEqual([])
  })
})

describe('createDriver /resume session switcher overlay', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-sw-overlay-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('opens the switcher on /resume (no args) with sessions newest-first and current marked', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-current', events: [], status: 'idle' },
      sessionList: [
        { id: 's-old', createdAt: 1000 },
        { id: 's-current', createdAt: 2000 },
        { id: 's-newest', createdAt: 3000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    await driver.submit('/resume')
    const sw = driver.state.sessionSwitcher
    expect(sw).toBeDefined()
    // Newest-first
    expect(sw!.sessions.map(s => s.id)).toEqual(['s-newest', 's-current', 's-old'])
    // Current session marked
    expect(sw!.currentId).toBe('s-current')
    // Focus on the current session
    expect(sw!.focused).toBe(1)
    // Not switching
    expect(sw!.switching).toBe(false)
  })

  it('focuses index 0 when the current session is not in the list', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-ghost', events: [], status: 'idle' },
      sessionList: [
        { id: 's-a', createdAt: 1000 },
        { id: 's-b', createdAt: 2000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')
    expect(driver.state.sessionSwitcher?.focused).toBe(0)
  })

  it('falls back to a status-row notice when no sessions exist', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      sessionList: [],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')
    expect(driver.state.sessionSwitcher).toBeUndefined()
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toMatch(/No sessions are available/)
  })

  it('move clamps at the bounds (no wrap)', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-b', events: [], status: 'idle' },
      sessionList: [
        { id: 's-a', createdAt: 1000 },
        { id: 's-b', createdAt: 2000 },
        { id: 's-c', createdAt: 3000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')
    // Focus starts at 1 (current = s-b)
    driver.sessionSwitcherMove(-1) // → 0
    expect(driver.state.sessionSwitcher?.focused).toBe(0)
    driver.sessionSwitcherMove(-1) // clamp at top
    expect(driver.state.sessionSwitcher?.focused).toBe(0)
    driver.sessionSwitcherMove(1)
    driver.sessionSwitcherMove(1) // → 2
    expect(driver.state.sessionSwitcher?.focused).toBe(2)
    driver.sessionSwitcherMove(1) // clamp at bottom
    expect(driver.state.sessionSwitcher?.focused).toBe(2)
  })

  it('cancel closes the overlay without switching', async () => {
    const { ctx, disposed } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      sessionList: [{ id: 's-b', createdAt: 1000 }],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')
    driver.sessionSwitcherCancel()
    expect(driver.state.sessionSwitcher).toBeUndefined()
    expect(disposed).toEqual([])
  })

  it('submit switches to the focused session and closes the overlay', async () => {
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: {
        's-b': { id: 's-b', events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'hello from s-b' }], source: { kind: 'user' } } }], status: 'idle' },
      },
      sessionList: [
        { id: 's-a', createdAt: 1000 },
        { id: 's-b', createdAt: 2000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')
    // Focus starts at 1 (current = s-a, sorted newest-first: s-b, s-a)
    expect(driver.state.sessionSwitcher?.focused).toBe(1)
    // Move up to s-b (index 0)
    driver.sessionSwitcherMove(-1)
    expect(driver.state.sessionSwitcher?.focused).toBe(0)

    await driver.sessionSwitcherSubmit()

    // Overlay closed
    expect(driver.state.sessionSwitcher).toBeUndefined()
    // Old handle disposed
    expect(disposed).toEqual(['s-a'])
    // Resume called for s-b
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-b')
    // New session's folded history is on screen
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'hello from s-b' })
  })

  it('/resume <id> switches directly without opening the overlay', async () => {
    const { ctx, disposed, resumeCalls } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: {
        's-b': { id: 's-b', events: [{ type: 'user/message', data: { content: [{ type: 'text', text: 'direct switch' }], source: { kind: 'user' } } }], status: 'idle' },
      },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    await driver.submit('/resume s-b')

    // No overlay opened
    expect(driver.state.sessionSwitcher).toBeUndefined()
    // Old handle disposed
    expect(disposed).toEqual(['s-a'])
    // Resume called
    expect(resumeCalls).toHaveLength(1)
    expect(resumeCalls[0]!.resumeSessionId).toBe('s-b')
    // Folded history visible
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'direct switch' })
  })

  it('/resume <id> with unknown id emits a failure notice without disposing', async () => {
    const { ctx, disposed } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      resumeSessions: {}, // 's-unknown' not registered
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    await driver.submit('/resume s-unknown')

    expect(disposed).toEqual([])
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toMatch(/Resume failed/)
  })

  it('does not leave any "Restart with" text (regression)', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      sessionList: [{ id: 's-b', createdAt: 1000 }],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')
    // The old restart notice must not appear anywhere in the transcript.
    for (const row of driver.state.rows) {
      if (row.kind === 'status') {
        expect(row.text).not.toMatch(/Restart with/)
      }
    }
  })

  it('defaults to cwd scope: other-project sessions stay hidden until Tab', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-cur', events: [], status: 'idle' },
      sessionList: [
        { id: 's-cur', createdAt: 2000 },
        { id: 's-far', cwd: '/away', createdAt: 3000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    await driver.submit('/resume')

    expect(driver.state.sessionSwitcher?.scope).toBe('cwd')
    expect(driver.state.sessionSwitcher?.query).toBe('')
    expect(driver.state.sessionSwitcher?.sessions.map(s => s.id)).toEqual(['s-cur'])
    expect(driver.state.sessionSwitcher?.totalCount).toBe(2)

    // Tab reveals the other project, ordered by activity, with the focus
    // following the current session into the wider list.
    driver.sessionSwitcherToggleScope()
    expect(driver.state.sessionSwitcher?.scope).toBe('all')
    expect(driver.state.sessionSwitcher?.sessions.map(s => s.id)).toEqual(['s-far', 's-cur'])
    expect(driver.state.sessionSwitcher?.focused).toBe(1)

    // Tab back: the other project hides again.
    driver.sessionSwitcherToggleScope()
    expect(driver.state.sessionSwitcher?.scope).toBe('cwd')
    expect(driver.state.sessionSwitcher?.sessions.map(s => s.id)).toEqual(['s-cur'])
  })

  it('hides forked child sessions from the picker (same inherited title, different ids)', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-root', events: [], status: 'idle' },
      sessionList: [
        { id: 's-root', createdAt: 1000 },
        { id: 's-child-a', createdAt: 2000, parentSession: 's-root' },
        { id: 's-child-b', createdAt: 3000, parentSession: 's-root' },
        { id: 's-other', createdAt: 4000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')
    expect(driver.state.sessionSwitcher?.sessions.map(s => s.id)).toEqual(['s-other', 's-root'])
  })

  it('opens the overlay on an empty cwd scope when other projects have sessions', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-cur', events: [], status: 'idle' },
      sessionList: [{ id: 's-far', cwd: '/away', createdAt: 3000 }],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    await driver.submit('/resume')
    // The overlay still opens (Tab can reveal the rest) — no status fallback.
    expect(driver.state.sessionSwitcher?.sessions).toEqual([])
    expect(driver.state.sessionSwitcher?.totalCount).toBe(1)
    expect(driver.state.sessionSwitcher?.focused).toBe(0)
  })

  it('project scope shows subdirectory/worktree-cwd sessions of the same repo', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-cur', events: [], status: 'idle' },
      sessionList: [
        { id: 's-cur', createdAt: 1000 },
        { id: 's-sub', cwd: '/proj/packages/x', createdAt: 2000 },
        { id: 's-wt', cwd: '/proj/.claude/worktrees/feat', createdAt: 3000 },
        { id: 's-sibling', cwd: '/proj2', createdAt: 4000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')

    const ids = driver.state.sessionSwitcher?.sessions.map(s => s.id)
    expect(ids).toContain('s-sub')
    expect(ids).toContain('s-wt')
    // Prefix boundary: a sibling directory is NOT part of the project.
    expect(ids).not.toContain('s-sibling')
  })

  it('project scope shows sidecar-indexed sessions recorded under a foreign cwd', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-cur', events: [], status: 'idle' },
      sessionList: [
        { id: 's-cur', createdAt: 1000 },
        { id: 's-pinned', cwd: '/elsewhere', createdAt: 2000 },
      ],
    })
    // Pin the foreign-cwd session in /proj's bucket (as a switch into it
    // from within this project would have done).
    const key = createHash('sha256').update(resolve(PROJ_CWD)).digest('hex').slice(0, 16)
    recordProjectSessionId(join(tempHome, 'tui', 'projects', key), 's-pinned')

    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')

    expect(driver.state.sessionSwitcher?.sessions.map(s => s.id)).toContain('s-pinned')
  })

  it('types a query filter, backspaces it away, and refilters with focus tracking', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-alpha', events: [], status: 'idle' },
      sessionList: [
        { id: 's-alpha', createdAt: 2000 },
        { id: 's-beta', createdAt: 3000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')

    driver.sessionSwitcherType('b')
    expect(driver.state.sessionSwitcher?.query).toBe('b')
    expect(driver.state.sessionSwitcher?.sessions.map(s => s.id)).toEqual(['s-beta'])
    expect(driver.state.sessionSwitcher?.focused).toBe(0)

    driver.sessionSwitcherType('eta')
    expect(driver.state.sessionSwitcher?.sessions.map(s => s.id)).toEqual(['s-beta'])

    // Backspace past the whole query; the full (cwd-scoped) list returns and
    // the focus lands back on the current session.
    driver.sessionSwitcherBackspace()
    driver.sessionSwitcherBackspace()
    driver.sessionSwitcherBackspace()
    driver.sessionSwitcherBackspace()
    driver.sessionSwitcherBackspace() // already empty — no-op
    expect(driver.state.sessionSwitcher?.query).toBe('')
    expect(driver.state.sessionSwitcher?.sessions.map(s => s.id)).toEqual(['s-beta', 's-alpha'])
    expect(driver.state.sessionSwitcher?.focused).toBe(1)
  })

  it('escape is two-stage: clears a non-empty query first, then closes', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      sessionList: [
        { id: 's-a', createdAt: 1000 },
        { id: 's-b', createdAt: 2000 },
      ],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')

    driver.sessionSwitcherType('zzz') // matches nothing
    expect(driver.state.sessionSwitcher?.sessions).toEqual([])

    driver.sessionSwitcherCancel()
    // First stage: query cleared, overlay stays open, list restored.
    expect(driver.state.sessionSwitcher).toBeDefined()
    expect(driver.state.sessionSwitcher?.query).toBe('')
    expect(driver.state.sessionSwitcher?.sessions).toHaveLength(2)

    driver.sessionSwitcherCancel()
    // Second stage: overlay closes.
    expect(driver.state.sessionSwitcher).toBeUndefined()
  })

  it('decorates titles asynchronously from sessionQuery (rejections skipped)', async () => {
    let release: (() => void) | undefined
    const sessionQuery = {
      readTitleSnapshots: async (ids: readonly string[]) => {
        await new Promise<void>(resolve => {
          release = resolve
        })
        return ids.map(id => {
          if (id === 's-alpha') return { status: 'rejected' as const, sessionId: id }
          return {
            status: 'fulfilled' as const,
            sessionId: id,
            value: { session: { id }, ...id === 's-beta' ? { title: { title: 'Beta title' } } : {} },
          }
        })
      },
    }
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-alpha', events: [], status: 'idle' },
      sessionList: [
        { id: 's-alpha', createdAt: 2000 },
        { id: 's-beta', createdAt: 3000 },
      ],
      sessionQuery,
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    await driver.submit('/resume')
    // The overlay opens immediately, titles not yet applied.
    expect(driver.state.sessionSwitcher?.sessions.find(s => s.id === 's-beta')?.title).toBeUndefined()

    release?.()
    await new Promise(resolve => setTimeout(resolve, 0))

    // Fulfilled title merged; the rejected id and the title-less id stay clean.
    expect(driver.state.sessionSwitcher?.sessions.find(s => s.id === 's-beta')?.title).toBe('Beta title')
    expect(driver.state.sessionSwitcher?.sessions.find(s => s.id === 's-alpha')?.title).toBeUndefined()
  })

  it('drops a late title result after the overlay closed (generation guard)', async () => {
    let release: (() => void) | undefined
    const sessionQuery = {
      readTitleSnapshots: async (ids: readonly string[]) => {
        await new Promise<void>(resolve => {
          release = resolve
        })
        return ids.map(id => ({
          status: 'fulfilled' as const,
          sessionId: id,
          value: { session: { id }, title: { title: `late ${id}` } },
        }))
      },
    }
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      sessionList: [{ id: 's-b', createdAt: 1000 }],
      sessionQuery,
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    await driver.submit('/resume')
    driver.sessionSwitcherCancel() // closes the overlay before the read resolves
    release?.()
    await new Promise(resolve => setTimeout(resolve, 0))

    // The stale result must not resurrect or mutate any overlay state.
    expect(driver.state.sessionSwitcher).toBeUndefined()
  })

  it('joins titles on result.sessionId, not value.session.id (cloned headers are not the identity)', async () => {
    const sessionQuery = {
      readTitleSnapshots: async (ids: readonly string[]) => ids.map(id => ({
        status: 'fulfilled' as const,
        sessionId: id,
        // Cloned/reused header whose id does NOT match the requested session —
        // the real sessionQuery API's join key is `sessionId`.
        value: {
          session: { id: 's-alpha' },
          title: { title: id === 's-beta' ? 'Beta title' : 'Alpha title' },
        },
      })),
    }
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-alpha', events: [], status: 'idle' },
      sessionList: [
        { id: 's-alpha', createdAt: 2000 },
        { id: 's-beta', createdAt: 3000 },
      ],
      sessionQuery,
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(driver.state.sessionSwitcher?.sessions.find(s => s.id === 's-alpha')?.title).toBe('Alpha title')
    expect(driver.state.sessionSwitcher?.sessions.find(s => s.id === 's-beta')?.title).toBe('Beta title')
  })

  it('skips title decoration when no sessionQuery service is mounted', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      sessionList: [{ id: 's-b', createdAt: 1000 }],
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/resume')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(driver.state.sessionSwitcher?.sessions[0]!.title).toBeUndefined()
  })
})

describe('createDriver catalog refresh on session switch', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-skillcat-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  function makeCatalogSwitchCtx(opts: {
    resumeSessions: Record<string, { id: string; status?: string }>
  }): { ctx: Record<string, unknown> } {
    const makeAgent = (id: string): Record<string, unknown> => ({
      options: {},
      session: { id, header: { cwd: PROJ_CWD }, events: [] },
      id: `agent-${id}`,
      status: 'idle',
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
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
        if (key === 'commands') {
          return {
            list: (agent: { session: { id: string } }) => [
              { name: `cmd-for-${agent.session.id}`, description: 'scoped' },
            ],
          }
        }
        if (key === 'skills') {
          return {
            snapshot: async (opts: { scope?: { session: { id: string } } }) => ({
              skills: [{
                name: `skill-for-${opts.scope?.session.id ?? 'unknown'}`,
                description: 'scoped skill',
                invocation: { modelInvocable: true, userInvocable: true },
              }],
              complete: true,
            }),
          }
        }
        return undefined
      },
      on: () => () => {},
      agents: {
        create: async () => ({ agent: makeAgent('s-a'), dispose: async () => {} }),
        resume: async (req: { resumeSessionId: string }) => {
          const raw = opts.resumeSessions[req.resumeSessionId]
          if (raw === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
          return { agent: makeAgent(raw.id), dispose: async () => {} }
        },
      },
    }
    return { ctx }
  }

  it('refreshes commands AND skills after a successful switchSession', async () => {
    const { ctx } = makeCatalogSwitchCtx({ resumeSessions: { 's-b': { id: 's-b' } } })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await vi.waitFor(() => {
      const names = driver.listCommands().map(c => c.name)
      expect(names).toContain('cmd-for-s-a')
      expect(names).toContain('skill-for-s-a')
    })

    await driver.switchSession('s-b')

    await vi.waitFor(() => {
      const names = driver.listCommands().map(c => c.name)
      expect(names).toContain('cmd-for-s-b')
      expect(names).toContain('skill-for-s-b')
      expect(names).not.toContain('cmd-for-s-a')
      expect(names).not.toContain('skill-for-s-a')
    })
  })

  it('a failed resume does NOT swap the catalog', async () => {
    const { ctx } = makeCatalogSwitchCtx({ resumeSessions: {} })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await vi.waitFor(() => {
      const names = driver.listCommands().map(c => c.name)
      expect(names).toContain('cmd-for-s-a')
      expect(names).toContain('skill-for-s-a')
    })
    await driver.switchSession('s-missing')
    await new Promise(r => setTimeout(r, 10))
    const names = driver.listCommands().map(c => c.name)
    expect(names).toContain('cmd-for-s-a')
    expect(names).toContain('skill-for-s-a')
    expect(names).not.toContain('cmd-for-s-missing')
  })
})

describe('createDriver session title state', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-title-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  const titleEvent = (title: string) => ({
    type: 'session/title',
    data: { title, messageSeqs: [1], source: 'provider' },
  })

  it('folds the boot session history title into state', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [titleEvent('Boot title')], status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    expect(driver.state.title).toBe('Boot title')
  })

  it('switchSession clears a stale title when the new session has none', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [titleEvent('Alpha work')], status: 'idle' },
      resumeSessions: { 's-b': { id: 's-b', events: [], status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    expect(driver.state.title).toBe('Alpha work')

    await driver.switchSession('s-b')

    expect(driver.state.title).toBeUndefined()
  })

  it('switchSession adopts the new session title from its folded history', async () => {
    const { ctx } = makeSwitchableCtx({
      createSession: { id: 's-a', events: [titleEvent('Alpha work')], status: 'idle' },
      resumeSessions: { 's-b': { id: 's-b', events: [titleEvent('Beta work')], status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })

    await driver.switchSession('s-b')

    expect(driver.state.title).toBe('Beta work')
  })
})
