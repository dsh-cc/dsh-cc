/**
 * `llm-pi-ai` / `agent-default-model` configEditor bridge (migration plan
 * Q3 addendum, disposition: bridge with data migration). The rc.2 harness
 * consumers read their own plugin entry Config (`config.providers` /
 * `config.provider`/`model`), so the TUI write path mirrors the user-override
 * section into the live entry config; a one-shot copy moves pre-existing
 * settings.json sections across before the first write path use.
 *
 * Doubles here pin the bridge's own contract: idempotence, the
 * prefer-existing-entry conflict rule, subtree path rejection, and
 * absent-seam degradation.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SettingsProvider, type SettingsNamespace } from '@dsh-cc/settings-provider'
import {
  DEFAULT_MODEL_SETTINGS_NAMESPACE,
  PROVIDER_ENTRY_ID,
  ensureProviderBridge,
  mirrorToEntry,
} from '../src/provider-bridge.ts'
import { writeRoute } from '../src/provider-settings.ts'

type Ctx = { get(key: string): unknown }

/** ConfigEditor double: one entry per id, records edit() calls. The layered
 * `configuration()` view exists only when `layers` are given — plain doubles
 * exercise the bridge's conservative presence-guard fallback. */
function fakeConfigEditor(
  entries: Record<string, Record<string, unknown>> = {},
  layers?: Record<string, { inherited?: Record<string, unknown>; override?: Record<string, unknown> }>,
) {
  const calls: Array<{ id: string; next: Record<string, unknown> }> = []
  const rows = new Map(Object.keys(entries).map(id => [id, {
    options: {
      id,
      // Live view: applySubtree reads entry.options.config at apply time.
      get config() { return entries[id] ?? {} },
    },
  }]))
  return {
    calls,
    entries: () => [...rows.values()],
    configOf: (id: string) => entries[id] ?? {},
    ...(layers === undefined
      ? {}
      : {
          configuration: () => [...rows.values()].map(entry => ({
            entry,
            inherited: structuredClone(layers[entry.options.id]?.inherited ?? entries[entry.options.id] ?? {}),
            override: structuredClone(layers[entry.options.id]?.override ?? {}),
          })),
        }),
    edit: vi.fn(async (entry: { options: { id?: unknown } }, change: (current: Record<string, unknown>) => Record<string, unknown>) => {
      const id = String(entry.options.id)
      const next = change(entries[id] ?? {})
      entries[id] = next
      calls.push({ id, next: structuredClone(next) })
    }),
  }
}

/** ctx double with settings + configEditor; settings describes the given user sections. */
function fakeCtx(opts: {
  user?: Record<string, Record<string, unknown>>
  entries?: Record<string, Record<string, unknown>>
  layers?: Record<string, { inherited?: Record<string, unknown>; override?: Record<string, unknown> }>
  warns?: unknown[]
  withConfigEditor?: boolean
} = {}) {
  const editor = fakeConfigEditor(opts.entries, opts.layers)
  const settings = {
    describe: () => Object.entries(opts.user ?? {}).map(([ns, user]) => ({ ns, user })),
    mutate: vi.fn(async () => {}),
    replace: vi.fn(async () => {}),
    register: vi.fn(),
  }
  const ctx: Ctx & { editor: typeof editor } = {
    editor,
    get: (key: string) =>
      key === 'settings' ? settings
        : key === 'logger' && opts.warns !== undefined ? { warn: (m: unknown) => opts.warns?.push(m) }
        : key === 'configEditor' && opts.withConfigEditor !== false ? editor
        : undefined,
  }
  return { ctx, settings, editor }
}

describe('ensureProviderBridge (one-shot data migration)', () => {
  it('copies a pre-existing user llm-pi-ai section into the plugin entry config', async () => {
    const { ctx, editor } = fakeCtx({
      user: { 'llm-pi-ai': { providers: { deepseek: { baseURL: 'https://api' } } } },
      entries: { 'llm-pi-ai': {} },
    })
    await ensureProviderBridge(ctx)
    expect(editor.edit).toHaveBeenCalledTimes(1)
    expect(editor.configOf('llm-pi-ai')).toEqual({ providers: { deepseek: { baseURL: 'https://api' } } })
  })

  it('copies the agent-default-model selection into its entry config', async () => {
    const { ctx, editor } = fakeCtx({
      user: { 'agent-default-model': { provider: 'deepseek', model: 'deepseek-chat' } },
      entries: { 'agent-default-model': {} },
    })
    await ensureProviderBridge(ctx)
    expect(editor.configOf('agent-default-model')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  it('is idempotent: a second run whose sections already match performs no edit', async () => {
    const section = { providers: { deepseek: { baseURL: 'https://api' } } }
    const { ctx, editor } = fakeCtx({
      user: { 'llm-pi-ai': section },
      entries: { 'llm-pi-ai': { providers: { deepseek: { baseURL: 'https://api' } } } },
    })
    await ensureProviderBridge(ctx)
    await ensureProviderBridge(ctx)
    expect(editor.edit).not.toHaveBeenCalled()
  })

  it('prefers an existing plugin entry on conflict: no edit, warn once', async () => {
    const warns: unknown[] = []
    const { ctx, settings } = fakeCtx({
      user: { 'llm-pi-ai': { providers: { deepseek: { baseURL: 'https://user' } } } },
      entries: { 'llm-pi-ai': { providers: { deepseek: { baseURL: 'https://entry' } } } },
    })
    ;(settings as unknown as { logger?: unknown }).logger = undefined
    ctx.get = (key: string) => (key === 'settings' ? settings : key === 'configEditor' ? (ctx as { editor: unknown }).editor : key === 'logger' ? { warn: vi.fn((m: unknown) => warns.push(m)) } : undefined)
    await ensureProviderBridge(ctx)
    await ensureProviderBridge(ctx)
    expect(ctx.editor.edit).not.toHaveBeenCalled()
    expect(warns).toHaveLength(1)
  })

  it('migrates past composition-inherited defaults (they are not user decisions)', async () => {
    // rc.2 regression: the stock base bundle ships agent-default-model config
    // (deepseek-official/deepseek-flash). The presence-only guard mistook
    // those inherited values for user configuration and stranded every
    // settings.json agent-default-model section; with the layered view the
    // migration must apply.
    const { ctx, editor } = fakeCtx({
      user: { 'agent-default-model': { provider: 'orchestrix', model: 'llmbox_ant/glm-5.3', reasoningEffort: 'max' } },
      entries: { 'agent-default-model': { provider: 'deepseek-official', model: 'deepseek-flash' } },
      layers: {
        'agent-default-model': { inherited: { provider: 'deepseek-official', model: 'deepseek-flash' }, override: {} },
      },
    })
    await ensureProviderBridge(ctx)
    expect(editor.configOf('agent-default-model')).toEqual({ provider: 'orchestrix', model: 'llmbox_ant/glm-5.3', reasoningEffort: 'max' })
  })

  it('keeps a diverging profile-layer override during migration: no edit, warn once', async () => {
    const warns: unknown[] = []
    const { ctx, editor } = fakeCtx({
      warns,
      user: { 'agent-default-model': { provider: 'orchestrix', model: 'm-user', reasoningEffort: 'max' } },
      entries: { 'agent-default-model': { provider: 'user-picked', model: 'm-picked' } },
      layers: {
        'agent-default-model': {
          inherited: { provider: 'deepseek-official', model: 'deepseek-flash' },
          override: { provider: 'user-picked', model: 'm-picked' },
        },
      },
    })
    await ensureProviderBridge(ctx)
    await ensureProviderBridge(ctx)
    expect(editor.edit).not.toHaveBeenCalled()
    expect(editor.configOf('agent-default-model')).toEqual({ provider: 'user-picked', model: 'm-picked' })
    expect(warns).toHaveLength(1)
  })

  it('degrades silently without a configEditor or an unregistered namespace', async () => {
    const { ctx } = fakeCtx({ user: { 'llm-pi-ai': { providers: {} } }, withConfigEditor: false })
    await expect(ensureProviderBridge(ctx)).resolves.toBeUndefined()
  })

  it('exposes the bridged entry ids (llm-pi-ai owns the providers row)', () => {
    expect(PROVIDER_ENTRY_ID).toBe('llm-pi-ai')
    expect(DEFAULT_MODEL_SETTINGS_NAMESPACE).toBe('agent-default-model')
  })
})

describe('ensureProviderBridge against a real SettingsProvider (rc.2 regression)', () => {
  // The bridge used to register its namespaces with a toJSON-only impostor,
  // which only doubles accepted: the vendored provider CALLS the schema at
  // register time (resolveValue), so /provider crashed with "schema is not a
  // function" and the settings.json → entry-config migration behind it never
  // ran (custom providers silently dropped from the model list). Doubles here
  // must therefore be the REAL vendored provider over a real cordis context.

  /** In-memory provider: the smallest real `SettingsProvider` subclass. */
  class MemorySettings extends SettingsProvider {
    doc: Record<string, unknown>

    constructor(ctx: ConstructorParameters<typeof SettingsProvider>[0], options?: { doc?: Record<string, unknown> }) {
      super(ctx)
      this.doc = structuredClone(options?.doc ?? {})
    }

    protected load(): Promise<Record<string, unknown>> {
      return Promise.resolve(structuredClone(this.doc))
    }

    protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
      this.doc[ns] = structuredClone(section)
    }

    get writable(): boolean {
      return true
    }
  }

  /** Real vendored provider on a root context; only configEditor is doubled. */
  async function realSettingsCtx(opts: { doc?: Record<string, unknown>; entries?: Record<string, Record<string, unknown>> } = {}) {
    const root = new Context()
    await root.plugin(MemorySettings, { doc: opts.doc ?? {} })
    const editor = fakeConfigEditor(opts.entries)
    const ctx: Ctx = { get: key => (key === 'configEditor' ? editor : root.get(key)) }
    const settings = root.get('settings') as MemorySettings
    return { ctx, editor, settings }
  }

  it('registers through the real provider and migrates the settings.json providers into the entry config', async () => {
    const { ctx, editor, settings } = await realSettingsCtx({
      doc: { 'llm-pi-ai': { providers: { orchestrix: { baseURL: 'https://api' } } } },
      entries: { 'llm-pi-ai': {} },
    })
    await expect(ensureProviderBridge(ctx)).resolves.toBeUndefined()
    expect(editor.configOf('llm-pi-ai')).toEqual({ providers: { orchestrix: { baseURL: 'https://api' } } })
    const ns = settings.describe().map(row => String(row.ns))
    expect(ns).toContain('llm-pi-ai')
    expect(ns).toContain('agent-default-model')
  })

  it('is safe in either registration order: a namespace registered by another owner first is reused', async () => {
    const { ctx, editor, settings } = await realSettingsCtx({
      doc: { 'llm-pi-ai': { providers: { kimi: { apiKeyEnv: 'K' } } } },
      entries: { 'llm-pi-ai': {} },
    })
    settings.register('llm-pi-ai', z.any())
    await expect(ensureProviderBridge(ctx)).resolves.toBeUndefined()
    expect(editor.configOf('llm-pi-ai')).toEqual({ providers: { kimi: { apiKeyEnv: 'K' } } })
  })

  it('rejects a non-callable schema with a readable error (duck-typed caller guard)', async () => {
    const { settings } = await realSettingsCtx()
    expect(() => settings.register('guard-probe', { toJSON: () => ({ type: 'any' }) } as never)).toThrow('callable schemastery Schema')
  })
})

describe('mirrorToEntry (write-path mirror)', () => {
  it('pushes the user providers section into the entry config after a write', async () => {
    const { ctx, editor } = fakeCtx({
      user: { 'llm-pi-ai': { providers: { kimi: { apiKeyEnv: 'K' } } } },
      entries: { 'llm-pi-ai': { providers: {} } },
    })
    await mirrorToEntry(ctx, 'llm-pi-ai')
    expect(editor.configOf('llm-pi-ai')).toEqual({ providers: { kimi: { apiKeyEnv: 'K' } } })
  })

  it('never touches entry keys outside the namespace subtree', async () => {
    const { ctx, editor } = fakeCtx({
      user: { 'agent-default-model': { provider: 'p', model: 'm' } },
      entries: { 'agent-default-model': { other: true, provider: 'old', model: 'old' } },
    })
    await mirrorToEntry(ctx, 'agent-default-model')
    expect(editor.configOf('agent-default-model')).toEqual({ other: true, provider: 'p', model: 'm' })
  })

  it('rejects namespaces outside the bridge', async () => {
    const { ctx } = fakeCtx({})
    await expect(mirrorToEntry(ctx, 'permissions')).rejects.toThrow()
  })

  it('tolerates an absent configEditor', async () => {
    const { ctx } = fakeCtx({ user: { 'llm-pi-ai': { providers: {} } }, withConfigEditor: false })
    await expect(mirrorToEntry(ctx, 'llm-pi-ai')).resolves.toBeUndefined()
  })
})

describe('writeRoute subtree guard', () => {
  const coreWith = (ctx: Ctx) => ({ rt: { ctx }, buf: {}, runtime: () => ({}) } as never)

  it('rejects path ops outside the llm-pi-ai.providers subtree', async () => {
    const { ctx, settings } = fakeCtx({ user: { 'llm-pi-ai': { providers: {} } } })
    const error = await writeRoute(coreWith(ctx), { op: 'set', path: ['retryPolicy', 'maxRetries'], value: 3 })
    expect(error).toContain('providers')
    expect(settings.mutate).not.toHaveBeenCalled()
  })

  it('accepts providers-subtree ops and mirrors the section into the entry', async () => {
    const { ctx, settings, editor } = fakeCtx({
      user: { 'llm-pi-ai': { providers: { deepseek: {} } } },
      entries: { 'llm-pi-ai': { providers: {} } },
    })
    const error = await writeRoute(coreWith(ctx), { op: 'set', path: ['providers', 'deepseek'], value: {} })
    expect(error).toBeUndefined()
    expect(settings.mutate).toHaveBeenCalledTimes(1)
    expect(editor.configOf('llm-pi-ai')).toEqual({ providers: { deepseek: {} } })
  })
})
