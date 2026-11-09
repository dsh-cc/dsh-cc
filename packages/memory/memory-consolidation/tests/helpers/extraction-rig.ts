/**
 * Test rig for the extraction coordinator (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"State machine
 * and commit rules" and the deferred-done example at the end of the design).
 *
 * The rig makes the watermark boundary OBSERVABLE instead of masked by fast
 * promises, so it supplies every seam itself:
 * - a controllable clock (`Date.now` is never consulted by the coordinator);
 * - a fake index read (one mutable string, so an index change is one call);
 * - a fake bound decision runner (a mutable probability, an optional gate hold,
 *   and a recorded request list);
 * - a fake job whose `done` only settles when the test resolves it;
 * - a MANUAL drain: the coordinator's microtask drain is queued, so `settle()`
 *   never auto-completes a pending job and a later stop stays pending until the
 *   test drains it.
 */

import { vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  BoundDecisionRunner,
  DecisionRequest,
  DecisionRouteIdentity,
  DecisionRun,
  DecisionScope,
  SystemOneAnswer,
} from '@dsh-cc/systemone'
import {
  DEFAULT_EXTRACTION_DECISION_SETTINGS,
  type ExtractionDecisionSettings,
  type ExtractionMode,
} from '../../src/extraction-settings.ts'
import {
  createExtractionCoordinator,
  type ExtractionCoordinator,
  type ExtractionIndexRead,
  type ExtractionState,
} from '../../src/extraction-coordinator.ts'
import { EXTRACTION_QUESTION_KEY } from '../../src/extraction-gate.ts'
import type { MemoryJobControl } from '../../src/memory-job.ts'

/** A promise a test settles by hand (the deferred-done idiom of the design). */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Fixed decision scope identity the fake runner mints. */
const PROJECT_KEY = 'f'.repeat(64)

/** Keyless route identity the fake runner reports as stable. */
const IDENTITY: DecisionRouteIdentity = {
  provider: 'testone',
  model: 's1-wire',
  revision: 'rev-1',
  perRequestTokens: 4000,
  perQuestionTokens: 1000,
  maxQuestions: 4,
  maxOutputTokens: 500,
}

let rigCounter = 0

/** One user/message surface event (the v4 shape the window builder reads). */
export function userEvent(seq: number, text: string, source: unknown = { kind: 'user' }): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    surfaceOp: 'append',
    data: { id: `user-${seq}`, role: 'user', content: [{ type: 'text', text }], source },
  } as unknown as SessionEvent
}

/** One assistant/message surface event. */
export function assistantEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/message',
    seq,
    time: 0,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { id: `assistant-${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
      stream: [],
    },
  } as unknown as SessionEvent
}

/** A user message with a non-text block: a window containing it is incomplete. */
export function imageUserEvent(seq: number): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time: 0,
    surfaceOp: 'append',
    data: { id: `image-${seq}`, role: 'user', content: [{ type: 'image', source: { kind: 'file', path: '/tmp/x.png' } }], source: { kind: 'user' } },
  } as unknown as SessionEvent
}

/** Options of {@link extractionRig}. */
export interface RigOptions {
  /** Gate mode (default `active`). */
  mode?: ExtractionMode
  /** The noul probability the fake runner answers (default `0.9`). */
  probability?: number
  /** Effective-settings overrides on top of the shipped defaults. */
  settings?: Partial<ExtractionDecisionSettings>
  /** The MEMORY.md body the fake fs serves; `undefined` means "absent". */
  index?: string
  /** The job dispatched per fork: one control object, or a factory (default: completed). */
  job?: MemoryJobControl | ((call: number) => MemoryJobControl)
  /** `false` makes the decision service unavailable (no runner at all). */
  runner?: boolean
  /** Hold every decision until `releaseGate()` (a stop may arrive in between). */
  holdGate?: boolean
  memoryDir?: string
  sessionId?: string
  cwd?: string
  /** Override the takeover/teardown grace (tests only). */
  graceMs?: number
}

/** The assertion surface of one coordinator under test. */
export interface ExtractionRig {
  readonly coordinator: ExtractionCoordinator
  readonly agent: Agent
  readonly memoryDir: string
  readonly sessionId: string
  /** Append mono-seq user events until the highest seq equals `head`. */
  growTo(head: number): void
  /** Append one raw event (for incomplete-window and compaction cases). */
  append(event: SessionEvent): void
  /** Grow to `head`, dispatch one turn-stopping, then settle. */
  stopAt(head: number): Promise<void>
  /** Dispatch one turn-stopping at the current head, then settle. */
  stop(): Promise<void>
  /** Flush every outstanding continuation; never completes a pending job. */
  settle(): Promise<void>
  /** Run the queued coordinator drains (a later stop), settling after each. */
  drain(): Promise<void>
  /** Fork dispatch count. */
  startCount(): number
  /** Prompts of the dispatched forks, in dispatch order. */
  prompts(): string[]
  /** Write-back baselines of the dispatched forks, in dispatch order. */
  baselines(): string[]
  /** Windows the gate was asked about (`undefined` when it was never asked). */
  windows(): Array<{ fromExclusive: unknown; throughInclusive: unknown }>
  /** Decision requests the fake runner observed. */
  requests(): DecisionRequest[]
  /** The live state (or `undefined` after a dispose/eviction). */
  state(): ExtractionState | undefined
  reviewedThrough(): number
  /** The next unreviewed span: `(reviewedThrough, pendingHead]`. */
  pendingWindow(): { fromExclusive: number; throughInclusive: number }
  phase(): ExtractionState['phase'] | 'absent'
  skipOrdinal(): number
  /** Current effective settings snapshot. */
  settings(): ExtractionDecisionSettings
  setMode(mode: ExtractionMode): void
  setProbability(probability: number): void
  setIndex(index: string | undefined): void
  advance(ms: number): void
  /** Let every held decision answer now. */
  releaseGate(): void
  /** The jobs dispatched so far (abort spies included). */
  jobs(): MemoryJobControl[]
  /** Dispose the coordinator and settle the teardown. */
  dispose(): Promise<void>
  /** Throw the coordinator away and start a fresh one (process restart). */
  restart(): Promise<void>
}

/**
 * Build one rig.
 * @param options - the mode, the fake runner's probability and the seams'
 *   initial contents.
 * @returns the rig.
 */
export function extractionRig(options: RigOptions = {}): ExtractionRig {
  rigCounter += 1
  const memoryDir = options.memoryDir ?? `/mem/projects/rig-${rigCounter}`
  const sessionId = options.sessionId ?? `session-rig-${rigCounter}`
  const cwd = options.cwd ?? '/workspace/rig'
  const graceMs = options.graceMs ?? 5
  const events: SessionEvent[] = []
  const agent = {
    options: {},
    session: {
      events,
      get seq() { return events.length },
      snapshotEvents() { return events },
      header: { id: sessionId, cwd },
    },
  } as unknown as Agent

  let settings: ExtractionDecisionSettings = {
    ...DEFAULT_EXTRACTION_DECISION_SETTINGS,
    mode: options.mode ?? 'active',
    ...options.settings,
  }
  let index: string | undefined = options.index
  let clock = 1_000_000
  const drainQueue: Array<() => void> = []
  const started: Array<{ prompt: string; baselineIndex: string }> = []
  const observedRequests: DecisionRequest[] = []
  const heldGates: Array<() => void> = []
  const gateWindows: Array<{ fromExclusive: unknown; throughInclusive: unknown }> = []
  const dispatched: MemoryJobControl[] = []

  const makeJob = (call: number): MemoryJobControl => {
    const configured = options.job
    if (configured === undefined) {
      const done = Promise.resolve({ status: 'completed' as const })
      return { abort: vi.fn(), done, settled: done.then(() => true) }
    }
    return typeof configured === 'function' ? configured(call) : configured
  }

  const answeredRun = (probability: number): DecisionRun => ({
    status: 'answered',
    answers: { [EXTRACTION_QUESTION_KEY]: { type: 'noul', noul: probability } as SystemOneAnswer },
    model: 's1-actual',
    usage: { input_tokens: 900, output_tokens: 12 },
    decisionId: 'decision-1',
    inputHash: 'input-hash',
  })

  const runner: BoundDecisionRunner = {
    identifyRoute: () => IDENTITY,
    scope: (originSeq?: number): DecisionScope => ({
      projectKey: PROJECT_KEY,
      sessionId,
      agentId: 'agent-rig',
      originSeq: originSeq ?? -1,
    }),
    run: (request) => {
      observedRequests.push(request)
      const state = request.state as { window?: { fromExclusive?: unknown; throughInclusive?: unknown } }
      gateWindows.push({
        fromExclusive: state.window?.fromExclusive,
        throughInclusive: state.window?.throughInclusive,
      })
      const answer = options.holdGate === true
        ? new Promise<DecisionRun>((resolveGate) => {
          heldGates.push(() => resolveGate(answeredRun(probability)))
        })
        : Promise.resolve(answeredRun(probability))
      return answer
    },
  }

  let probability = options.probability ?? 0.9
  const runnerAvailable = options.runner ?? true

  let coordinator = createExtractionCoordinator({
    readSettings: () => settings,
    memoryDirOf: () => memoryDir,
    readIndex: async (): Promise<ExtractionIndexRead> => ({
      snapshot: index === undefined ? { kind: 'absent' } : { kind: 'text', text: index },
      promptIndex: index ?? '',
    }),
    startJob: async (request) => {
      started.push({ prompt: request.prompt, baselineIndex: request.baselineIndex })
      const job = makeJob(started.length)
      dispatched.push(job)
      return job
    },
    ...(runnerAvailable
      ? { resolveRunner: () => runner }
      : {}),
    now: () => clock,
    schedule: (task) => { drainQueue.push(task) },
    graceMs,
    log: () => {},
  })

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
  }

  const liveState = (): ExtractionState | undefined => coordinator.stateOf(memoryDir, sessionId)

  /** A signature that changes whenever the coordinator makes observable progress. */
  const progressMark = (): string => {
    const state = liveState()
    return [
      state?.phase ?? 'absent',
      state?.reviewedThrough ?? '-',
      state?.pendingHead ?? '-',
      state?.skipOrdinal ?? '-',
      started.length,
      observedRequests.length,
    ].join('|')
  }

  const rig: ExtractionRig = {
    get coordinator() { return coordinator },
    agent,
    memoryDir,
    sessionId,
    growTo(head: number): void {
      while (events.length <= head) events.push(userEvent(events.length, `message ${events.length}`))
    },
    append(event: SessionEvent): void {
      events.push(event)
    },
    async stopAt(head: number): Promise<void> {
      rig.growTo(head)
      await rig.stop()
    },
    async stop(): Promise<void> {
      coordinator.onTurnStopping({ agent, signal: new AbortController().signal })
      await rig.settle()
    },
    async settle(): Promise<void> {
      let previous = ''
      let stable = 0
      for (let round = 0; round < 40; round++) {
        await flush()
        const mark = progressMark()
        if (mark === previous) {
          stable += 1
          // Two consecutive identical rounds mean the work is stalled on a seam
          // the test owns (a deferred job or a held gate): stop, don't hang.
          if (stable >= 2) return
          continue
        }
        stable = 0
        previous = mark
      }
    },
    async drain(): Promise<void> {
      await rig.settle()
      while (drainQueue.length > 0) {
        const task = drainQueue.shift()
        task?.()
        await rig.settle()
      }
    },
    startCount: () => started.length,
    prompts: () => started.map((entry) => entry.prompt),
    baselines: () => started.map((entry) => entry.baselineIndex),
    windows: () => [...gateWindows],
    requests: () => [...observedRequests],
    state: liveState,
    reviewedThrough: () => liveState()?.reviewedThrough ?? -1,
    pendingWindow: () => {
      const state = liveState()
      const from = state?.reviewedThrough ?? -1
      return { fromExclusive: from, throughInclusive: state?.pendingHead ?? from }
    },
    phase: () => liveState()?.phase ?? 'absent',
    skipOrdinal: () => liveState()?.skipOrdinal ?? 0,
    settings: () => settings,
    setMode(mode: ExtractionMode): void { settings = { ...settings, mode } },
    setProbability(next: number): void { probability = next },
    setIndex(next: string | undefined): void { index = next },
    advance(ms: number): void { clock += ms },
    releaseGate(): void {
      while (heldGates.length > 0) {
        const resolveGate = heldGates.shift()
        resolveGate?.()
      }
    },
    jobs: () => [...dispatched],
    async dispose(): Promise<void> {
      coordinator.dispose()
      await flush()
    },
    async restart(): Promise<void> {
      coordinator.dispose()
      await flush()
      drainQueue.length = 0
      started.length = 0
      observedRequests.length = 0
      gateWindows.length = 0
      dispatched.length = 0
      coordinator = createExtractionCoordinator({
        readSettings: () => settings,
        memoryDirOf: () => memoryDir,
        readIndex: async (): Promise<ExtractionIndexRead> => ({
          snapshot: index === undefined ? { kind: 'absent' } : { kind: 'text', text: index },
          promptIndex: index ?? '',
        }),
        startJob: async (request) => {
          started.push({ prompt: request.prompt, baselineIndex: request.baselineIndex })
          const job = makeJob(started.length)
          dispatched.push(job)
          return job
        },
        ...(runnerAvailable ? { resolveRunner: () => runner } : {}),
        now: () => clock,
        schedule: (task) => { drainQueue.push(task) },
        graceMs,
        log: () => {},
      })
    },
  }
  return rig
}
