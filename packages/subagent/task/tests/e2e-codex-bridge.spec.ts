/**
 * End-to-end codex-rescue-bridge PreToolUse allow hook through the FULL
 * dsh-cc path (plan §3.2 / §9 S2, §10 PR-2): the real `@dsh-cc/subagent-task`
 * Task tool over the real subagent runtime, with the REAL
 * `cc-codex-bridge` plugin mounted from its repo path through
 * `@dsh-cc/plugin-loader` onto the real hooks-claude-code bridge — only the
 * LLM adapter is scripted (MockAdapter).
 *
 * What is NOT mocked: the plugin loader (`hooks/hooks.json` +
 * `${CLAUDE_PLUGIN_ROOT}` substitution), the hook bridge (payload building,
 * matcher dispatch, allow/ask/deny waterfall), the allow hook's node
 * subprocess itself, and the canonical launcher execution.
 *
 * Observable marker convention: an ALLOWED canonical call EXECUTES the real
 * launcher; with codex unresolvable it exits non-zero with a
 * `codex-rescue:`-prefixed message — that marker in the tool result is the
 * execution-past-the-bridge proof. A DENIED call never executes.
 *
 * HERMETICITY INVARIANT (load-bearing): an allowed canonical call runs the
 * real launcher, which PATH-resolves the Codex CLI. PATH is pinned to the
 * node dir + /usr/bin + /bin (codex NOT reachable) and HOME to an empty
 * tmpdir, so the launcher fail-louds on stderr instead of ever touching the
 * network or credentials. Vitest runs each spec file in its own worker
 * process, so the swap below is file-scoped.
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { apply as applyTask } from '../src/index.ts'

const BRIDGE_PLUGIN_DIR = resolve(import.meta.dirname, '../../../plugin/cc-codex-bridge')

// --- File-scoped hermeticity swap (see header comment). ---
const SAVED_PATH = process.env.PATH
const SAVED_HOME = process.env.HOME
const E2E_HOME = mkdtempSync(join(tmpdir(), 'codex-bridge-e2e-home-'))
process.env.PATH = [dirname(realpathSync(process.execPath)), '/usr/bin', '/bin'].join(delimiter)
process.env.HOME = E2E_HOME

afterAll(() => {
  process.env.PATH = SAVED_PATH
  process.env.HOME = SAVED_HOME
  rmSync(E2E_HOME, { recursive: true, force: true })
})

// PREFLIGHT (fails LOUD, never skips): the bridge must arm in this
// environment — the node binary and the repo launcher must sit outside the
// hook's refusal triple {realpath(cwd), realpath(tmpdir), realpath('/tmp')}.
// The session workspace is an mkdtemp under tmpdir, so the repo-path anchors
// arm naturally; a pathological environment (node under tmp, repo cloned
// under /tmp) must fail here with a remedy, not silently no-op the matrix.
{
  const node = realpathSync(process.execPath)
  const launcher = realpathSync(join(BRIDGE_PLUGIN_DIR, 'scripts', 'codex-rescue-run.mjs'))
  const tmpReal = realpathSync(tmpdir())
  const insideTmp = (p: string) => p === tmpReal || p.startsWith(tmpReal + '/')
  if (insideTmp(node) || insideTmp(launcher)) {
    throw new Error(
      `codex-bridge e2e preflight: refusal set swallows an anchor (node=${node}, launcher=${launcher} ` +
      `is inside ${tmpReal}). Remedy: run from a repo checkout outside the canonical tmp roots ` +
      `(e.g. not under /tmp or the system tempdir), and ensure node itself resolves outside them.`,
    )
  }
}

/** The hook's own anchor derivation — the byte-pinned command bytes. */
const NODE = realpathSync(process.execPath)
const LAUNCHER = realpathSync(join(BRIDGE_PLUGIN_DIR, 'scripts', 'codex-rescue-run.mjs'))
const CANONICAL = `${NODE} ${LAUNCHER} -- 'review the failing spec'`

const dirs: string[] = []
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

async function waitFor(predicate: () => boolean, timeout = 30_000, dump?: () => string): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor: condition not met before deadline${dump !== undefined ? `\nstate: ${dump()}` : ''}`)
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await waitFor(() => ctx.agents.get(childId) === undefined)
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

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

/** Every bash command that actually EXECUTED (past the waterfall) in this worker. */
const executedCommands: string[] = []

/**
 * Boot the full dsh-cc composition with the REAL cc-codex-bridge plugin
 * mounted; only the model adapter is scripted. The parent is NOT parked for
 * the main-thread rows (they drive a real parent turn); child rows park it.
 */
async function setup(script: ConstructorParameters<typeof MockAdapter>[0], opts: { agentsDir?: boolean; parkParent?: boolean } = {}) {
  executedCommands.length = 0
  const dir = mkdtempSync(join(tmpdir(), 'codex-bridge-e2e-'))
  dirs.push(dir)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const persistRoot = mkdtempSync(join(tmpdir(), 'codex-bridge-e2e-persist-'))
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
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: 'command', command: pre }] }],
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
      '---\nname: reader\ndescription: read-only child\ntools: [Read]\n---\nREADER PERSONA MARKER\n',
    )
  }
  // A real Bash tool named like the harness built-in (`bash` — the bridge
  // alias-maps it onto the CC name `Bash` in the hook payload, so the hook's
  // `Bash` matcher selects it), and an allowed call genuinely executes — the
  // launcher's `codex-rescue:` stderr is the execution marker. Hermetic:
  // PATH is pinned at file scope (codex absent).
  ctx.tools.register(defineContentToolFixture({
    name: 'bash',
    description: 'bash',
    parameters: {},
    async execute(args: { command?: string }) {
      const command = args.command ?? ''
      executedCommands.push(command)
      const res = spawnSync('bash', ['-c', command], { cwd: ws, encoding: 'utf8' })
      const out = [res.stdout, res.stderr].filter(s => s !== '').join('\n')
      return [{ type: 'text', text: out }]
    },
  }))
  await mountCcPlugin(ctx, { root: BRIDGE_PLUGIN_DIR })

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
  return { ctx, parent, adapter, dir, ws, marker }
}

function requestsFor(adapter: MockAdapter, sessionId: string) {
  return adapter.requests.filter(request => String(request.sessionId) === sessionId)
}

/** The probe hook's captured payloads (one JSON object per line). */
function payloads(marker: string): Array<Record<string, unknown>> {
  if (!existsSync(marker)) return []
  return readFileSync(marker, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
}

/** Diagnostic dump for waitFor deadlines. */
function dumpState(adapter: MockAdapter, marker = ''): () => string {
  return () => `executed=${JSON.stringify(executedCommands)}${marker !== '' ? ` payloads=${JSON.stringify(payloads(marker))}` : ''} requests=${JSON.stringify(
    adapter.requests.map(r => ({ session: String(r.sessionId), results: toolResults(r).map(b => b.text.slice(0, 120)) })),
  )}`
}

/** A downstream (append-order, so AFTER the bridge's prepended listener)
 * tools/pre-execute listener deciding only on the exact canonical string. */
function gateCanonical(ctx: Context, verdict: 'deny' | 'ask'): void {
  ctx.on('tools/pre-execute', async (exec: { name?: string; arguments?: { command?: string } }, next) => {
    if (exec?.name !== 'bash' || exec?.arguments?.command !== CANONICAL) return next()
    return verdict === 'deny' ? { kind: 'deny', reason: 'downstream deny' } : { kind: 'ask', reason: 'downstream ask' }
  })
}

describe('e2e — codex-rescue-bridge PreToolUse allow hook through the real plugin', () => {
  it('M1: canonical call on the main thread is allowed and EXECUTES the launcher (codex-rescue: marker)', async () => {
    const { ctx, parent, adapter, marker } = await setup([
      toolCallResponse('r1', 'bash', { command: CANONICAL }),
      textResponse('rescue attempted'),
    ], { parkParent: false })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the rescue' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    // Stage 1: the bridge DISPATCHED the Bash PreToolUse payload (the plugin
    // hook actually ran, matcher subject + command bytes correct).
    await waitFor(
      () => payloads(marker).some(p =>
        p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash'
        && (p.tool_input as { command?: string })?.command === CANONICAL),
      30_000,
      dumpState(adapter, marker),
    )
    // Stage 2: the call executed past the bridge (launcher marker).
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).some(b => b.text.includes('codex-rescue:'))),
      30_000,
      dumpState(adapter, marker),
    )
    const result = toolResults(requestsFor(adapter, 'parent').find(r => toolResults(r).some(b => b.text.includes('codex-rescue:')))).find(b => b.text.includes('codex-rescue:'))!
    expect(executedCommands).toContain(CANONICAL)
    expect(result.text).toContain('codex-rescue:')
  }, 90_000)

  it('M4 control: a non-canonical echo is the unchanged passthrough flow (no marker)', async () => {
    const { parent, adapter, marker } = await setup([
      toolCallResponse('r1', 'bash', { command: 'echo hello' }),
      textResponse('done'),
    ], { parkParent: false })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'echo' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).length > 0),
      30_000,
      dumpState(adapter, marker),
    )
    // The bridge DISPATCHED the Bash payload; the allow hook stayed silent
    // for the non-canonical command (no canonical execution lineage).
    expect(payloads(marker).some(p => p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash')).toBe(true)
    const results = toolResults(requestsFor(adapter, 'parent').at(-1))
    expect(results.length).toBeGreaterThanOrEqual(1)
    // Hook stayed silent: no allow verdict, no launcher execution.
    expect(results.some(b => b.text.includes('codex-rescue:'))).toBe(false)
    expect(results.at(-1)!.isError).toBe(false)
    expect(results.at(-1)!.text).toContain('hello')
    expect(executedCommands).toContain('echo hello')
  }, 90_000)

  it('M2: a downstream deny for the canonical call is NEVER flipped by the hook allow', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('r1', 'bash', { command: CANONICAL }),
      textResponse('unreachable'),
    ], { parkParent: false })
    // Registered AFTER the bridge mount → append order = downstream of the
    // bridge's {prepend:true} listener; a deny short-circuits and the hook
    // allow can never resurrect it.
    gateCanonical(ctx, 'deny')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the rescue' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).some(b => b.isError)),
      30_000,
      dumpState(adapter),
    )
    const denied = toolResults(requestsFor(adapter, 'parent').find(r => toolResults(r).some(b => b.isError))!)
      .find(b => b.isError)!
    expect(denied.isError).toBe(true)
    expect(denied.text).not.toContain('codex-rescue:')
    expect(executedCommands).not.toContain(CANONICAL)
  }, 90_000)

  it('M3: a downstream ask for the canonical call is downgraded to allow (marker present)', async () => {
    const { ctx, parent, adapter, marker } = await setup([
      toolCallResponse('r1', 'bash', { command: CANONICAL }),
      textResponse('rescue attempted'),
    ], { parkParent: false })
    gateCanonical(ctx, 'ask')
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'run the rescue' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    // The hook RAN for this payload (evidence the downgrade is hook-driven).
    await waitFor(
      () => payloads(marker).some(p =>
        p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash'),
      30_000,
      dumpState(adapter, marker),
    )
    await waitFor(
      () => requestsFor(adapter, 'parent').some(r => toolResults(r).some(b => b.text.includes('codex-rescue:'))),
      30_000,
      dumpState(adapter),
    )
    expect(executedCommands).toContain(CANONICAL)
  }, 90_000)

  it('M5: a tool-restricted child\'s canonical bash call traverses the same hook and is allowed', async () => {
    const { ctx, parent, adapter, marker } = await setup([
      toolCallResponse('c1', 'bash', { command: CANONICAL }),
      textResponse('child done'),
    ], { agentsDir: true })
    const result = await callTool(ctx, 'subagent_fork', {
      description: 'child rescue',
      prompt: 'run the rescue',
      subagent_type: 'researcher',
    }, parent)
    expect(result.isError).toBe(false)
    // The bridge DISPATCHED the child's bash call to the plugin hook — the
    // probe payload carries the CC caller-identity field (agent_id), which is
    // what ties this traversal row to the child rather than the parent.
    await waitFor(
      () => payloads(marker).some(p =>
        p.hook_event_name === 'PreToolUse' && p.tool_name === 'Bash'
        && (p.tool_input as { command?: string })?.command === CANONICAL
        && typeof p.agent_id === 'string' && p.agent_id !== ''),
      30_000,
      dumpState(adapter, marker),
    )
    await waitFor(
      () => adapter.requests.some(r => toolResults(r).some(b => b.text.includes('codex-rescue:'))),
      30_000,
      dumpState(adapter),
    )
    const childRequest = adapter.requests.find(r => toolResults(r).some(b => b.text.includes('codex-rescue:')))
    expect(String(childRequest!.sessionId)).not.toBe('parent')
    expect(executedCommands).toContain(CANONICAL)
    await waitNoActivation(ctx, SessionId(String(childRequest!.sessionId)))
  }, 90_000)

  it('M6 control: a read-only child\'s echo is denied by its toolFilter — never executed, no marker', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', 'bash', { command: 'echo hello' }),
      textResponse('child done'),
    ], { agentsDir: true })
    const result = await callTool(ctx, 'subagent_fork', {
      description: 'child echo',
      prompt: 'echo',
      subagent_type: 'reader',
    }, parent)
    expect(result.isError).toBe(false)
    await waitFor(
      () => adapter.requests.some(r => String(r.sessionId) !== 'parent' && toolResults(r).some(b => b.isError)),
      30_000,
      dumpState(adapter),
    )
    const childRequest = adapter.requests.find(r => String(r.sessionId) !== 'parent' && toolResults(r).some(b => b.isError))!
    const denied = toolResults(childRequest).find(b => b.isError)!
    expect(denied.text).not.toContain('codex-rescue:')
    expect(executedCommands).not.toContain('echo hello')
    await waitNoActivation(ctx, SessionId(String(childRequest!.sessionId)))
  }, 90_000)
})
