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
import { RECEIPT_EVENT, type Receipt } from '../src/events.ts'
import {
  evaluateTurnStopping,
  maybeResolveOnReceipt,
  type EvalAgent,
  type EvalEvent,
} from '../src/evaluate.ts'
import { LineageRegistry, countGenuineUserMessages, type SessionLike } from '../src/lineage.ts'
import { buildReceipt } from '../src/receipts.ts'
import { DEFAULT_GATE_SETTINGS, type GateSettings } from '../src/settings.ts'

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

function deps(overrides?: Partial<GateSettings> & { lineage?: LineageRegistry; latches?: Map<string, number> }): {
  settings: GateSettings
  lineage: LineageRegistry
  latches: Map<string, number>
  debug: string[]
} {
  const debug: string[] = []
  return {
    settings: { ...DEFAULT_GATE_SETTINGS, enabled: true, ...overrides },
    lineage: overrides?.lineage ?? new LineageRegistry(),
    latches: overrides?.latches ?? new Map(),
    debug: (message: string) => debug.push(message),
  }
}

function userMessage(text = 'please finish', kind?: string): EvalEvent {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], ...(kind ? { source: { kind } } : {}) } }
}

function assistantClaim(turn: number, text = 'tests pass'): EvalEvent {
  return { type: 'assistant/message', data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

function receiptEvent(tool: string, head?: string): EvalEvent {
  const receipt = buildReceipt(
    { callId: 'c1', name: tool, arguments: { command: head ?? 'noop' }, agent: undefined } as never,
    { isError: false, content: [{ type: 'text', text: 'ok' }] } as never,
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
    lineage.record(child, { sessionId: 'child', tool: 'bash', head: 'pnpm test' })
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
