/**
 * Observe mode (plan §"Observe mode (r1 fold: isolated shadow state)"): the same
 * fresh-batch computation and the same row fields as enforce, but the batch is
 * returned untouched, no defer queue exists, no `drop-expired` rows appear, and
 * the observe→enforce flip starts from an empty queue.
 */

import { describe, expect, it } from 'vitest'
import { govern, type GovernedMessage, type GovernorSettings } from '../src/index.ts'
import { messageOf, settingsOf, sizesOf } from './rig.ts'

describe('observe mode changes nothing', () => {
  it('returns the incoming batch in arrival order and no backlog', () => {
    const messages = [messageOf('advisor', 900), messageOf('user', 100), messageOf('memory', 1200)]
    const result = govern({
      messages,
      settings: settingsOf({ mode: 'observe', 'advisory-budget-bytes': 512 }),
    })
    expect(result.messages).toEqual(messages)
    expect(sizesOf(result.messages)).toEqual([900, 100, 1200])
    expect(result.backlog).toEqual([])
    expect(result.decision.offeredBacklog).toBe(0)
    expect(result.decision.mode).toBe('observe')
  })

  it('records the decisions it would have taken in the shared trimmed array', () => {
    const result = govern({
      messages: [messageOf('advisor', 600), messageOf('advisor', 300)],
      settings: settingsOf({ mode: 'observe', 'advisory-budget-bytes': 800 }),
    })
    expect(result.messages).toHaveLength(2)
    expect(result.decision.trimmed).toEqual([{ kind: 'advisor', bytes: 600, action: 'defer' }])
  })

  it('can still record drop-oversize — it is a fresh-batch computation', () => {
    const result = govern({
      messages: [messageOf('advisor', 9000)],
      settings: settingsOf({ mode: 'observe', 'advisory-budget-bytes': 8192 }),
    })
    expect(result.decision.trimmed).toEqual([
      { kind: 'advisor', bytes: 9000, action: 'drop-oversize' },
    ])
  })

  it('emits no drop-expired rows and ignores any backlog handed to it', () => {
    const result = govern({
      messages: [messageOf('advisor', 600)],
      settings: settingsOf({ mode: 'observe', 'advisory-budget-bytes': 800, 'defer-ttl-steps': 1 }),
      backlog: [{ message: messageOf('advisor', 600), enqueuedAtSeq: 1, lastOfferedSeq: 1 }],
      gateSeq: 9,
    })
    expect(result.decision.trimmed).toEqual([])
    expect(result.messages).toHaveLength(1)
    expect(result.backlog).toEqual([])
    expect(result.decision.offeredBacklog).toBe(0)
  })
})

describe('observe/enforce row parity for fresh-batch fields', () => {
  const cases: { name: string; messages: GovernedMessage[]; settings: Partial<GovernorSettings> }[] = [
    {
      name: 'a plain trim',
      messages: [messageOf('advisor', 600), messageOf('advisor', 300)],
      settings: { 'advisory-budget-bytes': 800 },
    },
    {
      name: 'an oversize drop',
      messages: [messageOf('advisor', 9000), messageOf('memory', 500)],
      settings: { 'advisory-budget-bytes': 8192 },
    },
    {
      name: 'an enter-budget trim',
      messages: [messageOf('user', 3000), messageOf('advisor', 900)],
      settings: { 'enter-budget-bytes': 3200 },
    },
    {
      name: 'a hard overflow',
      messages: [messageOf('user', 9000), messageOf('advisor', 1000)],
      settings: { 'enter-budget-bytes': 4096 },
    },
  ]

  for (const item of cases) {
    it(`matches enforce for ${item.name}`, () => {
      const observed = govern({ messages: item.messages, settings: settingsOf({ ...item.settings, mode: 'observe' }) })
      const enforced = govern({ messages: item.messages, settings: settingsOf({ ...item.settings, mode: 'enforce' }) })
      expect(observed.decision.bytesByClass).toEqual(enforced.decision.bytesByClass)
      expect(observed.decision.trimmed).toEqual(enforced.decision.trimmed)
      expect(observed.decision.hardOver).toBe(enforced.decision.hardOver)
      expect(observed.decision.mode).toBe('observe')
      expect(enforced.decision.mode).toBe('enforce')
    })
  }
})

describe('flip boundary', () => {
  it('an observe result leaves an empty queue, so enforce starts empty after a flip', () => {
    const observed = govern({
      messages: [messageOf('advisor', 600), messageOf('advisor', 300)],
      settings: settingsOf({ mode: 'observe', 'advisory-budget-bytes': 800 }),
    })
    // The observe decision deferred one message, but nothing was actually queued.
    expect(observed.decision.trimmed).toHaveLength(1)
    expect(observed.backlog).toEqual([])

    const enforced = govern({
      messages: [],
      settings: settingsOf({ 'advisory-budget-bytes': 800 }),
      backlog: observed.backlog,
      gateSeq: observed.gateSeq,
    })
    expect(enforced.decision.offeredBacklog).toBe(0)
    expect(enforced.messages).toEqual([])
  })

  it('the gateSeq clock keeps advancing across mode changes', () => {
    const first = govern({ messages: [messageOf('user', 10)], settings: settingsOf({ mode: 'observe' }) })
    const second = govern({
      messages: [messageOf('user', 10)],
      settings: settingsOf({ mode: 'enforce' }),
      backlog: first.backlog,
      gateSeq: first.gateSeq,
    })
    const third = govern({
      messages: [messageOf('user', 10)],
      settings: settingsOf({ mode: 'observe' }),
      backlog: second.backlog,
      gateSeq: second.gateSeq,
    })
    expect([first.gateSeq, second.gateSeq, third.gateSeq]).toEqual([1, 2, 3])
  })
})
