/**
 * Defer queue (plan §"Defer queue (deterministic algorithm)"): the three
 * ordered phases — age, backlog admission against each entry's own class
 * budget, fresh trim — plus the `gateSeq` bookkeeping each entry carries.
 */

import { describe, expect, it } from 'vitest'
import { govern, type DeferredEntry, type GovernedMessage } from '../src/index.ts'
import { messageOf, settingsOf, sizesOf } from './rig.ts'

/** One backlog entry, stamped with the gateSeq it was enqueued at. */
function entry(message: GovernedMessage, enqueuedAtSeq: number): DeferredEntry {
  return { message, enqueuedAtSeq, lastOfferedSeq: enqueuedAtSeq }
}

/** Sizes of a backlog's messages, in queue order. */
function backlogSizes(backlog: readonly DeferredEntry[]): number[] {
  return sizesOf(backlog.map((queued) => queued.message))
}

describe('fresh trims enqueue', () => {
  it('stamps a trimmed message with the gateSeq it was trimmed at', () => {
    const result = govern({
      messages: [messageOf('advisor', 600), messageOf('advisor', 300)],
      settings: settingsOf({ 'advisory-budget-bytes': 800 }),
    })
    expect(result.gateSeq).toBe(1)
    expect(sizesOf(result.messages)).toEqual([300])
    expect(backlogSizes(result.backlog)).toEqual([600])
    expect(result.backlog[0]).toEqual({
      message: expect.anything(),
      enqueuedAtSeq: 1,
      lastOfferedSeq: 1,
    })
  })

  it('continues the session clock from the supplied gateSeq', () => {
    const result = govern({
      messages: [messageOf('advisor', 600), messageOf('advisor', 300)],
      settings: settingsOf({ 'advisory-budget-bytes': 800 }),
      gateSeq: 7,
    })
    expect(result.gateSeq).toBe(8)
    expect(result.backlog[0]?.enqueuedAtSeq).toBe(8)
  })
})

describe('backlog admission', () => {
  it('admits a queued entry when its own class budget has room', () => {
    const result = govern({
      messages: [],
      settings: settingsOf({ 'advisory-budget-bytes': 800 }),
      backlog: [entry(messageOf('advisor', 600), 1)],
      gateSeq: 1,
    })
    expect(sizesOf(result.messages)).toEqual([600])
    expect(result.backlog).toEqual([])
    expect(result.decision.offeredBacklog).toBe(1)
    expect(result.decision.trimmed).toEqual([])
  })

  it('rejects the entry that does not fit and keeps it queued', () => {
    const result = govern({
      messages: [],
      settings: settingsOf({ 'advisory-budget-bytes': 800 }),
      backlog: [entry(messageOf('advisor', 600), 1), entry(messageOf('advisor', 600), 1)],
      gateSeq: 1,
    })
    expect(sizesOf(result.messages)).toEqual([600])
    expect(backlogSizes(result.backlog)).toEqual([600])
    expect(result.backlog[0]?.lastOfferedSeq).toBe(2)
    expect(result.backlog[0]?.enqueuedAtSeq).toBe(1)
    // Admission is at-most-once: the admitted entry left the queue.
    expect(result.backlog).toHaveLength(1)
  })

  it('judges a queued memory entry against the memory budget, not the advisory one', () => {
    const result = govern({
      messages: [],
      settings: settingsOf({ 'memory-budget-bytes': 1600, 'advisory-budget-bytes': 512 }),
      backlog: [entry(messageOf('memory', 1200), 1)],
      gateSeq: 1,
    })
    expect(sizesOf(result.messages)).toEqual([1200])
    expect(result.backlog).toEqual([])
  })

  it('counts admitted backlog bytes against the class budget before fresh trimming', () => {
    const result = govern({
      messages: [messageOf('advisor', 300)],
      settings: settingsOf({ 'advisory-budget-bytes': 800 }),
      backlog: [entry(messageOf('advisor', 600), 1)],
      gateSeq: 1,
    })
    // The admitted 600 leaves 200 of room, so the fresh 300 is trimmed.
    expect(sizesOf(result.messages)).toEqual([600])
    expect(result.decision.trimmed).toEqual([{ kind: 'advisor', bytes: 300, action: 'defer' }])
    expect(backlogSizes(result.backlog)).toEqual([300])
  })

  it('appends fresh trims behind the entries that stayed queued', () => {
    const result = govern({
      messages: [messageOf('advisor', 300)],
      settings: settingsOf({ 'advisory-budget-bytes': 800 }),
      backlog: [entry(messageOf('advisor', 600), 1), entry(messageOf('advisor', 600), 1)],
      gateSeq: 1,
    })
    expect(sizesOf(result.messages)).toEqual([600])
    expect(backlogSizes(result.backlog)).toEqual([600, 300])
    expect(result.backlog.map((queued) => queued.enqueuedAtSeq)).toEqual([1, 2])
    expect(result.backlog.map((queued) => queued.lastOfferedSeq)).toEqual([2, 2])
  })

  it('admits a settled batch in FIFO order and never reorders it', () => {
    const result = govern({
      messages: [messageOf('advisor', 300)],
      settings: settingsOf({ 'advisory-budget-bytes': 800 }),
      backlog: [entry(messageOf('advisor', 200), 1), entry(messageOf('advisor', 250), 1)],
      gateSeq: 1,
    })
    expect(sizesOf(result.messages)).toEqual([200, 250, 300])
    expect(result.backlog).toEqual([])
  })
})

describe('aging', () => {
  it('drops an entry whose age exceeds the TTL, and only past the boundary', () => {
    const settings = settingsOf({ 'advisory-budget-bytes': 800, 'defer-ttl-steps': 2 })
    const atBoundary = govern({
      messages: [],
      settings,
      backlog: [entry(messageOf('advisor', 600), 1)],
      gateSeq: 3,
    })
    // seq 4 - enqueued 1 = 3 > 2 -> expired.
    expect(atBoundary.decision.trimmed).toEqual([{ kind: 'advisor', bytes: 600, action: 'drop-expired' }])
    expect(atBoundary.messages).toEqual([])
    expect(atBoundary.backlog).toEqual([])

    const insideBoundary = govern({
      messages: [],
      settings,
      backlog: [entry(messageOf('advisor', 600), 1)],
      gateSeq: 2,
    })
    // seq 3 - enqueued 1 = 2, not greater than the TTL -> still admitted.
    expect(insideBoundary.decision.trimmed).toEqual([])
    expect(sizesOf(insideBoundary.messages)).toEqual([600])
  })

  it('ages before admitting, so an expired entry is never admitted', () => {
    const result = govern({
      messages: [],
      settings: settingsOf({ 'advisory-budget-bytes': 800, 'defer-ttl-steps': 1 }),
      backlog: [entry(messageOf('advisor', 600), 1)],
      gateSeq: 5,
    })
    expect(result.messages).toEqual([])
    expect(result.decision.trimmed).toEqual([{ kind: 'advisor', bytes: 600, action: 'drop-expired' }])
  })

  it('drops a queued entry that its class budget can no longer hold (hot budget shrink)', () => {
    const result = govern({
      messages: [],
      settings: settingsOf({ 'advisory-budget-bytes': 512 }),
      backlog: [entry(messageOf('advisor', 600), 1), entry(messageOf('advisor', 200), 1)],
      gateSeq: 1,
    })
    expect(result.decision.trimmed).toEqual([{ kind: 'advisor', bytes: 600, action: 'drop-oversize' }])
    expect(sizesOf(result.messages)).toEqual([200])
    expect(result.backlog).toEqual([])
  })
})

describe('the backlog walk in one invocation', () => {
  it('runs age, oversize, admission and rejection in that order', () => {
    const result = govern({
      messages: [],
      settings: settingsOf({ 'advisory-budget-bytes': 800, 'defer-ttl-steps': 2 }),
      backlog: [
        entry(messageOf('advisor', 600), 1),
        entry(messageOf('advisor', 900), 4),
        entry(messageOf('advisor', 600), 4),
        entry(messageOf('advisor', 400), 4),
      ],
      gateSeq: 4,
    })
    expect(result.decision.trimmed).toEqual([
      { kind: 'advisor', bytes: 600, action: 'drop-expired' },
      { kind: 'advisor', bytes: 900, action: 'drop-oversize' },
    ])
    expect(sizesOf(result.messages)).toEqual([600])
    expect(backlogSizes(result.backlog)).toEqual([400])
    expect(result.backlog[0]?.lastOfferedSeq).toBe(5)
    expect(result.decision.offeredBacklog).toBe(4)
    expect(result.gateSeq).toBe(5)
  })
})

describe('enter-budget trims join the defer queue', () => {
  it('enqueues the message the enter budget had to trim', () => {
    const result = govern({
      messages: [messageOf('user', 3000), messageOf('advisor', 900)],
      settings: settingsOf({ 'enter-budget-bytes': 3200 }),
      gateSeq: 3,
    })
    expect(result.decision.trimmed).toEqual([{ kind: 'advisor', bytes: 900, action: 'defer' }])
    expect(backlogSizes(result.backlog)).toEqual([900])
    expect(result.backlog[0]?.enqueuedAtSeq).toBe(4)
    expect(result.gateSeq).toBe(4)
  })
})
