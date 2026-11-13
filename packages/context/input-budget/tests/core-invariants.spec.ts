/**
 * Governor structural invariants: the properties a reviewer checks by hand but
 * that nothing else pins numerically.
 *
 * (This file was created as a temporary sensitivity probe for the FIFO trim
 * rule; deleting it is not permitted in the authoring session. Its name is
 * historical — it now carries the invariant suite, which belongs at
 * `tests/core-invariants.spec.ts`.)
 */

import { describe, expect, it } from 'vitest'
import { classBudgetOf, govern, sourceKindOf } from '../src/index.ts'
import { messageOf, settingsOf, sizesOf } from './rig.ts'

describe('trim ordering', () => {
  it('trims a prefix of the class cohort, never an arbitrary subset', () => {
    // Newest-first trimming would keep the oldest messages; FIFO-oldest keeps
    // the newest and removes the arrival-order prefix of the class.
    const result = govern({
      messages: [messageOf('advisor', 500), messageOf('advisor', 300), messageOf('advisor', 250)],
      settings: settingsOf({ 'advisory-budget-bytes': 1000 }),
    })
    expect(sizesOf(result.messages)).toEqual([300, 250])
    expect(result.decision.trimmed.map((trim) => trim.bytes)).toEqual([500])
  })

  it('keeps admitted backlog entries out of the enter-budget trim (at-most-once)', () => {
    const result = govern({
      messages: [messageOf('user', 5000)],
      settings: settingsOf({ 'enter-budget-bytes': 4096, 'advisory-budget-bytes': 800 }),
      backlog: [{ message: messageOf('advisor', 600), enqueuedAtSeq: 1, lastOfferedSeq: 1 }],
      gateSeq: 1,
    })
    // The user message alone blows the enter budget, so nothing is trimmed; the
    // admitted backlog entry is admitted once and never re-trimmed.
    expect(sizesOf(result.messages)).toEqual([600, 5000])
    expect(result.decision.hardOver).toBe(true)
    expect(result.backlog).toEqual([])
    expect(result.decision.trimmed).toEqual([])
  })
})

describe('class helpers', () => {
  it('charges no budget to protected classes', () => {
    const settings = settingsOf()
    expect(classBudgetOf('governance', settings)).toBeUndefined()
    expect(classBudgetOf('task', settings)).toBeUndefined()
    expect(classBudgetOf('passthrough', settings)).toBeUndefined()
    expect(classBudgetOf('memory', settings)).toBe(16_384)
    expect(classBudgetOf('advisory', settings)).toBe(8192)
  })

  it('reports an absent source kind as an empty string', () => {
    expect(sourceKindOf({ content: [] })).toBe('')
    expect(sourceKindOf(undefined)).toBe('')
    expect(sourceKindOf(messageOf('memory', 1))).toBe('memory')
  })
})
