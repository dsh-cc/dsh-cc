import { describe, expect, it, vi } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { promptSkillName, syncPrompts } from '@dsh-cc/mcp-client/src/prompts.ts'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { syncResources, resourcePublicName } from '@dsh-cc/mcp-client/src/resources.ts'

// ---- Mock MCP Client (tools + resources + prompts) ----

function createMockClient(handler: (method: string, params?: Record<string, unknown>) => unknown) {
  return {
    request: vi.fn(async (
      request: { method: string; params?: Record<string, unknown> },
      _schema: unknown,
      _options?: unknown,
    ): Promise<unknown> => handler(request.method, request.params)),
    setNotificationHandler: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

async function mountTools(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

async function mountToolsAndSkills(): Promise<Context> {
  const ctx = await mountTools()
  await ctx.plugin(SkillRegistry)
  return ctx
}

describe('resourcePublicName / naming', () => {
  it('produces server-qualified resource tool names', () => {
    expect(resourcePublicName('github', 'list_mcp_resources')).toBe('mcp__github__list_mcp_resources')
    expect(resourcePublicName('web', 'read_mcp_resource')).toBe('mcp__web__read_mcp_resource')
  })
})

describe('syncResources', () => {
  it('registers the two resource bridge tools on ctx.tools', async () => {
    const ctx = await mountTools()
    const client = createMockClient((method, params) => {
      if (method === 'resources/list') {
        return { resources: [{ uri: 'file:///a', name: 'a' }], nextCursor: undefined }
      }
      if (method === 'resources/read') {
        return { contents: [{ uri: params?.uri, text: 'hello' }] }
      }
      throw new Error(`unexpected: ${method}`)
    })

    const disposers = syncResources(client as never, ctx, 'github')

    expect(ctx.tools.get('mcp__github__list_mcp_resources')).toBeDefined()
    expect(ctx.tools.get('mcp__github__read_mcp_resource')).toBeDefined()

    const list = await ctx.tools.execute({
      callId: CallId('c1'), name: 'mcp__github__list_mcp_resources', arguments: {}, signal: new AbortController().signal,
    })
    if (list.isError) throw new Error('list failed')
    expect(list.content[0]).toEqual({ type: 'text', text: 'file:///a — a' })

    const read = await ctx.tools.execute({
      callId: CallId('c2'), name: 'mcp__github__read_mcp_resource', arguments: { uri: 'file:///a' }, signal: new AbortController().signal,
    })
    if (read.isError) throw new Error('read failed')
    expect(read.content[0]).toEqual({ type: 'text', text: 'hello' })

    expect(client.request).toHaveBeenCalledWith(
      { method: 'resources/read', params: { uri: 'file:///a' } },
      expect.anything(),
      expect.anything(),
    )

    // Disposal unregisters both tools.
    for (const dispose of disposers.values()) dispose()
    expect(ctx.tools.get('mcp__github__list_mcp_resources')).toBeUndefined()
    expect(ctx.tools.get('mcp__github__read_mcp_resource')).toBeUndefined()
  })
})

describe('promptSkillName', () => {
  it('maps mcp__<server>__<prompt> to a valid kebab-case skill name', () => {
    const name = promptSkillName('github', 'create_issue')
    expect(name).toBe('mcp-github-create-issue')
    expect(isSkillName(name)).toBe(true)
  })

  it('collapses separators and lowercases, keeping a leading mcp', () => {
    expect(promptSkillName('My-Server', 'Review Code')).toBe('mcp-my-server-review-code')
    expect(isSkillName(promptSkillName('My-Server', 'Review Code'))).toBe(true)
  })
})

describe('syncPrompts', () => {
  it('registers one skill per argumentless prompt using its rendered body', async () => {
    const ctx = await mountToolsAndSkills()
    const client = createMockClient((method, params) => {
      if (method === 'prompts/list') {
        return { prompts: [{ name: 'greet', description: 'Greet' }], nextCursor: undefined }
      }
      if (method === 'prompts/get') {
        expect(params?.name).toBe('greet')
        return { messages: [{ role: 'user', content: { type: 'text', text: 'Hello there' } }] }
      }
      throw new Error(`unexpected: ${method}`)
    })

    const disposers = await syncPrompts(client as never, ctx, 'github')

    expect(disposers.size).toBe(1)
    const skill = await ctx.skills.get('mcp-github-greet', {})
    expect(skill).toBeDefined()
    expect(skill?.content).toContain('Hello there')

    for (const dispose of disposers.values()) dispose()
    const after = await ctx.skills.get('mcp-github-greet', {})
    expect(after).toBeUndefined()
  })

  it('documents prompts that require arguments instead of fetching', async () => {
    const ctx = await mountToolsAndSkills()
    const client = createMockClient((method) => {
      if (method === 'prompts/list') {
        return { prompts: [{ name: 'needs-args', arguments: [{ name: 'topic', required: true }] }], nextCursor: undefined }
      }
      throw new Error(`unexpected: ${method}`)
    })

    const disposers = await syncPrompts(client as never, ctx, 'github')
    expect(disposers.size).toBe(1)
    const skill = await ctx.skills.get('mcp-github-needs-args', {})
    expect(skill?.content).toContain('topic')
    expect(skill?.content).toContain('required')
  })

  it('is a no-op when the skills service is absent', async () => {
    const ctx = await mountTools()
    const client = createMockClient((method) => {
      if (method === 'prompts/list') return { prompts: [{ name: 'p' }], nextCursor: undefined }
      throw new Error(`unexpected: ${method}`)
    })

    const disposers = await syncPrompts(client as never, ctx, 'github')
    expect(disposers.size).toBe(0)
  })

  it('contains no executable shell in the registered body', async () => {
    const ctx = await mountToolsAndSkills()
    const client = createMockClient((method) => {
      if (method === 'prompts/list') return { prompts: [{ name: 'hint' }], nextCursor: undefined }
      if (method === 'prompts/get') return { messages: [{ role: 'user', content: { type: 'text', text: 'run nothing' } }] }
      throw new Error(`unexpected: ${method}`)
    })
    const disposers = await syncPrompts(client as never, ctx, 'github')
    const skill = await ctx.skills.get('mcp-github-hint', {})
    expect(skill?.content).not.toMatch(/```|\$\(|exec|system\(/i)
    for (const dispose of disposers.values()) dispose()
  })
})
