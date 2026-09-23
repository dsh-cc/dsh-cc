/**
 * Unit tests for the CC-parity workflow tool (plan DoD 2): fake
 * `workflowEngine` + fake session (offline stubs). Covers the source
 * precedence matrix, strict inline-meta extraction, both-meta and
 * absent-meta refusals, the documented launch-receipt subset, targeted
 * off-slice refusals, single-active-run, registry disposal, the four durable
 * events with the `source` extension, and prompt-section registration.
 *
 * The busy-vein never-in-pending-inbox assertion and the scripted idle wake
 * live in `idle-wake.spec.ts` (harness `agent-loop-testkit`, real AgentLoop).
 */

import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { WorkflowEngine, WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowResult, WorkflowRun,
  WorkflowRunId as WorkflowRunIdType, WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import ToolRuntimeCC from '@dsh-cc/tools'
import * as toolWorkflow from '../src/index.ts'
import { extractInlineMeta } from '../src/meta-extract.ts'

const testToolSignal = new AbortController().signal

/** A controllable engine standing in behind ctx.workflowEngine (the tool's only seam). */
class StubEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  disposed = 0
  startError: Error | undefined
  private readonly settlements = new Map<WorkflowRunIdType, (result: WorkflowResult) => void>()

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError) throw this.startError
    this.requests.push(request)
    const id = WorkflowRunId(`run-${this.requests.length}`)
    const result = new Promise<WorkflowResult>((resolve) => { this.settlements.set(id, resolve) })
    return {
      id,
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settlements.get(id)?.({ value: null, stopReason: 'cancelled', ...reason !== undefined ? { error: reason } : {}, agentsStarted: 0 })
      },
      dispose: async () => { this.disposed += 1 },
    }
  }

  settleRun(id: WorkflowRunIdType, result: WorkflowResult): void {
    const settle = this.settlements.get(id)
    if (settle === undefined) throw new Error(`unknown stub workflow ${id}`)
    settle(result)
  }

  agentStart(id: WorkflowRunIdType, agent: WorkflowAgentInfo): void {
    this.emitWorkflowEvent('workflow/agent-start', { id, meta: this.requests[Number(String(id).slice(4)) - 1]!.meta }, agent)
  }

  agentEnd(id: WorkflowRunIdType, agent: WorkflowAgentEndInfo): void {
    this.emitWorkflowEvent('workflow/agent-end', { id, meta: this.requests[Number(String(id).slice(4)) - 1]!.meta }, agent)
  }
}

function fakeAgent(append: ReturnType<typeof vi.fn>, options: { status?: 'idle' | 'running'; cwd?: string; inject?: ReturnType<typeof vi.fn>; followup?: ReturnType<typeof vi.fn> } = {}) {
  const session = {
    id: 'caller',
    append,
    snapshotEvents: () => [],
    // Mirrors the real Session surface launch.ts reads (`session.header.cwd`).
    header: { cwd: options.cwd ?? process.cwd() },
  }
  return {
    id: 'caller-agent',
    options: { cwd: options.cwd },
    status: options.status ?? 'idle',
    session,
    inject: options.inject ?? vi.fn(),
    followup: options.followup ?? vi.fn(),
  } as never
}

async function setup(cwd?: string) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntimeCC)
  await ctx.plugin(StubEngine)
  // The tool plugin mounts ccWorkflowRunRegistry itself (idempotence guard:
  // a second mount would re-register the service).
  await ctx.plugin(toolWorkflow, {})
  const engine = ctx.workflowEngine as StubEngine
  return { ctx, engine }
}

let callCounter = 0
async function call(ctx: Context, args: unknown, agent?: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'workflow',
    arguments: args,
    ...(agent !== undefined ? { agent: agent as never } : {}),
  })
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const META_BLOCK = `export const meta = { name: 'audit', description: 'runs an audit' }`

const roots: string[] = []
function workspace(): string {
  const scratch = join(process.cwd(), '.scratch')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'tool-workflow-'))
  roots.push(root)
  return root
}

describe('inline meta extraction (strict literal parser)', () => {
  it('accepts trailing commas, comments, phases, and single/double quotes', () => {
    const extracted = extractInlineMeta(`// leading note
export const meta = {
  name: 'audit', /* block */ "description": "runs an audit",
  whenToUse: 'big audits',
  phases: [ { title: 'scan', detail: 'read files', }, ],
}
return 1`)
    expect(extracted.ok).toBe(true)
    if (!extracted.ok) return
    expect(extracted.meta).toEqual({
      name: 'audit',
      description: 'runs an audit',
      whenToUse: 'big audits',
      phases: [{ title: 'scan', detail: 'read files' }],
    })
    expect(extracted.body).toContain('return 1')
    expect(extracted.body).not.toContain('export const meta')
  })

  it('rejects construct classes with construct-naming errors', () => {
    const cases: [string, string][] = [
      ['export const meta = { name: `x`, description: \'d\' }', 'template literals'],
      ['export const meta = { name, description: \'d\' }', 'identifier'],
      ['export const meta = { ...rest }', 'spreads'],
      ['export const meta = { [\'name\']: \'x\', description: \'d\' }', 'computed keys'],
      ['export const meta = { name: () => \'x\', description: \'d\' }', 'function values'],
    ]
    for (const [script, expected] of cases) {
      const extracted = extractInlineMeta(script)
      expect(extracted.ok, script).toBe(false)
      if (extracted.ok) continue
      expect(extracted.error, script).toContain(expected)
    }
  })

  it('reports a missing meta block (not a construct error)', () => {
    const extracted = extractInlineMeta('return 1')
    expect(extracted.ok).toBe(false)
    if (extracted.ok) return
    expect(extracted.missing).toBe(true)
    expect(extracted.error).toContain('export const meta')
  })
})

describe('workflow tool (fake engine + fake session)', () => {
  it('launches an inline CC-doc-shaped script and returns the documented receipt subset', async () => {
    const { ctx, engine } = await setup()
    const append = vi.fn()
    const pending = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn { findings: [1] }`, args: { files: ['a.ts'] }, title: 'ignored', description: 'ignored' },
      agent: fakeAgent(append),
    })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    expect(engine.requests[0]).toMatchObject({ script: '\nreturn { findings: [1] }', meta: { name: 'audit', description: 'runs an audit' }, args: { files: ['a.ts'] } })
    engine.settleRun(WorkflowRunId('run-1'), { value: { findings: [1] }, stopReason: 'completed', agentsStarted: 3 })
    const result = await pending
    expect(result.isError).toBe(false)
    const value = (result as { value: Record<string, unknown> }).value
    expect(value).toEqual({
      status: 'async_launched',
      taskId: 'run-1',
      taskType: 'local_workflow',
      workflowName: 'audit',
      runId: 'run-1',
      summary: 'runs an audit',
    })
    expect('transcriptDir' in value).toBe(false)
    expect('scriptPath' in value).toBe(false)
    expect('sessionUrl' in value).toBe(false)
  })

  it('resolves sources with precedence scriptPath > script > name and reports shadowing/misses', async () => {
    const root = workspace()
    mkdirSync(join(root, '.claude', 'workflows'), { recursive: true })
    mkdirSync(join(root, 'home', 'workflows'), { recursive: true })
    writeFileSync(join(root, '.claude', 'workflows', 'w-a.js'), `${META_BLOCK}\nreturn 'project'\n`)
    writeFileSync(join(root, 'home', 'workflows', 'w-b.js'), `${META_BLOCK}\nreturn 'user'\n`)
    writeFileSync(join(root, 'plain.js'), `${META_BLOCK}\nreturn 'path'\n`)
    const realHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'home')
    try {
      const { ctx, engine } = await setup(root)
      const runWith = async (args: unknown, status: 'idle' | 'running' = 'idle') => {
        const append = vi.fn()
        const pending = ctx.tools.execute({
          signal: testToolSignal,
          callId: ToolCallId(`call-${++callCounter}`),
          name: 'workflow',
          arguments: args,
          agent: fakeAgent(append, { status, cwd: root }),
        })
        await vi.waitFor(() => { expect(engine.requests.length).toBeGreaterThanOrEqual(1) })
        const script = engine.requests[engine.requests.length - 1]!.script
        engine.settleRun(WorkflowRunId(`run-${engine.requests.length}`), { value: null, stopReason: 'completed', agentsStarted: 0 })
        const result = await pending
        return { script, result }
      }

      const byPath = await runWith({ scriptPath: 'plain.js' })
      expect(byPath.script).toContain(`return 'path'`)
      // scriptPath beats script; script beats name.
      const byScript = await runWith({ scriptPath: 'plain.js', script: `${META_BLOCK}\nreturn 'inline'` })
      expect(byScript.script).toContain(`return 'path'`)
      const byName = await runWith({ name: 'w-a', script: `${META_BLOCK}\nreturn 'inline'` })
      expect(byName.script).toContain(`return 'inline'`)
      const project = await runWith({ name: 'w-a' })
      expect(project.script).toContain(`return 'project'`)
      const user = await runWith({ name: 'w-b' })
      expect(user.script).toContain(`return 'user'`)
      const miss = await runWith({ name: 'w-missing' })
      expect(miss.result.isError).toBe(true)
      const missText = textOf(miss.result as { content: { type: string; text?: string }[] })
      expect(missText).toContain(join(root, '.claude', 'workflows', 'w-missing.js'))
      expect(missText).toContain(join(root, 'home', 'workflows', 'w-missing.js'))
    } finally {
      if (realHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = realHome
    }
  })

  it('populates warning on the saved-script name-disagreement path', async () => {
    const root = workspace()
    mkdirSync(join(root, '.claude', 'workflows'), { recursive: true })
    writeFileSync(join(root, '.claude', 'workflows', 'saved-name.js'), `${META_BLOCK}\nreturn 1\n`)
    const { ctx, engine } = await setup(root)
    const append = vi.fn()
    const pending = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { name: 'saved-name' },
      agent: fakeAgent(append, { cwd: root }),
    })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
    const result = await pending
    expect(result.isError).toBe(false)
    const value = (result as { value: Record<string, unknown> }).value
    expect(value.warning).toContain('"audit"')
    expect(value.warning).toContain('saved-name')
  })

  it('returns the error-populated no-start receipt (status + error, taskId absent) when the engine rejects', async () => {
    const { ctx, engine } = await setup()
    engine.startError = new Error('invalid meta: meta.phases[0].title must be a non-empty string')
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 1` },
      agent: fakeAgent(vi.fn()),
    })
    expect(result.isError).toBe(false)
    const value = (result as { value: Record<string, unknown> }).value
    expect(value.status).toBe('async_launched')
    expect(value.error).toContain('invalid meta')
    expect('taskId' in value).toBe(false)
  })

  it('refuses resumeFromRunId with the validateResume-unknown-id refusal and rejects unknown keys', async () => {
    const { ctx } = await setup()
    const resume = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 1`, resumeFromRunId: 'run-0' },
      agent: fakeAgent(vi.fn()),
    })
    expect(resume.isError).toBe(true)
    expect(textOf(resume as never)).toContain('unknown resumeFromRunId "run-0"')
    expect(textOf(resume as never)).toContain('settled runs this session: (none)')

    const unknown = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 1`, frobnicate: true },
      agent: fakeAgent(vi.fn()),
    })
    expect(unknown.isError).toBe(true)
    expect(textOf(unknown as never)).toContain('unknown option "frobnicate"')
  })

  it('errors on the both-meta ambiguity (inline block + meta param; saved file + meta param)', async () => {
    const { ctx } = await setup()
    const both = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 1`, meta: { name: 'm', description: 'd' } },
      agent: fakeAgent(vi.fn()),
    })
    expect(both.isError).toBe(true)
    expect(textOf(both as never)).toContain('mutually exclusive')

    const transitional = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: 'return 1', meta: { name: 'm', description: 'd' } },
      agent: fakeAgent(vi.fn()),
    })
    expect(transitional.isError).toBe(false)
  })

  it('refuses a missing-meta inline script with the CC-form refusal', async () => {
    const { ctx } = await setup()
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: 'return 1' },
      agent: fakeAgent(vi.fn()),
    })
    expect(result.isError).toBe(false)
    const value = (result as { value: Record<string, unknown> }).value
    expect(value.error).toContain('export const meta')
  })

  it('refuses a second concurrent run naming the in-flight runId', async () => {
    const { ctx, engine } = await setup()
    const first = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 1` },
      agent: fakeAgent(vi.fn()),
    })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    const second = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 2` },
      agent: fakeAgent(vi.fn()),
    })
    expect(second.isError).toBe(true)
    expect(textOf(second as never)).toContain('run-1')
    expect(textOf(second as never)).toContain('already active')
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
    await first
  })

  it('disposes: registry disposal cancels in-flight runs and swallows settle delivery', async () => {
    const { ctx, engine } = await setup()
    const inject = vi.fn()
    const agent = fakeAgent(vi.fn(), { inject, status: 'idle' })
    const pending = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 1` },
      agent,
    })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    const disposeRegistry = () => ctx.ccWorkflowRunRegistry.disposeAll()
    disposeRegistry()
    expect(engine.cancels).toEqual(['session ended'])
    expect(engine.disposed).toBe(1)
    engine.settleRun(WorkflowRunId('run-1'), { value: { x: 1 }, stopReason: 'completed', agentsStarted: 0 })
    await pending
    expect(inject).not.toHaveBeenCalled()
  })

  it('records the four durable events with the dsh-cc source extension (top-level only)', async () => {
    const { ctx, engine } = await setup()
    const append = vi.fn()
    const agent = fakeAgent(append)
    const pending = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 1` },
      agent,
    })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.agentStart(WorkflowRunId('run-1'), { seq: 1, label: 'scanner', childId: 'child-1' })
    engine.agentEnd(WorkflowRunId('run-1'), { seq: 1, outcome: 'completed' })
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 1 })
    await pending
    const types = append.mock.calls.map(call => call[0])
    expect(types).toEqual(['tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end'])
    expect(append.mock.calls[0]![1]).toEqual({ runId: 'run-1', name: 'audit', source: 'inline' })
    expect(append.mock.calls[1]![1]).toEqual({ runId: 'run-1', seq: 1, label: 'scanner', childId: 'child-1' })
    expect(append.mock.calls[2]![1]).toEqual({ runId: 'run-1', seq: 1, outcome: 'completed' })
    expect(append.mock.calls[3]![1]).toEqual({ runId: 'run-1', stopReason: 'completed' })
  })

  it('delivers the consolidated payload once on settle (idle fake agent) with the result capped', async () => {
    const { ctx, engine } = await setup()
    const followup = vi.fn()
    const agent = fakeAgent(vi.fn(), { followup, status: 'idle' })
    const pending = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 1` },
      agent,
    })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settleRun(WorkflowRunId('run-1'), { value: { big: 'x'.repeat(10) }, stopReason: 'completed', agentsStarted: 2 })
    await pending
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]![0] as { content: { text?: string }[] }
    const text = message.content.map(block => block.text ?? '').join('')
    expect(text).toContain('"big"')
    expect(text).toContain('completed (2 agents)')
  })

  it('queues delivery for a busy session instead of injecting', async () => {
    const { ctx, engine } = await setup()
    const inject = vi.fn()
    const agent = fakeAgent(vi.fn(), { inject, status: 'running' })
    const pending = ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId(`call-${++callCounter}`),
      name: 'workflow',
      arguments: { script: `${META_BLOCK}\nreturn 1` },
      agent,
    })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'error', error: 'boom', agentsStarted: 0 })
    await pending
    expect(inject).not.toHaveBeenCalled()
    expect(ctx.ccWorkflowRunRegistry.pendingFor('caller')).toHaveLength(1)
  })

  it('registers the tool:workflow prompt section under the TOOL_WORKFLOW order key', async () => {
    const { ctx } = await setup()
    const provider = await ctx.systemPrompt.assemble()
    const text = JSON.stringify(provider)
    expect(text).toContain('tool:workflow')
    expect(text).toContain('ultracode')
  })
})
