import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
// Type-only: the `compaction/prune` shadow-price SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-compaction'
import { attemptSwap } from '../src/defer/swap.ts'
import type { ResidentEntry } from '../src/defer/residents.ts'

/**
 * F-4 (PR #298 TLA+ finding): "defer swap's prune and tool/result append are
 * two persistence points; a crash between them leaves an orphan prune with the
 * token accounting already deducted."
 *
 * These tests inject the crash between the two appends of `attemptSwap` and
 * measure with the REAL token meter. They pin why the finding does not hold:
 * the shadow-price fold arms a claim on `compaction/prune` with delta 0 and
 * debits only when the adjacent surface `replace` consumes it, so an orphan
 * prune deducts nothing; the resident stays swappable and the retry on resume
 * debits exactly once.
 */

const MODEL = 'test-model'
const FULL = 'full deferred body '.repeat(40)
const STUB = 'stub body\n[dsh-cc compressed 100→10 tokens. Original: ccr://a1b2c3d4e5f60708]'

function estimate(message: Message): number {
  return JSON.stringify(message.content).length
}

function meter(): TokenMeter {
  const ctx = new Context()
  void new SessionProjectionRegistry(ctx)
  return new TokenMeter(ctx)
}

function fixture(id: string): { session: Session; seq: number } {
  const s = Session.create(SessionId(id))
  const callId = ToolCallId('call-1')
  s.append('turn/start', { turn: 1 })
  s.append('step/start', { turn: 1, step: 1 })
  s.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
    }),
  }, { surfaceOp: 'append' })
  s.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
  const result = s.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: FULL }], isError: false }),
  }, { surfaceOp: 'append' })
  s.append('step/end', { turn: 1, step: 1 })
  s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { session: s, seq: result.seq }
}

function entry(): ResidentEntry {
  return {
    hash: 'a1b2c3d4e5f60708',
    callId: ToolCallId('call-1'),
    sentCount: 3,
    tokensSaved: 100,
    createdAt: Date.now(),
  }
}

function swap(session: Session) {
  return attemptSwap({
    session,
    entry: entry(),
    fullText: FULL,
    stubText: STUB,
    apply: true,
    margin: 1.5,
    remainingRequestsEstimate: 1,
    estimateMessage: estimate,
  })
}

/** Crash the process the moment `attemptSwap` issues its second append. */
function crashOnNthAppend(session: Session, n: number): () => void {
  const real = session.append.bind(session) as (...args: unknown[]) => unknown
  let calls = 0
  ;(session as unknown as { append: (...args: unknown[]) => unknown }).append = (...args: unknown[]) => {
    calls += 1
    if (calls === n) throw new Error('simulated crash between prune and replace')
    return real(...args)
  }
  return () => { (session as unknown as { append: unknown }).append = real }
}

describe('F-4: crash between the swap prune and its replace', () => {
  it('an orphan prune deducts nothing and leaves the surface byte-for-byte unswapped', () => {
    const tokenMeter = meter()
    const { session } = fixture('swap-crash-1')
    const before = tokenMeter.measure(session)

    crashOnNthAppend(session, 2)
    expect(() => swap(session)).toThrow('simulated crash')

    const log = session.snapshotEvents()
    expect(log.some((e) => e.type === 'compaction/prune')).toBe(true) // orphan is really there
    expect(log.at(-1)?.type).toBe('compaction/prune') // ...and no replace followed it

    const after = tokenMeter.measure(session)
    // No deduction: the metered surface is exactly the pre-swap surface.
    expect(after.surfaceTokens).toBe(before.surfaceTokens)
    expect(after.nodes.map((n) => n.tokens)).toEqual(before.nodes.map((n) => n.tokens))
  })

  it('resume re-attempts the swap and the debit lands exactly once (orphan prune stays inert)', () => {
    const tokenMeter = meter()
    // Control: one clean swap on an identical session.
    const control = fixture('swap-crash-control')
    const untouched = tokenMeter.measure(control.session).surfaceTokens
    expect(swap(control.session).outcome).toBe('applied')
    const cleanTotal = tokenMeter.measure(control.session).surfaceTokens
    expect(cleanTotal).toBeLessThan(untouched)

    // Crash, then resume on the same persisted log and retry.
    const { session } = fixture('swap-crash-2')
    const restore = crashOnNthAppend(session, 2)
    expect(() => swap(session)).toThrow('simulated crash')
    restore()
    expect(swap(session).outcome).toBe('applied')

    // Exactly one deduction: same total as the clean run, never double-debited.
    expect(tokenMeter.measure(session).surfaceTokens).toBe(cleanTotal)
    const prunes = session.snapshotEvents().filter((e) => e.type === 'compaction/prune')
    expect(prunes).toHaveLength(2) // the orphan + the healing one
  })

  it('a crash before the prune append changes nothing at all', () => {
    const tokenMeter = meter()
    const { session } = fixture('swap-crash-3')
    const before = tokenMeter.measure(session).surfaceTokens
    const eventsBefore = session.snapshotEvents().length
    crashOnNthAppend(session, 1)
    expect(() => swap(session)).toThrow('simulated crash')
    expect(session.snapshotEvents()).toHaveLength(eventsBefore)
    expect(tokenMeter.measure(session).surfaceTokens).toBe(before)
  })
})
