import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, SessionEvent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@dsh-cc/tools'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { isCrusherStub } from '@dsh-cc/tool-use-summary'
import ContextCrusher, { parseMarker, shortHash } from '../src/index.ts'
import { route } from '../src/router.ts'

/**
 * Reducer composition tests (plan §4 Phase 1): the REAL crusher plugin runs
 * inside the REAL agent loop; only the models are mocked — the parent lane
 * with a MockAdapter, the cheap lane with a ReplayAdapter serving a scripted
 * receipt (tool-use-summary producer.spec.ts assembly pattern: fake
 * ccModelRoutes, temp dshHomePath).
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A failing-vitest-style log: route() declines it (shape heuristics miss). */
export const VITEST_LOG: string = readFileSync(new URL('./fixtures/vitest-fail.log.txt', import.meta.url), 'utf8')

/** Receipt the cheap lane serves for the vitest log — every quote verbatim. */
const VITEST_RECEIPT = JSON.stringify({
  v: 1,
  cmd: 'vitest run',
  exit: { ok: true },
  failures: [{ name: 'fail.spec.ts > scratch golden fixture > fails a diff-style assertion', evidence: 'Test Files  1 failed (1)' }],
  key_output: ['Duration  103ms (transform 10ms, setup 0ms, import 16ms, tests 5ms, environment 0ms)'],
  counts: { pass: 0, fail: 1, skip: 0 },
})

function streamScript(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ReplayAdapter extends LlmAdapter {
  constructor(private readonly script: readonly StreamChunk[]) { super() }
  readonly calls: GenerateOptions[] = []
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    for (const chunk of this.script) {
      if (options.signal?.aborted) break
      yield chunk
    }
  }
}

interface HarnessOptions {
  adapter: MockAdapter
  mode?: 'on' | 'dry-run'
  config?: Record<string, unknown>
  /** Output of the fixture `bash` tool (defaults to the vitest log). */
  toolOutput?: string
  /** Mount the REAL harness bash tool instead of the fixture. */
  realBash?: boolean
  /** Fake ccModelRoutes resolve for 'haiku'; defaults to an explicit cheap route. */
  routes?: () => { provider?: string; model?: string } | undefined
  cheapScript?: readonly StreamChunk[]
}

export async function harness(opts: HarnessOptions): Promise<{ ctx: Context; agent: Agent; home: string; replay: ReplayAdapter }> {
  const home = mkdtempSync(join(tmpdir(), 'ccr-reducer-home-'))
  dirs.push(home)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  if (opts.realBash === true) {
    await ctx.plugin(ShellEnv as never)
    await ctx.plugin(ToolBash as never)
  }
  void new TokenMeter(ctx)
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(home, ...segments)
  ctx.provide('ccModelRoutes', {
    resolve: (alias: string | undefined) =>
      alias === 'haiku'
        ? (opts.routes === undefined ? { provider: 'cheap', model: 'haiku-model' } : opts.routes())
        : undefined,
  })
  const replay = new ReplayAdapter(opts.cheapScript ?? streamScript(VITEST_RECEIPT))
  await ctx.plugin(ContextCrusher, {
    enabled: true,
    mode: opts.mode ?? 'on',
    'min-bytes': 60,
    ...(opts.config ?? {}),
  })
  if (opts.realBash !== true) {
    ctx.tools.register(defineContentToolFixture({
      name: 'bash', description: 'b', parameters: {},
      async execute() { return [{ type: 'text', text: opts.toolOutput ?? VITEST_LOG }] },
    }))
  }
  ctx.llm.registerAdapter(['mock'], opts.adapter)
  ctx.llm.registerAdapter(['cheap'], replay)
  const agent = await ctx.agentLoop.create(SessionId('ccr1'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, home, replay }
}

export async function run(agent: Agent, adapter: MockAdapter): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run tests' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  void adapter
}

export function resultTexts(agent: Agent): string[] {
  return [...agent.session.snapshotEvents()]
    .filter((e) => e.type === 'tool/result')
    .map((e) => {
      const content = (e.data as { message: { content: { type: string; content?: { type: string; text?: string }[]; text?: string }[] } }).message.content
      return content.map((b) =>
        b.type === 'tool-result'
          ? (b.content ?? []).map((x) => x.text ?? '').join('\n')
          : b.text ?? '',
      ).join('\n')
    })
}

export function ledgerRows(home: string): Record<string, unknown>[] {
  const p = join(home, 'ccr', 'savings.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []
}

/** Read the stored original for a 16-hex handle, wherever the project bucket is. */
function storedText(home: string, hash: string): string | undefined {
  const ccr = join(home, 'ccr')
  if (!existsSync(ccr)) return undefined
  for (const bucket of readdirSync(ccr)) {
    const file = join(ccr, bucket, hash)
    if (existsSync(file)) return readFileSync(file, 'utf8')
  }
  return undefined
}

describe('reducer composition', () => {
  it('a+d: route-null failing-vitest log escalates to the reducer; receipt + pinned marker; store holds the original; retrieve round-trips', async () => {
    expect(route(VITEST_LOG)).toBeNull()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'bash', { command: 'vitest run' }),
      toolCallResponse('c2', 'context_retrieve', { hash: shortHash(VITEST_LOG) }),
      textResponse('done'),
    ])
    const { agent, home, replay } = await harness({ adapter, config: { 'reducer-enabled': true } })
    await run(agent, adapter)
    expect(replay.calls).toHaveLength(1)

    const committed = resultTexts(agent)[0]
    const lines = committed.split('\n')
    expect(lines[0]).toBe('cmd: vitest run')
    expect(lines.at(-1)).toMatch(/^\[dsh-cc compressed \d+→\d+ tokens\. Original: ccr:\/\/[0-9a-f]{16}\]$/)
    const marker = parseMarker(lines.at(-1)!)
    expect(marker).not.toBeNull()
    // g. downstream stub protection via the pinned marker contract.
    expect(isCrusherStub(committed)).toBe(true)
    // The store holds the FULL original; context_retrieve round-trips the bytes.
    // The store keeps an envelope; the retrieve tool unwraps it.
    const stored = storedText(home, marker!.hash)
    expect(stored === undefined ? undefined : (JSON.parse(stored) as { text: string }).text).toBe(VITEST_LOG)
    expect(resultTexts(agent)[1]).toBe(VITEST_LOG)
    const row = ledgerRows(home).find((r) => r.kind === 'receipt')
    expect(row).toMatchObject({ kind: 'receipt', applied: true, hash: marker!.hash })
  })

  it('b: unrouted alias → ledger lane-missing and NO cheap-lane call', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, home, replay } = await harness({ adapter, config: { 'reducer-enabled': true }, routes: () => undefined })
    await run(agent, adapter)

    expect(resultTexts(agent)[0]).toBe(VITEST_LOG)
    const rows = ledgerRows(home).filter((r) => r.kind === 'receipt')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ applied: false, reason: 'lane-missing' })
    expect(replay.calls).toHaveLength(0)
  })

  it('c: oversized source → truncated view → still verifies and applies', async () => {
    const big = [VITEST_LOG, VITEST_LOG, VITEST_LOG].join('\n')
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, home, replay } = await harness({
      adapter,
      config: { 'reducer-enabled': true, 'reducer-max-input-tokens': 400 },
      toolOutput: big,
      // The receipt quote lives in the tail of the truncated view.
      cheapScript: streamScript(VITEST_RECEIPT),
    })
    await run(agent, adapter)

    expect(replay.calls).toHaveLength(1)
    const promptText = String((replay.calls[0].messages.at(-1) as { content?: { text?: string }[] }).content?.[0]?.text ?? '')
    expect(promptText.length).toBeLessThan(big.length / 2) // the view was truncated
    expect(promptText).toContain('Test Files  1 failed (1)') // tail survived
    const committed = resultTexts(agent)[0]
    expect(committed.endsWith(']')).toBe(true)
    expect(isCrusherStub(committed)).toBe(true)
    const row = ledgerRows(home).find((r) => r.kind === 'receipt')
    expect(row).toMatchObject({ applied: true })
  })

  it('e: a real bash execution surfaces its command under exec.arguments.command (eligibility input source)', async () => {
    // Real LocalBashExecutor, real arguments.command. Noise route() declines.
    const script = "for i in $(seq 0 399); do echo 'FAIL src/x.test.ts > case '$i' Error: expected '$i' to equal '$((i+1)); done"
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: script, description: 'run the noisy build' }), textResponse('done')])
    const receipt = JSON.stringify({
      v: 1,
      cmd: script,
      exit: { ok: true },
      failures: [],
      key_output: ['FAIL src/x.test.ts > case 399 Error: expected 399 to equal 400'],
    })
    const { agent, home, replay } = await harness({
      adapter,
      config: { 'reducer-enabled': true, 'reducer-commands': ['\\bseq\\b'], 'min-savings-ratio': 0.9 },
      realBash: true,
      cheapScript: streamScript(receipt),
    })
    // Replace the fixture bash with the REAL tool output: run the command via
    // the loop's own bash tool by simply executing it (fixture tool name is
    // 'bash' too — this test uses the real executor output through the loop).
    // The fixture tool is bypassed because the loop's real bash tool handles
    // 'bash' first; assert on whatever ran: the eligibility input must have
    // been exec.arguments.command, else no receipt row appears.
    await run(agent, adapter)
    const rows = ledgerRows(home).filter((r) => r.kind === 'receipt')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ applied: true })
    expect(replay.calls).toHaveLength(1)
  })

  it('f: provider-less route → lane-inherited; explicit-provider route → accepted', async () => {
    const holed = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    {
      const { agent, home, replay } = await harness({ adapter: holed, config: { 'reducer-enabled': true }, routes: () => ({ model: 'haiku-model' }) })
      await run(agent, holed)
      expect(resultTexts(agent)[0]).toBe(VITEST_LOG)
      const rows = ledgerRows(home).filter((r) => r.kind === 'receipt')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ applied: false, reason: 'lane-inherited' })
      expect(replay.calls).toHaveLength(0)
    }
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    {
      const { agent, home, replay } = await harness({ adapter, config: { 'reducer-enabled': true } })
      await run(agent, adapter)
      const rows = ledgerRows(home).filter((r) => r.kind === 'receipt')
      expect(rows[0]).toMatchObject({ applied: true })
      expect(replay.calls).toHaveLength(1)
      void home
    }
  })

  it('dry-run: receipt produced + verified, no store.put, original committed', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, home, replay } = await harness({ adapter, mode: 'dry-run', config: { 'reducer-enabled': true } })
    await run(agent, adapter)

    expect(resultTexts(agent)[0]).toBe(VITEST_LOG)
    expect(replay.calls).toHaveLength(1)
    const rows = ledgerRows(home).filter((r) => r.kind === 'receipt')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ applied: false })
    expect(rows[0].hash).toBeUndefined()
    expect(storedText(home, shortHash(VITEST_LOG))).toBeUndefined()
  })
})
