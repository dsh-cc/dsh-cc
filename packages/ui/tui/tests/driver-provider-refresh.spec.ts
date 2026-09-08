import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'

/**
 * Detail "Refresh models" action (design doc §8-S2 "refresh list", §2/C5):
 * the draft-form discovery probe re-derives the curated model list for an
 * already-configured route. Fake settings/llm/credentials seams drive the
 * real driver runtime.
 */

type SettingsOp = { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }

function fakeSettings(opts: { providers?: Record<string, unknown>; revision?: number; rejectMutate?: string } = {}) {
  const providers = opts.providers ?? {}
  const revision = opts.revision ?? 7
  return {
    describe: () => [{ ns: 'llm-pi-ai', user: { providers }, revision }],
    mutate: vi.fn(async (ns: string, ops: readonly SettingsOp[], rev?: unknown) => {
      if (opts.rejectMutate !== undefined) throw new Error(opts.rejectMutate)
      return { ns, ops, rev }
    }),
  }
}

function fakeCredentials() {
  return {
    describe: vi.fn(async (_ref: string) => ({ configured: true, source: 'managed', writable: true })),
    set: vi.fn(async (_ref: string, _value: string) => {}),
    unset: vi.fn(async (_ref: string) => {}),
  }
}

function fakeLlm(opts: { models?: { id: string; name?: string }[]; discoverError?: string } = {}) {
  return {
    listProviders: () => [],
    listModels: vi.fn(async (provider: string) => [{ id: `${provider}-chat`, name: 'Chat' }]),
    listConfigurableProviders: () => [],
    discoverModels: vi.fn(async (_ns: string, _req: unknown) => {
      if (opts.discoverError !== undefined) throw new Error(opts.discoverError)
      return opts.models ?? [{ id: 'model-a', name: 'Alpha' }, { id: 'model-b' }]
    }),
  }
}

function makeCtx(opts: { settings?: unknown; llm?: unknown; credentials?: unknown }) {
  const handlers = new Map<string, Set<() => void>>()
  const ctx: Record<string, unknown> = {
    get(key: string) {
      if (key === 'agentPresets') {
        return { defaultId: 'cc', resolve: async () => ({ id: 'cc' }), mount: async () => ({ id: 'cc' }) }
      }
      if (key === 'settings') return opts.settings
      if (key === 'llm') return opts.llm
      if (key === 'credentials') return opts.credentials
      return undefined
    },
    on(event: string, handler: () => void) {
      const set = handlers.get(event) ?? new Set<() => void>()
      set.add(handler)
      handlers.set(event, set)
      return () => { set.delete(handler) }
    },
    agents: {
      create: async () => ({
        agent: {
          options: {},
          session: { id: 's-a', header: {}, events: [], snapshotEvents() { return this.events } },
          id: 'agent-s-a',
          status: 'idle',
          followup: vi.fn(),
          steer: vi.fn(),
          cancel: vi.fn(),
        },
        dispose: async () => {},
      }),
      resume: async () => { throw new Error('not used') },
    },
  }
  return { ctx }
}

let prevHome: string | undefined
let tempHome: string

beforeEach(() => {
  prevHome = process.env.DSH_HOME
  tempHome = mkdtempSync(join(tmpdir(), 'dsh-provider-refresh-'))
  process.env.DSH_HOME = tempHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
})

async function makeDriver(opts: Parameters<typeof makeCtx>[0] = {}) {
  const built = makeCtx({
    settings: fakeSettings(),
    llm: fakeLlm(),
    credentials: fakeCredentials(),
    ...opts,
  })
  const driver = await createDriver(built.ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
  return { driver, runtime: driver.providerRuntime }
}

describe('detail refresh-models action (§8-S2 refresh list)', () => {
  it('enabled for a custom route with profile baseURL/api; r runs the draft-form probe and writes the models op', async () => {
    const settings = fakeSettings({
      providers: { 'my-gateway': { api: 'openai-completions', baseURL: 'https://gw.example.com/v1', models: [] } },
    })
    const llm = fakeLlm({ models: [{ id: 'model-a', name: 'Alpha' }, { id: 'model-b' }] })
    const { driver, runtime } = await makeDriver({ settings, llm })
    await runtime.openProviderPanel()
    const list = driver.state.providerPanel!
    const index = list.rows.findIndex(r => r.route === 'my-gateway')
    expect(index).toBeGreaterThanOrEqual(0)
    for (let i = 0; i < index; i += 1) runtime.panelMove(1)
    runtime.panelSubmit()
    await vi.waitFor(() => {
      const action = driver.state.providerPanel?.actions?.find(a => a.id === 'refresh-models')
      expect(action).toBeDefined()
      expect(action?.disabled).not.toBe(true)
    })

    runtime.panelRefreshModels()
    await vi.waitFor(() => {
      expect(llm.discoverModels).toHaveBeenCalledTimes(1)
    })
    const [ns, req] = llm.discoverModels.mock.calls[0]! as [string, Record<string, unknown>]
    expect(ns).toBe('llm-pi-ai')
    expect(req.baseURL).toBe('https://gw.example.com/v1')
    expect(req.api).toBe('openai-completions')
    expect(req.signal).toBeInstanceOf(AbortSignal)
    // Draft form: NEVER the provider form; no key needed for stored refs.
    expect(req).not.toHaveProperty('provider')
    expect(req).not.toHaveProperty('apiKey')
    await vi.waitFor(() => {
      expect(settings.mutate).toHaveBeenCalledWith(
        'llm-pi-ai',
        [{ op: 'set', path: ['providers', 'my-gateway', 'models'], value: [{ id: 'model-a', name: 'Alpha' }, { id: 'model-b', name: 'model-b' }] }],
        7,
      )
      expect(driver.state.providerPanel?.message ?? '').toContain('2 models')
    })
  })

  it('falls back to the preset probe baseURL/api when the profile omits them', async () => {
    const settings = fakeSettings({ providers: { deepseek: {} } })
    const llm = fakeLlm()
    const { driver, runtime } = await makeDriver({ settings, llm })
    await runtime.openProviderPanel()
    const list = driver.state.providerPanel!
    const index = list.rows.findIndex(r => r.route === 'deepseek')
    for (let i = 0; i < index; i += 1) runtime.panelMove(1)
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.actions?.some(a => a.id === 'refresh-models')).toBe(true)
      const action = driver.state.providerPanel?.actions?.find(a => a.id === 'refresh-models')
      expect(action?.disabled).not.toBe(true)
    })
    runtime.panelRefreshModels()
    await vi.waitFor(() => {
      expect(llm.discoverModels).toHaveBeenCalledWith(
        'llm-pi-ai',
        expect.objectContaining({ baseURL: 'https://api.deepseek.com', api: 'openai-completions' }),
      )
    })
  })

  it('disabled with an explanation for a preset route with no listable probe (kimi-coding)', async () => {
    const llm = fakeLlm()
    const { driver, runtime } = await makeDriver({
      settings: fakeSettings({ providers: { 'kimi-coding': {} } }),
      llm,
    })
    await runtime.openProviderPanel()
    const list = driver.state.providerPanel!
    const index = list.rows.findIndex(r => r.route === 'kimi-coding')
    for (let i = 0; i < index; i += 1) runtime.panelMove(1)
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.actions?.some(a => a.id === 'refresh-models')).toBe(true)
    })
    const action = driver.state.providerPanel!.actions!.find(a => a.id === 'refresh-models')!
    expect(action.disabled).toBe(true)
    expect(action.reason ?? '').toMatch(/probeable endpoint/)
    runtime.panelRefreshModels()
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.message ?? '').toContain('probeable endpoint')
    })
    expect(llm.discoverModels).not.toHaveBeenCalled()
    expect(driver.state.providerPanel?.phase).toBe('detail')
  })

  it('disabled for a non-listable protocol (anthropic-messages custom profile)', async () => {
    const llm = fakeLlm()
    const { driver, runtime } = await makeDriver({
      settings: fakeSettings({ providers: { relay: { api: 'anthropic-messages', baseURL: 'https://relay.example.com' } } }),
      llm,
    })
    await runtime.openProviderPanel()
    const list = driver.state.providerPanel!
    const index = list.rows.findIndex(r => r.route === 'relay')
    for (let i = 0; i < index; i += 1) runtime.panelMove(1)
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.actions?.some(a => a.id === 'refresh-models')).toBe(true)
    })
    const action = driver.state.providerPanel!.actions!.find(a => a.id === 'refresh-models')!
    expect(action.disabled).toBe(true)
    runtime.panelRefreshModels()
    expect(llm.discoverModels).not.toHaveBeenCalled()
  })

  it('failure renders the reason verbatim and changes no state', async () => {
    const reason = '401 Unauthorized from endpoint'
    const settings = fakeSettings({
      providers: { deepseek: {} },
    })
    const llm = fakeLlm({ discoverError: reason })
    const { driver, runtime } = await makeDriver({ settings, llm })
    await runtime.openProviderPanel()
    const list = driver.state.providerPanel!
    const index = list.rows.findIndex(r => r.route === 'deepseek')
    for (let i = 0; i < index; i += 1) runtime.panelMove(1)
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.actions?.some(a => a.id === 'refresh-models')).toBe(true)
      const action = driver.state.providerPanel?.actions?.find(a => a.id === 'refresh-models')
      expect(action?.disabled).not.toBe(true)
    })
    runtime.panelRefreshModels()
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.message ?? '').toContain(reason)
    })
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('timeout aborts the probe after 15s', async () => {
    const settings = fakeSettings({ providers: { deepseek: {} } })
    const llm = fakeLlm()
    llm.discoverModels = vi.fn((_ns: string, req: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        req.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')))
      }),
    )
    const { driver, runtime } = await makeDriver({ settings, llm })
    await runtime.openProviderPanel()
    const list = driver.state.providerPanel!
    const index = list.rows.findIndex(r => r.route === 'deepseek')
    for (let i = 0; i < index; i += 1) runtime.panelMove(1)
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.actions?.some(a => a.id === 'refresh-models')).toBe(true)
      const action = driver.state.providerPanel?.actions?.find(a => a.id === 'refresh-models')
      expect(action?.disabled).not.toBe(true)
    })
    // Fake timers must be live BEFORE the probe schedules its 15s abort timer.
    await vi.useFakeTimers()
    runtime.panelRefreshModels()
    await vi.waitFor(() => {
      expect(llm.discoverModels).toHaveBeenCalled()
    })
    await vi.advanceTimersByTimeAsync(15_500)
    await vi.useRealTimers()
    await vi.waitFor(() => {
      const message = driver.state.providerPanel?.message ?? ''
      expect(message).toContain('aborted')
      expect(message).toContain('refresh failed')
    })
    expect(settings.mutate).not.toHaveBeenCalled()
  })
})
