import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@dsh-cc/tools'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { MockAdapter, toolCallResponse, textResponse } from '@dsh-cc/agent-loop-mock'

/**
 * The plugin hooks seam (plan docs/plans/2026-09-08-plugin-hooks-seam.md): the
 * bridge provides the `hooks` guest seam from @dsh-cc/plugin-loader, merging a
 * plugin's Claude Code hooks into the SAME runPoint as the boot config.
 * Covers the unconditional provide (even with no boot config), the
 * ${CLAUDE_PLUGIN_ROOT} substitution, the copy-on-write disposer, and the
 * never-throw behavior on a malformed plugin config.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-plugin-hooks-seam-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

/** The `hooks` seam shape the bridge provides (structural, like the loader's contract). */
interface HooksSeam {
  mergePluginHooks(pluginName: string, config: unknown, pluginRoot?: string): () => void
}

/** Mount the bridge (optionally with a boot configPath) and return (ctx, seam). */
async function mountBridge(configPath: string | undefined, adapter: MockAdapter): Promise<{ ctx: Context; seam: HooksSeam }> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, configPath !== undefined ? { configPath } : {})
  ctx.llm.registerAdapter(['mock'], adapter)
  const seam = ctx.get('hooks')
  expect(seam).toBeDefined()
  return { ctx, seam: seam as HooksSeam }
}

/** Run one `echo` tool execution through a real agent loop; observe the folded decision. */
async function driveToolCall(ctx: Context, adapter: MockAdapter): Promise<{ ran: boolean; denied: boolean }> {
  let ran = false
  ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
  let denied = false
  ctx.on('tools/pre-execute', async (_exec, next) => {
    const decision = await next()
    if (decision.kind === 'deny') denied = true
    return decision
  })
  const agent: Agent = ctx.agentLoop.create(SessionId('seam'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  return { ran, denied }
}

describe('plugin hooks seam', () => {
  it('is provided even with NO boot config; a merged hook still fires', async () => {
    const d = dir()
    const marker = join(d, 'fired')
    const stub = sh(d, 'h.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`)
    // configPath points at a nonexistent file: the boot config fails to read,
    // yet the seam must still exist and merged hooks must still run.
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const { ctx, seam } = await mountBridge(join(d, 'no-such-hooks.json'), adapter)
    seam.mergePluginHooks('p1', { PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: stub }] }] })
    await driveToolCall(ctx, adapter)
    // The merged hook actually ran (marker touched) despite the failed boot config.
    await waitFor(() => existsSync(marker))
  })

  it('merges a PreToolUse command hook that blocks the tool (decision folding)', async () => {
    const d = dir()
    const stub = sh(d, 'block.sh', `#!/usr/bin/env bash\necho '{"decision":"block","reason":"x"}'\n`)
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const { ctx, seam } = await mountBridge(undefined, adapter)
    seam.mergePluginHooks('p1', { PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: stub }] }] })
    const { ran } = await driveToolCall(ctx, adapter)
    expect(ran).toBe(false)
  })

  it('substitutes ${CLAUDE_PLUGIN_ROOT} in the command with the passed pluginRoot', async () => {
    const d = dir()
    // The stub lives under a FAKE plugin root: unsubstituted, the command
    // would try to spawn the literal path and fail (no block at all).
    const pluginRoot = join(d, 'fake-plugin')
    mkdirSync(pluginRoot, { recursive: true })
    sh(pluginRoot, 'block.sh', `#!/usr/bin/env bash\necho '{"decision":"block","reason":"root"}'\n`)
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const { ctx, seam } = await mountBridge(undefined, adapter)
    seam.mergePluginHooks('p1', { PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/block.sh' }] }] }, pluginRoot)
    const { ran } = await driveToolCall(ctx, adapter)
    expect(ran).toBe(false)
  })

  it('disposer removes exactly the merged groups (copy-on-write: A gone, B still firing)', async () => {
    const d = dir()
    // A touches a marker (observable), B blocks (observable via the fold).
    const marker = join(d, 'a-fired')
    const stubA = sh(d, 'a.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`)
    const blockB = sh(d, 'block-b.sh', `#!/usr/bin/env bash\necho '{"decision":"block","reason":"b"}'\n`)
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const { ctx, seam } = await mountBridge(undefined, adapter)
    const disposeA = seam.mergePluginHooks('pa', { PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: stubA }] }] })
    seam.mergePluginHooks('pb', { PreToolUse: [{ matcher: 'echo', hooks: [{ type: 'command', command: blockB }] }] })
    disposeA()
    const { ran } = await driveToolCall(ctx, adapter)
    // B still fires after A's disposer ran.
    expect(ran).toBe(false)
    // A no longer fires: give a pending dispatch time to settle, then check.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(existsSync(marker)).toBe(false)
  })

  it('warns and returns a no-op disposer (never throws) on malformed plugin config', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, seam } = await mountBridge(undefined, adapter)
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    // An invalid matcher regex makes parseClaudeCodeConfig throw.
    const dispose = seam.mergePluginHooks('bad', { PreToolUse: [{ matcher: '([unclosed', hooks: [{ type: 'command', command: 'echo' }] }] })
    expect(dispose).toBeTypeOf('function')
    expect(() => dispose()).not.toThrow()
    expect(warn.mock.calls.some(args => String(args[0]).includes('plugin "bad"'))).toBe(true)
  })
})
