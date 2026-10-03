/**
 * Tests for the shared ref-counted lifecycle fan-out (`subagent-watchers.ts`):
 * one underlying `on` attach per bus while any subscriber remains, exact
 * detach-on-last-release, fresh re-attach after full detach, reentrancy-safe
 * dispatch, and idempotent release.
 */
import { describe, expect, it } from 'vitest'
import { subscribeLifecycle } from '../src/subagent-watchers.ts'

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

  liveCount(event: string): number {
    return (this.listeners.get(event) ?? []).filter(r => !r.disposed).length
  }
}

describe('subscribeLifecycle', () => {
  it('attaches exactly one on-pair while any subscriber remains, detaching once on the last release', () => {
    const bus = new FakeBus()
    const r1 = subscribeLifecycle(bus, { onStart: () => {}, onEnd: () => {} })
    const r2 = subscribeLifecycle(bus, { onStart: () => {}, onEnd: () => {} })
    expect(bus.liveCount('subagent/start')).toBe(1)
    expect(bus.liveCount('subagent/end')).toBe(1)
    expect(bus.disposeCount).toBe(0)
    r1()
    expect(bus.liveCount('subagent/start')).toBe(1)
    expect(bus.disposeCount).toBe(0)
    r2()
    expect(bus.liveCount('subagent/start')).toBe(0)
    expect(bus.liveCount('subagent/end')).toBe(0)
    expect(bus.disposeCount).toBe(2)
  })

  it('re-attaches a fresh pair after a full detach (WeakMap entry cleared)', () => {
    const bus = new FakeBus()
    const release = subscribeLifecycle(bus, { onStart: () => {}, onEnd: () => {} })
    release()
    const before = bus.disposeCount
    subscribeLifecycle(bus, { onStart: () => {}, onEnd: () => {} })
    // A stale entry was never reused: the new subscribe attached again.
    expect(bus.liveCount('subagent/start')).toBe(1)
    expect(bus.disposeCount).toBe(before)
  })

  it('a subscriber releasing synchronously inside its own onStart does not skip the other subscriber', () => {
    const bus = new FakeBus()
    const seenB: string[] = []
    let r1: () => void
    r1 = subscribeLifecycle(bus, {
      onStart: () => r1(),
      onEnd: () => {},
    })
    const r2 = subscribeLifecycle(bus, {
      onStart: p => seenB.push(String(p.id)),
      onEnd: () => {},
    })
    bus.emit('subagent/start', { id: 'child-1' })
    expect(seenB).toEqual(['child-1'])
    expect(bus.liveCount('subagent/start')).toBe(1) // r2 still attached
    r2()
  })

  it('double release is a no-op (underlying pair disposed exactly once)', () => {
    const bus = new FakeBus()
    const release = subscribeLifecycle(bus, { onStart: () => {}, onEnd: () => {} })
    release()
    expect(bus.disposeCount).toBe(2)
    release()
    expect(bus.disposeCount).toBe(2)
    expect(bus.liveCount('subagent/start')).toBe(0)
  })
})
