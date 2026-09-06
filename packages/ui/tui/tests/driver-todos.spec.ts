import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Fake sessionProjections service (same registry shape the driver consumes
 * structurally): `stateOf` reads a per-session key→state map and
 * `onChanged` listeners are drivable by hand.
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
}

/** Minimal ctx stub with a sessionProjections service and switchable agents. */
function makeTodosCtx(opts: {
  projections?: ReturnType<typeof makeProjections>
  resumeSessions?: Record<string, FakeSession>
}) {
  const createSession: FakeSession = { id: 's-a', events: [], status: 'idle' }
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
    dispose: async () => {},
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
  return { ctx }
}

const todoList = (...items: Array<[string, string]>) =>
  items.map(([content, status]) => ({ content, status }))

describe('createDriver todos (sessionProjections feed)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-todos-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('folds todos changes for our session into state.todos', async () => {
    const projections = makeProjections()
    const { ctx } = makeTodosCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    expect(driver.state.todos).toBeUndefined()

    projections.fire('s-a', 'todos', todoList(['a', 'completed'], ['b', 'in_progress']))
    expect(driver.state.todos).toEqual([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ])

    // Whole-list last-wins: a later list replaces the earlier one.
    projections.fire('s-a', 'todos', todoList(['c', 'pending']))
    expect(driver.state.todos).toEqual([{ content: 'c', status: 'pending' }])
  })

  it('drops malformed todo entries defensively', async () => {
    const projections = makeProjections()
    const { ctx } = makeTodosCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-a', 'todos', [
      { content: 'ok', status: 'pending' },
      { content: 42, status: 'pending' },
      { status: 'pending' },
      { content: 'bad status', status: 'weird' },
      null,
      'nope',
    ])
    expect(driver.state.todos).toEqual([{ content: 'ok', status: 'pending' }])
  })

  it('a null todos value clears the strip', async () => {
    const projections = makeProjections()
    const { ctx } = makeTodosCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-a', 'todos', todoList(['a', 'pending']))
    expect(driver.state.todos).toHaveLength(1)

    projections.fire('s-a', 'todos', null)
    expect(driver.state.todos).toBeUndefined()
  })

  it('does not emit when the todos list carries the same values', async () => {
    const projections = makeProjections()
    const { ctx } = makeTodosCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-a', 'todos', todoList(['a', 'pending']))
    const afterFirst = driver.state
    projections.fire('s-a', 'todos', todoList(['a', 'pending']))
    expect(driver.state).toBe(afterFirst)
  })

  it('ignores todos changes for another session id', async () => {
    const projections = makeProjections()
    const { ctx } = makeTodosCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    projections.fire('s-other', 'todos', todoList(['a', 'pending']))
    expect(driver.state.todos).toBeUndefined()
  })

  it('seeds todos from stateOf at boot', async () => {
    const projections = makeProjections({
      's-a': { todos: todoList(['seeded', 'in_progress']) },
    })
    const { ctx } = makeTodosCtx({ projections })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })

    expect(driver.state.todos).toEqual([{ content: 'seeded', status: 'in_progress' }])
  })

  it('switchSession re-seeds todos and clears them when the new session has none', async () => {
    const projections = makeProjections({
      's-a': { todos: todoList(['old-session', 'pending']) },
      's-b': { todos: todoList(['new-session', 'in_progress']) },
      's-c': {},
    })
    const { ctx } = makeTodosCtx({
      projections,
      resumeSessions: {
        's-b': { id: 's-b', events: [], status: 'idle' },
        's-c': { id: 's-c', events: [], status: 'idle' },
      },
    })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    expect(driver.state.todos).toEqual([{ content: 'old-session', status: 'pending' }])

    await driver.switchSession('s-b')
    expect(driver.state.todos).toEqual([{ content: 'new-session', status: 'in_progress' }])

    // s-c has no todos: nothing may leak from s-a or s-b.
    await driver.switchSession('s-c')
    expect(driver.state.todos).toBeUndefined()
  })

  it('late todos events from the disposed session are dropped after a switch', async () => {
    const projections = makeProjections({ 's-a': {} })
    const { ctx } = makeTodosCtx({
      projections,
      resumeSessions: { 's-b': { id: 's-b', events: [], status: 'idle' } },
    })
    const driver = await createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
    await driver.switchSession('s-b')

    projections.fire('s-a', 'todos', todoList(['stale', 'pending']))
    expect(driver.state.todos).toBeUndefined()
  })
})
