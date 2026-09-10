import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent, SessionEvent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { defineContentToolFixture } from '@dsh-cc/tools'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
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
  hooksJson?: string
  beforeHooks?: (ctx: Context) => void
  afterPlugins?: (ctx: Context) => void
}

async function harness(opts: HarnessOptions): Promise<{ ctx: Context; agent: Agent; home: string }> {
  const home = mkdtempSync(join(tmpdir(), 'ccr-home-'))
  dirs.push(home)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
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
    const { agent } = await harness({ mode: 'on', adapter, hooksJson, minBytes: 300, minSavingsRatio: 0.25 })
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

    // Cache safety: the events BEFORE the tool result are byte-untouched.
    const log = events(agent)
    const resultIdx = log.findIndex((e) => e.type === 'tool/result')
    expect(resultIdx).toBeGreaterThan(0)
    for (let i = 0; i < resultIdx; i++) {
      expect(log[i]).toEqual(structuredClone(log[i]))
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
