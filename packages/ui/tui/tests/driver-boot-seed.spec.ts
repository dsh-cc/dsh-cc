import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Boot-seed contract (W4): the deployment default-model seed fires early
 * (never blocking the first frame) and every model-turn path — submit and
 * /effort — awaits the settled seed before dispatch/enqueue. The no-model
 * notice is emitted only from the settled continuation (slow boots never
 * flash it), and a settled seed upserts the banner's model label.
 */

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * A ctx stub whose `agentDefaultModel.currentSelection()` is a controllable
 * async seam: the boot seed stays pending until the test resolves it. Sent
 * followup messages are captured on the fake agent.
 */
function makeSeedCtx(): {
  ctx: Record<string, unknown>
  gate: { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  sent: { text: string }[]
} {
  const gate = deferred<unknown>()
  const sent: { text: string }[] = []
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return {
          defaultId: 'cc',
          resolve: async () => ({ id: 'cc' }),
          mount: async () => ({ id: 'cc' }),
        }
      }
      if (key === 'agentDefaultModel') {
        return { currentSelection: () => gate.promise as never }
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async (o: unknown) => {
        const agentOpts = (o as { agentOptions?: Record<string, unknown> })?.agentOptions ?? {}
        return {
          agent: {
            options: agentOpts,
            session: { id: 's-boot', header: {}, events: [] },
            id: 'a-boot',
            status: 'idle',
            followup(message: { content: { text?: string }[] }) {
              sent.push({ text: message.content?.find(p => p.text !== undefined)?.text ?? '' })
            },
            cancel() {},
          },
          dispose: async () => {},
        }
      },
    },
  }
  return { ctx, gate, sent }
}

const bannerRows = (state: { rows: { kind: string; text?: string }[] }): string[] =>
  state.rows.filter(r => r.kind === 'status' && r.text?.startsWith('dsh cc-mode')).map(r => r.text ?? '')

const noModelNotices = (state: { rows: { kind: string; text?: string }[] }): string[] =>
  state.rows.filter(r => r.kind === 'status' && r.text?.includes('No model configured')).map(r => r.text ?? '')

const settle = async (): Promise<void> => { await new Promise(res => setTimeout(res, 0)) }

describe('createDriver boot seed (fire-early / await-late)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-bootseed-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('createDriver resolves before the seed settles (first frame not blocked)', async () => {
    const { ctx, gate } = makeSeedCtx()
    let settled = false
    gate.promise.then(() => { settled = true })
    const driver = await createDriver(ctx as never, {})
    expect(settled).toBe(false)
    gate.resolve(undefined)
    await settle()
  })

  it('submit during the seed window dispatches only after settle, with the seeded selection', async () => {
    const { ctx, gate, sent } = makeSeedCtx()
    const driver = await createDriver(ctx as never, {})
    const pending = driver.submit('hello')
    await settle()
    // Not dispatched while the seed is in flight.
    expect(sent).toEqual([])
    gate.resolve({ provider: 'orchestrix', model: 'deepseek-v4-flash' })
    await settle()
    await pending
    expect(sent.map(m => m.text)).toEqual(['hello'])
    expect(driver.state.busy).toBe(true)
  })

  it('a queued (busy) submit is not enqueued until the seed settles', async () => {
    const { ctx, gate, sent } = makeSeedCtx()
    const driver = await createDriver(ctx as never, {})
    const first = driver.submit('first')
    gate.resolve({ provider: 'orchestrix', model: 'deepseek-v4-flash' })
    await first
    // Agent busy → second submit parks in the outbox; it must not enqueue
    // before ITS seed wait resolves (already settled here — regression guard
    // for the wait seam sitting before enqueue).
    await driver.submit('second')
    expect(driver.state.queued).toEqual(['second'])
  })

  it('no-model notice appears exactly once, only after the seed settles', async () => {
    const { ctx, gate } = makeSeedCtx()
    const driver = await createDriver(ctx as never, {})
    await settle()
    expect(noModelNotices(driver.state)).toEqual([])
    gate.resolve(undefined) // seed settles with no deployment default
    await settle()
    expect(noModelNotices(driver.state)).toHaveLength(1)
  })

  it('seed failure does not hang submit and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { ctx, gate, sent } = makeSeedCtx()
      const driver = await createDriver(ctx as never, {})
      const pending = driver.submit('hello')
      gate.reject(new Error('deployment default lookup failed'))
      await pending
      expect(sent.map(m => m.text)).toEqual(['hello'])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('banner row updates from the fallback label to the seeded model on settle', async () => {
    const { ctx, gate } = makeSeedCtx()
    const driver = await createDriver(ctx as never, {})
    await settle()
    expect(bannerRows(driver.state)[0]).toContain('default model')
    gate.resolve({ provider: 'orchestrix', model: 'deepseek-v4-flash' })
    await settle()
    const banners = bannerRows(driver.state)
    expect(banners).toHaveLength(1)
    expect(banners[0]).toContain('deepseek-v4-flash')
  })

  it('/effort with an argument waits for the settled seed before reading the selection', async () => {
    const { ctx, gate } = makeSeedCtx()
    const driver = await createDriver(ctx as never, {})
    const pending = driver.submit('/effort high')
    await settle()
    // Before settle: no "No model configured. Use /model first." row and no
    // resolution — the effort path is parked on the seed.
    expect(driver.state.rows.some(r => r.kind === 'status' && (r as { text?: string }).text?.includes('Use /model first'))).toBe(false)
    gate.resolve({ provider: 'orchestrix', model: 'deepseek-v4-flash' })
    await settle()
    await pending
    expect(driver.state.rows.some(r => r.kind === 'status' && (r as { text?: string }).text?.includes('Use /model first'))).toBe(false)
  })
})
