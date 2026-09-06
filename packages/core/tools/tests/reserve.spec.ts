/**
 * The `reserve`/`isAdmitted` seam: a capability name can be made known and
 * restrictable BEFORE its definition loads, without becoming model-visible, and
 * a scope's restriction must be distinguishable from a plain absent name when a
 * caller decides whether a deferred tool may load for it.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME } from '@dsh-cc/tools'
import type { ToolDefinition } from '@dsh-cc/tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

async function mintAgentScope(ctx: Context, name: string): Promise<{ key: Agent; scope: Scope }> {
  const key = { id: name as SessionId } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, key) },
    { inject: ['tools', 'systemPrompt'] }))
  return { key, scope }
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: (): Promise<string> => Promise.resolve('ok'),
  }
}

describe('tools.reserve()', () => {
  it('makes a name known and restrictable without making it visible', async () => {
    const ctx = await mount()
    ctx.tools.reserve('heavy_tool')

    // Known to the registry (restrict may name it) but not presented to the model.
    expect(ctx.tools.schemas().map(s => s.name)).toEqual([])
    expect(ctx.tools.get('heavy_tool')).toBeUndefined()

    // A scope can restrict the reserved name even though no definition loaded.
    const { key, scope } = await mintAgentScope(ctx, 'agent')
    scope.ctx.tools.restrict({ deny: ['heavy_tool'] })
    expect(ctx.tools.isAdmitted('heavy_tool', key)).toBe(false)
  })

  it('tears the reservation down with its disposer', async () => {
    const ctx = await mount()
    const dispose = ctx.tools.reserve('heavy_tool')

    const { key, scope } = await mintAgentScope(ctx, 'agent')
    scope.ctx.tools.restrict({ deny: ['heavy_tool'] })
    expect(ctx.tools.isAdmitted('heavy_tool', key)).toBe(false)

    dispose()
    // After disposer the name is no longer a legal restrict target.
    expect(() => scope.ctx.tools.restrict({ deny: ['heavy_tool'] })).toThrow(/unknown global tool/)
  })

  it('rejects a duplicate reservation and the reserved transport name', async () => {
    const ctx = await mount()
    ctx.tools.reserve('heavy_tool')
    expect(() => ctx.tools.reserve('heavy_tool')).toThrow(/already reserved/)
    expect(() => ctx.tools.reserve(RUN_CODE_NAME)).toThrow(/reserved/)
  })

  it('reclaims a scoped reservation on dispose', async () => {
    const ctx = await mount()
    const { key, scope } = await mintAgentScope(ctx, 'agent')

    const dispose = scope.ctx.tools.reserve('scoped_tool')
    expect(() => scope.ctx.tools.reserve('scoped_tool')).toThrow(/already reserved/)

    dispose()
    // The scoped layer is fully empty again, so the name is no longer known.
    expect(() => scope.ctx.tools.restrict({ deny: ['scoped_tool'] })).toThrow(/unknown global tool/)
    expect(ctx.tools.isAdmitted('scoped_tool', key)).toBe(true)
  })
})

describe('tools.isAdmitted()', () => {
  it('is true without any restriction, globally and for an unconstrained scope', async () => {
    const ctx = await mount()
    ctx.tools.reserve('heavy_tool')
    const { key } = await mintAgentScope(ctx, 'agent')

    expect(ctx.tools.isAdmitted('heavy_tool')).toBe(true)
    expect(ctx.tools.isAdmitted('heavy_tool', key)).toBe(true)
  })

  it('is false when a scope denies the reserved name', async () => {
    const ctx = await mount()
    ctx.tools.reserve('heavy_tool')
    const { key, scope } = await mintAgentScope(ctx, 'agent')

    scope.ctx.tools.restrict({ deny: ['heavy_tool'] })
    expect(ctx.tools.isAdmitted('heavy_tool', key)).toBe(false)
    // The global view still admits it (restrictions are per scope).
    expect(ctx.tools.isAdmitted('heavy_tool')).toBe(true)
  })

  it('is false when a scope allow-list omits the name, true when it lists it', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('real_tool'))
    ctx.tools.reserve('heavy_tool')
    const { key, scope } = await mintAgentScope(ctx, 'agent')

    scope.ctx.tools.restrict({ allow: ['real_tool', 'heavy_tool'] })
    expect(ctx.tools.isAdmitted('heavy_tool', key)).toBe(true)
    expect(ctx.tools.isAdmitted('other', key)).toBe(false)

    scope.ctx.tools.restrict({ allow: ['real_tool'] })
    expect(ctx.tools.isAdmitted('heavy_tool', key)).toBe(false)
  })

  it('applies to registered tools as well as reserved ones', async () => {
    const ctx = await mount()
    ctx.tools.register(tool('real_tool'))
    const { key, scope } = await mintAgentScope(ctx, 'agent')

    expect(ctx.tools.isAdmitted('real_tool', key)).toBe(true)
    scope.ctx.tools.restrict({ deny: ['real_tool'] })
    expect(ctx.tools.isAdmitted('real_tool', key)).toBe(false)
  })
})
