/**
 * Lifecycle pins (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"Degradation and
 * lifecycle truth table", §"The repo write lease and its relation to dream"):
 * disposal aborts the gate/job and gives the lease back, a failure cooldown is
 * only re-armed by a later stop, the active → off flip never double-dispatches,
 * and a dream lease conflict returns before the disk lock is ever touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BoundDecisionRunner } from '@dsh-cc/systemone'
import { apply } from '../src/index.ts'
import type { JobOutcome, MemoryJobControl } from '../src/memory-job.ts'
import { tryAcquireMemoryMutationLease } from '../src/mutation-lease.ts'
import { EXTRACTION_QUESTION_KEY } from '../src/extraction-gate.ts'
import { deferred, extractionRig } from './helpers/extraction-rig.ts'

/** A caller-controlled job control object. */
function deferredJob(done: ReturnType<typeof deferred<JobOutcome>>): MemoryJobControl {
  return {
    abort: vi.fn(),
    done: done.promise,
    settled: done.promise.then((outcome) => outcome.status === 'completed'),
  }
}

describe('disposal', () => {
  it('aborts the in-flight job, destroys the state and releases the lease', async () => {
    const done = deferred<JobOutcome>()
    const job = deferredJob(done)
    const rig = extractionRig({ mode: 'active', probability: 0.9, job })
    await rig.stopAt(3)
    expect(rig.phase()).toBe('extracting')
    // The extraction owns the canonical dir's write slot.
    expect(tryAcquireMemoryMutationLease(rig.memoryDir)).toBeUndefined()

    await rig.dispose()
    expect(job.abort).toHaveBeenCalledTimes(1)
    expect(rig.state()).toBeUndefined()
    // The lease is back: a dream-style tryAcquire succeeds immediately.
    const released = tryAcquireMemoryMutationLease(rig.memoryDir)
    expect(typeof released).toBe('function')
    released?.()

    // The late outcome of the aborted job never commits a watermark.
    done.resolve({ status: 'completed' })
    await rig.settle()
    expect(rig.state()).toBeUndefined()
  })

  it('aborts a gate that is still deciding, without dispatching or moving the watermark', async () => {
    const rig = extractionRig({ mode: 'active', probability: 0.01, holdGate: true })
    await rig.stopAt(2)
    expect(rig.requests()).toHaveLength(1)
    await rig.dispose()
    rig.releaseGate()
    await rig.settle()
    expect(rig.startCount()).toBe(0)
    expect(rig.state()).toBeUndefined()
    expect(tryAcquireMemoryMutationLease(rig.memoryDir)).toBeDefined()
  })
})

describe('failure cooldown', () => {
  it('does not retry inside the cooldown and retries on the next stop after it expires', async () => {
    const failed = deferred<JobOutcome>()
    const rig = extractionRig({
      mode: 'active',
      probability: 0.9,
      job: deferredJob(failed),
    })
    await rig.stopAt(4)
    failed.resolve({ status: 'failed', detail: 'write-back failed' })
    await rig.settle()
    expect(rig.phase()).toBe('cooldown')
    expect(rig.reviewedThrough()).toBe(-1)
    const retryAt = rig.state()?.retryAt ?? 0
    expect(retryAt).toBeGreaterThan(0)

    // A later stop inside the cooldown only moves the pending head.
    rig.advance(1)
    await rig.stopAt(6)
    expect(rig.startCount()).toBe(1)
    expect(rig.pendingWindow()).toEqual({ fromExclusive: -1, throughInclusive: 6 })

    // After the cooldown expires the next stop retries the whole unreviewed span.
    rig.advance(rig.settings().failureCooldownMs)
    await rig.stopAt(8)
    expect(rig.startCount()).toBe(2)
    expect(rig.windows()).toEqual([
      { fromExclusive: -1, throughInclusive: 4 },
      { fromExclusive: -1, throughInclusive: 8 },
    ])
  })

  it('installs no retry timer: a quiet session never forks again', async () => {
    const failed = deferred<JobOutcome>()
    const rig = extractionRig({ mode: 'active', probability: 0.9, job: deferredJob(failed) })
    await rig.stopAt(2)
    failed.resolve({ status: 'failed', detail: 'boom' })
    await rig.settle()
    rig.advance(rig.settings().failureCooldownMs * 10)
    await rig.settle()
    expect(rig.startCount()).toBe(1)
    expect(rig.phase()).toBe('cooldown')
  })
})

/** One user message, so the coordinator has an evidence head to review. */
function fakeAgent(cwd: string, id: string): Agent {
  const events: unknown[] = [{
    type: 'user/message',
    seq: 0,
    time: 0,
    surfaceOp: 'append',
    data: { id: 'm0', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
  }]
  return {
    options: {},
    session: {
      events,
      get seq() { return events.length },
      snapshotEvents() { return events },
      header: { id, cwd },
    },
  } as unknown as Agent
}

/** Minimal fs seam: an absent index, and a write log for the lock assertions. */
function makeFsMock() {
  const backing = new Map<string, string>()
  const writes: string[] = []
  return {
    backing,
    writes,
    async resolve(path: string) { return { targetKey: path, displayPath: path } },
    async stat(target: unknown) {
      const key = String((target as { targetKey: unknown }).targetKey)
      const content = backing.get(key)
      return content === undefined ? undefined : { version: 'v1', type: 'file', size: content.length }
    },
    async readText(target: unknown) {
      const key = String((target as { targetKey: unknown }).targetKey)
      const content = backing.get(key)
      if (content === undefined) throw new Error('not found')
      return content
    },
    async writeText(target: unknown, content: string) {
      const key = String((target as { targetKey: unknown }).targetKey)
      writes.push(key)
      backing.set(key, content)
      return {}
    },
    async listDir() { return [] },
  }
}

/** Answering runner: one high-probability Noul (extract). */
function extractRunner(probability = 0.9): BoundDecisionRunner {
  return {
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
    run: async () => ({
      status: 'answered',
      answers: { [EXTRACTION_QUESTION_KEY]: { type: 'noul', noul: probability } },
      model: 'm',
      usage: { input_tokens: 1, output_tokens: 1 },
      decisionId: 'd',
      inputHash: 'h',
    }),
  } as unknown as BoundDecisionRunner
}

describe('single-listener mode handoff', () => {
  const sessions: string[] = []
  beforeEach(() => { sessions.push(`session-${sessions.length}`) })
  afterEach(() => { sessions.length = 0 })

  it('active → off never double-dispatches: the coordinator drains before the legacy branch', async () => {
    const ctx = new Context()
    const memoryHome = '/mem-handoff'
    const section: { current: Record<string, unknown> } = { current: { mode: 'active' } }
    const provider = { register: () => undefined, get: () => section.current }
    let activations = 0
    let disposals = 0
    const prompts: string[] = []
    const subagents = {
      async startActivation(spec: { label: string; request: { prompt: readonly { text: string }[] } }) {
        activations += 1
        prompts.push(spec.request.prompt[0]?.text ?? '')
        const run = deferred<unknown>()
        let disposed = false
        const dispose = (): Promise<void> => {
          if (!disposed) {
            disposed = true
            disposals += 1
            run.reject(new Error('cancelled'))
          }
          return Promise.resolve()
        }
        return { childId: `child-${activations}`, messageId: `m-${activations}`, result: run.promise, dispose }
      },
    }
    const fs = makeFsMock()
    ctx.provide('settings' as never, provider as never)
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, fs as never)
    ctx.provide('ccSystemoneDecisions' as never, { forAgent: () => extractRunner() } as never)
    apply(ctx, { memoryHome, dreamEnabled: false })

    const agent = fakeAgent('/mem-handoff', 'session-handoff')
    const stop = async (): Promise<void> => {
      await ctx.serial('agent/turn-stopping' as never, { agent, signal: new AbortController().signal } as never)
    }

    await stop()
    await vi.waitFor(() => expect(activations).toBe(1))
    expect(prompts[0]).toContain('Review window (fromExclusive=-1, throughInclusive=0):')

    // Flip to off: the coordinator is cancelled and drained, then the legacy
    // branch owns the SAME stop — never both.
    section.current = { mode: 'off' }
    await stop()
    await vi.waitFor(() => expect(activations).toBe(2))
    expect(disposals).toBe(1)
    expect(prompts[1]).toContain('messages of this conversation')
    // Exactly one dispatch for the second stop, and no late coordinator fork.
    await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 25) })
    expect(activations).toBe(2)
  })
})

describe('dream wiring (local lease before the disk lock)', () => {
  let tmpRoot = ''
  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'dream-lease-sessions-'))
  })
  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true })
  })

  /** Seed one fresh top-level session so the dream gates pass. */
  async function seedSession(root: string, id: string): Promise<void> {
    const dir = join(root, 'proj', id)
    await mkdir(dir, { recursive: true })
    const header = JSON.stringify({
      type: 'session', version: 3, id, createdAt: 1000, cwd: '/x', delegationDepth: 0, isSeeded: false,
    })
    await writeFile(join(dir, 'session.v3.jsonl.zstd'), zstdCompressSync(Buffer.from(`${header}\n`)))
  }

  it('an in-flight extraction holding the local lease makes the dream round return without the disk lock', async () => {
    await seedSession(tmpRoot, 's1')
    const ctx = new Context()
    const memoryHome = '/mem-dream-lease'
    const started: string[] = []
    const extractionRun = deferred<unknown>()
    const subagents = {
      async startActivation(spec: { label: string }) {
        started.push(spec.label)
        // The extraction fork is HELD: it keeps the mutation lease while the
        // dream lane runs its gates for the next stop.
        if (spec.label === 'extract-memories') {
          return {
            childId: 'extract-child',
            messageId: 'm-extract',
            result: extractionRun.promise,
            dispose: () => Promise.resolve(),
          }
        }
        return {
          childId: 'dream-child',
          messageId: 'm-dream',
          result: Promise.resolve({ structured: { writes: [] }, stopReason: 'completed' }),
          dispose: () => Promise.resolve(),
        }
      },
    }
    const fs = makeFsMock()
    ctx.provide('settings' as never, { register: () => undefined, get: () => ({ mode: 'active' }) } as never)
    ctx.provide('subagents' as never, subagents as never)
    ctx.provide('fs' as never, fs as never)
    ctx.provide('ccSystemoneDecisions' as never, { forAgent: () => extractRunner() } as never)
    apply(ctx, {
      memoryHome,
      dreamEnabled: true,
      sessionsRoot: tmpRoot,
      minSessions: 1,
      minHours: 0,
    })
    const agent = fakeAgent(memoryHome, 'session-dream-lease')
    const stop = async (): Promise<void> => {
      await ctx.serial('agent/turn-stopping' as never, { agent, signal: new AbortController().signal } as never)
    }

    // Stop 1: the extraction takes the canonical dir's lease and holds it.
    await stop()
    await vi.waitFor(() => expect(started).toContain('extract-memories'))

    // Stop 2 runs while that lease is still held: the dream round must return
    // BEFORE the original disk lock instead of queueing behind it.
    started.length = 0
    fs.writes.length = 0
    await stop()
    await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 40) })
    expect(started).toEqual([])
    expect(fs.writes.filter((key) => key.endsWith('.consolidation-lock'))).toEqual([])
  })
})
