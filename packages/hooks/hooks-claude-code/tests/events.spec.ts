import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { defineContentToolFixture } from '@dsh-cc/tools'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'

/**
 * Full-loop tests for the expanded observe/interception event set (the 9 events
 * beyond the original 7) and the disabled-by-default prompt/agent executor
 * surface. Reuses the bridge.spec.ts harness: a real agent loop + real bash
 * executor + the REAL bridge, with the model mocked; hooks touch marker files so
 * the assertion is the side effect, polled to quiescence.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function subagentCarrier(ctx: Context) {
  return scopeTarget(ctx as unknown as SubagentRuntime, undefined)
}

/** Write a hooks.json with the given event→hooks map into a fresh temp dir. */
function writeConfig(hooks: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }))
  return dir
}

/** An executable hook script that touches `marker` then exits 0. */
function markerHook(dir: string, name: string, marker: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\ntouch "${marker}"\n`)
  chmodSync(path, 0o755)
  return path
}

async function harness(
  configDir: string,
  adapter: MockAdapter,
  beforeHooks?: (ctx: Context) => void,
): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  beforeHooks?.(ctx)
  await ctx.plugin(HooksClaude, { configPath: join(configDir, 'hooks.json') })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

describe('hooks-claude-code bridge — Setup (first-run approx)', () => {
  it('emits Setup adjacent to SessionStart for a brand-new (startup) session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const setupMarker = join(dir, 'setup-ran')
    const setup = markerHook(dir, 'setup.sh', setupMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { Setup: [{ hooks: [{ type: 'command', command: setup }] }] } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('setup-session'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await waitFor(() => existsSync(setupMarker))
    expect(existsSync(setupMarker)).toBe(true)
  })
})

describe('hooks-claude-code bridge — SessionEnd', () => {
  it('emits SessionEnd when a session is disposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const endMarker = join(dir, 'end-ran')
    const end = markerHook(dir, 'end.sh', endMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: end }] }] } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('end-session'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // Emit session/disposed directly (the store path is effect-tied); root
    // listeners observe it regardless of the session-scoped carrier.
    ctx.emit(ctx, 'session/disposed', agent.session)
    await waitFor(() => existsSync(endMarker))
    expect(existsSync(endMarker)).toBe(true)
  })
})

describe('hooks-claude-code bridge — Notification / PermissionDenied / PostCompact (session/event observers)', () => {
  it('tracks approval/decided rejected to a PermissionDenied hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const pdMarker = join(dir, 'pd-ran')
    const pd = markerHook(dir, 'pd.sh', pdMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PermissionDenied: [{ hooks: [{ type: 'command', command: pd }] }] } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('pd-session'), { provider: 'mock', model: 'mock' })
    // Synthesize the approval-decided rejection directly on the session log.
    agent.session.append('approval/decided', { id: 'req-1' as never, outcome: 'rejected' })
    await waitFor(() => existsSync(pdMarker))
    expect(existsSync(pdMarker)).toBe(true)
  })

  it('tracks an approval/asked to a Notification (permission_prompt) hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const notifMarker = join(dir, 'notif-ran')
    const notif = markerHook(dir, 'notif.sh', notifMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { Notification: [{ hooks: [{ type: 'command', command: notif }] }] } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('notif-session'), { provider: 'mock', model: 'mock' })
    agent.session.append('approval/asked', { id: 'req-1' as never, toolName: 'bash' })
    await waitFor(() => existsSync(notifMarker))
    expect(existsSync(notifMarker)).toBe(true)
  })

  it('tracks a compaction/end to a PostCompact hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const pcMarker = join(dir, 'pc-ran')
    const pc = markerHook(dir, 'pc.sh', pcMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PostCompact: [{ hooks: [{ type: 'command', command: pc }] }] } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('pc-session'), { provider: 'mock', model: 'mock' })
    agent.session.append('compaction/end' as never, {} as never)
    await waitFor(() => existsSync(pcMarker))
    expect(existsSync(pcMarker)).toBe(true)
  })
})

describe('hooks-claude-code bridge — PermissionRequest (interception)', () => {
  it('a PermissionRequest hook denying the request rejects the approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const deny = join(dir, 'deny.sh')
    writeFileSync(deny, '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"deny","permissionDecisionReason":"blocked by policy"}}\'\n')
    chmodSync(deny, 0o755)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      PermissionRequest: [{ hooks: [{ type: 'command', command: deny }] }],
    } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter, (c) => { void c.plugin(ApprovalService) })
    const agent = ctx.agentLoop.create(SessionId('perm-session'), { provider: 'mock', model: 'mock' })
    // The approval audit pair must be turn-enclosed; open a turn first.
    agent.session.append('turn/start', { turn: 1 })
    const outcome = await ctx.approval.request({ agent, toolName: 'bash' })
    expect(outcome).toBe('rejected')
  })

  it('a PermissionRequest hook with no decision delegates to the answerer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const pass = markerHook(dir, 'pass.sh', join(dir, 'pass-ran'))
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      PermissionRequest: [{ hooks: [{ type: 'command', command: pass }] }],
    } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter, (c) => { void c.plugin(ApprovalService) })
    // A downstream answerer that the mid-chain hook must delegate to via `next()`.
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const agent = ctx.agentLoop.create(SessionId('perm-pass-session'), { provider: 'mock', model: 'mock' })
    // The approval audit pair must be turn-enclosed; open a turn first.
    agent.session.append('turn/start', { turn: 1 })
    const outcome = await ctx.approval.request({ agent, toolName: 'bash' })
    expect(outcome).toBe('allowed-once')
  })
})

describe('hooks-claude-code bridge — StopFailure', () => {
  it('maps an agent/error to a StopFailure hook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const sfMarker = join(dir, 'sf-ran')
    const sf = markerHook(dir, 'sf.sh', sfMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { StopFailure: [{ hooks: [{ type: 'command', command: sf }] }] } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('sf-session'), { provider: 'mock', model: 'mock' })
    ctx.emit(ctx, 'agent/error', { agent, turn: 1, step: 0, error: new Error('rate limit exceeded') })
    await waitFor(() => existsSync(sfMarker))
    expect(existsSync(sfMarker)).toBe(true)
  })
})

describe('hooks-claude-code bridge — TaskCreated (jobs diff)', () => {
  it('emits TaskCreated once per newly-appeared job', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const tdMarker = join(dir, 'td-ran')
    const td = markerHook(dir, 'td.sh', tdMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { TaskCreated: [{ hooks: [{ type: 'command', command: td }] }] } }))

    // A minimal jobs registry fake exposed via `ctx.get('jobs')`; the bridge
    // subscribes to its onJobsChanged and diffs list() snapshots.
    const jobs: { ids: Set<string>; listeners: Array<(owner?: unknown) => void> } = {
      ids: new Set(),
      listeners: [],
      list() { return [...this.ids].map(id => ({ id, label: `task ${id}` })) },
      onJobsChanged(fn: (owner?: unknown) => void) { this.listeners.push(fn); return () => {} },
    }
    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter, (c) => { c.provide('jobs', jobs as never) })
    const agent = ctx.agentLoop.create(SessionId('td-session'), { provider: 'mock', model: 'mock' })
    // A brand-new job appears → the registered onJobsChanged listener fires.
    jobs.ids.add('task-1')
    for (const l of jobs.listeners) l(undefined)
    await waitFor(() => existsSync(tdMarker))
    expect(existsSync(tdMarker)).toBe(true)
  })
})

describe('hooks-claude-code bridge — PostToolUseFailure', () => {
  it('fires PostToolUseFailure when a tool result is an error (isError=true)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const ptuMarker = join(dir, 'ptu-fail-ran')
    const ptu = markerHook(dir, 'ptu-fail.sh', ptuMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PostToolUseFailure: [{ hooks: [{ type: 'command', command: ptu }] }] } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'boom', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'boom', description: 'b', parameters: {}, async execute() { throw new Error('kaput') } }))
    const agent = ctx.agentLoop.create(SessionId('ptu-session'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitFor(() => existsSync(ptuMarker))
    expect(existsSync(ptuMarker)).toBe(true)
  })

  it('does NOT fire PostToolUseFailure when the tool succeeds (isError=false)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const ptuMarker = join(dir, 'ptu-ok-ran')
    const ptu = markerHook(dir, 'ptu-ok.sh', ptuMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { PostToolUseFailure: [{ hooks: [{ type: 'command', command: ptu }] }] } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(SessionId('ptu-ok-session'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await new Promise(r => setTimeout(r, 150))
    expect(existsSync(ptuMarker)).toBe(false)
  })

  it('PostToolUse still fires on success while PostToolUseFailure does not (no regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const ptuMarker = join(dir, 'ptu-ran')
    const ptuFailMarker = join(dir, 'ptu-fail-ran')
    const ptu = markerHook(dir, 'ptu.sh', ptuMarker)
    const ptuFail = markerHook(dir, 'ptu-fail.sh', ptuFailMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      PostToolUse: [{ hooks: [{ type: 'command', command: ptu }] }],
      PostToolUseFailure: [{ hooks: [{ type: 'command', command: ptuFail }] }],
    } }))

    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(dir, adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(SessionId('ptu-reg-session'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await waitFor(() => existsSync(ptuMarker))
    expect(existsSync(ptuMarker)).toBe(true)
    expect(existsSync(ptuFailMarker)).toBe(false)
  })
})

describe('hooks-claude-code bridge — SessionResume', () => {
  it('fires SessionResume when agent/session-start has source=resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const srMarker = join(dir, 'sr-ran')
    const sr = markerHook(dir, 'sr.sh', srMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { SessionResume: [{ hooks: [{ type: 'command', command: sr }] }] } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('sr-session'), { provider: 'mock', model: 'mock' })
    ctx.emit(ctx, 'agent/session-start', { agent, source: 'resume' })
    await waitFor(() => existsSync(srMarker))
    expect(existsSync(srMarker)).toBe(true)
  })

  it('does NOT fire SessionResume when source is startup (Setup still fires)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const srMarker = join(dir, 'sr-startup-ran')
    const setupMarker = join(dir, 'setup-ran')
    const sr = markerHook(dir, 'sr.sh', srMarker)
    const setup = markerHook(dir, 'setup.sh', setupMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
      SessionResume: [{ hooks: [{ type: 'command', command: sr }] }],
      Setup: [{ hooks: [{ type: 'command', command: setup }] }],
    } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('sr-startup-session'), { provider: 'mock', model: 'mock' })
    ctx.emit(ctx, 'agent/session-start', { agent, source: 'startup' })
    await waitFor(() => existsSync(setupMarker))
    expect(existsSync(setupMarker)).toBe(true)
    expect(existsSync(srMarker)).toBe(false)
  })
})

describe('hooks-claude-code bridge — TeammateIdle', () => {
  it('fires TeammateIdle only for agents seen as subagents transitioning to idle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const tiMarker = join(dir, 'ti-ran')
    const ti = markerHook(dir, 'ti.sh', tiMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { TeammateIdle: [{ hooks: [{ type: 'command', command: ti }] }] } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('team-session'), { provider: 'mock', model: 'mock' })
    // Mark the agent as a subagent via subagent/start, then flip it to idle.
    ctx.emit(subagentCarrier(ctx), 'subagent/start', { runId: SubagentRunId('run-1'), provider: 'inproc', id: SessionId('team-session'), local: false })
    ctx.emit(ctx, 'agent/status', { agent, status: 'idle' })
    await waitFor(() => existsSync(tiMarker))
    expect(existsSync(tiMarker)).toBe(true)
  })

  it('does NOT fire TeammateIdle for a root agent never seen as a subagent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-claude-events-'))
    dirs.push(dir)
    const tiMarker = join(dir, 'ti-root-ran')
    const ti = markerHook(dir, 'ti.sh', tiMarker)
    writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: { TeammateIdle: [{ hooks: [{ type: 'command', command: ti }] }] } }))

    const adapter = new MockAdapter([])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('root-only-session'), { provider: 'mock', model: 'mock' })
    ctx.emit(ctx, 'agent/status', { agent, status: 'idle' })
    // Root listener fires, but the hook must NOT run because the agent is not a subagent.
    await new Promise(r => setTimeout(r, 100))
    expect(existsSync(tiMarker)).toBe(false)
  })
})


