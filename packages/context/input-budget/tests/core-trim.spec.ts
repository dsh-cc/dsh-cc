/**
 * Budget model (plan §"Budget model (per enter batch)"): FIFO-oldest trimming
 * per class, the two independent trimmable budgets, the enter budget as a last
 * resort, `hardOver` when protected content alone blows the enter budget, and
 * the Lean-mirrored arithmetic (`fits`, `oversize`, `available`).
 */

import { describe, expect, it } from 'vitest'
import {
  available,
  fits,
  govern,
  messageBytes,
  oversize,
  type GovernedMessage,
} from '../src/index.ts'
import { messageOf, settingsOf, sizesOf } from './rig.ts'

describe('budget arithmetic (Lean Formal.fits / oversize)', () => {
  it('matches the bridge cases the Lean and TLA models share', () => {
    // Bridge_admit_exact_advisory_0 / Bridge_admit_over_advisory_1
    expect(fits(4, 0, 4)).toBe(true)
    expect(fits(4, 1, 4)).toBe(false)
    // Bridge_oversize_above_4 / Bridge_oversize_at_4
    expect(oversize(4, 5)).toBe(true)
    expect(oversize(4, 4)).toBe(false)
  })

  it('saturates the remaining room instead of going negative', () => {
    expect(available(4, 0)).toBe(4)
    expect(available(4, 4)).toBe(0)
    expect(available(4, 10)).toBe(0)
  })
})

describe('byte measurement', () => {
  it('counts text blocks as UTF-8 bytes and nothing else', () => {
    const mixed: GovernedMessage = {
      content: [
        { type: 'text', text: 'abc' },
        { type: 'tool_result' },
        { type: 'text', text: 'é' },
      ],
    }
    // 'abc' = 3, 'é' (U+00E9) = 2.
    expect(messageBytes(mixed)).toBe(5)
    expect(messageBytes({ content: 'plain string' })).toBe(0)
    expect(messageBytes({ content: [] })).toBe(0)
    expect(messageBytes(undefined)).toBe(0)
  })
})

describe('class-budget trim (FIFO-oldest, per class)', () => {
  it('trims the oldest advisory messages until the class is within budget', () => {
    const result = govern({
      messages: [messageOf('advisor', 500), messageOf('advisor', 300), messageOf('advisor', 250)],
      settings: settingsOf({ 'advisory-budget-bytes': 1000 }),
    })
    expect(sizesOf(result.messages)).toEqual([300, 250])
    expect(result.decision.trimmed).toEqual([{ kind: 'advisor', bytes: 500, action: 'defer' }])
    expect(result.decision.hardOver).toBe(false)
  })

  it('trims memory first, then advisory — the budget-model step order', () => {
    const result = govern({
      messages: [
        messageOf('memory', 800),
        messageOf('memory', 800),
        messageOf('advisor', 300),
        messageOf('advisor', 300),
      ],
      settings: settingsOf({ 'memory-budget-bytes': 1024, 'advisory-budget-bytes': 512 }),
    })
    expect(result.decision.trimmed).toEqual([
      { kind: 'memory', bytes: 800, action: 'defer' },
      { kind: 'advisor', bytes: 300, action: 'defer' },
    ])
    expect(sizesOf(result.messages)).toEqual([800, 300])
  })

  it('never trims governance, task or passthrough content', () => {
    const result = govern({
      messages: [
        messageOf('turn-rules', 2000),
        messageOf('user', 2000),
        messageOf('cc-shell-glue', 2000),
        messageOf('some-future-producer', 2000),
      ],
      settings: settingsOf({ 'enter-budget-bytes': 4096, 'advisory-budget-bytes': 512 }),
    })
    expect(result.messages).toHaveLength(4)
    expect(result.decision.trimmed).toEqual([])
    expect(result.decision.hardOver).toBe(true)
  })
})

describe('memory and advisory budgets are separate', () => {
  it('does not judge a 12 KiB memory entry against the advisory limit', () => {
    const result = govern({
      messages: [messageOf('memory', 12_288)],
      settings: settingsOf({ 'advisory-budget-bytes': 512 }),
    })
    expect(sizesOf(result.messages)).toEqual([12_288])
    expect(result.decision.trimmed).toEqual([])
    expect(result.decision.bytesByClass.memory).toBe(12_288)
    expect(result.decision.bytesByClass.advisory).toBe(0)
  })

  it('drops an advisory message that alone exceeds the advisory budget', () => {
    const result = govern({
      messages: [messageOf('advisor', 12_288)],
      settings: settingsOf({ 'advisory-budget-bytes': 8192 }),
    })
    expect(result.messages).toEqual([])
    expect(result.decision.trimmed).toEqual([
      { kind: 'advisor', bytes: 12_288, action: 'drop-oversize' },
    ])
    // Oversize messages are never enqueued, in either mode.
    expect(result.backlog).toEqual([])
  })

  it('trims only the memory class when memory alone is over budget', () => {
    const result = govern({
      messages: [messageOf('memory', 12_288), messageOf('memory', 12_288)],
      settings: settingsOf({ 'memory-budget-bytes': 16_384 }),
    })
    expect(sizesOf(result.messages)).toEqual([12_288])
    expect(result.decision.trimmed).toEqual([{ kind: 'memory', bytes: 12_288, action: 'defer' }])
    expect(result.backlog).toHaveLength(1)
    expect(result.backlog[0]?.enqueuedAtSeq).toBe(1)
  })
})

describe('enter budget', () => {
  it('trims advisory before memory when the batch total is over budget', () => {
    const result = govern({
      messages: [messageOf('user', 3000), messageOf('advisor', 900), messageOf('memory', 800)],
      settings: settingsOf({ 'enter-budget-bytes': 4096 }),
    })
    expect(sizesOf(result.messages)).toEqual([3000, 800])
    expect(result.decision.trimmed).toEqual([{ kind: 'advisor', bytes: 900, action: 'defer' }])
    expect(result.decision.hardOver).toBe(false)
  })

  it('admits everything and flags hardOver when the budget cannot be met', () => {
    const result = govern({
      messages: [messageOf('user', 9000), messageOf('advisor', 1000)],
      settings: settingsOf({ 'enter-budget-bytes': 4096 }),
    })
    // Protected content alone exceeds the enter budget: nothing more is trimmed,
    // the trimmable advisory message is admitted rather than half-dropped.
    expect(sizesOf(result.messages)).toEqual([9000, 1000])
    expect(result.decision.trimmed).toEqual([])
    expect(result.decision.hardOver).toBe(true)
  })

  it('trims nothing from protected classes even under hard overflow', () => {
    const result = govern({
      messages: [
        messageOf('agent-instructions', 5000),
        messageOf('user', 4000),
        messageOf('passthrough-kind', 3000),
      ],
      settings: settingsOf({ 'enter-budget-bytes': 4096 }),
    })
    expect(result.messages).toHaveLength(3)
    expect(result.decision.hardOver).toBe(true)
    expect(result.decision.trimmed).toEqual([])
  })
})

describe('oversize never fits', () => {
  it('admits a message that exactly fills its class budget', () => {
    const result = govern({
      messages: [messageOf('advisor', 8192)],
      settings: settingsOf({ 'advisory-budget-bytes': 8192 }),
    })
    expect(sizesOf(result.messages)).toEqual([8192])
    expect(result.decision.trimmed).toEqual([])
  })

  it('drops a message one byte over its class budget instead of deferring it', () => {
    const result = govern({
      messages: [messageOf('advisor', 8193)],
      settings: settingsOf({ 'advisory-budget-bytes': 8192 }),
    })
    expect(result.messages).toEqual([])
    expect(result.decision.trimmed).toEqual([
      { kind: 'advisor', bytes: 8193, action: 'drop-oversize' },
    ])
    expect(result.backlog).toEqual([])
  })
})

describe('row fields', () => {
  it('reports all five class keys in table order over the decision batch', () => {
    const result = govern({
      messages: [messageOf('user', 100), messageOf('turn-rules', 200), messageOf('tool-registry', 300)],
      settings: settingsOf(),
    })
    expect(Object.keys(result.decision.bytesByClass)).toEqual([
      'governance',
      'task',
      'memory',
      'advisory',
      'passthrough',
    ])
    expect(result.decision.bytesByClass).toEqual({
      governance: 200,
      task: 100,
      memory: 0,
      advisory: 0,
      passthrough: 300,
    })
    expect(result.decision.offeredBacklog).toBe(0)
    expect(result.decision.mode).toBe('enforce')
  })

  it('counts the decision batch, not the incoming batch', () => {
    const result = govern({
      messages: [messageOf('advisor', 500), messageOf('advisor', 300)],
      settings: settingsOf({ 'advisory-budget-bytes': 400 }),
    })
    expect(result.decision.bytesByClass.advisory).toBe(300)
    expect(result.decision.trimmed).toHaveLength(1)
  })
})
