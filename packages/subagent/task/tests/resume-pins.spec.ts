/**
 * Integration matrix for the resume-pin GATE + OVERLAY + notices (plan §6
 * tests 6-12): the REAL Task plugin composed with the resume-pins plugin on
 * the real in-process harness stack, two-Context cold boots over one
 * persistence + pin root (Spike S1 recipe). Only the model is scripted.
 *
 * Covered:
 * 6.  Acceptance: pinned maxTokens+effort+route survive a cold boot; a
 *     pinned-null case removes the request keys (absence, not null).
 * 7.  Changed definition → notice + lastNotice; block policy denies;
 *     comment-only edit → no notice.
 * 8.  Provider absent → blocked (no request, list_agents annotated); policy
 *     flip route-current → resumes with the complete current tuple on the
 *     FIRST request (cache coherence); adapter-default drift variant.
 * 9.  Pinned tool removed → PINNED_TOOL_UNAVAILABLE.
 * 10. Workspace: deleted cwd blocks; repo-identity drift per policy;
 *     branch-only drift notices.
 * 11. Unpinned (legacy) children and live-Activation followups pass through.
 * 12. Crash window: pin without a persisted session → PIN_ORPHANED.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, type LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ControlTools from '@deepseek-ai/dsh-tool-subagent-control'
import * as ListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import { defineTool } from '@dsh-cc/tools'
import type { DetailedRoute, ResolvedRoute } from '@dsh-cc/model-aliases'
import {
  PinStore,
  RESUME_POLICY_NAMESPACE,
  applyResumePinsPlugin,
  type ResumePolicy,
} from '@dsh-cc/subagent-resume-pins'
import { apply as applyTask } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function gitInit(dir: string, branch = 'main'): void {
  execSync(`git init -q -b ${branch} && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init`, { cwd: dir })
}

function writeResearcherDefinition(workspace: string, body = 'RESEARCHER PERSONA MARKER'): void {
  mkdirSync(join(workspace, '.claude', 'agents'), { recursive: true })
  writeFileSync(
    join(workspace, '.claude', 'agents', 'researcher.md'),
    `---\nname: researcher\ndescription: reads things\nmodel: sonnet\ntools:\n  - read\n---\n${body}\n`,
  )
}

interface BootOptions {
  /** Alias map provided as the ccModelRoutes service. */
  routes?: Record<string, ResolvedRoute>
  /** MockAdapter reasoning metadata + defaultMaxTokens. */
  reasoning?: LlmModelReasoningInfo
  defaultMaxTokens?: number
  /** Register the 'mock' adapter at all (false = provider absent). */
  registerMockAdapter?: boolean
  /** Initial live policy values (mutate the returned ref to flip). */
  policy?: Partial<ResumePolicy>
  /** Parent maxTokens (the spawn inherits it into the pin preflight). */
  parentMaxTokens?: number
  /** Register the deployment 'read' tool (default true). */
  readTool?: boolean
  /** Write the alias-stamped researcher definition. */
  researcherDefinition?: boolean
  /** Inject a PinStore (e.g. a write-failing subclass) into the plugin. */
  store?: PinStore
  /** Inject an agent/request listener (before the pin plugin) that adds junk maxTokens/effort keys. */
  junkRequestKeys?: boolean
}

interface Boot {
  ctx: Context
  parent: Agent
  adapter: MockAdapter
  store: PinStore
  workspace: string
  livePolicy: { value: Partial<ResumePolicy> }
}

/**
 * Boot one Context over `root` (shared persistence + pins + workspace), like
 * `integration.spec.ts` plus the resume-pins plugin and a live policy stub.
 */
async function boot(
  script: ConstructorParameters<typeof MockAdapter>[0],
  root: string,
  opts: BootOptions = {},
): Promise<Boot> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const workspace = join(root, 'workspace')
  if (!existsSync(join(workspace, '.git'))) {
    mkdirSync(workspace, { recursive: true })
    gitInit(workspace)
  }
  if (opts.researcherDefinition === true) writeResearcherDefinition(workspace)
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  // sendMessage's cold-resume delivery resolves sessions through session-query.
  await ctx.plugin(SessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ControlTools)
  await ctx.plugin(ListAgents)
  if (opts.readTool !== false) {
    ctx.tools.register(defineTool({
      name: 'read',
      description: 'read',
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      async execute() { return null },
    }))
  }
  const tools = ctx.get('tools') as { reserve?(name: string): () => void }
  if (typeof tools.reserve !== 'function') {
    const reserved = new Set<string>()
    tools.reserve = (name: string) => {
      reserved.add(name)
      return () => { reserved.delete(name) }
    }
  }
  // Seed the alias map as the ccModelRoutes service (settings-less composition).
  const routes = opts.routes
  if (routes !== undefined) {
    const resolveDetailed = (model: string | undefined): DetailedRoute => {
      if (model === undefined) return { selector: undefined, via: 'inherit', route: undefined }
      const route = routes[model]
      return route === undefined
        ? { selector: model, via: 'literal', route: { model } }
        : { selector: model, via: 'alias', route }
    }
    ctx.provide('ccModelRoutes', {
      resolve: (model: string | undefined) => resolveDetailed(model).route,
      resolveDetailed,
    })
  }
  // The live policy: a minimal settings stub whose subagents-resume section
  // is a mutable ref the tests flip (the plugin reads it per evaluation).
  const livePolicy: { value: Partial<ResumePolicy> } = { value: opts.policy ?? {} }
  ctx.provide('settings', {
    register: (ns: unknown) => ns === RESUME_POLICY_NAMESPACE ? { get: () => livePolicy.value } : undefined,
    get: () => undefined,
  })
  const junkSeen = { value: false }
  const pinsRoot = join(root, 'resume-pins')
  // The resume-pins plugin MUST mount before the Task plugin so the capture
  // prefers the plugin-provided store (one cache for gate + overlay + capture).
  applyResumePinsPlugin(ctx, { pinsRoot, ...(opts.store !== undefined ? { store: opts.store } : {}) })
  applyTask(ctx, { resumePins: { pinsRoot } })
  // The junk middleware registers AFTER the resume-pins plugin so it runs
  // DOWNSTREAM (inner) of the overlay: it injects junk maxTokens/effort keys
  // into the freshly resolved request, which the overlay must then REMOVE
  // (test-quality fix a — a non-vacuous pinned-null).
  if (opts.junkRequestKeys === true) {
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next() as unknown as Record<string, unknown>
      junkSeen.value = true
      return { ...resolved, maxTokens: 7777, reasoningEffort: 'junk-injected' }
    })
  }
  const adapter = new MockAdapter(script, opts.reasoning, opts.defaultMaxTokens)
  if (opts.registerMockAdapter !== false) ctx.llm.registerAdapter(['mock'], adapter)
  // The parent identity is STABLE across boots (production: a resumed
  // coordinator keeps its session id, and a cold-resumed child only accepts
  // messages from the parent its header records). Re-creating 'parent' over
  // the shared root is refused by the jsonl backend, so a second boot
  // RESUMES the persisted parent session instead.
  const parentId = SessionId('parent')
  const persistedParent = await (ctx.get('sessionPersistence') as {
    stat(id: SessionId): Promise<{ revision: unknown } | undefined>
  }).stat(parentId)
  const parentOptions = {
    provider: 'mock',
    model: 'mock',
    ...(opts.parentMaxTokens !== undefined ? { maxTokens: opts.parentMaxTokens } : {}),
  }
  let parent: Agent
  if (persistedParent !== undefined) {
    const handle = await ctx.agentLoop.resume(ctx, { resumeSessionId: parentId, agentOptions: parentOptions })
    parent = handle.agent
  } else {
    parent = await ctx.agentLoop.create(parentId, parentOptions, { cwd: workspace })
  }
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    return { kind: 'reject' as const }
  })
  return { ctx, parent, adapter, store: new PinStore(pinsRoot), workspace, livePolicy, junkSeen }
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
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

async function startBackground(ctx: Context, parent: Agent, args: Record<string, unknown> = {}): Promise<string> {
  const result = await callTool(ctx, 'subagent_fork', {
    description: 'long research',
    prompt: 'slow work',
    run_in_background: true,
    ...args,
  }, parent)
  if (result.isError) throw new Error(`background Task failed: ${text(result as never)}`)
  const agentId = /agentId: ([0-9a-f-]{36})/.exec(text(result as never))?.[1]
  expect(agentId, `background notice must name the durable id, got: ${text(result as never)}`).toBeTypeOf('string')
  return agentId!
}

async function waitNoActivation(ctx: Context, childId: ReturnType<typeof SessionId>): Promise<void> {
  await vi.waitFor(() => expect(ctx.agents.get(childId)).toBeUndefined(), { timeout: 10_000 })
}

function childRequests(adapter: MockAdapter, childId: ReturnType<typeof SessionId>) {
  return adapter.requests.filter(request => request.sessionId === childId)
}

const HIGH_EFFORT: LlmModelReasoningInfo = { efforts: [{ id: 'low', name: 'low' }, { id: 'high', name: 'high' }], defaultEffort: 'low' }

describe('§6 test 6 — acceptance: the pinned tuple survives a two-Context cold boot', () => {
  it('cold-resumed requests carry the pinned maxTokens + effort + route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)

    // ── Context A: alias-stamped effort + non-default maxTokens, spawn, settle ──
    const a = await boot([textResponse('first answer')], root, {
      researcherDefinition: true,
      routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } },
      reasoning: HIGH_EFFORT,
      parentMaxTokens: 5555,
    })
    const agentId = await startBackground(a.ctx, a.parent, { subagent_type: 'researcher' })
    const childId = SessionId(agentId)
    await waitNoActivation(a.ctx, childId)
    const pin = a.store.read(agentId)
    expect(pin).toMatchObject({
      effective: { provider: 'mock', model: 'mock', reasoningEffort: 'high', maxTokens: 5555, complete: true },
      modelSelector: { raw: 'sonnet', via: 'alias' },
    })
    await a.ctx.fiber.dispose()

    // ── Context B: same roots; a cold-resumed descriptor drops maxTokens ──
    const b = await boot([textResponse('resumed answer from B')], root, { reasoning: HIGH_EFFORT, routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } } })
    expect(childRequests(b.adapter, childId)).toHaveLength(0)

    const send = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue from B' }, b.parent)
    expect(send.isError, text(send as never)).toBe(false)
    await vi.waitFor(() => expect(childRequests(b.adapter, childId).length).toBeGreaterThan(0), { timeout: 10_000 })
    await waitNoActivation(b.ctx, childId)

    // The resumed request carries the PINNED config — maxTokens is the
    // unconditional-loss sentinel; effort + route are the pin's too.
    const resumed = childRequests(b.adapter, childId).at(-1)!
    expect(resumed.maxTokens).toBe(5555)
    expect(resumed.reasoningEffort).toBe('high')
    expect(resumed.model).toBe('mock')
    // 0.1.5: the system prompt rides as the leading system message, not a request field.
    expect(JSON.stringify(resumed.messages?.filter((message: { role: string }) => message.role === 'system'))).toContain('RESEARCHER PERSONA MARKER')
    expect((resumed.tools ?? []).map(tool => tool.name)).toContain('read')
    // No gate notices on a clean resume.
    expect(text(send as never)).not.toContain('resumed')
  }, 30_000)

  it('a pinned-null case removes the maxTokens/effort keys from the resumed request (absence, not null)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)

    // Spawn with NO maxTokens anywhere and an adapter without defaults:
    // the pin records explicit absence (`null`) for both knobs.
    const a = await boot([textResponse('first answer')], root)
    const agentId = await startBackground(a.ctx, a.parent)
    const childId = SessionId(agentId)
    await waitNoActivation(a.ctx, childId)
    expect(a.store.read(agentId)).toMatchObject({
      effective: { reasoningEffort: null, maxTokens: null, complete: true },
    })
    await a.ctx.fiber.dispose()

    // Context B: an upstream agent/request middleware ("fake adapter default")
    // injects junk maxTokens/effort keys into the resolved request BEFORE the
    // overlay runs — the overlay must REMOVE them (absence, not null), making
    // the removal non-vacuous (test-quality fix a).
    const b = await boot([textResponse('resumed answer from B')], root, { junkRequestKeys: true })
    const send = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(send.isError, `send failed: ${text(send as never)}`).toBe(false)
    await vi.waitFor(() => expect(childRequests(b.adapter, childId).length).toBeGreaterThan(0), { timeout: 10_000 })
    await waitNoActivation(b.ctx, childId)
    const resumed = childRequests(b.adapter, childId).at(-1)!
    // The middleware really ran upstream of the overlay.
    expect(b.junkSeen.value).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(resumed, 'maxTokens')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(resumed, 'reasoningEffort')).toBe(false)
  }, 30_000)
})

describe('§6 test 7 — changed definition between boots', () => {
  async function changedFixture(): Promise<{ root: string; agentId: string }> {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const a = await boot([textResponse('first answer')], root, {
      researcherDefinition: true,
      routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } },
      reasoning: HIGH_EFFORT,
    })
    const agentId = await startBackground(a.ctx, a.parent, { subagent_type: 'researcher' })
    await waitNoActivation(a.ctx, SessionId(agentId))
    await a.ctx.fiber.dispose()
    return { root, agentId }
  }

  it('a real edit notices (result + lastNotice); block policy denies; a comment-only edit is silent', async () => {
    const { root, agentId } = await changedFixture()

    // Real edit between boots.
    writeResearcherDefinition(join(root, 'workspace'), 'CHANGED PERSONA MARKER')
    const b = await boot([textResponse('resumed answer')], root, { reasoning: HIGH_EFFORT, routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } } })
    const send = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(send.isError, text(send as never)).toBe(false)
    expect(text(send as never)).toContain('resumed with changed definition (pinned persona retained)')
    expect(b.store.read(agentId)).toMatchObject({ lastNotice: expect.stringContaining('changed definition') })
    await waitNoActivation(b.ctx, SessionId(agentId))
    await b.ctx.fiber.dispose()

    // Block policy variant: denied, no request, blocked state persisted.
    writeResearcherDefinition(join(root, 'workspace'), 'CHANGED AGAIN PERSONA')
    const c = await boot([], root, {
      reasoning: HIGH_EFFORT,
      routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } },
      policy: { onDefinitionChanged: 'block' },
    })
    const before = childRequests(c.adapter, SessionId(agentId)).length
    const denied = await callTool(c.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, c.parent)
    expect(denied.isError).toBe(true)
    expect(text(denied as never)).toContain('DEFINITION_CHANGED')
    expect(childRequests(c.adapter, SessionId(agentId)).length).toBe(before)
    expect(c.store.read(agentId)).toMatchObject({ resume: { state: 'blocked', reason: expect.stringContaining('DEFINITION_CHANGED') } })
    await c.ctx.fiber.dispose()

    // Comment-only edit: parse-level canonicalization → no notice.
    const ws = join(root, 'workspace')
    writeFileSync(join(ws, '.claude', 'agents', 'researcher.md'),
      '---\nname: researcher # a yaml comment\ndescription: reads things\nmodel: sonnet\ntools:\n  - read\n---\nRESEARCHER PERSONA MARKER\n')
    const d = await boot([textResponse('resumed answer')], root, { reasoning: HIGH_EFFORT, routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } } })
    const quiet = await callTool(d.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, d.parent)
    expect(quiet.isError).toBe(false)
    expect(text(quiet as never)).not.toContain('changed definition')
    await waitNoActivation(d.ctx, SessionId(agentId))
  }, 40_000)
})

describe('§6 test 8 — model unavailability, policy fallback, and adapter-default drift', () => {
  async function spawnFixture(root: string, opts: BootOptions = {}): Promise<string> {
    const a = await boot([textResponse('first answer')], root, {
      researcherDefinition: true,
      routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } },
      reasoning: HIGH_EFFORT,
      ...opts,
    })
    const agentId = await startBackground(a.ctx, a.parent, { subagent_type: 'researcher' })
    await waitNoActivation(a.ctx, SessionId(agentId))
    await a.ctx.fiber.dispose()
    return agentId
  }

  it('provider absent in Context B → blocked: no request, list_agents annotated; route-current flip resumes atomically on the FIRST request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const agentId = await spawnFixture(root)
    const childId = SessionId(agentId)

    // B: NO 'mock' adapter — the pinned provider is gone.
    const b = await boot([], root, { registerMockAdapter: false, reasoning: HIGH_EFFORT, routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } } })
    const denied = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(denied.isError).toBe(true)
    expect(text(denied as never)).toContain('SUBAGENT_MODEL_UNAVAILABLE')
    expect(childRequests(b.adapter, childId)).toHaveLength(0)
    expect(b.store.read(agentId)).toMatchObject({ resume: { state: 'blocked', reason: expect.stringContaining('SUBAGENT_MODEL_UNAVAILABLE') } })

    // list_agents annotates the blocked child.
    const list = await callTool(b.ctx, 'list_agents', {}, b.parent)
    expect(text(list as never)).toContain(`[resume-pin] ${agentId}`)
    expect(text(list as never)).toContain('state blocked')
    await b.ctx.fiber.dispose()

    // C: policy flipped to route-current AND a current default route exists
    // (alias retargeted to mock2, adapter mounted with its own defaults).
    const c = await boot([textResponse('resumed on current route')], root, {
      routes: { sonnet: { provider: 'mock2', model: 'mock2' } },
      reasoning: HIGH_EFFORT,
      policy: { onUnavailableModel: 'route-current' },
      defaultMaxTokens: 999,
    })
    const mock2Adapter = new MockAdapter([textResponse('resumed on current route')], HIGH_EFFORT, 999)
    c.ctx.llm.registerAdapter(['mock2'], mock2Adapter)
    const resumed = await callTool(c.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, c.parent)
    expect(resumed.isError).toBe(false)
    expect(text(resumed as never)).toContain('resumed with current default route mock2/mock2 per policy')
    // Cache coherence: the FIRST resumed request already carries the complete
    // current tuple the gate published before the followup.
    await vi.waitFor(() => expect(childRequests(mock2Adapter, childId).length).toBeGreaterThan(0), { timeout: 10_000 })
    const first = childRequests(mock2Adapter, childId)[0]!
    expect(first.provider).toBe('mock2')
    expect(first.model).toBe('mock2')
    expect(first.maxTokens).toBe(999)
    expect(first.reasoningEffort).toBe('low')
    await waitNoActivation(c.ctx, childId)
  }, 40_000)

  it('adapter-default drift (a default appears where the pin pinned absence) blocks; route-current resumes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    // Spawn with a reasoning-capable adapter but NO defaultMaxTokens → the
    // pin records maxTokens: null.
    const agentId = await spawnFixture(root)
    const childId = SessionId(agentId)

    // B: same route, but the adapter NOW declares a default maxTokens.
    const b = await boot([], root, { reasoning: HIGH_EFFORT, defaultMaxTokens: 4321, routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } } })
    const denied = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(denied.isError).toBe(true)
    expect(text(denied as never)).toContain('SUBAGENT_MODEL_UNAVAILABLE')
    expect(childRequests(b.adapter, childId)).toHaveLength(0)
    await b.ctx.fiber.dispose()

    // route-current variant: the current tuple (default 4321, default effort low) applies.
    const c = await boot([textResponse('resumed on current route')], root, {
      reasoning: HIGH_EFFORT,
      defaultMaxTokens: 4321,
      policy: { onUnavailableModel: 'route-current' },
    })
    const resumed = await callTool(c.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, c.parent)
    expect(resumed.isError, text(resumed as never)).toBe(false)
    expect(text(resumed as never)).toContain('resumed with current default route mock/mock per policy')
    await vi.waitFor(() => expect(childRequests(c.adapter, childId).length).toBeGreaterThan(0), { timeout: 10_000 })
    const first = childRequests(c.adapter, childId)[0]!
    expect(first.maxTokens).toBe(4321)
    expect(first.reasoningEffort).toBe('low')
    await waitNoActivation(c.ctx, childId)
  }, 40_000)
})

describe('§6 test 9 — pinned tool removed in Context B', () => {
  it('denies PINNED_TOOL_UNAVAILABLE (fail-closed, no fallback)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const a = await boot([textResponse('first answer')], root, {
      researcherDefinition: true,
      routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } },
      reasoning: HIGH_EFFORT,
    })
    const agentId = await startBackground(a.ctx, a.parent, { subagent_type: 'researcher' })
    await waitNoActivation(a.ctx, SessionId(agentId))
    await a.ctx.fiber.dispose()

    // B: the 'read' tool no longer exists in this composition.
    const b = await boot([], root, { readTool: false, reasoning: HIGH_EFFORT, routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } } })
    const denied = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(denied.isError).toBe(true)
    expect(text(denied as never)).toContain('PINNED_TOOL_UNAVAILABLE')
    expect(childRequests(b.adapter, SessionId(agentId))).toHaveLength(0)
    expect(b.store.read(agentId)).toMatchObject({ resume: { state: 'blocked' } })
  }, 30_000)
})

describe('§6 test 10 — workspace drift', () => {
  async function workspaceFixture(): Promise<{ root: string; agentId: string; workspace: string }> {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const a = await boot([textResponse('first answer')], root)
    const agentId = await startBackground(a.ctx, a.parent)
    await waitNoActivation(a.ctx, SessionId(agentId))
    await a.ctx.fiber.dispose()
    return { root, agentId, workspace: join(root, 'workspace') }
  }

  it('deleted cwd → WORKSPACE_MISSING block; repo-identity drift per policy; branch-only drift notices', async () => {
    // (a) deleted cwd.
    const gone = await workspaceFixture()
    const b1 = await boot([], gone.root)
    rmSync(gone.workspace, { recursive: true, force: true })
    const denied = await callTool(b1.ctx, 'send_message', { agent_id: gone.agentId, message: 'continue' }, b1.parent)
    expect(denied.isError, text(denied as never)).toBe(true)
    expect(text(denied as never)).toContain('WORKSPACE_MISSING')
    await b1.ctx.fiber.dispose()

    // (b) gitCommonDir drift: the workspace was a linked worktree at spawn,
    // and is now a standalone repo at the same path.
    const driftRoot = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(driftRoot)
    const mainRepo = join(driftRoot, 'main')
    const wt = join(driftRoot, 'workspace')
    mkdirSync(mainRepo, { recursive: true })
    gitInit(mainRepo)
    execSync(`git worktree add -q "${wt}" -b wt-branch`, { cwd: mainRepo })
    const a = await boot([textResponse('first answer')], driftRoot)
    const agentId = await startBackground(a.ctx, a.parent)
    await waitNoActivation(a.ctx, SessionId(agentId))
    expect(a.store.read(agentId)).toMatchObject({ workspace: { gitDir: expect.stringContaining('worktrees') } })
    await a.ctx.fiber.dispose()
    // Reprovision the same path as a standalone repo.
    rmSync(join(wt, '.git'))
    gitInit(wt)
    const b2 = await boot([textResponse('resumed')], driftRoot)
    const identityDrift = await callTool(b2.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b2.parent)
    expect(identityDrift.isError).toBe(false)
    expect(text(identityDrift as never)).toContain('repository identity changed')
    await waitNoActivation(b2.ctx, SessionId(agentId))
    await b2.ctx.fiber.dispose()

    // (c) the same drift under block policy denies.
    const blockRoot = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(blockRoot)
    const main2 = join(blockRoot, 'main')
    const wt2 = join(blockRoot, 'workspace')
    mkdirSync(main2, { recursive: true })
    gitInit(main2)
    execSync(`git worktree add -q "${wt2}" -b wt-branch`, { cwd: main2 })
    const a2 = await boot([textResponse('first answer')], blockRoot)
    const agentId2 = await startBackground(a2.ctx, a2.parent)
    await waitNoActivation(a2.ctx, SessionId(agentId2))
    await a2.ctx.fiber.dispose()
    rmSync(join(wt2, '.git'))
    gitInit(wt2)
    const b3 = await boot([], blockRoot, { policy: { onWorkspaceChanged: 'block' } })
    const blocked = await callTool(b3.ctx, 'send_message', { agent_id: agentId2, message: 'continue' }, b3.parent)
    expect(blocked.isError).toBe(true)
    expect(text(blocked as never)).toContain('WORKSPACE_CHANGED')
    await b3.ctx.fiber.dispose()

    // (d) branch-only drift: notice, independent of the policy.
    const branchRoot = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(branchRoot)
    const a3 = await boot([textResponse('first answer')], branchRoot)
    const agentId3 = await startBackground(a3.ctx, a3.parent)
    await waitNoActivation(a3.ctx, SessionId(agentId3))
    expect(a3.store.read(agentId3)).toMatchObject({ workspace: { branch: 'main' } })
    await a3.ctx.fiber.dispose()
    execSync('git checkout -q -b topic', { cwd: join(branchRoot, 'workspace') })
    const b4 = await boot([textResponse('resumed')], branchRoot, { policy: { onWorkspaceChanged: 'block' } })
    const branched = await callTool(b4.ctx, 'send_message', { agent_id: agentId3, message: 'continue' }, b4.parent)
    expect(branched.isError).toBe(false)
    expect(text(branched as never)).toContain('branch changed')
    await waitNoActivation(b4.ctx, SessionId(agentId3))
  }, 60_000)
})

describe('§6 test 11 — regression: unpinned children and live followups pass through untouched', () => {
  it('a pin deleted after spawn reads as a legacy child; a live-Activation followup is not gated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const a = await boot(['hang', textResponse('first answer')], root, { parentMaxTokens: 5555 })
    const agentId = await startBackground(a.ctx, a.parent)
    const childId = SessionId(agentId)

    // (a) Live-Activation followup while the child runs: the gate skips it.
    const live = await callTool(a.ctx, 'send_message', { agent_id: agentId, message: 'still there?' }, a.parent)
    expect(live.isError).toBe(false)
    expect(text(live as never)).toContain(`message delivered to agent ${agentId}`)
    await a.store.remove(agentId)
    // Stop the hung turn so the child's Activation can release.
    await callTool(a.ctx, 'interrupt_agent', { agent_id: agentId }, a.parent)
    // Dispose drains the in-flight turn; the persisted session survives.
    await a.ctx.fiber.dispose()

    // (b) Cold resume with NO pin: legacy passthrough — the pinned maxTokens
    // would be restored by the overlay, so its absence proves zero effect.
    const b = await boot([textResponse('resumed answer')], root)
    const send = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(send.isError, `send failed: ${text(send as never)}`).toBe(false)
    await vi.waitFor(() => expect(childRequests(b.adapter, childId).length).toBeGreaterThan(0), { timeout: 10_000 })
    await waitNoActivation(b.ctx, childId)
    const resumed = childRequests(b.adapter, childId).at(-1)!
    expect(Object.prototype.hasOwnProperty.call(resumed, 'maxTokens')).toBe(false)
    expect(resumed.reasoningEffort).toBeUndefined()
    expect(text(send as never)).not.toContain('resume-pin')
  }, 30_000)
})

describe('§6 test 12 — crash window: pin exists, session never created', () => {
  it('denies PIN_ORPHANED (blocked, not legacy pass-through)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const b = await boot([textResponse('unused')], root)
    const orphanId = '00000000-0000-4000-8000-000000000001'
    b.store.write({
      version: 1,
      childId: orphanId,
      parentSessionId: 'parent',
      label: 'aborted',
      mode: 'continuable-background',
      createdAt: new Date().toISOString(),
      definition: { kind: 'plain' },
      modelSelector: { raw: 'inherit', via: 'inherit' },
      effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true },
      toolFilter: { allow: [], deny: [] },
      workspace: { cwd: b.workspace, gitDir: '.git', gitCommonDir: '.git', branch: 'main' },
      resume: { state: 'ok' },
    })
    const denied = await callTool(b.ctx, 'send_message', { agent_id: orphanId, message: 'continue' }, b.parent)
    expect(denied.isError).toBe(true)
    expect(text(denied as never)).toContain('PIN_ORPHANED')
    expect(childRequests(b.adapter, SessionId(orphanId))).toHaveLength(0)
    expect(b.store.read(orphanId)).toMatchObject({ resume: { state: 'blocked', reason: expect.stringContaining('PIN_ORPHANED') } })
  }, 30_000)
})

describe('review fixes — corrupt/vanished pins at request time (H2 + H4)', () => {
  it('a pin file corrupted between boots fail-closes the request (overlay throws); list_agents annotates blocked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const a = await boot([textResponse('first answer')], root, { parentMaxTokens: 5555 })
    const agentId = await startBackground(a.ctx, a.parent)
    await waitNoActivation(a.ctx, SessionId(agentId))
    await a.ctx.fiber.dispose()

    const b = await boot([textResponse('never sent')], root)
    // Corrupt the pin file out-of-band: the durable marker is the file itself.
    writeFileSync(join(root, 'resume-pins', `${agentId}.json`), '{corrupt')
    // The corrupt sentinel is fail-closed at BOTH layers: the gate denies the
    // send visibly (no followup), and the request-time overlay would throw
    // the same way for any request that bypasses the gate.
    const send = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(send.isError).toBe(true)
    expect(text(send as never)).toContain('PIN_UNREADABLE')
    expect(childRequests(b.adapter, SessionId(agentId))).toHaveLength(0)
    // list_agents shows the corrupt pin as blocked (the file IS the marker).
    const list = await callTool(b.ctx, 'list_agents', {}, b.parent)
    expect(text(list as never)).toContain(`[resume-pin] ${agentId}`)
    expect(text(list as never)).toContain('state blocked')
  }, 30_000)

  it('a pin file deleted between boots reads as legacy: the overlay stops applying', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const a = await boot([textResponse('first answer')], root, { parentMaxTokens: 5555 })
    const agentId = await startBackground(a.ctx, a.parent)
    const childId = SessionId(agentId)
    await waitNoActivation(a.ctx, childId)
    await a.ctx.fiber.dispose()

    const b = await boot([textResponse('resumed answer')], root)
    rmSync(join(root, 'resume-pins', `${agentId}.json`))
    const send = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(send.isError, `send failed: ${text(send as never)}`).toBe(false)
    await vi.waitFor(() => expect(childRequests(b.adapter, childId).length).toBeGreaterThan(0), { timeout: 10_000 })
    await waitNoActivation(b.ctx, childId)
    // No pin → no overlay: the pinned maxTokens is NOT restored.
    const resumed = childRequests(b.adapter, childId).at(-1)!
    expect(Object.prototype.hasOwnProperty.call(resumed, 'maxTokens')).toBe(false)
  }, 30_000)
})

describe('review fixes — durability ordering on store-write failure (H3)', () => {
  class FailingUpdateStore extends PinStore {
    update(): never {
      throw new Error('disk full')
    }
  }

  it('a pending DENY keeps denying when the blocked state cannot be persisted (reason notes it)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const b = await boot([textResponse('unused')], root, { store: new FailingUpdateStore(join(root, 'resume-pins')) })
    const orphanId = '00000000-0000-4000-8000-000000000002'
    b.store.write({
      version: 1,
      childId: orphanId,
      parentSessionId: 'parent',
      label: 'aborted',
      mode: 'continuable-background',
      createdAt: new Date().toISOString(),
      definition: { kind: 'plain' },
      modelSelector: { raw: 'inherit', via: 'inherit' },
      effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: null, complete: true },
      toolFilter: { allow: [], deny: [] },
      workspace: { cwd: b.workspace, gitDir: '.git', gitCommonDir: '.git', branch: 'main' },
      resume: { state: 'ok' },
    })
    const denied = await callTool(b.ctx, 'send_message', { agent_id: orphanId, message: 'continue' }, b.parent)
    expect(denied.isError).toBe(true)
    expect(text(denied as never)).toContain('PIN_ORPHANED')
    expect(text(denied as never)).toContain('persistence failed')
    expect(text(denied as never)).toContain('disk full')
    expect(childRequests(b.adapter, SessionId(orphanId))).toHaveLength(0)
  }, 30_000)

  it('a pending PASS must not followup when the gate result cannot be published (STORE_WRITE_FAILURE)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const a = await boot([textResponse('first answer')], root, { parentMaxTokens: 5555 })
    const agentId = await startBackground(a.ctx, a.parent)
    await waitNoActivation(a.ctx, SessionId(agentId))
    await a.ctx.fiber.dispose()

    // Healthy spawn, write-failing store in B: the gate would pass, but the
    // pass must never be admitted without its durable publication.
    const b = await boot([textResponse('resumed answer')], root, { store: new FailingUpdateStore(join(root, 'resume-pins')) })
    const denied = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(denied.isError).toBe(true)
    expect(text(denied as never)).toContain('STORE_WRITE_FAILURE')
    expect(childRequests(b.adapter, SessionId(agentId))).toHaveLength(0)
  }, 30_000)
})

describe('review fixes — unsafe session ids pass through at lookup level (H5)', () => {
  it('a session id containing / or .. is not rejected by the pin store path validator', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const b = await boot([textResponse('unused')], root)
    const result = await callTool(b.ctx, 'send_message', { agent_id: 'weird/../id', message: 'hi' }, b.parent)
    // The gate must NOT have thrown the store's "unsafe resume-pin childId"
    // error; the send proceeds (and fails as an unknown agent, unpin-related).
    expect(text(result as never)).not.toContain('unsafe resume-pin childId')
    expect(text(result as never)).not.toContain('PIN_')
  }, 30_000)
})

describe('review fixes — concurrent sends to one cold child never cross-deliver notices (M11)', () => {
  it('two near-simultaneous sends each carry at most their own single gate notice', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const a = await boot([textResponse('first answer')], root, {
      researcherDefinition: true,
      routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } },
      reasoning: HIGH_EFFORT,
    })
    const agentId = await startBackground(a.ctx, a.parent, { subagent_type: 'researcher' })
    await waitNoActivation(a.ctx, SessionId(agentId))
    await a.ctx.fiber.dispose()

    // A real definition edit ⇒ the gate produces a notice for the cold resume.
    writeResearcherDefinition(join(root, 'workspace'), 'CHANGED PERSONA MARKER')
    const b = await boot([textResponse('resumed answer')], root, { reasoning: HIGH_EFFORT, routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } } })
    const [r1, r2] = await Promise.all([
      callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'first continue' }, b.parent),
      callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'second continue' }, b.parent),
    ])
    const NOTICED = 'resumed with changed definition (pinned persona retained)'
    const t1 = text(r1 as never)
    const t2 = text(r2 as never)
    // Neither result may carry another execution's notice twice; the notice
    // (whichever execution legitimately earned it) appears at most once per
    // result and at least once overall.
    expect([...t1.matchAll(new RegExp(NOTICED, 'g'))].length).toBeLessThanOrEqual(1)
    expect([...t2.matchAll(new RegExp(NOTICED, 'g'))].length).toBeLessThanOrEqual(1)
    expect(t1.includes(NOTICED) || t2.includes(NOTICED)).toBe(true)
  }, 40_000)
})

describe('§6 rename — the gate reads the harness control tool\'s `agent_id` key', () => {
  it('denies a send_message addressed by agent_id (and the legacy subagent_id key no longer gates)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cc-resume-pins-'))
    roots.push(root)
    const a = await boot([textResponse('first answer')], root, {
      researcherDefinition: true,
      routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } },
      reasoning: HIGH_EFFORT,
    })
    const agentId = await startBackground(a.ctx, a.parent, { subagent_type: 'researcher' })
    await waitNoActivation(a.ctx, SessionId(agentId))
    await a.ctx.fiber.dispose()

    // B: NO 'mock' adapter — the pinned provider is gone, so the gate denies.
    const b = await boot([], root, { registerMockAdapter: false, reasoning: HIGH_EFFORT, routes: { sonnet: { model: 'mock', reasoningEffort: 'high' } } })
    const denied = await callTool(b.ctx, 'send_message', { agent_id: agentId, message: 'continue' }, b.parent)
    expect(denied.isError, `expected gate deny, got: ${text(denied as never)}`).toBe(true)
    expect(text(denied as never)).toContain('SUBAGENT_MODEL_UNAVAILABLE')
    expect(childRequests(b.adapter, SessionId(agentId))).toHaveLength(0)
    expect(b.store.read(agentId)).toMatchObject({ resume: { state: 'blocked' } })

    // The legacy `subagent_id` key no longer addresses the gate: the tool
    // call fails upstream (unknown/blank agent_id) rather than being denied
    // with a resume-pin reason — the old key must NOT silently re-enable a
    // gated send.
    const legacy = await callTool(b.ctx, 'send_message', { subagent_id: agentId, message: 'continue' }, b.parent)
    expect(text(legacy as never)).not.toContain('SUBAGENT_MODEL_UNAVAILABLE')
    await b.ctx.fiber.dispose()
  }, 40_000)
})
