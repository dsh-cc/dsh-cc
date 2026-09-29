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
import {
  DEFAULT_MODEL_SETTINGS_NAMESPACE,
  PROVIDER_ENTRY_ID,
  ensureProviderBridge,
  mirrorToEntry,
} from '../src/provider-bridge.ts'
import { writeRoute } from '../src/provider-settings.ts'

type Ctx = { get(key: string): unknown }

/** ConfigEditor double: one entry per id, records edit() calls. */
function fakeConfigEditor(entries: Record<string, Record<string, unknown>> = {}) {
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
  withConfigEditor?: boolean
} = {}) {
  const editor = fakeConfigEditor(opts.entries)
  const settings = {
    describe: () => Object.entries(opts.user ?? {}).map(([ns, user]) => ({ ns, user })),
    mutate: vi.fn(async () => {}),
    replace: vi.fn(async () => {}),
    register: vi.fn(),
  }
  const ctx: Ctx & { editor: typeof editor } = {
    editor,
    get: (key: string) => (key === 'settings' ? settings : key === 'configEditor' && opts.withConfigEditor !== false ? editor : undefined),
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

  it('degrades silently without a configEditor or an unregistered namespace', async () => {
    const { ctx } = fakeCtx({ user: { 'llm-pi-ai': { providers: {} } }, withConfigEditor: false })
    await expect(ensureProviderBridge(ctx)).resolves.toBeUndefined()
  })

  it('exposes the bridged entry ids (llm-pi-ai owns the providers row)', () => {
    expect(PROVIDER_ENTRY_ID).toBe('llm-pi-ai')
    expect(DEFAULT_MODEL_SETTINGS_NAMESPACE).toBe('agent-default-model')
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
