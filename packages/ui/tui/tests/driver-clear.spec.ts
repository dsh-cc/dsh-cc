import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { readResumeTarget } from '@dsh-cc/tui/resume-target.ts'

interface FakeSession {
  id: string
  events?: unknown[]
  status?: string
  provider?: string
  model?: string
  cwd?: string
}

interface CreateCall {
  sessionId?: string
  meta?: { cwd?: string }
  agentOptions?: { provider: string; model: string }
}

const PROJ_CWD = '/proj'

const userEvent = (text: string): unknown => ({
  type: 'user/message',
  data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
})

function makeClearCtx(opts: {
  createSession?: FakeSession
  resumeSessions?: Record<string, FakeSession>
  failCreate?: boolean
  rules?: boolean
  commands?: boolean
}): {
  ctx: Record<string, unknown>
  disposed: string[]
  createCalls: CreateCall[]
  resumeCalls: { resumeSessionId: string }[]
  cancels: { id: string; args: unknown }[]
  setModeCalls: { agentId: string; mode: string }[]
  executed: string[]
} {
  const disposed: string[] = []
  const createCalls: CreateCall[] = []
  const resumeCalls: { resumeSessionId: string }[] = []
  const cancels: { id: string; args: unknown }[] = []
  const setModeCalls: { agentId: string; mode: string }[] = []
  const executed: string[] = []
  const boot = { cwd: PROJ_CWD, ...opts.createSession ?? { id: 's-a', events: [], status: 'idle' } }
  let boots = 0
  const approvalHandlers = new Set<(req: unknown, next: () => void) => void>()

  const makeAgent = (s: FakeSession, agentOptions?: { provider: string; model: string }) => {
    const options = s.provider !== undefined && s.model !== undefined
      ? { provider: s.provider, model: s.model }
      : agentOptions ?? {}
    const agent = {
      options,
      session: { id: s.id, header: s.cwd === undefined ? {} : { cwd: s.cwd }, events: s.events ?? [] },
      id: `agent-${s.id}`,
      status: s.status ?? 'idle',
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn((args: unknown) => { cancels.push({ id: s.id, args }) }),
    }
    return agent
  }
  const makeHandle = (s: FakeSession, agentOptions?: { provider: string; model: string }) => ({
    agent: makeAgent(s, agentOptions),
    dispose: async () => { disposed.push(s.id) },
  })

  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return { defaultId: 'cc', resolve: async () => ({ id: 'cc' }), mount: async () => ({ id: 'cc' }) }
      }
      if (key === 'permissionRules') {
        return opts.rules === true
          ? {
            setMode: (agent: { id: string }, mode: string) => {
              setModeCalls.push({ agentId: agent.id, mode })
            },
          }
          : undefined
      }
      if (key === 'commands') {
        return opts.commands === true || opts.rules === true
          ? {
            list: () => [],
            execute: async (_agent: unknown, line: string) => {
              executed.push(line)
              return { result: { kind: 'success', text: `ran ${line}` } }
            },
          }
          : undefined
      }
      return undefined
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'approval/request') {
        approvalHandlers.add(handler as (req: unknown, next: () => void) => void)
      }
      return () => {}
    },
    agents: {
      create: async (req: CreateCall) => {
        createCalls.push(req)
        if (boots === 0) {
          boots += 1
          return makeHandle(boot, req.agentOptions)
        }
        if (opts.failCreate === true) throw new Error('create exploded')
        const id = String(req.sessionId ?? `tui-${createCalls.length}`)
        return makeHandle({
          id,
          events: [],
          status: 'idle',
          cwd: req.meta?.cwd,
        }, req.agentOptions)
      },
      resume: async (req: { resumeSessionId: string }) => {
        resumeCalls.push(req)
        const raw = opts.resumeSessions?.[req.resumeSessionId]
        if (raw === undefined) throw new Error(`unknown session: ${req.resumeSessionId}`)
        return makeHandle({ cwd: PROJ_CWD, ...raw })
      },
    },
  }
  ;(ctx as { _fireApproval: (req: unknown) => void })._fireApproval = (req: unknown) => {
    for (const handler of approvalHandlers) handler(req, () => {})
  }
  return { ctx, disposed, createCalls, resumeCalls, cancels, setModeCalls, executed }
}

function statusTexts(driver: { state: { rows: readonly { kind: string; text?: string }[] } }): string[] {
  return driver.state.rows.filter(row => row.kind === 'status').map(row => row.text ?? '')
}

describe('createDriver /clear /new /reset', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-clear-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('/clear creates a new session, disposes the old handle, and drops prior rows', async () => {
    const { ctx, disposed, createCalls, resumeCalls } = makeClearCtx({
      createSession: { id: 's-a', events: [userEvent('old turn')], status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'old turn' })
    const bootCreates = createCalls.length

    await driver.submit('/clear')

    expect(createCalls.length).toBe(bootCreates + 1)
    expect(resumeCalls).toEqual([])
    expect(disposed).toEqual(['s-a'])
    expect(driver.state.rows).not.toContainEqual({ kind: 'user', text: 'old turn' })
    expect(driver.state.rows[0]).toMatchObject({ kind: 'banner' })
    expect(driver.state.rows[1]).toMatchObject({ kind: 'status' })
    expect((driver.state.rows[1] as { text: string }).text).toMatch(/dsh cc-mode/)
  })

  it('/new and /reset take the same create path', async () => {
    for (const cmd of ['/new', '/reset'] as const) {
      const { ctx, disposed, createCalls, resumeCalls } = makeClearCtx({
        createSession: { id: 's-a', events: [userEvent('old turn')], status: 'idle' },
      })
      const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
      const bootCreates = createCalls.length
      await driver.submit(cmd)
      expect(createCalls.length).toBe(bootCreates + 1)
      expect(resumeCalls).toEqual([])
      expect(disposed).toEqual(['s-a'])
      expect(driver.state.rows).not.toContainEqual({ kind: 'user', text: 'old turn' })
    }
  })

  it('after /clear, /resume <oldId> restores the previous rows', async () => {
    const oldEvents = [userEvent('old turn')]
    const { ctx } = makeClearCtx({
      createSession: { id: 's-a', events: oldEvents, status: 'idle' },
      resumeSessions: { 's-a': { id: 's-a', events: oldEvents, status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/clear')
    expect(driver.state.rows).not.toContainEqual({ kind: 'user', text: 'old turn' })

    await driver.submit('/resume s-a')
    expect(driver.state.rows).toContainEqual({ kind: 'user', text: 'old turn' })
  })

  it('failed create keeps the old session and emits Start failed', async () => {
    const { ctx, disposed, createCalls } = makeClearCtx({
      createSession: { id: 's-a', events: [userEvent('keep me')], status: 'idle' },
      failCreate: true,
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    const originalRows = [...driver.state.rows]
    const markerBefore = readResumeTarget({ cwd: PROJ_CWD })

    await driver.submit('/clear')

    expect(disposed).toEqual([])
    expect(createCalls.length).toBeGreaterThan(1)
    const last = driver.state.rows.at(-1)
    expect(last?.kind).toBe('status')
    expect((last as { text: string }).text).toMatch(/Start failed/)
    expect(driver.state.rows.slice(0, originalRows.length)).toEqual(originalRows)
    expect(readResumeTarget({ cwd: PROJ_CWD })).toBe(markerBefore)
  })

  it('drains a parked approval on success', async () => {
    const { ctx, disposed } = makeClearCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    const fire = (ctx as { _fireApproval: (req: unknown) => void })._fireApproval
    fire({
      agent: { id: 'agent-s-a', session: { id: 's-a', events: [] } },
      toolName: 'Bash',
      callId: undefined,
      reason: undefined,
      signal: { addEventListener: () => {}, removeEventListener: () => {} },
    })
    expect(driver.state.approval).toBeDefined()

    await driver.submit('/clear')
    expect(driver.state.approval).toBeUndefined()
    expect(disposed).toEqual(['s-a'])
  })

  it('writes the resume marker to the new session id', async () => {
    const { ctx, createCalls } = makeClearCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/clear')
    const newId = String(createCalls.at(-1)?.sessionId)
    expect(newId.length).toBeGreaterThan(0)
    expect(readResumeTarget({ cwd: PROJ_CWD })).toBe(newId)
  })

  it('passes the live /model route as create agentOptions', async () => {
    const { ctx, createCalls } = makeClearCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD, provider: 'p', model: 'm' })
    await driver.submit('/clear')
    expect(createCalls.at(-1)?.agentOptions).toEqual({ provider: 'p', model: 'm' })
  })

  it('failed create on a running turn does not cancel, drain, or dispose', async () => {
    const { ctx, disposed, cancels } = makeClearCtx({
      createSession: { id: 's-a', events: [userEvent('keep me')], status: 'running' },
      failCreate: true,
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    const originalRows = [...driver.state.rows]
    const markerBefore = readResumeTarget({ cwd: PROJ_CWD })

    await driver.submit('/clear')

    expect(cancels).toEqual([])
    expect(disposed).toEqual([])
    expect(driver.state.busy).toBe(true)
    expect(driver.state.rows.slice(0, originalRows.length)).toEqual(originalRows)
    const last = driver.state.rows.at(-1)
    expect((last as { text: string }).text).toMatch(/Start failed/)
    expect(readResumeTarget({ cwd: PROJ_CWD })).toBe(markerBefore)
  })

  it('failed create keeps a parked approval parked', async () => {
    const { ctx, disposed } = makeClearCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      failCreate: true,
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    const fire = (ctx as { _fireApproval: (req: unknown) => void })._fireApproval
    fire({
      agent: { id: 'agent-s-a', session: { id: 's-a', events: [] } },
      toolName: 'Bash',
      callId: undefined,
      reason: undefined,
      signal: { addEventListener: () => {}, removeEventListener: () => {} },
    })
    expect(driver.state.approval).toBeDefined()

    await driver.submit('/clear')

    expect(driver.state.approval).toBeDefined()
    expect(disposed).toEqual([])
  })

  it('cancels a running turn before dispose and drops the interrupt row', async () => {
    const { ctx, cancels, createCalls } = makeClearCtx({
      createSession: { id: 's-a', events: [userEvent('old turn')], status: 'running' },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    expect(driver.state.busy).toBe(true)
    const bootCreates = createCalls.length

    await driver.submit('/clear')

    expect(cancels).toContainEqual({ id: 's-a', args: { kind: 'user' } })
    expect(createCalls.length).toBe(bootCreates + 1)
    expect(statusTexts(driver).join('\n')).not.toMatch(/Interrupted by user/)
  })

  it('re-applies a non-default permission mode on the new agent', async () => {
    const { ctx, setModeCalls } = makeClearCtx({
      createSession: {
        id: 's-a',
        events: [{ type: 'permission/mode', data: { mode: 'acceptEdits' } }],
        status: 'idle',
      },
      rules: true,
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/clear')
    expect(setModeCalls.some(c => c.mode === 'acceptEdits' && c.agentId !== 'agent-s-a')).toBe(true)
  })

  it('does not call setMode when the captured mode is default', async () => {
    const { ctx, setModeCalls } = makeClearCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
      rules: true,
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/clear')
    expect(setModeCalls).toEqual([])
  })

  it('creates with the live session cwd, not the process cwd', async () => {
    const { ctx, createCalls } = makeClearCtx({
      createSession: { id: 's-a', events: [], status: 'idle', cwd: '/worktree' },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/clear')
    expect(createCalls.at(-1)?.meta?.cwd).toBe('/worktree')
  })

  it('double /clear creates twice with distinct ids', async () => {
    const { ctx, createCalls, disposed } = makeClearCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    const bootCreates = createCalls.length
    await driver.submit('/clear')
    await driver.submit('/clear')
    const fresh = createCalls.slice(bootCreates)
    expect(fresh).toHaveLength(2)
    expect(String(fresh[0]?.sessionId)).not.toBe(String(fresh[1]?.sessionId))
    expect(disposed[0]).toBe('s-a')
    expect(disposed).toHaveLength(2)
  })

  it('re-enters plan mode via /plan, not setMode(plan)', async () => {
    const { ctx, executed, setModeCalls } = makeClearCtx({
      createSession: {
        id: 's-a',
        events: [{ type: 'plan/mode', data: { active: true } }],
        status: 'idle',
      },
      rules: true,
      commands: true,
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD })
    await driver.submit('/clear')
    expect(executed).toContain('/plan')
    expect(setModeCalls.some(c => c.mode === 'plan')).toBe(false)
  })

  it('falls back to boot agentOptions when that is the live route', async () => {
    const { ctx, createCalls } = makeClearCtx({
      createSession: { id: 's-a', events: [], status: 'idle' },
    })
    const driver = await createDriver(ctx as never, { cwd: PROJ_CWD, provider: 'boot-p', model: 'boot-m' })
    await driver.submit('/clear')
    expect(createCalls.at(-1)?.agentOptions).toEqual({ provider: 'boot-p', model: 'boot-m' })
  })
})
