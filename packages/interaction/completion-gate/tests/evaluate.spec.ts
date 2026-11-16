/**
 * Evaluate-pipeline pins (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §5.4, §5.5, §5.7,
 * §5.14, §5.15): head-less fail-open + enabled early-return, skip-rule
 * isolation + nudge-once, compaction fail-open, composite fail-open matrix,
 * window-anchor/re-entry/turn-guard, horizon rule, and the resolved
 * loop-closer. Fixtures are constructed snapshot arrays (prompt-suggest
 * pattern); the agent-loop integration pin lives in smoke.spec.ts, the
 * persistence pin in persistence.spec.ts.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { EXHAUSTED_EVENT, NUDGE_EVENT, RECEIPT_EVENT, type Receipt } from '../src/events.ts'
import {
  evaluateTurnStopping,
  maybeResolveOnReceipt,
  type EvalAgent,
  type EvalEvent,
  type EnforceMirrorEntry,
  type EvaluateDeps,
} from '../src/evaluate.ts'
import { LineageRegistry, countGenuineUserMessages, type SessionLike } from '../src/lineage.ts'
import { buildReceipt } from '../src/receipts.ts'
import { DEFAULT_GATE_SETTINGS, type GateSettings } from '../src/settings.ts'
import { createTurnStoppingHandler } from '../src/wiring.ts'

/** One fixture session whose append mutates the same snapshot array. */
function fakeSession(id: string, events: EvalEvent[] = []): any {
  return {
    header: { id },
    snapshotEvents: () => events,
    append: (type: string, data: unknown) => {
      events.push({ type, data, seq: events.length })
    },
  }
}

function fixtureAgent(session: any): EvalAgent & { injected: string[] } {
  const injected: string[] = []
  return {
    session,
    injected,
    inject: (message: any) => {
      injected.push(message.content.map((block: any) => block.text).join('\n'))
    },
  } as never
}

/**
 * Evaluate deps fixture. `enforceMirror`/`exhaustedTurns` are SHARED across
 * re-dispatches within a test (a fresh map per dispatch can never stall) —
 * pass one in to continue a simulated turn loop.
 */
function deps(overrides?: Partial<GateSettings> & {
  lineage?: LineageRegistry
  latches?: Map<string, number>
  enforceMirror?: Map<string, EnforceMirrorEntry>
  exhaustedTurns?: Set<string>
}): EvaluateDeps & { logs: string[] } {
  const { lineage, latches, enforceMirror, exhaustedTurns, ...settingsOverrides } = overrides ?? {}
  const logs: string[] = []
  return {
    settings: { ...DEFAULT_GATE_SETTINGS, enabled: true, ...settingsOverrides } as GateSettings,
    lineage: lineage ?? new LineageRegistry(),
    latches: latches ?? new Map(),
    enforceMirror: enforceMirror ?? new Map(),
    exhaustedTurns: exhaustedTurns ?? new Set(),
    debug: (message: string) => logs.push(message),
    logs,
  }
}

function userMessage(text = 'please finish', kind?: string): EvalEvent {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], ...(kind ? { source: { kind } } : {}) } }
}

function assistantClaim(turn: number, text = 'tests pass'): EvalEvent {
  return { type: 'assistant/message', data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

function receiptEvent(tool: string, head?: string, outcome: 'ok' | 'error' = 'ok'): EvalEvent {
  const receipt = buildReceipt(
    { callId: 'c1', name: tool, arguments: { command: head ?? 'noop' }, agent: undefined } as never,
    { isError: outcome === 'error', content: [{ type: 'text', text: 'ok' }] } as never,
    { headEnabled: head !== undefined },
  )
  if (head === undefined) delete receipt.head
  return { type: RECEIPT_EVENT, data: receipt }
}

function outcome(events: EvalEvent[], turn: number, d = deps()) {
  const agent = fixtureAgent(fakeSession('root', events))
  return { result: evaluateTurnStopping(agent, turn, d), agent, d }
}

describe('head-less fail-open + enabled gate (§5.4)', () => {
  it('a bash receipt with no head does not satisfy — nudge still fires', () => {
    const events = [userMessage(), receiptEvent('bash'), assistantClaim(1)]
    const { result } = outcome(events, 1)
    expect(result).toMatchObject({ action: 'nudge', claims: ['tests-green'] })
  })

  it('a headed in-window receipt satisfies — no nudge', () => {
    const events = [userMessage(), receiptEvent('bash', 'pnpm test'), assistantClaim(1)]
    const { result } = outcome(events, 1)
    expect(result).toEqual({ action: 'skip', reason: 'satisfied' })
  })

  it('enabled=false early-returns before any evaluation', () => {
    const events = [userMessage(), assistantClaim(1)]
    const { result } = outcome(events, 1, deps({ enabled: false }))
    expect(result).toEqual({ action: 'skip', reason: 'disabled' })
  })
})

describe('skip-rule isolation + nudge-once (§5.5)', () => {
  it('two consecutive claim-bearing final messages ⇒ one nudge (budget)', () => {
    const events = [userMessage(), assistantClaim(1)]
    const first = outcome(events, 1)
    expect(first.result).toMatchObject({ action: 'nudge' })
    // Second judged message (a fresh turn after the nudge continuation).
    events.push(userMessage('and now?'), assistantClaim(2))
    const second = outcome(events, 2)
    expect(second.result).toEqual({ action: 'skip', reason: 'budget' })
  })

  it('the latch alone (event append unavailable) still caps nudges', () => {
    const session: any = {
      header: { id: 'root' },
      snapshotEvents: () => [userMessage(), assistantClaim(1)],
    }
    const agent = fixtureAgent(session)
    const d = deps()
    expect(evaluateTurnStopping(agent, 1, d)).toMatchObject({ action: 'nudge' })
    expect(d.latches.get('root')).toBe(1)
    expect(evaluateTurnStopping(agent, 1, d)).toEqual({ action: 'skip', reason: 'budget' })
  })

  it('our completion-gate user/message suppresses detection; plugin checkpoints do NOT', () => {
    // Same-turn re-entry: latest preceding user/message is our kind ⇒ skip.
    const gated = [userMessage(), assistantClaim(1), userMessage('Evidence check…', 'completion-gate'), assistantClaim(1)]
    const gatedD = deps({ 'nudges-per-session': 5 })
    expect(outcome(gated, 1, gatedD).result).toEqual({ action: 'skip', reason: 'suppressed' })

    // Checkpoint user/message (kind 'plugin') with NO compaction/end still evaluates.
    const checkpoint = [userMessage(), userMessage('checkpoint…', 'plugin'), assistantClaim(1)]
    expect(outcome(checkpoint, 1).result).toMatchObject({ action: 'nudge' })
  })

  it('a bare re-evaluation with budget > 1 re-nudges only without the skip-rule anchor', () => {
    // Followup genuine user input does NOT suppress (§5.15 suppression scope).
    const events = [userMessage(), userMessage('followup')]
    const d = deps({ 'nudges-per-session': 5 })
    events.push(assistantClaim(1))
    expect(outcome(events, 1, d).result).toMatchObject({ action: 'nudge' })
  })
})

describe('compaction fail-open (§5.7)', () => {
  it('checkpoint + compaction/end inside the window ⇒ no nudge', () => {
    const events = [userMessage(), userMessage('checkpoint…', 'plugin'), { type: 'compaction/end', data: { compactionId: 'c' } }, assistantClaim(1)]
    expect(outcome(events, 1).result).toEqual({ action: 'skip', reason: 'compaction' })
  })

  it('compaction/end BEFORE the window start does not fail open', () => {
    const events = [userMessage('first'), { type: 'compaction/end', data: {} }, userMessage('second'), assistantClaim(1)]
    expect(outcome(events, 1).result).toMatchObject({ action: 'nudge' })
  })
})

describe('composite fail-open + suppression matrix (§5.14)', () => {
  it('(zero receipts ∧ zero tool events) ⇒ gate stays armed — nudge fires', () => {
    const events = [userMessage(), assistantClaim(1)]
    expect(outcome(events, 1).result).toMatchObject({ action: 'nudge' })
  })

  it('(zero receipts ∧ tool events present) ⇒ skip (broken evidence view)', () => {
    const events = [userMessage(), { type: 'tool/call', data: { name: 'bash', arguments: '{}' } }, assistantClaim(1)]
    expect(outcome(events, 1).result).toEqual({ action: 'skip', reason: 'composite-fail-open' })
  })

  it('receipts present alongside tool events ⇒ evaluates normally', () => {
    const events = [userMessage(), { type: 'tool/call', data: { name: 'bash', arguments: '{}' } }, receiptEvent('bash', 'pnpm test'), assistantClaim(1)]
    expect(outcome(events, 1).result).toEqual({ action: 'skip', reason: 'satisfied' })
  })

  it('hot-toggle: head-less earlier work draws at most ONE bounded false nudge', () => {
    // Receipt captured while disabled (head-less), then enabled flips on.
    const events = [userMessage(), receiptEvent('bash'), assistantClaim(1)]
    const first = outcome(events, 1)
    expect(first.result).toMatchObject({ action: 'nudge' })
    const second = outcome(events, 1)
    expect(second.result).toEqual({ action: 'skip', reason: 'budget' })
  })
})

describe('window anchor + re-entry + turn guard (§5.15)', () => {
  it('turn 1 executes, turn 2 claims ⇒ previous-turn receipt must NOT satisfy (nudge)', () => {
    const events = [userMessage('run tests'), receiptEvent('bash', 'pnpm test'), assistantClaim(1), userMessage('done yet?'), assistantClaim(2, 'tests pass')]
    expect(outcome(events, 2).result).toMatchObject({ action: 'nudge' })
    // ...but turn 1's own claim was satisfied in its own window.
    expect(outcome(events, 1).result).toEqual({ action: 'skip', reason: 'satisfied' })
  })

  it('same-turn re-entry with budget > 1: second turn-stopping emits no second nudge', () => {
    const events = [userMessage(), assistantClaim(1), userMessage('Evidence check…', 'completion-gate'), assistantClaim(1)]
    const d = deps({ 'nudges-per-session': 2 })
    expect(outcome(events, 1, d).result).toEqual({ action: 'skip', reason: 'suppressed' })
  })

  it('turn guard: aborted turn without a judged assistant/message ⇒ no evaluation', () => {
    const events = [userMessage(), assistantClaim(1)]
    expect(outcome(events, 2).result).toEqual({ action: 'skip', reason: 'turn-guard' })
  })

  it('session-start window (no genuine user message) evaluates with ordinal 0', () => {
    const events = [userMessage('kickoff…', 'plugin'), assistantClaim(1)]
    expect(outcome(events, 1).result).toMatchObject({ action: 'nudge' })
  })
})

describe('horizon rule (§3.4 / §5.13)', () => {
  it('delegation receipt in window with zero witnessed children ⇒ skip', () => {
    const events = [userMessage(), receiptEvent('subagent_fork', 'fork something'), assistantClaim(1)]
    expect(outcome(events, 1).result).toEqual({ action: 'skip', reason: 'horizon' })
  })

  it('a witnessed child opens the horizon: lift evidence satisfies the claim', () => {
    const rootEvents: EvalEvent[] = [userMessage(), assistantClaim(1)]
    const root = fakeSession('root', rootEvents)
    const child = { id: 'child', header: { id: 'child', parentSession: 'root' }, snapshotEvents: () => [] } as unknown as SessionLike
    const lineage = new LineageRegistry()
    lineage.witness(root)
    lineage.record(child, buildReceipt(
      { callId: 'c1', name: 'bash', arguments: { command: 'pnpm test' }, agent: { session: child } } as never,
      { isError: false, content: [{ type: 'text', text: 'ok' }] } as never,
      { headEnabled: true },
    ))
    const agent = fixtureAgent(root)
    const d = deps({ lineage })
    expect(evaluateTurnStopping(agent, 1, d)).toEqual({ action: 'skip', reason: 'satisfied' })
  })

  it('lift ordinal equality: stamp equals count-from-view at lift time (restored-style view)', () => {
    // Restored session: replayed messages sit in the snapshot; the firehose
    // never replayed them. A child receipt stamped NOW must equal the view
    // count, and satisfy a claim in a session-start window (ordinal 0).
    const rootEvents: EvalEvent[] = [userMessage('a'), userMessage('b')]
    const root = fakeSession('root', rootEvents)
    const child = { id: 'child', header: { id: 'child', parentSession: 'root' }, snapshotEvents: () => [] } as unknown as SessionLike
    const lineage = new LineageRegistry()
    // The restored session object IS reachable at lift time (the firehose
    // never replayed its old messages — replay is not needed: the stamp reads
    // snapshotEvents, and it must equal the count-from-view at lift time).
    lineage.witness(root)
    lineage.record(child, { sessionId: 'child', tool: 'bash', head: 'pnpm test', outcome: 'ok' })
    expect(lineage.liftsFor('root')[0]!.stampedOrdinal).toBe(countGenuineUserMessages(rootEvents))
    rootEvents.push(assistantClaim(1))
    const d = deps({ lineage })
    expect(evaluateTurnStopping(fixtureAgent(root), 1, d)).toEqual({ action: 'skip', reason: 'satisfied' })
  })
})

describe('resolved loop-closer (§3.4 step 4)', () => {
  it('a matching receipt resolves an open nudge exactly once', () => {
    const events: EvalEvent[] = [userMessage(), assistantClaim(1)]
    const session = fakeSession('s', events)
    session.append('completion-gate/nudge', { claim: 'tests-green', missingReceipt: true, assistantTextHash: 'h' })
    maybeResolveOnReceipt(session, buildReceipt(
      { callId: 'c1', name: 'bash', arguments: { command: 'pnpm test' }, agent: undefined } as never,
      { isError: false, content: [{ type: 'text', text: 'ok' }] } as never,
      { headEnabled: true },
    ), () => {})
    const resolved = events.filter(event => event.type === 'completion-gate/resolved')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.data).toEqual({ claim: 'tests-green', via: 'bash' })
    // Idempotent: a second matching receipt resolves nothing more.
    maybeResolveOnReceipt(session, buildReceipt(
      { callId: 'c2', name: 'bash', arguments: { command: 'pnpm test' }, agent: undefined } as never,
      { isError: false, content: [{ type: 'text', text: 'ok' }] } as never,
      { headEnabled: true },
    ), () => {})
    expect(events.filter(event => event.type === 'completion-gate/resolved')).toHaveLength(1)
  })

  it('a non-matching receipt resolves nothing', () => {
    const events: EvalEvent[] = []
    const session = fakeSession('s', events)
    session.append('completion-gate/nudge', { claim: 'tests-green', missingReceipt: true, assistantTextHash: 'h' })
    maybeResolveOnReceipt(session, buildReceipt(
      { callId: 'c1', name: 'bash', arguments: { command: 'ls' }, agent: undefined } as never,
      { isError: false, content: [{ type: 'text', text: 'ok' }] } as never,
      { headEnabled: true },
    ), () => {})
    expect(events.filter(event => event.type === 'completion-gate/resolved')).toHaveLength(0)
  })
})

/** Count fixture events of one type. */
function countOf(events: EvalEvent[], type: string): number {
  return events.filter(event => event.type === type).length
}

describe('enforce mode: cycle machine (§5 cases 1-3)', () => {
  it('case 1: first unmatched claim ⇒ nudge with cycle 1, one inject, mirror advanced', () => {
    const events = [userMessage(), assistantClaim(1)]
    const d = deps({ mode: 'enforce' })
    const { result, agent } = outcome(events, 1, d)
    expect(result).toEqual({ action: 'nudge', claims: ['tests-green'] })
    const nudges = events.filter(event => event.type === NUDGE_EVENT)
    expect(nudges).toHaveLength(1)
    expect(nudges[0]!.data).toMatchObject({ claim: 'tests-green', missingReceipt: true, cycle: 1 })
    expect(agent.injected).toHaveLength(1)
    expect(agent.injected[0]).toContain('Completion gate (enforced):')
    expect(agent.injected[0]).toContain('Gate cycles remaining: 2.')
    expect(d.enforceMirror.get('root')).toEqual({ windowOrdinal: 1, spent: 1 })
  })

  it('case 2: re-dispatch after a restated claim ⇒ cycle 2 (mirror shared across dispatches)', () => {
    const events = [userMessage(), assistantClaim(1)]
    const d = deps({ mode: 'enforce' })
    expect(outcome(events, 1, d).result).toEqual({ action: 'nudge', claims: ['tests-green'] })
    // The model restated the claim after the injected message (same turn).
    events.push(userMessage('Completion gate (enforced): …', 'completion-gate'), assistantClaim(1))
    expect(outcome(events, 1, d).result).toEqual({ action: 'nudge', claims: ['tests-green'] })
    expect(events.filter(event => event.type === NUDGE_EVENT).map(event => event.data.cycle)).toEqual([1, 2])
    expect(d.enforceMirror.get('root')).toEqual({ windowOrdinal: 1, spent: 2 })
  })

  it('case 3: enforce-max-cycles 2 ⇒ third evaluation stalls once, fourth is idempotent', () => {
    const events = [userMessage(), assistantClaim(1)]
    const d = deps({ mode: 'enforce', 'enforce-max-cycles': 2 })
    expect(outcome(events, 1, d).result).toMatchObject({ action: 'nudge' })
    expect(outcome(events, 1, d).result).toMatchObject({ action: 'nudge' })
    const third = outcome(events, 1, d)
    expect(third.result).toEqual({ action: 'stall', claims: ['tests-green'] })
    expect(third.agent.injected).toHaveLength(0)
    expect(countOf(events, EXHAUSTED_EVENT)).toBe(1)
    const exhausted = events.find(event => event.type === EXHAUSTED_EVENT)!
    expect(exhausted.data).toMatchObject({ turn: 1, claims: ['tests-green'] })
    expect(typeof exhausted.data.assistantTextHash).toBe('string')
    // Fourth dispatch: no second event, no inject, no mirror write.
    const mirrorBefore = { ...d.enforceMirror.get('root')! }
    const fourth = outcome(events, 1, d)
    expect(fourth.result).toEqual({ action: 'stall', claims: ['tests-green'] })
    expect(fourth.agent.injected).toHaveLength(0)
    expect(countOf(events, EXHAUSTED_EVENT)).toBe(1)
    expect(d.enforceMirror.get('root')).toEqual(mirrorBefore)
  })
})

describe('enforce mode: exits (§5 cases 4-5)', () => {
  it('case 4: retraction (phrase gone) ⇒ no-claim skip; an apology WITH the phrase ⇒ nudge again', () => {
    // Lexical retraction: the new final message simply drops the phrase.
    const retracted = [
      userMessage(), assistantClaim(1),
      userMessage('Completion gate (enforced): …', 'completion-gate'), assistantClaim(1, 'all good now'),
    ]
    expect(outcome(retracted, 1, deps({ mode: 'enforce' })).result)
      .toEqual({ action: 'skip', reason: 'no-claim' })

    // Lexical contract: an apology that still contains the phrase is NOT a retraction.
    const apology = [
      userMessage(), assistantClaim(1),
      userMessage('Completion gate (enforced): …', 'completion-gate'),
      assistantClaim(1, "you're right, tests pass was unverified"),
    ]
    const d = deps({ mode: 'enforce' })
    expect(outcome(apology, 1, d).result).toEqual({ action: 'nudge', claims: ['tests-green'] })
    expect(d.enforceMirror.get('root')).toEqual({ windowOrdinal: 1, spent: 1 })
  })

  it('case 5: an ok receipt satisfies; a failed execution does not', () => {
    const satisfied = [userMessage(), receiptEvent('bash', 'pnpm test', 'ok'), assistantClaim(1)]
    expect(outcome(satisfied, 1, deps({ mode: 'enforce' })).result)
      .toEqual({ action: 'skip', reason: 'satisfied' })

    const failed = [userMessage(), receiptEvent('bash', 'pnpm test', 'error'), assistantClaim(1)]
    const d = deps({ mode: 'enforce' })
    expect(outcome(failed, 1, d).result).toEqual({ action: 'nudge', claims: ['tests-green'] })
    expect(d.enforceMirror.get('root')).toEqual({ windowOrdinal: 1, spent: 1 })
  })
})

describe('enforce mode: suppression + budget matrix (§5 cases 6, 8)', () => {
  const gatedEvents = (): EvalEvent[] =>
    [userMessage(), assistantClaim(1), userMessage('Evidence check…', 'completion-gate'), assistantClaim(1)]

  it('case 6: nudge mode skips on its own nudge; enforce mode does not (only mode differs)', () => {
    expect(outcome(gatedEvents(), 1, deps({ 'nudges-per-session': 5 })).result)
      .toEqual({ action: 'skip', reason: 'suppressed' })
    expect(outcome(gatedEvents(), 1, deps({ mode: 'enforce' })).result)
      .toEqual({ action: 'nudge', claims: ['tests-green'] })
  })

  it('case 8: enforce nudges consume no advisory budget and write no latches', () => {
    // nudges-per-session: 0 does not stop enforce.
    const zero = deps({ mode: 'enforce', 'nudges-per-session': 0 })
    expect(outcome([userMessage(), assistantClaim(1)], 1, zero).result).toMatchObject({ action: 'nudge' })

    // Cycle-bearing NUDGE events are invisible to the advisory count.
    const events = [userMessage(), assistantClaim(1)]
    const enforceD = deps({ mode: 'enforce' })
    expect(outcome(events, 1, enforceD).result).toMatchObject({ action: 'nudge' })
    expect(enforceD.latches.size).toBe(0)
    const nudgeD = deps({ 'nudges-per-session': 1, latches: enforceD.latches })
    expect(outcome(events, 1, nudgeD).result).toMatchObject({ action: 'nudge' })
  })
})

describe('enforce mode: window-scoped budget (§5 case 9)', () => {
  it('plugin-origin turns cannot re-arm a fresh budget; a genuine user message can', () => {
    const events = [userMessage(), assistantClaim(1)]
    const d = deps({ mode: 'enforce', 'enforce-max-cycles': 1 })
    expect(outcome(events, 1, d).result).toMatchObject({ action: 'nudge' })

    // Turn 2 opens with a PLUGIN-origin user message — no new window.
    events.push(userMessage('checkpoint…', 'plugin'), assistantClaim(2))
    expect(outcome(events, 2, d).result).toEqual({ action: 'stall', claims: ['tests-green'] })
    // ...and a second plugin-origin turn still finds no fresh budget.
    events.push(userMessage('advisor note…', 'plugin'), assistantClaim(3))
    expect(outcome(events, 3, d).result).toEqual({ action: 'stall', claims: ['tests-green'] })

    // A GENUINE user message advances the window ⇒ fresh budget.
    events.push(userMessage('another ask'), assistantClaim(4))
    expect(outcome(events, 4, d).result).toEqual({ action: 'nudge', claims: ['tests-green'] })
    expect(events.filter(event => event.type === NUDGE_EVENT).map(event => event.data.cycle)).toEqual([1, 1])
  })
})

describe('enforce mode: mirror hygiene (§5 case 10)', () => {
  it('append-unavailable: the mirror alone advances the cycle (no re-inject of cycle 1)', () => {
    const events = [userMessage(), assistantClaim(1)]
    const session: any = { header: { id: 'root' }, snapshotEvents: () => events }
    const d = deps({ mode: 'enforce', 'enforce-max-cycles': 2 })
    const agent = fixtureAgent(session)
    expect(evaluateTurnStopping(agent, 1, d)).toMatchObject({ action: 'nudge' })
    expect(d.enforceMirror.get('root')).toEqual({ windowOrdinal: 1, spent: 1 })
    expect(evaluateTurnStopping(agent, 1, d)).toMatchObject({ action: 'nudge' })
    expect(d.enforceMirror.get('root')).toEqual({ windowOrdinal: 1, spent: 2 })
    // Budget exhausted without a single durable cycle event.
    expect(evaluateTurnStopping(agent, 1, d)).toEqual({ action: 'stall', claims: ['tests-green'] })
  })

  it('inject-failure consumes the cycle and marks the marker', () => {
    const events = [userMessage(), assistantClaim(1)]
    const session = fakeSession('root', events)
    const d = deps({ mode: 'enforce', 'enforce-max-cycles': 2 })
    let attempts = 0
    const agent = {
      session,
      inject: () => { attempts += 1; throw new Error('inject exploded') },
    } as unknown as EvalAgent
    expect(evaluateTurnStopping(agent, 1, d)).toMatchObject({ action: 'nudge' })
    expect(d.enforceMirror.get('root')).toEqual({ windowOrdinal: 1, spent: 1, lastInjectFailed: true })
    expect(evaluateTurnStopping(agent, 1, d)).toMatchObject({ action: 'nudge' })
    expect(attempts).toBe(2)
    expect(evaluateTurnStopping(agent, 1, d)).toEqual({ action: 'stall', claims: ['tests-green'] })
    // The record does not accuse a model that never saw the last-chance footer.
    expect(events.find(event => event.type === EXHAUSTED_EVENT)!.data.lastInjectFailed).toBe(true)
  })
})

describe('enforce mode: co-owner composition (§5 case 12)', () => {
  it('exhausted + a co-owner continuing the turn ⇒ stall, no inject, one exhaustion observation', () => {
    const events = [userMessage(), assistantClaim(1)]
    const d = deps({ mode: 'enforce', 'enforce-max-cycles': 1 })
    expect(outcome(events, 1, d).result).toMatchObject({ action: 'nudge' })
    // A denying Stop hook steered a continuation of the SAME turn.
    events.push(userMessage('Stop hook denial…', 'hooks-claude-code'), assistantClaim(1))
    const stall = outcome(events, 1, d)
    expect(stall.result).toEqual({ action: 'stall', claims: ['tests-green'] })
    expect(stall.agent.injected).toHaveLength(0)
    // Another co-owner pass in the same dispatch still records only ONE event.
    events.push(userMessage('Stop hook denial…', 'hooks-claude-code'), assistantClaim(1))
    expect(outcome(events, 1, d).result).toEqual({ action: 'stall', claims: ['tests-green'] })
    expect(countOf(events, EXHAUSTED_EVENT)).toBe(1)
  })
})

describe('enforce mode: aborted signal (§5 case 14)', () => {
  it('an aborted dispatch neither injects nor records exhaustion', () => {
    const events = [userMessage(), assistantClaim(1)]
    const agent = fixtureAgent(fakeSession('root', events))
    const exhaustedTurns = new Set<string>()
    const handler = createTurnStoppingHandler({
      readSettings: () => ({ ...DEFAULT_GATE_SETTINGS, enabled: true, mode: 'enforce' }),
      lineage: new LineageRegistry(),
      latches: new Map(),
      enforceMirror: new Map(),
      exhaustedTurns,
      debug: () => {},
    })
    const controller = new AbortController()
    controller.abort()
    handler({ agent, turn: 1, signal: controller.signal })
    expect(agent.injected).toHaveLength(0)
    expect(countOf(events, NUDGE_EVENT)).toBe(0)
    expect(countOf(events, EXHAUSTED_EVENT)).toBe(0)
    expect(exhaustedTurns.size).toBe(0)
  })
})

describe('enforce mode: lift outcomes (§5 case 15)', () => {
  function liftFixture(childOutcome: 'ok' | 'error'): { root: any; lineage: LineageRegistry } {
    const rootEvents: EvalEvent[] = [userMessage(), assistantClaim(1)]
    const root = fakeSession('root', rootEvents)
    const child = {
      id: 'child',
      header: { id: 'child', parentSession: 'root' },
      snapshotEvents: () => [],
    } as unknown as SessionLike
    const lineage = new LineageRegistry()
    lineage.witness(root)
    lineage.record(child, buildReceipt(
      { callId: 'c1', name: 'bash', arguments: { command: 'pnpm test' }, agent: { session: child } } as never,
      { isError: childOutcome === 'error', content: [{ type: 'text', text: 'ok' }] } as never,
      { headEnabled: true },
    ))
    return { root, lineage }
  }

  it('a failed child execution does not satisfy the claim', () => {
    const { root, lineage } = liftFixture('error')
    expect(evaluateTurnStopping(fixtureAgent(root), 1, deps({ mode: 'enforce', lineage })))
      .toEqual({ action: 'nudge', claims: ['tests-green'] })
  })

  it('an ok child execution satisfies the claim', () => {
    const { root, lineage } = liftFixture('ok')
    expect(evaluateTurnStopping(fixtureAgent(root), 1, deps({ mode: 'enforce', lineage })))
      .toEqual({ action: 'skip', reason: 'satisfied' })
  })
})
