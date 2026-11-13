/**
 * The `agent/pre-step` listener wiring (plan doc §"Package & seam",
 * §"Failure semantics", §"Observe mode").
 *
 * These legs drive the listener directly over a fake context deps object, so
 * each semantic is pinned without a runtime: delegate-first, spread-preserving
 * rewrites, observe/enforce behaviour, flip-boundary queue reset, reject and
 * disabled passthroughs, and the never-throw failure path with its
 * `{ error: true }` row.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  createGovernorListener,
  type GovernorListener,
  type GovernorRow,
  type InputBudgetSettings,
  type PreStepDecisionLike,
  type PreStepPayloadLike,
} from '../src/index.ts'
import { messageOf, settingsOf } from './rig.ts'
import { agentOf, cleanupRigs, enforceSettings, observeSettings } from './live-rig.ts'
import { liveRig } from './live-rig.ts'

afterEach(() => { cleanupRigs() })

/** One fake-context harness: mutable settings, captured rows, quiet debug. */
interface Harness {
  listener: GovernorListener
  rows: GovernorRow[]
  /** Replace on the fly to flip mode/budgets between invocations. */
  settings: InputBudgetSettings
  debug: string[]
}

/** Build the listener over a deps object, with optional overrides. */
function harness(
  settings: InputBudgetSettings = enforceSettings(),
  overrides: {
    readSettings?: () => InputBudgetSettings
    hooks?: Parameters<typeof createGovernorListener>[0]['hooks']
    emit?: (row: GovernorRow) => void
  } = {},
): Harness {
  const rows: GovernorRow[] = []
  const debug: string[] = []
  const state: Harness = { listener: undefined as never, rows, settings, debug }
  state.listener = createGovernorListener({
    readSettings: () => (overrides.readSettings ?? (() => state.settings))(),
    emit: overrides.emit ?? ((row) => { rows.push(row) }),
    gen: 'gen-test',
    debug: (message) => { debug.push(message) },
    hooks: overrides.hooks,
  })
  return state
}

/** The innermost decision of one invocation (what the harness would produce). */
function nextOf(
  messages: ReturnType<typeof messageOf>[],
  startsRequestSeries = false,
): () => Promise<PreStepDecisionLike<ReturnType<typeof messageOf>>> {
  return () => Promise.resolve({
    kind: 'enter' as const,
    messages,
    ...(startsRequestSeries ? { startsRequestSeries: true as const } : {}),
  })
}

/** A pre-step payload for one session. */
function payloadOf(agent: object = agentOf('session-1'), turn = 2, step = 3): PreStepPayloadLike {
  return { agent, messages: [], turn, step, signal: new AbortController().signal, modelSelection: {} }
}

/** The messages of an enter decision. */
function messagesOf(decision: PreStepDecisionLike<ReturnType<typeof messageOf>>) {
  return decision.kind === 'enter' ? decision.messages : []
}

describe('delegate-first', () => {
  it('awaits next() before it reads settings or emits a row', async () => {
    const harnessed = harness()
    const order: string[] = []
    const rowsBefore = (): number => {
      order.push(`rows:${harnessed.rows.length}`)
      return harnessed.rows.length
    }
    await harnessed.listener.handler(payloadOf(), () => {
      rowsBefore()
      order.push('next')
      return Promise.resolve({ kind: 'enter' as const, messages: [messageOf('user', 10)] })
    })
    expect(order).toEqual(['rows:0', 'next'])
    expect(harnessed.rows).toHaveLength(1)
  })

  it('passes the reject decision straight through without a row or a clock tick', async () => {
    const harnessed = harness()
    const decision = await harnessed.listener.handler(payloadOf(), () => Promise.resolve({ kind: 'reject' as const }))
    expect(decision).toEqual({ kind: 'reject' })
    expect(harnessed.rows).toEqual([])
    // No state was created for the session: the reject was not a gate invocation.
    expect(harnessed.listener.stateOf('session-1')).toBeUndefined()
  })
})

describe('observe mode', () => {
  it('returns the batch untouched and records the same decisions', async () => {
    const harnessed = harness(observeSettings({ 'advisory-budget-bytes': 800 }))
    const first = messageOf('advisor', 600)
    const second = messageOf('advisor', 600)
    const decision = await harnessed.listener.handler(payloadOf(), nextOf([first, second]))
    // Same instances, same order: observe mode changes nothing.
    expect(messagesOf(decision)).toEqual([first, second])
    expect(messagesOf(decision)[0]).toBe(first)
    // Decisions still land in the shared `trimmed` array, under mode 'observe'.
    expect(harnessed.rows[0]).toMatchObject({
      type: 'governor',
      mode: 'observe',
      offeredBacklog: 0,
      hardOver: false,
      trimmed: [{ kind: 'advisor', bytes: 600, action: 'defer' }],
    })
  })
})

describe('enforce mode', () => {
  it('rewrites the batch and spreads the decision (optional fields survive)', async () => {
    const harnessed = harness(enforceSettings({ 'advisory-budget-bytes': 800 }))
    const first = messageOf('advisor', 600)
    const second = messageOf('advisor', 600)
    const decision = await harnessed.listener.handler(payloadOf(), nextOf([first, second], true))
    expect(messagesOf(decision)).toEqual([second])
    expect(decision.kind === 'enter' ? decision.startsRequestSeries : undefined).toBe(true)
    expect(harnessed.rows[0]).toMatchObject({ mode: 'enforce', offeredBacklog: 0 })
  })

  it('never drops a protected class, whatever the overflow', async () => {
    const harnessed = harness(enforceSettings({ 'enter-budget-bytes': 4096, 'advisory-budget-bytes': 512 }))
    const governance = messageOf('agent-instructions', 3000)
    const task = messageOf('user', 2000)
    const advisory = messageOf('advisor', 600)
    const decision = await harnessed.listener.handler(payloadOf(), nextOf([governance, task, advisory]))
    // Both protected messages survive; the enter budget cannot be met within the
    // trimmable classes, so the overflow is flagged rather than paid for.
    expect(messagesOf(decision)).toEqual([governance, task])
    expect(harnessed.rows[0]?.hardOver).toBe(true)
  })

  it('re-admits a deferred message through the return value only', async () => {
    const harnessed = harness(enforceSettings({ 'advisory-budget-bytes': 800 }))
    const first = messageOf('advisor', 600)
    const second = messageOf('advisor', 600)
    await harnessed.listener.handler(payloadOf(), nextOf([first, second]))
    const decision = await harnessed.listener.handler(payloadOf(), nextOf([]))
    expect(messagesOf(decision)).toEqual([first])
    expect(harnessed.rows[1]?.offeredBacklog).toBe(1)
  })
})

describe('flip boundaries', () => {
  it('resets the backlog on enforce → observe → enforce', async () => {
    const harnessed = harness(enforceSettings({ 'advisory-budget-bytes': 800 }))
    await harnessed.listener.handler(payloadOf(), nextOf([messageOf('advisor', 600), messageOf('advisor', 600)]))
    expect(harnessed.listener.stateOf('session-1')?.backlog).toHaveLength(1)

    harnessed.settings = observeSettings({ 'advisory-budget-bytes': 800 })
    await harnessed.listener.handler(payloadOf(), nextOf([]))
    expect(harnessed.listener.stateOf('session-1')?.mode).toBe('observe')
    expect(harnessed.listener.stateOf('session-1')?.backlog).toEqual([])

    harnessed.settings = enforceSettings({ 'advisory-budget-bytes': 800 })
    await harnessed.listener.handler(payloadOf(), nextOf([]))
    expect(harnessed.listener.stateOf('session-1')?.mode).toBe('enforce')
    // Nothing carried across either flip: the queue starts empty.
    expect(harnessed.listener.stateOf('session-1')?.backlog).toEqual([])
    expect(harnessed.rows.map(row => row.offeredBacklog)).toEqual([0, 0, 0])
  })
})

describe('passthrough paths', () => {
  it('is a full no-op when the governor is disabled', async () => {
    const harnessed = harness({ ...enforceSettings({ 'advisory-budget-bytes': 800 }), enabled: false })
    const batch = [messageOf('advisor', 600), messageOf('advisor', 600)]
    const decision = await harnessed.listener.handler(payloadOf(), nextOf(batch))
    expect(messagesOf(decision)).toEqual(batch)
    expect(harnessed.rows).toEqual([])
    expect(harnessed.listener.stateOf('session-1')).toBeUndefined()
  })

  it('leaves an unattributable batch alone (no session clock to age against)', async () => {
    const harnessed = harness()
    const batch = [messageOf('advisor', 600), messageOf('advisor', 600)]
    const decision = await harnessed.listener.handler({ messages: [], signal: null }, nextOf(batch))
    expect(messagesOf(decision)).toEqual(batch)
    expect(harnessed.rows).toEqual([])
  })
})

describe('failure semantics', () => {
  it('returns the unmodified decision and records an error row when settings fail', async () => {
    const harnessed = harness(enforceSettings(), {
      readSettings: () => { throw new Error('boom') },
    })
    const batch = [messageOf('advisor', 600), messageOf('advisor', 600)]
    const decision = await harnessed.listener.handler(payloadOf(), nextOf(batch))
    expect(messagesOf(decision)).toEqual(batch)
    expect(harnessed.rows).toHaveLength(1)
    expect(harnessed.rows[0]).toMatchObject({ type: 'governor', error: true, mode: 'observe' })
    expect(harnessed.debug.join('\n')).toContain('boom')
  })

  it('contains a throwing pipeline stage the same way', async () => {
    const harnessed = harness(enforceSettings(), {
      hooks: [{ stage: 'dedupe', run: () => { throw new Error('stage-boom') } }],
    })
    const batch = [messageOf('user', 10)]
    const decision = await harnessed.listener.handler(payloadOf(), nextOf(batch))
    expect(messagesOf(decision)).toEqual(batch)
    expect(harnessed.rows[0]).toMatchObject({ error: true })
    // The clock did not advance with the failed invocation.
    expect(harnessed.listener.stateOf('session-1')?.gateSeq ?? 0).toBe(0)
  })

  it('survives a throwing row sink without diverging the batch from the state', async () => {
    const harnessed = harness(enforceSettings({ 'advisory-budget-bytes': 800 }), {
      emit: () => { throw new Error('sink-boom') },
    })
    const decision = await harnessed.listener.handler(
      payloadOf(),
      nextOf([messageOf('advisor', 600), messageOf('advisor', 600)]),
    )
    // The trim still applies: the deferred message lives in the backlog, so
    // returning the untrimmed batch would deliver it twice.
    expect(messagesOf(decision)).toHaveLength(1)
    expect(harnessed.listener.stateOf('session-1')?.backlog).toHaveLength(1)
    expect(harnessed.debug.join('\n')).toContain('sink-boom')
  })
})

describe('row construction seam', () => {
  it('builds a full GovernorRow with attribution from the payload', async () => {
    const harnessed = harness()
    await harnessed.listener.handler(payloadOf(agentOf('session-9'), 4, 7), nextOf([messageOf('user', 12)]))
    const row = harnessed.rows[0]!
    expect(row).toMatchObject({
      v: 1,
      type: 'governor',
      sessionId: 'session-9',
      gen: 'gen-test',
      turn: 4,
      step: 7,
      mode: 'enforce',
      offeredBacklog: 0,
      hardOver: false,
      trimmed: [],
    })
    expect(typeof row.ts).toBe('number')
    expect(Object.keys(row.bytesByClass).sort()).toEqual(['advisory', 'governance', 'memory', 'passthrough', 'task'])
    expect(row.bytesByClass.task).toBe(12)
    expect(row).not.toHaveProperty('error')
  })

  it('routes the batch through the pre-trim pipeline stages', async () => {
    const seen: string[] = []
    const harnessed = harness(enforceSettings({ 'advisory-budget-bytes': 800 }), {
      hooks: [
        { stage: 'caps', run: (messages) => { seen.push('caps'); return messages } },
        { stage: 'dedupe', run: (messages) => { seen.push('dedupe'); return messages.slice(0, 1) } },
      ],
    })
    const first = messageOf('advisor', 600)
    const second = messageOf('advisor', 600)
    await harnessed.listener.handler(payloadOf(), nextOf([first, second]))
    // Dedupe ran before caps regardless of list order, and the trim then saw
    // only the deduped batch (so nothing needed trimming).
    expect(seen).toEqual(['dedupe', 'caps'])
    expect(harnessed.rows[0]?.trimmed).toEqual([])
    expect(harnessed.rows[0]?.bytesByClass.advisory).toBe(600)
  })
})

describe('settings wiring', () => {
  it('runs observe mode when no settings file exists', async () => {
    const rig = liveRig({ fileless: true })
    // Over the SHIP-default advisory budget (8192), so the decision is visible.
    const batch = [messageOf('advisor', 4000), messageOf('advisor', 4000), messageOf('advisor', 4000)]
    const decision = await rig.run(batch)
    expect(decision.kind === 'enter' ? decision.messages : []).toEqual(batch)
    expect(rig.rows[0]?.mode).toBe('observe')
    expect(rig.rows[0]?.trimmed).toEqual([{ kind: 'advisor', bytes: 4000, action: 'defer' }])
  })

  it('honours an enforce section read from the raw user file', async () => {
    const rig = liveRig({ section: { mode: 'enforce', 'advisory-budget-bytes': 800 } })
    const decision = await rig.run([messageOf('advisor', 600), messageOf('advisor', 600)])
    expect(decision.kind === 'enter' ? decision.messages : []).toHaveLength(1)
    expect(rig.rows[0]?.mode).toBe('enforce')
    expect(settingsOf().mode).toBe('enforce')
  })
})
