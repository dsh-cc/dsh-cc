import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Container } from '@dsh-cc/pi-tui'
import { createDriver } from '@dsh-cc/tui/harness/driver.ts'
import { createProviderPanelBox } from '@dsh-cc/tui/components/provider-box.ts'
import { parseProviderArgs, renderProviderList } from '@dsh-cc/tui/provider-command.ts'
import { routeProviderPanelInput } from '@dsh-cc/tui/input.ts'
import { buildProviderRows, type CredentialsLike, type LlmManageLike } from '@dsh-cc/tui/provider-flow.ts'

/**
 * `/provider` read-path driver specs (§4.2): fake settings / llm / credentials
 * seams drive the panel through the real driver runtime. No slash mounting —
 * everything is exercised through `driver.providerRuntime`.
 */

type Listener = (event: string, handler: () => void) => () => void

function boxText(box: Container): string {
  return box.render(120).map(line => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()).join('\n')
}

interface FakeSession {
  id: string
  events?: unknown[]
  status?: string
  cwd?: string
  provider?: string
  model?: string
}

function makeCtx(opts: {
  session?: FakeSession
  settings?: unknown
  llm?: unknown
  credentials?: unknown
}) {
  const disposed: string[] = []
  const session = opts.session ?? { id: 's-a', events: [], status: 'idle' }
  const handlers = new Map<string, Set<() => void>>()

  const makeAgent = (s: FakeSession): Record<string, unknown> => ({
    options: {
      ...(s.provider !== undefined && s.model !== undefined ? { provider: s.provider, model: s.model } : {}),
    },
    session: {
      id: s.id,
      header: s.cwd === undefined ? {} : { cwd: s.cwd },
      events: s.events ?? [],
    },
    id: `agent-${s.id}`,
    status: s.status ?? 'idle',
    followup: vi.fn(),
    steer: vi.fn(),
    cancel: vi.fn(),
  })
  const makeHandle = (s: FakeSession) => ({
    agent: makeAgent(s),
    dispose: async () => { disposed.push(s.id) },
  })

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
      create: async () => makeHandle(session),
      resume: async () => { throw new Error('not used') },
    },
  }
  const fire = (event: string): number => {
    const set = handlers.get(event)
    if (set === undefined) return 0
    for (const handler of [...set]) handler()
    return set.size
  }
  const subscriptionCount = (event: string): number => handlers.get(event)?.size ?? 0
  return { ctx, fire, subscriptionCount, disposed }
}

const managedCreds: CredentialsLike = {
  describe: async (ref: string) =>
    ref === 'DEEPSEEK_API_KEY'
      ? { configured: true, source: 'env', writable: false }
      : { configured: true, source: 'managed', writable: true },
  set: async () => {},
  unset: async () => {},
}

const fakeLlm: LlmManageLike = {
  listConfigurableProviders: () => [
    { provider: 'github-copilot', displayName: 'GitHub Copilot' },
    { provider: 'kimi-coding' },
  ],
  discoverModels: async () => [],
}

const fakeSettings = () => ({
  describe: () => [
    { ns: 'other-ns', user: {}, revision: 1 },
    { ns: 'llm-pi-ai', user: { providers: { 'kimi-coding': { models: [{ id: 'a' }, { id: 'b' }] }, deepseek: {} } }, revision: 7 },
  ],
})

async function makeDriver(extra?: Parameters<typeof makeCtx>[0]) {
  const built = makeCtx({ settings: fakeSettings(), llm: fakeLlm, credentials: managedCreds, ...extra })
  const driver = await createDriver(built.ctx as never, { cwd: '/w/proj', branchProbe: async () => undefined })
  return { driver, ...built }
}

describe('createDriver providerRuntime (read path)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-provider-panel-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  it('no-arg open merges configured (dict order, badges, current marker) with presets + directory tail', async () => {
    const { driver } = await makeDriver({ session: { id: 's-a', provider: 'kimi-coding', model: 'kimi' } })
    await driver.providerRuntime.openProviderPanel()

    const panel = driver.state.providerPanel
    expect(panel?.phase).toBe('list')
    const rows = panel?.rows ?? []
    // Configured = live dict, document order preserved.
    expect(rows.filter(r => r.section === 'configured').map(r => r.route)).toEqual(['kimi-coding', 'deepseek'])
    const kimi = rows.find(r => r.route === 'kimi-coding')!
    expect(kimi.isCurrent).toBe(true)
    expect(kimi.credential?.badge).toBe('managed')
    expect(kimi.modelCount).toBe(2)
    expect(kimi.credential?.warning).toBe(false)
    const deepseek = rows.find(r => r.route === 'deepseek')!
    expect(deepseek.credential?.badge).toBe('env')
    expect(deepseek.isCurrent).toBe(false)
    // Presets not configured land in Available.
    expect(rows.filter(r => r.section === 'available').map(r => r.route)).toContain('moonshotai')
    expect(rows.filter(r => r.section === 'available').map(r => r.route)).not.toContain('kimi-coding')
    // Directory entries neither configured nor preset-covered collapse into more.
    expect(panel?.more.map(m => m.provider)).toEqual(['github-copilot'])

    // The overlay box renders both sections with the badge and current marker.
    const text = boxText(createProviderPanelBox(panel!))
    expect(text).toContain('Providers')
    expect(text).toContain('Configured')
    expect(text).toContain('● kimi-coding')
    expect(text).toContain('key ✓ (managed)')
    expect(text).toContain('key ✓ (env)')
    expect(text).toContain('Available')
    expect(text).toContain('More providers (github-copilot)')
  })

  it('⚠ marks a configured route with models but a missing credential', async () => {
    const { driver } = await makeDriver({
      credentials: { describe: async () => ({ configured: false }), set: async () => {}, unset: async () => {} },
    })
    await driver.providerRuntime.openProviderPanel()
    const rows = driver.state.providerPanel?.rows ?? []
    expect(rows.find(r => r.route === 'kimi-coding')?.credential).toEqual({ badge: 'missing', warning: true })
  })

  it('absent seams still open the panel with honest unavailable rows (no throw)', async () => {
    const { driver } = await makeDriver({ settings: undefined, llm: undefined, credentials: undefined })
    await expect(driver.providerRuntime.openProviderPanel()).resolves.toBeUndefined()
    const panel = driver.state.providerPanel
    expect(panel?.phase).toBe('list')
    expect(panel?.rows.filter(r => r.section === 'configured')).toEqual([])
    // All eight presets degrade to Available with missing credentials.
    expect(panel?.rows.filter(r => r.section === 'available').length).toBeGreaterThan(0)
    expect(panel?.more).toEqual([])
    expect(panel?.rows.every(r => r.credential === undefined || r.credential.badge === 'missing')).toBe(true)
  })

  it('/provider list renders the two sections as plain chat output and does not open the overlay', async () => {
    const { driver } = await makeDriver()
    await driver.providerRuntime.openProviderPanel('list')
    expect(driver.state.providerPanel).toBeUndefined()
    const rows = driver.state.rows
    const last = rows[rows.length - 1]!
    expect(last.kind).toBe('status')
    const text = last.kind === 'status' ? last.text : ''
    expect(text).toContain('Configured')
    expect(text).toContain('Available')
    expect(text).toContain('kimi-coding')
  })

  it('live refresh: llm/adapters-updated rebuilds rows while open; nothing after close', async () => {
    const settings = fakeSettings()
    const { driver, fire } = await makeDriver({ settings })
    await driver.providerRuntime.openProviderPanel()
    expect(driver.state.providerPanel?.rows.map(r => r.route)).not.toContain('new-route')

    // Second terminal wrote settings; the seam now reports the new route.
    settings.describe = () => [{ ns: 'llm-pi-ai', user: { providers: { 'new-route': {} } }, revision: 8 }]
    fire('llm/adapters-updated')
    await vi.waitFor(() => {
      expect(driver.state.providerPanel?.rows.filter(r => r.section === 'configured').map(r => r.route)).toEqual(['new-route'])
    })

    driver.providerRuntime.closeProviderPanel()
    expect(driver.state.providerPanel).toBeUndefined()
    const eventCount = fire('llm/adapters-updated')
    expect(eventCount).toBe(0)
  })

  it('subscribes only while open (no duplicate listeners on refresh, disposed on close)', async () => {
    const { driver, fire, subscriptionCount } = await makeDriver()
    await driver.providerRuntime.openProviderPanel()
    expect(subscriptionCount('llm/adapters-updated')).toBe(1)
    expect(subscriptionCount('credentials/reference-updated')).toBe(1)
    fire('llm/adapters-updated')
    await vi.waitFor(() => expect(driver.state.providerPanel).toBeDefined())
    expect(subscriptionCount('llm/adapters-updated')).toBe(1)
    driver.providerRuntime.closeProviderPanel()
    expect(subscriptionCount('llm/adapters-updated')).toBe(0)
    expect(subscriptionCount('credentials/reference-updated')).toBe(0)
  })
})

describe('parseProviderArgs (§4.1 invocation forms)', () => {
  it('maps the subcommand table; unknown subcommands are invalid, never silent', () => {
    expect(parseProviderArgs('')).toEqual({ kind: 'open' })
    expect(parseProviderArgs('list')).toEqual({ kind: 'list' })
    expect(parseProviderArgs('add kimi-coding')).toEqual({ kind: 'add', route: 'kimi-coding' })
    expect(parseProviderArgs('remove my-gateway')).toEqual({ kind: 'remove', route: 'my-gateway' })
    expect(parseProviderArgs('add')).toEqual({ kind: 'invalid' })
    expect(parseProviderArgs('remove')).toEqual({ kind: 'invalid' })
    expect(parseProviderArgs('frobnicate')).toEqual({ kind: 'invalid' })
  })

  it('openProviderPanel answers invalid with a usage row, never a silent no-op', async () => {
    const { driver } = await makeDriver()
    const before = driver.state.rows.length
    await driver.providerRuntime.openProviderPanel('frobnicate')
    expect(driver.state.providerPanel).toBeUndefined()
    const last = driver.state.rows[driver.state.rows.length - 1]!
    expect(last.kind).toBe('status')
    expect(last.kind === 'status' ? last.text : '').toContain('Usage:')
    expect(driver.state.rows.length).toBe(before + 1)
  })

  it('renderProviderList is plain text over the same two-section data', () => {
    const list = buildProviderRows({
      configured: { 'kimi-coding': { models: [{ id: 'a' }] } },
      directory: [{ provider: 'github-copilot', displayName: 'GitHub Copilot' }],
      credentialStates: { KIMI_API_KEY: { configured: true, source: 'env' } },
    })
    const text = renderProviderList(list)
    expect(text).toContain('Configured')
    expect(text).toContain('kimi-coding')
    expect(text).toContain('key ✓ (env)')
    expect(text).toContain('Available')
    expect(text).toContain('More providers (github-copilot)')
  })
})

describe('routeProviderPanelInput (list phase)', () => {
  let prevHome: string | undefined
  let tempHome: string

  beforeEach(() => {
    prevHome = process.env.DSH_HOME
    tempHome = mkdtempSync(join(tmpdir(), 'dsh-provider-routing-'))
    process.env.DSH_HOME = tempHome
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  })

  async function openRuntime() {
    const { driver, fire } = await makeDriver()
    await driver.providerRuntime.openProviderPanel()
    return { driver, fire }
  }

  it('j/k and arrows move the cursor clamped', async () => {
    const { driver } = await openRuntime()
    const runtime = driver.providerRuntime
    routeProviderPanelInput(runtime, 'j')
    expect(driver.state.providerPanel?.cursor).toBe(1)
    routeProviderPanelInput(runtime, 'k')
    expect(driver.state.providerPanel?.cursor).toBe(0)
    routeProviderPanelInput(runtime, 'k')
    expect(driver.state.providerPanel?.cursor).toBe(0) // clamp at top
    routeProviderPanelInput(runtime, '\x1b[B') // down arrow
    expect(driver.state.providerPanel?.cursor).toBe(1)
    routeProviderPanelInput(runtime, '\x1b[A') // up arrow
    expect(driver.state.providerPanel?.cursor).toBe(0)
  })

  it('enter on a configured row opens the detail view; esc closes from the list', async () => {
    const { driver } = await openRuntime()
    routeProviderPanelInput(driver.providerRuntime, '\r')
    expect(driver.state.providerPanel?.phase).toBe('detail')
    routeProviderPanelInput(driver.providerRuntime, '\x1b')
    expect(driver.state.providerPanel?.phase).toBe('list')
    routeProviderPanelInput(driver.providerRuntime, '\x1b')
    expect(driver.state.providerPanel).toBeUndefined()
  })
})
