/**
 * Coordinator pins (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"State machine
 * and commit rules", the test table and the deferred-done example at the end of
 * the design).
 *
 * The point of every test here is the boundary between DISPATCH and COMPLETION:
 * the review watermark advances only after `job.done` says `completed`, a second
 * stop never runs a concurrent job, and a skip verdict only commits against the
 * material it was asked about. Windows, prompts and decisions are observed
 * through {@link extractionRig}'s fake runner, fake job and manual drain.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createExtractionCoordinator } from '../src/extraction-coordinator.ts'
import {
  DEFAULT_EXTRACTION_DECISION_SETTINGS,
  type ExtractionDecisionSettings,
} from '../src/extraction-settings.ts'
import type { JobOutcome, MemoryJobControl } from '../src/memory-job.ts'
import { deferred, extractionRig, imageUserEvent } from './helpers/extraction-rig.ts'

/** A caller-controlled job control object (the design's deferred-done idiom). */
function deferredJob(done: ReturnType<typeof deferred<JobOutcome>>): MemoryJobControl {
  return {
    abort: vi.fn(),
    done: done.promise,
    settled: done.promise.then((outcome) => outcome.status === 'completed'),
  }
}

describe('dispatch is not completion', () => {
  it('does not treat dispatch as completion', async () => {
    const done = deferred<JobOutcome>()
    const job: MemoryJobControl = {
      abort: vi.fn(),
      done: done.promise,
      settled: done.promise.then((x) => x.status === 'completed'),
    }
    const rig = extractionRig({ mode: 'active', probability: 0.9, job })
    await rig.stopAt(7)
    await rig.stopAt(11)
    expect(rig.startCount()).toBe(1)
    expect(rig.reviewedThrough()).toBe(-1)
    done.resolve({ status: 'completed' })
    await rig.settle()
    expect(rig.reviewedThrough()).toBe(7)
    expect(rig.pendingWindow()).toEqual({ fromExclusive: 7, throughInclusive: 11 })
  })

  it('a completed outcome with EMPTY writes still advances to the captured head', async () => {
    const done = deferred<JobOutcome>()
    const rig = extractionRig({ mode: 'active', probability: 0.9, job: deferredJob(done) })
    await rig.stopAt(4)
    expect(rig.reviewedThrough()).toBe(-1)
    // `completed` means the host validated and wrote the (empty) batch.
    done.resolve({ status: 'completed' })
    await rig.settle()
    expect(rig.reviewedThrough()).toBe(4)
    expect(rig.phase()).toBe('idle')
    expect(rig.state()?.pendingHead).toBeUndefined()
  })

  it('repeated stops while the job is unsettled produce a single job', async () => {
    const done = deferred<JobOutcome>()
    const rig = extractionRig({ mode: 'active', probability: 0.9, job: deferredJob(done) })
    await rig.stopAt(3)
    await rig.stopAt(5)
    await rig.stopAt(7)
    expect(rig.startCount()).toBe(1)
    expect(rig.reviewedThrough()).toBe(-1)
    // The pending head keeps the maximum of the later stops.
    expect(rig.pendingWindow()).toEqual({ fromExclusive: -1, throughInclusive: 7 })
    done.resolve({ status: 'completed' })
    await rig.settle()
    expect(rig.reviewedThrough()).toBe(3)
    done.resolve({ status: 'completed' })
  })
})

describe('the windowed prompt', () => {
  it('sends the captured window and the complete index, and never the whole-session count', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.9, index: '- style.md: code style' })
    await rig.stopAt(0)
    const [prompt] = rig.prompts()
    expect(prompt).toContain('Review window (fromExclusive=-1, throughInclusive=0):')
    expect(prompt).toContain('- seq 0 [user]: message 0')
    expect(prompt).toContain('host state: the model cannot advance, extend, reset or otherwise change it')
    expect(prompt).toContain('- style.md: code style')
    // The reviewed-through watermark is host state, and newer content is context.
    expect(prompt).toContain('Session content outside it — including anything newer — is context only')
    expect(prompt).not.toContain('messages of this conversation')
    expect(rig.baselines()).toEqual(['- style.md: code style'])
    expect(rig.reviewedThrough()).toBe(0)
  })

  it('keeps seq 0 reviewable: the first window starts after -1', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.9 })
    await rig.stopAt(0)
    expect(rig.windows()).toEqual([{ fromExclusive: -1, throughInclusive: 0 }])
  })

  it('falls back to the ORIGINAL whole-session prompt for an incomplete window', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.9 })
    rig.growTo(2)
    // A non-text block makes the window unreconstructable: it is never asked.
    rig.append(imageUserEvent(3))
    await rig.stop()
    expect(rig.requests()).toHaveLength(0)
    expect(rig.startCount()).toBe(1)
    expect(rig.prompts()[0]).toContain('messages of this conversation')
    // The watermark still only advances to the captured head.
    expect(rig.reviewedThrough()).toBe(3)
  })

  it('extracts as unavailable (one fork) when no decision service is bound', async () => {
    const rig = extractionRig({ mode: 'active', runner: false })
    await rig.stopAt(2)
    expect(rig.requests()).toHaveLength(0)
    expect(rig.startCount()).toBe(1)
    expect(rig.reviewedThrough()).toBe(2)
  })
})

describe('skip verdicts settle against a moving evidence head', () => {
  it('commits an eligible active skip and clears the drained pending head', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.01 })
    await rig.stopAt(4)
    expect(rig.requests()).toHaveLength(1)
    expect(rig.startCount()).toBe(0)
    expect(rig.reviewedThrough()).toBe(4)
    expect(rig.skipOrdinal()).toBe(1)
  })

  it('never commits a skip whose window is no longer the reviewed material', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.01, holdGate: true })
    await rig.stopAt(4)
    expect(rig.requests()).toHaveLength(1)
    // A second stop arrives before the gate answers: only the head moves.
    rig.growTo(9)
    await rig.stop()
    expect(rig.skipOrdinal()).toBe(0)
    rig.releaseGate()
    await rig.settle()
    // The old verdict is discarded: no watermark move, no fallback fork.
    expect(rig.reviewedThrough()).toBe(-1)
    expect(rig.skipOrdinal()).toBe(0)
    expect(rig.startCount()).toBe(0)
    // The next drain covers EVERY unreviewed event, not just the lost window.
    await rig.drain()
    rig.releaseGate()
    await rig.settle()
    expect(rig.windows()).toEqual([
      { fromExclusive: -1, throughInclusive: 4 },
      { fromExclusive: -1, throughInclusive: 9 },
    ])
    expect(rig.reviewedThrough()).toBe(9)
  })

  it('discards a skip when the index changed under the gate', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.01, index: '- a.md: a', holdGate: true })
    await rig.stopAt(4)
    rig.setIndex('- a.md: a\n- b.md: b')
    rig.releaseGate()
    await rig.settle()
    expect(rig.reviewedThrough()).toBe(-1)
    expect(rig.skipOrdinal()).toBe(0)
    await rig.drain()
    rig.releaseGate()
    await rig.settle()
    expect(rig.reviewedThrough()).toBe(4)
  })

  it('discards a skip when the mode flips to off mid-gate: no watermark move, no fallback', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.01, holdGate: true })
    await rig.stopAt(4)
    rig.setMode('off')
    rig.releaseGate()
    await rig.settle()
    expect(rig.reviewedThrough()).toBe(-1)
    expect(rig.startCount()).toBe(0)
    expect(rig.phase()).toBe('idle')
    // The legacy branch owns the next stop: the coordinator must not drain.
    await rig.drain()
    expect(rig.startCount()).toBe(0)
    expect(rig.reviewedThrough()).toBe(-1)
  })
})

describe('skip auditing', () => {
  it('audits the 20th skippable window and skips the first 19', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.01 })
    for (let head = 0; head < 19; head++) await rig.stopAt(head)
    expect(rig.startCount()).toBe(0)
    expect(rig.skipOrdinal()).toBe(19)
    expect(rig.reviewedThrough()).toBe(18)

    await rig.stopAt(19)
    expect(rig.skipOrdinal()).toBe(20)
    expect(rig.startCount()).toBe(1)
    expect(rig.prompts()[0]).toContain('Review window (fromExclusive=18, throughInclusive=19):')
    expect(rig.reviewedThrough()).toBe(19)
  })

  it('audits every skip when auditEveryNSkips is 1', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.01, settings: { auditEveryNSkips: 1 } })
    await rig.stopAt(2)
    expect(rig.skipOrdinal()).toBe(1)
    expect(rig.startCount()).toBe(1)
  })

  it('shadow forks on all 20 would-skip windows and counts them', async () => {
    const rig = extractionRig({ mode: 'shadow', probability: 0.01 })
    for (let head = 0; head < 20; head++) await rig.stopAt(head)
    expect(rig.startCount()).toBe(20)
    expect(rig.skipOrdinal()).toBe(20)
    expect(rig.reviewedThrough()).toBe(19)
  })
})

describe('failure, restart and cache', () => {
  it('a failed (partial) host write keeps the previous watermark and cools down', async () => {
    const done = deferred<JobOutcome>()
    const rig = extractionRig({ mode: 'active', probability: 0.9, job: deferredJob(done) })
    await rig.stopAt(4)
    done.resolve({ status: 'failed', detail: 'write-back failed after 1 of 2 files' })
    await rig.settle()
    expect(rig.reviewedThrough()).toBe(-1)
    expect(rig.phase()).toBe('cooldown')
  })

  it('a killed job keeps the previous watermark without cooldown when it was not a dispose', async () => {
    const done = deferred<JobOutcome>()
    const rig = extractionRig({ mode: 'active', probability: 0.9, job: deferredJob(done) })
    await rig.stopAt(4)
    done.resolve({ status: 'killed' })
    await rig.settle()
    expect(rig.reviewedThrough()).toBe(-1)
    expect(rig.phase()).toBe('cooldown')
  })

  it('a restart re-reviews from -1', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.01 })
    await rig.stopAt(3)
    await rig.stopAt(5)
    expect(rig.reviewedThrough()).toBe(5)
    await rig.restart()
    expect(rig.reviewedThrough()).toBe(-1)
    await rig.stopAt(5)
    expect(rig.windows()).toEqual([{ fromExclusive: -1, throughInclusive: 5 }])
    expect(rig.reviewedThrough()).toBe(5)
  })
})

/** A direct coordinator over N sessions on one dir (the LRU needs several keys). */
function multiSessionCoordinator(settings: Partial<ExtractionDecisionSettings>) {
  let clock = 1_000
  const requests: string[] = []
  const coordinator = createExtractionCoordinator({
    readSettings: () => ({ ...DEFAULT_EXTRACTION_DECISION_SETTINGS, mode: 'active', skipProbability: 0.2, ...settings }),
    memoryDirOf: () => '/mem/projects/lru',
    readIndex: async () => ({ snapshot: { kind: 'absent' }, promptIndex: '' }),
    startJob: async () => {
      const done = Promise.resolve({ status: 'completed' as const })
      return { abort: () => {}, done, settled: done.then(() => true) }
    },
    resolveRunner: () => ({
      identifyRoute: () => ({
        provider: 'p',
        model: 'm',
        revision: 'r',
        perRequestTokens: 1,
        perQuestionTokens: 1,
        maxQuestions: 1,
        maxOutputTokens: 1,
      }),
      scope: (originSeq?: number) => ({ projectKey: 'k', sessionId: 's', agentId: 'a', originSeq: originSeq ?? -1 }),
      run: async (request) => {
        requests.push(String((request.state as { window?: { throughInclusive?: unknown } }).window?.throughInclusive))
        return {
          status: 'answered',
          answers: { has_durable_novel_fact: { type: 'noul', noul: 0.01 } },
          model: 'm',
          usage: { input_tokens: 1, output_tokens: 1 },
          decisionId: 'd',
          inputHash: 'h',
        }
      },
    }),
    now: () => clock,
    schedule: () => {},
    log: () => {},
  })
  const stopFor = (sessionId: string, head: number, tick: number): void => {
    clock += tick
    const events: unknown[] = []
    for (let seq = 0; seq <= head; seq++) {
      events.push({
        type: 'user/message',
        seq,
        time: 0,
        surfaceOp: 'append',
        data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text: `m${seq}` }], source: { kind: 'user' } },
      })
    }
    const agent = {
      options: {},
      session: {
        events,
        get seq() { return events.length },
        snapshotEvents() { return events },
        header: { id: sessionId, cwd: '/workspace/lru' },
      },
    } as unknown as Agent
    coordinator.onTurnStopping({ agent, signal: new AbortController().signal })
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return { coordinator, stopFor, flush, requests, stateOf: (id: string) => coordinator.stateOf('/mem/projects/lru', id) }
}

describe('session state cache', () => {
  it('evicts only idle states by lastUsedAt, oldest first, and never skips a new session', async () => {
    const { stopFor, flush, requests, stateOf } = multiSessionCoordinator({ sessionStateCap: 2 })
    stopFor('session-a', 1, 1)
    await flush()
    stopFor('session-b', 1, 1)
    await flush()
    expect(stateOf('session-a')?.reviewedThrough).toBe(1)
    expect(stateOf('session-b')?.reviewedThrough).toBe(1)

    stopFor('session-c', 1, 1)
    await flush()
    // The oldest idle state is gone; a brand new session still gated (never skipped).
    expect(stateOf('session-a')).toBeUndefined()
    expect(stateOf('session-b')?.reviewedThrough).toBe(1)
    expect(stateOf('session-c')?.reviewedThrough).toBe(1)
    expect(requests).toEqual(['1', '1', '1'])
  })
})

/** A job that already completed successfully. */
function completedJob(): MemoryJobControl {
  const done = Promise.resolve({ status: 'completed' as const })
  return { abort: vi.fn(), done, settled: done.then(() => true) }
}

/** A second Agent instance for the same session header (an owner takeover). */
function takeoverAgent(rig: { agent: Agent; sessionId: string }): Agent {
  const events = rig.agent.session.events
  return {
    options: {},
    session: {
      events,
      get seq() { return events.length },
      snapshotEvents() { return events },
      header: { id: rig.sessionId, cwd: '/workspace/rig' },
    },
  } as unknown as Agent
}

describe('owner takeover', () => {
  it('cancels the old owner, waits bounded for its job.done and starts at watermark -1', async () => {
    const done = deferred<JobOutcome>()
    const first = deferredJob(done)
    const rig = extractionRig({
      mode: 'active',
      probability: 0.9,
      graceMs: 1,
      job: (call) => (call === 1 ? first : completedJob()),
    })
    await rig.stopAt(3)
    expect(rig.phase()).toBe('extracting')

    rig.coordinator.onTurnStopping({ agent: takeoverAgent(rig), signal: new AbortController().signal })
    await rig.settle()

    // The old fork was cancelled and the fresh state reviews from -1 again.
    expect(first.abort).toHaveBeenCalledTimes(1)
    expect(rig.windows()).toEqual([
      { fromExclusive: -1, throughInclusive: 3 },
      { fromExclusive: -1, throughInclusive: 3 },
    ])
    expect(rig.reviewedThrough()).toBe(3)
    expect(rig.startCount()).toBe(2)

    // The old job's late completion is host-validated but its commit is dropped.
    done.resolve({ status: 'completed' })
    await rig.settle()
    expect(rig.reviewedThrough()).toBe(3)
    expect(rig.startCount()).toBe(2)
  })

  it('proceeds with the fresh state even when the old job never settles', async () => {
    const never = new Promise<JobOutcome>(() => {})
    const stuck: MemoryJobControl = { abort: vi.fn(), done: never, settled: never.then(() => false) }
    const rig = extractionRig({
      mode: 'active',
      probability: 0.9,
      graceMs: 1,
      job: (call) => (call === 1 ? stuck : completedJob()),
    })
    await rig.stopAt(2)
    expect(rig.phase()).toBe('extracting')

    rig.coordinator.onTurnStopping({ agent: takeoverAgent(rig), signal: new AbortController().signal })
    await rig.settle()
    // The bounded grace expired: the new owner still reviews from -1 and commits.
    expect(rig.windows()).toEqual([
      { fromExclusive: -1, throughInclusive: 2 },
      { fromExclusive: -1, throughInclusive: 2 },
    ])
    expect(rig.reviewedThrough()).toBe(2)
  })
})
