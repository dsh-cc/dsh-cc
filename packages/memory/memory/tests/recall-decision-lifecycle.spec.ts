/**
 * Lifecycle specs for the active recall coordinator (design
 * docs/plans/2026-11-02-systemone-03-memory-recall.md §"Query generations and
 * when shown takes effect", §"Failure table and mode switching", and the
 * test-matrix rows of §"Test matrix and commands").
 *
 * Every leg drives a REAL `MemoryRecall` over the fake `ctx.fs`, a fake
 * `DecisionRunner` (one deferred run per batch, resolved by the test) and a
 * recording legacy selector, so out-of-order generations, idle drops, content
 * changes and inject faults are all controlled from the test. The invariants are
 * the TLA model's (`specs/tla/memory-recall-dispatch`): shown only after a
 * successful synchronous inject, one terminal per dispatch key, a stale
 * `finally` confined to its own generation.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {
  DecisionRequest,
  DecisionRouteIdentity,
  DecisionRun,
  DecisionScope,
  SystemOneAnswer,
} from '@dsh-cc/systemone'
import { MemoryRecall } from '../src/recall.ts'
import type { MemorySelector, RecallCandidate } from '../src/recall.ts'
import type { RecallDecisionBinding } from '../src/recall-coordinator-support.ts'
import { DEFAULT_RECALL_DECISION_SETTINGS } from '../src/recall-decision-settings.ts'
import type { RecallDecisionMode, RecallDecisionSettings } from '../src/recall-decision-settings.ts'
import { FakeMemoryFs } from './helpers.ts'

/** A real topic file body (frontmatter + body) the scanner parses. */
function topicBody(name: string, description: string, body = 'body'): string {
  return `---\nname: ${name}\ndescription: ${description}\ntype: reference\n---\n${body}`
}

/** One session-log event face used by the origin lookup: the turn's own anchor. */
function turnStart(seq: number): unknown {
  return { type: 'turn/start', seq, time: 1_700_000_000_000 + seq, data: { turn: seq } }
}

/** The fixed route identity of the fake runner. */
const ROUTE: DecisionRouteIdentity = {
  provider: 'gauge',
  model: 'gauge-1',
  revision: 'rev-1',
  perRequestTokens: 8192,
  // The measured model window a real pin resolves to: one question carries the
  // whole state, so a narrower per-question window would (correctly) degrade
  // every run with `budget`.
  perQuestionTokens: 16384,
  maxQuestions: 32,
  maxOutputTokens: 2048,
}

/** The budget scope the host service would mint; the consumer never builds one. */
function scopeOf(originSeq?: number): DecisionScope {
  return { projectKey: 'a'.repeat(64), sessionId: 'session-1', agentId: 'agent-1', originSeq: originSeq ?? 0 }
}

/** The candidates of one dispatched request (host-side view of the batch). */
function candidatesOf(request: DecisionRequest): Array<{ id: string; filename: string }> {
  return (request.state as { candidates: Array<{ id: string; filename: string }> }).candidates
}

/** The recent tool names one request carried. */
function recentToolsOf(request: DecisionRequest): string[] {
  return (request.state as { recentTools: string[] }).recentTools
}

/** Answer a request: the listed filenames are inclusive, everything else excluded. */
function answerOnly(request: DecisionRequest, filenames: readonly string[]): Record<string, number> {
  const probabilities: Record<string, number> = {}
  for (const candidate of candidatesOf(request)) {
    probabilities[candidate.id] = filenames.includes(candidate.filename) ? 0.9 : 0.1
  }
  return probabilities
}

/** One batch answer as the runner reports it. */
function answered(probabilities: Record<string, number>): DecisionRun {
  const answers: Record<string, SystemOneAnswer> = {}
  for (const [id, noul] of Object.entries(probabilities)) answers[id] = { type: 'noul', noul }
  return { status: 'answered', answers, model: 'gauge-1', usage: { input_tokens: 10, output_tokens: 5 }, decisionId: 'd1', inputHash: 'h1' }
}

/** The fake decision runner: every `run` waits for the test to answer it. */
interface FakeRunner {
  binding: RecallDecisionBinding
  requests: DecisionRequest[]
  /** Resolve the oldest pending run (all question keys, or an explicit map). */
  answerNext(spec: number | 'unavailable' | ((request: DecisionRequest) => Record<string, number>)): void
}

/** Build a fake runner plus its request log. */
function fakeRunner(identify: () => DecisionRouteIdentity | undefined = () => ROUTE): FakeRunner {
  const requests: DecisionRequest[] = []
  const queue: Array<{ request: DecisionRequest; resolve: (run: DecisionRun) => void }> = []
  const binding: RecallDecisionBinding = {
    identifyRoute: () => identify(),
    scope: originSeq => scopeOf(originSeq),
    run: request => new Promise<DecisionRun>((resolve) => {
      requests.push(request)
      queue.push({ request, resolve })
    }),
  }
  return {
    binding,
    requests,
    answerNext(spec) {
      const head = queue.shift()
      if (head === undefined) throw new Error('no pending decision request')
      if (spec === 'unavailable') {
        head.resolve({ status: 'unavailable', reason: 'budget', decisionId: 'd1' })
        return
      }
      const probabilities = typeof spec === 'number'
        ? Object.fromEntries(Object.keys(head.request.questions).map(id => [id, spec]))
        : spec(head.request)
      head.resolve(answered(probabilities))
    },
  }
}

/** A legacy selector that records its invocations and returns a fixed selection. */
class RecordingSelector implements MemorySelector {
  selection: string[] = []
  calls: Array<{ query: string; candidates: readonly RecallCandidate[]; recentTools: readonly string[] }> = []

  async select(query: string, candidates: readonly RecallCandidate[], _signal: AbortSignal, recentTools: readonly string[]): Promise<string[]> {
    this.calls.push({ query, candidates, recentTools })
    return [...this.selection]
  }
}

/** One fake agent with a controllable status, session id and session log. */
interface FakeAgent {
  agent: Agent
  inject: ReturnType<typeof vi.fn>
  events: unknown[]
  session: { id: string; header: { cwd: string }; snapshotEvents(): readonly unknown[] }
}

/** Build a top-level agent whose snapshot log the test controls. */
function makeAgent(options: { id?: string; cwd?: string } = {}): FakeAgent {
  const events: unknown[] = []
  const session = {
    id: options.id ?? 'session-1',
    header: { cwd: options.cwd ?? '/work/repo' },
    snapshotEvents: () => events,
  }
  const inject = vi.fn()
  const agent = { session, status: 'running', inject } as unknown as Agent
  return { agent, inject, events, session }
}

/** Everything one mounted recall rig exposes to a test. */
interface Rig {
  ctx: Context
  fs: FakeMemoryFs
  recall: MemoryRecall
  runner: FakeRunner
  legacy: RecordingSelector
  settings: RecallDecisionSettings
  dispose(): Promise<void>
}

/** Mount a MemoryRecall over the fake fs, a fake runner and a mutable snapshot. */
async function mount(options: {
  mode?: RecallDecisionMode
  files?: Array<[string, string]>
  identify?: () => DecisionRouteIdentity | undefined
} = {}): Promise<Rig> {
  const ctx = new Context()
  await ctx.plugin(FakeMemoryFs)
  const fs = ctx.fs as FakeMemoryFs
  // The home root is the global layer; the workspace layer resolves to
  // `<home>/projects/<slug>` from the agent's session cwd.
  fs.seed('/root/projects/work-repo/MEMORY.md', '# memory')
  for (const [name, body] of options.files ?? []) fs.seed(`/root/projects/work-repo/${name}`, body)
  const settings: RecallDecisionSettings = { ...DEFAULT_RECALL_DECISION_SETTINGS, mode: options.mode ?? 'active' }
  const runner = fakeRunner(options.identify)
  const legacy = new RecordingSelector()
  const recall = new MemoryRecall(ctx, '/root', {
    enabled: true,
    createSelector: () => legacy,
    readSettings: () => settings,
    decisionsFor: () => runner.binding,
  })
  return {
    ctx,
    fs,
    recall,
    runner,
    legacy,
    settings,
    dispose: async () => {
      recall.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/** Drive one pre-step (recall is fire-and-forget, so this never awaits it). */
function drivePreStep(ctx: Context, agent: Agent, texts: readonly string[]): void {
  void ctx.emit('agent/pre-step', {
    agent,
    messages: texts.map(text => ({ content: [{ type: 'text', text }] })),
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  } as never, async () => ({ kind: 'enter', messages: [] }) as never)
}

/** Wait until the predicate holds (flushing microtasks) or fail on timeout. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Settle the pending microtask/timer queue a few times (a negative assertion helper). */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/** The text an injection delivered. */
function injectedText(inject: ReturnType<typeof vi.fn>, call = 0): string {
  const message = inject.mock.calls[call]?.[0] as { content: Array<{ text?: string }> } | undefined
  return (message?.content ?? []).map(block => block.text ?? '').join('\n')
}

/** Two topic files every leg can select from (bash sorts before git). */
const TWO_TOPICS: Array<[string, string]> = [
  ['bash.md', topicBody('Bash', 'Bash reference documentation')],
  ['git.md', topicBody('Git', 'Git reference documentation')],
]

describe('RecallCoordinator: query generations', () => {
  it('drops a superseded query A and sends query B exactly once', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['query A'])
    await until(() => rig.runner.requests.length === 1, 'query A dispatched')

    // B arrives while A is still in flight; A is aborted but its promise is
    // still ours to settle.
    events.push(turnStart(2))
    drivePreStep(rig.ctx, agent, ['query B'])
    await settle()
    expect(rig.runner.requests).toHaveLength(1)

    // A returns FIRST and selects git.md — its generation is gone, so nothing is
    // injected and nothing becomes shown.
    rig.runner.answerNext(request => answerOnly(request, ['git.md']))
    await until(() => rig.runner.requests.length === 2, 'query B dispatched after A settled')
    expect(inject).not.toHaveBeenCalled()
    expect(rig.runner.requests[0]!.state.query).toBe('query A')
    expect(rig.runner.requests[1]!.state.query).toBe('query B')

    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await until(() => inject.mock.calls.length === 1, 'query B injected')
    expect(injectedText(inject)).toContain('## Memory: Bash')
    expect(injectedText(inject)).not.toContain('Git')

    // A's git.md was never marked shown: a third turn still sees it fresh.
    events.push(turnStart(3))
    drivePreStep(rig.ctx, agent, ['query C'])
    await until(() => rig.runner.requests.length === 3, 'query C dispatched')
    expect(candidatesOf(rig.runner.requests[2]!).map(candidate => candidate.filename)).toEqual(['git.md'])
    await rig.dispose()
  })

  it('executes the same text for a new turn anchor and never for a repeated anchor', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['why does this fail?'])
    await until(() => rig.runner.requests.length === 1, 'first dispatch')
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await until(() => inject.mock.calls.length === 1, 'first injection')

    // The same origin re-presented (a repeated pre-step) must not re-execute.
    drivePreStep(rig.ctx, agent, ['why does this fail?'])
    await settle()
    expect(rig.runner.requests).toHaveLength(1)

    // The same TEXT under a new turn/start anchor is a new turn: it executes.
    events.push(turnStart(5))
    drivePreStep(rig.ctx, agent, ['why does this fail?'])
    await until(() => rig.runner.requests.length === 2, 'second dispatch')
    expect(rig.runner.requests[1]!.state.query).toBe('why does this fail?')
    rig.runner.answerNext(request => answerOnly(request, ['git.md']))
    await until(() => inject.mock.calls.length === 2, 'second injection')
    expect(injectedText(inject, 1)).toContain('## Memory: Git')
    await rig.dispose()
  })

  it('dispatches before the turn\'s user event is persisted (the real pre-step ordering)', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    // The REAL ordering: turn/start is in the log, the turn's user/message
    // lands only after the pre-step waterfall — so it is absent here.
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['a query the log has not seen as a user event'])
    await until(() => rig.runner.requests.length === 1, 'dispatch without a persisted user event')
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await until(() => inject.mock.calls.length === 1, 'injection')
    await rig.dispose()
  })

  it('re-dispatches an A→B→A replay when the recentTools key input changed', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['query A'])
    await until(() => rig.runner.requests.length === 1, 'A dispatched')
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await until(() => inject.mock.calls.length === 1, 'A injected (terminal)')
    // B in the same turn: a different query text dispatches under its own key.
    drivePreStep(rig.ctx, agent, ['query B'])
    await until(() => rig.runner.requests.length === 2, 'B dispatched')
    rig.runner.answerNext(request => answerOnly(request, []))
    await settle()
    // An identical A replay with UNCHANGED key inputs is the completed key:
    // suppressed (the r2-adjudicated intentional per-turn dedupe).
    drivePreStep(rig.ctx, agent, ['query A'])
    await settle()
    expect(rig.runner.requests).toHaveLength(2)
    // The same A replay AFTER a tool was used is a NEW key (recentTools hash)
    // and dispatches again.
    void rig.ctx.emit('tools/post-execute', { agent, name: 'bash' } as never, {} as never, async () => {})
    await settle()
    drivePreStep(rig.ctx, agent, ['query A'])
    await until(() => rig.runner.requests.length === 3, 'A re-dispatched after a tool use')
    rig.runner.answerNext(request => answerOnly(request, ['git.md']))
    await until(() => inject.mock.calls.length === 2, 'second injection')
    await rig.dispose()
  })

  it('sends no request while the log has no turn/start anchor', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject } = makeAgent()
    drivePreStep(rig.ctx, agent, ['a query the log has no anchor for'])
    await settle()
    expect(rig.runner.requests).toHaveLength(0)
    expect(inject).not.toHaveBeenCalled()
    await rig.dispose()
  })

  it('clears the completed set when the scope key changes', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject, events, session } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'first dispatch')
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await until(() => inject.mock.calls.length === 1, 'first injection')

    // A different session id is a different scope: the state (and the dispatch
    // key it remembered) must not survive.
    session.id = 'session-2'
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 2, 'second dispatch after scope change')
    expect(rig.runner.requests[1]!.state.query).toBe('q1')
    await rig.dispose()
  })

  it('aborts the in-flight task on dispose', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'dispatch')
    rig.recall.dispose()
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await settle()
    expect(inject).not.toHaveBeenCalled()
    await rig.ctx.fiber.dispose()
  })

  it('releases one agent state and aborts its in-flight task (Agent dispose)', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'dispatch')
    rig.recall.release(agent)
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await settle()
    expect(inject).not.toHaveBeenCalled()
    await rig.dispose()
  })
})

describe('RecallCoordinator: recentTools isolation', () => {
  it('a tool executed for another agent never pollutes this agent set', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const one = makeAgent({ id: 'session-1' })
    const two = makeAgent({ id: 'session-2' })
    await rig.ctx.emit('tools/post-execute', { name: 'Bash', agent: two.agent }, undefined, async () => ({}))
    one.events.push(turnStart(1))
    drivePreStep(rig.ctx, one.agent, ['q one'])
    await until(() => rig.runner.requests.length === 1, 'agent one dispatch')
    expect(recentToolsOf(rig.runner.requests[0]!)).toEqual([])

    two.events.push(turnStart(1))
    drivePreStep(rig.ctx, two.agent, ['q two'])
    await until(() => rig.runner.requests.length === 2, 'agent two dispatch')
    expect(recentToolsOf(rig.runner.requests[1]!)).toEqual(['Bash'])
    rig.runner.answerNext(request => answerOnly(request, []))
    rig.runner.answerNext(request => answerOnly(request, []))
    await settle()
    await rig.dispose()
  })
})

describe('RecallCoordinator: freshness checkpoints', () => {
  it('an agent that went idle after reading injects nothing and marks no shown', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'dispatch')
    agent.status = 'idle' as never
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await settle()
    expect(inject).not.toHaveBeenCalled()

    // bash.md was not marked shown: a running agent's next turn still sees it.
    agent.status = 'running' as never
    events.push(turnStart(2))
    drivePreStep(rig.ctx, agent, ['q2'])
    await until(() => rig.runner.requests.length === 2, 'second dispatch')
    expect(candidatesOf(rig.runner.requests[1]!).map(candidate => candidate.filename)).toContain('bash.md')
    rig.runner.answerNext(request => answerOnly(request, []))
    await settle()
    await rig.dispose()
  })

  it('a seedShown path is never re-injected and a non-canonical one is ignored', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, events } = makeAgent()
    rig.recall.seedShown(agent, ['/root/projects/work-repo/bash.md', 'relative/git.md'])
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'dispatch')
    // bash.md was seeded as delivered; git.md only via a non-canonical entry.
    expect(candidatesOf(rig.runner.requests[0]!).map(candidate => candidate.filename)).toEqual(['git.md'])
    rig.runner.answerNext(request => answerOnly(request, []))
    await settle()
    await rig.dispose()
  })
})

describe('RecallCoordinator: terminal dispatch keys', () => {
  it('an empty read-back is never injected and the key is not paid twice', async () => {
    const rig = await mount({ files: [['bash.md', topicBody('Bash', 'Bash reference')]] })
    const { agent, inject, events } = makeAgent()
    const original = rig.fs.readText.bind(rig.fs)
    let truncateReads = false
    rig.fs.readText = async (target: FsTarget) =>
      (truncateReads && String(target.targetKey) === '/root/projects/work-repo/bash.md'
        ? ''
        : await original(target))
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'dispatch')
    // The scan saw real content; only the read-back comes back empty.
    truncateReads = true
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await settle()
    expect(inject).not.toHaveBeenCalled()

    // Terminal: with the manifest unchanged, the identical input is not paid for
    // again (an undelivered path is never marked shown, so nothing is suppressed).
    truncateReads = false
    drivePreStep(rig.ctx, agent, ['q1'])
    await settle()
    expect(rig.runner.requests).toHaveLength(1)
    await rig.dispose()
  })

  it('a read failure after selection injects nothing and marks no shown', async () => {
    const rig = await mount({ files: [['bash.md', topicBody('Bash', 'Bash reference')]] })
    const { agent, inject, events } = makeAgent()
    const original = rig.fs.readText.bind(rig.fs)
    const failing = new Set<string>()
    rig.fs.readText = async (target: FsTarget) => {
      if (failing.has(String(target.targetKey))) throw new Error('read failed')
      return await original(target)
    }
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'dispatch')
    // The scan has read the file already; only the read-back fails.
    failing.add('/root/projects/work-repo/bash.md')
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await settle()
    expect(inject).not.toHaveBeenCalled()
    drivePreStep(rig.ctx, agent, ['q1'])
    await settle()
    expect(rig.runner.requests).toHaveLength(1)
    await rig.dispose()
  })

  it('a content-hash mismatch discards the whole result', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'dispatch')
    const scanned = rig.fs.backingText('/root/projects/work-repo/bash.md')!
    // Rewrite the file AFTER the scan: the description no longer matches the bytes.
    rig.fs.seed('/root/projects/work-repo/bash.md', topicBody('Bash', 'Bash reference documentation', 'rewritten body'))
    rig.runner.answerNext(request => answerOnly(request, ['bash.md', 'git.md']))
    await settle()
    expect(inject).not.toHaveBeenCalled()

    // Restoring the scanned bytes reproduces the SAME dispatch key, so the
    // terminal write is observable: the round is not paid for twice.
    rig.fs.seed('/root/projects/work-repo/bash.md', scanned)
    drivePreStep(rig.ctx, agent, ['q1'])
    await settle()
    expect(rig.runner.requests).toHaveLength(1)
    await rig.dispose()
  })

  it('a thrown injection marks the key terminal without marking shown', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    const { agent, inject, events } = makeAgent()
    inject.mockImplementation(() => {
      throw new Error('inject exploded')
    })
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'dispatch')
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await settle()
    expect(inject).toHaveBeenCalledTimes(1)
    // No path was marked shown, so a new turn re-selects bash.md...
    events.push(turnStart(2))
    drivePreStep(rig.ctx, agent, ['q2'])
    await until(() => rig.runner.requests.length === 2, 'second dispatch')
    expect(candidatesOf(rig.runner.requests[1]!).map(candidate => candidate.filename)).toContain('bash.md')
    rig.runner.answerNext(request => answerOnly(request, []))
    await settle()
    await rig.dispose()
  })
})

describe('MemoryRecall mode dispatch', () => {
  it('runs only the baseline in shadow mode and logs no content or query', async () => {
    const rig = await mount({ mode: 'shadow', files: TWO_TOPICS })
    const lines: string[] = []
    ;(rig.ctx as { logger?: unknown }).logger = { info: (line: string) => lines.push(line) }
    rig.legacy.selection = ['bash.md']
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['why does this test fail randomly?'])
    await until(() => rig.runner.requests.length === 1, 'shadow decision dispatched')
    // The decision disagrees with the baseline (it wants git.md) — it is still
    // never injected.
    rig.runner.answerNext(request => answerOnly(request, ['git.md']))
    await until(() => inject.mock.calls.length === 1 && lines.length === 1, 'baseline injection and shadow record')
    expect(inject).toHaveBeenCalledTimes(1)
    expect(injectedText(inject)).toContain('## Memory: Bash')
    expect(rig.legacy.calls).toHaveLength(1)
    const log = lines.join('\n')
    expect(log).toContain('"kind":"selected"')
    // The record documents the decision arm's scope: the whole pool was judged.
    expect(log).toContain('"pool":2')
    expect(log).toContain('"judged":2')
    expect(log).toContain('"selected":1')
    expect(log).not.toContain('"candidates"')
    expect(log).not.toContain('why does this test fail randomly?')
    expect(log).not.toContain('bash.md')
    expect(log).not.toContain('git.md')
    expect(log).not.toContain('Bash reference')
    await rig.dispose()
  })

  it('reports an unavailable shadow comparison instead of a fake one', async () => {
    const rig = await mount({ mode: 'shadow', files: TWO_TOPICS, identify: () => undefined })
    const lines: string[] = []
    ;(rig.ctx as { logger?: unknown }).logger = { info: (line: string) => lines.push(line) }
    rig.legacy.selection = ['bash.md']
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['a query'])
    await until(() => lines.length === 1, 'shadow record')
    expect(rig.runner.requests).toHaveLength(0)
    expect(lines[0]).toContain('"kind":"unavailable"')
    expect(lines[0]).toContain('route-unavailable')
    // No plan existed, so the judged scope is 0 while the pool is still 2.
    expect(lines[0]).toContain('"pool":2')
    expect(lines[0]).toContain('"judged":0')
    // The baseline still injects exactly once.
    await until(() => inject.mock.calls.length === 1, 'baseline injection')
    await rig.dispose()
  })

  it('leaving active cancels the in-flight decision and keeps the baseline', async () => {
    const rig = await mount({ files: TWO_TOPICS })
    rig.legacy.selection = ['git.md']
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'active dispatch')

    // The operator switches the mode off mid-flight.
    rig.settings.mode = 'off'
    events.push(turnStart(2))
    drivePreStep(rig.ctx, agent, ['q2'])
    await until(() => rig.legacy.calls.length === 1, 'legacy baseline ran')
    await until(() => inject.mock.calls.length === 1, 'baseline injection')

    // The cancelled decision settles late and must not inject anything.
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await settle()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(injectedText(inject)).toContain('## Memory: Git')
    await rig.dispose()
  })

  it('switching back to off never re-injects a path active already delivered', async () => {
    const rig = await mount({ files: [['bash.md', topicBody('Bash', 'Bash reference documentation')]] })
    rig.legacy.selection = ['bash.md']
    const { agent, inject, events } = makeAgent()
    events.push(turnStart(1))
    drivePreStep(rig.ctx, agent, ['q1'])
    await until(() => rig.runner.requests.length === 1, 'active dispatch')
    rig.runner.answerNext(request => answerOnly(request, ['bash.md']))
    await until(() => inject.mock.calls.length === 1, 'active injection')
    expect(injectedText(inject)).toContain('## Memory: Bash')

    // Back to the legacy branch: every candidate is already delivered, so the
    // selector is never even asked — the mirror, not a mis-marked shown set.
    rig.settings.mode = 'off'
    events.push(turnStart(2))
    drivePreStep(rig.ctx, agent, ['q2'])
    await settle()
    expect(rig.legacy.calls).toHaveLength(0)
    expect(inject).toHaveBeenCalledTimes(1)
    await rig.dispose()
  })
})
