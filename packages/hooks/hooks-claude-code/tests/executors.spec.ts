import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { defineContentToolFixture } from '@dsh-cc/tools'
import { contentToHookOutput, interpolatePrompt } from '@dsh-cc/hooks-claude-code'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'

/**
 * `prompt`/`agent` executor tests. The fork subagent seam is stubbed (a synthetic
 * `ctx.subagents` service), so the assertion is that dispatch routes to
 * `subagents.start` with the interpolated prompt, that disabled-by-default skips
 * execution, and that the pure output/interpolation helpers decode correctly.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function writeConfig(hooks: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-exec-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }))
  return dir
}

async function harness(
  configDir: string,
  adapter: MockAdapter,
  pluginConfig: Record<string, unknown>,
  beforeHooks?: (ctx: Context) => void,
): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  beforeHooks?.(ctx)
  await ctx.plugin(HooksClaude, { configPath: join(configDir, 'hooks.json'), ...pluginConfig })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** A minimal fork-subagent seam whose start records the full request and returns a chosen result. */
function fakeSubagents(hook: { stopReason: string; content: readonly { type: string; text?: string }[] }) {
  const calls: Array<{ name: string; request: Record<string, unknown> }> = []
  const service = {
    start(name: string, request: Record<string, unknown>) {
      calls.push({ name, request })
      return { result: Promise.resolve(hook) }
    },
  }
  return { service, calls }
}

/** Fake ccModelRoutes service resolving only the aliases in the given map. */
function fakeRoutes(routes: Record<string, { provider?: string; model?: string }>) {
  return {
    resolve: (model: string | undefined) => model === undefined ? undefined : routes[model.toLowerCase()],
  }
}

/** A harmless always-OK hook result for stamp-focused cases. */
function okHookResult() {
  return { stopReason: 'completed' as const, content: [{ type: 'text' as const, text: '{}' }] }
}

describe('contentToHookOutput (pure)', () => {
  it('concatenates text blocks and parses recognized HookOutput fields', () => {
    const { output } = contentToHookOutput({
      stopReason: 'completed',
      content: [
        { type: 'text', text: '{"continue":false,"stopReason":"halt","systemMessage":"watch out",' },
        { type: 'text', text: '"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","permissionDecision":"deny",' },
        { type: 'text', text: '"permissionDecisionReason":"no","additionalContext":"add this","updatedInput":{"command":"x"}}}' },
      ],
    }, () => {})
    expect(output.decision).toBe('deny')
    expect(output.reason).toBe('no')
    expect(output.continue).toBe(false)
    expect(output.stopReason).toBe('halt')
    expect(output.systemMessage).toBe('watch out')
    expect(output.hookEventName).toBe('UserPromptSubmit')
    expect(output.additionalContext).toBe('add this')
    expect(output.updatedInput).toEqual({ command: 'x' })
  })

  it('treats a parse failure as an empty non-blocking output and debug-warns', () => {
    const debug = vi.fn()
    const { output, error } = contentToHookOutput({ stopReason: 'completed', content: [{ type: 'text', text: 'not json at all' }] }, debug)
    expect(error).toBeUndefined()
    expect(output.decision).toBeUndefined()
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('non-JSON'))
  })

  it('surfaces a stopReason of error as a non-blocking hook error', () => {
    const { output, error } = contentToHookOutput({ stopReason: 'error', content: [{ type: 'text', text: 'the subagent failed' }] }, () => {})
    expect(error).toEqual({ type: 'error', message: 'the subagent failed' })
    expect(output.decision).toBeUndefined()
  })
})

describe('interpolatePrompt (pure)', () => {
  it('replaces $ARGUMENTS with the JSON payload', () => {
    expect(interpolatePrompt('eval: $ARGUMENTS', { tool_name: 'bash' })).toBe('eval: {"tool_name":"bash"}')
  })

  it('appends the JSON payload when the template names no placeholder', () => {
    const out = interpolatePrompt('be strict', { a: 1 })
    expect(out).toBe('be strict\n\n{"a":1}')
  })
})

describe('hooks-claude-code bridge — prompt executor', () => {
  it('routes to subagents.start with the interpolated prompt and feeds the output back', async () => {
    const dir = writeConfig({
      UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'Evaluate: $ARGUMENTS', model: 'claude-haiku' }] }],
    })
    // The synthetic subagent decodes to an additionalContext the model must see.
    const { service, calls } = fakeSubagents({
      stopReason: 'completed',
      content: [{ type: 'text', text: '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"from the prompt hook"}}' }],
    })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(dir, adapter, { enablePromptHooks: true }, (c) => { c.provide('subagents', service as never) })
    const agent = await ctx.agentLoop.create(SessionId('exec-1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(calls).toHaveLength(1)
    // The payload JSON was interpolated into the $ARGUMENTS placeholder.
    expect(calls[0]!.request.prompt[0]!.text).toContain('Evaluate: {"')
    expect(calls[0]!.request.prompt[0]!.text).toContain('hook_event_name')
    // The decoded additionalContext reached the model request.
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('from the prompt hook')
  })

  it('is a warned no-op by default (disabled), preserving the old safe behavior', async () => {
    const dir = writeConfig({
      UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'eval', model: 'claude-haiku' }] }],
    })
    const { service, calls } = fakeSubagents({ stopReason: 'completed', content: [{ type: 'text', text: '{}' }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const warn = vi.fn()
    const ctx = await harness(dir, adapter, {}, (c) => { c.provide('subagents', service as never); c.logger.warn = warn as never })
    const agent = await ctx.agentLoop.create(SessionId('exec-disabled'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('prompt hook is disabled'))
  })

  it('degrades to a warned no-op when enabled but no subagents service is present', async () => {
    const dir = writeConfig({
      UserPromptSubmit: [{ hooks: [{ type: 'prompt', prompt: 'eval' }] }],
    })
    const adapter = new MockAdapter([textResponse('ok')])
    const warn = vi.fn()
    const ctx = await harness(dir, adapter, { enablePromptHooks: true }, (c) => { c.logger.warn = warn as never })
    const agent = await ctx.agentLoop.create(SessionId('exec-nosub'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot run (no subagents service or parent agent'))
  })
})

describe('hooks-claude-code bridge — model stamping (agentOptions)', () => {
  /** Fire one UserPromptSubmit prompt hook and return the recorded start calls. */
  async function firePromptHook(options: {
    hookModel?: string
    routes?: Record<string, { provider?: string; model?: string }>
  }): Promise<Array<{ name: string; request: Record<string, unknown> }>> {
    const hook = options.hookModel !== undefined ? { type: 'prompt', prompt: 'eval', model: options.hookModel } : { type: 'prompt', prompt: 'eval' }
    const dir = writeConfig({ UserPromptSubmit: [{ hooks: [hook] }] })
    const { service, calls } = fakeSubagents(okHookResult())
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(dir, adapter, { enablePromptHooks: true }, (c) => {
      c.provide('subagents', service as never)
      if (options.routes !== undefined) c.provide('ccModelRoutes', fakeRoutes(options.routes) as never)
    })
    const stampId = options.hookModel === undefined
      ? (options.routes === undefined ? 'exec-stamp-omitted-noroutes' : 'exec-stamp-omitted-haiku')
      : `exec-stamp-${options.hookModel}`
    const agent = await ctx.agentLoop.create(SessionId(stampId), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    return calls
  }

  it('stamps the haiku route when model is omitted and haiku is configured', async () => {
    const calls = await firePromptHook({ routes: { haiku: { provider: 'orchestrix', model: 'flash-1' } } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request['agentOptions']).toEqual({ provider: 'orchestrix', model: 'flash-1' })
  })

  it('omits agentOptions when model is omitted and no ccModelRoutes is mounted', async () => {
    const calls = await firePromptHook({})
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request['agentOptions']).toBeUndefined()
  })

  it('resolves an authored haiku alias through the resolver, never stamping the literal', async () => {
    const calls = await firePromptHook({ hookModel: 'haiku', routes: { haiku: { provider: 'p', model: 'flash-1' } } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request['agentOptions']).toEqual({ provider: 'p', model: 'flash-1' })
  })

  it('omits agentOptions for model: inherit', async () => {
    const calls = await firePromptHook({ hookModel: 'inherit', routes: { haiku: { provider: 'p', model: 'flash-1' } } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request['agentOptions']).toBeUndefined()
  })

  it('resolves model: opus to the opus route', async () => {
    const calls = await firePromptHook({ hookModel: 'opus', routes: { haiku: { provider: 'p', model: 'h' }, opus: { provider: 'z', model: 'glm' } } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request['agentOptions']).toEqual({ provider: 'z', model: 'glm' })
  })

  it('stamps an agent hook identically when model is omitted and haiku is configured', async () => {
    const dir = writeConfig({ PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'agent', prompt: 'Verify' }] }] })
    const { service, calls } = fakeSubagents(okHookResult())
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter, { enableAgentHooks: true }, (c) => {
      c.provide('subagents', service as never)
      c.provide('ccModelRoutes', fakeRoutes({ haiku: { provider: 'orchestrix', model: 'flash-1' } }) as never)
    })
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'raw' }] } }))
    const agent = await ctx.agentLoop.create(SessionId('exec-agent-stamp'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.request['agentOptions']).toEqual({ provider: 'orchestrix', model: 'flash-1' })
  })
})

describe('hooks-claude-code bridge — agent executor', () => {
  it('routes an agent hook to subagents.start under enableAgentHooks and feeds output back', async () => {
    const dir = writeConfig({
      PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'agent', prompt: 'Verify the tool output', model: 'claude-haiku' }] }],
    })
    const { service, calls } = fakeSubagents({
      stopReason: 'completed',
      content: [{ type: 'text', text: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"verification failed"}}' }],
    })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter, { enableAgentHooks: true }, (c) => { c.provide('subagents', service as never) })
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'raw' }] } }))
    const agent = await ctx.agentLoop.create(SessionId('exec-agent'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(calls).toHaveLength(1)
    expect(calls[0]!.request.prompt[0]!.text).toContain('Verify the tool output')
    // The decoded deny decision blocked the tool (verification subagent vetoed it).
    expect(ran).toBe(false)
    const result = [...agent.session.snapshotEvents()].find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
  })

  it('is a warned no-op by default when agent hooks are disabled', async () => {
    const dir = writeConfig({
      PreToolUse: [{ hooks: [{ type: 'agent', prompt: 'Verify' }] }],
    })
    const { service, calls } = fakeSubagents({ stopReason: 'completed', content: [{ type: 'text', text: '{}' }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const warn = vi.fn()
    const ctx = await harness(dir, adapter, {}, (c) => { c.provide('subagents', service as never); c.logger.warn = warn as never })
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'raw' }] } }))
    const agent = await ctx.agentLoop.create(SessionId('exec-agent-disabled'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(calls).toHaveLength(0)
    expect(ran).toBe(true) // the hook did not run, so the tool was not vetoed
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('agent hook is disabled'))
  })
})

