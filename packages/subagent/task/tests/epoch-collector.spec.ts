/**
 * Tests for the dsh-cc epoch collector (docs/plans/2026-09-05-epoch-collector-dsh-cc.md
 * §9): inline first-epoch collection of a continuable child over the shared
 * `subagent/start` / `subagent/end` bus listeners, with abort semantics,
 * duplicate-notice suppression bookkeeping, parallel-collector sharing, and
 * capability degradation.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  collectFirstEpoch,
  collectorFor,
  collectorKey,
  collectorsForSession,
  epochWatchSize,
  isCollectedForSuppression,
  registerCollector,
  unregisterCollector,
  type EpochOutcome,
} from '../src/epoch-collector.ts'

/** A fake cordis bus recording listener registrations and disposal. */
class FakeBus {
  private readonly listeners = new Map<string, { fn: (info: Record<string, unknown>) => void; disposed: boolean }[]>()
  disposeCount = 0

  on(event: string, fn: (info: Record<string, unknown>) => void): () => void {
    const record = { fn, disposed: false }
    const list = this.listeners.get(event) ?? []
    list.push(record)
    this.listeners.set(event, list)
    return () => {
      if (record.disposed) return
      record.disposed = true
      this.disposeCount++
    }
  }

  emit(event: string, info: Record<string, unknown>): void {
    for (const record of this.listeners.get(event) ?? []) {
      if (!record.disposed) record.fn(info)
    }
  }

  /** Number of still-registered listeners for an event. */
  liveCount(event: string): number {
    return (this.listeners.get(event) ?? []).filter(r => !r.disposed).length
  }
}

const agent = { id: 'parent-1' } as unknown as Agent

function freshSignal(): AbortSignal {
  return new AbortController().signal
}

describe('epoch collector', () => {
  it('case 1: resolves on the end event matching the first-epoch runId and ignores a later cold-resume epoch', async () => {
    const bus = new FakeBus()
    const done = collectFirstEpoch({
      bus,
      childId: 'c1',
      agent,
      signal: freshSignal(),
      start: async () => {},
    })
    bus.emit('subagent/start', { runId: 'r1', provider: 'spawn', id: 'c1', local: true })
    bus.emit('subagent/end', {
      runId: 'r1',
      provider: 'spawn',
      id: 'c1',
      local: true,
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'done' }],
    })
    const outcome: EpochOutcome = await done
    expect(outcome).toEqual({
      kind: 'epoch',
      stopReason: 'completed',
      output: [{ type: 'text', text: 'done' }],
    })
    // A later cold-resumed epoch's end (new runId) is ignored: no stale watcher.
    bus.emit('subagent/end', { runId: 'r9', provider: 'spawn', id: 'c1', local: true, stopReason: 'error' })
    expect(epochWatchSize()).toBe(0)
  })

  it('case 2: catches an immediate settle delivered synchronously inside start (subscribe-before-start)', async () => {
    const bus = new FakeBus()
    const done = collectFirstEpoch({
      bus,
      childId: 'c2',
      agent,
      signal: freshSignal(),
      start: async () => {
        // The child settles between startContinuable and the first poll.
        bus.emit('subagent/start', { runId: 'r2', provider: 'spawn', id: 'c2', local: true })
        bus.emit('subagent/end', { runId: 'r2', provider: 'spawn', id: 'c2', local: true, stopReason: 'completed' })
      },
    })
    const outcome = await done
    expect(outcome).toEqual({ kind: 'epoch', stopReason: 'completed' })
    expect(epochWatchSize()).toBe(0)
  })

  it('case 3: abort interrupts exactly once with the ancestor authority, resolves promptly, and keeps the watcher armed for the real end', async () => {
    const bus = new FakeBus()
    const ac = new AbortController()
    const interrupts: [string, unknown][] = []
    const done = collectFirstEpoch({
      bus,
      childId: 'c3',
      agent,
      signal: ac.signal,
      subagents: {
        interrupt: (childId, authority) => {
          interrupts.push([childId, authority])
        },
      },
      start: async () => {},
    })
    ac.abort()
    const outcome = await done
    // Prompt synthetic resolution — not awaiting the child's terminal.
    expect(outcome).toEqual({ kind: 'aborted', stopReason: 'aborted' })
    expect(interrupts).toEqual([['c3', { kind: 'ancestor', agent }]])
    // A second abort signal event must not re-interrupt.
    ac.abort()
    expect(interrupts).toHaveLength(1)
    // The real terminal arrives later: it performs the suppression
    // bookkeeping (entry release) and disposes the shared watchers.
    bus.emit('subagent/start', { runId: 'r3', provider: 'spawn', id: 'c3', local: true })
    bus.emit('subagent/end', { runId: 'r3', provider: 'spawn', id: 'c3', local: true, stopReason: 'aborted' })
    expect(epochWatchSize()).toBe(0)
    expect(bus.liveCount('subagent/end')).toBe(0)
    expect(bus.liveCount('subagent/start')).toBe(0)
  })

  it('case 5 seam: the collector registry registers and unregisters handles by key', () => {
    const handle = { childId: 'c5', promote: () => {}, abort: () => {} }
    registerCollector('parent-1\u0000call-5', handle)
    unregisterCollector('parent-1\u0000call-5')
    // Unregistered keys resolve to nothing; double-unregister is a no-op.
    expect(() => unregisterCollector('parent-1\u0000call-5')).not.toThrow()
  })

  it('case 6: parallel collectors share ONE end listener and one map; the listener is disposed on the last release with no cross-talk', async () => {
    const bus = new FakeBus()
    const a = collectFirstEpoch({ bus, childId: 'p1', agent, signal: freshSignal(), start: async () => {} })
    const b = collectFirstEpoch({ bus, childId: 'p2', agent, signal: freshSignal(), start: async () => {} })
    expect(bus.liveCount('subagent/end')).toBe(1)
    expect(bus.liveCount('subagent/start')).toBe(1)
    bus.emit('subagent/start', { runId: 'ra', provider: 'spawn', id: 'p1', local: true })
    bus.emit('subagent/start', { runId: 'rb', provider: 'spawn', id: 'p2', local: true })
    bus.emit('subagent/end', { runId: 'ra', provider: 'spawn', id: 'p1', local: true, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'A' }] })
    const outcomeA = await a
    expect(outcomeA).toEqual({ kind: 'epoch', stopReason: 'completed', output: [{ type: 'text', text: 'A' }] })
    expect(epochWatchSize()).toBe(1)
    // p1's end must not resolve p2's collect (no cross-talk).
    let bSettled = false
    void b.then(o => {
      bSettled = true
      return o
    })
    bus.emit('subagent/end', { runId: 'rb', provider: 'spawn', id: 'p2', local: true, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'B' }] })
    const outcomeB = await b
    expect(outcomeB).toEqual({ kind: 'epoch', stopReason: 'completed', output: [{ type: 'text', text: 'B' }] })
    expect(bSettled).toBe(true)
    expect(epochWatchSize()).toBe(0)
    expect(bus.liveCount('subagent/end')).toBe(0)
  })

  it('case 7: when the seam lacks interrupt, abort still resolves promptly (degraded, observable, no hang)', async () => {
    const bus = new FakeBus()
    const ac = new AbortController()
    const done = collectFirstEpoch({
      bus,
      childId: 'c7',
      agent,
      signal: ac.signal,
      subagents: {}, // no interrupt capability
      start: async () => {},
    })
    ac.abort()
    const outcome = await done
    expect(outcome).toEqual({ kind: 'aborted', stopReason: 'aborted' })
    // The degraded collect still keeps its watch entry armed for suppression
    // bookkeeping; the real terminal (with its runId) releases it.
    bus.emit('subagent/start', { runId: 'r7', provider: 'spawn', id: 'c7', local: true })
    bus.emit('subagent/end', { runId: 'r7', provider: 'spawn', id: 'c7', local: true, stopReason: 'aborted' })
    expect(epochWatchSize()).toBe(0)
  })

  it('releases the reservation and the suppression mark when start throws (tombstone parity lives in the tool)', async () => {
    const bus = new FakeBus()
    await expect(collectFirstEpoch({
      bus,
      childId: 'cx',
      agent,
      signal: freshSignal(),
      start: async () => {
        throw new Error('start failed')
      },
    })).rejects.toThrow('start failed')
    expect(epochWatchSize()).toBe(0)
    expect(bus.liveCount('subagent/end')).toBe(0)
  })
})

describe('Slice 3 promotion (epoch-collector doc §6)', () => {
  it('settle-wins: the epoch outcome resolves, the registration is removed, and the suppression mark stays for the pop-once listener', async () => {
    const bus = new FakeBus()
    const key = collectorKey('parent-1', 'call-s1')
    const done = collectFirstEpoch({
      bus,
      childId: 'c-s1',
      agent,
      signal: freshSignal(),
      parentSessionId: 'parent-1',
      toolCallToken: 'call-s1',
      start: async () => {},
    })
    bus.emit('subagent/start', { runId: 'rs1', provider: 'spawn', id: 'c-s1', local: true })
    expect(collectorFor(key)?.childId).toBe('c-s1')
    expect(isCollectedForSuppression('c-s1')).toBe(true)
    bus.emit('subagent/end', {
      runId: 'rs1', provider: 'spawn', id: 'c-s1', local: true,
      stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'done' }],
    })
    await expect(done).resolves.toEqual({
      kind: 'epoch', stopReason: 'completed', output: [{ type: 'text', text: 'done' }],
    })
    // Registry cleanup on settle: the resolved collect is never promotable.
    expect(collectorFor(key)).toBeUndefined()
    // Suppression mark persists (the pre-step waterfall pops it when the
    // duplicated settled notice is dropped).
    expect(isCollectedForSuppression('c-s1')).toBe(true)
    expect(epochWatchSize()).toBe(0)
  })

  it('promote-wins: resolves { kind: promoted }, unregisters, un-suppresses, and the later runId-matched end resolves nothing', async () => {
    const bus = new FakeBus()
    const key = collectorKey('parent-1', 'call-p1')
    const done = collectFirstEpoch({
      bus,
      childId: 'c-p1',
      agent,
      signal: freshSignal(),
      parentSessionId: 'parent-1',
      toolCallToken: 'call-p1',
      start: async () => {},
    })
    bus.emit('subagent/start', { runId: 'rp1', provider: 'spawn', id: 'c-p1', local: true })
    expect(isCollectedForSuppression('c-p1')).toBe(true)
    collectorFor(key)!.promote()
    await expect(done).resolves.toEqual({ kind: 'promoted' })
    expect(collectorFor(key)).toBeUndefined()
    // The promoted child's settlement notice is NOT suppressed: exactly-once
    // delivery by construction.
    expect(isCollectedForSuppression('c-p1')).toBe(false)
    expect(epochWatchSize()).toBe(0)
    // The later runId-matched end (the real terminal) resolves nothing.
    bus.emit('subagent/end', { runId: 'rp1', provider: 'spawn', id: 'c-p1', local: true, stopReason: 'completed' })
    expect(collectorsForSession('parent-1')).toEqual([])
  })

  it('promote-before-acceptance: a promote during in-flight start resolves as soon as start resolves', async () => {
    const bus = new FakeBus()
    let releaseStart!: () => void
    const gate = new Promise<void>(resolve => { releaseStart = resolve })
    const key = collectorKey('parent-1', 'call-pa')
    const done = collectFirstEpoch({
      bus,
      childId: 'c-pa',
      agent,
      signal: freshSignal(),
      parentSessionId: 'parent-1',
      toolCallToken: 'call-pa',
      start: async () => { await gate },
    })
    // Registered BEFORE start (reserve-before-start): Ctrl+B finds the armed
    // handle even while startContinuable is still in flight.
    const handle = collectorFor(key)
    expect(handle).toBeDefined()
    handle!.promote()
    releaseStart()
    await expect(done).resolves.toEqual({ kind: 'promoted' })
    // No end event was needed, and the watch was already released.
    expect(epochWatchSize()).toBe(0)
    expect(collectorFor(key)).toBeUndefined()
  })

  it('abort-wins: the aborted outcome unregisters; a post-abort promote is a no-op and never un-suppresses', async () => {
    const bus = new FakeBus()
    const ac = new AbortController()
    const key = collectorKey('parent-1', 'call-a1')
    const done = collectFirstEpoch({
      bus,
      childId: 'c-a1',
      agent,
      signal: ac.signal,
      subagents: {},
      parentSessionId: 'parent-1',
      toolCallToken: 'call-a1',
      start: async () => {},
    })
    ac.abort()
    await expect(done).resolves.toEqual({ kind: 'aborted', stopReason: 'aborted' })
    expect(collectorFor(key)).toBeUndefined()
    // A stale handle promote after abort is inert: the child stays suppressed
    // (the aborted epoch's real terminal notice is still dropped).
    collectorFor(key)?.promote()
    expect(isCollectedForSuppression('c-a1')).toBe(true)
  })

  it('promote-then-abort: after promotion the collect is settled — abort is a no-op (child keeps running)', async () => {
    const bus = new FakeBus()
    const ac = new AbortController()
    const key = collectorKey('parent-1', 'call-p2')
    const done = collectFirstEpoch({
      bus,
      childId: 'c-p2',
      agent,
      signal: ac.signal,
      subagents: {},
      parentSessionId: 'parent-1',
      toolCallToken: 'call-p2',
      start: async () => {},
    })
    collectorFor(key)!.promote()
    await expect(done).resolves.toEqual({ kind: 'promoted' })
    ac.abort()
    expect(isCollectedForSuppression('c-p2')).toBe(false)
  })

  it('repeated promote is idempotent: one resolution, one un-suppress, one unregister', async () => {
    const bus = new FakeBus()
    const key = collectorKey('parent-1', 'call-rp')
    const done = collectFirstEpoch({
      bus,
      childId: 'c-rp',
      agent,
      signal: freshSignal(),
      parentSessionId: 'parent-1',
      toolCallToken: 'call-rp',
      start: async () => {},
    })
    const handle = collectorFor(key)!
    handle.promote()
    expect(() => handle.promote()).not.toThrow()
    await expect(done).resolves.toEqual({ kind: 'promoted' })
    expect(isCollectedForSuppression('c-rp')).toBe(false)
    expect(collectorFor(key)).toBeUndefined()
  })

  it('collectorsForSession returns exactly the armed collects of that session; other sessions unaffected', async () => {
    const bus = new FakeBus()
    const other = collectFirstEpoch({
      bus,
      childId: 'c-other',
      agent,
      signal: freshSignal(),
      parentSessionId: 'parent-2',
      toolCallToken: 'call-o',
      start: async () => {},
    })
    const mine = collectFirstEpoch({
      bus,
      childId: 'c-mine',
      agent,
      signal: freshSignal(),
      parentSessionId: 'parent-1',
      toolCallToken: 'call-m',
      start: async () => {},
    })
    expect(collectorsForSession('parent-1').map(h => h.childId)).toEqual(['c-mine'])
    expect(collectorsForSession('parent-2').map(h => h.childId)).toEqual(['c-other'])
    collectorFor(collectorKey('parent-1', 'call-m'))!.promote()
    await mine
    expect(collectorsForSession('parent-1')).toEqual([])
    expect(collectorsForSession('parent-2').map(h => h.childId)).toEqual(['c-other'])
    bus.emit('subagent/start', { runId: 'ro', provider: 'spawn', id: 'c-other', local: true })
    bus.emit('subagent/end', { runId: 'ro', provider: 'spawn', id: 'c-other', local: true, stopReason: 'completed' })
    await other
    expect(collectorsForSession('parent-2')).toEqual([])
  })
})
