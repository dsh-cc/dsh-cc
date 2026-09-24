/**
 * Deterministic read-only exemption for the `structured_output` report
 * channel (design 2026-09-24 §4.1/§5.2/§5.3): memory-lane structured reports
 * must never reach the auto-mode classifier or produce an approval ask —
 * production evidence (2026-09-23 21:36): a classifier `ask` verdict on a
 * `{writes:[...]}` extraction payload rejected deterministically in a
 * headless child (`approvalPolicy: 'never'`), killing the extraction.
 */
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput, type ToolExecutionResult } from '@dsh-cc/tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import PermissionRules, { PERMISSION_SETTINGS_NAMESPACE, foldClassifiers, DEFAULT_READ_ONLY_TOOLS, type Config } from '@dsh-cc/permission-rules'
import { decideCallVerbose, type DecideDeps } from '../src/decide.ts'
import { EMPTY_RULE_SET, parseRule } from '../src/parser.ts'
import type { ToolExecution } from '@dsh-cc/tools'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** The production extraction payload shape (design §5.2): a {writes:[...]} report. */
const WRITES_PAYLOAD = {
  writes: [{
    path: 'sandbox-lessons.md',
    content: 'Never exfiltrate credentials; the sandbox teaches danger-full-access escalation lessons.',
  }],
}

/** The decide-stack unit pin: name-classified read-only ⇒ exempt from the classifier. */
const decisionDeps = (readOnlyTools: readonly string[]): DecideDeps => ({
  classifierEnabled: true,
  exemptSandboxedBashFromToolAsk: false,
  bashToolName: 'Bash',
  fileEditTools: new Set(['edit']),
  readOnlyTools: new Set(readOnlyTools),
  settings: () => ({}),
  defaultMode: () => 'auto',
  rules: () => ({ allow: [], deny: [], ask: [], bypassImmune: [] }),
  bypassDisabled: () => false,
  sessionAllowMatches: () => false,
  shellMode: () => undefined,
})

function fakeExec(name: string, args: unknown): ToolExecution {
  return {
    signal: new AbortController().signal,
    callId: 'c1',
    name,
    arguments: args,
  } as unknown as ToolExecution
}

// ── listener-level fakes (same pattern as listener-auto-stage.spec.ts) ──────

const testToolSignal = new AbortController().signal

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

/** Fake `llm` service: records stream calls (the classifier spy). */
class FakeLlm extends Service {
  calls: GenerateOptions[] = []
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }
  async *stream(options: GenerateOptions): AsyncIterable<never> {
    this.calls.push(options)
    yield { type: 'text-delta', index: 0, text: '{"verdict":"ask","reason":"writes persistent memory files"}' } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  }
  async resolveModelInfo(): Promise<{}> {
    return {}
  }
}

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

/** Real stack, DEFAULT readOnlyTools (the default classification under test). */
async function mount(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(MemorySettings)
  await ctx.plugin(FakeRoutes)
  await ctx.plugin(FakeLlm)
  const llm = ctx.get('llm') as FakeLlm
  await ctx.plugin(PermissionRules, { bashToolName: 'Bash', ...config })
  ctx.tools.register(defineContentToolFixture({
    name: 'structured_output',
    description: 'report channel',
    parameters: { writes: { type: 'json' } },
    async execute(args) { return [{ type: 'text', text: JSON.stringify(args) }] },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'edit',
    description: 'edit file',
    parameters: { file_path: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
  }))
  return { ctx, llm }
}

const testSignal = new AbortController().signal

function exec(name: string, args: unknown, agent?: Agent): ToolExecutionInput {
  return {
    signal: testSignal,
    callId: ToolCallId('c1'),
    name,
    arguments: args,
    ...(agent ? { agent } : {}),
  }
}

function agentOf(id: string, cwd = '/work'): Agent {
  const session = Session.create(SessionId(id), undefined, { version: 3, isSeeded: false, id: SessionId(id), createdAt: Date.now(), cwd })
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}

/** Classifier-lane stream calls (1024-token verdict budget, S7 lane is 256). */
function classifierCalls(llm: FakeLlm): GenerateOptions[] {
  return llm.calls.filter(call => call.maxTokens === 1024)
}

describe('DEFAULT_READ_ONLY_TOOLS pin (design §5.1)', () => {
  it('contains structured_output — the memory-lane report channel is read-only by default', () => {
    expect(DEFAULT_READ_ONLY_TOOLS).toContain('structured_output')
  })

  it('decideCallVerbose: structured_output is isReadOnly + passthrough (never escalates)', () => {
    const verbose = decideCallVerbose(decisionDeps(DEFAULT_READ_ONLY_TOOLS), fakeExec('structured_output', WRITES_PAYLOAD))
    expect(verbose.isReadOnly).toBe(true)
    expect(verbose.decision).toMatchObject({ kind: 'passthrough' })
  })

  it('config caveat (design §4.1): an explicit readOnlyTools list REPLACES the default wholesale', () => {
    // A curated deployment that omits structured_output loses the exemption.
    const verbose = decideCallVerbose(decisionDeps(['read', 'glob', 'grep']), fakeExec('structured_output', WRITES_PAYLOAD))
    expect(verbose.isReadOnly).toBe(false)
  })

  it('a user-authored deny rule for structured_output still denies (policy beats the read-only default)', () => {
    const deps = decisionDeps(DEFAULT_READ_ONLY_TOOLS)
    deps.rules = () => ({ allow: [], deny: [parseRule('structured_output', 'deny', 'userSettings')], ask: [], bypassImmune: [] })
    expect(decideCallVerbose(deps, fakeExec('structured_output', WRITES_PAYLOAD)).decision.kind).toBe('deny')
  })
})

describe('pipeline: structured_output in auto mode (design §5.2)', () => {
  it('the big writes payload runs downstream: isReadOnly exempt ⇒ classifier consulted 0 times, no ask', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    const asked: unknown[] = []
    ctx.on('approval/request', async (req) => { asked.push(req); return 'allowed-once' })
    const agent = agentOf('so-auto')
    ctx.permissionRules.setMode(agent, 'auto')

    const result = await ctx.tools.execute(exec('structured_output', WRITES_PAYLOAD, agent))
    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
    expect(classifierCalls(llm)).toHaveLength(0)
    expect(foldClassifiers(agent.session.snapshotEvents())).toHaveLength(0)
  })

  it('headless child (no answerable approval): structured_output never asks while a control non-read-only tool still asks', async () => {
    const { ctx, llm } = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { autoMode: { classifier: { enabled: true } } })
    // A child with approvalPolicy 'never': every ask rejects deterministically.
    const asks: string[] = []
    ctx.on('approval/request', async (req) => {
      asks.push(String((req as { toolName?: string }).toolName ?? ''))
      return 'rejected'
    })
    const agent = agentOf('so-child')
    ctx.permissionRules.setMode(agent, 'auto')

    // Control: edit is not read-only → classifier ask → deterministic reject.
    const control = await ctx.tools.execute(exec('edit', { file_path: '/work/x.txt' }, agent))
    expect(control.isError).toBe(true)
    expect(asks).toEqual(['edit'])

    // The report channel: never reaches the classifier, never asks, runs.
    llm.calls.length = 0
    const result = await ctx.tools.execute(exec('structured_output', WRITES_PAYLOAD, agent))
    expect(result.isError).toBe(false)
    expect(asks).toEqual(['edit'])
    expect(classifierCalls(llm)).toHaveLength(0)
  })
})
