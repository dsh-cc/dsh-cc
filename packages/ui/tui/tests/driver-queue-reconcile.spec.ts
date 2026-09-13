import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * W2: zombie-busy reconciliation in submit/steerQueued. When state.busy is
 * latched but the agent's ground-truth status is not 'running', the busy gate
 * reconciles: clears busy/turn/queue, re-dispatches queued chips FIFO through
 * dispatchQueued (synchronously, so slash commands reclassify), then falls
 * through to the idle-send path. With status 'running' the chip path is
 * unchanged.
 */

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
    session: { id: 's-reconcile', header: {}, events: [], snapshotEvents() { return this.events } },
    id: 'a-reconcile',
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

function makeCtx(agent: FakeAgent, ccPlugins?: unknown): {
  ctx: Record<string, unknown>
  setAgentStatus: (status: string) => void
} {
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'ccPlugins') return ccPlugins
      return undefined
    },
    on(_event: string, _handler: (...args: unknown[]) => void) {
      return () => {}
    },
    agents: {
      create: async () => ({ agent, dispose: async () => {} }),
      resume: async () => ({ agent, dispose: async () => {} }),
    },
  }
  return { ctx, setAgentStatus: (status: string) => { agent.status = status } }
}

const sentTexts = (calls: readonly unknown[][]): string[] =>
  calls.map(call => {
    const message = call[0] as { content?: readonly { type?: string; text?: string }[] }
    return (message.content ?? [])
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')
  })

describe('zombie-busy reconciliation (W2)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-reconcile-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  /** busy + turn anchor + one queued chip, with a controllable agent status. */
  it('submit under zombie busy re-dispatches chips FIFO, then sends the draft', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, setAgentStatus } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    // The fake agent boots as 'running', so the UI starts busy: both submits
    // park as chips. Then the pipeline dies — ground truth flips to idle
    // while UI busy stays latched.
    await driver.submit('chip one')
    await driver.submit('queued chip')
    setAgentStatus('idle')

    await driver.submit('next draft')

    expect(sentTexts(agent.followup.mock.calls)).toEqual(['chip one', 'queued chip', 'next draft'])
    expect(driver.state.queued).toEqual([])
    // The new draft re-anchors busy + the turn optimistically.
    expect(driver.state.busy).toBe(true)
    expect(driver.state.turn).toBeDefined()
  })

  it('submit under zombie busy routes a queued plugin slash command through dispatchQueued', async () => {
    const runPluginCommand = vi.fn(async () => ({ ok: true as const }))
    const ccPlugins = {
      listPluginCommands: () => [{ name: 'review' }],
      runPluginCommand,
    }
    const agent = makeFakeAgent('running')
    const { ctx, setAgentStatus } = makeCtx(agent, ccPlugins)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('/review the diff')
    setAgentStatus('idle')

    await driver.submit('next draft')

    expect(runPluginCommand).toHaveBeenCalledTimes(1)
    expect(runPluginCommand.mock.calls[0]?.[0]).toBe('review')
    expect(sentTexts(agent.followup.mock.calls)).toEqual(['next draft'])
    expect(driver.state.queued).toEqual([])
  })

  it('submit while genuinely busy keeps the chip path unchanged (regression pin)', async () => {
    const agent = makeFakeAgent('running')
    const { ctx } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('queued chip')

    expect(driver.state.queued).toEqual(['queued chip'])
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('Ctrl+S steer under zombie busy reconciles before steering', async () => {
    const agent = makeFakeAgent('running')
    const { ctx, setAgentStatus } = makeCtx(agent)
    const driver = await createDriver(ctx as never, {})
    await driver.submit('queued chip')
    setAgentStatus('idle')

    driver.steerQueued()

    expect(sentTexts(agent.followup.mock.calls)).toEqual(['queued chip'])
    expect(driver.state.queued).toEqual([])
    expect(driver.state.busy).toBe(false)
    expect(driver.state.turn).toBeUndefined()
  })
})
