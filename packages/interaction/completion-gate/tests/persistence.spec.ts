/**
 * Resume replay pin through the REAL JsonlSessionPersistence backend (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §5.8, zstd default —
 * the agent-loop testkit wires no persistence, so an in-memory stand-in
 * structurally cannot see refusal/admission behavior): receipts + a nudge
 * written through the real session reach the log, survive a reopen
 * (evidence/budget durable), and both halves of the composite fail-open hold
 * on the restored view — a pre-feature log (tool events, no receipts) draws
 * no nudge, while a zero-tool lifetime keeps the gate armed.
 *
 * @module
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { defineTool } from '@dsh-cc/tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { NUDGE_EVENT, RECEIPT_EVENT, type Receipt } from '../src/events.ts'
import { evaluateTurnStopping, type EvalAgent, type EvalEvent } from '../src/evaluate.ts'
import { createPostExecuteHandler } from '../src/wiring.ts'
import { LineageRegistry } from '../src/lineage.ts'
import { DEFAULT_GATE_SETTINGS } from '../src/settings.ts'
import { apply } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const evalDeps = () => ({
  settings: { ...DEFAULT_GATE_SETTINGS, enabled: true },
  lineage: new LineageRegistry(),
  latches: new Map<string, number>(),
  debug: () => {},
})

function evalAgent(events: readonly EvalEvent[], id: string): EvalAgent {
  return { session: { header: { id }, snapshotEvents: () => events } }
}

function userText(text: string): ReturnType<typeof createUserMessage> {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function turn(agent: Agent, text: string): Promise<void> {
  agent.followup(userText(text))
  await agent.whenIdle()
}

/**
 * Mount the REAL loop stack on a shared persistence root. `gate` toggles the
 * plugin: `false` produces a genuine PRE-FEATURE log shape (native tool
 * events written by the loop, no `completion-gate/*` receipts anywhere).
 */
async function mount(root: string, responses: ReturnType<typeof textResponse>[], gate: boolean): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // Real backend, DEFAULT compression (zstd) — no 'none' stand-in (§5.8).
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (gate) {
    ctx.tools.register(defineTool({
      name: 'read',
      description: 'read',
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      async execute() { return null },
    }))
  }
  const mock = new MockAdapter(responses)
  ctx.llm.registerAdapter(['mock'], mock)
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(root, ...segments)
  ctx.provide('settings', { get: () => undefined, register: () => ({ get: () => undefined }) })
  if (gate) apply(ctx)
  return ctx
}

describe('@dsh-cc/completion-gate resume replay (§5.8, real zstd backend)', () => {
  it('receipts + nudge survive a reopen; budget durable; composite fail-open holds on the restored view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cg-persist-'))
    roots.push(root)
    // User-layer settings: the gate's dual-half read path is LIVE (§3.5).
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'settings.json'), JSON.stringify({ 'cc-completion-gate': { enabled: true } }), 'utf8')

    // Gate-side stack: s1 claims (nudge fires), then a receipt lands through
    // the REAL post-execute handler; s3 is a zero-tool claiming turn.
    const gateCtx = await mount(root, [
      textResponse('tests pass'),
      textResponse('tests pass'),
      textResponse('tests pass'),
      textResponse('tests pass'),
    ], true)
    const agent1 = await gateCtx.agentLoop.create(SessionId('cg-persist-1'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await turn(agent1, 'run the tests please')
    await turn(agent1, 'and again')
    const handler = createPostExecuteHandler({
      readEnabled: () => true,
      receiptsDir: () => `${root}/completion-gate/receipts`,
      lineage: new LineageRegistry(),
      debug: () => {},
    })
    await handler(
      { callId: 'call_1', name: 'bash', arguments: { command: 'pnpm test' }, agent: { session: agent1.session } } as never,
      { isError: false, content: [{ type: 'text', text: 'ok' }] } as never,
      async () => ({ kind: 'pass' }) as never,
    )
    const agent3 = await gateCtx.agentLoop.create(SessionId('cg-persist-3'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await turn(agent3, 'claim it')
    await gateCtx.sessions.flush(agent1.session)
    await gateCtx.sessions.flush(agent3.session)

    // Pre-feature stack (gate NOT installed): s2 runs a REAL tool execution
    // through the loop — native tool/call + tool/result events, no receipts.
    const preCtx = await mount(root, [
      toolCallResponse('call_x', 'read', {}) as unknown as ReturnType<typeof textResponse>,
      textResponse('tests pass'),
    ], false)
    const agent2 = await preCtx.agentLoop.create(SessionId('cg-persist-2'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await turn(agent2, 'read the file then claim done')
    await preCtx.sessions.flush(agent2.session)

    // /resume: reopen every log through a FRESH persistence stack.
    const ctx2 = new Context()
    await ctx2.plugin(JsonlSessionPersistence, { root })
    const replay = async (id: string): Promise<EvalEvent[]> => {
      const reader = await ctx2.sessionPersistence.open(SessionId(id), 'read')
      try {
        return (await reader.read()).events as EvalEvent[]
      } finally {
        await reader.close()
      }
    }
    const replayed1 = await replay('cg-persist-1')
    const replayed2 = await replay('cg-persist-2')
    const replayed3 = await replay('cg-persist-3')

    // Evidence intact: the receipt (with scrubbed head) and the nudge replay.
    const receipts = replayed1.filter(event => event.type === RECEIPT_EVENT)
    expect(receipts).toHaveLength(1)
    expect((receipts[0]!.data as Receipt).head).toBe('pnpm test')
    expect(replayed1.filter(event => event.type === NUDGE_EVENT)).toHaveLength(1)

    // Budget durable: a fresh process evaluates the restored view's SECOND
    // turn (turn 1 re-entry is suppressed by the skip rule — by design, §3.3)
    // and finds the nudge budget already spent — a resume does not refund.
    expect(evaluateTurnStopping(evalAgent(replayed1, 'cg-persist-1'), 2, evalDeps()))
      .toEqual({ action: 'skip', reason: 'budget' })

    // Composite fail-open, restored pre-feature half: tool events present,
    // zero receipts ⇒ no nudge on the restored view.
    expect(replayed2.some(event => event.type === 'tool/call')).toBe(true)
    expect(replayed2.some(event => event.type === RECEIPT_EVENT)).toBe(false)
    expect(evaluateTurnStopping(evalAgent(replayed2, 'cg-persist-2'), 1, evalDeps()))
      .toEqual({ action: 'skip', reason: 'composite-fail-open' })

    // Composite fail-open, armed half: zero-tool lifetime on the restored
    // view ⇒ the gate stays armed (s3's own turn-1 nudge consumed the default
    // budget, so this evaluates with budget 2 — budget is config, not state).
    const restored3 = evaluateTurnStopping(evalAgent(replayed3, 'cg-persist-3'), 1, {
      ...evalDeps(),
      settings: { ...DEFAULT_GATE_SETTINGS, enabled: true, 'nudges-per-session': 2 },
    })
    expect(restored3).toEqual({ action: 'nudge', claims: ['tests-green'] })
  }, 30_000)
})
