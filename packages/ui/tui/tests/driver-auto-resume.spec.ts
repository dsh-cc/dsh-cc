import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { readResumeTarget, writeResumeTarget } from '@dsh-cc/tui/resume-target.ts'

/** Duck-typed ctx stub (same idiom as driver-resume-marker.spec.ts). */
function makeCtx(opts: { resumeError?: Error; resumeId?: string }): {
  ctx: Record<string, unknown>
  resumeCalls: unknown[]
  createCalls: unknown[]
} {
  const resumeCalls: unknown[] = []
  const createCalls: unknown[] = []
  const makeHandle = (id: string) => ({
    agent: {
      options: {},
      session: { id, header: {}, events: [], snapshotEvents() { return this.events } },
      id: `agent-${id}`,
      status: 'idle',
      followup: vi.fn(),
      steer: vi.fn(),
      cancel: vi.fn(),
    },
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
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async () => {
        createCalls.push(1)
        return makeHandle('s-fresh')
      },
      resume: async (req: unknown) => {
        resumeCalls.push(req)
        if (opts.resumeError !== undefined) throw opts.resumeError
        return makeHandle(opts.resumeId ?? 's-old')
      },
    },
  }
  return { ctx, resumeCalls, createCalls }
}

/**
 * Resume lock contention: when the anchored session is still owned by another
 * RUNNING TUI, agents.resume rejects with SessionAlreadyOwnedError — that is
 * NOT a stale marker and the resume.txt anchor must survive the boot.
 */
describe('createDriver auto-resume failure policy', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-auto-resume-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('SessionAlreadyOwnedError keeps the marker and opens a fresh session with the ownership notice', async () => {
    writeResumeTarget('s-old')
    const { ctx, resumeCalls, createCalls } = makeCtx({
      resumeError: Object.assign(new Error('session already owned'), { name: 'SessionAlreadyOwnedError' }),
    })
    const driver = await createDriver(ctx as never, { autoResume: true })
    expect(resumeCalls).toHaveLength(1)
    expect(createCalls).toHaveLength(1)
    expect(readResumeTarget()).toBe('s-old')
    expect(driver.state.notice).toContain('仍在另一个窗口')
    await driver.dispose()
  })

  it('a generic resume failure clears the marker with the stale-session notice', async () => {
    writeResumeTarget('s-old')
    const { ctx, createCalls } = makeCtx({ resumeError: new Error('boom') })
    const driver = await createDriver(ctx as never, { autoResume: true })
    expect(createCalls).toHaveLength(1)
    expect(readResumeTarget()).toBeUndefined()
    expect(driver.state.notice).toContain('上次会话已失效')
    await driver.dispose()
  })

  it('a successful resume shows no failure notice and uses the resumed handle', async () => {
    writeResumeTarget('s-old')
    const { ctx, resumeCalls, createCalls } = makeCtx({ resumeId: 's-old' })
    const driver = await createDriver(ctx as never, { autoResume: true })
    expect(resumeCalls).toHaveLength(1)
    expect(createCalls).toHaveLength(0)
    expect(readResumeTarget()).toBe('s-old')
    // No resume-failure notice (an unrelated boot/worktree notice may exist).
    expect(driver.state.notice).not.toContain('上次会话已失效')
    expect(driver.state.notice).not.toContain('仍在另一个窗口')
    await driver.dispose()
  })
})
