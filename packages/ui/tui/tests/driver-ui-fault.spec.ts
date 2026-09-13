import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * W1-A: emit-level fault isolation. One throwing listener must never veto the
 * others or the emitter's caller; faults are recorded (capped), logged to
 * console.error, and surfaced as a notice on the FIRST fault only. Reentry
 * (a listener emitting via showNotice) must not recurse-throw.
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
    session: { id: 's-fault', header: {}, events: [], snapshotEvents() { return this.events } },
    id: 'a-fault',
    status,
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  }
}

function makeCtx(agent: FakeAgent): { ctx: Record<string, unknown> } {
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
    on(_event: string, _handler: (...args: unknown[]) => void) {
      return () => {}
    },
    agents: {
      create: async () => ({ agent, dispose: async () => {} }),
      resume: async () => ({ agent, dispose: async () => {} }),
    },
  }
  return { ctx }
}

describe('driver emit fault isolation (W1-A)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-fault-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  async function mounted() {
    const agent = makeFakeAgent('idle')
    const { ctx } = makeCtx(agent)
    return createDriver(ctx as never, {})
  }

  it('a throwing listener does not veto other listeners; fault recorded, logged, noticed once', async () => {
    const driver = await mounted()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    let armed = false
    driver.subscribe(() => { if (armed) throw new Error('boom') })
    driver.subscribe(state => { if (armed) seen.push(state.draft) })
    armed = true

    driver.setDraft('hello')

    // The recorder ran (the thrower did not veto it); extra pushes come from
    // the notice's own reentrant emit — that is expected and harmless.
    expect(seen.at(-1)).toBe('hello')
    expect(driver.state.draft).toBe('hello')
    // Two faults: the draft emit and the notice's own reentrant emit (each
    // hitting the armed thrower). Both logged; the notice shows on the first.
    expect(driver.uiFaults).toHaveLength(2)
    expect(driver.uiFaults[0]?.message).toBe('boom')
    expect(errSpy).toHaveBeenCalledTimes(2)
    expect(driver.state.notice).toContain('UI fault')

    // A second fault is recorded and logged, but the notice is not re-flooded.
    driver.setDraft('again')
    expect(driver.uiFaults).toHaveLength(3)
    expect(errSpy).toHaveBeenCalledTimes(3)
    errSpy.mockRestore()
  })

  it('the fault log caps at the last 5 entries', async () => {
    const driver = await mounted()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let armed = false
    let armedCount = 0
    driver.subscribe(() => { if (armed) throw new Error(`fault-${armedCount++}`) })
    armed = true
    for (let i = 0; i < 6; i++) driver.setDraft(`m${i}`)
    expect(driver.uiFaults).toHaveLength(5)
    errSpy.mockRestore()
  })

  it('emitting from inside a listener (showNotice reentry) does not recurse-throw', async () => {
    const driver = await mounted()
    const seen: string[] = []
    let armed = false
    let noticed = false
    driver.subscribe(() => {
      if (!armed || noticed) return
      noticed = true
      driver.showNotice('reentry')
      throw new Error('boom')
    })
    driver.subscribe(state => { if (armed) seen.push(state.draft) })
    armed = true

    expect(() => driver.setDraft('hello')).not.toThrow()
    expect(seen.at(-1)).toBe('hello')
  })
})
