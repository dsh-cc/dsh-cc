/**
 * Integration coverage for the spawn-time resume-pin capture (plan §4.3, §4.5,
 * §6 test 5): the REAL Task plugin composed on the real in-process harness
 * stack, with the model scripted — like `integration.spec.ts`, plus a
 * configured `resumePins` plugin option and a seeded `ccModelRoutes` alias map.
 *
 * Covered: the complete pin field-by-field after a real background spawn
 * (alias-stamped definition, materialized preflight tuple), the effective-tuple
 * overlay equivalence against the harness child-agent spread semantics, the
 * spawn-failure tombstone, the degraded (unpreflightable-route) pin with the
 * spawn still succeeding, and the plain-spawn pin shape.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { execSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'

import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import SubagentRuntime, { resolveChildAgentOptions } from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ControlTools from '@deepseek-ai/dsh-tool-subagent-control'
import * as ListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MockAdapter, textResponse } from '@dsh-cc/agent-loop-mock'
import { defineTool } from '@dsh-cc/tools'
import type { DetailedRoute, ResolvedRoute } from '@dsh-cc/model-aliases'
import { toAgentOptions } from '@dsh-cc/model-aliases'
import { PinStore, definitionFingerprint, personaHash } from '@dsh-cc/subagent-resume-pins'
import { overlayRoute, probeWorkspace } from '../src/resume-capture.ts'
import { apply as applyTask } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

/** An alias-stamped project definition: model alias + a tool restriction. */
function writeResearcherDefinition(workspace: string): void {
  mkdirSync(join(workspace, '.claude', 'agents'), { recursive: true })
  writeFileSync(
    join(workspace, '.claude', 'agents', 'researcher.md'),
    '---\nname: researcher\ndescription: reads things\nmodel: sonnet\ntools:\n  - read\n---\nRESEARCHER PERSONA MARKER\n',
  )
}

/** A small deployment tool surface so the researcher toolFilter has a target. */
function registerReadTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read',
    description: 'read',
    parameters: {},
    output: { schema: { type: 'null' }, render: () => [] },
    async execute() { return null },
  }))
}

interface SetupOptions {
  /** Write the alias-stamped `researcher` definition into the workspace. */
  researcherDefinition?: boolean
  /** `git init` the workspace so the workspace-identity probe succeeds. */
  gitInit?: boolean
  /** Alias map seeded as the `ccModelRoutes` service (alias name → route). */
  routes?: Record<string, ResolvedRoute>
  /** MockAdapter reasoning metadata + defaultMaxTokens for the preflight. */
  reasoning?: ConstructorParameters<typeof MockAdapter>[1]
  defaultMaxTokens?: number
  /** Mount the plugin WITHOUT resume-pins config (zero-change composition). */
  noPins?: boolean
}

/**
 * Boot the full composition like `integration.spec.ts`, with the resume-pin
 * capture pointed at a temp pinsRoot and a seeded alias resolver. Returns the
 * pin store so tests read pins back by childId.
 */
async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  opts: SetupOptions = {},
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(SessionProjectionRegistry)
  const root = mkdtempSync(join(tmpdir(), 'dsh-cc-task-resume-capture-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  if (opts.gitInit === true) execSync('git init -q -b main', { cwd: workspace })
  if (opts.researcherDefinition === true) writeResearcherDefinition(workspace)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(SessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(ControlTools)
  await ctx.plugin(ListAgents)
  registerReadTool(ctx)
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
  const pinsRoot = join(root, 'resume-pins')
  const warns: string[] = []
  const originWarn = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = (message: string) => {
    warns.push(message)
    originWarn(message)
  }
  applyTask(ctx, opts.noPins === true ? {} : { resumePins: { pinsRoot } })
  const store = new PinStore(pinsRoot)
  const adapter = new MockAdapter(script, opts.reasoning, opts.defaultMaxTokens)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(
    SessionId('parent'),
    { provider: 'mock', model: 'mock' },
    { cwd: workspace },
  )
  ctx.on('agent/pre-step', async ({ agent: subject }, next) => {
    if (subject !== parent) return next()
    return { kind: 'reject' as const }
  })
  return { ctx, parent, store, warns, pinsRoot, workspace }
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

/** Start a durable background child through the REAL Task tool; return its agentId. */
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

describe('resume pin capture — complete pin after a real background spawn (§6 test 5)', () => {
  it('pins the full descriptor field-by-field for an alias-stamped named definition', async () => {
    const { ctx, parent, store, workspace } = await setup(
      [textResponse('working')],
      {
        researcherDefinition: true,
        gitInit: true,
        routes: { sonnet: { provider: 'mock', model: 'mock-sonnet', reasoningEffort: 'low' } },
        reasoning: { efforts: [{ id: 'low', name: 'low' }], defaultEffort: 'low' },
        defaultMaxTokens: 2048,
      },
    )

    const agentId = await startBackground(ctx, parent, { subagent_type: 'researcher' })
    const pin = store.read(agentId)
    expect(pin, 'the pin for the preallocated child id must exist').toBeDefined()
    // Wait for the child's turn to close before reading its persisted session.
    await vi.waitFor(() => expect(ctx.agents.get(SessionId(agentId))).toBeUndefined(), { timeout: 10_000 })
    expect(pin).toMatchObject({
      version: 1,
      childId: agentId,
      parentSessionId: 'parent',
      label: 'long research',
      mode: 'continuable-background',
      definition: {
        kind: 'named',
        agentType: 'researcher',
        source: 'project',
        fingerprint: definitionFingerprint({
          agentType: 'researcher',
          whenToUse: 'reads things',
          systemPrompt: 'RESEARCHER PERSONA MARKER',
          source: 'project',
          baseDir: '',
          filename: 'researcher',
          toolRestriction: { allow: ['read'] },
          model: 'sonnet',
        } as never),
        personaHash: personaHash('RESEARCHER PERSONA MARKER'),
      },
      modelSelector: { raw: 'sonnet', via: 'alias' },
      effective: { provider: 'mock', model: 'mock-sonnet', reasoningEffort: 'low', maxTokens: 2048, complete: true },
      toolFilter: { allow: ['read'], deny: [] },
      workspace: { cwd: workspace },
      resume: { state: 'ok' },
    })
    // The preallocated id IS the durable child session id (a persisted
    // session exists under it — the jsonl backend's cold inspection).
    expect(await ctx.sessionPersistence.readStoredRevision(SessionId(pin!.childId))).toBeDefined()
  }, 20_000)

  it('pins kind "plain" for a general-purpose background spawn', async () => {
    const { ctx, parent, store } = await setup([textResponse('working')], { defaultMaxTokens: 512 })
    const agentId = await startBackground(ctx, parent)
    expect(store.read(agentId)).toMatchObject({
      definition: { kind: 'plain' },
      modelSelector: { raw: 'inherit', via: 'inherit' },
      effective: { provider: 'mock', model: 'mock', reasoningEffort: null, maxTokens: 512, complete: true },
      toolFilter: { allow: [], deny: [] },
      resume: { state: 'ok' },
    })
  }, 20_000)
})

describe('resume pin capture — effective tuple equivalence (§4.3)', () => {
  it('the hand-built overlay matches the harness child-agent spread, field by field', () => {
    const parentRoutes: { provider?: string; model?: string; maxTokens?: number }[] = [
      { provider: 'mock', model: 'mock', maxTokens: 999 },
      { provider: 'mock', model: 'mock' },
      { model: 'mock' },
      {},
    ]
    const routes: (ResolvedRoute | undefined)[] = [
      { provider: 'mock', model: 'mock-sonnet', reasoningEffort: 'low' },
      { model: 'mock-sonnet' },
      { reasoningEffort: 'high' },
      undefined,
    ]
    for (const parent of parentRoutes) {
      for (const route of routes) {
        // The harness spread: parent options conditionally, then the child
        // request (toAgentOptions drops undefined fields) on top. The fake
        // parent exposes a session whose requestHeader is unset, matching a
        // parent with no in-flight request config.
        const harness = resolveChildAgentOptions(
          { options: parent, session: { requestHeader: () => undefined } } as never,
          toAgentOptions(route) as never,
          0,
        )
        const pinned = overlayRoute(parent, route)
        expect(pinned.provider).toBe(harness.provider)
        expect(pinned.model).toBe(harness.model)
        expect(pinned.maxTokens).toBe(harness.maxTokens)
      }
    }
  })
})

describe('resume pin capture — spawn-failure tombstone (§4.5 step 4)', () => {
  it('removes the pin when startContinuable throws and rethrows unchanged', async () => {
    const { ctx, parent, store, pinsRoot } = await setup([textResponse('never used')])
    const seam = ctx.get('subagents') as { startContinuable(): Promise<unknown> }
    seam.startContinuable = () => Promise.reject(new Error('boom'))
    await expect(startBackground(ctx, parent)).rejects.toThrow('boom')
    // The pin was tombstoned (file removed) — nothing orphaned under the root.
    expect(readdirSync(pinsRoot).filter(name => name.endsWith('.json'))).toEqual([])
  }, 20_000)
})

describe('resume pin capture — degraded preflight (§4.3)', () => {
  it('writes an explicit-fields-only pin with complete:false, warns, and the spawn still succeeds', async () => {
    const { ctx, parent, store, warns } = await setup(
      [textResponse('working')],
      {
        routes: { sonnet: { provider: 'ghost', model: 'ghost-model' } },
        researcherDefinition: true,
        defaultMaxTokens: 2048,
      },
    )
    // The 'ghost' provider is unmounted at preflight; an agent/request
    // middleware supplies the real route at request time (harness
    // agent-loop agent.ts:457), so the spawn succeeds anyway.
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'mock', model: 'mock' }
    })

    const agentId = await startBackground(ctx, parent, { subagent_type: 'researcher' })
    expect(store.read(agentId)).toMatchObject({
      definition: { kind: 'named', agentType: 'researcher' },
      modelSelector: { raw: 'sonnet', via: 'alias' },
      effective: { provider: 'ghost', model: 'ghost-model', reasoningEffort: null, maxTokens: null, complete: false },
      resume: { state: 'ok' },
    })
    expect(warns.some(message => message.includes('resume pin degraded'))).toBe(true)
  }, 20_000)
})

describe('resume pin capture — never a silent unpinned launch (H6)', () => {
  it('a forced pin-write failure keeps the spawn alive and the tool result carries an explicit captureWarning', async () => {
    const { ctx, parent, pinsRoot } = await setup(
      [textResponse('working')],
      { gitInit: true },
    )
    // Sabotage the pins root: make the directory unwritable so every pin
    // write fails (EACCES) while reads/listing stay healthy.
    chmodSync(pinsRoot, 0o500)
    const result = await callTool(ctx, 'subagent_fork', {
      description: 'long research',
      prompt: 'slow work',
      run_in_background: true,
    }, parent)
    const resultText = text(result as never)
    // The spawn itself still succeeds (async_launched)…
    if (result.isError) throw new Error(`spawn failed: ${resultText}`)
    // DEBUG
    if (!/capture failed/.test(resultText)) throw new Error(`no warning; text=${resultText}`)
    expect(/async_launched|agentId:/.test(resultText)).toBe(true)
    expect(/agentId: [0-9a-f-]{36}/.exec(resultText)).not.toBeNull()
    // …but the capture failure is explicit in the result, never silent.
    expect(resultText).toContain('resume pin capture failed: ')
    expect(resultText).toContain('this child will resume with legacy semantics')
    // Restore so afterEach cleanup can remove the tree.
    chmodSync(pinsRoot, 0o755)
  }, 20_000)
})

describe('probeWorkspace — absolute git identity paths (M13)', () => {
  it('normalizes git rev-parse output to cwd-anchored absolute real paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-probe-'))
    roots.push(dir)
    execSync('git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: dir })
    const probed = probeWorkspace(dir)
    expect(probed.cwd).toBe(dir)
    expect(isAbsolute(probed.gitDir)).toBe(true)
    expect(isAbsolute(probed.gitCommonDir)).toBe(true)
    // realpath: macOS /tmp-style links are canonicalized.
    expect(probed.gitDir).toBe(realpathSync(join(dir, '.git')))
  })

  it('a non-repo cwd falls back to the unknown sentinel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-probe-'))
    roots.push(dir)
    const probed = probeWorkspace(dir)
    expect(probed).toMatchObject({ gitDir: 'unknown', gitCommonDir: 'unknown', branch: 'unknown' })
  })

  it('RESIDUAL LIMIT (documented): two different standalone repos at the same path probe the SAME identity paths', () => {
    // The identity comparison is the normalized --git-dir/--git-common-dir
    // path pair. Worktree↔standalone flips and cwd moves change those paths
    // and ARE detected; re-initializing a different repo at the same path
    // yields the same path strings and is NOT detectable by this probe.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cc-probe-'))
    roots.push(dir)
    execSync('git init -q -b main', { cwd: dir })
    const first = probeWorkspace(dir)
    rmSync(join(dir, '.git'), { recursive: true, force: true })
    execSync('git init -q -b other', { cwd: dir })
    const second = probeWorkspace(dir)
    expect(second.gitDir).toBe(first.gitDir)
    expect(second.gitCommonDir).toBe(first.gitCommonDir)
  })
})
