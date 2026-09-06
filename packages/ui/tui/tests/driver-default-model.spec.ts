import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Driver contract tests for seeding the deployment default model from the
 * `agentDefaultModel` service (settings.yaml's agent-default-model), matching
 * the headless bundle. The service is read at boot and on switchSession;
 * explicit DriverConfig provider+model always win; a missing selection emits a
 * boot notice row.
 */

interface ServiceSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

interface AgentDefaultModelLike {
  currentSelection(): ServiceSelection | undefined
}

interface Capture {
  create?: unknown
  resume?: unknown
}

/**
 * A ctx stub exposing an `agentDefaultModel` service. `service` is returned
 * for every `ctx.get('agentDefaultModel')` call — the driver captures it once
 * at boot and reuses the same object in switchSession, so a test that mutates
 * the service's return value (e.g. to simulate a changed settings.yaml between
 * boots) is reflected on the next `seedDefaultModel()` call. When
 * `sessionEvents` are supplied, the resumed agent carries them (for
 * switchSession replays).
 */
function makeCtx(opts: {
  service?: AgentDefaultModelLike
  resumeEvents?: unknown[]
  resumeStatus?: string
}): { ctx: Record<string, unknown>; capture: Capture } {
  const capture: Capture = {}
  const service = opts.service
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
        return service
      }
      return undefined
    },
    on: () => () => {},
    agents: {
      create: async (o: unknown) => {
        capture.create = o
        const agentOpts = (o as { agentOptions?: Record<string, unknown> })?.agentOptions ?? {}
        return {
          agent: {
            options: agentOpts,
            session: { id: 's-boot', header: {}, events: [] },
            id: 'a-boot',
            status: 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
      resume: async (o: unknown) => {
        capture.resume = o
        const agentOpts = (o as { agentOptions?: Record<string, unknown> })?.agentOptions ?? {}
        return {
          agent: {
            options: agentOpts,
            session: { id: 's-resume', header: {}, events: opts.resumeEvents ?? [] },
            id: 'a-resume',
            status: opts.resumeStatus ?? 'idle',
            followup() {},
            cancel() {},
          },
          dispose: async () => {},
        }
      },
    },
  }
  return { ctx, capture }
}

describe('createDriver deployment default-model seeding', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-driver-dm-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('seeds selection.current from the agentDefaultModel service at boot', async () => {
    const { ctx } = makeCtx({
      service: { currentSelection: () => ({ provider: 'orchestrix', model: 'deepseek-v4-flash' }) },
    })
    const driver = await createDriver(ctx as never, {})
    // statusLine surfaces selection.current.model; the seeded model lands there.
    expect(driver.statusLine).toContain('deepseek-v4-flash')
    // The boot banner labels the resolved model too.
    const banner = driver.state.rows.find(r => r.kind === 'status') as { text: string } | undefined
    expect(banner).toBeDefined()
    expect(banner!.text).toContain('deepseek-v4-flash')
  })

  it('explicit DriverConfig provider+model wins over the service', async () => {
    const { ctx, capture } = makeCtx({
      service: { currentSelection: () => ({ provider: 'orchestrix', model: 'deepseek-v4-flash' }) },
    })
    const driver = await createDriver(ctx as never, {
      provider: 'explicit',
      model: 'gpt-5',
    })
    expect(driver.statusLine).toContain('gpt-5')
    expect(driver.statusLine).not.toContain('deepseek-v4-flash')
    // agentOptions were forwarded to the harness.
    expect(capture.create).toMatchObject({ agentOptions: { provider: 'explicit', model: 'gpt-5' } })
  })

  it('emits a boot notice row when no model can be resolved (service absent)', async () => {
    const { ctx } = makeCtx({})
    const driver = await createDriver(ctx as never, {})
    const notice = driver.state.rows.find(
      r => r.kind === 'status' && (r as { text: string }).text.includes('No model configured'),
    )
    expect(notice).toBeDefined()
    expect((notice as { text: string }).text).toMatch(/\/model/)
    // statusLine omits the model segment when no model is resolved (unchanged
    // from today — the banner carries the "default model" label, not the
    // statusLine).
    expect(driver.statusLine).not.toContain('deepseek-v4-flash')
  })

  it('does not emit the no-model notice when the service provides a selection', async () => {
    const { ctx } = makeCtx({
      service: { currentSelection: () => ({ provider: 'orchestrix', model: 'deepseek-v4-flash' }) },
    })
    const driver = await createDriver(ctx as never, {})
    const notice = driver.state.rows.find(
      r => r.kind === 'status' && (r as { text: string }).text.includes('No model configured'),
    )
    expect(notice).toBeUndefined()
  })

  it('switchSession re-seeds from the new session service', async () => {
    const resumeEvents = [
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
    ]
    // One mutable service: returns undefined at boot (no default configured),
    // then gpt-5 after settings.yaml is (simulated to be) updated before the
    // switch — the driver re-reads currentSelection() on each seed call.
    let resumeSelection: ServiceSelection | undefined = undefined
    const service: AgentDefaultModelLike = { currentSelection: () => resumeSelection }
    const { ctx } = makeCtx({
      service,
      resumeEvents,
      resumeStatus: 'idle',
    })
    const driver = await createDriver(ctx as never, {})
    // At boot: no service selection, notice present, statusLine omits the
    // model segment (the banner carries "default model", not the statusLine).
    expect(driver.statusLine).not.toContain('gpt-5')
    const bootNotice = driver.state.rows.find(
      r => r.kind === 'status' && (r as { text: string }).text.includes('No model configured'),
    )
    expect(bootNotice).toBeDefined()

    // Simulate settings.yaml now advertising a default model.
    resumeSelection = { provider: 'openai', model: 'gpt-5' }

    await driver.switchSession('s-resume')
    // After switch: seeded model appears in statusLine.
    expect(driver.statusLine).toContain('gpt-5')
    expect(driver.statusLine).not.toContain('default model')
    // The boot notice row from the old session was cleared (clearRows runs on
    // switch), and the new session's boot banner carries the seeded model.
    const banner = driver.state.rows.find(r => r.kind === 'status' && (r as { text: string }).text.includes('dsh cc-mode'))
    expect((banner as { text: string } | undefined)?.text).toContain('gpt-5')
    // No no-model notice in the new session.
    const staleNotice = driver.state.rows.find(
      r => r.kind === 'status' && (r as { text: string }).text.includes('No model configured'),
    )
    expect(staleNotice).toBeUndefined()
  })
})
