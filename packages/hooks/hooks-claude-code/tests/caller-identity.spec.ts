/**
 * Caller-identity payload fields (`agent_id` + constant `agent_type`) for LIVE
 * subagent callers (the start/end live set — see register-events.ts). A stdin-
 * capturing command hook appends each payload as a JSON line to a marker file,
 * so the exact field SET of each payload is assertable (the field-set goldens
 * nothing pinned before). Reuses the events.spec.ts harness shape: a real
 * agent loop + real bash executor + the REAL bridge, model mocked. Agents are
 * created FIRST (one session id each, no store collisions), and `subagent/start`
 * is then emitted for an existing agent's own session id — the same order the
 * TeammateIdle spec uses.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { defineContentToolFixture } from '@dsh-cc/tools'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function subagentCarrier(ctx: Context) {
  return scopeTarget(ctx as unknown as SubagentRuntime, undefined)
}

async function waitFor(predicate: () => boolean, timeout = 20_000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

/** A command hook that appends its stdin payload as one JSON line to `marker`. */
function capturingHook(dir: string, name: string, marker: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\ncat >> "${marker}"\necho >> "${marker}"\n`)
  chmodSync(path, 0o755)
  return path
}

async function harness(configDir: string, adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath: join(configDir, 'hooks.json') })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function payloads(marker: string): Array<Record<string, unknown>> {
  if (!existsSync(marker)) return []
  return readFileSync(marker, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
}

function startEvent(id: string, runId = 'run-1') {
  return { runId: SubagentRunId(runId), provider: 'inproc', id: SessionId(id), local: false }
}

function echoTool(ctx: Context): void {
  ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
}

async function runTool(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

describe('hooks-claude-code — caller-identity fields on live subagent payloads', () => {
  it('PreToolUse payload carries agent_id + agent_type exactly when the caller id is in the live set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-identity-'))
    dirs.push(dir)
    const marker = join(dir, 'payloads')
    const pre = capturingHook(dir, 'pre.sh', marker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: pre }] }],
    } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done'), toolCallResponse('c2', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    echoTool(ctx)
    // Create BOTH agents up front (distinct session ids, no store collision),
    // then mark the child as a live subagent via its own start event.
    const main = await ctx.agentLoop.create(SessionId('main-session'), { provider: 'mock', model: 'mock' })
    const child = await ctx.agentLoop.create(SessionId('child-session'), { provider: 'mock', model: 'mock' })

    await runTool(main)
    await waitFor(() => payloads(marker).length >= 1)
    expect(payloads(marker)).toHaveLength(1)
    expect(payloads(marker)[0]).not.toHaveProperty('agent_id')
    expect(payloads(marker)[0]).not.toHaveProperty('agent_type')

    ctx.emit(subagentCarrier(ctx), 'subagent/start', startEvent(String(child.session.header.id)))
    await runTool(child)
    await waitFor(() => payloads(marker).length >= 2)
    const sub = payloads(marker)[1]!
    expect(sub.agent_id).toBe(String(child.session.header.id))
    expect(sub.agent_type).toBe('general-purpose')
  })

  it('field-set goldens: exact key set of a PreToolUse payload for a main agent and a live subagent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-identity-'))
    dirs.push(dir)
    const marker = join(dir, 'payloads')
    const pre = capturingHook(dir, 'pre.sh', marker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: pre }] }],
    } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done'), toolCallResponse('c2', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    echoTool(ctx)
    const main = await ctx.agentLoop.create(SessionId('main-session'), { provider: 'mock', model: 'mock' })
    const child = await ctx.agentLoop.create(SessionId('child-session'), { provider: 'mock', model: 'mock' })

    await runTool(main)
    ctx.emit(subagentCarrier(ctx), 'subagent/start', startEvent(String(child.session.header.id)))
    await runTool(child)
    await waitFor(() => payloads(marker).length >= 2)

    const [mainPayload, childPayload] = payloads(marker)
    expect(Object.keys(mainPayload!).sort()).toEqual(['cwd', 'hook_event_name', 'session_id', 'tool_input', 'tool_name', 'tool_use_id', 'transcript_path'])
    expect(Object.keys(childPayload!).sort()).toEqual(['agent_id', 'agent_type', 'cwd', 'hook_event_name', 'session_id', 'tool_input', 'tool_name', 'tool_use_id', 'transcript_path'])
  })

  it('live-set lifecycle: end deletes the id — the same session resumed as top-level emits NO fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-identity-'))
    dirs.push(dir)
    const marker = join(dir, 'payloads')
    const pre = capturingHook(dir, 'pre.sh', marker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: pre }] }],
    } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done'), toolCallResponse('c2', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    echoTool(ctx)
    const agent = await ctx.agentLoop.create(SessionId('resumed-child'), { provider: 'mock', model: 'mock' })

    // Start → tool call carries fields.
    ctx.emit(subagentCarrier(ctx), 'subagent/start', startEvent(String(agent.session.header.id)))
    await runTool(agent)
    await waitFor(() => payloads(marker).length >= 1)
    expect(payloads(marker)[0]).toHaveProperty('agent_id', String(agent.session.header.id))

    // End → the id leaves the live set; a same-id session acting as top-level is gated again.
    ctx.emit(subagentCarrier(ctx), 'subagent/end', startEvent(String(agent.session.header.id)))
    await runTool(agent)
    await waitFor(() => payloads(marker).length >= 2)
    expect(payloads(marker)[1]).not.toHaveProperty('agent_id')
    expect(payloads(marker)[1]).not.toHaveProperty('agent_type')
  })

  it('start precedes the first PreToolUse: the first tool payload of a child already carries agent_id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-identity-'))
    dirs.push(dir)
    const marker = join(dir, 'payloads')
    const startHook = capturingHook(dir, 'start.sh', marker)
    const pre = capturingHook(dir, 'pre.sh', marker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      SubagentStart: [{ hooks: [{ type: 'command', command: startHook }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: pre }] }],
    } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    echoTool(ctx)
    const child = await ctx.agentLoop.create(SessionId('ordered-child'), { provider: 'mock', model: 'mock' })

    ctx.emit(subagentCarrier(ctx), 'subagent/start', startEvent(String(child.session.header.id)))
    await runTool(child)
    await waitFor(() => payloads(marker).length >= 2)
    // Order in the marker file IS the process order: SubagentStart first.
    expect(payloads(marker)[0]).toMatchObject({ hook_event_name: 'SubagentStart', agent_id: String(child.session.header.id) })
    expect(payloads(marker)[1]).toMatchObject({ hook_event_name: 'PreToolUse', agent_id: String(child.session.header.id) })
    // And the identity is equal across the two payloads for the same child.
    expect(payloads(marker)[1]!.agent_id).toBe(payloads(marker)[0]!.agent_id)
  })

  it('a grandchild (depth 2) caller also carries the identity fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-identity-'))
    dirs.push(dir)
    const marker = join(dir, 'payloads')
    const pre = capturingHook(dir, 'pre.sh', marker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: pre }] }],
    } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    echoTool(ctx)
    const grandchild = await ctx.agentLoop.create(SessionId('grandchild-session'), { provider: 'mock', model: 'mock' })

    // Grandchild start (nested run epoch) before its first tool call.
    ctx.emit(subagentCarrier(ctx), 'subagent/start', startEvent(String(grandchild.session.header.id), 'run-gc'))
    await runTool(grandchild)
    await waitFor(() => payloads(marker).length >= 1)
    expect(payloads(marker)[0]).toMatchObject({ agent_id: String(grandchild.session.header.id), agent_type: 'general-purpose' })
  })
})
