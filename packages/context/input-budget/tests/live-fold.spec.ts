/**
 * Live-fold ordering and progression legs (plan doc §"Package & seam" ordering
 * defenses 2–3 and §"Verification" integration bullet).
 *
 * Everything here runs on the REAL cordis event chain: the real listener is
 * registered through its public entry point, synthetic producers register on
 * the same `agent/pre-step` event, and each invocation goes through the real
 * waterfall — only the agent loop is absent, because this package links no
 * agent-loop dependency.
 *
 * What the two ordering legs pin:
 *
 * 1. a PLAIN (non-prepend) producer's append is INSIDE the governor — the
 *    governor's final batch and its row include it (the prepend/unshift
 *    contract: plain listeners always run inside a prepended one);
 * 2. a LATE-REGISTERED prepended producer lands OUTSIDE the governor — its
 *    content never enters the row and is never trimmed, the documented
 *    by-construction visibility boundary (risk register: "late-registered
 *    prepended listeners bypass the governor … class-default passthrough means
 *    they cannot be trimmed by surprise").
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { GovernedMessage } from '../src/index.ts'
import { messageOf } from './rig.ts'
import { agentOf, cleanupRigs, enforceSettings, liveRig, observeSettings } from './live-rig.ts'

afterEach(() => { cleanupRigs() })

/** The actions of one row's trims, in the order the algorithm recorded them. */
function actionsOf(row: { trimmed: { action: string }[] } | undefined): string[] {
  return (row?.trimmed ?? []).map(trim => trim.action)
}

describe('live-fold ordering defense 1 — a plain producer stays inside the governor', () => {
  it('sees the plain producer append in both the final batch and the row', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) })
    const marker = messageOf('user', 100)
    // A plain producer: registered without prepend, delegate-first, appending on
    // the way back out — exactly the mcpReadyNotice / progress-rebuild shape.
    rig.producer(async (_payload, next) => {
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream
      return { ...downstream, messages: [...downstream.messages, marker] }
    })
    const first = messageOf('advisor', 600)
    const second = messageOf('advisor', 600)
    const decision = await rig.run([first, second])

    // The governor trimmed the advisory class (it saw both advisories) …
    expect(actionsOf(rig.rows[0])).toEqual(['defer'])
    // … and it also saw the plain producer's marker, which is only possible
    // because a prepended listener wraps every plain one.
    expect(rig.rows[0]?.bytesByClass).toMatchObject({ advisory: 600, task: 100 })
    expect(decision.kind).toBe('enter')
    const messages = decision.kind === 'enter' ? decision.messages : []
    // The marker is never a trim candidate: it survives untouched.
    expect(messages).toContain(marker)
    expect(messages.filter(message => message.source?.kind === 'advisor')).toEqual([second])
  })
})

describe('live-fold ordering defense 2 — a late prepended producer lands outside the governor', () => {
  it('never enters the row and is never trimmed, even over budget', async () => {
    // A deliberately tiny advisory budget: anything the governor could see
    // would be trimmed, so "not trimmed" proves "not seen".
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) })
    const late = messageOf('advisor', 900)
    // Registered AFTER the governor, prepended → unshifted ahead of it, i.e.
    // outermost: it appends after the governor already produced its decision.
    rig.prepended(async (_payload, next) => {
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream
      return { ...downstream, messages: [...downstream.messages, late] }
    })
    const inside = messageOf('advisor', 600)
    const decision = await rig.run([inside])

    // The governor measured only the inner batch, recorded no trim, and left the
    // late message alone: outside-governor content can never be harmed.
    expect(rig.rows[0]?.bytesByClass).toMatchObject({ advisory: 600 })
    expect(actionsOf(rig.rows[0])).toEqual([])
    expect(decision.kind).toBe('enter')
    const messages = decision.kind === 'enter' ? decision.messages : []
    expect(messages).toEqual([inside, late])
  })
})

describe('three-step progression with defer aging and TTL expiry', () => {
  it('defers, admits from the backlog, then drops the aged entries', async () => {
    const rig = liveRig({
      settings: enforceSettings({ 'memory-budget-bytes': 1024, 'defer-ttl-steps': 1 }),
    })
    // The fake agent has no `inject`: re-entry through anything but the
    // governor's own return value would throw here (and leave the batch
    // unmodified), so an empty call log plus an admitted message pins the
    // "no agent.inject" contract.
    const injected: GovernedMessage[] = []
    const agent = { session: { id: 'live-session', header: { id: 'live-session' } }, inject: (m: GovernedMessage) => { injected.push(m) } }
    const first = messageOf('memory', 600)
    const second = messageOf('memory', 600)
    const third = messageOf('memory', 600)
    const fourth = messageOf('memory', 600)

    // Step 1: 2400 memory bytes against a 1024 budget — FIFO trim three entries.
    const one = await rig.run([first, second, third, fourth], { agent, turn: 1, step: 1 })
    expect(one.kind === 'enter' ? one.messages : []).toEqual([fourth])
    expect(actionsOf(rig.rows[0])).toEqual(['defer', 'defer', 'defer'])
    expect(rig.rows[0]?.offeredBacklog).toBe(0)
    expect(rig.rows[0]).toMatchObject({ type: 'governor', mode: 'enforce', sessionId: 'live-session' })

    // Step 2: no fresh content — the backlog head is re-admitted THROUGH the
    // governor's own return value (no agent.inject anywhere).
    const two = await rig.run([], { agent, turn: 1, step: 2 })
    const admitted = two.kind === 'enter' ? two.messages : []
    expect(admitted).toEqual([first])
    expect(admitted[0]).toBe(first)
    expect(actionsOf(rig.rows[1])).toEqual([])
    expect(rig.rows[1]?.offeredBacklog).toBe(3)

    // Step 3: the two entries that never fit aged past the 1-invocation TTL.
    const three = await rig.run([], { agent, turn: 1, step: 3 })
    expect(three.kind === 'enter' ? three.messages : []).toEqual([])
    expect(actionsOf(rig.rows[2])).toEqual(['drop-expired', 'drop-expired'])
    expect(rig.rows[2]?.offeredBacklog).toBe(2)

    // The clock advanced once per gate invocation, and the queue drained.
    expect(rig.rows.map(row => row.hardOver)).toEqual([false, false, false])
    expect(injected).toEqual([])
  })
})

describe('live listener state', () => {
  it('keeps one clock and one backlog per session', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) })
    // Session A defers one 600-byte advisory (two of them cannot fit in 800).
    await rig.run([messageOf('advisor', 600), messageOf('advisor', 600)], { agent: agentOf('session-a') })
    // Session B's invocation must not see A's backlog.
    await rig.run([messageOf('user', 20)], { agent: agentOf('session-b') })
    // A's backlog is still there; B's is still empty.
    const a = await rig.run([], { agent: agentOf('session-a') })
    const b = await rig.run([], { agent: agentOf('session-b') })
    expect(rig.rows.map(row => row.sessionId)).toEqual(['session-a', 'session-b', 'session-a', 'session-b'])
    expect(rig.rows.map(row => row.offeredBacklog)).toEqual([0, 0, 1, 0])
    expect(a.kind === 'enter' ? a.messages : []).toHaveLength(1)
    expect(b.kind === 'enter' ? b.messages : []).toEqual([])
  })

  it('spreads the decision, so the optional enter fields survive the rewrite', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) })
    const decision = await rig.run([messageOf('advisor', 600), messageOf('advisor', 600)], {
      startsRequestSeries: true,
    })
    expect(decision.kind === 'enter' ? decision.startsRequestSeries : undefined).toBe(true)
    expect(rig.rows[0]?.trimmed).toHaveLength(1)
  })

  it('drops one session state on disposal and leaves the others alone', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) })
    await rig.run([messageOf('advisor', 600), messageOf('advisor', 600)], { agent: agentOf('gone') })
    await rig.run([messageOf('advisor', 600), messageOf('advisor', 600)], { agent: agentOf('kept') })
    const emit = rig.ctx.emit as unknown as (name: string, payload: unknown) => void
    emit.call(rig.ctx, 'session/disposed', { id: 'gone' })
    // The disposed session starts over with an empty queue; the other keeps its own.
    await rig.run([], { agent: agentOf('gone') })
    await rig.run([], { agent: agentOf('kept') })
    expect(rig.rows.map(row => row.offeredBacklog)).toEqual([0, 0, 0, 1])
  })

  it('resets the backlog at the flip boundary, in both directions', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) })
    const agent = agentOf('flip-session')
    // Enforce: one advisory is deferred, so the queue holds one entry.
    await rig.run([messageOf('advisor', 600), messageOf('advisor', 600)], { agent })
    expect(rig.rows[0]).toMatchObject({ mode: 'enforce', offeredBacklog: 0 })

    // Flip to observe: the queue is cleared, not carried into the shadow mode.
    rig.settings = observeSettings({ 'advisory-budget-bytes': 800 })
    const observed = await rig.run([], { agent })
    expect(rig.rows[1]).toMatchObject({ mode: 'observe', offeredBacklog: 0 })
    // Observe mode changes nothing, even with nothing to admit.
    expect(observed.kind === 'enter' ? observed.messages : []).toEqual([])

    // Flip back to enforce: the queue starts empty at the new boundary too.
    rig.settings = enforceSettings({ 'advisory-budget-bytes': 800 })
    await rig.run([], { agent })
    expect(rig.rows[2]).toMatchObject({ mode: 'enforce', offeredBacklog: 0 })
  })
})

describe('the release handle', () => {
  it('unregisters the listener (no rows, batch untouched)', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) })
    rig.release()
    const messages: GovernedMessage[] = [messageOf('advisor', 600), messageOf('advisor', 600)]
    const decision = await rig.run(messages)
    expect(rig.rows).toEqual([])
    expect(decision.kind === 'enter' ? decision.messages : []).toEqual(messages)
  })
})
