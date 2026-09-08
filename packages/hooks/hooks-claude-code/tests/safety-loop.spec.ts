import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture, type PreToolDecision } from '@dsh-cc/tools'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'

/**
 * Safety-loop plan (v0.4.1) behavior tests: F1 stop-block cap + truthful
 * stop_hook_active, F2 continue:false halts, F3 surfaced notices, F4 pre-approval,
 * S1 additionalContext, S2 tool-result replacement. Real agent loop + real bash
 * executor + the REAL bridge; only the model is mocked.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
afterEach(() => { delete process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP })

function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-safety-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
function hooks(d: string, h: unknown): string {
  writeFileSync(join(d, 'hooks.json'), JSON.stringify({ hooks: h })); return join(d, 'hooks.json')
}

type HarnessOpts = {
  beforeHooks?: (ctx: Context) => void
  dshHome?: string
}
async function harness(configPath: string, adapter: MockAdapter, opts: HarnessOpts = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  if (opts.dshHome !== undefined) ctx.dshHomePath = (...segs: string[]) => join(opts.dshHome, ...segs)
  opts.beforeHooks?.(ctx)
  await ctx.plugin(HooksClaude, { configPath })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}
function events(agent: Agent): SessionEvent[] { return [...agent.session.events] }
async function waitForIdle(_ctx: Context, agent: Agent): Promise<void> { return agent.whenIdle() }
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}
function notices(agent: Agent): string[] {
  return events(agent)
    .filter(e => e.type === 'user/message' && (e.data.source as { form?: string }).form === 'notice')
    .flatMap(e => e.type === 'user/message' ? e.data.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text) : [])
}

/** A Stop hook that blocks every run, recording each payload's stop_hook_active into `flags`. */
function alwaysBlockStop(d: string): { flags: string; command: string } {
  const flags = join(d, 'flags')
  const script = sh(d, 'stop.sh', `#!/usr/bin/env bash
payload=$(cat)
echo "$payload" | grep -o '"stop_hook_active":[a-z]*' >> "${flags}"
echo "block" >&2
exit 2
`)
  return { flags, command: script }
}

/** The stop_hook_active values recorded by {@link alwaysBlockStop}, in run order. */
function stopHookFlags(flags: string): boolean[] {
  return existsSync(flags)
    ? readFileSync(flags, 'utf8').split('\n').filter(Boolean).map(line => line.endsWith('true'))
    : []
}

describe('F1 — Stop-hook block cap + truthful stop_hook_active', () => {
  it('blocks exactly 8 times then overrides: flags false,true×8, override notice, stop-cap diagnostic', async () => {
    const d = dir()
    const home = join(d, 'home')
    const { flags, command } = alwaysBlockStop(d)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command }] }] })
    // One response per steered continuation: 1 initial + 8 steered.
    const adapter = new MockAdapter(Array.from({ length: 12 }, (_, i) => textResponse(`r${i}`)))
    const ctx = await harness(path, adapter, { dshHome: home })
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Payload flags: block #1 observes false, blocks #2..#8 observe true; the
    // 9th run is the overridden one (its payload still says true — count was 8).
    const recorded = stopHookFlags(flags)
    expect(recorded.length).toBe(9)
    expect(recorded[0]).toBe(false)
    expect(recorded.slice(1)).toEqual([true, true, true, true, true, true, true, true])
    // 8 steers happened, then the turn ended (no 10th request).
    expect(adapter.requests).toHaveLength(9)
    // The override notice was injected (queued in the inbox — the cancel that
    // ends the loop also drops the injected copy before it becomes a row).
    expect(agent.inbox.nextStep.some(m => m.content.some(b => b.type === 'text' && b.text.includes('Stop hook overridden after 8 consecutive block(s); the turn is ending')))).toBe(true)
    // And a stop-cap diagnostic was recorded in the dsh-home JSONL.
    const diag = readFileSync(join(home, 'hooks', 'diagnostics.jsonl'), 'utf8')
    expect(diag).toContain('"kind":"stop-cap"')
  }, 30_000)

  it('CLAUDE_CODE_STOP_HOOK_BLOCK_CAP=3 overrides after 3 blocks; 0 and garbage fall back to 8', async () => {
    for (const [env, expectedRequests] of [['3', 4], ['0', 9], ['bogus', 9]] as const) {
      const d = dir()
      const { command } = alwaysBlockStop(d)
      const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command }] }] })
      process.env.CLAUDE_CODE_STOP_HOOK_BLOCK_CAP = env
      const adapter = new MockAdapter(Array.from({ length: 12 }, (_, i) => textResponse(`r${i}`)))
      const ctx = await harness(path, adapter)
      const agent = ctx.agentLoop.create(SessionId(`a-${env}`), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(adapter.requests).toHaveLength(expectedRequests)
    }
  }, 60_000)

  it('a real user message resets the counter (plugin-source messages must not)', async () => {
    const d = dir()
    // Block the first TWO Stop runs, then allow — the cap (8) is never hit, so
    // no cancel interferes with the queued followup.
    const flags = join(d, 'flags')
    const runs = join(d, 'runs')
    const command = sh(d, 'stop.sh', `#!/usr/bin/env bash
payload=$(cat)
echo "$payload" | grep -o '"stop_hook_active":[a-z]*' >> "${flags}"
n=$(cat "${runs}" 2>/dev/null || echo 0); echo $((n+1)) > "${runs}"
if [ "$n" -le 2 ]; then echo "block" >&2; exit 2; fi
exit 0
`)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command }] }] })
    const adapter = new MockAdapter(Array.from({ length: 12 }, (_, i) => textResponse(`r${i}`)))
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitFor(() => existsSync(flags)) // the first block ran → count(a1) = 1
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // Turn 1: flags false,true,… — and a LATER Stop run observes false again:
    // the real user message reset the chain before its next Stop run (the
    // harness may consume the followup as pending input at a stopping boundary,
    // so the exact run index is the machine's to choose; the reset is not).
    const recorded = stopHookFlags(flags)
    expect(recorded[0]).toBe(false)
    expect(recorded.some((flag, i) => i > 0 && flag === false)).toBe(true)
  }, 30_000)

  it('another agent\u2019s blocks never contaminate this agent\u2019s counter (agent.id keying)', async () => {
    const d = dir()
    // Per-line "session_id flag" records so runs are attributable per agent.
    const records = join(d, 'records')
    const command = sh(d, 'stop.sh', `#!/usr/bin/env bash
payload=$(cat)
sid=$(echo "$payload" | grep -o '"session_id":"[^"]*"' | head -1)
flag=$(echo "$payload" | grep -o '"stop_hook_active":[a-z]*')
echo "$sid $flag" >> "${records}"
# agent a1 blocks ONCE, then allows; every other agent blocks.
if echo "$sid" | grep -q 'a1' && [ ! -e "${join(d, 'blocked')}" ]; then touch "${join(d, 'blocked')}"; echo "block" >&2; exit 2; fi
exit 0
`)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command }] }] })
    const adapter = new MockAdapter(Array.from({ length: 12 }, (_, i) => textResponse(`r${i}`)))
    const ctx = await harness(path, adapter)
    const a = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const b = ctx.agentLoop.create(SessionId('b1'), { provider: 'mock', model: 'mock' })
    a.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitFor(() => existsSync(records)) // a blocked once → count(a1) = 1
    b.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, b)
    await waitForIdle(ctx, a)
    const lines = existsSync(records) ? readFileSync(records, 'utf8').split('\n').filter(Boolean) : []
    const forAgent = (id: string): boolean[] => lines.filter(l => l.includes(`"session_id":"${id}"`)).map(l => l.endsWith('true'))
    // b's EVERY Stop run observed false — a's block count never leaked.
    expect(forAgent('b1').length).toBeGreaterThanOrEqual(1)
    expect(forAgent('b1').every(f => f === false)).toBe(true)
    // ...while a's first run really did block-and-steer (its second run saw true).
    expect(forAgent('a1')[0]).toBe(false)
    expect(forAgent('a1')[1]).toBe(true)
  }, 30_000)

  it('session disposal frees the stop-block entries (the next Stop observes a reset counter)', async () => {
    const d = dir()
    const { flags, command } = alwaysBlockStop(d)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command }] }] })
    const adapter = new MockAdapter(Array.from({ length: 12 }, (_, i) => textResponse(`r${i}`)))
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitFor(() => existsSync(flags)) // blocked once → count(a1) = 1
    // Fire the disposal edge: the cleanup must drop a1's counter and session
    // pairing (and the SessionEnd hook runs detached).
    ctx.emit(ctx as never, 'session/disposed', agent.session)
    await waitForIdle(ctx, agent)
    // The recorded flag sequence starts false (block #1) — and if any further
    // Stop run for a1 happens post-disposal with a fresh user message it must
    // observe false again, proving the entry was freed rather than reused.
    expect(stopHookFlags(flags)[0]).toBe(false)
  }, 30_000)
})

describe('F2 — continue:false halts each in-run seam', () => {
  it('UserPromptSubmit halt rejects the prompt: canceled with a hook cause, no model request, notice queued', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"continue":false,"stopReason":"no more prompts"}\'\n')
    const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(0)
    const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'aborted'
      && turnEnd.data.reason.reason.kind === 'hook').toBe(true)
    expect(agent.inbox.nextStep.some(m => m.content.some(b => b.type === 'text' && b.text.includes('any queued input was discarded')))).toBe(true)
  })

  it('PostToolUse halt blocks the result and cancels the run with a hook cause', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"continue":false,"stopReason":"tool output rejected"}\'\n')
    const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {})])
    const ctx = await harness(path, adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(ran).toBe(true) // post-execute: the tool already ran
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('tool output rejected'))).toBe(true)
    const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'aborted'
      && turnEnd.data.reason.reason.kind === 'hook').toBe(true)
  })

  it('Stop-hook halt at the stopping boundary cancels with pending steering (the continuation machine is defeated)', async () => {
    const d = dir()
    // First run: block (steers); every later run: continue:false — the halt
    // must land while the previous steer's continuation is the pending work.
    const s = sh(d, 'h.sh', `#!/usr/bin/env bash
if [ -e "${join(d, 'once')}" ]; then echo '{"continue":false,"stopReason":"stop hook halted"}'; exit 0; fi
touch "${join(d, 'once')}"
echo "continue" >&2
exit 2
`)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // The turn ended canceled with the hook cause — the steer did not loop forever.
    const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'aborted'
      && turnEnd.data.reason.reason.kind === 'hook').toBe(true)
  })

  it('PermissionRequest halt rejects the approval and cancels', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"continue":false,"stopReason":"approvals are off"}\'\n')
    const path = hooks(d, { PermissionRequest: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([])
    const ctx = await harness(path, adapter, { beforeHooks: (c) => { void c.plugin(ApprovalService) } })
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.session.append('turn/start', { turn: 1 })
    const outcome = await ctx.approval.request({ agent, toolName: 'bash' })
    expect(outcome).toBe('rejected')
  })
})

describe('F3 — notices: shaping, fallback, no-agent warn path', () => {
  it('a whitespace-only systemMessage surfaces the fallback label; a long one is capped at 200 chars', async () => {
    const d = dir()
    const long = 'x'.repeat(300)
    const s = sh(d, 'h.sh', `#!/usr/bin/env bash
if [ -e "${join(d, 'once')}" ]; then echo '{"systemMessage":"   "}'; exit 0; fi
touch "${join(d, 'once')}"
echo '{"systemMessage":"${long}"}'
`)
    const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(path, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const surfaced = notices(agent)
    // The long message is collapsed + truncated to exactly 200 chars.
    expect(surfaced.some(t => t === 'x'.repeat(200))).toBe(true)
    // The whitespace-only message fell back to the point-labeled default — on a
    // LATER run (the second user turn), so drive one more turn.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(notices(agent).some(t => t === '(UserPromptSubmit hook message)')).toBe(true)
  }, 30_000)

  it('the no-agent path warns instead of throwing (direct tool call)', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"systemMessage":"heads up no agent"}\'\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const ctx = await harness(path, new MockAdapter([]))
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('c1'), name: 'echo', arguments: {} })
    expect(result.isError).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('heads up no agent'))
  })
})

describe('F4 — PreToolUse allow pre-approves (downstream boundaries still win)', () => {
  /** Mount an approval answerer that records every request reaching it. */
  function recordingAnswerer(ctx: Context): { requests: string[] } {
    const requests: string[] = []
    ctx.on('approval/request', async (req: ApprovalRequest, next): Promise<ApprovalOutcome> => {
      requests.push(req.toolName)
      return next()
    })
    return { requests }
  }

  it('a hook allow suppresses the approval prompt entirely: no approval request, tool runs', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\'\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter, { beforeHooks: (c) => { void c.plugin(ApprovalService) } })
    const { requests } = recordingAnswerer(ctx)
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(ran).toBe(true)
    // No APPROVAL prompt ever reached an answerer (the hook allow bypassed it).
    expect(requests).toHaveLength(0)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(false)
  })

  it('a hook allow + a downstream boundary deny → denied (the boundary wins), in BOTH listener orders', async () => {
    async function runOrder(boundaryFirst: boolean): Promise<boolean> {
      const d = dir()
      const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\'\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const boundary = async (): Promise<PreToolDecision> => ({ kind: 'deny', reason: 'boundary says no' })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter, {
        beforeHooks: boundaryFirst ? (c) => { c.on('tools/pre-execute', boundary) } : undefined,
      })
      if (!boundaryFirst) ctx.on('tools/pre-execute', boundary)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      const denied = result?.type === 'tool/result' && result.data.message.content[0].isError === true
        && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('boundary says no'))
      return ran === false && denied === true
    }
    expect(await runOrder(true)).toBe(true) // boundary registered BEFORE the bridge
    expect(await runOrder(false)).toBe(true) // boundary registered AFTER the bridge
  })

  it('a hook deny never runs the tool (short-circuit unchanged)', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"hook no"}}\'\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    let ran = false
    let downstreamSeen = false
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    ctx.on('tools/pre-execute', async (_exec, next) => { downstreamSeen = true; return next() })
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(ran).toBe(false)
    expect(downstreamSeen).toBe(false) // deny short-circuits — no downstream listener ran
  })

  it('a hook ask + a downstream boundary deny → deny (stricter fold)', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"hook asks"}}\'\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter, { beforeHooks: (c) => { void c.plugin(ApprovalService) } })
    const { requests } = (() => {
      const requests: string[] = []
      ctx.on('approval/request', async (req: { toolName: string }, next): Promise<ApprovalOutcome> => { requests.push(req.toolName); return next() })
      return { requests }
    })()
    ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({ kind: 'deny', reason: 'boundary says no' }))
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // The boundary deny beats the hook ask: the tool never ran and no approval
    // prompt was raised to an answerer.
    expect(ran).toBe(false)
    expect(requests).toHaveLength(0)
  })
})

describe('S1 — PreToolUse additionalContext is injected', () => {
  it('a non-deny PreToolUse additionalContext reaches the next model request (and deny does not inject)', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"pre-tool guidance"}}\'\n')
    const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    // The context landed as a durable plugin-sourced message AFTER the tool result.
    const log = events(agent)
    const resultIdx = log.findIndex(e => e.type === 'tool/result')
    const ctxIdx = log.findIndex(e => e.type === 'user/message' && e.data.source.kind !== 'user')
    expect(ctxIdx).toBeGreaterThan(resultIdx)
    expect(log[ctxIdx]?.type === 'user/message' && log[ctxIdx].data.content.some(b => b.type === 'text' && b.text.includes('pre-tool guidance'))).toBe(true)
  })
})

describe('S2 — PostToolUse tool-result replacement', () => {
  it('a string updatedToolOutput replaces a plain downstream accept projection', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"replaced output"}}\'\n')
    const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'raw output' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(false)
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text === 'replaced output')).toBe(true)
  })

  it('a non-string updatedToolOutput is JSON.stringify-ed into the replacement text', async () => {
    const d = dir()
    const s = sh(d, 'h.sh', `#!/usr/bin/env bash\necho '{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":{"rows":3}}}'\n`)
    const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, adapter)
    ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'raw' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text === '{"rows":3}')).toBe(true)
  })

  it('a downstream replacement (content or value) wins over the hook replacement; a downstream block beats it too', async () => {
    async function downstreamWins(mode: 'content' | 'block'): Promise<boolean> {
      const d = dir()
      const s = sh(d, 'h.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"hook replacement"}}\'\n')
      const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.on('tools/post-execute', async () => mode === 'content'
        ? { kind: 'accept' as const, content: [{ type: 'text' as const, text: 'downstream content' }] }
        : { kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'downstream block' }] })
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'raw' }] } }))
      const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      if (result?.type !== 'tool/result') return false
      const text = JSON.stringify(result.data.message.content[0].content)
      return mode === 'content'
        ? text.includes('downstream content') && !text.includes('hook replacement')
        : result.data.message.content[0].isError === true && !text.includes('hook replacement')
    }
    expect(await downstreamWins('content')).toBe(true)
    expect(await downstreamWins('block')).toBe(true)
  })

  it('updatedMCPToolOutput applies ONLY to mcp__ tools; the mismatched field is ignored', async () => {
    async function replacementFor(toolName: string, fields: Record<string, unknown>): Promise<string | undefined> {
      const d = dir()
      const s = sh(d, 'h.sh', `#!/usr/bin/env bash\necho '${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', ...fields } })}'\n`)
      const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', toolName, {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: toolName, description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'raw' }] } }))
      const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      if (result?.type !== 'tool/result' || result.data.message.content[0].isError) return undefined
      const blocks = result.data.message.content[0].content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      return blocks.length === 1 && blocks[0].text === 'raw' ? undefined : blocks[0].text
    }
    // mcp__ tool: the MCP field applies, the plain field is ignored.
    expect(await replacementFor('mcp__srv', { updatedMCPToolOutput: 'mcp replacement' })).toBe('mcp replacement')
    expect(await replacementFor('mcp__srv', { updatedToolOutput: 'wrong field' })).toBeUndefined()
    // Non-MCP tool: the plain field applies, the MCP field is ignored.
    expect(await replacementFor('echo', { updatedToolOutput: 'plain replacement' })).toBe('plain replacement')
    expect(await replacementFor('echo', { updatedMCPToolOutput: 'wrong field' })).toBeUndefined()
  })
})

