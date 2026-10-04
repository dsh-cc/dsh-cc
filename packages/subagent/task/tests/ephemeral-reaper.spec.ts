/**
 * Tests for the §3.4 ephemeral TTL reaper: kill identity (per-run
 * AbortController, never a child id), the bounded 10s observe wait, the
 * interrupt authority-handle signature, the ledger-as-kill-log membership
 * predicate, and the pinned foreground failure copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  armEphemeralTtl,
  EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS,
  EPHEMERAL_TTL_KILL_COPY,
  EPHEMERAL_TTL_MS_DEFAULT,
  EPHEMERAL_TTL_TIMEOUT_STOP_REASON,
  type EphemeralReaperLedger,
} from '../src/ephemeral-reaper.ts'
import type { OneShotLedgerRow } from '../src/one-shot-ledger.ts'

const AGENT = { session: { id: 'parent-1' } } as unknown as Agent

function row(overrides: Partial<OneShotLedgerRow> = {}): OneShotLedgerRow {
  return {
    runId: 'r1',
    id: 'child-1',
    provider: 'spawn',
    label: 'scout',
    parentId: 'parent-1',
    startedAt: Date.now(),
    internal: false,
    ...overrides,
  }
}

/** A mutable in-memory ledger fake (the kill-log surface the reaper uses). */
function fakeLedger(rows: OneShotLedgerRow[]): {
  ledger: EphemeralReaperLedger
  marks: { runId: string; stopReason: string }[]
} {
  const marks: { runId: string; stopReason: string }[] = []
  return {
    ledger: {
      rows: () => rows,
      markTimedOut: (runId, stopReason) => marks.push({ runId, stopReason }),
    },
    marks,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ephemeral TTL reaper (§3.4)', () => {
  it('defaults to the 15-minute TTL and the 10s bounded wait', () => {
    expect(EPHEMERAL_TTL_MS_DEFAULT).toBe(900_000)
    expect(EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS).toBe(10_000)
  })

  it('pins the foreground TTL-kill copy exactly', () => {
    expect(EPHEMERAL_TTL_KILL_COPY).toBe('ephemeral child hit its TTL; re-spawn it')
  })

  it('on expiry aborts the per-run controller and interrupts with the {kind:ancestor, agent} authority', async () => {
    const { ledger, marks } = fakeLedger([row()])
    const controller = new AbortController()
    const interrupts: unknown[] = []
    armEphemeralTtl({
      ttlMs: 1000,
      controller,
      agent: AGENT,
      parentSessionId: 'parent-1',
      label: 'scout',
      ledger,
      interrupt: { interrupt: (childId, authority) => interrupts.push([childId, authority]) },
    })
    expect(controller.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(controller.signal.aborted).toBe(true)
    expect(interrupts).toEqual([['child-1', { kind: 'ancestor', agent: AGENT }]])
    // No `subagent/end` within the 10s bound → the zombie row is marked.
    await vi.advanceTimersByTimeAsync(EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS)
    expect(marks).toEqual([{ runId: 'r1', stopReason: EPHEMERAL_TTL_TIMEOUT_STOP_REASON }])
  })

  it('a `subagent/end` inside the 10s bound records the real stop reason and skips the mark', async () => {
    const rowObj = row()
    const { ledger, marks } = fakeLedger([rowObj])
    const controller = new AbortController()
    armEphemeralTtl({ ttlMs: 1000, controller, agent: AGENT, parentSessionId: 'parent-1', label: 'scout', ledger })
    await vi.advanceTimersByTimeAsync(1000)
    // The child settles 2s after the kill, well inside the bound.
    await vi.advanceTimersByTimeAsync(2000)
    rowObj.endedAt = Date.now()
    rowObj.stopReason = 'aborted'
    await vi.advanceTimersByTimeAsync(EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS)
    expect(marks).toEqual([])
  })

  it('membership predicate: a labeled memory-recall row past TTL is left alone (kill log, never candidate set)', async () => {
    const pastTtl = row({
      runId: 'r-mem',
      id: 'mem-child',
      label: 'memory-recall',
      internal: true,
      // Started long before this dispatch armed — a stale row of another lane.
      startedAt: Date.now() - 900_000,
    })
    const { ledger, marks } = fakeLedger([pastTtl])
    const controller = new AbortController()
    const interrupts: string[] = []
    armEphemeralTtl({
      ttlMs: 1000,
      controller,
      agent: AGENT,
      parentSessionId: 'parent-1',
      label: 'scout',
      ledger,
      interrupt: { interrupt: childId => interrupts.push(childId) },
    })
    await vi.advanceTimersByTimeAsync(1000 + EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS)
    // The controller (the only kill identity) is aborted, but the foreign row
    // is never interrupted nor marked — no process-wide sweep.
    expect(controller.signal.aborted).toBe(true)
    expect(interrupts).toEqual([])
    expect(marks).toEqual([])
    expect(pastTtl.stopReason).toBeUndefined()
    expect(pastTtl.endedAt).toBeUndefined()
  })

  it('two same-shape candidate rows are ambiguous: abort-only, no interrupt, no mark', async () => {
    const { ledger, marks } = fakeLedger([
      row({ runId: 'r1', id: 'child-1' }),
      row({ runId: 'r2', id: 'child-2' }),
    ])
    const controller = new AbortController()
    const interrupts: string[] = []
    armEphemeralTtl({
      ttlMs: 1000,
      controller,
      agent: AGENT,
      parentSessionId: 'parent-1',
      label: 'scout',
      ledger,
      interrupt: { interrupt: childId => interrupts.push(childId) },
    })
    await vi.advanceTimersByTimeAsync(1000 + EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS)
    expect(controller.signal.aborted).toBe(true)
    expect(interrupts).toEqual([])
    expect(marks).toEqual([])
  })

  it('rows started before the arm point are never candidates (fresh-dispatch arm only)', async () => {
    const stale = row({ runId: 'r-old', id: 'child-old', startedAt: Date.now() - 60_000 })
    const { ledger, marks } = fakeLedger([stale])
    const interrupts: string[] = []
    const controller = new AbortController()
    armEphemeralTtl({
      ttlMs: 1000,
      controller,
      agent: AGENT,
      parentSessionId: 'parent-1',
      label: 'scout',
      ledger,
      interrupt: { interrupt: childId => interrupts.push(childId) },
    })
    await vi.advanceTimersByTimeAsync(1000 + EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS)
    expect(interrupts).toEqual([])
    expect(marks).toEqual([])
  })

  it('a fire-callback failure is logged and never rethrown (timer hygiene)', async () => {
    const warns: string[] = []
    const controller = new AbortController()
    armEphemeralTtl({
      ttlMs: 1000,
      controller,
      agent: AGENT,
      parentSessionId: 'parent-1',
      warn: message => warns.push(message),
      ledger: { rows: () => { throw new Error('boom') }, markTimedOut: () => {} },
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(warns[0]).toContain('ephemeral TTL reaper fire failed')
    expect(controller.signal.aborted).toBe(true)
  })

  it('an interrupt admission throw degrades to the bounded wait + mark', async () => {
    const { ledger, marks } = fakeLedger([row()])
    const controller = new AbortController()
    armEphemeralTtl({
      ttlMs: 1000,
      controller,
      agent: AGENT,
      parentSessionId: 'parent-1',
      label: 'scout',
      ledger,
      interrupt: { interrupt: () => { throw new Error('admission refused') } },
      warn: () => {},
    })
    await vi.advanceTimersByTimeAsync(1000 + EPHEMERAL_KILL_OBSERVE_TIMEOUT_MS)
    expect(marks).toEqual([{ runId: 'r1', stopReason: EPHEMERAL_TTL_TIMEOUT_STOP_REASON }])
  })
})
