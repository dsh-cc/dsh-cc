/**
 * End-to-end grok-review-bridge PreToolUse allow hook through the FULL
 * dsh-cc path (design §5 item 6): the real `@dsh-cc/subagent-task` Task tool
 * over the real subagent runtime, with the REAL `cc-grok-bridge` plugin
 * mounted from its repo path through `@dsh-cc/plugin-loader` onto the real
 * hooks-claude-code bridge — only the LLM adapter is scripted (MockAdapter).
 *
 * What is NOT mocked: the plugin loader (`hooks/hooks.json` +
 * `${CLAUDE_PLUGIN_ROOT}` substitution), the hook bridge (payload building,
 * matcher dispatch, allow/ask/deny waterfall), the allow hook's node
 * subprocess itself, and the canonical launcher execution.
 *
 * Observable marker convention: an ALLOWED canonical call EXECUTES the real
 * launcher; with grok unresolvable it exits non-zero with a
 * `grok-review:`-prefixed message — that marker in the tool result is the
 * execution-past-the-bridge proof. A DENIED call never executes.
 *
 * HERMETICITY INVARIANT (load-bearing): an allowed canonical call runs the
 * real launcher, which PATH-resolves the grok CLI. PATH is pinned to the
 * node dir + a dedicated bin dir holding only the links this suite needs
 * (grok NOT reachable; the preflight below fails loud if it ever resolves)
 * and HOME to an empty tmpdir, so the launcher fail-louds on stderr instead
 * of ever touching the network or credentials. Vitest runs each spec file in
 * its own worker process, so the swap below is file-scoped.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
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
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyTask } from '../src/index.ts'

// TIMEOUT-BUDGET: keep byte-identical across spec files.
// scale: DSH_TEST_TIMEOUT_SCALE (debug override), else 2 on GitHub Actions, else 1.
// Must be an integer in [1,4]; anything else → 1. Values >2 exceed what R4 was sized for.
const raw = Number(process.env.DSH_TEST_TIMEOUT_SCALE ?? (process.env.CI === 'true' ? 2 : 1))
const scale = Number.isInteger(raw) && raw >= 1 && raw <= 4 ? raw : 1

// --- F1 lifecycle envelope + per-test world disposal (docs/plans/2026-10-03-ci-test-stability.md, F1) ---

vi.setConfig({ hookTimeout: 15_000 }) // flat, unscaled: hooks are teardown; contention does not multiply housekeeping need.

interface Envelope {
  /** Milliseconds left before the envelope expiry (never negative). */
  remaining(): number
  /** Record a timestamped phase marker for the expiry dump (F1.5). */
  phase(label: string): void
}

const ENVELOPE_HEADROOM_MS = 30_000
let activeEnvelope: Envelope | undefined
let envDump: () => string = () => 'state unavailable (setup incomplete)'

/** One booted (or half-built) per-test world, registered at construction. */
interface World {
  ctx: Context
  parentSessionId: SessionId
  sealed: boolean
  /** In-flight start admissions (fork promises), recorded at creation. */
  inflight: Array<Promise<unknown>>
}
const worlds: World[] = []

function registryAgents(world: World): Array<{ id: unknown; cancel: (authority: unknown, opts: unknown) => unknown }> {
  const agents = (world.ctx as unknown as { agents?: { list?: () => Array<{ id: unknown; cancel: (authority: unknown, opts: unknown) => unknown }> } }).agents
  try {
    return agents?.list?.() ?? []
  } catch {
    return [] // half-built world: the agents seam was never mounted
  }
}

function joinBounded(ps: Array<Promise<unknown>>, deadline: number): Promise<void> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, remaining)
    void Promise.allSettled(ps).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * F1.1: one inner envelope per test, opened BEFORE the body's setup() runs.
 * envelopeMs = outerMs − 30s, so setup → fork await → polls →
 * waitNoActivation share a single deadline that always fires 30s before
 * vitest's outer timer, with a timestamped phase dump (F1.5) instead of the
 * bare `Test timed out` signature.
 */
function withEnvelope<T>(outerMs: number, label: string, body: (env: Envelope) => Promise<T>): Promise<T> {
  const ms = outerMs - ENVELOPE_HEADROOM_MS
  const start = Date.now()
  const phases: string[] = []
  const env: Envelope = {
    remaining: () => Math.max(0, ms - (Date.now() - start)),
    phase: (text: string) => phases.push(`${text} @ +${((Date.now() - start) / 1000).toFixed(2)}s`),
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `envelope expired in "${label}": inner deadline ${ms}ms (outer ${outerMs}ms − ${ENVELOPE_HEADROOM_MS}ms headroom)`
      + ` elapsed from ${new Date(start).toISOString()} to ${new Date().toISOString()}`
      + `\nphases: ${phases.join(' | ') || '(none recorded)'}`
      + `\nworlds: ${JSON.stringify(worlds.map(w => ({ sealed: w.sealed, agents: registryAgents(w).map(a => String(a.id)) })))}`
      + `\nstate: ${envDump()}`,
    )), ms)
  })
  activeEnvelope = env
  return Promise.race([
    body(env).finally(() => {
      clearTimeout(timer)
      if (activeEnvelope === env) activeEnvelope = undefined
    }),
    expiry,
  ])
}

/** Await a promise under an explicit deadline taken from the envelope (F1.1). */
async function awaitBounded<T>(p: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  if (timeoutMs <= 0) throw new Error(`${what}: envelope already exhausted (remaining ${timeoutMs}ms)`)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: not settled within ${timeoutMs}ms (envelope remaining)`)), timeoutMs)
  })
  try {
    return await Promise.race([p, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * F1.3: per-test world disposal, in the pinned order seal → bounded-join →
 * bounded-interrupt → dispose, inside ONE shared teardown window clamped
 * under the 15s hookTimeout ceiling. Window expiry logs a
 * `teardown-incomplete` marker line and CONTINUES; the registry is cleared
 * regardless. Guarantees (D1): no new tool executions/spawns after seal
 * (seal wraps ctx.tools.execute — the only admission path in this world),
 * in-flight admissions bounded-joined, bounded interrupt via the live Agent
 * handles' cancel(), dispose joined to the same window; seal/interrupt/
 * dispose are tolerated no-ops on half-built worlds.
 */
afterEach(async () => {
  const windowMs = Math.min(4_000 * scale, 13_000)
  const deadline = Date.now() + windowMs
  const worldsToDispose = worlds.splice(0)
  for (const world of worldsToDispose) {
    // (a) seal: no new spawns/tool executions admitted.
    world.sealed = true
    // (b) bounded-join of any in-flight start admission.
    await joinBounded(world.inflight, deadline)
    // (c) bounded interrupt of registered live children (tolerated no-op on
    // an already-settled or half-built agent); the interrupt's drain is
    // joined by dispose below, itself bounded by the same window.
    for (const agent of registryAgents(world)) {
      try {
        agent.cancel({ kind: 'parent' }, { keepInbox: true })
      } catch { /* tolerated no-op */ }
    }
    // (d) dispose/finalize of the ctx — joined to the SAME window; its own
    // hang cannot outlive it.
    await joinBounded([world.ctx.fiber.dispose()], deadline)
  }
  // (e) the registry is cleared regardless (splice above); expiry is a
  // marker, not a teardown precondition.
  if (Date.now() > deadline) {
    console.log(`[teardown-incomplete] teardown window ${windowMs}ms exhausted after ${worldsToDispose.length} world(s); registry cleared`)
  }
})

const BRIDGE_PLUGIN_DIR = resolve(import.meta.dirname, '../../../plugin/cc-grok-bridge')

// --- File-scoped hermeticity swap (see header comment). ---
const SAVED_PATH = process.env.PATH
const SAVED_HOME = process.env.HOME
const E2E_HOME = mkdtempSync(join(tmpdir(), 'grok-bridge-e2e-home-'))
// Dedicated bin dir with ONLY the links this suite needs (bash for the
// fixture tool; node comes from its own dir) — grok must NOT resolve.
const E2E_BIN = mkdtempSync(join(tmpdir(), 'grok-bridge-e2e-bin-'))
for (const needed of ['bash', 'sh', 'env', 'dirname', 'cat', 'touch']) {
  try {
    symlinkSync(spawnSync('sh', ['-c', 'command -v ' + needed], { encoding: 'utf8' }).stdout.trim(), join(E2E_BIN, needed))
  } catch {
    /* absent helper — the suite does not need it */
  }
}
process.env.PATH = [dirname(realpathSync(process.execPath)), E2E_BIN].join(delimiter)
process.env.HOME = E2E_HOME

afterAll(() => {
  process.env.PATH = SAVED_PATH
  process.env.HOME = SAVED_HOME
  rmSync(E2E_HOME, { recursive: true, force: true })
  rmSync(E2E_BIN, { recursive: true, force: true })
})

// PREFLIGHT (fails LOUD, never skips): grok must NOT resolve under the
// hermetic PATH — an accidental real-grok passthrough would consume network
// + quota from an e2e suite.
{
  const probe = spawnSync('grok', ['--version'], { encoding: 'utf8' })
  if (!probe.error) {
    throw new Error(
      `grok-bridge e2e preflight: 'grok' resolves under the hermetic PATH (${process.env.PATH}). ` +
      `Remedy: keep the dedicated bin dir free of a grok link — the suite must never reach the real CLI.`,
    )
  }
  // The bridge must arm in this environment — the node binary and the repo
  // launcher must sit outside the hook's refusal triple
  // {realpath(cwd), realpath(tmpdir), realpath('/tmp')}. The session
  // workspace is an mkdtemp under tmpdir, so the repo-path anchors arm
  // naturally; a pathological environment must fail here with a remedy.
  const node = realpathSync(process.execPath)
  const launcher = realpathSync(join(BRIDGE_PLUGIN_DIR, 'scripts', 'grok-review-run.mjs'))
  const tmpReal = realpathSync(tmpdir())
  const insideTmp = (p: string) => p === tmpReal || p.startsWith(tmpReal + '/')
  if (insideTmp(node) || insideTmp(launcher)) {
    throw new Error(
      `grok-bridge e2e preflight: refusal set swallows an anchor (node=${node}, launcher=${launcher} ` +
      `is inside ${tmpReal}). Remedy: run from a repo checkout outside the canonical tmp roots ` +
      `(e.g. not under /tmp or the system tempdir), and ensure node itself resolves outside them.`,
    )
  }
}

/** The hook's own anchor derivation — the byte-pinned command bytes. */
const NODE = realpathSync(process.execPath)
const LAUNCHER = realpathSync(join(BRIDGE_PLUGIN_DIR, 'scripts', 'grok-review-run.mjs'))
const CANONICAL = `${NODE} ${LAUNCHER} -- 'review the failing spec'`

const dirs: string[] = []
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

async function waitFor(predicate: () => boolean, timeout = 30_000, dump?: () => string): Promise<void> {
  activeEnvelope?.phase(`poll entered: ${predicate.toString().slice(0, 80)}`)
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met before deadline${dump !== undefined ? `\nstate: ${dump()}` : ''}`)
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

async function waitNoActivation(ctx: Context, childId: SessionId, timeout: number): Promise<void> {
  await waitFor(() => ctx.agents.get(childId) === undefined, timeout)
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function toolResults(request: { messages?: readonly unknown[] } | undefined): Array<{ text: string; isError: boolean }> {
  const out: Array<{ text: string; isError: boolean }> = []
  for (const message of request?.messages ?? []) {
    // v4 ToolResultMessage: role 'tool' with flat content blocks + message-level isError.
    const m = message as { role?: string; isError?: boolean; content?: unknown }
    if (m.role === 'tool') {
      const blocks = Array.isArray(m.content) ? m.content as Array<{ text?: string }> : []
      out.push({ text: blocks.map(b => b.text ?? '').join('\n'), isError: m.isError === true })
      continue
    }
    const content = m.content
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
// The mounted cc-grok-bridge plugin (commands seam + hook surface), set by setup.
let bridgeMount: Awaited<ReturnType<typeof mountCcPlugin>> | undefined
function callTool(ctx: Context, name: string, args: unknown, agent: Agent) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++calls}`),
    name,
    arguments: args,
    agent: agent as never,
  })
}

/** Every bash command that actually EXECUTED (past the waterfall) in this worker. */
const executedCommands: string[] = []

/**
 * Boot the full dsh-cc composition with the REAL cc-grok-bridge plugin
 * mounted; only the model adapter is scripted. The parent is NOT parked for
 * the main-thread rows (they drive a real parent turn); child rows park it.
 */
async function setup(script: ConstructorParameters<typeof MockAdapter>[0], opts: { agentsDir?: boolean; parkParent?: boolean } = {}) {
  executedCommands.length = 0
  bridgeMount = undefined
  const dir = mkdtempSync(join(tmpdir(), 'grok-bridge-e2e-'))
  dirs.push(dir)
  const ctx = new Context()
  // F1.3: registered at CONSTRUCTION, not on completion — an envelope abort
  // midway through setup still leaves the half-built world inside the
  // afterEach disposal pass (grok r4-6).
  const world: World = { ctx, parentSessionId: SessionId('parent'), sealed: false, inflight: [] }
  worlds.push(world)
  await mountAgentLoopTestDependencies(ctx)
  const persistRoot = mkdtempSync(join(tmpdir(), 'grok-bridge-e2e-persist-'))
  dirs.push(persistRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: persistRoot })
  await ctx.plugin(SessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(ControlTools)
  await ctx.plugin(LocalSubprocessRuntime)
  // The shell service the hooks bridge injects (`inject = ['shell']`) —
  // command hooks (probe AND the plugin's allow hook) never run without it.
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  // A probe command hook (shunt e2e precedent): captures every PreToolUse
  // payload the bridge dispatches, proving the plugin hook actually ran and
  // with what tool_name — and lets M4 assert the allow hook's silence.
  const marker = join(dir, 'probe-payloads')
  const pre = join(dir, 'probe.sh')
  writeFileSync(pre, `#!/usr/bin/env bash\ncat >> "${marker}"\necho >> "${marker}"\n`)
  chmodSync(pre, 0o755)
  // Side-band witness that the SessionStart edge fired at all (rc.2: the
  // agent/created announcement that agentLoop.create() performs carries it):
  // an absent marker means the event never fired in this assembly; a present
  // marker with no armed block means the plugin context hook ran silently.
  const sessionStartRan = join(dir, 'session-start-ran')
  const ssTouch = join(dir, 'session-start.sh')
  writeFileSync(ssTouch, `#!/usr/bin/env bash\ntouch "${sessionStartRan}"\n`)
  chmodSync(ssTouch, 0o755)
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: pre }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: ssTouch }] }],
  } }))
  await ctx.plugin(HooksClaude, { configPath: join(dir, 'hooks.json') })
  const tools = ctx.get('tools') as { reserve?(name: string): () => void }
  if (typeof tools.reserve !== 'function') {
    const reserved = new Set<string>()
    tools.reserve = (name: string) => {
      reserved.add(name)
      return () => { reserved.delete(name) }
    }
  }
  // F1.3 (a) seal primitive (D1): after seal, new tool executions — and
  // therefore new spawns/admissions, all of which route through the tools
  // seam in this composition — are refused on this world.
  const toolsService = ctx.tools as unknown as { execute: (call: unknown) => Promise<unknown> }
  const rawExecute = toolsService.execute.bind(toolsService)
  toolsService.execute = (call: unknown) => {
    if (world.sealed) return Promise.reject(new Error('world sealed for teardown: new tool execution refused'))
    return rawExecute(call)
  }
  applyTask(ctx)
  applyRoutes(ctx, { modelAliases: { opus: { provider: 'mock', model: 'mock' } } })
  // Session workspace = mkdtemp under os.tmpdir(): the repo-path launcher
  // anchor sits OUTSIDE the hook's refusal set, so the bridge arms naturally.
  const ws = join(dir, 'workspace')
  mkdirSync(ws, { recursive: true })
  if (opts.agentsDir === true) {
    mkdirSync(join(ws, '.claude', 'agents'), { recursive: true })
    writeFileSync(
      join(ws, '.claude', 'agents', 'researcher.md'),
      '---\nname: researcher\ndescription: child runner\ntools: [Bash, Read]\n---\nRESEARCHER PERSONA MARKER\n',
    )
    writeFileSync(
      join(ws, '.claude', 'agents', 'reader.md'),
      '---\nname: reader\ndescription: read-only child\ntools: [Read]\nephemeral: false\n---\nREADER PERSONA MARKER\n',
    )
  }
  // A real Bash tool named like the harness built-in (`bash` — the bridge
  // alias-maps it onto the CC name `Bash` in the hook payload, so the hook's
  // `Bash` matcher selects it), and an allowed call genuinely executes — the
  // launcher's `grok-review:` stderr is the execution marker. Hermetic:
  // PATH is pinned at file scope (grok absent).
  ctx.tools.register(defineContentToolFixture({
    name: 'bash',
    description: 'bash',
    parameters: {},
    async execute(args: { command?: string }) {
      const command = args.command ?? ''
      executedCommands.push(command)
      // F1.6: envelope-clamped via the remainder-with-guard rule — never
      // spend a deadline that is already empty.
      const remaining = activeEnvelope !== undefined ? activeEnvelope.remaining() : 60_000
      const timeout = remaining - 1_000
      if (timeout <= 1_000) throw new Error(`fixture spawn refused: envelope remaining ${remaining}ms <= 1000ms (fail fast without spawning)`)
      const res = spawnSync('bash', ['-c', command], { cwd: ws, encoding: 'utf8', timeout })
      const out = [res.stdout, res.stderr].filter(s => s !== '').join('\n')
      return [{ type: 'text', text: out }]
    },
  }))
  // The bare testkit assembly has no commands service, and without one the
  // loader skips plugin command mounting ("commands seam 'commands' is not
  // mounted", cc-plugin-loader/src/commands.ts). This recording stub keeps
  // the mount/render path real; S2 invokes the loader-rendered
  // MountedPluginCommand.run directly, so no harness registry is under test.
  const commandRegistry = new Map<string, unknown>()
  ctx.provide('commands', {
    register: (definition: { name: string }) => {
      commandRegistry.set(definition.name, definition)
      return () => { commandRegistry.delete(definition.name) }
    },
  } as never)
  await mountCcPlugin(ctx, { root: BRIDGE_PLUGIN_DIR }).then(m => { bridgeMount = m })

  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: ws },
  )
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent || opts.parkParent === false) return next()
    return { kind: 'reject' as const }
  })
  return { ctx, parent, adapter, dir, ws, marker, sessionStartRan, mount: bridgeMount!, world }
}

function requestsFor(adapter: MockAdapter, sessionId: string) {
  return adapter.requests.filter(request => String(request.sessionId) === sessionId)
}

/**
 * Provisional read (F1.4): while the owning child may still be live, exactly
 * ONE unterminated trailing line is tolerated (a torn mid-write read);
 * completed lines always pass through throwing `JSON.parse`.
 */
function provisionalPayloads(marker: string): Array<Record<string, unknown>> {
  if (!existsSync(marker)) return []
  const lines = readFileSync(marker, 'utf8').split('\n')
  if (lines.at(-1) !== '') lines.pop() // the single tolerated unterminated trailing line
  return lines.filter(l => l.trim() !== '').map(l => JSON.parse(l))
}

/** TERMINAL read (F1.4): re-parses the whole file strictly — a writer that exits with a truncated final record fails loudly. */
function payloads(marker: string): Array<Record<string, unknown>> {
  if (!existsSync(marker)) return []
  return readFileSync(marker, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
}

/** Diagnostic dump for waitFor deadlines. */
function dumpState(adapter: MockAdapter, marker = ''): () => string {
  return () => `executed=${JSON.stringify(executedCommands)}${marker !== '' ? ` payloads=${JSON.stringify(provisionalPayloads(marker))}` : ''} requests=${JSON.stringify(
    adapter.requests.map(r => ({ session: String(r.sessionId), results: toolResults(r).map(b => b.text.slice(0, 120)) })),
  )}`
}

/** A downstream (append-order, so AFTER the bridge's prepended listener)
 * tools/pre-execute listener deciding only on the exact given command string
 * (default: the canonical invocation). */
function gateCanonical(ctx: Context, verdict: 'deny' | 'ask', command: string = CANONICAL): void {
  ctx.on('tools/pre-execute', async (exec: { name?: string; arguments?: { command?: string } }, next) => {
    if (exec?.name !== 'bash' || exec?.arguments?.command !== command) return next()
    return verdict === 'deny' ? { kind: 'deny', reason: 'downstream deny' } : { kind: 'ask', reason: 'downstream ask' }
  })
}

describe('e2e — grok-review-bridge PreToolUse allow hook through the real plugin', () => {
  it('M1: canonical call on the main thread is allowed and EXECUTES the launcher (grok-review: marker)', () => withEnvelope(90_000, 'M1', async env => {
    const { ctx, parent, adapter, marker } = await setup([
      toolCallResponse('r1', 'bash', { command: CANONICAL }),
      textResponse('review attempted'),
    ], { parkParent: false })
    env.phase('setup-done')
    envDump = dumpState(adapter, marker)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the review' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    // Stage 1: the bridge DISPATCHED the Bash PreToolUse payload (the plugin
    // hook actually ran, matcher subject + command bytes correct).
    await waitFor(
      () => payloads(marker).some(p =>
        p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash'
        && (p.tool_input as { command?: string })?.command === CANONICAL),
      env.remaining(),
      dumpState(adapter, marker),
    )
    // Stage 2: the call executed past the bridge (launcher marker).
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).some(b => b.text.includes('grok-review:'))),
      env.remaining(),
      dumpState(adapter, marker),
    )
    const result = toolResults(requestsFor(adapter, 'parent').find(r => toolResults(r).some(b => b.text.includes('grok-review:')))).find(b => b.text.includes('grok-review:'))!
    expect(executedCommands).toContain(CANONICAL)
    expect(result.text).toContain('grok-review:')
  }), 90_000) // envelope 60_000 < outer 90_000: strict 30s headroom, setup inside the envelope

  it('M4 control: a non-canonical echo is the unchanged passthrough flow (no marker)', () => withEnvelope(90_000, 'M4', async env => {
    const { parent, adapter, marker } = await setup([
      toolCallResponse('r1', 'bash', { command: 'echo hello' }),
      textResponse('done'),
    ], { parkParent: false })
    env.phase('setup-done')
    envDump = dumpState(adapter, marker)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'echo' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).length > 0),
      env.remaining(),
      dumpState(adapter, marker),
    )
    // The bridge DISPATCHED the Bash payload; the allow hook stayed silent
    // for the non-canonical command (no canonical execution lineage).
    expect(payloads(marker).some(p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash')).toBe(true)
    const results = toolResults(requestsFor(adapter, 'parent').at(-1))
    expect(results.length).toBeGreaterThanOrEqual(1)
    // Hook stayed silent: no allow verdict, no launcher execution.
    expect(results.some(b => b.text.includes('grok-review:'))).toBe(false)
    expect(results.at(-1)!.isError).toBe(false)
    expect(results.at(-1)!.text).toContain('hello')
    expect(executedCommands).toContain('echo hello')
  }), 90_000) // envelope 60_000 < outer 90_000: strict 30s headroom, setup inside the envelope

  it('M2: a downstream deny for the canonical call is NEVER flipped by the hook allow', () => withEnvelope(90_000, 'M2', async env => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('r1', 'bash', { command: CANONICAL }),
      textResponse('unreachable'),
    ], { parkParent: false })
    env.phase('setup-done')
    envDump = dumpState(adapter)
    // Registered AFTER the bridge mount → append order = downstream of the
    // bridge's {prepend:true} listener; a deny short-circuits and the hook
    // allow can never resurrect it.
    gateCanonical(ctx, 'deny')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the review' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).some(b => b.isError)),
      env.remaining(),
      dumpState(adapter),
    )
    const denied = toolResults(requestsFor(adapter, 'parent').find(r => toolResults(r).some(b => b.isError))!)
      .find(b => b.isError)!
    expect(denied.isError).toBe(true)
    expect(denied.text).not.toContain('grok-review:')
    expect(executedCommands).not.toContain(CANONICAL)
  }), 90_000) // envelope 60_000 < outer 90_000: strict 30s headroom, setup inside the envelope

  it('M3: a downstream ask for the canonical call is downgraded to allow (marker present)', () => withEnvelope(90_000, 'M3', async env => {
    const { ctx, parent, adapter, marker } = await setup([
      toolCallResponse('r1', 'bash', { command: CANONICAL }),
      textResponse('review attempted'),
    ], { parkParent: false })
    env.phase('setup-done')
    envDump = dumpState(adapter, marker)
    gateCanonical(ctx, 'ask')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the review' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    // The hook RAN for this payload (evidence the downgrade is hook-driven).
    await waitFor(
      () => payloads(marker).some(p =>
        p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash'),
      env.remaining(),
      dumpState(adapter, marker),
    )
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).some(b => b.text.includes('grok-review:'))),
      env.remaining(),
      dumpState(adapter),
    )
    expect(executedCommands).toContain(CANONICAL)
  }), 90_000) // envelope 60_000 < outer 90_000: strict 30s headroom, setup inside the envelope

  it('M5: a tool-restricted child\'s canonical bash call traverses the same hook and is allowed', () => withEnvelope(120_000, 'M5', async env => {
    const { ctx, parent, adapter, marker, world } = await setup([
      toolCallResponse('c1', 'bash', { command: CANONICAL }),
      textResponse('child done'),
    ], { agentsDir: true })
    env.phase('setup-done')
    envDump = dumpState(adapter, marker)
    env.phase('fork-dispatched')
    const forkPromise = callTool(ctx, 'subagent_fork', {
      description: 'child review',
      prompt: 'run the review',
      subagent_type: 'researcher',
    }, parent)
    // F1.1: the fork promise's rejection is recorded at creation (no floating
    // promise); afterEach bounded-joins this registration even when the
    // envelope expires while the bounded await below is still pending.
    world.inflight.push(forkPromise)
    const result = await awaitBounded(forkPromise, env.remaining(), 'fork: subagent_fork')
    env.phase('fork-resolved')
    expect(result.isError).toBe(false)
    // The bridge DISPATCHED the child's bash call to the plugin hook — the
    // probe payload carries the CC caller-identity field (agent_id), which is
    // what ties this traversal row to the child rather than the parent.
    await waitFor(
      () => payloads(marker).some(p =>
        p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash'
        && (p.tool_input as { command?: string })?.command === CANONICAL
        && typeof p.agent_id === 'string' && p.agent_id !== ''),
      env.remaining(),
      dumpState(adapter, marker),
    )
    await waitFor(
      () => adapter.requests.some(r => toolResults(r).some(b => b.text.includes('grok-review:'))),
      env.remaining(),
      dumpState(adapter),
    )
    const childRequest = adapter.requests.find(r => toolResults(r).some(b => b.text.includes('grok-review:')))
    expect(String(childRequest!.sessionId)).not.toBe('parent')
    expect(executedCommands).toContain(CANONICAL)
    await waitNoActivation(ctx, SessionId(String(childRequest!.sessionId)), env.remaining())
  }), 120_000) // envelope 90_000 < outer 120_000: strict 30s headroom, setup inside the envelope

  it('M6 control: a read-only child\'s echo is denied by its toolFilter — never executed, no marker', () => withEnvelope(120_000, 'M6', async env => {
    const { ctx, parent, adapter, world } = await setup([
      toolCallResponse('c1', 'bash', { command: 'echo hello' }),
      textResponse('child done'),
    ], { agentsDir: true })
    env.phase('setup-done')
    envDump = dumpState(adapter)
    env.phase('fork-dispatched')
    const forkPromise = callTool(ctx, 'subagent_fork', {
      description: 'child echo',
      prompt: 'echo',
      subagent_type: 'reader',
    }, parent)
    // F1.1: the fork promise's rejection is recorded at creation (no floating
    // promise); afterEach bounded-joins this registration even when the
    // envelope expires while the bounded await below is still pending.
    world.inflight.push(forkPromise)
    const result = await awaitBounded(forkPromise, env.remaining(), 'fork: subagent_fork')
    env.phase('fork-resolved')
    expect(result.isError).toBe(false)
    await waitFor(
      () => adapter.requests.some(r => String(r.sessionId) !== 'parent' && toolResults(r).some(b => b.isError)),
      env.remaining(),
      dumpState(adapter),
    )
    const childRequest = adapter.requests.find(r => String(r.sessionId) !== 'parent' && toolResults(r).some(b => b.isError))!
    const denied = toolResults(childRequest).find(b => b.isError)!
    expect(denied.text).not.toContain('grok-review:')
    expect(executedCommands).not.toContain('echo hello')
    await waitNoActivation(ctx, SessionId(String(childRequest!.sessionId)), env.remaining())
  }), 120_000) // envelope 90_000 < outer 120_000: strict 30s headroom, setup inside the envelope
})

describe('e2e — grok-review-bridge entry surface: SessionStart context + review command', () => {
  /** All text blocks across a request's serialized messages. */
  function requestTexts(request: { messages?: readonly unknown[] } | undefined): string[] {
    const out: string[] = []
    for (const message of request?.messages ?? []) {
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
      }
    }
    return out
  }

  it('S1: the SessionStart context hook lands the armed canonical block in the parent\'s messages', () => withEnvelope(90_000, 'S1', async env => {
    const { parent, adapter, sessionStartRan } = await setup([
      textResponse('acknowledged'),
    ], { parkParent: false })
    env.phase('setup-done')
    envDump = dumpState(adapter)
    // Side-band first: the SessionStart edge (rc.2 agent/created) fired at
    // all in this assembly
    // (detached witness hook). Then synchronize on the injected block in the
    // NEXT-STEP INBOX — the SessionStart hook runs detached, agent.inject
    // lands in inbox.nextStep and becomes a user/message only after step
    // entry, so wait for the inbox before the followup and the FIRST request
    // already carries the block.
    await waitFor(() => existsSync(sessionStartRan), env.remaining(), dumpState(adapter))
    await waitFor(
      () => (parent as unknown as { inbox: { nextStep: Array<{ content: Array<{ type: string; text?: string }> }> } })
        .inbox.nextStep.some(message =>
          message.content.some(block => block.type === 'text'
            && (block.text ?? '').includes('Grok review lane is ARMED')
            && (block.text ?? '').includes(`'${LAUNCHER}'`)
            && (block.text ?? '').includes('--prompt-file'))),
      env.remaining(),
      dumpState(adapter),
    )
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(requestTexts(requestsFor(adapter, 'parent').at(0)).join('\n')).toContain('Grok review lane is ARMED')
  }), 90_000) // envelope 60_000 < outer 90_000: strict 30s headroom, setup inside the envelope

  it('S2: the mounted /review command renders its template into the parent; the scripted model then issues exactly one canonical call', () => withEnvelope(90_000, 'S2', async env => {
    const { parent, adapter, marker, mount } = await setup([
      toolCallResponse('r1', 'bash', { command: CANONICAL }),
      textResponse('review attempted'),
    ], { parkParent: false })
    env.phase('setup-done')
    envDump = dumpState(adapter, marker)
    const review = mount.commands.find(c => c.info.name === 'cc-grok-bridge:review')
    expect(review).toBeDefined()
    // The real seam: the loader's MountedPluginCommand.run substitutes
    // $ARGUMENTS and dispatches the rendered body via agent.followup.
    const result = await review!.run({ rawInput: 'review the failing spec', agent: parent })
    expect(result.kind).toBe('success')
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).some(b => b.text.includes('grok-review:'))),
      env.remaining(),
      dumpState(adapter, marker),
    )
    // The plugin command's rendered template reached the parent (the body's
    // fail-closed clause is in the model-visible prompt).
    expect(requestTexts(requestsFor(adapter, 'parent').at(0)).join('\n')).toContain('SessionStart')
    // Template → exactly one canonical argv call, allowed and executed.
    expect(executedCommands.filter(c => c === CANONICAL)).toHaveLength(1)
    expect(payloads(marker).some(p =>
      p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash'
      && (p.tool_input as { command?: string })?.command === CANONICAL)).toBe(true)
  }), 90_000) // envelope 60_000 < outer 90_000: strict 30s headroom, setup inside the envelope

  it('S3 control: a hand-rolled near-miss invocation fails closed (downstream ask stands, no marker)', () => withEnvelope(90_000, 'S3', async env => {
    // The model free-forms a PATH-trampoline `node` bare name — never
    // byte-equal to the canonical anchor. The hook stays silent for it; the
    // scripted downstream ask for exactly that string then stands (nothing
    // may downgrade it), so the call fails closed.
    const NEAR_MISS = `node ${LAUNCHER} -- 'review the failing spec'`
    const { ctx, parent, adapter, marker } = await setup([
      toolCallResponse('r1', 'bash', { command: NEAR_MISS }),
      textResponse('unreachable'),
    ], { parkParent: false })
    env.phase('setup-done')
    envDump = dumpState(adapter, marker)
    gateCanonical(ctx, 'ask', NEAR_MISS)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the review' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).some(b => b.isError)),
      env.remaining(),
      dumpState(adapter, marker),
    )
    const failed = toolResults(requestsFor(adapter, 'parent').find(r => toolResults(r).some(b => b.isError))!)
      .find(b => b.isError)!
    expect(failed.isError).toBe(true)
    expect(failed.text).not.toContain('grok-review:')
    expect(executedCommands).not.toContain(NEAR_MISS)
  }), 90_000) // envelope 60_000 < outer 90_000: strict 30s headroom, setup inside the envelope
})
