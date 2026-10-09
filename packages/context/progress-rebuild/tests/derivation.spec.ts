/**
 * Unit tests for the M1 progress-state projection fold (design §3.2/§5.1):
 * goal arm, verified-receipt arm, lastUser arm — pure fold over plain
 * SessionEvent fixtures, no live Session.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyProgressRebuild,
  CALL_INDEX_CAP,
  progressRebuildProjection,
  VERIFIED_RING_CAP,
  type ProgressRebuildState,
} from '../src/state.ts'

/** Fold a fixture event list through the registered unit, from `init`. */
function fold(events: SessionEvent[]): ProgressRebuildState {
  let state = progressRebuildProjection.init({ id: 's', createdAt: 0, origin: 'user' } as never, 0)
  for (const event of events) state = applyProgressRebuild(state, event)
  return state
}

let seqCounter = 0
/** Build one plain session event fixture (the fold only reads it). */
function ev(type: string, data: unknown, time = 1000): SessionEvent {
  return { type, seq: SessionSeq(++seqCounter), time, data } as unknown as SessionEvent
}

/** A `goal/change` snapshot event per the domain shape (§3.2 footnote 1). */
function goalChange(operation: string, goalOverrides: Record<string, unknown> = {}): SessionEvent {
  const phase = ({
    create: 'active',
    edit: 'active',
    pause: 'paused',
    resume: 'active',
    block: 'blocked',
    complete: 'complete',
  } as Record<string, string>)[operation]
  return ev('goal/change', {
    kind: 'goal/change',
    version: 1,
    operation,
    goal: {
      id: 'goal-1',
      revision: 1,
      objective: 'ship slice B',
      maxGoalRounds: 5,
      ...(phase === undefined ? {} : { phase }),
      ...goalOverrides,
    },
    roundsStarted: 0,
    createdAt: 100,
    updatedAt: 100,
  })
}

/** A `tool/call` + `tool/result` pair. */
function bashPair(
  callId: string,
  command: string,
  resultText: string,
  opts: { isError?: boolean; name?: string; args?: string } = {},
): SessionEvent[] {
  return [
    ev('tool/call', {
      turn: 1,
      step: 1,
      callId,
      name: opts.name ?? 'bash',
      arguments: opts.args ?? JSON.stringify({ command }),
    }),
    ev('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'm-' + callId,
        role: 'tool',
        content: [{ type: 'text', text: resultText }],
        source: { kind: 'tool', callId },
        toolCallId: callId,
        ...(opts.isError === true ? { isError: true } : {}),
      },
    }, 2000),
  ]
}

/** A user/message event. */
function userMessage(text: string, source?: { kind: string } & Record<string, unknown>): SessionEvent {
  return ev('user/message', {
    id: 'u-' + ++seqCounter,
    role: 'user',
    content: text === '' ? [] : [{ type: 'text', text }],
    ...(source === undefined ? {} : { source }),
  })
}

describe('goal arm (harness canonical fold)', () => {
  it('create records the active objective', () => {
    const state = fold([goalChange('create')])
    expect(state.goal.failure).toBeNull()
    expect(state.goal.current).toMatchObject({ goal: { id: 'goal-1', objective: 'ship slice B', phase: 'active' } })
  })

  it.each([
    ['edit', { revision: 2, objective: 'ship slice B faster' }, 'ship slice B faster'],
    ['pause', { revision: 2, phase: 'paused' }, 'ship slice B'],
    ['resume', { revision: 2, phase: 'active' }, 'ship slice B'],
    ['complete', { revision: 2, phase: 'complete' }, 'ship slice B'],
    ['block', { revision: 2, phase: 'blocked', blockedReason: { code: 'blocked', message: 'waiting on review' } }, 'ship slice B'],
  ])('%s snapshot updates the goal through the fold', (operation, goalOverrides, expected) => {
    const state = fold([goalChange('create'), goalChange(operation, goalOverrides)])
    expect(state.goal.failure).toBeNull()
    expect(state.goal.current?.goal.objective).toBe(expected)
  })

  it('clear tombstone clears the current goal', () => {
    const state = fold([
      goalChange('create'),
      ev('goal/change', {
        kind: 'goal/change',
        version: 1,
        operation: 'clear',
        cleared: { id: 'goal-1', revision: 2 },
        clearedAt: 200,
      }),
    ])
    expect(state.goal.failure).toBeNull()
    expect(state.goal.current).toBeNull()
  })

  it('a goal-round user/message advances the round counter', () => {
    const state = fold([
      goalChange('create'),
      ev('user/message', {
        id: 'round-1',
        role: 'user',
        content: [{ type: 'text', text: 'continue' }],
        source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 1 },
      }),
    ])
    expect(state.goal.failure).toBeNull()
    expect(state.goal.current).not.toBeNull()
  })

  it('a malformed goal round latches failure ("goal state unavailable" on render)', () => {
    const state = fold([
      goalChange('create'),
      ev('user/message', {
        id: 'round-bad',
        role: 'user',
        content: [{ type: 'text', text: 'continue' }],
        source: { kind: 'goal', goalId: 'goal-1', revision: 1, round: 3 },
      }),
    ])
    expect(state.goal.failure).not.toBeNull()
    expect(state.goal.failure).toContain('goal replay failed')
  })
})

describe('verified arm (§3.2 verified row)', () => {
  it('clean exit-0 result (no marker) becomes a receipt', () => {
    const state = fold(bashPair('c1', 'pnpm test', 'all green\n'))
    expect(state.verified).toHaveLength(1)
    expect(state.verified[0]).toEqual({ ts: 2000, callId: 'c1', commandHead: 'pnpm test' })
  })

  it.each([
    ['[exit code: 1]', 'exit code marker'],
    ['done\n[exit code: 1]', 'trailing exit marker'],
    ['[timed out after 5000ms]', 'timed out (even exit-0)'],
    ['[stopped: cancelled by user]', 'stopped'],
    ['[killed by signal: SIGKILL]', 'killed by signal'],
    ['[still running after 30000ms] promoted', 'promoted still-running'],
  ])('%s tail → not a receipt (%s)', (tail) => {
    const state = fold(bashPair('c1', 'pnpm test', tail))
    expect(state.verified).toHaveLength(0)
  })

  it('background-start ack (run_in_background) → markerless ack text is not a receipt', () => {
    const state = fold(bashPair('c1', 'sleep 10', 'started background job j1', {
      args: JSON.stringify({ command: 'sleep 10', run_in_background: true }),
    }))
    expect(state.verified).toHaveLength(0)
  })

  it('isError result → not a receipt', () => {
    const state = fold(bashPair('c1', 'pnpm test', 'ok', { isError: true }))
    expect(state.verified).toHaveLength(0)
  })

  it('non-bash tool (read) → not a receipt', () => {
    const state = fold(bashPair('c1', 'src/index.ts', 'file body', { name: 'read' }))
    expect(state.verified).toHaveLength(0)
  })

  it.each([
    ['pnpm test; true', 'semicolon'],
    ['pnpm test &', 'trailing &'],
    ['cd x && pnpm test', '&&'],
    ['pnpm test\necho done', 'newline'],
    ['echo $(date)', 'substitution'],
    ['echo `date`', 'backtick'],
    ['pnpm test | tee log', 'pipe'],
  ])('command %s (%s) → not a receipt', (command) => {
    const state = fold(bashPair('c1', command, 'all green'))
    expect(state.verified).toHaveLength(0)
  })

  it('run_in_background: true → not a receipt', () => {
    const state = fold(bashPair('c1', 'pnpm test', 'all green', {
      args: JSON.stringify({ command: 'pnpm test', run_in_background: true }),
    }))
    expect(state.verified).toHaveLength(0)
  })

  it('microcompact re-append of the same callId yields a single receipt', () => {
    const events = [
      ...bashPair('c1', 'pnpm test', 'all green'),
      // replacement re-append of the same result (compaction-micro)
      ev('tool/result', {
        turn: 1,
        step: 1,
        message: {
          id: 'm-c1',
          role: 'tool',
          content: [{ type: 'text', text: 'all green' }],
          source: { kind: 'tool', callId: 'c1' },
          toolCallId: 'c1',
        },
      }, 3000),
    ]
    const state = fold(events)
    expect(state.verified).toHaveLength(1)
  })

  it('duplicate tool/call with the same callId keeps the FIRST record', () => {
    const state = fold([
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) }),
      ev('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ command: 'x' }) }),
      ...bashPair('c1', 'unused', 'all green').slice(1),
    ])
    expect(state.verified).toHaveLength(1)
    expect(state.callIndex[0]?.name).toBe('bash')
  })

  it('receipt ring caps at 20, dropping the oldest', () => {
    const events: SessionEvent[] = []
    for (let i = 0; i < VERIFIED_RING_CAP + 5; i++) events.push(...bashPair(`c${i}`, `cmd-${i}`, 'ok'))
    const state = fold(events)
    expect(state.verified).toHaveLength(VERIFIED_RING_CAP)
    expect(state.verified[0]?.callId).toBe(`c${5}`)
    expect(state.verified.at(-1)?.callId).toBe(`c${VERIFIED_RING_CAP + 4}`)
  })

  it('callIndex LRU caps at 512, dropping the oldest', () => {
    const events: SessionEvent[] = []
    for (let i = 0; i < CALL_INDEX_CAP + 10; i++) {
      events.push(ev('tool/call', { turn: 1, step: 1, callId: `k${i}`, name: 'bash', arguments: JSON.stringify({ command: `cmd-${i}` }) }))
    }
    const state = fold(events)
    expect(state.callIndex).toHaveLength(CALL_INDEX_CAP)
    expect(state.callIndex[0]?.callId).toBe(`k${CALL_INDEX_CAP + 10 - CALL_INDEX_CAP}`)
    expect(state.callIndex.at(-1)?.callId).toBe(`k${CALL_INDEX_CAP + 9}`)
  })

  it('malformed arguments JSON → no receipt and no throw', () => {
    const state = fold(bashPair('c1', 'ignored', 'all green', { args: '{not json' }))
    expect(state.verified).toHaveLength(0)
  })
})

describe('todos arm', () => {
  it('latest todo/write snapshot replaces verbatim; null before first write', () => {
    const initial = fold([])
    expect(initial.todos).toBeNull()
    const first = fold([ev('todo/write', { todos: [{ content: 'a', status: 'pending' }] })])
    expect(first.todos).toEqual([{ content: 'a', status: 'pending' }])
    const second = fold([ev('todo/write', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] })])
    expect(second.todos).toHaveLength(2)
  })
})

describe('lastUser arm (genuine-user rule)', () => {
  it('source-less user message is recorded (first 200 chars, ts, seq)', () => {
    const state = fold([userMessage('hello world')])
    expect(state.lastUser).toEqual({ ts: 1000, seq: String(state.lastUser?.seq), text: 'hello world' })
    expect(state.lastUser?.text).toBe('hello world')
  })

  it("source kind 'user' is recorded", () => {
    const state = fold([userMessage('from user', { kind: 'user' })])
    expect(state.lastUser?.text).toBe('from user')
  })

  it("source kind 'compact-checkpoint' is ignored", () => {
    const state = fold([userMessage('checkpoint', { kind: 'compact-checkpoint' })])
    expect(state.lastUser).toBeNull()
  })

  it("source kind 'progress-rebuild' is ignored", () => {
    const state = fold([userMessage('brief', { kind: 'progress-rebuild' })])
    expect(state.lastUser).toBeNull()
  })

  it('user message with no non-empty text block is ignored', () => {
    const state = fold([userMessage('')])
    expect(state.lastUser).toBeNull()
  })
})
