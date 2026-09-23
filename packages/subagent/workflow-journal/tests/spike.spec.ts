/**
 * The load-bearing spike (resume-journal design DoD item 1): the REAL
 * worker-thread workflow engine over the real SubagentRuntime, with the
 * journal provider mounted over a fake `spawn` delegate. Asserts:
 * (a) provider arrival order == invocation order;
 * (b) durable agent-start seq == provider arrival index, per record;
 * (c) an all-hit resume performs zero spawns, replays the results into the
 *     script's return value, and marks the durable rows `cached: true`;
 * (d) editing one middle prompt reruns exactly the suffix (first-miss
 *     freezing), with the captured spawn prompts as proof.
 *
 * Idiom mirrors the harness workflow-worker-thread tests (StubProvider over
 * the real registry, real worker thread, fake parent).
 */

import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { WorkflowResult, WorkflowRun } from '@deepseek-ai/dsh-workflow'
import WorkerThreadWorkflowEngine from '@deepseek-ai/dsh-workflow-worker-thread'
import { mountCcWorkflowRunRegistry, parseJournal } from '@dsh-cc/tool-workflow'
import { CcWorkflowJournalProvider } from '../src/provider.ts'

// Real worker-thread startup on contended runners (the harness idiom).
vi.setConfig({ testTimeout: 60_000 })

const FAN = 4
const PIPE_ITEMS = 3
const TOTAL = FAN + PIPE_ITEMS * 2

const SCRIPT = `
const fan = await parallel(args.fans.map(prompt => () => agent(prompt)))
const pipe = await pipeline(args.items,
  (prev, item) => agent('stage1 ' + item),
  (prev, item) => agent(prev + ' stage2 ' + item),
)
return { fan, pipe }
`

/** Fake 'spawn' delegate: deterministic text after a small delay, records arrivals. */
class FakeSpawnProvider implements SubagentProvider {
  readonly name = 'spawn'
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: false,
    depthLimit: true,
    toolFilter: true,
    persona: false,
  }
  readonly inheritsParentContext = false
  /** Arrival-ordered prompts across ALL runs (arrival index = position + 1). */
  readonly arrivals: { promptText: string; signal: AbortSignal }[] = []

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.arrivals.push({
      promptText: (request.prompt as readonly { text?: string }[]).map(block => block.text ?? '').join(''),
      signal: request.signal,
    })
    const index = this.arrivals.length - 1
    const result: SubagentResult = {
      output: [{ type: 'text', text: `answer-${index}` }],
      stopReason: 'completed',
    }
    const run: SubagentRun = {
      id: `spawn-child-${index}` as never,
      localAgent: undefined,
      result: new Promise<SubagentResult>(resolve => setTimeout(() => resolve(result), 5)),
      dispose: () => Promise.resolve(),
    }
    return run
  }
}

interface DurableRecord { runId: string; type: string; data: Record<string, unknown> }

/** Fake parent session/agent stand-ins (the registry-resume.spec.ts idiom). */
function fakeParentSession(records: DurableRecord[]): { parent: Agent; session: unknown } {
  const append = (type: string, data: unknown): void => {
    records.push({ runId: (data as { runId?: string }).runId ?? '', type, data: data as Record<string, unknown> })
  }
  const session = {
    append,
    snapshotEvents: () => [],
    header: { id: 'sess-test', cwd: process.cwd() },
  }
  const parent = {
    id: SessionId('workflow-parent'),
    options: {},
    session,
  } as unknown as Agent
  return { parent, session }
}

function fakeCallbackAgent(session: unknown): Agent {
  return {
    id: 'caller-agent',
    options: {},
    status: 'idle',
    session,
    inject: vi.fn(),
    followup: vi.fn(),
  } as never
}

async function setup() {
  const scratch = mkdtempSync(join(process.cwd(), '.scratch', 'spike-'))
  const home = join(scratch, 'home')
  mkdirSync(home, { recursive: true })
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const records: DurableRecord[] = []
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SubagentRuntime)
  const spawnProvider = new FakeSpawnProvider()
  ctx.subagents.registerProvider(spawnProvider)
  mountCcWorkflowRunRegistry(ctx)
  const journalProvider = new CcWorkflowJournalProvider(ctx.subagents, ctx.ccWorkflowRunRegistry, {
    maxJournalBytes: 8_388_608,
    warn: message => { throw new Error(`unexpected journal warning: ${message}`) },
  })
  ctx.subagents.registerProvider(journalProvider)
  await ctx.plugin(WorkerThreadWorkflowEngine, { provider: 'cc-workflow-journal', maxConcurrentAgents: 8 })
  const { parent, session } = fakeParentSession(records)
  const callerAgent = fakeCallbackAgent(session)
  return {
    ctx,
    spawnProvider,
    journalProvider,
    parent,
    session,
    callerAgent,
    records,
    engine: ctx.workflowEngine,
    registry: ctx.ccWorkflowRunRegistry,
    cleanup: async () => {
      await journalProvider.disposeAllJournals()
      if (realHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = realHome
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}

/** Start one run through the real engine, registering it with the registry. */
function launch(
  fixture: Awaited<ReturnType<typeof setup>>,
  options: { resumeOf?: string; journalText?: string; args?: unknown } = {},
): { runId: string; run: WorkflowRun } {
  const args = options.args ?? { fans: ['fan 0', 'fan 1', 'fan 2', 'fan 3'], items: ['a', 'b', 'c'] }
  const run = fixture.engine.start({ meta: { name: 'spike', description: 'spike script' }, script: SCRIPT, args, parent: fixture.parent })
  fixture.registry.register({
    run,
    meta: { name: 'spike', description: 'spike script' },
    args,
    scriptText: SCRIPT,
    source: 'tool' as never,
    startedAt: Date.now(),
    session: fixture.session as never,
    agent: fixture.callerAgent as never,
    maxResultChars: 50_000,
    record: true,
    ...(options.resumeOf !== undefined ? { resumeOf: options.resumeOf as never } : {}),
    ...(options.journalText !== undefined ? { journalText: options.journalText } : {}),
  } as never)
  return { runId: run.id, run }
}
/** Wait until the registry's settled map publishes the run (drain-gated). */
async function waitSettled(fixture: Awaited<ReturnType<typeof setup>>, runId: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    try {
      fixture.registry.validateResume(runId)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw new Error(`run ${runId} never published its settled projection`)
}

function journalPath(runId: string): string {
  return join(process.env.DSH_HOME!, 'workflows', 'runs', 'sess-test', `${runId}.jsonl`)
}

describe('workflow resume journal spike (real worker-thread engine)', () => {
  it('preserves arrival order == seq, replays an all-hit resume with zero spawns, and reruns exactly the edited suffix', async () => {
    const fixture = await setup()
    try {
      // --- Run 1: parallel(4) + pipeline(3 x 2 stages) -----------------
      const first = launch(fixture)
      const result1: WorkflowResult = await first.run.result
      expect(result1.stopReason).toBe('completed')
      expect(result1.agentsStarted).toBe(TOTAL)

      // (a) arrival order at the fake provider == invocation order 1..n.
      expect(fixture.spawnProvider.arrivals).toHaveLength(TOTAL)
      // (b) durable agent-start seq == provider arrival index, per record.
      const durableStarts = fixture.records.filter(record => record.type === 'tool-workflow/agent-start')
      expect(durableStarts).toHaveLength(TOTAL)
      durableStarts.forEach((record, position) => {
        expect(record.data.seq).toBe(position + 1)
        expect(record.data.runId).toBe(first.runId)
        expect(record.data.cached).toBeUndefined() // live rows are not cached
      })
      // The provider's arrival order matches the scripted invocation order:
      // the fan prompts in 0..3 order, and each pipeline item's stage1
      // before its stage2 (cross-item interleaving is engine-owned).
      const prompts = fixture.spawnProvider.arrivals.map(arrival => arrival.promptText)
      expect(prompts.filter(prompt => prompt.startsWith('fan '))).toEqual(['fan 0', 'fan 1', 'fan 2', 'fan 3'])
      for (const item of ['a', 'b', 'c']) {
        const firstStage = prompts.indexOf(`stage1 ${item}`)
        const secondStage = prompts.findIndex(prompt => prompt.endsWith(`stage2 ${item}`) && prompt.includes('answer-'))
        expect(firstStage).toBeGreaterThanOrEqual(0)
        expect(secondStage).toBeGreaterThan(firstStage)
      }
      void existsSync
      void readFileSync

      // --- Run 2: full resume of run 1 --------------------------------
      await waitSettled(fixture, first.runId)
      const journalText = readFileSync(journalPath(first.runId), 'utf8')
      const parsed = parseJournal(journalText)
      expect(parsed.corrupt).toBe(false)
      expect(parsed.lines).toHaveLength(TOTAL)
      const spawnsBefore = fixture.spawnProvider.arrivals.length
      const second = launch(fixture, { resumeOf: first.runId, journalText })
      const result2: WorkflowResult = await second.run.result
      // (c) zero fake-provider spawns in run 2; identical return value.
      expect(fixture.spawnProvider.arrivals.length).toBe(spawnsBefore)
      expect(result2.stopReason).toBe('completed')
      expect(result2.agentsStarted).toBe(TOTAL)
      expect(result2.value).toEqual(result1.value)
      // Durable rows of run 2 carry cached: true; run 1's do not.
      const secondStarts = fixture.records.filter(record => record.type === 'tool-workflow/agent-start' && record.data.runId === second.runId)
      expect(secondStarts).toHaveLength(TOTAL)
      for (const record of secondStarts) expect(record.data.cached).toBe(true)

      // --- Run 3: edit ONE middle prompt ('fan 2' -> 'fan EDITED') ----
      await waitSettled(fixture, second.runId)
      const journal2 = readFileSync(journalPath(second.runId), 'utf8')
      const editedArgs = { fans: ['fan 0', 'fan 1', 'fan EDITED', 'fan 3'], items: ['a', 'b', 'c'] }
      const run3 = fixture.engine.start({ meta: { name: 'spike', description: 'spike script' }, script: SCRIPT, args: editedArgs, parent: fixture.parent })
      fixture.registry.register({
        run: run3,
        meta: { name: 'spike', description: 'spike script' },
        args: editedArgs,
        scriptText: SCRIPT,
        source: 'tool' as never,
        startedAt: Date.now(),
        session: fixture.session as never,
        agent: fixture.callerAgent as never,
        maxResultChars: 50_000,
        record: true,
        resumeOf: second.runId as never,
        journalText: journal2,
      } as never)
      const result3: WorkflowResult = await run3.result
      expect(result3.stopReason).toBe('completed')
      // (d) first-miss freezing: exactly the suffix after 'fan 2' reran —
      // the same arrival order as run 1 from that index on, with the one
      // edited prompt swapped in and the cached prefix absent.
      const run3Prompts = fixture.spawnProvider.arrivals.slice(spawnsBefore).map(arrival => arrival.promptText)
      // Stage2 prompts embed the live stage1 answer, whose index differs per
      // run — normalize it before comparing against run 1's suffix.
      const normalized = (prompt: string): string => prompt.replace(/^answer-\d+ /, 'answer-* ')
      const expectedSuffix = [...prompts.slice(2)].map(prompt => normalized(prompt === 'fan 2' ? 'fan EDITED' : prompt))
      expect(run3Prompts.map(normalized)).toEqual(expectedSuffix)
      expect(run3Prompts).toHaveLength(TOTAL - 2)
      expect(run3Prompts).not.toContain('fan 0')
      expect(run3Prompts).not.toContain('fan 1')
    } finally {
      await fixture.cleanup()
    }
  })
})
