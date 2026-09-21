import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolResultMessage } from '@deepseek-ai/dsh-session'
import type { Agent, SessionEvent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@dsh-cc/tools'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { getSessionCwd } from '@dsh-cc/session-cwd'
import ContextCrusher, { shortHash } from '../src/index.ts'

/**
 * REAL composition tests (bridge.spec.ts pattern): the REAL context-crusher
 * plugin and the REAL hooks-claude-code bridge run against the REAL agent loop
 * with a scripted mock MODEL — only the model is mocked. No hand-rolled
 * service fakes for the tripwire.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** A grep-shaped output large enough to clear the size gate. */
function bigGrepOutput(): string {
  const lines: string[] = []
  for (let i = 0; i < 120; i++) {
    const file = `src/components/deeply/nested/really/long/module-path-${i % 4}.ts`
    lines.push(`${file}:${100 + i}:  someMatchyFunctionCall(argument-${i}, { option: ${i}, extra: 'padding to make the row long enough for a solid saving ratio' })`)
  }
  return lines.join('\n')
}

interface HarnessOptions {
  mode: 'on' | 'dry-run'
  adapter: MockAdapter
  /** Lower the token gate for small fixtures (explicitly set, per plan). */
  minBytes?: number
  /** Explicitly-set savings ratio for small fixtures (defaults stay 0.4). */
  minSavingsRatio?: number
  /** Deferred-mode residency (0 = off; the plugin default). */
  deferRequests?: number
  deferMargin?: number
  deferMaxAgeMs?: number
  deferUrgencyTokens?: number
  hooksJson?: string
  beforeHooks?: (ctx: Context) => void
  afterPlugins?: (ctx: Context) => void
}

async function harness(opts: HarnessOptions): Promise<{ ctx: Context; agent: Agent; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'ccr-home-'))
  dirs.push(home)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  // Service constructors self-register; TokenMeter hard-injects sessionProjections.
  void new TokenMeter(ctx)
  // dshHomePath seam: a real boot provides it; tests point it at a temp home.
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(home, ...segments)
  opts.beforeHooks?.(ctx)
  await ctx.plugin(ContextCrusher, {
    enabled: true,
    mode: opts.mode,
    'min-bytes': opts.minBytes,
    ...(opts.minSavingsRatio !== undefined ? { 'min-savings-ratio': opts.minSavingsRatio } : {}),
    ...(opts.deferRequests !== undefined ? { 'defer-requests': opts.deferRequests } : {}),
    ...(opts.deferMargin !== undefined ? { 'defer-margin': opts.deferMargin } : {}),
    ...(opts.deferMaxAgeMs !== undefined ? { 'defer-max-age-ms': opts.deferMaxAgeMs } : {}),
    ...(opts.deferUrgencyTokens !== undefined ? { 'defer-urgency-tokens': opts.deferUrgencyTokens } : {}),
  })
  if (opts.hooksJson !== undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'ccr-hooks-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'hooks.json'), opts.hooksJson)
    await ctx.plugin(HooksClaude, { configPath: join(dir, 'hooks.json') })
  }
  opts.afterPlugins?.(ctx)
  ctx.tools.register(defineContentToolFixture({
    name: 'biggrep', description: 'b', parameters: {},
    async execute() { return [{ type: 'text', text: bigGrepOutput() }] },
  }))
  ctx.llm.registerAdapter(['mock'], opts.adapter)
  const agent = await ctx.agentLoop.create(SessionId('ccr1'), { provider: 'mock', model: 'mock' })
  return { ctx, agent, home }
}

async function run(agent: Agent, adapter: MockAdapter): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'search the code' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  void adapter
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'test' } as never })
}

function events(agent: Agent): SessionEvent[] {
  return [...agent.session.snapshotEvents()]
}

function committedResult(agent: Agent): string {
  return resultTexts(agent)[0] ?? ''
}

function resultTexts(agent: Agent): string[] {
  return events(agent)
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

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('context-crusher composition (real boot)', () => {
  it('ORDER TRIPWIRE: the PostToolUse hook payload sees the ORIGINAL bytes while the committed tool/result carries compressed text + marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccr-hookcap-'))
    dirs.push(dir)
    const capture = join(dir, 'payload.json')
    writeFileSync(join(dir, 'cap.sh'), `#!/bin/bash\ncat > ${capture}\n`)
    chmodSync(join(dir, 'cap.sh'), 0o755)
    const hooksJson = JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'biggrep', hooks: [{ type: 'command', command: join(dir, 'cap.sh') }] }] } })

    const original = bigGrepOutput()
    const adapter = new MockAdapter([toolCallResponse('c1', 'biggrep', {}), textResponse('done')])
    // B1 hardening: capture every committed event's bytes BEFORE the tool
    // runs (the previous assertion compared each event to its own deep
    // clone — vacuous). Default config here means `defer-requests: 0`, so
    // this also pins that defer-off is byte-identical to today.
    let preToolBytes: readonly string[] = []
    const { agent } = await harness({ mode: 'on', adapter, hooksJson, minBytes: 300, minSavingsRatio: 0.25, beforeHooks: (ctx) => {
      ctx.on('tools/pre-execute', async (exec, next) => {
        preToolBytes = exec.agent === undefined
          ? []
          : [...exec.agent.session.snapshotEvents()].map((e) => JSON.stringify(e))
        return next()
      })
    } })
    await run(agent, adapter)

    // The committed session event carries the compressed form + marker.
    const committed = committedResult(agent)
    // Compressed form: per-file cluster headers + the pinned marker.
    expect(committed).toContain('== src/components/deeply/nested/really/long/module-path-0.ts ==')
    expect(committed).toContain('dsh-cc compressed')
    expect(committed).toMatch(/Original: ccr:\/\/[0-9a-f]{16}/)

    // The REAL PostToolUse hook saw the ORIGINAL bytes (path-prefixed rows,
    // no cluster headers, no marker).
    expect(existsSync(capture)).toBe(true)
    const payload = readFileSync(capture, 'utf8')
    expect(payload).toContain('src/components/deeply/nested/really/long/module-path-0.ts:100:')
    expect(payload).not.toContain('== src/')
    expect(payload).not.toContain('dsh-cc compressed')

    // The original bytes themselves round-trip: hash is content-derived.
    expect(committed).toContain(`ccr://${shortHash(original)}`)

    // Cache safety: the events committed BEFORE the tool ran are
    // byte-identical after the crusher rewrote the result.
    const log = events(agent)
    expect(preToolBytes.length).toBeGreaterThan(0)
    const resultIdx = log.findIndex((e) => e.type === 'tool/result')
    expect(resultIdx).toBeGreaterThan(0)
    expect(resultIdx).toBeGreaterThanOrEqual(preToolBytes.length)
    for (let i = 0; i < preToolBytes.length; i++) {
      expect(JSON.stringify(log[i])).toBe(preToolBytes[i])
    }
  })

  it('context_retrieve(hash) returns the original verbatim (real tool through the real loop)', async () => {
    const original = bigGrepOutput()
    const hash = shortHash(original)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'biggrep', {}),
      toolCallResponse('c2', 'context_retrieve', { hash }),
      textResponse('done'),
    ])
    const { agent } = await harness({ mode: 'on', adapter, minBytes: 300, minSavingsRatio: 0.25 })
    await run(agent, adapter)

    const retrieveResults = resultTexts(agent)
    expect(retrieveResults.length).toBe(2)
    expect(retrieveResults[1]).toBe(original)
  })

  it('a downstream block decision passes through untouched (never converted)', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'biggrep', {}), textResponse('done')])
    const { agent } = await harness({ mode: 'on', adapter, minBytes: 300, afterPlugins: (ctx) => {
      ctx.on('tools/post-execute', async (_exec, _result, next) => {
        await next()
        return { kind: 'block', feedback: [{ type: 'text', text: 'blocked by policy' }] }
      })
    } })
    await run(agent, adapter)

    const log = events(agent)
    const last = [...log].reverse().find((e) => e.type === 'tool/result')
    expect(last).toBeDefined()
    expect(resultTexts(agent)[0]).toContain('blocked by policy')
  })

  it('additionalContexts from a downstream accept survive the crusher replace (D11)', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'biggrep', {}), textResponse('done')])
    const { agent } = await harness({ mode: 'on', adapter, minBytes: 300, minSavingsRatio: 0.25, afterPlugins: (ctx) => {
      ctx.on('tools/post-execute', async (_exec, _result, next) => {
        await next()
        return {
          kind: 'accept',
          additionalContexts: [userMessage('dsh-cc test extra context marker')],
        }
      })
    } })
    await run(agent, adapter)

    // Compressed form committed AND the downstream context appended after it.
    const committed = committedResult(agent)
    expect(committed).toContain('dsh-cc compressed')
    const log = events(agent)
    const resultIdx = log.findIndex((e) => e.type === 'tool/result')
    const ctxIdx = log.findIndex((e) => e.type === 'user/message' && e.data.source.kind !== 'user')
    expect(ctxIdx).toBeGreaterThan(resultIdx)
    const ctxMsg = log[ctxIdx] as { data: { content: { type: string; text?: string }[] } }
    expect(ctxMsg.data.content.some((b) => b.text?.includes('dsh-cc test extra context marker'))).toBe(true)
  })

  it('dry-run: the original is committed and a ledger row applied:false exists', async () => {
    const original = bigGrepOutput()
    const adapter = new MockAdapter([toolCallResponse('c1', 'biggrep', {}), textResponse('done')])
    const { agent, home } = await harness({ mode: 'dry-run', adapter, minBytes: 300, minSavingsRatio: 0.25 })
    await run(agent, adapter)

    expect(committedResult(agent)).toBe(original)
    const ledgerPath = join(home, 'ccr', 'savings.jsonl')
    expect(existsSync(ledgerPath)).toBe(true)
    const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ applied: false, tool: 'biggrep', sessionId: expect.any(String) })
    expect(rows[0].hash).toBeUndefined()
  })
})

/** Text of the CURRENT surface's tool/result nodes (surface, not log). */
function surfaceResultTexts(agent: Agent): string[] {
  const out: string[] = []
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.eventAt(seq)
    if (event?.type !== 'tool/result') continue
    const block = event.data.message.content[0]
    if (block?.type === 'tool-result') {
      out.push(block.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'))
    }
  }
  return out
}

function surfaceResult(agent: Agent): string {
  return surfaceResultTexts(agent)[0] ?? ''
}

interface DeferRow {
  type: string
  outcome?: string
  applied?: boolean
  hash?: string
}

function deferLedgerRows(home: string, agent: Agent): DeferRow[] {
  const file = join(home, 'ccr', 'defer', `${String(agent.session.id)}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as DeferRow)
}

describe('deferred externalization (real boot)', () => {
  it('PHASE-0 PIN: the llm/stream listener registers { global: true, prepend: true }', async () => {
    const registrations: unknown[] = []
    const adapter = new MockAdapter([textResponse('done')])
    const { agent } = await harness({ mode: 'on', adapter, minBytes: 300, beforeHooks: (ctx) => {
      const original = ctx.on.bind(ctx)
      ctx.on = ((name: string, listener: never, options?: unknown) => {
        if (name === 'llm/stream') registrations.push(options)
        return original(name, listener, options as never)
      }) as typeof ctx.on
    } })
    await run(agent, adapter)
    expect(registrations).toEqual([{ global: true, prepend: true }])
  })

  it('defer-requests: 2 — full text for two sends, stub+marker swap at the pre-step before the third', async () => {
    const original = bigGrepOutput()
    const hash = shortHash(original)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'biggrep', {}),
      textResponse('done-1'),
      textResponse('done-2'),
      toolCallResponse('c2', 'context_retrieve', { hash }),
      textResponse('done-3'),
    ])
    const { ctx, agent, home } = await harness({ mode: 'on', adapter, minBytes: 1000, minSavingsRatio: 0.25, deferRequests: 2 })

    // Turn 1: the tool runs; request 2 sends the full text (1st send).
    await run(agent, adapter)
    expect(committedResult(agent)).toBe(original)

    // Turn 2: request 3 sends the full text again (2nd send); still resident.
    await run(agent, adapter)
    expect(surfaceResult(agent)).toBe(original)

    // Turn 3: the pre-step swaps BEFORE the request; the stub enters the surface.
    await run(agent, adapter)
    const surface = surfaceResult(agent)
    expect(surface).toContain('dsh-cc compressed')
    expect(surface).toContain(`ccr://${hash}`)
    expect(surface).not.toBe(original)

    // The log stays append-only: the original event is untouched and the
    // swap landed as adjacent prune + replace appends (microcompact shape).
    const log = events(agent)
    const firstResultIdx = log.findIndex((e) => e.type === 'tool/result')
    const firstResult = log[firstResultIdx]
    expect(firstResult?.type).toBe('tool/result')
    if (firstResult?.type !== 'tool/result') return
    const originalBlock = firstResult.data.message.content[0]
    expect(originalBlock?.type === 'tool-result' && originalBlock.content[0])
      .toEqual({ type: 'text', text: original })

    const pruneIdx = log.findIndex((e) => e.type === 'compaction/prune')
    expect(pruneIdx).toBeGreaterThan(-1)
    const prune = log[pruneIdx]
    if (prune?.type !== 'compaction/prune') throw new Error('prune row missing')
    // The paired prune row debits the token meter by the ORIGINAL message's estimate.
    expect(prune.data.shadowedSeqs).toEqual([firstResultIdx])
    expect(prune.data.shadowedTokenCount)
      .toBe(ctx.tokenMeter.estimateMessage(firstResult.data.message))

    const replacement = log[pruneIdx + 1]
    expect(replacement?.type).toBe('tool/result')
    if (replacement?.type !== 'tool/result') throw new Error('replacement row missing')
    expect(replacement.surfaceOp).toEqual({ op: 'replace', startSeq: firstResultIdx, endSeq: firstResultIdx })
    expect(replacement.sourceEventSeqs).toEqual([firstResultIdx])
    const replacementBlock = replacement.data.message.content[0]
    if (replacementBlock?.type !== 'tool-result' || originalBlock?.type !== 'tool-result') {
      throw new Error('replacement block missing')
    }
    // Every non-content field of the original block survives the swap.
    expect(replacementBlock.toolCallId).toBe(originalBlock.toolCallId)
    expect(replacementBlock.isError).toBe(originalBlock.isError)
    expect(replacementBlock.content[0]?.type).toBe('text')

    // The original stays permanently retrievable (real tool, real loop).
    expect(resultTexts(agent).at(-1)).toBe(original)

    // The defer ledger recorded the resident and the applied swap.
    const rows = deferLedgerRows(home, agent)
    expect(rows[0]).toMatchObject({ type: 'resident', hash })
    expect(rows.some((r) => r.type === 'swap' && r.outcome === 'applied' && r.applied === true)).toBe(true)
  })

  it('a failed cost gate keeps the entry resident (no swap, no abandonment)', async () => {
    const original = bigGrepOutput()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'biggrep', {}),
      textResponse('done-1'),
      textResponse('done-2'),
      textResponse('done-3'),
    ])
    const { agent, home } = await harness({ mode: 'on', adapter, minBytes: 1000, minSavingsRatio: 0.25, deferRequests: 2, deferMargin: 1e9 })
    await run(agent, adapter)
    await run(agent, adapter)
    await run(agent, adapter)

    expect(surfaceResult(agent)).toBe(original)
    expect(events(agent).some((e) => e.type === 'compaction/prune')).toBe(false)
    const rows = deferLedgerRows(home, agent)
    expect(rows.some((r) => r.type === 'resident')).toBe(true)
    expect(rows.some((r) => r.type === 'swap')).toBe(false)
  })

  it('sweeps a resident older than defer-max-age-ms with swap:abandoned', async () => {
    const original = bigGrepOutput()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'biggrep', {}),
      textResponse('done-1'),
      textResponse('done-2'),
    ])
    const { agent, home } = await harness({ mode: 'on', adapter, minBytes: 1000, minSavingsRatio: 0.25, deferRequests: 2, deferMaxAgeMs: 1 })
    await run(agent, adapter)
    await new Promise((r) => setTimeout(r, 10))
    await run(agent, adapter)

    expect(surfaceResult(agent)).toBe(original)
    expect(events(agent).some((e) => e.type === 'compaction/prune')).toBe(false)
    const rows = deferLedgerRows(home, agent)
    expect(rows.some((r) => r.type === 'swap' && r.outcome === 'abandoned' && r.applied === false)).toBe(true)
  })

  it('swap:stale — a mutated surface body drops the resident without appending', async () => {
    const original = bigGrepOutput()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'biggrep', {}),
      textResponse('done-1'),
      textResponse('done-2'),
      textResponse('done-3'),
    ])
    const { agent, home } = await harness({ mode: 'on', adapter, minBytes: 1000, minSavingsRatio: 0.25, deferRequests: 2 })
    await run(agent, adapter)
    await run(agent, adapter)

    // Mutate the surface body in place (mimics a user compaction landing first).
    const session = agent.session
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq)
      if (event?.type !== 'tool/result') continue
      const block = event.data.message.content[0]
      if (block?.type !== 'tool-result') continue
      session.append('tool/result', {
        ...event.data,
        message: freezeMessage<ToolResultMessage>({
          ...event.data.message,
          content: [{ ...block, content: [{ type: 'text', text: 'mutated body' }] }],
        }),
      }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
    }
    expect(surfaceResult(agent)).toBe('mutated body')

    // The next pre-step finds the body no longer byte-equals the stored text.
    await run(agent, adapter)
    expect(surfaceResult(agent)).toBe('mutated body')
    expect(events(agent).some((e) => e.type === 'compaction/prune')).toBe(false)
    const rows = deferLedgerRows(home, agent)
    expect(rows.filter((r) => r.type === 'swap')).toEqual([
      expect.objectContaining({ outcome: 'stale', applied: false }),
    ])
  })

  it('deferred dry-run: stores and counts but NEVER appends to the session (intent rows applied:false)', async () => {
    const original = bigGrepOutput()
    const hash = shortHash(original)
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'biggrep', {}),
      textResponse('done-1'),
      textResponse('done-2'),
      textResponse('done-3'),
    ])
    const { agent, home } = await harness({ mode: 'dry-run', adapter, minBytes: 1000, minSavingsRatio: 0.25, deferRequests: 2 })
    await run(agent, adapter)
    await run(agent, adapter)
    await run(agent, adapter)

    // Never appended: the surface still carries the full original.
    expect(surfaceResult(agent)).toBe(original)
    expect(events(agent).some((e) => e.type === 'compaction/prune')).toBe(false)

    // Divergence pin (§3.6): deferred dry-run DOES write the store file
    // (today's immediate dry-run returns before store.put).
    const projectKey = shortHash(getSessionCwd(agent))
    expect(existsSync(join(home, 'ccr', projectKey, hash))).toBe(true)

    // Resident row + dry-run intent rows, all applied:false.
    const rows = deferLedgerRows(home, agent)
    expect(rows[0]).toMatchObject({ type: 'resident', hash })
    const swaps = rows.filter((r) => r.type === 'swap')
    expect(swaps.length).toBeGreaterThan(0)
    for (const row of swaps) {
      expect(row.outcome).toBe('dry-run')
      expect(row.applied).toBe(false)
    }
  })
})
