import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Minimal ctx stub for notice tests: no services mounted at all, so every
 * driver path that reports a missing capability lands in `showNotice`. The
 * branch probe is injected via DriverConfig so no real git subprocess runs.
 */
function makeBareCtx() {
  const makeAgent = () => ({
    options: {},
    session: { id: 's-a', header: {}, events: [], snapshotEvents() { return this.events } },
    id: 'agent-s-a',
    status: 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  })
  const handle = { agent: makeAgent(), dispose: async () => {} }
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
    agents: { create: async () => handle, resume: async () => handle },
  }
  return ctx
}

async function makeDriver() {
  const ctx = makeBareCtx()
  return createDriver(ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
}

describe('createDriver showNotice (transient notice with TTL)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-notice-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('showNotice parks the text in state.notice immediately', async () => {
    vi.useFakeTimers()
    const driver = await makeDriver()
    driver.showNotice('hello hint')
    expect(driver.state.notice).toBe('hello hint')
    await driver.dispose()
  })

  it('auto-clears the notice after the default TTL', async () => {
    vi.useFakeTimers()
    const driver = await makeDriver()
    driver.showNotice('hello hint')

    vi.advanceTimersByTime(2999)
    expect(driver.state.notice).toBe('hello hint')

    vi.advanceTimersByTime(1)
    expect(driver.state.notice).toBeUndefined()
    await driver.dispose()
  })

  it('honors a custom ttlMs', async () => {
    vi.useFakeTimers()
    const driver = await makeDriver()
    driver.showNotice('custom ttl', 500)

    vi.advanceTimersByTime(500)
    expect(driver.state.notice).toBeUndefined()
    await driver.dispose()
  })

  it('a newer notice replaces the pending clear timer of the previous one', async () => {
    vi.useFakeTimers()
    const driver = await makeDriver()
    driver.showNotice('first', 1000)
    vi.advanceTimersByTime(800)
    driver.showNotice('second', 1000)

    // The first timer must not clear the replacement notice.
    vi.advanceTimersByTime(200)
    expect(driver.state.notice).toBe('second')

    // One tick before the replacement's own deadline.
    vi.advanceTimersByTime(799)
    expect(driver.state.notice).toBe('second')

    vi.advanceTimersByTime(1)
    expect(driver.state.notice).toBeUndefined()
    await driver.dispose()
  })

  it('dispose cancels the pending auto-clear (no emissions after disposal)', async () => {
    vi.useFakeTimers()
    const driver = await makeDriver()
    driver.showNotice('survives dispose')

    let emissions = 0
    driver.subscribe(() => { emissions += 1 })
    const afterSubscribe = emissions

    await driver.dispose()
    vi.advanceTimersByTime(10_000)

    // The subscribe() call itself emits once; the lapsed timer must not.
    expect(emissions).toBe(afterSubscribe)
  })

  it('the unknown-model slash path migrates to showNotice (auto-expires)', async () => {
    vi.useFakeTimers()
    const driver = await makeDriver()
    await driver.submit('/model nope')
    expect(driver.state.notice).toBe('Unknown model "nope". Try /model for the catalog.')

    vi.advanceTimersByTime(3000)
    expect(driver.state.notice).toBeUndefined()
    await driver.dispose()
  })

  it('markExitAttempt records the double-press anchor in state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_234_567)
    const driver = await makeDriver()
    driver.markExitAttempt()
    expect(driver.state.lastExitAttemptAt).toBe(1_234_567)

    driver.markExitAttempt(9_876)
    expect(driver.state.lastExitAttemptAt).toBe(9_876)
    await driver.dispose()
  })
})
