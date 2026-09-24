/**
 * C2 canary spec: crusher store redaction. `CrusherStore.put` redacts via the
 * injected redactor BEFORE hashing (hash + file + stored text all derive from
 * the redacted string), and `context_retrieve` output carries the trailing
 * note when the content was scrubbed at write time and `redactCrusherStore`
 * stays on. Real composition for the retrieve path: the REAL context-crusher
 * plugin over the REAL agent loop with a scripted mock model (composition.spec
 * pattern); the settings provider is a double.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalBashExecutor from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@dsh-cc/tools'
import { redact, resetForTests, type SecretsSettings } from '@dsh-cc/transcript-secrets'
import { CrusherStore, shortHash } from '../src/store.ts'
import ContextCrusher from '../src/index.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

beforeEach(() => { resetForTests() })
afterEach(() => { resetForTests() })

/** A canary key above the built-in body floor. */
const CANARY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ'
const REDACT_NOTE = '[secrets redacted before store write]'

describe('CrusherStore redaction (C2)', () => {
  it('redact-before-hash: stored file and hash both derive from the redacted text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccr-store-'))
    dirs.push(root)
    const store = new CrusherStore(root, Date.now, (text) => redact(text).text)
    const pk = 'p'.repeat(16)
    const hash = await store.put(pk, `secret ${CANARY} end`)
    expect(hash).toBe(shortHash('secret [REDACTED] end'))
    const files = readdirSync(join(root, pk))
    expect(files).toContain(hash)
    const stored = readFileSync(join(root, pk, hash), 'utf8')
    expect(stored).not.toContain(CANARY)
    expect(stored).toContain('[REDACTED]')
    expect(await store.get(pk, hash)).toMatchObject({ ok: true, redacted: true })
  })

  it('without a redactor the put is byte-identical to the pre-C2 behavior', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccr-store-'))
    dirs.push(root)
    const store = new CrusherStore(root)
    const pk = 'p'.repeat(16)
    const hash = await store.put(pk, CANARY)
    expect(hash).toBe(shortHash(CANARY))
    expect(await store.get(pk, hash)).toMatchObject({ ok: true, text: CANARY, redacted: false })
  })

  it('a redactor that leaves the text unchanged does not mark the envelope', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ccr-store-'))
    dirs.push(root)
    const store = new CrusherStore(root, Date.now, (text) => text)
    const pk = 'p'.repeat(16)
    const hash = await store.put(pk, 'clean text')
    expect(await store.get(pk, hash)).toMatchObject({ ok: true, text: 'clean text', redacted: false })
  })
})

/** Minimal settings provider double (settings-ns unit.spec shape). */
function fakeProvider(resolved: Record<string, unknown>) {
  const registrations = new Set<string>()
  return {
    register(ns: string) { registrations.add(ns) },
    get(ns: string) { return registrations.has(ns) ? structuredClone(resolved) : undefined },
  }
}

interface HarnessOptions {
  adapter: MockAdapter
  /** Live `cc-secrets` scope (namespace-resolved value). */
  secrets?: SecretsSettings
  /** Reuse a temp home so a second boot reads the same store. */
  home?: string
}

/** Real context-crusher boot (composition.spec harness shape). */
async function harness(opts: HarnessOptions): Promise<{ ctx: Context; agent: Agent; home: string }> {
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'ccr-home-'))
  if (opts.home === undefined) dirs.push(home)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  void new TokenMeter(ctx)
  ;(ctx as unknown as { dshHomePath: (...s: string[]) => string }).dshHomePath =
    (...segments: string[]) => join(home, ...segments)
  if (opts?.secrets !== undefined) {
    const registrations = new Set<string>()
    const provider = {
      register(ns: string) { registrations.add(ns) },
      get(ns: string) { return registrations.has(ns) ? structuredClone(opts.secrets) : undefined },
    }
    ctx.provide('settings', provider)
  }
  await ctx.plugin(ContextCrusher, { enabled: true, mode: 'on', 'min-bytes': 300, 'min-savings-ratio': 0.25 })
  ctx.tools.register(defineContentToolFixture({
    name: 'biggrep', description: 'b', parameters: {},
    async execute() { return [{ type: 'text', text: bigGrepOutput() }] },
  }))
  ctx.llm.registerAdapter(['mock'], opts.adapter)
  return { ctx, agent: await ctx.agentLoop.create(SessionId('ccr-sec1'), { provider: 'mock', model: 'mock' }), home }
}

/** A grep-shaped output large enough to clear the size gate, carrying the canary. */
function bigGrepOutput(): string {
  const lines: string[] = []
  for (let i = 0; i < 120; i++) {
    const file = `src/components/deeply/nested/really/long/module-path-${i % 4}.ts`
    lines.push(`${file}:${100 + i}:  someMatchyFunctionCall(argument-${i}, { option: ${i}, extra: 'padding to make the row long enough for a solid saving ratio' })`)
  }
  return `apikey=${CANARY}\n${lines.join('\n')}`
}

async function run(agent: Agent): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'search the code' }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function toolResultTexts(agent: Agent): string[] {
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

/** The ccr:// hash from the first crushed marker, if any. */
function crushedHash(agent: Agent): string | undefined {
  return toolResultTexts(agent).find((t) => t.includes('ccr://'))?.match(/ccr:\/\/([0-9a-f]{16})/)?.[1]
}

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('crusher store secrets (real boot, C2)', () => {
  it('stores the redacted form; context_retrieve output carries the note when the setting is on', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'biggrep', {}), textResponse('done')])
    const { agent, home } = await harness({ adapter, secrets: { extraPatterns: [], redactCrusherStore: true } })
    await run(agent)
    const hash = crushedHash(agent)
    expect(hash).toBeDefined()
    await waitFor(() => existsSync(join(home, 'ccr')))
    const projectDirs = readdirSync(join(home, 'ccr'))
    const stored = readFileSync(join(home, 'ccr', projectDirs[0]!, hash!), 'utf8')
    expect(stored).not.toContain(CANARY)
    expect(stored).toContain('[REDACTED]')

    // Retrieve through the REAL tool registry from a second boot over the SAME store.
    const retrieveAdapter = new MockAdapter([toolCallResponse('c2', 'context_retrieve', { hash }), textResponse('ok')])
    const { agent: agent2 } = await harness({ adapter: retrieveAdapter, home, secrets: { extraPatterns: [], redactCrusherStore: true } })
    await run(agent2)
    const retrieved = toolResultTexts(agent2).find((t) => t.includes('[REDACTED]'))
    expect(retrieved).toBeDefined()
    expect(retrieved!.endsWith(REDACT_NOTE)).toBe(true)
    expect(retrieved).not.toContain(CANARY)
  })

  it('redactCrusherStore=false keeps raw bytes in the store and omits the note', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'biggrep', {}), textResponse('done')])
    const { agent, home } = await harness({ adapter, secrets: { extraPatterns: [], redactCrusherStore: false } })
    await run(agent)
    const hash = crushedHash(agent)
    expect(hash).toBeDefined()
    await waitFor(() => existsSync(join(home, 'ccr')))
    const projectDirs = readdirSync(join(home, 'ccr'))
    const stored = readFileSync(join(home, 'ccr', projectDirs[0]!, hash!), 'utf8')
    expect(stored).toContain(CANARY)

    const retrieveAdapter = new MockAdapter([toolCallResponse('c2', 'context_retrieve', { hash }), textResponse('ok')])
    const { agent: agent2 } = await harness({ adapter: retrieveAdapter, home, secrets: { extraPatterns: [], redactCrusherStore: false } })
    await run(agent2)
    const retrieved = toolResultTexts(agent2).find((t) => t.includes(CANARY))
    expect(retrieved).toBeDefined()
    expect(retrieved).not.toContain(REDACT_NOTE)
  })
})
