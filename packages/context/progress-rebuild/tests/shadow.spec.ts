/**
 * Shadow-reducer unit tests (design §5 items 1 and 3, spec pins 1-4): goal
 * seven-operation fixtures (clear tombstone included), todo whole-list
 * replacement, exit-marker three-state verified derivation, isError
 * exclusion, and the lastUser allowlist.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { applyEvent, createShadow, VERIFIED_CAP, todoMark } from '../src/shadow.ts'
import { isProofCommand, parseExitMarker, proofClass } from '../src/receipts.ts'

/** Build a minimal SessionEvent fixture (loose cast — shapes pin §3.2 data). */
function ev<K extends keyof SessionEventMap>(
  type: K,
  time: number,
  data: unknown,
): SessionEvent<K> {
  return { type, seq: 0, time, data } as unknown as SessionEvent<K>
}

const goal = (operation: string, phase = 'active') =>
  ev('goal/change', 1000, {
    kind: 'goal/change', version: 1, operation, goal: { id: 'goal-1', revision: 1, objective: 'ship the thing', phase }, roundsStarted: 0, createdAt: 1, updatedAt: 1,
  })

describe('receipts', () => {
  it('parses the exit marker; missing marker → null', () => {
    expect(parseExitMarker('out\n[exit code: 0]')).toBe(0)
    expect(parseExitMarker('out\n[exit code: 3]')).toBe(3)
    expect(parseExitMarker('no marker here')).toBeNull()
  })

  it('classifies proof commands by the first 4 tokens; git commit as a pair', () => {
    expect(isProofCommand('npx vitest run')).toBe(true)
    expect(isProofCommand('npm test')).toBe(true)
    expect(isProofCommand('pnpm build')).toBe(true)
    expect(isProofCommand('eslint src')).toBe(true)
    expect(isProofCommand('git commit -m "x"')).toBe(true)
    expect(isProofCommand('cat file.txt')).toBe(false)
    expect(proofClass('git commit -m x')).toBe('git-commit')
    expect(proofClass('PRESUBMIT later args')).toBe('presubmit')
  })
})

describe('goal/change derivation (all seven operations)', () => {
  it('create sets an active goal', () => {
    const next = applyEvent(createShadow(), goal('create'))
    expect(next.goal).toEqual({ objective: 'ship the thing', phase: 'active', active: true })
  })

  it('edit/resume update the objective and keep the goal active', () => {
    let shadow = applyEvent(createShadow(), goal('create'))
    shadow = applyEvent(shadow, goal('edit', 'review'))
    expect(shadow.goal).toEqual({ objective: 'ship the thing', phase: 'review', active: true })
    shadow = applyEvent(shadow, goal('pause'))
    expect(shadow.goal?.active).toBe(false)
    shadow = applyEvent(shadow, goal('resume'))
    expect(shadow.goal?.active).toBe(true)
  })

  it('pause keeps the goal, inactive; block forces phase blocked', () => {
    let shadow = applyEvent(createShadow(), goal('create'))
    shadow = applyEvent(shadow, goal('pause', 'active'))
    expect(shadow.goal).toEqual({ objective: 'ship the thing', phase: 'active', active: false })
    shadow = applyEvent(shadow, goal('block'))
    expect(shadow.goal).toEqual({ objective: 'ship the thing', phase: 'blocked', active: false })
  })

  it('complete nulls the goal', () => {
    let shadow = applyEvent(createShadow(), goal('create'))
    shadow = applyEvent(shadow, goal('complete'))
    expect(shadow.goal).toBeUndefined()
  })

  it('clear TOMBSTONE (no goal member) nulls the goal — discriminated on operation', () => {
    let shadow = applyEvent(createShadow(), goal('create'))
    const tombstone = ev('goal/change', 2000, { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'goal-1' }, clearedAt: 2000 })
    shadow = applyEvent(shadow, tombstone)
    expect(shadow.goal).toBeUndefined()
  })

  it('a clear tombstone on an empty shadow stays empty (absence tolerance)', () => {
    const shadow = applyEvent(createShadow(), ev('goal/change', 1, { kind: 'goal/change', version: 1, operation: 'clear', cleared: { id: 'g' }, clearedAt: 1 }))
    expect(shadow.goal).toBeUndefined()
  })
})

describe('todo/write whole-list snapshot', () => {
  it('later writes REPLACE, never patch', () => {
    let shadow = applyEvent(createShadow(), ev('todo/write', 10, { todos: [{ content: 'a', status: 'pending' }] }))
    expect(shadow.todos).toEqual([{ content: 'a', status: 'pending' }])
    shadow = applyEvent(shadow, ev('todo/write', 20, { todos: [{ content: 'b', status: 'in_progress' }, { content: 'c', status: 'completed' }] }))
    expect(shadow.todos).toEqual([
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'completed' },
    ])
    expect(todoMark(shadow.todos[1]!)).toBe('[x]')
    expect(todoMark(shadow.todos[0]!)).toBe('[ ]')
  })
})

describe('verified receipts (exit-marker three-state, fail-closed)', () => {
  const bash = (command: string, callId = 'c1') =>
    ev('tool/call', 10, { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) })
  const result = (text: string, isError?: boolean, callId = 'c1') =>
    ev('tool/result', 20, {
      turn: 1, step: 1,
      message: { id: 'm1', role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text }], isError },
    })

  it('exit code 0 on a proof command IS verified', () => {
    let shadow = applyEvent(createShadow(), bash('npx vitest run packages/x'))
    shadow = applyEvent(shadow, result('ok\n[exit code: 0]'))
    expect(shadow.verified).toHaveLength(1)
    expect(shadow.verified[0]!.label).toBe('tests green (vitest)')
    expect(shadow.verified[0]!.ts).toBe(20)
    expect(shadow.pendingBash.size).toBe(0)
  })

  it('non-zero exit is NOT verified (plain result, not isError)', () => {
    let shadow = applyEvent(createShadow(), bash('npx vitest run'))
    shadow = applyEvent(shadow, result('failed\n[exit code: 1]'))
    expect(shadow.verified).toHaveLength(0)
  })

  it('marker absent is NOT verified (fail-closed)', () => {
    let shadow = applyEvent(createShadow(), bash('npx vitest run'))
    shadow = applyEvent(shadow, result('all good, trust me'))
    expect(shadow.verified).toHaveLength(0)
  })

  it('isError results are excluded even with a 0 marker (infrastructure failure)', () => {
    let shadow = applyEvent(createShadow(), bash('npx vitest run'))
    shadow = applyEvent(shadow, result('...\n[exit code: 0]', true))
    expect(shadow.verified).toHaveLength(0)
  })

  it('non-proof commands with exit 0 are NOT receipts', () => {
    let shadow = applyEvent(createShadow(), bash('cat package.json'))
    shadow = applyEvent(shadow, result('json\n[exit code: 0]'))
    expect(shadow.verified).toHaveLength(0)
  })

  it('unmatched results and malformed arguments are tolerated', () => {
    let shadow = applyEvent(createShadow(), result('...\n[exit code: 0]'))
    expect(shadow.verified).toHaveLength(0)
    shadow = applyEvent(shadow, ev('tool/call', 10, { callId: 'c2', name: 'bash', arguments: '{oops' }))
    expect(shadow.pendingBash.size).toBe(0)
  })

  it('ring caps verified at 20, newest kept', () => {
    let shadow = createShadow()
    for (let i = 0; i < VERIFIED_CAP + 5; i++) {
      shadow = applyEvent(shadow, bash(`npx vitest run ${i}`, `c${i}`))
      shadow = applyEvent(shadow, result(`ok\n[exit code: 0]`, undefined, `c${i}`))
    }
    expect(shadow.verified).toHaveLength(VERIFIED_CAP)
    expect(shadow.verified.at(-1)!.command).toBe('npx vitest run 24')
  })
})

describe('lastUser allowlist (pin 4)', () => {
  const userMessage = (kind: string, text: string, ts = 5) =>
    ev('user/message', ts, { content: [{ type: 'text', text }], source: { kind } })

  it("kind 'user' updates lastUser with first 200 chars", () => {
    const long = 'x'.repeat(300)
    const shadow = applyEvent(createShadow(), userMessage('user', long, 42))
    expect(shadow.lastUserTs).toBe(42)
    expect(shadow.lastUserText).toHaveLength(200)
  })

  it('injected kinds NEVER update lastUser (allowlist, not denylist)', () => {
    let shadow = applyEvent(createShadow(), userMessage('user', 'real prompt'))
    for (const kind of ['compact-checkpoint', 'compaction-micro', 'compaction-cost-gate', 'cc-shell-glue', 'memory', 'advisor', 'turn-rules', 'plugin', 'progress-rebuild']) {
      shadow = applyEvent(shadow, userMessage(kind, `injected ${kind}`, 99))
    }
    expect(shadow.lastUserTs).toBe(5)
    expect(shadow.lastUserText).toBe('real prompt')
  })

  it('self-pollution: the brief injected later as a user/message is ignored', () => {
    let shadow = applyEvent(createShadow(), userMessage('user', 'do the work', 7))
    // Apply a normal event after: shadow remains non-degenerate, then the
    // plugin's own injected message arrives with kind 'progress-rebuild'.
    shadow = applyEvent(shadow, ev('todo/write', 8, { todos: [{ content: 't', status: 'pending' }] }))
    shadow = applyEvent(shadow, userMessage('progress-rebuild', '## Resume after compaction …', 9))
    expect(shadow.lastUserTs).toBe(7)
    expect(shadow.lastUserText).toBe('do the work')
    expect(shadow.todos).toHaveLength(1)
  })

  it('the reducer is copy-on-write: the input shadow is never mutated', () => {
    const shadow = createShadow()
    const next = applyEvent(shadow, goal('create'))
    expect(shadow.goal).toBeUndefined()
    expect(next.goal).toBeDefined()
    expect(shadow).not.toBe(next)
  })
})
