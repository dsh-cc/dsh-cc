/**
 * The two seams slice 6 plugs into: the ordered pipeline (doc 7's dedupe → caps
 * stages ahead of the budget trim) and the `GovernorRow` payload builder.
 */

import { describe, expect, it } from 'vitest'
import {
  GOVERNOR_STAGES,
  buildGovernorRow,
  emptyBytesByClass,
  govern,
  runGovernorPipeline,
  type GovernedMessage,
  type GovernorStageHook,
} from '../src/index.ts'
import { messageOf, settingsOf, sizesOf } from './rig.ts'

describe('pipeline seam', () => {
  it('fixes the stage order as dedupe → caps → trim', () => {
    expect(GOVERNOR_STAGES).toEqual(['dedupe', 'caps', 'trim'])
    expect(Object.isFrozen(GOVERNOR_STAGES)).toBe(true)
  })

  it('is exactly the pure governor when no stage is registered', () => {
    const input = { messages: [messageOf('advisor', 600), messageOf('advisor', 600)], settings: settingsOf({ 'advisory-budget-bytes': 800 }) }
    const piped = runGovernorPipeline(input)
    const direct = govern(input)
    expect(sizesOf(piped.messages)).toEqual(sizesOf(direct.messages))
    expect(piped.decision).toEqual(direct.decision)
    expect(piped.backlog).toHaveLength(direct.backlog.length)
    expect(piped.gateSeq).toBe(direct.gateSeq)
  })

  it('runs hooks in stage order and lets them rewrite the trimmed batch', () => {
    const seen: string[] = []
    const hooks: GovernorStageHook[] = [
      { stage: 'caps', run: (messages) => { seen.push('caps'); return messages } },
      { stage: 'dedupe', run: (messages) => { seen.push('dedupe'); return messages.slice(1) } },
    ]
    const first = messageOf('advisor', 600)
    const dropped = messageOf('advisor', 5000)
    const result = runGovernorPipeline(
      { messages: [dropped, first], settings: settingsOf({ 'advisory-budget-bytes': 800 }) },
      hooks,
    )
    expect(seen).toEqual(['dedupe', 'caps'])
    // Dedupe removed the oversize message before the trim could judge it.
    expect(result.messages).toEqual([first])
    expect(result.decision.trimmed).toEqual([])
  })

  it('lets a hook throw through to the caller (the listener contains it)', () => {
    const hooks: GovernorStageHook[] = [{ stage: 'dedupe', run: () => { throw new Error('stage-boom') } }]
    expect(() => runGovernorPipeline({ messages: [], settings: settingsOf() }, hooks)).toThrow('stage-boom')
  })
})

describe('row builder seam', () => {
  it('carries every class key at zero on the failure path', () => {
    const row = buildGovernorRow({ sessionId: 's1', gen: 'g1', mode: 'enforce', error: true })
    expect(row).toMatchObject({
      v: 1,
      type: 'governor',
      sessionId: 's1',
      gen: 'g1',
      mode: 'enforce',
      trimmed: [],
      offeredBacklog: 0,
      hardOver: false,
      error: true,
    })
    expect(row.bytesByClass).toEqual({ governance: 0, task: 0, memory: 0, advisory: 0, passthrough: 0 })
    expect(row.bytesByClass).toEqual(emptyBytesByClass())
    // Attribution is omitted, not zeroed, when the payload carried none.
    expect(row).not.toHaveProperty('turn')
    expect(row).not.toHaveProperty('step')
  })

  it('defaults to observe mode and no error marker when nothing was decided', () => {
    const row = buildGovernorRow({ sessionId: 's1', gen: 'g1', turn: 3, step: 1 })
    expect(row.mode).toBe('observe')
    expect(row).not.toHaveProperty('error')
    expect(row.turn).toBe(3)
    expect(row.step).toBe(1)
  })

  it('takes mode, bytes, trims and the overflow flag from the decision', () => {
    const result = govern({
      messages: [messageOf('advisor', 600), messageOf('user', 20)],
      settings: settingsOf({ 'advisory-budget-bytes': 800, 'enter-budget-bytes': 4096 }),
    })
    const row = buildGovernorRow({ sessionId: 's1', gen: 'g1', decision: result.decision })
    expect(row.mode).toBe('enforce')
    expect(row.bytesByClass.advisory).toBe(600)
    expect(row.bytesByClass.task).toBe(20)
    expect(row.trimmed).toEqual(result.decision.trimmed)
    expect(row.hardOver).toBe(result.decision.hardOver)
    expect(row.offeredBacklog).toBe(result.decision.offeredBacklog)
  })

  it('never emits a text-bearing field (privacy boundary is structural)', () => {
    const message: GovernedMessage = messageOf('memory', 40)
    const result = govern({ messages: [message], settings: settingsOf() })
    const row = buildGovernorRow({ sessionId: 's1', gen: 'g1', decision: result.decision }) as unknown as Record<string, unknown>
    for (const key of ['kind', 'summary', 'text', 'content']) expect(row).not.toHaveProperty(key)
    for (const trim of row.trimmed as { kind: string }[]) expect(trim.kind.length).toBeLessThanOrEqual(64)
  })
})
