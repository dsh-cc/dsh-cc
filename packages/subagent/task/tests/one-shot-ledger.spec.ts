/**
 * Tests for the one-shot subagent ledger (memory-recall hardening follow-ups
 * W2a): shared `subagent/start` / `subagent/end` listeners, runId pairing
 * (never child id — a cold-resumed child gets a new runId), header-based
 * parentage resolution, internal classification with the label completeness
 * gate, and TTL pruning for ended AND active rows.
 */
import { describe, expect, it } from 'vitest'
import {
  INTERNAL_LABELS,
  createOneShotLedger,
  type OneShotLedgerRow,
} from '../src/one-shot-ledger.ts'

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

/** Duck-typed `ctx.agents` whose child sessions carry descriptor events. */
function fakeAgents(children: Record<string, {
  parentSession?: string
  descriptorLabel?: string
  descriptorMode?: string
}>) {
  return {
    get(id: string) {
      const child = children[id]
      if (child === undefined) return undefined
      return {
        session: {
          header: { ...child.parentSession !== undefined ? { parentSession: child.parentSession } : {} },
          events: child.descriptorLabel === undefined
            ? []
            : [{
              type: 'subagent/descriptor',
              data: {
                mode: child.descriptorMode ?? 'one-shot',
                ...child.descriptorLabel !== undefined ? { label: child.descriptorLabel } : {},
              },
            }],
        },
      }
    },
  }
}

describe('one-shot ledger', () => {
  it('case 1: pairs end to start by runId and ignores a later cold-resume end of the same child id', () => {
    const bus = new FakeBus()
    const ledger = createOneShotLedger({ bus, now: () => 1000 })
    bus.emit('subagent/start', { runId: 'r1', id: 'c1', provider: 'fork' })
    // The child cold-resumes: a new runId for the same child id.
    bus.emit('subagent/start', { runId: 'r2', id: 'c1', provider: 'fork' })
    bus.emit('subagent/end', { runId: 'r2', id: 'c1', provider: 'fork', stopReason: 'completed' })
    const rows = ledger.rows()
    // r1 (stale epoch) is still active; r2 ended. Pairing was by runId, not id.
    expect(rows).toHaveLength(2)
    const r1 = rows.find(row => row.runId === 'r1')
    const r2 = rows.find(row => row.runId === 'r2')
    expect(r1?.endedAt).toBeUndefined()
    expect(r2?.endedAt).toBe(1000)
    expect(r2?.stopReason).toBe('completed')
    ledger.dispose()
  })

  it('case 2: an end with an unknown runId is a no-op', () => {
    const bus = new FakeBus()
    const ledger = createOneShotLedger({ bus, now: () => 1000 })
    bus.emit('subagent/end', { runId: 'ghost', id: 'c1', provider: 'fork', stopReason: 'completed' })
    expect(ledger.rows()).toHaveLength(0)
    ledger.dispose()
  })

  it('case 3: resolves parentId from the child session header, unresolvable stays undefined', () => {
    const bus = new FakeBus()
    const agents = fakeAgents({
      c1: { parentSession: 'p1' },
      c2: {},
    })
    const ledger = createOneShotLedger({ bus, agents, now: () => 1000 })
    bus.emit('subagent/start', { runId: 'r1', id: 'c1', provider: 'fork' })
    bus.emit('subagent/start', { runId: 'r2', id: 'c2', provider: 'fork' })
    // No agents accessor at all: also unresolvable.
    bus.emit('subagent/start', { runId: 'r3', id: 'c3', provider: 'fork' })
    const rows = ledger.rows()
    expect(rows.find(row => row.runId === 'r1')?.parentId).toBe('p1')
    expect(rows.find(row => row.runId === 'r2')?.parentId).toBeUndefined()
    expect(rows.find(row => row.runId === 'r3')?.parentId).toBeUndefined()
    ledger.dispose()
  })

  it('case 4: classifies internal children from the descriptor label, falling back to provider metadata absence', () => {
    const bus = new FakeBus()
    const agents = fakeAgents({
      infra: { parentSession: 'p1', descriptorLabel: 'memory-recall' },
      rogue: { parentSession: 'p1', descriptorLabel: 'rogue-task' },
      opaque: { parentSession: 'p1' },
    })
    const ledger = createOneShotLedger({ bus, agents, now: () => 1000 })
    bus.emit('subagent/start', { runId: 'r1', id: 'infra', provider: 'fork' })
    bus.emit('subagent/start', { runId: 'r2', id: 'rogue', provider: 'fork' })
    bus.emit('subagent/start', { runId: 'r3', id: 'opaque', provider: 'fork' })
    const rows = ledger.rows()
    expect(rows.find(row => row.runId === 'r1')?.internal).toBe(true)
    expect(rows.find(row => row.runId === 'r2')?.internal).toBe(false)
    // Without descriptor metadata the label list is the only signal: not internal.
    expect(rows.find(row => row.runId === 'r3')?.internal).toBe(false)
    ledger.dispose()
  })

  it('case 5: the INTERNAL_LABELS list contains every known production label (completeness gate)', () => {
    expect(INTERNAL_LABELS).toContain('memory-recall')
    expect(INTERNAL_LABELS).toContain('extract-memories')
    expect(INTERNAL_LABELS).toContain('memory-consolidation')
    expect(INTERNAL_LABELS).toContain('hook-prompt')
    expect(INTERNAL_LABELS).toContain('hook-agent')
  })

  it('case 6: ended rows prune after the TTL; active rows age out too', () => {
    let now = 1000
    const bus = new FakeBus()
    const ledger = createOneShotLedger({ bus, now: () => now, endedTtlMs: 500, activeTtlMs: 5000 })
    bus.emit('subagent/start', { runId: 'r1', id: 'c1', provider: 'fork' })
    now = 1100
    bus.emit('subagent/end', { runId: 'r1', id: 'c1', provider: 'fork', stopReason: 'completed' })
    bus.emit('subagent/start', { runId: 'r2', id: 'c2', provider: 'fork' }) // active, started at 1100
    expect(ledger.rows()).toHaveLength(2)
    now = 1500 // 400ms after r1 ended: still inside the TTL
    expect(ledger.rows()).toHaveLength(2)
    now = 1700 // 600ms after r1 ended: pruned; r2 active for 600ms: kept
    expect(ledger.rows().map(row => row.runId)).toEqual(['r2'])
    now = 6200 // r2 has been active 5100ms: aged out
    expect(ledger.rows()).toHaveLength(0)
    ledger.dispose()
  })

  it('case 7: an end arriving after its row was pruned is a no-op', () => {
    let now = 1000
    const bus = new FakeBus()
    const ledger = createOneShotLedger({ bus, now: () => now, endedTtlMs: 500, activeTtlMs: 5000 })
    bus.emit('subagent/start', { runId: 'r1', id: 'c1', provider: 'fork' })
    now = 9000 // past the active TTL: row aged out
    expect(ledger.rows()).toHaveLength(0)
    bus.emit('subagent/end', { runId: 'r1', id: 'c1', provider: 'fork', stopReason: 'completed' })
    expect(ledger.rows()).toHaveLength(0)
    ledger.dispose()
  })

  it('case 8: activeFor returns only active rows of one parent', () => {
    const bus = new FakeBus()
    const agents = fakeAgents({
      c1: { parentSession: 'p1' },
      c2: { parentSession: 'p1' },
      c3: { parentSession: 'p2' },
    })
    const ledger = createOneShotLedger({ bus, agents, now: () => 1000 })
    bus.emit('subagent/start', { runId: 'r1', id: 'c1', provider: 'fork' })
    bus.emit('subagent/start', { runId: 'r2', id: 'c2', provider: 'fork' })
    bus.emit('subagent/start', { runId: 'r3', id: 'c3', provider: 'fork' })
    bus.emit('subagent/end', { runId: 'r2', id: 'c2', provider: 'fork', stopReason: 'completed' })
    expect(ledger.activeFor('p1').map(row => row.runId)).toEqual(['r1'])
    expect(ledger.activeFor('p2').map(row => row.runId)).toEqual(['r3'])
    expect(ledger.activeFor('nobody')).toEqual([])
    ledger.dispose()
  })

  it('case 9: rows carry the run metadata snapshot', () => {
    const bus = new FakeBus()
    const agents = fakeAgents({ c1: { parentSession: 'p1', descriptorLabel: 'rogue-task', descriptorMode: 'one-shot' } })
    const ledger = createOneShotLedger({ bus, agents, now: () => 42 })
    bus.emit('subagent/start', { runId: 'r1', id: 'c1', provider: 'spawn' })
    bus.emit('subagent/end', { runId: 'r1', id: 'c1', provider: 'spawn', stopReason: 'aborted' })
    const row: OneShotLedgerRow | undefined = ledger.rows()[0]
    expect(row).toMatchObject({
      runId: 'r1', id: 'c1', provider: 'spawn', label: 'rogue-task',
      parentId: 'p1', startedAt: 42, endedAt: 42, stopReason: 'aborted',
      internal: false, mode: 'one-shot',
    })
    ledger.dispose()
  })
})
