import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecution, type ToolExecutionInput, type ToolExecutionResult } from '@dsh-cc/tools'
import { defineContentToolFixture, executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider, type SettingsNamespace } from '@dsh-cc/settings'
import PermissionRules, { PERMISSION_SETTINGS_NAMESPACE, PLAN_READONLY_REASON, type Config } from '@dsh-cc/permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as CcToolExecutor from '@dsh-cc/tools/executor'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { decideCallVerbose, type DecideDeps, type McpToolClass, type McpToolClassSource } from '../src/decide.ts'
import { createMcpToolClassOf } from '../src/pre-execute.ts'
import { parseRule } from '../src/parser.ts'
import type { PermissionRuleSet } from '../src/types.ts'
import type { PermissionSettings } from '../src/settings-schema.ts'

const testToolSignal = new AbortController().signal

// ── unit face: decideCallVerbose with a stub classification supplier ────────

function fakeExec(name: string, args: unknown): ToolExecution {
  return { signal: testToolSignal, callId: 'c1', name, arguments: args } as unknown as ToolExecution
}

function rules(overrides: Partial<PermissionRuleSet> = {}): PermissionRuleSet {
  return { allow: [], deny: [], ask: [], bypassImmune: [], ...overrides }
}

function deps(overrides: Partial<DecideDeps> = {}): DecideDeps {
  return {
    classifierEnabled: true,
    exemptSandboxedBashFromToolAsk: false,
    bashToolName: 'Bash',
    fileEditTools: new Set(['edit']),
    readOnlyTools: new Set(['read']),
    settings: () => ({}),
    defaultMode: () => 'default',
    rules: () => rules(),
    bypassDisabled: () => false,
    sessionAllowMatches: () => false,
    mcpToolClassOf: () => undefined,
    shellMode: () => undefined,
    ...overrides,
  }
}

/** A dep face whose ONE MCP tool resolves to `mcpClass` from `source`. */
function classified(mcpClass: McpToolClass, mcpClassSource: McpToolClassSource, overrides: Partial<DecideDeps> = {}): DecideDeps {
  return deps({ mcpToolClassOf: () => ({ mcpClass, mcpClassSource }), ...overrides })
}

const MCP_TOOL = 'mcp__serena__replace_content'

describe('DecidedCall MCP classification wiring (D3)', () => {
  it('settings/curated readOnly ⇒ isReadOnly true (plan mode does not wrap it)', () => {
    for (const source of ['settings', 'curated'] as const) {
      const decided = decideCallVerbose(classified('readOnly', source, { defaultMode: () => 'plan' }), fakeExec(MCP_TOOL, {}))
      expect(decided.isReadOnly).toBe(true)
      expect(decided).toMatchObject({ mcpClass: 'readOnly', mcpClassSource: source })
      expect(decided.decision.kind).not.toBe('deny')
    }
  })

  it('annotation readOnly ⇒ NOT isReadOnly: plan mode still denies (no amplification)', () => {
    const decided = decideCallVerbose(
      classified('readOnly', 'annotation', { defaultMode: () => 'plan' }),
      fakeExec(MCP_TOOL, {}),
    )
    expect(decided.isReadOnly).toBe(false)
    expect(decided).toMatchObject({ mcpClass: 'readOnly', mcpClassSource: 'annotation' })
    expect(decided.decision).toEqual({ kind: 'deny', reason: PLAN_READONLY_REASON })
  })

  it('workspaceWrite ⇒ NOT isReadOnly: plan mode still wraps it', () => {
    const decided = decideCallVerbose(
      classified('workspaceWrite', 'settings', { defaultMode: () => 'plan' }),
      fakeExec(MCP_TOOL, {}),
    )
    expect(decided.isReadOnly).toBe(false)
    expect(decided).toMatchObject({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' })
    expect(decided.decision).toEqual({ kind: 'deny', reason: PLAN_READONLY_REASON })
  })

  it('unclassified ⇒ both class fields absent', () => {
    const decided = decideCallVerbose(deps({ defaultMode: () => 'auto' }), fakeExec(MCP_TOOL, {}))
    expect(decided.mcpClass).toBeUndefined()
    expect(decided.mcpClassSource).toBeUndefined()
  })

  it('a deny rule wins over BOTH classes', () => {
    for (const mcpClass of ['readOnly', 'workspaceWrite'] as const) {
      const decided = decideCallVerbose(
        classified(mcpClass, 'settings', {
          defaultMode: () => 'auto',
          rules: () => rules({ deny: [parseRule(MCP_TOOL, 'deny', 'config')] }),
        }),
        fakeExec(MCP_TOOL, {}),
      )
      expect(decided.decision.kind).toBe('deny')
    }
  })

  it('an ask rule wins over BOTH classes', () => {
    for (const mcpClass of ['readOnly', 'workspaceWrite'] as const) {
      const decided = decideCallVerbose(
        classified(mcpClass, 'settings', {
          defaultMode: () => 'auto',
          rules: () => rules({ ask: [parseRule(MCP_TOOL, 'ask', 'config')] }),
        }),
        fakeExec(MCP_TOOL, {}),
      )
      expect(decided.decision.kind).toBe('ask')
    }
  })
})

describe('D6b workspaceWrite protected screen', () => {
  const hit = deps({
    defaultMode: () => 'auto',
    mcpToolClassOf: () => ({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' }),
  })

  it('a .mcp.json argument value ⇒ deterministic protected ask, classification dropped', () => {
    const decided = decideCallVerbose(hit, fakeExec(MCP_TOOL, { relative_path: '.mcp.json', content: 'x' }))
    expect(decided.decision).toEqual({
      kind: 'ask',
      reason: 'requires approval: workspaceWrite tool arguments match protected pattern .mcp.json',
    })
    expect(decided.mcpClass).toBeUndefined()
    expect(decided.mcpClassSource).toBeUndefined()
  })

  it('nested and array values are screened per value (anchored, not substring-over-JSON)', () => {
    const decided = decideCallVerbose(hit, fakeExec(MCP_TOOL, { payload: { files: ['src/a.ts', '.ssh/id_rsa'] } }))
    expect(decided.decision).toEqual({
      kind: 'ask',
      reason: 'requires approval: workspaceWrite tool arguments match protected pattern .ssh/**',
    })
    expect(decided.mcpClass).toBeUndefined()
  })

  it('clean in-workspace strings ⇒ classification kept, decision untouched', () => {
    const decided = decideCallVerbose(hit, fakeExec(MCP_TOOL, { relative_path: 'src/a.ts', content: 'not a path' }))
    expect(decided.decision.kind).toBe('passthrough')
    expect(decided).toMatchObject({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' })
  })

  it('settings protectedFiles replace the curated defaults; an empty list keeps them', () => {
    const custom = deps({
      defaultMode: () => 'auto',
      settings: () => ({ protectedFiles: ['secrets/**'] }),
      mcpToolClassOf: () => ({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' }),
    })
    expect(decideCallVerbose(custom, fakeExec(MCP_TOOL, { relative_path: '.mcp.json' })).decision.kind).toBe('passthrough')
    expect(decideCallVerbose(custom, fakeExec(MCP_TOOL, { relative_path: 'secrets/key.pem' })).decision).toMatchObject({
      kind: 'ask',
      reason: 'requires approval: workspaceWrite tool arguments match protected pattern secrets/**',
    })
    // The settings schema materializes an absent `protectedFiles` as `[]`, so
    // an empty list must keep the curated defaults effective.
    const empty = deps({
      defaultMode: () => 'auto',
      settings: () => ({ protectedFiles: [] }),
      mcpToolClassOf: () => ({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' }),
    })
    expect(decideCallVerbose(empty, fakeExec(MCP_TOOL, { relative_path: '.mcp.json' })).decision).toMatchObject({ kind: 'ask' })
  })

  it('a waterfall deny still stands over the screen', () => {
    const denyDeps = deps({
      defaultMode: () => 'auto',
      rules: () => rules({ deny: [parseRule(MCP_TOOL, 'deny', 'config')] }),
      mcpToolClassOf: () => ({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' }),
    })
    const decided = decideCallVerbose(denyDeps, fakeExec(MCP_TOOL, { relative_path: '.mcp.json' }))
    expect(decided.decision.kind).toBe('deny')
    expect(decided.mcpClass).toBeUndefined()
  })

  it('bypassPermissions never turns the screen into an ask', () => {
    const bypass = deps({
      defaultMode: () => 'bypassPermissions',
      mcpToolClassOf: () => ({ mcpClass: 'workspaceWrite', mcpClassSource: 'settings' }),
    })
    const decided = decideCallVerbose(bypass, fakeExec(MCP_TOOL, { relative_path: '.mcp.json' }))
    expect(decided.decision.kind).not.toBe('ask')
    expect(decided.mcpClass).toBeUndefined()
  })
})

// ── mechanism face: fake cordis ctx, real registry + settings ───────────────

/** Minimal in-memory settings provider (same pattern as listener-auto-stage.spec.ts). */
class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** Fake `llm` service: an invoked classifier stream FAILS the test. */
class FakeLlm extends Service {
  calls: GenerateOptions[] = []

  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    throw new Error('the classifier stream must not run for a classified call')
    // Unreachable: the throw fires on the first `next()` (kept for the type).
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Fake `ccModelRoutes` service: every alias resolves to a deterministic route. */
class FakeRoutes extends Service {
  constructor(ctx: Context) {
    super(ctx, 'ccModelRoutes')
  }

  resolve(): { provider: string; model: string } {
    return { provider: 'fake', model: 'classifier-model' }
  }

  resolveDetailed(): { selector: string; via: 'alias'; route: { provider: string; model: string } } {
    return { selector: 'classifier-model', via: 'alias', route: this.resolve() }
  }
}

/** One MCP-stamped fixture: the public name, the stamped identity, annotations. */
function mcpTool(name: string, server: string, rawName: string, annotations?: { readOnlyHint?: boolean }) {
  const base = defineContentToolFixture({
    name,
    description: `${server}:${rawName}`,
    parameters: { relative_path: { type: 'string' } },
    async execute(args) {
      return [{ type: 'text' as const, text: `ok:${(args as { relative_path?: string }).relative_path ?? ''}` }]
    },
  })
  return { ...base, mcp: { server, rawName }, ...(annotations === undefined ? {} : { annotations }) }
}

const FIND_SYMBOL = 'mcp__serena__find_symbol'
const REPLACE_CONTENT = 'mcp__serena__replace_content'
const ANNOTATED = 'mcp__custom__list'
const UNCLASSIFIED = 'mcp__other__do'

async function mount(config: Config = {}): Promise<{ ctx: Context; llm: FakeLlm }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(CcToolExecutor)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(FakeRoutes)
  await ctx.plugin(FakeLlm)
  const llm = ctx.get('llm') as FakeLlm
  await ctx.plugin(PermissionRules, {
    fileEditTools: ['edit'],
    readOnlyTools: ['read'],
    bashToolName: 'Bash',
    ...config,
  })
  // Curated serena read tool, an unclassified serena write tool, a server with
  // only a server-authored readOnly annotation, and a server with no entry.
  ctx.tools.register(mcpTool(FIND_SYMBOL, 'serena', 'find_symbol'))
  ctx.tools.register(mcpTool(REPLACE_CONTENT, 'serena', 'replace_content'))
  ctx.tools.register(mcpTool(ANNOTATED, 'custom', 'list', { readOnlyHint: true }))
  ctx.tools.register(mcpTool(UNCLASSIFIED, 'other', 'do'))
  return { ctx, llm }
}

function exec(name: string, args: unknown, agent?: Agent): ToolExecutionInput {
  return { signal: testToolSignal, callId: ToolCallId('c1'), name, arguments: args, ...(agent ? { agent } : {}) }
}

function text(result: ToolExecutionResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

/**
 * Classifier-lane calls only: the S7 PI probe lane shares this fake `llm` and
 * streams at maxTokens 256, so raw `llm.calls` never isolates arbitration.
 */
function classifierCalls(llm: FakeLlm): GenerateOptions[] {
  return llm.calls.filter(call => call.maxTokens === 1024)
}

function agentOf(id: string): Agent {
  const session = Session.create(SessionId(id), undefined, { version: 4, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd: '/work' })
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}

/** Arm the classifier lane in `auto` mode plus any extra settings section keys. */
async function arm(ctx: Context, extra: Record<string, unknown> = {}): Promise<void> {
  await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, {
    autoMode: { classifier: { enabled: true } },
    ...extra,
  })
}

describe('MCP classification mechanism (auto mode, armed classifier)', () => {
  afterEach(() => { /* context disposal is owned by each test's ctx */ })

  it('curated readOnly ⇒ the call runs and the classifier stream is NEVER invoked', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx)
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    const agent = agentOf('mcp-curated')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await executeModelToolFixture(ctx, exec(FIND_SYMBOL, { relative_path: 'src/a.ts' }, agent))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ok:src/a.ts')
    expect(asked).toHaveLength(0)
    expect(classifierCalls(llm)).toHaveLength(0)
  })

  it('settings readOnly (REPLACES the curated row) ⇒ allow; a curated tool becomes unclassified', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx, { mcpToolClasses: { serena: { readOnlyTools: ['find_symbol'] } } })
    const agent = agentOf('mcp-settings-readonly')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await executeModelToolFixture(ctx, exec(FIND_SYMBOL, { relative_path: 'src/a.ts' }, agent))
    expect(result.isError).toBe(false)
    expect(classifierCalls(llm)).toHaveLength(0)

    // The settings entry replaced the curated row: another curated tool is
    // unclassified again, so the gauge lane is consulted (and fails closed).
    await executeModelToolFixture(ctx, exec('mcp__serena__get_symbols_overview', {}, agent))
    expect(classifierCalls(llm).length).toBe(1)
  })

  it('annotation readOnly with trustMcpAnnotations ⇒ allow with the gauge skipped; absent ⇒ gauge consulted', async () => {
    const untrusted = await mount()
    await arm(untrusted.ctx)
    const untrustedAgent = agentOf('mcp-annotation-untrusted')
    untrusted.ctx.permissionRules.setMode(untrustedAgent, 'auto')
    await executeModelToolFixture(untrusted.ctx, exec(ANNOTATED, {}, untrustedAgent))
    expect(classifierCalls(untrusted.llm).length).toBe(1)

    const trusted = await mount()
    await arm(trusted.ctx, { trustMcpAnnotations: true })
    const asked: unknown[] = []
    trusted.ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    const trustedAgent = agentOf('mcp-annotation-trusted')
    trusted.ctx.permissionRules.setMode(trustedAgent, 'auto')
    const result = await executeModelToolFixture(trusted.ctx, exec(ANNOTATED, {}, trustedAgent))
    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
    expect(classifierCalls(trusted.llm)).toHaveLength(0)
  })

  it('workspaceWrite via settings ⇒ allow with the gauge skipped', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx, { mcpToolClasses: { serena: { workspaceWriteTools: ['replace_content'] } } })
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    const agent = agentOf('mcp-workspace-write')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await executeModelToolFixture(ctx, exec(REPLACE_CONTENT, { relative_path: 'src/a.ts' }, agent))
    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
    expect(classifierCalls(llm)).toHaveLength(0)
  })

  it('a deny rule still wins over a classified call', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx, { deny: [`${FIND_SYMBOL}`] })
    const agent = agentOf('mcp-deny-wins')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await executeModelToolFixture(ctx, exec(FIND_SYMBOL, { relative_path: 'src/a.ts' }, agent))
    expect(result.isError).toBe(true)
    expect(classifierCalls(llm)).toHaveLength(0)
  })

  it('D6b: a .mcp.json argument value on a workspaceWrite call ⇒ deterministic protected ask', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx, { mcpToolClasses: { serena: { workspaceWriteTools: ['replace_content'] } } })
    const reasons: string[] = []
    ctx.on('approval/request', async (req) => {
      reasons.push(String((req as { reason?: string }).reason ?? ''))
      return 'allowed-once'
    })
    const agent = agentOf('mcp-protected-ask')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await executeModelToolFixture(ctx, exec(REPLACE_CONTENT, { relative_path: '.mcp.json' }, agent))
    expect(result.isError).toBe(false)
    expect(reasons).toEqual([
      'requires approval: workspaceWrite tool arguments match protected pattern .mcp.json',
    ])
    expect(classifierCalls(llm)).toHaveLength(0)
  })

  it('D6b: a waterfall deny still stands over the protected screen', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx, { deny: [REPLACE_CONTENT], mcpToolClasses: { serena: { workspaceWriteTools: ['replace_content'] } } })
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    const agent = agentOf('mcp-protected-deny')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await executeModelToolFixture(ctx, exec(REPLACE_CONTENT, { relative_path: '.mcp.json' }, agent))
    expect(result.isError).toBe(true)
    expect(asked).toHaveLength(0)
    expect(classifierCalls(llm)).toHaveLength(0)
  })

  it('an unclassified MCP server keeps the gauge path unchanged', async () => {
    const { ctx, llm } = await mount()
    await arm(ctx)
    const agent = agentOf('mcp-unclassified')
    ctx.permissionRules.setMode(agent, 'auto')

    await executeModelToolFixture(ctx, exec(UNCLASSIFIED, {}, agent))
    expect(classifierCalls(llm).length).toBe(1)
  })
})

describe('createMcpToolClassOf (executing-definition resolution, D4)', () => {
  const settings = (overrides: Partial<PermissionSettings> = {}): PermissionSettings => ({
    mcpToolClasses: { serena: { readOnlyTools: ['find_symbol'] } },
    ...overrides,
  })

  it('resolves a stamped definition through the registry and the live settings', async () => {
    const { ctx } = await mount()
    const resolve = createMcpToolClassOf(ctx, () => settings())
    expect(resolve(fakeExec(FIND_SYMBOL, {}))).toEqual({ mcpClass: 'readOnly', mcpClassSource: 'settings' })
  })

  it('an unregistered name is unclassified (fail-safe, never throws)', async () => {
    const { ctx } = await mount()
    const resolve = createMcpToolClassOf(ctx, () => settings())
    expect(resolve(fakeExec('mcp__serena__not_registered', {}))).toBeUndefined()
  })

  it('a definition without a stamped MCP identity is unclassified', async () => {
    const { ctx } = await mount()
    ctx.tools.register(defineContentToolFixture({
      name: 'plain-native',
      description: 'native',
      parameters: {},
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    }))
    const resolve = createMcpToolClassOf(ctx, () => settings())
    expect(resolve(fakeExec('plain-native', {}))).toBeUndefined()
  })

  it('trustMcpAnnotations gates the annotation source', async () => {
    const { ctx } = await mount()
    expect(createMcpToolClassOf(ctx, () => settings())(fakeExec(ANNOTATED, {}))).toBeUndefined()
    expect(createMcpToolClassOf(ctx, () => settings({ trustMcpAnnotations: true }))(fakeExec(ANNOTATED, {})))
      .toEqual({ mcpClass: 'readOnly', mcpClassSource: 'annotation' })
  })
})
