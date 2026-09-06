/**
 * Unit tests for the ToolSearch activation append-order plugin: each scope's
 * previously emitted tool sequence is remembered on the `system-prompt/assemble`
 * waterfall, surviving tools keep their positions, and new tools (a ToolSearch
 * activation, an MCP registration) append lexicographically at the tail — so an
 * activation extends the request prefix instead of shifting every tool after
 * the insertion point.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolAppendOrder from '@dsh-cc/tool-append-order'

/** The scope keys used by the tests; any distinct objects will do. */
const scopeA = { id: 'agent-a' }
const scopeB = { id: 'agent-b' }

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  return { ctx, systemPrompt: ctx.systemPrompt }
}

/** Mount the plugin under test as a preset row would. */
async function mount(ctx: Context) {
  await ctx.plugin(ToolAppendOrder)
}

/** Register a scope context like a preset subtree does; returns its scoped context. */
async function mintScope(ctx: Context, key: object): Promise<Context> {
  let scopeCtx!: Context
  await ctx.plugin(Object.assign((inner: Context) => {
    scopeCtx = createScope(inner, key).ctx
  }, { inject: ['systemPrompt'] }))
  return scopeCtx
}

/**
 * A tool-schema provider whose visible set the test drives: the harness sorts
 * schemas lexicographically at assembly, so `show`/`hide` alone control what
 * each assembly sees and in which baseline order.
 */
function controlledTools(ctx: Context) {
  const visible = new Set<string>()
  ctx.systemPrompt.tools(() => ({
    schemas: [...visible].sort().map(name => ({
      name,
      description: `Tool ${name}.`,
      parameters: { type: 'object', properties: {} },
    })),
  }))
  return {
    show: (...names: string[]) => {
      for (const name of names) visible.add(name)
    },
    hide: (name: string) => {
      visible.delete(name)
    },
  }
}

function names(assembly: { tools: { name: string }[] }): string[] {
  return assembly.tools.map(tool => tool.name)
}

describe('append-order assembly waterfall', () => {
  it('passes the harness baseline order through on the first scoped assembly', async () => {
    const { ctx, systemPrompt } = await setup()
    const tools = controlledTools(ctx)
    await mount(ctx)

    tools.show('zeta', 'alpha', 'mike')
    const assembly = await systemPrompt.assemble({ scope: scopeA })

    // Harness lexicographic order, untouched: the baseline every later
    // assembly is pinned to.
    expect(names(assembly)).toEqual(['alpha', 'mike', 'zeta'])
  })

  it('appends a newly visible tool at the tail without moving the established order', async () => {
    const { ctx, systemPrompt } = await setup()
    const tools = controlledTools(ctx)
    await mount(ctx)

    tools.show('zeta', 'alpha', 'mike')
    expect(names(await systemPrompt.assemble({ scope: scopeA }))).toEqual(['alpha', 'mike', 'zeta'])

    // 'beta' sorts before 'mike'/'zeta': plain harness order would shift both.
    // Activation must append instead.
    tools.show('beta')
    const assembly = await systemPrompt.assemble({ scope: scopeA })
    expect(names(assembly)).toEqual(['alpha', 'mike', 'zeta', 'beta'])
  })

  it('filters removed tools out while keeping the surviving order', async () => {
    const { ctx, systemPrompt } = await setup()
    const tools = controlledTools(ctx)
    await mount(ctx)

    tools.show('zeta', 'alpha', 'mike')
    expect(names(await systemPrompt.assemble({ scope: scopeA }))).toEqual(['alpha', 'mike', 'zeta'])
    tools.show('beta')
    expect(names(await systemPrompt.assemble({ scope: scopeA }))).toEqual(['alpha', 'mike', 'zeta', 'beta'])

    tools.hide('mike')
    const assembly = await systemPrompt.assemble({ scope: scopeA })
    expect(names(assembly)).toEqual(['alpha', 'zeta', 'beta'])
  })

  it('remembers each scope independently', async () => {
    const { ctx, systemPrompt } = await setup()
    await mount(ctx)
    // Each scope contributes its own tool set, as distinct agents do.
    const toolsA = controlledTools(await mintScope(ctx, scopeA))
    const toolsB = controlledTools(await mintScope(ctx, scopeB))

    toolsA.show('alpha', 'zeta')
    expect(names(await systemPrompt.assemble({ scope: scopeA }))).toEqual(['alpha', 'zeta'])

    toolsA.show('beta')
    expect(names(await systemPrompt.assemble({ scope: scopeA }))).toEqual(['alpha', 'zeta', 'beta'])

    // B's first assembly takes its OWN baseline, not A's sequence.
    toolsB.show('alpha', 'beta')
    expect(names(await systemPrompt.assemble({ scope: scopeB }))).toEqual(['alpha', 'beta'])

    // B appends relative to B's own sequence — leaked A state would emit
    // ['alpha', 'zeta', 'beta'] here.
    toolsB.show('zeta')
    expect(names(await systemPrompt.assemble({ scope: scopeB }))).toEqual(['alpha', 'beta', 'zeta'])

    // A is unaffected by B's assemblies.
    expect(names(await systemPrompt.assemble({ scope: scopeA }))).toEqual(['alpha', 'zeta', 'beta'])
  })

  it('emits byte-identical tools for repeated assemblies over the same input', async () => {
    const { ctx, systemPrompt } = await setup()
    const tools = controlledTools(ctx)
    await mount(ctx)

    tools.show('echo', 'bravo')
    expect(names(await systemPrompt.assemble({ scope: scopeA }))).toEqual(['bravo', 'echo'])

    tools.show('delta')
    const first = await systemPrompt.assemble({ scope: scopeA })
    expect(names(first)).toEqual(['bravo', 'echo', 'delta'])

    // Same input again: the memory sequence ('bravo, echo, delta') differs from
    // the harness order ('bravo, delta, echo'), so only the plugin keeps this
    // byte-stable.
    const second = await systemPrompt.assemble({ scope: scopeA })
    expect(names(second)).toEqual(['bravo', 'echo', 'delta'])
    expect(JSON.stringify(second.tools)).toEqual(JSON.stringify(first.tools))
  })

  it('passes scope-less global assemblies through untouched', async () => {
    const { ctx, systemPrompt } = await setup()
    const tools = controlledTools(ctx)
    await mount(ctx)

    tools.show('mike', 'alpha')
    expect(names(await systemPrompt.assemble())).toEqual(['alpha', 'mike'])

    // Still pure harness order after a change — no global sequence is tracked.
    tools.show('beta')
    expect(names(await systemPrompt.assemble())).toEqual(['alpha', 'beta', 'mike'])
  })

  it('composes with a code-mode-style filter listener identically in both registration orders', async () => {
    const run = async (codeModeFirst: boolean): Promise<string[][]> => {
      const { ctx, systemPrompt } = await setup()
      const tools = controlledTools(ctx)
      const codeModeListener = async (
        _assembly: unknown,
        _context: unknown,
        next: () => Promise<{ tools: { name: string }[] }>,
      ): Promise<{ tools: { name: string }[] }> => {
        const result = await next()
        return { ...result, tools: result.tools.filter(tool => tool.name !== 'run_code') }
      }
      const registerCodeMode = () => {
        ctx.on('system-prompt/assemble', codeModeListener as never)
      }
      if (codeModeFirst) {
        registerCodeMode()
        await mount(ctx)
      } else {
        await mount(ctx)
        registerCodeMode()
      }

      const observed: string[][] = []
      tools.show('alpha', 'run_code', 'zeta')
      observed.push(names(await systemPrompt.assemble({ scope: scopeA })))
      tools.show('beta')
      observed.push(names(await systemPrompt.assemble({ scope: scopeA })))
      tools.hide('run_code')
      observed.push(names(await systemPrompt.assemble({ scope: scopeA })))
      return observed
    }

    expect(await run(true)).toEqual(await run(false))
    // And the composition itself appends activations at the tail of the
    // filtered wire order.
    expect(await run(false)).toEqual([
      ['alpha', 'zeta'],
      ['alpha', 'zeta', 'beta'],
      ['alpha', 'zeta', 'beta'],
    ])
  })
})
