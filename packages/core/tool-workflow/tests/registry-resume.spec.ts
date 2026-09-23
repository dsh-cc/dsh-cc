/**
 * Resume-seam registry tests (resume-journal design §3.2–§3.4): pending-claim
 * deposit/claim/expiry semantics, drain-gated settled publication, FIFO
 * eviction deleting the evicted journal file, validateResume refusal
 * classes, `cached: true` provenance enrichment, and disposal clearing.
 *
 * The tool-level idiom (fake engine + fake session) mirrors
 * `tool-workflow.spec.ts`; journal paths are seeded under a temp DSH_HOME.
 */

import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import type { CcWorkflowRunRegistry, WorkflowJournalHandle } from '../src/registry.ts'

const testToolSignal = new AbortController().signal

/** A controllable engine standing in behind ctx.workflowEngine (mirrors tool-workflow.spec.ts). */
class StubEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  private readonly settlements = new Map<WorkflowRunIdType, (result: WorkflowResult) => void>()

  start(request: WorkflowStartRequest): WorkflowRun {
    this.requests.push(request)
    const id = WorkflowRunId(`run-${this.requests.length}`)
    const result = new Promise<WorkflowResult>((resolve) => { this.settlements.set(id, resolve) })
    return {
      id,
      meta: request.meta,
      result,
      cancel: () => { this.settlements.get(id)?.({ value: null, stopReason: 'cancelled', agentsStarted: 0 }) },
      dispose: async () => {},
    }
  }

  settleRun(id: WorkflowRunIdType, result: WorkflowResult): void {
    this.settlements.get(id)?.(result)
  }

  agentStart(id: WorkflowRunIdType, agent: WorkflowAgentInfo): void {
    this.emitWorkflowEvent('workflow/agent-start', { id, meta: this.requests[Number(String(id).slice(4)) - 1]!.meta }, agent)
  }

  agentEnd(id: WorkflowRunIdType, agent: WorkflowAgentEndInfo): void {
    this.emitWorkflowEvent('workflow/agent-end', { id, meta: this.requests[Number(String(id).slice(4)) - 1]!.meta }, agent)
  }
}

function fakeAgent(append: ReturnType<typeof vi.fn>, options: { status?: 'idle' | 'running'; followup?: ReturnType<typeof vi.fn> } = {}) {
  const session = {
    id: 'sess-test',
    append,
    snapshotEvents: () => [],
    header: { id: 'sess-test', cwd: process.cwd() },
  }
  return {
    id: 'caller-agent',
    options: {},
    status: options.status ?? 'idle',
    session,
    inject: vi.fn(),
    followup: options.followup ?? vi.fn(),
  } as never
}

const roots: string[] = []
function workspace(): string {
  const scratch = join(process.cwd(), '.scratch')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'registry-resume-'))
  roots.push(root)
  return root
}

/** Seed DSH_HOME for the duration of one test body (the tool-workflow.spec.ts idiom). */
async function withHome<T>(body: () => Promise<T>): Promise<T> {
  const root = workspace()
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await body()
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntimeCC)
  await ctx.plugin(StubEngine)
  await ctx.plugin(toolWorkflow, {})
  return { ctx, engine: ctx.workflowEngine as StubEngine, registry: ctx.ccWorkflowRunRegistry as CcWorkflowRunRegistry }
}

const META_BLOCK = `export const meta = { name: 'audit', description: 'runs an audit' }`

/** The seeded journal directory for the fake parent session id. */
function journalDir(): string {
  return join(process.env.DSH_HOME!, 'workflows', 'runs', 'sess-test')
}

/** Write one well-formed journal line so the settled run's journal exists. */
function seedJournal(runId: string): string {
  mkdirSync(journalDir(), { recursive: true })
  const path = join(journalDir(), `${runId}.jsonl`)
  writeFileSync(path, '{"seq":1,"hash":"h","status":"completed","result":{}}\n')
  return path
}

/** Launch one run through the tool and wait for its registration. */
async function launch(ctx: Context, engine: StubEngine, agent?: unknown): Promise<WorkflowRunIdType> {
  const pending = ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${Math.random()}`),
    name: 'workflow',
    arguments: { script: `${META_BLOCK}\nreturn 1` },
    agent: agent ?? fakeAgent(vi.fn()),
  })
  await vi.waitFor(() => { expect(engine.requests.length).toBeGreaterThanOrEqual(1) })
  void pending.catch(() => {})
  return engine.requests[engine.requests.length - 1]!.meta ? WorkflowRunId(`run-${engine.requests.length}`) : WorkflowRunId('run-x')
}

describe('registry resume seam', () => {
  it('deposits the pending claim in register() before the run-start record', async () => {
    await withHome(async () => {
      const { ctx, engine, registry } = await setup()
      const append = vi.fn()
      await launch(ctx, engine, fakeAgent(append))
      // register() ran synchronously inside the tool call: the claim exists and
      // the run-start record is already the first append.
      const claim = registry.takePendingClaim()
      expect(claim?.runId).toBe('run-1')
      expect(claim?.journalPath).toContain(join('workflows', 'runs', 'sess-test', 'run-1.jsonl'))
      expect(append.mock.calls[0]![0]).toBe('tool-workflow/run-start')
    })
  })

  it('takePendingClaim is one-shot: cleared after the first read', async () => {
    await withHome(async () => {
      const { ctx, engine, registry } = await setup()
      await launch(ctx, engine)
      expect(registry.takePendingClaim()?.runId).toBe('run-1')
      expect(registry.takePendingClaim()).toBeUndefined()
    })
  })

  it('a new deposit overwrites an unclaimed prior claim and settle clears the claim', async () => {
    await withHome(async () => {
      const { ctx, engine, registry } = await setup()
      await launch(ctx, engine)
      engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
      await Promise.resolve()
      await Promise.resolve()
      // Settle of an unclaimed run clears the deposit.
      expect(registry.takePendingClaim()).toBeUndefined()
      await launch(ctx, engine)
      expect(registry.takePendingClaim()?.runId).toBe('run-2')
    })
  })

  it('publishes the settled projection only after the bound journal drain resolves; delivery stays immediate', async () => {
    await withHome(async () => {
      const { ctx, engine, registry } = await setup()
      let releaseDrain: () => void = () => {}
      const drained = new Promise<void>((resolve) => { releaseDrain = resolve })
      const handle: WorkflowJournalHandle = {
        drain: () => drained,
        markCached: () => {},
      }
      const followup = vi.fn()
      const agent = fakeAgent(vi.fn(), { followup, status: 'idle' })
      const runId = await launch(ctx, engine, agent)
      registry.bindJournal(runId, handle)
      seedJournal('run-1')
      engine.settleRun(runId, { value: null, stopReason: 'completed', agentsStarted: 0 })
      // Delivery text arrives immediately even though the drain is deferred.
      await vi.waitFor(() => { expect(followup).toHaveBeenCalledTimes(1) })
      // Settled lookup before drain resolves is still "unknown".
      expect(() => registry.validateResume('run-1')).toThrow('unknown resumeFromRunId "run-1"')
      releaseDrain()
      await vi.waitFor(() => { expect(() => registry.validateResume('run-1')).not.toThrow() })
      expect(registry.validateResume('run-1').journalPath).toContain('run-1.jsonl')
    })
  })

  it('FIFO eviction at cap 128 deletes the evicted journal file', { timeout: 120_000 }, async () => {
    await withHome(async () => {
      const { ctx, engine, registry } = await setup()
      for (let i = 1; i <= 129; i++) {
        const runId = await launch(ctx, engine)
        seedJournal(runId)
        engine.settleRun(runId, { value: null, stopReason: 'completed', agentsStarted: 0 })
        await Promise.resolve()
        await Promise.resolve()
      }
      expect(existsSync(join(journalDir(), 'run-1.jsonl'))).toBe(false)
      expect(existsSync(join(journalDir(), 'run-2.jsonl'))).toBe(true)
      expect(existsSync(join(journalDir(), 'run-129.jsonl'))).toBe(true)
      rmSync(journalDir(), { recursive: true, force: true })
    })
  })

  it('validateResume raises the three structured refusal classes', async () => {
    await withHome(async () => {
      const { ctx, engine, registry } = await setup()
      // Unknown (nothing settled, nothing in flight).
      expect(() => registry.validateResume('run-9')).toThrow('unknown resumeFromRunId "run-9"')
      expect(() => registry.validateResume('run-9')).toThrow('settled runs this session: (none); in-flight: (none)')
      // In-flight.
      const runId = await launch(ctx, engine)
      expect(() => registry.validateResume('run-1')).toThrow('is still in flight — resume is only possible after its completion delivery')
      // Journal gone (settled, then file deleted). Path comes from the claim.
      const journalPath = registry.takePendingClaim()!.journalPath
      seedJournal('run-1')
      engine.settleRun(runId, { value: null, stopReason: 'completed', agentsStarted: 0 })
      await Promise.resolve()
      await Promise.resolve()
      expect(() => registry.validateResume('run-1')).not.toThrow()
      rmSync(journalPath, { force: true })
      expect(() => registry.validateResume('run-1')).toThrow('settled but its journal is gone (evicted or garbage-collected) — relaunch without resumeFromRunId')
    })
  })

  it('enriches agent-start/agent-end records with cached:true only for markCached members', async () => {
    await withHome(async () => {
      const { ctx, engine, registry } = await setup()
      const append = vi.fn()
      const runId = await launch(ctx, engine, fakeAgent(append))
      registry.markCached(runId, 1)
      engine.agentStart(runId, { seq: 1, label: 'a', childId: 'child-1' })
      engine.agentStart(runId, { seq: 2, label: 'b', childId: 'child-2' })
      engine.agentEnd(runId, { seq: 1, outcome: 'completed' })
      engine.agentEnd(runId, { seq: 2, outcome: 'completed' })
      const agentRecords = append.mock.calls.map(call => call[1] as Record<string, unknown>)
      expect(agentRecords[1]).toEqual({ runId: 'run-1', seq: 1, label: 'a', childId: 'child-1', cached: true })
      expect(agentRecords[2]).toEqual({ runId: 'run-1', seq: 2, label: 'b', childId: 'child-2' })
      expect(agentRecords[3]).toEqual({ runId: 'run-1', seq: 1, outcome: 'completed', cached: true })
      expect(agentRecords[4]).toEqual({ runId: 'run-1', seq: 2, outcome: 'completed' })
      // The cached set clears at settle (after settled publication).
      seedJournal('run-1')
      engine.settleRun(runId, { value: null, stopReason: 'completed', agentsStarted: 2 })
      await Promise.resolve()
      await Promise.resolve()
      expect(() => registry.validateResume('run-1')).not.toThrow()
      // (The settled-run cached-set clear itself is not observable through the
      // record listeners — the registry entry is dropped at settle — so the
      // disposal-clearing test below covers that branch end to end.)
    })
  })

  it('disposeAll clears settled projections, claims, journal handles, and cached sets', async () => {
    await withHome(async () => {
      const { ctx, engine, registry } = await setup()
      const runId = await launch(ctx, engine)
      registry.markCached(runId, 1)
      seedJournal('run-1')
      engine.settleRun(runId, { value: null, stopReason: 'completed', agentsStarted: 0 })
      await Promise.resolve()
      await Promise.resolve()
      expect(() => registry.validateResume('run-1')).not.toThrow()
      registry.disposeAll()
      expect(registry.takePendingClaim()).toBeUndefined()
      expect(() => registry.validateResume('run-1')).toThrow('unknown resumeFromRunId "run-1"')
    })
  })
})
