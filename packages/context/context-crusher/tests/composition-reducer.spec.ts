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
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ShellEnv from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
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
  /** Raw nested reducer-decision-gate settings object (S1-12). */
  gate?: Record<string, unknown>
  /** Mount the fake decision service (S1-12); its runs are counted separately from the generator. */
  decision?: DecisionFakeOptions
  /** Extra registrations after the plugins mount (e.g. a downstream accept with additionalContexts). */
  afterPlugins?: (ctx: Context) => void
}

interface DecisionFakeOptions {
  /** Scripted answers per `run` call index (defaults to the low-opportunity pair). */
  answers?: (callIndex: number) => Record<string, unknown>
  /** Scripted route identity per `identifyRoute` call index (defaults to a fixed route). */
  routeOf?: (identifyIndex: number) => Record<string, unknown> | undefined
}

/** Separate counters for the decision runner and the cheap-lane generator. */
interface DecisionStats { runs: number; identifies: number }

const GATE_ROUTE = {
  provider: 'gauge-provider', model: 'gauge-model', revision: 'rev-1',
  perRequestTokens: 8192, perQuestionTokens: 8192, maxQuestions: 4, maxOutputTokens: 64,
}

/** The always-skippable verdict pair (S1-12 thresholds cleared). */
const LOW_ANSWERS = {
  receiptOpportunity: { type: 'score', score: 0.5, probabilities: { '0': 1 } },
  compressible: { type: 'noul', noul: 0.05 },
}

/** The clear-opportunity verdict pair from the design's example (3.6/.95). */
const HIGH_ANSWERS = {
  receiptOpportunity: { type: 'score', score: 3.6, probabilities: { '3': 0.4, '4': 0.6 } },
  compressible: { type: 'noul', noul: 0.95 },
}

function decisionFake(opts: DecisionFakeOptions = {}): { service: unknown; stats: DecisionStats } {
  const stats: DecisionStats = { runs: 0, identifies: 0 }
  return {
    stats,
    service: {
      forAgent: () => ({
        identifyRoute: () => {
          stats.identifies += 1
          return opts.routeOf === undefined ? GATE_ROUTE : opts.routeOf(stats.identifies - 1)
        },
        scope: (originSeq?: number) => ({ projectKey: 'proj', sessionId: 'sess', agentId: 'agent', originSeq: originSeq ?? 0 }),
        run: async () => {
          stats.runs += 1
          return {
            status: 'answered',
            answers: (opts.answers ?? (() => LOW_ANSWERS))(stats.runs - 1),
            model: GATE_ROUTE.model,
            usage: { input_tokens: 10, output_tokens: 2 },
            decisionId: `d-${stats.runs}`,
            inputHash: `h-${stats.runs}`,
          }
        },
      }),
    },
  }
}

export async function harness(opts: HarnessOptions): Promise<{ ctx: Context; agent: Agent; home: string; replay: ReplayAdapter; decision?: DecisionStats }> {
  const home = mkdtempSync(join(tmpdir(), 'ccr-reducer-home-'))
  dirs.push(home)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  if (opts.realBash === true) {
    // rc.5: the bash tool injects fs + working-directory; neither is part of
    // the loop testkit, and the harness service stays PENDING on a missing fs.
    await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
    await ctx.plugin(WorkingDirectory, { cwd: process.cwd() })
    await ctx.plugin(ShellEnv as never, {})
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
    ...(opts.gate === undefined ? {} : { 'reducer-decision-gate': opts.gate }),
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
  // S1-12: the root-realm bridge name the production resolver lands on.
  let decision: DecisionStats | undefined
  if (opts.decision !== undefined) {
    const fake = decisionFake(opts.decision)
    decision = fake.stats
    ctx.provide('ccSystemoneDecisions', fake.service as never)
  }
  opts.afterPlugins?.(ctx)
  const agent = await ctx.agentLoop.create(SessionId('ccr1'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, home, replay, ...(decision === undefined ? {} : { decision }) }
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
    console.log('PROBE-REQ', JSON.stringify((adapter as unknown as { requests?: unknown[] }).requests ?? []).slice(0, 1200))
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

/** The D11 idiom: a downstream accept carries additionalContexts (extra context block). */
function withExtraContext(ctx: Context): void {
  ctx.on('tools/post-execute', async (_exec, _result, next) => {
    await next()
    return {
      kind: 'accept',
      additionalContexts: [createUserMessage({
        content: [{ type: 'text', text: 'dsh-cc gate extra context marker' }],
        source: { kind: 'plugin', plugin: 'test' } as never,
      })],
    }
  })
}

/** The downstream additional-context block landed as a user/message AFTER the tool result. */
function extraContextCommitted(agent: Agent): boolean {
  const log: SessionEvent[] = [...agent.session.snapshotEvents()]
  const resultIdx = log.findIndex((e) => e.type === 'tool/result')
  const ctxIdx = log.findIndex((e) => e.type === 'user/message' && (e.data as { source?: { kind?: string } }).source?.kind !== 'user')
  if (ctxIdx <= resultIdx) return false
  const message = log[ctxIdx] as { data: { content: { type: string; text?: string }[] } }
  return message.data.content.some((b) => b.text?.includes('dsh-cc gate extra context marker'))
}

describe('reducer decision gate (S1-12)', () => {
  it('cheap declines with the gate active: decision=0, generation=0, identical source text', async () => {
    // Command misses the reducer regex: neither model is consulted.
    const miss = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'cat foo.txt' }), textResponse('done')])
    {
      const { agent, replay, decision } = await harness({
        adapter: miss, config: { 'reducer-enabled': true }, gate: { mode: 'active' }, decision: {},
      })
      await run(agent, miss)
      expect(decision!.runs).toBe(0)
      expect(replay.calls).toHaveLength(0)
      expect(resultTexts(agent)[0]).toBe(VITEST_LOG)
    }
    // Unconfigured reducer alias: the original lane-missing decline, no gate call.
    const unrouted = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    {
      const { agent, home, replay, decision } = await harness({
        adapter: unrouted, config: { 'reducer-enabled': true }, gate: { mode: 'active' }, decision: {}, routes: () => undefined,
      })
      await run(agent, unrouted)
      expect(decision!.runs).toBe(0)
      expect(replay.calls).toHaveLength(0)
      expect(resultTexts(agent)[0]).toBe(VITEST_LOG)
      expect(ledgerRows(home).filter((r) => r.kind === 'receipt')).toEqual([
        expect.objectContaining({ applied: false, reason: 'lane-missing' }),
      ])
    }
    // Protected tool list bypass: the crusher never reaches the reducer at all.
    const protected_ = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    {
      const { agent, replay, decision } = await harness({
        adapter: protected_, config: { 'reducer-enabled': true, 'protected-tools': ['bash'] }, gate: { mode: 'active' }, decision: {},
      })
      await run(agent, protected_)
      expect(decision!.runs).toBe(0)
      expect(replay.calls).toHaveLength(0)
      expect(resultTexts(agent)[0]).toBe(VITEST_LOG)
    }
  })

  it('active + every chunk .5/.05: generation=0, put=0, source text character-identical, explicit zero-savings skip row', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, home, replay, decision } = await harness({
      adapter, config: { 'reducer-enabled': true }, gate: { mode: 'active' }, decision: {}, afterPlugins: withExtraContext,
    })
    await run(agent, adapter)

    expect(decision!.runs).toBe(1)
    expect(replay.calls).toHaveLength(0) // the generator never ran
    expect(resultTexts(agent)[0]).toBe(VITEST_LOG) // source text, character-identical
    expect(storedText(home, shortHash(VITEST_LOG))).toBeUndefined() // put=0
    const row = ledgerRows(home).find((r) => r.kind === 'receipt')
    expect(row).toMatchObject({
      applied: false,
      reason: 'decision-gate',
      charsBefore: VITEST_LOG.length,
      charsAfter: VITEST_LOG.length,
      decisionId: 'd-1',
    })
    expect(row!.tokensAfter).toBe(row!.tokensBefore) // zero savings, never an overstated benefit
    // additionalContexts preserved on the skip path.
    expect(extraContextCommitted(agent)).toBe(true)
  })

  it('active + a 3.6/.95 chunk: the generator runs, the verifier applies, additionalContexts survive success', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, home, replay, decision } = await harness({
      adapter, config: { 'reducer-enabled': true }, gate: { mode: 'active' }, decision: { answers: () => HIGH_ANSWERS }, afterPlugins: withExtraContext,
    })
    await run(agent, adapter)

    expect(decision!.runs).toBe(1)
    expect(replay.calls).toHaveLength(1)
    const committed = resultTexts(agent)[0]
    const lines = committed.split('\n')
    expect(lines[0]).toBe('cmd: vitest run')
    expect(isCrusherStub(committed)).toBe(true)
    const marker = parseMarker(lines.at(-1)!)
    expect(marker).not.toBeNull()
    const stored = storedText(home, marker!.hash)
    expect(stored === undefined ? undefined : (JSON.parse(stored) as { text: string }).text).toBe(VITEST_LOG)
    expect(ledgerRows(home).find((r) => r.kind === 'receipt')).toMatchObject({ applied: true, hash: marker!.hash })
    // additionalContexts preserved on the successful-replacement path.
    expect(extraContextCommitted(agent)).toBe(true)
  })

  it('a fabricated receipt after an attempt verdict: the verifier declines, source text passes, put=0', async () => {
    const fabricated = JSON.stringify({
      v: 1, cmd: 'vitest run', exit: { ok: true },
      failures: [{ name: 'ghost.spec.ts', evidence: 'THIS QUOTE IS NOT IN THE SOURCE' }],
      key_output: [],
    })
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, home, replay, decision } = await harness({
      adapter, config: { 'reducer-enabled': true }, gate: { mode: 'active' },
      decision: { answers: () => HIGH_ANSWERS }, cheapScript: streamScript(fabricated), afterPlugins: withExtraContext,
    })
    await run(agent, adapter)

    expect(decision!.runs).toBe(1)
    expect(replay.calls).toHaveLength(1)
    expect(resultTexts(agent)[0]).toBe(VITEST_LOG) // the verifier declined; gates change nothing here
    expect(ledgerRows(home).find((r) => r.kind === 'receipt')).toMatchObject({ applied: false, reason: expect.stringMatching(/^verify:/) })
    expect(storedText(home, shortHash(VITEST_LOG))).toBeUndefined()
    // additionalContexts preserved on the failure path.
    expect(extraContextCommitted(agent)).toBe(true)
  })

  it('truncated view: decision=0 and the generator receives the same view as before', async () => {
    const big = [VITEST_LOG, VITEST_LOG, VITEST_LOG].join('\n')
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, replay, decision } = await harness({
      adapter,
      config: { 'reducer-enabled': true, 'reducer-max-input-tokens': 400 },
      gate: { mode: 'active' },
      decision: {},
      toolOutput: big,
    })
    await run(agent, adapter)

    expect(decision!.runs).toBe(0) // an incomplete view is never judged
    expect(replay.calls).toHaveLength(1)
    const promptText = String((replay.calls[0].messages.at(-1) as { content?: { text?: string }[] }).content?.[0]?.text ?? '')
    expect(promptText.length).toBeLessThan(big.length / 2) // the same truncated view as without the gate
    expect(promptText).toContain('Test Files  1 failed (1)')
    expect(isCrusherStub(resultTexts(agent)[0])).toBe(true)
  })

  it('shadow + dry-run: the judgment and the original generation run, nothing is applied or replaced', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, home, replay, decision } = await harness({
      adapter, mode: 'dry-run', config: { 'reducer-enabled': true }, gate: { mode: 'shadow' }, decision: {},
    })
    await run(agent, adapter)

    expect(decision!.runs).toBe(1)
    expect(replay.calls).toHaveLength(1)
    expect(resultTexts(agent)[0]).toBe(VITEST_LOG)
    const rows = ledgerRows(home).filter((r) => r.kind === 'receipt')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ applied: false })
    expect(rows[0].reason).toBeUndefined() // shadow never writes a decision-gate row
    expect(storedText(home, shortHash(VITEST_LOG))).toBeUndefined()
  })

  it('a route revision change after the await drops the judgment; the model is not re-asked; generation continues', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, home, replay, decision } = await harness({
      adapter, config: { 'reducer-enabled': true }, gate: { mode: 'active' },
      decision: { routeOf: (i) => ({ ...GATE_ROUTE, revision: i < 2 ? 'rev-1' : 'rev-2' }) },
    })
    await run(agent, adapter)

    expect(decision!.runs).toBe(1) // ONE wire attempt per batch; no re-ask under a moved identity
    expect(replay.calls).toHaveLength(1)
    expect(ledgerRows(home).find((r) => r.kind === 'receipt')).toMatchObject({ applied: true })
    expect(isCrusherStub(resultTexts(agent)[0])).toBe(true)
  })

  it('an invalid chunk answer (a missing question key) drops the group; generation continues', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'bash', { command: 'vitest run' }), textResponse('done')])
    const { agent, home, replay, decision } = await harness({
      adapter, config: { 'reducer-enabled': true }, gate: { mode: 'active' },
      decision: { answers: () => ({ receiptOpportunity: { type: 'score', score: 0.5, probabilities: { '0': 1 } } }) },
    })
    await run(agent, adapter)

    expect(decision!.runs).toBe(1)
    expect(replay.calls).toHaveLength(1)
    expect(ledgerRows(home).find((r) => r.kind === 'receipt')).toMatchObject({ applied: true })
    expect(isCrusherStub(resultTexts(agent)[0])).toBe(true)
  })
})
