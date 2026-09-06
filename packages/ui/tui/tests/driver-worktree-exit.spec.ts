import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import type {
  WorktreeCleanupOutcome,
  WorktreeExitEvidence,
  WorktreeExitHooks,
  WorktreeExitSession,
} from '@dsh-cc/tui/harness/worktree-exit.ts'

interface FakeAgent extends Record<string, unknown> {
  options: Record<string, unknown>
  session: { id: string; header: Record<string, unknown>; events: unknown[] }
  id: string
  status: string
  followup: ReturnType<typeof vi.fn>
  steer: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

function makeFakeAgent(status: string): FakeAgent {
  return {
    options: {},
    session: { id: 's-wt', header: {}, events: [] },
    id: 'a-wt',
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

function makeCtx(agent: FakeAgent, dispose: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return {
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
    on() {
      return () => {}
    },
    agents: {
      create: async () => ({ agent, dispose }),
      resume: async () => ({ agent, dispose }),
    },
  }
}

const MANAGED: WorktreeExitSession = {
  kind: 'managed',
  repoRoot: '/repo',
  worktreePath: '/repo/.claude/worktrees/feat',
  branch: 'worktree-feat',
  baseHead: 'abc123',
}

/** A configurable hook set; default happy-path hooks. Returns hooks plus a
 * mutable `ref` whose `.session` the probe reads, so tests can flip whether a
 * worktree is detected. */
function makeHooks(overrides: Partial<WorktreeExitHooks> = {}): WorktreeExitHooks & {
  ref: { session: WorktreeExitSession | undefined }
  cleaned: unknown[]
  evident: unknown[]
} {
  const ref = { session: MANAGED as WorktreeExitSession | undefined }
  const cleaned: unknown[] = []
  const evident: unknown[] = []
  const hooks: WorktreeExitHooks = {
    probe: vi.fn(async () => ref.session),
    evidence: vi.fn(async () => {
      evident.push(1)
      return { dirtyFiles: 2, commitsAhead: 3 } satisfies WorktreeExitEvidence
    }),
    cleanup: vi.fn(async (sess: WorktreeExitSession) => {
      cleaned.push(sess)
      return { branchDeleted: true } satisfies WorktreeCleanupOutcome
    }),
    ...overrides,
  }
  return { ...hooks, ref, cleaned, evident }
}

describe('createDriver /quit worktree-exit', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-wt-exit-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('plain /quit (no worktree) disposes and fires onQuit without opening the overlay', async () => {
    const agent = makeFakeAgent('idle')
    const dispose = vi.fn()
    const ctx = makeCtx(agent, dispose)
    const hooks = makeHooks()
    hooks.ref.session = undefined // no worktree detected
    const onQuit = vi.fn()
    const driver = await createDriver(ctx as never, { worktreeExit: hooks, onQuit })

    await driver.submit('/quit')
    expect(dispose).toHaveBeenCalledOnce()
    expect(onQuit).toHaveBeenCalledOnce()
    expect(driver.state.worktreeExit).toBeUndefined()
  })

  it('opens the worktree-exit overlay on /quit and defers dispose/onQuit', async () => {
    const agent = makeFakeAgent('idle')
    const dispose = vi.fn()
    const ctx = makeCtx(agent, dispose)
    const hooks = makeHooks()
    const onQuit = vi.fn()
    const driver = await createDriver(ctx as never, { worktreeExit: hooks, onQuit })

    await driver.submit('/quit')
    expect(driver.state.worktreeExit).toBeDefined()
    expect(driver.state.worktreeExit?.focused).toBe(0)
    expect(driver.state.worktreeExit?.busy).toBe(false)
    expect(driver.state.worktreeExit?.dirtyFiles).toBe(2)
    expect(driver.state.worktreeExit?.commitsAhead).toBe(3)
    expect(driver.state.worktreeExit?.managed).toBe(true)
    expect(driver.state.worktreeExit?.ownsBranch).toBe(true)
    expect(driver.state.worktreeExit?.worktreePath).toBe(MANAGED.worktreePath)
    // Nothing torn down yet.
    expect(dispose).not.toHaveBeenCalled()
    expect(onQuit).not.toHaveBeenCalled()
  })

  it('keep (focused 0) closes the overlay and quits without touching git cleanup', async () => {
    const agent = makeFakeAgent('idle')
    const dispose = vi.fn()
    const ctx = makeCtx(agent, dispose)
    const hooks = makeHooks()
    const onQuit = vi.fn()
    const driver = await createDriver(ctx as never, { worktreeExit: hooks, onQuit })
    await driver.submit('/quit')
    expect(driver.state.worktreeExit).toBeDefined()

    await driver.worktreeExitSubmit()
    expect(driver.state.worktreeExit).toBeUndefined()
    expect(hooks.cleanup).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
    expect(onQuit).toHaveBeenCalledOnce()
  })

  it('remove (focused 1) runs cleanup with the right session, then quits', async () => {
    const agent = makeFakeAgent('idle')
    const dispose = vi.fn()
    const ctx = makeCtx(agent, dispose)
    const hooks = makeHooks()
    const onQuit = vi.fn()
    const driver = await createDriver(ctx as never, { worktreeExit: hooks, onQuit })
    await driver.submit('/quit')
    await driver.worktreeExitMove(1)

    await driver.worktreeExitSubmit()
    expect(hooks.cleanup).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'managed',
      repoRoot: MANAGED.repoRoot,
      worktreePath: MANAGED.worktreePath,
      branch: MANAGED.branch,
    }))
    expect(driver.state.worktreeExit).toBeUndefined()
    expect(dispose).toHaveBeenCalledOnce()
    expect(onQuit).toHaveBeenCalledOnce()
  })

  it('cleanup failure closes the overlay, notices, and keeps the session alive (no dispose/onQuit)', async () => {
    const agent = makeFakeAgent('idle')
    const dispose = vi.fn()
    const ctx = makeCtx(agent, dispose)
    const hooks = makeHooks({
      cleanup: vi.fn(async () => { throw new Error('worktree in use') }),
    })
    const onQuit = vi.fn()
    const driver = await createDriver(ctx as never, { worktreeExit: hooks, onQuit })
    await driver.submit('/quit')
    await driver.worktreeExitMove(1)

    await driver.worktreeExitSubmit()
    expect(driver.state.worktreeExit).toBeUndefined()
    expect(driver.state.notice).toMatch(/Worktree cleanup failed: worktree in use/i)
    expect(dispose).not.toHaveBeenCalled()
    expect(onQuit).not.toHaveBeenCalled()
  })

  it('cancel (focused 2 submit) closes the overlay and keeps the session alive', async () => {
    const agent = makeFakeAgent('idle')
    const dispose = vi.fn()
    const ctx = makeCtx(agent, dispose)
    const hooks = makeHooks()
    const onQuit = vi.fn()
    const driver = await createDriver(ctx as never, { worktreeExit: hooks, onQuit })
    await driver.submit('/quit')
    await driver.worktreeExitMove(2)

    await driver.worktreeExitSubmit()
    expect(driver.state.worktreeExit).toBeUndefined()
    expect(hooks.cleanup).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
    expect(onQuit).not.toHaveBeenCalled()
  })

  it('worktreeExitCancel (esc) closes the overlay without quitting', async () => {
    const agent = makeFakeAgent('idle')
    const dispose = vi.fn()
    const ctx = makeCtx(agent, dispose)
    const driver = await createDriver(ctx as never, { worktreeExit: makeHooks(), onQuit: vi.fn() })
    await driver.submit('/quit')
    expect(driver.state.worktreeExit).toBeDefined()

    driver.worktreeExitCancel()
    expect(driver.state.worktreeExit).toBeUndefined()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('moves clamp within [0, 2]', async () => {
    const agent = makeFakeAgent('idle')
    const ctx = makeCtx(agent, vi.fn())
    const driver = await createDriver(ctx as never, { worktreeExit: makeHooks(), onQuit: vi.fn() })
    await driver.submit('/quit')
    expect(driver.state.worktreeExit?.focused).toBe(0)

    driver.worktreeExitMove(-1)
    expect(driver.state.worktreeExit?.focused).toBe(0)
    driver.worktreeExitMove(1)
    driver.worktreeExitMove(1)
    driver.worktreeExitMove(1)
    expect(driver.state.worktreeExit?.focused).toBe(2)
  })

  it('busy guards: move/cancel are ignored and submit does not double-fire', async () => {
    const agent = makeFakeAgent('idle')
    const dispose = vi.fn()
    const ctx = makeCtx(agent, dispose)
    let resolveCleanup: (() => void) | undefined
    const hooks = makeHooks({
      cleanup: vi.fn(async () => new Promise<WorktreeCleanupOutcome>((resolve) => {
        resolveCleanup = () => resolve({ branchDeleted: true })
      })),
    })
    const onQuit = vi.fn()
    const driver = await createDriver(ctx as never, { worktreeExit: hooks, onQuit })
    await driver.submit('/quit')
    await driver.worktreeExitMove(1)

    const pending = driver.worktreeExitSubmit()
    expect(driver.state.worktreeExit?.busy).toBe(true)

    // While busy: submit/move/cancel are all no-ops.
    await driver.worktreeExitSubmit()
    driver.worktreeExitMove(1)
    driver.worktreeExitCancel()
    expect(driver.state.worktreeExit?.focused).toBe(1) // move ignored while busy
    expect(driver.state.worktreeExit?.busy).toBe(true) // cancel ignored while busy
    expect(dispose).not.toHaveBeenCalled()

    resolveCleanup!()
    await pending
    expect(driver.state.worktreeExit).toBeUndefined()
    expect(dispose).toHaveBeenCalledOnce()
    expect(hooks.cleanup).toHaveBeenCalledOnce()
  })
})
