import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import { WORKTREE_ENTERED_EVENT, appendWorktreeEntered, foldSessionCwd } from '../src/events.ts'
import { EMPTY_SESSION_CWD_STATE, foldSessionCwdState, reduceSessionCwdState } from '../src/state.ts'

function session(): Session {
  return Session.create(SessionId(`cwd-${Math.random()}`))
}

describe('worktree/entered event registration', () => {
  it('registers worktree/entered into KNOWN_SESSION_EVENT_TYPES at module load', () => {
    expect((KNOWN_SESSION_EVENT_TYPES as Set<string>).has(WORKTREE_ENTERED_EVENT)).toBe(true)
  })

  it('uses the documented event type string', () => {
    expect(WORKTREE_ENTERED_EVENT).toBe('worktree/entered')
  })
})

describe('worktree/entered folding', () => {
  it('folds undefined from an empty log', () => {
    const sess = session()
    expect(foldSessionCwd(sess.snapshotEvents())).toBeUndefined()
  })

  it('folds the last-entered path (last-wins)', () => {
    const sess = session()
    appendWorktreeEntered(sess, '/tmp/first')
    appendWorktreeEntered(sess, '/tmp/second')
    expect(foldSessionCwd(sess.snapshotEvents())).toBe('/tmp/second')
  })

  it('folds through unrelated interleaved events', () => {
    const sess = session()
    sess.append('turn/start', { turn: 1 })
    appendWorktreeEntered(sess, '/tmp/worktree')
    sess.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(foldSessionCwd(sess.snapshotEvents())).toBe('/tmp/worktree')
  })

  it('appends {path} payloads readable from the log', () => {
    const sess = session()
    appendWorktreeEntered(sess, '/tmp/worktree')
    const event = sess.eventAt(sess.seq - 1)!
    expect(event.type).toBe('worktree/entered')
    expect(event.data).toEqual({ path: '/tmp/worktree' })
  })

  it('ignores malformed entered events during the fold', () => {
    const sess = session()
    ;(sess.append as unknown as (type: string, payload: unknown) => void)('worktree/entered', {})
    appendWorktreeEntered(sess, '/tmp/valid')
    expect(foldSessionCwd(sess.snapshotEvents())).toBe('/tmp/valid')
  })
})

describe('foldable cwd state', () => {
  it('reduces only worktree/entered events', () => {
    const state = reduceSessionCwdState(EMPTY_SESSION_CWD_STATE, { type: 'turn/start', data: {} } as never)
    expect(state).toBe(EMPTY_SESSION_CWD_STATE)
  })

  it('reduces an entered event into the cwd', () => {
    const state = reduceSessionCwdState(EMPTY_SESSION_CWD_STATE, { type: 'worktree/entered', data: { path: '/tmp/wt' } } as never)
    expect(state).toEqual({ cwd: '/tmp/wt' })
  })

  it('folds a whole log into the final state', () => {
    const sess = session()
    appendWorktreeEntered(sess, '/tmp/a')
    appendWorktreeEntered(sess, '/tmp/b')
    expect(foldSessionCwdState(sess.snapshotEvents())).toEqual({ cwd: '/tmp/b' })
  })

  it('folds an empty log to the empty state', () => {
    expect(foldSessionCwdState([])).toEqual(EMPTY_SESSION_CWD_STATE)
  })
})
