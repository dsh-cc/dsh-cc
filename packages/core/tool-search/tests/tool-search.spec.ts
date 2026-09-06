/**
 * The deferred-tool registry and ToolSearch tool. What it owes its caller: a
 * deferred tool is invisible until a ToolSearch hit loads it into the real
 * registry; loading is idempotent and unwinds with the deferred registration;
 * `alwaysLoad` loads immediately; and a scoped restriction denies a deferred
 * tool before it can load for that agent.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@dsh-cc/tools'
import DeferredToolRegistry, { TOOL_SEARCH_NAME } from '@dsh-cc/tool-search'
import type { DeferredToolRegistration } from '@dsh-cc/tool-search'

const signal = new AbortController().signal

/** A host plane with the tool registry, system prompt, and the ToolSearch service. */
async function host(options: { toolSearch?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  if (options.toolSearch !== false) await ctx.plugin(DeferredToolRegistry)
  return ctx
}

/** Register one real tool definition (the "heavy" implementation a deferred tool loads). */
function bigTool(name: string, description: string) {
  return defineTool({
    name,
    description,
    parameters: { value: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: args => Promise.resolve(args.value ?? 'ok'),
  })
}

/** Register a deferred tool whose activation performs a real `ctx.tools.register`. */
function deferred(host: Context, name: string, description: string, searchHint?: string, extra: Partial<DeferredToolRegistration> = {}) {
  return host.toolSearch.registerDeferred({
    name,
    description,
    ...searchHint !== undefined ? { searchHint } : {},
    activate: () => host.tools.register(bigTool(name, description)),
    ...extra,
  })
}

/** Mint an agent-scoped context under the host, as a preset subtree does. */
async function mintAgent(host: Context, id: string): Promise<{ agent: Agent; scope: Scope }> {
  const agent = { id: SessionId(id) } as Agent
  let scope!: Scope
  const fiber = host.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
  }, { inject: ['tools', 'systemPrompt', 'toolSearch'] }))
  await fiber.await()
  return { agent, scope }
}

/**
 * Mint an agent scope that hosts its OWN deferred registry on the scoped
 * context — as a CC agent preset would, so `this.ctx` (and thus `registerDeferred`
 * and the no-arg `search` fallback) resolve to that agent's scope rather than
 * the global host.
 */
async function installScopedRegistry(host: Context, id: string): Promise<{ agent: Agent; scope: Scope; registry: DeferredToolRegistry }> {
  const agent = { id: SessionId(id) } as Agent
  let scope!: Scope
  let registry!: DeferredToolRegistry
  const fiber = host.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, agent)
    scope.ctx.plugin(DeferredToolRegistry)
    scope.ctx.plugin(Object.assign((c: Context) => {
      registry = c.toolSearch
    }, { inject: ['toolSearch'] }))
  }, { inject: ['tools', 'systemPrompt'] }))
  await fiber.await()
  return { agent, scope, registry }
}

/** Observable model-facing tool names for a scope (undefined = global). */
async function visibleNames(host: Context, scope?: Agent | Scope) {
  const context: { scope?: Agent | Scope } = scope === undefined ? {} : { scope }
  const assembly = await host.systemPrompt.assemble(context)
  return assembly.tools.map(tool => tool.name)
}

/** Execute the ToolSearch tool on the host as the model would. */
interface ToolSearchValue {
  query: string
  message: string
  results: Array<{ name: string; description: string; status: string; reason?: string }>
}

async function runToolSearch(host: Context, query: string, args: { max_results?: number; agent?: Agent } = {}) {
  const result = await host.tools.execute({
    signal,
    callId: CallId('search'),
    name: TOOL_SEARCH_NAME,
    arguments: { query, ...args.max_results !== undefined ? { max_results: args.max_results } : {} },
    ...args.agent !== undefined ? { agent: args.agent } : {},
  })
  expect(result.isError).toBe(false)
  return result as typeof result & { value: ToolSearchValue }
}

describe('the deferred tool registry', () => {
  it('keeps a deferred tool invisible until it is loaded', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy filesystem capability.', 'read')

    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME])
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([TOOL_SEARCH_NAME])
  })

  it('searches the deferred set by name, searchHint, and description', async () => {
    const ctx = await host()
    deferred(ctx, 'bash_tool', 'Run shell commands.', 'shell terminal')
    deferred(ctx, 'write_file', 'Overwrite a file on disk.', 'edit write')
    deferred(ctx, 'notebook', 'Drive a Jupyter notebook.', 'python cells')

    // Name match outranks hint outranks description.
    expect(ctx.toolSearch.search('bash').map(hit => hit.name)).toContain('bash_tool')
    expect(ctx.toolSearch.search('shell').map(hit => hit.name)).toContain('bash_tool')
    expect(ctx.toolSearch.search('jupyter').map(hit => hit.name)).toEqual(['notebook'])
    // A description-only match still surfaces.
    expect(ctx.toolSearch.search('disk').map(hit => hit.name)).toEqual(['write_file'])
  })

  it('ranks name matches above hint matches above description matches', async () => {
    const ctx = await host()
    deferred(ctx, 'edit_tool', 'Change file contents.', 'write modify')
    deferred(ctx, 'write_tool', 'Create files.', 'edit')

    const names = ctx.toolSearch.search('edit').map(hit => hit.name)
    // `edit_tool` matches on its name and its hint; `write_tool` only on its
    // description. However both carry hint/description `edit`, so the name
    // exact token must break the tie deterministically.
    expect(names[0]).toBe('edit_tool')
  })

  it('respects max_results and defaults it to five', async () => {
    const ctx = await host()
    for (let index = 0; index < 7; index += 1) {
      deferred(ctx, `tool_${index}`, `capability number ${index}`, 'something')
    }

    expect(ctx.toolSearch.search('capability').length).toBe(5)
    expect(ctx.toolSearch.search('capability', 2).length).toBe(2)
  })

  it('overrides the default max_results through the tool call', async () => {
    const ctx = await host()
    for (let index = 0; index < 3; index += 1) {
      deferred(ctx, `tool_${index}`, `capability number ${index}`, 'something')
    }

    const result = await runToolSearch(ctx, 'capability', { max_results: 2 })
    expect(result.value.results.length).toBe(2)
  })
})

describe('loading a deferred tool', () => {
  it('loads a matched tool so the next assembly sees it', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME])

    const result = await runToolSearch(ctx, 'data')
    expect(result.value.results[0]?.status).toBe('loaded')

    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME, 'big_tool'])
  })

  it('returns a model-readable summary naming the loaded tool', async () => {
    const ctx = await host()
    deferred(ctx, 'bash_tool', 'Run shell commands.', 'shell')

    const result = await runToolSearch(ctx, 'shell')
    const block = result.content[0]
    expect(block?.type).toBe('text')
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain('bash_tool')
    expect(text).toContain('Run shell commands.')
  })

  it('is idempotent: loading an already-loaded tool is a no-op', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')

    expect(ctx.toolSearch.activate('big_tool').status).toBe('loaded')
    // A second activation must NOT re-register (which would throw on the
    // duplicate global name) nor reload.
    expect(ctx.toolSearch.activate('big_tool').status).toBe('already-loaded')

    // Still exactly one visible registration.
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME, 'big_tool'])
    // Once active it is directly callable, so it leaves the deferred set.
    expect(ctx.toolSearch.search('data')).toEqual([])
  })

  it('unloads the activated tool together with its deferred registration', async () => {
    const ctx = await host()
    const dispose = deferred(ctx, 'big_tool', 'Heavy capability.', 'data')

    await runToolSearch(ctx, 'data')
    expect(await visibleNames(ctx)).toContain('big_tool')

    dispose()
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME])
  })
})

describe('alwaysLoad', () => {
  it('loads immediately and is never a deferred candidate', async () => {
    const ctx = await host()
    deferred(ctx, 'essential', 'Always-present capability.', 'core', { alwaysLoad: true })
    deferred(ctx, 'heavy', 'Deferred capability.', 'data')

    // Visible from the start, without any search.
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME, 'essential'])
    expect(ctx.toolSearch.search('data').map(hit => hit.name)).toEqual(['heavy'])
    expect(ctx.toolSearch.search('core').map(hit => hit.name)).toEqual([])
    expect(ctx.toolSearch.activate('essential').status).toBe('already-loaded')
  })
})

describe('restriction priority', () => {
  it('does not load a deferred tool a scope denies, and says so', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')
    const { agent, scope } = await mintAgent(ctx, 'restricted')

    // Deny the reserved deferred name for this one agent; the reservation makes
    // it a legal restrict target even before it loads.
    scope.ctx.tools.restrict({ deny: ['big_tool'] })

    // The agent's own ToolSearch keeps it unloaded and explains why.
    const result = await runToolSearch(ctx, 'data', { agent })
    expect(result.value.results[0]?.status).toBe('denied')
    expect(result.value.results[0]?.reason).toContain('restricted')
    expect(ctx.toolSearch.activate('big_tool', agent).status).toBe('denied')

    // It stays unloaded for that agent, and is never in its schema.
    expect(await visibleNames(ctx, agent)).not.toContain('big_tool')
  })

  it('still loads the tool for an unrestricted scope', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')
    const { agent, scope } = await mintAgent(ctx, 'restricted')
    scope.ctx.tools.restrict({ deny: ['big_tool'] })

    // An unrestricted scope in the same process can still load it.
    expect(await visibleNames(ctx)).not.toContain('big_tool')
    expect(ctx.toolSearch.activate('big_tool').status).toBe('loaded')
    // The restricting agent still does not see it.
    expect(await visibleNames(ctx, agent)).not.toContain('big_tool')
  })
})

describe('scoped deferred visibility', () => {
  it('makes a deferred tool visible to its owning scope chain, invisible to siblings and the global view', async () => {
    const ctx = await host()
    // A global registration stays visible everywhere (regression).
    deferred(ctx, 'global_tool', 'Global capability.', 'global')

    const a = await installScopedRegistry(ctx, 'scope-a')
    a.registry.registerDeferred({
      name: 'scoped_tool',
      description: 'Scoped-only capability.',
      searchHint: 'scoped',
      activate: () => a.scope.ctx.tools.register(bigTool('scoped_tool', 'Scoped-only capability.')),
    })
    const b = await installScopedRegistry(ctx, 'scope-b')

    // Scope A sees its own deferred tool — through an explicit scope and via the
    // no-arg fallback onto its own scoped context — and still the global one.
    expect(a.registry.search('scoped', 5, a.agent).map(hit => hit.name)).toEqual(['scoped_tool'])
    expect(a.registry.search('scoped').map(hit => hit.name)).toEqual(['scoped_tool'])
    expect(a.registry.search('global').map(hit => hit.name)).toEqual(['global_tool'])

    // Sibling scope B never sees A's deferred tool; it does see the global one.
    expect(b.registry.search('scoped')).toEqual([])
    expect(b.registry.search('global').map(hit => hit.name)).toEqual(['global_tool'])

    // The global registry (host scope) sees only the global deferred tool.
    expect(ctx.toolSearch.search('scoped')).toEqual([])
    expect(ctx.toolSearch.search('global').map(hit => hit.name)).toEqual(['global_tool'])
  })

  it('activates a scoped deferred tool for its owner scope only', async () => {
    const ctx = await host()
    const a = await installScopedRegistry(ctx, 'scope-a')
    a.registry.registerDeferred({
      name: 'scoped_tool',
      description: 'Scoped-only capability.',
      searchHint: 'scoped',
      activate: () => a.scope.ctx.tools.register(bigTool('scoped_tool', 'Scoped-only capability.')),
    })
    const b = await installScopedRegistry(ctx, 'scope-b')

    // Scope A loads its own deferred tool.
    expect(a.registry.activate('scoped_tool', a.agent).status).toBe('loaded')
    // A sibling scope cannot even find it.
    expect(b.registry.activate('scoped_tool', b.agent).status).toBe('unknown')
    // Nor can the global registry.
    expect(ctx.toolSearch.activate('scoped_tool').status).toBe('unknown')
  })
})

describe('lazy ToolSearch registration', () => {
  it('keeps ToolSearch invisible while the pool is empty, but reserved and restrictable', async () => {
    const ctx = await host()

    // No searchable deferred entries → no ToolSearch in the model-visible set.
    expect(await visibleNames(ctx)).toEqual([])
    expect(ctx.tools.get(TOOL_SEARCH_NAME)).toBeUndefined()
    // The name is reserved: admitted everywhere, and a legal restrict target.
    expect(ctx.tools.isAdmitted(TOOL_SEARCH_NAME)).toBe(true)
    const { scope } = await mintAgent(ctx, 'gated')
    expect(() => scope.ctx.tools.restrict({ deny: [TOOL_SEARCH_NAME] })).not.toThrow()
  })

  it('registers ToolSearch on the first non-alwaysLoad entry (0→1) and keeps it after unload (hysteresis)', async () => {
    const ctx = await host()
    expect(await visibleNames(ctx)).toEqual([])

    const dispose = deferred(ctx, 'big_tool', 'Heavy capability.', 'data')
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME])

    // Hysteresis: emptying the pool does NOT unregister ToolSearch mid-session
    // (a mid-list removal would shift every later tool and break the cached
    // prefix; the empty-pool copy branch below covers the messaging instead).
    dispose()
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME])

    // A later registration reuses the standing registration without duplicating.
    deferred(ctx, 'other_tool', 'Another capability.', 'other')
    expect(await visibleNames(ctx)).toEqual([TOOL_SEARCH_NAME])
  })

  it('never registers ToolSearch for an alwaysLoad-only pool', async () => {
    const ctx = await host()
    deferred(ctx, 'essential', 'Always-present capability.', 'core', { alwaysLoad: true })

    expect(await visibleNames(ctx)).toEqual(['essential'])
  })

  it('makes the registration disposer idempotent', async () => {
    const ctx = await host()
    const dispose = deferred(ctx, 'big_tool', 'Heavy capability.', 'data')

    dispose()
    expect(() => dispose()).not.toThrow()
    expect(ctx.toolSearch.search('data')).toEqual([])
  })
})

describe('empty-search messaging', () => {
  it('says the pool is empty (and to call tools directly) when no deferred entries remain', async () => {
    const ctx = await host()
    const dispose = deferred(ctx, 'big_tool', 'Heavy capability.', 'data')
    dispose() // hysteresis keeps ToolSearch callable with an empty pool

    const result = await runToolSearch(ctx, 'anything')
    expect(result.value.results).toEqual([])
    expect(result.value.message).toContain('No deferred tools are available to you')
    expect(result.value.message).toContain('call it directly')
  })

  it('says everything is already loaded when the pool is fully activated', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')
    await runToolSearch(ctx, 'data')

    const result = await runToolSearch(ctx, 'zzz-no-match')
    expect(result.value.results).toEqual([])
    expect(result.value.message).toContain('already loaded')
    expect(result.value.message).toContain('call them directly')
  })

  it('points at direct invocation when a non-empty pool simply has no match', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')

    const result = await runToolSearch(ctx, 'zzz-no-match')
    expect(result.value.results).toEqual([])
    expect(result.value.message).toContain('No deferred tools matched "zzz-no-match"')
    expect(result.value.message).toContain('call it directly')
  })
})

describe('presentation', () => {
  it('declares an explicit generic render intent as pure functions of args', async () => {
    const ctx = await host()
    deferred(ctx, 'big_tool', 'Heavy capability.', 'data')

    const definition = ctx.tools.get(TOOL_SEARCH_NAME)
    expect(definition).toBeDefined()
    const presentCall = definition!.presentCall!
    const presentResult = definition!.presentResult!
    const call = presentCall({ query: 'data' })
    expect(call).toMatchObject({ card: 'generic', kind: 'search', rawInput: 'data' })

    const resultView = presentResult({ query: 'data' }, {
      content: [{ type: 'text', text: 'summary' }],
      isError: false,
    })
    expect(resultView).toMatchObject({ card: 'generic', title: 'Tool search' })
  })
})
