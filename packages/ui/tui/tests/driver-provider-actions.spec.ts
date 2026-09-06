import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Container, Input } from '@dsh-cc/pi-tui'
import { MaskedInput } from '@dsh-cc/tui/components/masked-input.ts'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { createProviderPanelBox } from '@dsh-cc/tui/components/provider-box.ts'
import { buildArgCompleters } from '@dsh-cc/tui/components/arg-completers.ts'
import { parseSlash, LOCAL_SLASH, LOCAL_COMMANDS, PROVIDER_SUBCOMMANDS } from '@dsh-cc/tui/slash.ts'
import { routeProviderPanelInput } from '@dsh-cc/tui/input.ts'

/**
 * `/provider` action flows (design doc §4.3, §4.4, §4.6, §6, §7): fake
 * settings / llm / credentials seams drive the add-preset wizard, the
 * custom-provider wizard, and the manage/remove flow through the real driver
 * runtime. Secrets are typed through the first-party `MaskedInput` (bullets only).
 */

function boxText(box: Container): string {
  return box.render(120).map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()).join('\n')
}

interface FakeSession {
  id: string
  events?: unknown[]
  status?: string
  provider?: string
  model?: string
}

type SettingsOp = { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }

function fakeSettings(opts: {
  providers?: Record<string, unknown>
  revision?: number
  rejectMutate?: string
  rejectReplace?: string
} = {}) {
  const providers = opts.providers ?? {}
  const revision = opts.revision ?? 7
  return {
    describe: () => [
      { ns: 'llm-pi-ai', user: { providers }, revision },
      { ns: 'agent-default-model', user: {}, revision },
    ],
    mutate: vi.fn(async (ns: string, ops: readonly SettingsOp[], rev?: unknown) => {
      if (opts.rejectMutate !== undefined) throw new Error(opts.rejectMutate)
      return { ns, ops, rev }
    }),
    replace: vi.fn(async (ns: string, value: unknown, rev?: unknown) => {
      if (opts.rejectReplace !== undefined) throw new Error(opts.rejectReplace)
      return { ns, value, rev }
    }),
  }
}

function fakeCredentials(opts: {
  describe?: (ref: string) => { configured: boolean; source?: string; writable?: boolean } | undefined
  rejectSet?: string
} = {}) {
  const describe = opts.describe ?? ((ref: string) => ({ configured: true, source: 'managed', writable: true }))
  return {
    describe: vi.fn(describe),
    set: vi.fn(async (ref: string, value: string) => {
      if (opts.rejectSet !== undefined) throw new Error(opts.rejectSet)
    }),
    unset: vi.fn(async (_ref: string) => {}),
  }
}

function fakeLlm(opts: {
  models?: { id: string; name?: string }[]
  discoverError?: string
} = {}) {
  return {
    listProviders: () => [],
    listModels: vi.fn(async (provider: string) =>
      [{ id: `${provider}-chat`, name: 'Chat' }, { id: `${provider}-reasoner`, name: 'Reasoner' }],
    ),
    listConfigurableProviders: () => [{ provider: 'github-copilot', displayName: 'GitHub Copilot' }],
    discoverModels: vi.fn(async (_ns: string, _req: unknown) => {
      if (opts.discoverError !== undefined) throw new Error(opts.discoverError)
      return opts.models ?? [{ id: 'model-a' }, { id: 'model-b' }]
    }),
  }
}

function makeCtx(opts: {
  session?: FakeSession
  settings?: unknown
  llm?: unknown
  credentials?: unknown
}) {
  const session = opts.session ?? { id: 's-a', events: [], status: 'idle' }
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
          options: {
            ...(session.provider !== undefined && session.model !== undefined ? { provider: session.provider, model: session.model } : {}),
          },
          session: { id: session.id, header: {}, events: session.events ?? [] },
          id: `agent-${session.id}`,
          status: session.status ?? 'idle',
          followup: vi.fn(),
          steer: vi.fn(),
          cancel: vi.fn(),
        },
        dispose: async () => {},
      }),
      resume: async () => { throw new Error('not used') },
    },
  }
  const fire = (event: string): void => {
    const set = handlers.get(event)
    if (set !== undefined) for (const handler of [...set]) handler()
  }
  return { ctx, fire }
}

let prevHome: string | undefined
let tempHome: string

beforeEach(() => {
  prevHome = process.env.DSH_HOME
  tempHome = mkdtempSync(join(tmpdir(), 'dsh-provider-actions-'))
  process.env.DSH_HOME = tempHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
})

async function makeDriver(opts: Parameters<typeof makeCtx>[0] = {}) {
  const built = makeCtx({
    settings: fakeSettings({ providers: { 'kimi-coding': { models: [{ id: 'k1' }] } } }),
    llm: fakeLlm(),
    credentials: fakeCredentials(),
    ...opts,
  })
  const driver = await createDriver(built.ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
  return { driver, fire: built.fire, runtime: driver.providerRuntime }
}

describe('mount: /provider registration + dispatch', () => {
  it('registers provider as a local slash command with list/add/remove subcommand hints', async () => {
    expect(LOCAL_SLASH).toContain('provider')
    const entry = LOCAL_COMMANDS.find(c => c.name === 'provider')
    expect(entry?.argumentHint).toBe('[list | add <preset-id> | remove <route>]')
    expect(PROVIDER_SUBCOMMANDS).toEqual(['list', 'add', 'remove'])
    expect(parseSlash('/provider add deepseek')).toEqual({ kind: 'local', name: 'provider', rawInput: 'add deepseek' })
    const completers = buildArgCompleters({
      loadModelCatalog: async () => [],
      loadModelEfforts: async () => [],
      listSessions: async () => [],
    } as never)
    const items = await completers.provider!('', new AbortController().signal)
    expect(items.map(i => i.value)).toEqual(['list', 'add', 'remove'])
  })

  it('/provider via submit opens the panel overlay', async () => {
    const { driver } = await makeDriver()
    await driver.submit('/provider')
    expect(driver.state.providerPanel?.phase).toBe('list')
  })

  it('/provider add deepseek jumps to the wizard credential step (MaskedInput naming the ref)', async () => {
    const { driver, runtime } = await makeDriver()
    await driver.submit('/provider add deepseek')
    const panel = driver.state.providerPanel
    expect(panel?.phase).toBe('wizard')
    expect(panel?.wizard?.route).toBe('deepseek')
    expect(panel?.wizard?.steps[panel!.wizard!.stepIndex]).toBe('credential')
    const field = runtime.wizardInput()
    expect(field).toBeInstanceOf(MaskedInput)
    const text = boxText(createProviderPanelBox(panel!, undefined, field))
    expect(text).toContain('DEEPSEEK_API_KEY')
    expect(text).toContain('~/.dsh/.credentials.yaml')
  })

  it('/provider remove kimi-coding jumps to the in-overlay confirm phase', async () => {
    const { driver } = await makeDriver()
    await driver.submit('/provider remove kimi-coding')
    const panel = driver.state.providerPanel
    expect(panel?.phase).toBe('confirm-remove')
    expect(panel?.selected).toBe('kimi-coding')
    expect(boxText(createProviderPanelBox(panel!))).toContain('Remove')
  })

  it('/provider frobnicate answers with the usage row, never a silent no-op', async () => {
    const { driver } = await makeDriver()
    const before = driver.state.rows.length
    await driver.submit('/provider frobnicate')
    expect(driver.state.providerPanel).toBeUndefined()
    const last = driver.state.rows[driver.state.rows.length - 1]!
    expect(last.kind).toBe('status')
    expect(last.kind === 'status' ? last.text : '').toContain('Usage:')
    expect(driver.state.rows.length).toBe(before + 1)
  })
})

describe('add-preset wizard (§4.3)', () => {
  it('happy path: raw key to credentials.set, exact mutate payload, draft-form probe, N-models message', async () => {
    const settings = fakeSettings({ providers: {} })
    const credentials = fakeCredentials()
    const llm = fakeLlm()
    const { driver, runtime } = await makeDriver({ settings, credentials, llm })
    await runtime.openProviderPanel('add deepseek')

    runtime.panelType('sk-test-123')
    runtime.panelSubmit()

    await vi.waitFor(() => {
      expect(settings.mutate).toHaveBeenCalledWith(
        'llm-pi-ai',
        [{ op: 'set', path: ['providers', 'deepseek'], value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }],
        7,
      )
    })
    // Raw key goes to the credential store, never into settings.
    expect(credentials.set).toHaveBeenCalledWith('DEEPSEEK_API_KEY', 'sk-test-123')
    // Draft-form probe: baseURL + api + just-typed key, NEVER the provider form.
    expect(llm.discoverModels).toHaveBeenCalledTimes(1)
    const [ns, req] = llm.discoverModels.mock.calls[0]! as [string, Record<string, unknown>]
    expect(ns).toBe('llm-pi-ai')
    expect(req.baseURL).toBe('https://api.deepseek.com')
    expect(req.api).toBe('openai-completions')
    expect(req.apiKey).toBe('sk-test-123')
    expect(req).not.toHaveProperty('provider')
    expect(req.signal).toBeInstanceOf(AbortSignal)
    // Success message + done step, with the field's retained state cleared.
    await vi.waitFor(() => {
      const panel = driver.state.providerPanel
      expect(panel?.wizard?.steps[panel!.wizard!.stepIndex]).toBe('done')
    })
    expect(driver.state.providerPanel?.message ?? driver.state.providerPanel?.wizard?.verify?.message).toContain('2 models reachable')
    const afterField = runtime.wizardInput()
    expect(afterField === undefined || afterField.getValue() === '').toBe(true)
  })

  it('kimi-coding (anthropic-messages) skips the probe with the explicit one-liner', async () => {
    const llm = fakeLlm()
    const { driver, runtime } = await makeDriver({ llm })
    await runtime.openProviderPanel('add kimi-coding')
    runtime.panelType('sk-kimi')
    runtime.panelSubmit()
    await vi.waitFor(() => {
      const panel = driver.state.providerPanel
      expect(panel?.wizard?.steps[panel!.wizard!.stepIndex]).toBe('done')
    })
    expect(llm.discoverModels).not.toHaveBeenCalled()
    const panel = driver.state.providerPanel!
    expect(panel.wizard?.verify?.message ?? panel.message ?? '').toContain('first message is the test')
  })

  it('env-supplied key skips the credential step and disables rotate in the detail view', async () => {
    const credentials = fakeCredentials({ describe: () => ({ configured: true, source: 'env', writable: false }) })
    const { driver, runtime } = await makeDriver({
      credentials,
      settings: fakeSettings({ providers: { 'kimi-coding': {}, deepseek: {} } }),
    })
    await runtime.openProviderPanel('add deepseek')
    const panel = driver.state.providerPanel!
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).not.toBe('credential')
    expect(panel.wizard?.note ?? panel.message ?? '').toContain('environment')
    await vi.waitFor(() => {
      expect(credentials.set).not.toHaveBeenCalled()
    })
    // Detail view: rotate action disabled with the shadowing explanation.
    await runtime.openProviderPanel()
    const rows = driver.state.providerPanel!.rows
    const deepseekIndex = rows.findIndex(r => r.route === 'deepseek')
    for (let i = 0; i < deepseekIndex; i += 1) runtime.panelMove(1)
    runtime.panelSubmit()
    const detail = driver.state.providerPanel!
    expect(detail.phase).toBe('detail')
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.actions?.find(a => a.id === 'rotate')?.disabled).toBe(true)
    })
    const rotate = driver.state.providerPanel!.actions!.find(a => a.id === 'rotate')!
    expect(rotate.reason ?? '').toMatch(/environment|read-only/)
    runtime.panelSubmit()
    expect(runtime.wizardInput()).toBeUndefined()
  })

  it('validator refusal renders the error verbatim; no state change, wizard stays on the key step', async () => {
    const refusal = 'settings-rejected: route deepseek: model list empty'
    const settings = fakeSettings({ providers: {}, rejectMutate: refusal })
    const credentials = fakeCredentials()
    const llm = fakeLlm()
    const { driver, runtime } = await makeDriver({ settings, credentials, llm })
    await runtime.openProviderPanel('add deepseek')
    runtime.panelType('sk-x')
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(settings.mutate).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      const panel = driver.state.providerPanel!
      expect(panel.message ?? panel.wizard?.note ?? '').toContain(refusal)
    })
    const panel = driver.state.providerPanel!
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('credential')
    expect(llm.discoverModels).not.toHaveBeenCalled()
  })

  it('set as default writes agent-default-model; failures are tolerated with a note', async () => {
    const settings = fakeSettings({ providers: {} })
    const { driver, runtime } = await makeDriver({ settings })
    await runtime.openProviderPanel('add deepseek')
    runtime.panelType('sk-y')
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.wizard?.steps[driver.state.providerPanel!.wizard!.stepIndex]).toBe('done')
    })
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(settings.replace).toHaveBeenCalledWith('agent-default-model', { provider: 'deepseek', model: 'deepseek-chat' }, 7)
    })

    // Every failure in this step is tolerated (D8(c) — opportunistic seed).
    const failing = fakeSettings({ providers: {}, rejectReplace: 'cascade closed' })
    const llmFail = fakeLlm()
    llmFail.listModels = vi.fn(async () => { throw new Error('llm gone') })
    const { driver: d2, runtime: rt2 } = await makeDriver({ settings: failing, llm: llmFail })
    await rt2.openProviderPanel('add deepseek')
    rt2.panelType('sk-z')
    rt2.panelSubmit()
    await vi.waitFor(() => {
      expect(d2.state.providerPanel?.wizard?.steps[d2.state.providerPanel!.wizard!.stepIndex]).toBe('done')
    })
    expect(() => rt2.panelSubmit()).not.toThrow()
    await vi.waitFor(() => {
      const note = d2.state.providerPanel?.message ?? d2.state.providerPanel?.wizard?.note ?? ''
      expect(note.length).toBeGreaterThan(0)
    })
    expect(failing.replace).not.toHaveBeenCalled()
  })

  it('empty key submit aborts without writing anything', async () => {
    const settings = fakeSettings({ providers: {} })
    const credentials = fakeCredentials()
    const { driver, runtime } = await makeDriver({ settings, credentials })
    await runtime.openProviderPanel('add deepseek')
    runtime.panelSubmit()
    const panel = driver.state.providerPanel!
    expect(panel.phase).toBe('list')
    expect(panel.message ?? '').toContain('nothing was written')
    expect(credentials.set).not.toHaveBeenCalled()
    expect(settings.mutate).not.toHaveBeenCalled()
  })
})

describe('remove flow (§4.4)', () => {
  it('unset payload, managed-only credential-drop offer, current-route warning', async () => {
    const settings = fakeSettings({ providers: { 'kimi-coding': { models: [{ id: 'k1' }] } } })
    const credentials = fakeCredentials()
    const { driver, runtime } = await makeDriver({
      settings,
      credentials,
      session: { id: 's-a', provider: 'kimi-coding', model: 'k1' },
    })
    await runtime.openProviderPanel('remove kimi-coding')
    const panel = driver.state.providerPanel!
    expect(panel.phase).toBe('confirm-remove')
    // Removing the currently-selected route always carries the warning (§4.4).
    expect(panel.message ?? '').toContain('keeps its current model')
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'kimi-coding'] }], 7)
    })
    // Managed credential: the drop offer appears.
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.phase).toBe('confirm-remove')
      expect(driver.state.providerPanel?.stage).toBe('drop-credential')
    })
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(credentials.unset).toHaveBeenCalledWith('KIMI_API_KEY')
      expect(driver.state.providerPanel?.phase).toBe('list')
    })
  })

  it('env-supplied credential is never touched; no drop offer', async () => {
    const settings = fakeSettings({ providers: { deepseek: {} } })
    const credentials = fakeCredentials({ describe: () => ({ configured: true, source: 'env', writable: false }) })
    const { driver, runtime } = await makeDriver({ settings, credentials })
    await runtime.openProviderPanel('remove deepseek')
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(settings.mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'unset', path: ['providers', 'deepseek'] }], 7)
      expect(driver.state.providerPanel?.phase).toBe('list')
    })
    expect(credentials.unset).not.toHaveBeenCalled()
    expect(driver.state.providerPanel?.stage).toBeUndefined()
  })
})

describe('custom-provider wizard (§4.6)', () => {
  async function openCustom(runtime: Awaited<ReturnType<typeof makeDriver>>['runtime']) {
    await runtime.openProviderPanel()
    runtime.startCustomWizard()
    expect(runtime.wizardInput()).toBeInstanceOf(Input)
    // route step
    runtime.panelType('My Gateway!!')
    runtime.panelSubmit()
    // displayName step
    runtime.panelType('My Gateway')
    runtime.panelSubmit()
    // baseURL step
    return runtime
  }

  it('end-to-end: normalized id, select protocol, fetch prefill, full profile persist', async () => {
    const settings = fakeSettings({ providers: {} })
    const credentials = fakeCredentials()
    const llm = fakeLlm({ models: [{ id: 'm1' }, { id: 'm2' }] })
    const { driver, runtime } = await makeDriver({ settings, credentials, llm })
    await openCustom(runtime)

    let panel = driver.state.providerPanel!
    // Route id normalized and collision-safe.
    expect(panel.wizard?.answers['route']).toBe('my-gateway')
    // baseURL step: invalid URL refused in place.
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('baseURL')
    runtime.panelType('notaurl')
    runtime.panelSubmit()
    panel = driver.state.providerPanel!
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('baseURL')
    expect(panel.wizard?.note ?? panel.message ?? '').toMatch(/absolute http/)
    runtime.panelType('https://gw.example.com/v1')
    runtime.panelSubmit()
    panel = driver.state.providerPanel!
    // protocol single-select: move to the second protocol and pick it.
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('protocol')
    runtime.panelMove(1)
    runtime.panelSubmit()
    panel = driver.state.providerPanel!
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('ref')
    expect(panel.wizard?.answers['ref']).toBe('DSH_PROVIDER_MY_GATEWAY_API_KEY')
    runtime.panelSubmit()
    // key step
    panel = driver.state.providerPanel!
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('key')
    runtime.panelType('sk-custom')
    runtime.panelSubmit()
    panel = driver.state.providerPanel!
    // models step: per-line errors first, then the fetch prefill.
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('models')
    runtime.panelType('m1|GLM One|100000|4096, bad entry with spaces')
    runtime.panelSubmit()
    panel = driver.state.providerPanel!
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('models')
    expect(panel.wizard?.modelErrors?.join('\n')).toContain('bad entry with spaces')
    runtime.panelToggleFetch()
    await vi.waitFor(() => {
      expect(llm.discoverModels).toHaveBeenCalledWith(
        'llm-pi-ai',
        expect.objectContaining({ baseURL: 'https://gw.example.com/v1', api: 'openai-responses', apiKey: 'sk-custom' }),
      )
    })
    const call = llm.discoverModels.mock.calls[0]![1] as Record<string, unknown>
    expect(call).not.toHaveProperty('provider')
    await vi.waitFor(() => {
      expect(runtime.wizardInput()?.getValue()).toBe('m1, m2')
    })
    runtime.panelSubmit()
    await vi.waitFor(() => {
      const done = driver.state.providerPanel!.wizard!
      expect(done.steps[done.stepIndex]).toBe('done')
    })
    expect(credentials.set).toHaveBeenCalledWith('DSH_PROVIDER_MY_GATEWAY_API_KEY', 'sk-custom')
    expect(settings.mutate).toHaveBeenCalledWith(
      'llm-pi-ai',
      [{
        op: 'set',
        path: ['providers', 'my-gateway'],
        value: {
          apiKeyEnv: 'DSH_PROVIDER_MY_GATEWAY_API_KEY',
          api: 'openai-responses',
          baseURL: 'https://gw.example.com/v1',
          models: [{ id: 'm1' }, { id: 'm2' }],
        },
      }],
      7,
    )
  })

  it('route collision is refused in place', async () => {
    const { driver, runtime } = await makeDriver()
    await runtime.openProviderPanel()
    runtime.startCustomWizard()
    runtime.panelType('kimi-coding')
    runtime.panelSubmit()
    const panel = driver.state.providerPanel!
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('route')
    expect(panel.wizard?.note ?? panel.message ?? '').toContain('kimi-coding')
  })
})

describe('degraded seams (§7)', () => {
  it('no llm seam: persist still works, probe skipped with a note', async () => {
    const settings = fakeSettings({ providers: {} })
    const credentials = fakeCredentials()
    const { driver, runtime } = await makeDriver({ settings, credentials, llm: undefined })
    await runtime.openProviderPanel('add deepseek')
    runtime.panelType('sk-nollm')
    runtime.panelSubmit()
    await vi.waitFor(() => {
      expect(settings.mutate).toHaveBeenCalled()
      const panel = driver.state.providerPanel!.wizard!
      expect(panel.steps[panel.stepIndex]).toBe('done')
    })
    const note = driver.state.providerPanel!.wizard?.verify?.message ?? driver.state.providerPanel!.message ?? ''
    expect(note).toMatch(/unavailable|skipped/)
  })
})

describe('secret hygiene (§6)', () => {
  it('the typed key never reaches the store, view snapshots, transcript, or the Input after the flow', async () => {
    const settings = fakeSettings({ providers: {} })
    const credentials = fakeCredentials()
    const llm = fakeLlm()
    const { driver, runtime } = await makeDriver({ settings, credentials, llm })
    await runtime.openProviderPanel('add deepseek')
    runtime.panelType('sk-super-secret-value')
    runtime.panelSubmit()
    await vi.waitFor(() => {
      const panel = driver.state.providerPanel!.wizard!
      expect(panel.steps[panel.stepIndex]).toBe('done')
    })
    runtime.panelEscape()
    expect(driver.state.providerPanel?.phase).toBe('list')
    runtime.panelEscape()
    expect(driver.state.providerPanel).toBeUndefined()
    const snapshot = JSON.stringify(driver.state)
    expect(snapshot).not.toContain('sk-super-secret-value')
    const field = runtime.wizardInput()
    if (field !== undefined) expect(JSON.stringify(field)).not.toContain('sk-super-secret-value')
    for (const row of driver.state.rows) {
      expect(JSON.stringify(row)).not.toContain('sk-super-secret-value')
    }
  })

  it('esc backs one wizard step; at the first step it closes with an unsaved-data note', async () => {
    const { driver, runtime } = await makeDriver()
    await runtime.openProviderPanel()
    runtime.startCustomWizard()
    runtime.panelType('my-route')
    runtime.panelSubmit()
    runtime.panelType('Display')
    runtime.panelEscape()
    let panel = driver.state.providerPanel!
    expect(panel.wizard?.steps[panel.wizard.stepIndex]).toBe('route')
    expect(panel.wizard?.answers['route']).toBe('my-route')
    runtime.panelEscape()
    panel = driver.state.providerPanel!
    expect(panel.phase).toBe('list')
    expect(panel.message ?? '').toContain('nothing was written')
  })
})
