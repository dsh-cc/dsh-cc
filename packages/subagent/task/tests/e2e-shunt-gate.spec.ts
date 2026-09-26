/**
 * End-to-end shunt-gate exemption through the FULL dsh-cc path
 * (docs/plans/2026-09-25-subagent-aware-shunt-gate.md §6.3): the real
 * `@dsh-cc/subagent-task` Task tool dispatching `subagent_type:
 * "dsh-cc-agents:critic"` over the real subagent runtime + in-process
 * spawn/fork providers, with BOTH real plugins (`dsh-cc-agents`,
 * `dsh-cc-shunt`) mounted from their repo paths through `@dsh-cc/plugin-loader`
 * onto the real hooks-claude-code bridge — only the LLM adapter is scripted.
 *
 * What is NOT mocked: the plugin loader (real `agents/` + `hooks/hooks.json`
 * from `packages/plugin/*` on disk, `${CLAUDE_PLUGIN_ROOT}` substituted),
 * the hook bridge (payload building, live-set identity, command-hook
 * dispatch), the shunt `check-file-size.mjs` gate, and the Task tool's
 * background/foreground/collect machinery.
 *
 * Round-3/4 note: the plugin-hooks-seam spec has no subagent runtime, so it
 * cannot cover the exemption — this spec closes that gap.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as ControlTools from '@deepseek-ai/dsh-tool-subagent-control'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse, toolCallResponse } from '@dsh-cc/agent-loop-mock'
import { defineContentToolFixture } from '@dsh-cc/tools'
import * as HooksClaude from '@dsh-cc/hooks-claude-code'
import { applyRoutes } from '@dsh-cc/model-aliases'
import { mountCcPlugin } from '@dsh-cc/plugin-loader'
import { apply as applyTask } from '../src/index.ts'

/** The real first-party plugins, mounted from the repo paths (no forks). */
const AGENTS_PLUGIN_DIR = resolve(import.meta.dirname, '../../../plugin/dsh-cc-agents')
const SHUNT_PLUGIN_DIR = resolve(import.meta.dirname, '../../../plugin/dsh-cc-shunt')

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

/**
 * Poll a predicate to a deadline (hook runs and child turns are detached).
 * `dump` renders diagnostic state into the deadline error, so a timeout is
 * self-evidencing (which payloads landed, how many model requests fired).
 */
async function waitFor(predicate: () => boolean, timeout = 20_000, dump?: () => string): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met before deadline${dump !== undefined ? `\nstate: ${dump()}` : ''}`)
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

/** Wait until a child's Activation is gone (its handle finished disposal). */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await waitFor(() => ctx.agents.get(childId) === undefined)
}

/**
 * A >350-line text fixture under the spec's own tmpdir (never the repo).
 * Created BEFORE setup() so its absolute path can be baked into the scripted
 * tool-call arguments (the mock queue is shared, so every read call must
 * already carry its concrete `file_path`).
 */
function newFixture(lines = 400): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-shunt-e2e-fixture-'))
  dirs.push(dir)
  const path = join(dir, 'bulk.txt')
  writeFileSync(path, `${Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n')}\n`)
  return path
}

/** A command hook that appends its stdin payload as one JSON line to `marker`. */
function capturingHook(dir: string, name: string, marker: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/usr/bin/env bash\ncat >> "${marker}"\necho >> "${marker}"\n`)
  chmodSync(path, 0o755)
  return path
}

function payloads(marker: string): Array<Record<string, unknown>> {
  if (!existsSync(marker)) return []
  return readFileSync(marker, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** The `tool-result` blocks of one model request — {text, isError} pairs.
 * NEVER scan a whole request's JSON: request messages include the system
 * prompt, whose plugin catalog legitimately mentions the shunt thresholds. */
function toolResults(request: { messages?: readonly unknown[] } | undefined): Array<{ text: string; isError: boolean }> {
  const out: Array<{ text: string; isError: boolean }> = []
  for (const message of request?.messages ?? []) {
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool-result') continue
      const inner = Array.isArray(block.content) ? block.content as Array<{ text?: string }> : []
      out.push({ text: inner.map(b => b.text ?? '').join('\n'), isError: block.isError === true })
    }
  }
  return out
}

let calls = 0
function callTool(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    agent: agent as never,
  })
}

/**
 * Boot the full dsh-cc composition: harness runtime stack + control tools +
 * the REAL Task plugin + the REAL hooks bridge with BOTH real plugins mounted
 * through the cc plugin loader. Only the model adapter is scripted.
 * `parkParent` keeps the parent out of the scripted corpus (its wake
 * pre-steps are rejected); the root-gate case unparks it to run a real turn.
 */
async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  opts: { parkParent?: boolean; agentsDir?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-shunt-e2e-'))
  dirs.push(dir)
  const marker = join(dir, 'payloads')
  // Probe command hooks mounted through the bridge's OWN boot config — the
  // exact mounting of the green SubagentStart precedent
  // (packages/hooks/hooks-claude-code/tests/background-subagent-start.spec.ts),
  // not the plugin seam, so the probe path carries no seam delta.
  const pre = capturingHook(dir, 'pre.sh', marker)
  const start = capturingHook(dir, 'start.sh', marker)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: pre }] }],
    SubagentStart: [{ hooks: [{ type: 'command', command: start }] }],
  } }))

  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistRoot = mkdtempSync(join(tmpdir(), 'dsh-cc-shunt-e2e-persist-'))
  dirs.push(persistRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: persistRoot })
  // sendMessage's cold-resume delivery resolves sessions through session-query.
  await ctx.plugin(SessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(ControlTools)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  // The REAL hooks bridge; the loader folds both plugins' hooks.json into its
  // `hooks` seam (probed via ctx.get('hooks')).
  await ctx.plugin(HooksClaude, { configPath: join(dir, 'hooks.json') })
  // The production cc `tools` service keeps disabled-row names restrictable;
  // the testkit ToolRuntime lacks that extension — add the minimal equivalent
  // so the Task plugin mounts identically (integration.spec.ts precedent).
  const tools = ctx.get('tools') as { reserve?(name: string): () => void }
  if (typeof tools.reserve !== 'function') {
    const reserved = new Set<string>()
    tools.reserve = (name: string) => {
      reserved.add(name)
      return () => { reserved.delete(name) }
    }
  }
  applyTask(ctx)
  // The critic frontmatter names `model: opus`; route it onto the mock adapter.
  applyRoutes(ctx, { modelAliases: { opus: { provider: 'mock', model: 'mock' } } })
  // A workspace root the Task registry and the parent session are bound to.
  const ws = join(dir, 'workspace')
  // The workspace dir MUST exist: hook commands run with the agent's session
  // cwd as workdir, and a nonexistent workdir is an infrastructure fault the
  // hook runner swallows into 'no exit code' — every hook (probes AND the
  // real shunt gate) silently never runs. (Probe-bisect finding.)
  mkdirSync(ws, { recursive: true })
  if (opts.agentsDir === true) {
    mkdirSync(join(ws, '.claude', 'agents'), { recursive: true })
    writeFileSync(
      join(ws, '.claude', 'agents', 'researcher.md'),
      '---\nname: researcher\ndescription: nested spawner\n---\nRESEARCHER PERSONA MARKER\n',
    )
  }
  // A real Read tool named like the harness built-in: the shunt gate's
  // `Read` matcher selects it through the bridge's ccToolAliases, and its
  // result is the actual fixture content.
  let readRuns = 0
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'read',
    parameters: {},
    async execute(args: { file_path?: string }) {
      readRuns += 1
      return [{ type: 'text', text: readFileSync(args.file_path!, 'utf8') }]
    },
  }))
  await mountCcPlugin(ctx, { root: AGENTS_PLUGIN_DIR })
  await mountCcPlugin(ctx, { root: SHUNT_PLUGIN_DIR })

  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: ws },
  )
  if (opts.parkParent !== false) {
    ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
      if (subject !== parent) return next()
      return { kind: 'reject' as const }
    })
  }
  return { ctx, parent, adapter, dir, marker, readRuns: () => readRuns }
}

/** Start the critic through the REAL Task tool and return its durable id. */
async function dispatchCritic(ctx: Context, parent: Agent, prompt: string): Promise<string> {
  const result = await callTool(ctx, 'subagent_fork', {
    description: 'review the bulk file',
    prompt,
    subagent_type: 'dsh-cc-agents:critic',
  }, parent)
  if (result.isError) throw new Error(`critic dispatch failed: ${text(result as never)}`)
  const agentId = /agentId: ([0-9a-f-]{36})/.exec(text(result as never))?.[1]
  expect(agentId, `background notice must name the durable id, got: ${text(result as never)}`).toBeTypeOf('string')
  return agentId!
}

function requestsFor(adapter: MockAdapter, sessionId: string) {
  return adapter.requests.filter(request => String(request.sessionId) === sessionId)
}

/** Diagnostic dump for waitFor deadlines: captured payloads + request counts. */
function dumpState(adapter: MockAdapter, marker: string): () => string {
  return () => `payloads=${JSON.stringify(payloads(marker))} requests=${JSON.stringify(
    adapter.requests.map(r => ({ session: String(r.sessionId), roles: (r.messages ?? []).map((m: { role?: string }) => m.role) })),
  )}`
}

describe('e2e — shunt gate exempts live subagents through the real plugin hook (§6.3)', () => {
  it('dispatches critic end-to-end: the child Read tool RESULT is file content (exemption delivered by the real hook)', async () => {
    const fixture = newFixture()
    const { ctx, parent, adapter, readRuns } = await setup([
      toolCallResponse('c1', 'read', { file_path: fixture }),
      textResponse('review done'),
    ])
    const agentId = await dispatchCritic(ctx, parent, 'review the file')
    // The critic pin (background: true) makes this a continuable background
    // start; the child runs its scripted turn to natural settlement.
    await waitNoActivation(ctx, SessionId(agentId))

    // The Read actually EXECUTED (no deny): the child's follow-up request
    // carries the tool RESULT — the fixture content, not a block. Asserted
    // on the tool-result block only (the system prompt legitimately mentions
    // the shunt thresholds in the plugin catalog).
    expect(readRuns()).toBe(1)
    const childRequests = requestsFor(adapter, agentId)
    expect(childRequests.length).toBeGreaterThanOrEqual(2)
    const result = toolResults(childRequests[1]).at(-1)
    expect(result, 'the child read produced a tool-result block').toBeDefined()
    expect(result!.isError).toBe(false)
    expect(result!.text).toContain('line 400')
    expect(result!.text).not.toContain('over the shunt threshold')
    expect(result!.text).not.toContain('bulk-reader')
  }, 30_000)

  it('the PreToolUse payload carried agent_id equal to the SubagentStart payload id for that child', async () => {
    const fixture = newFixture()
    const { ctx, parent, adapter, marker } = await setup([
      toolCallResponse('c1', 'read', { file_path: fixture }),
      textResponse('review done'),
    ])
    const agentId = await dispatchCritic(ctx, parent, 'review the file')
    await waitNoActivation(ctx, SessionId(agentId))
    // SubagentStart hook runs DETACHED (fire-and-forget) — waiting only for the
    // child's PreToolUse races it. Wait for BOTH payloads before asserting.
    await waitFor(
      () => payloads(marker).some(p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read')
        && payloads(marker).some(p => p.hook_event_name === 'SubagentStart'),
      20_000,
      dumpState(adapter, marker),
    )

    const startPayload = payloads(marker).find(p => p.hook_event_name === 'SubagentStart')
    expect(startPayload, `SubagentStart captured; payloads=${JSON.stringify(payloads(marker))}`).toBeDefined()
    expect(startPayload!.agent_id).toBe(agentId)
    const prePayload = payloads(marker).find(p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read')
    expect(prePayload, 'the child Read PreToolUse payload was captured').toBeDefined()
    // Identity is the SAME value across the two payloads for the child.
    expect(prePayload!.agent_id).toBe(startPayload!.agent_id)
    expect(prePayload!.agent_id).toBe(agentId)
  }, 30_000)

  it('a ROOT-agent Read of the same fixture is still blocked with the byte-identical golden reason', async () => {
    const fixture = newFixture()
    const { ctx, parent, adapter, marker, readRuns } = await setup([
      toolCallResponse('r1', 'read', { file_path: fixture }),
      textResponse('delegating instead'),
    ], { parkParent: false })

    // NOTE: observing the deny via an appended tools/pre-execute listener is
    // unsound — the bridge returns its merged decision WITHOUT calling next()
    // on deny, so an append-order listener never runs. The deny evidence is:
    // the tool body never executes (readRuns stays 0) and the follow-up model
    // request carries the denied tool-result.
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'read the file' }], source: { kind: 'user' } }))
    await parent.whenIdle()

    // Stage 1: the shunt bridge RAN for the root payload (probe captured it)
    // and the root payload carried NO agent_id (the live set never held it).
    await waitFor(
      () => payloads(marker).some(p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read'),
      20_000,
      dumpState(adapter, marker),
    )
    const rootPayload = payloads(marker).find(p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read')!
    expect(rootPayload.tool_input).toMatchObject({ file_path: fixture })
    expect(rootPayload).not.toHaveProperty('agent_id')
    // Stage 2: the gate denied — the tool body never ran.
    expect(readRuns()).toBe(0)
    // Stage 3: the byte-identical golden (line path) — pinned byte-for-byte
    // inside the denied tool-result delivered to the model (Stage 4 below).
    const kb = Math.max(1, Math.round(statSync(fixture).size / 1024))
    const golden =
      `File is 400 lines (~${kb} KB), over the shunt threshold (350 lines / 100000 bytes). ` +
      `To understand it, delegate via the "bulk-reader" skill instead of reading it into your context. ` +
      `For exact content to edit a specific section, re-read just that range with offset/limit — targeted reads always pass.`
    // Stage 4: what the MODEL sees is the error result carrying that reason —
    // asserted on the tool-result block only, never the whole request JSON.
    const followUp = requestsFor(adapter, 'parent').at(-1)
    const block = toolResults(followUp).at(-1)
    expect(block, 'the denied read produced a tool-result block').toBeDefined()
    expect(block!.isError).toBe(true)
    // Byte-identical golden delivered to the model verbatim (unit goldens in
    // the plugin spec own byte-exactness; here we pin it end-to-end).
    expect(block!.text).toContain(golden)
    expect(block!.text).not.toContain('line 400')
  }, 30_000)

  it('a subagent_type "fork" child is ALSO exempt (its Read result is content, payload carries agent_id)', async () => {
    const fixture = newFixture()
    const { ctx, parent, adapter, marker, readRuns } = await setup([
      toolCallResponse('f1', 'read', { file_path: fixture }),
      textResponse('fork done'),
    ])
    const result = await callTool(ctx, 'subagent_fork', {
      description: 'inherit and read',
      prompt: 'read the bulk file',
      subagent_type: 'fork',
    }, parent)
    expect(result.isError).toBe(false)

    expect(readRuns()).toBe(1)
    // The fork child's tool RESULT is content, not a block (tool-result block
    // only — the fork inherits parent turns whose prompts mention thresholds).
    const forkRequest = adapter.requests.find(request =>
      toolResults(request).some(block => block.text.includes('line 400')))
    expect(forkRequest, 'the fork child re-requested with its read result').toBeDefined()
    const forkResult = toolResults(forkRequest).find(block => block.text.includes('line 400'))!
    expect(forkResult.isError).toBe(false)
    expect(forkResult.text).not.toContain('over the shunt threshold')
    const forkId = String(forkRequest!.sessionId)
    // The fork child's Read PreToolUse payload carried its agent identity.
    await waitFor(
      () => payloads(marker).some(p =>
        p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read' && p.agent_id === forkId),
      20_000,
      dumpState(adapter, marker),
    )
    expect(payloads(marker).find(p =>
      p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read')!.agent_id).toBe(forkId)
  }, 30_000)

  it('a GRANDCHILD (a spawned unrestricted child of a spawned child) Read is exempt too', async () => {
    // The critic's shipped toolFilter has no Task tool, so the grandchild path
    // runs through a workspace file agent (no tools restriction → it holds
    // subagent_fork) dispatching a plain unrestricted child of its own.
    const fixture = newFixture()
    const { ctx, parent, adapter, marker } = await setup([
      // child (researcher): spawn the grandchild, then finish
      toolCallResponse('g0', 'subagent_fork', { description: 'nested', prompt: 'read it' }),
      textResponse('child done'),
      // grandchild: read the bulk file, then finish
      toolCallResponse('g1', 'read', { file_path: fixture }),
      textResponse('grandchild done'),
    ], { agentsDir: true })
    const result = await callTool(ctx, 'subagent_fork', {
      description: 'spawn the nested reader',
      prompt: 'delegate a reader',
      subagent_type: 'researcher',
    }, parent)
    expect(result.isError).toBe(false)

    // The grandchild's Read tool RESULT is content, not the block (exempt at
    // depth 2) — located by its tool-result block, never the whole request.
    await waitFor(
      () => adapter.requests.some(request => toolResults(request).some(block => block.text.includes('line 400'))),
      20_000,
      dumpState(adapter, marker),
    )
    const gcRequest = adapter.requests.filter(request =>
      toolResults(request).some(block => block.text.includes('line 400'))).at(-1)!
    const gcResult = toolResults(gcRequest).find(block => block.text.includes('line 400'))!
    expect(gcResult.isError).toBe(false)
    expect(gcResult.text).not.toContain('over the shunt threshold')
    // The grandchild's PreToolUse payload carried its own agent_id (start
    // precedes the first tool call at depth 2 as well).
    const readPayloads = payloads(marker).filter(p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read')
    expect(readPayloads.length, `Read payloads=${JSON.stringify(payloads(marker))}`).toBeGreaterThanOrEqual(1)
    const gcId = String(readPayloads.at(-1)!.agent_id)
    expect(gcId).not.toBe('')
    // …and equals the session id of the request that saw the content.
    expect(requestsFor(adapter, gcId).length).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it('a COLD-RESUMED critic child is still exempt (start re-emitted on the wake epoch)', async () => {
    const fixture = newFixture()
    const { ctx, parent, adapter, marker } = await setup([
      toolCallResponse('c1', 'read', { file_path: fixture }),
      textResponse('first pass done'),
      toolCallResponse('c2', 'read', { file_path: fixture }),
      textResponse('second pass done'),
    ])
    const agentId = await dispatchCritic(ctx, parent, 'review the file')
    const childId = SessionId(agentId)
    await waitNoActivation(ctx, childId)

    // Cold resume: with no resident Activation, send_message re-materializes
    // the child from its persisted session — a NEW epoch, so SubagentStart
    // re-emits (lifecycle.ts createActivationObserver.start) and the live set
    // re-adds the id before the resumed turn's tool calls.
    const send = await callTool(ctx, 'send_message', { agent_id: agentId, message: 'read it again' }, parent)
    expect(send.isError).toBe(false)
    // 4 child requests total: read→text (epoch 1), read→text (epoch 2).
    await waitFor(
      () => requestsFor(adapter, agentId).length >= 4,
      30_000,
      dumpState(adapter, marker),
    )

    // Both epochs' Read payloads carried the identity; the SECOND epoch's
    // start event was re-emitted for the same child id. SubagentStart hooks
    // run DETACHED (fire-and-forget command spawns), so under suite load the
    // two start payloads can land well after the pre-execute ones — wait for
    // them explicitly instead of racing the marker (combined-run evidence).
    await waitFor(
      () => payloads(marker).filter(p => p.hook_event_name === 'SubagentStart').length >= 2,
      30_000,
      dumpState(adapter, marker),
    )
    const readPayloads = payloads(marker).filter(p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Read')
    expect(readPayloads.length, `Read payloads=${JSON.stringify(payloads(marker))}`).toBeGreaterThanOrEqual(2)
    for (const payload of readPayloads) expect(payload.agent_id).toBe(agentId)
    const startPayloads = payloads(marker).filter(p => p.hook_event_name === 'SubagentStart')
    expect(startPayloads.length, `Start payloads=${JSON.stringify(payloads(marker))}`).toBeGreaterThanOrEqual(2)
    for (const payload of startPayloads) expect(payload.agent_id).toBe(agentId)
    // The woken child's second Read still returned CONTENT, not a block —
    // asserted on the tool-result block only.
    const second = toolResults(requestsFor(adapter, agentId).at(-1)).at(-1)
    expect(second, 'the woken read produced a tool-result block').toBeDefined()
    expect(second!.isError).toBe(false)
    expect(second!.text).toContain('line 400')
    expect(second!.text).not.toContain('over the shunt threshold')
    await waitNoActivation(ctx, childId)
  }, 40_000)
})
