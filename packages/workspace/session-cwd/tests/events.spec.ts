import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import { WORKTREE_ENTERED_EVENT, foldSessionCwd } from '../src/events.ts'

function session(): Session {
  return Session.create(SessionId(`cwd-${Math.random()}`))
}

/** Append a legacy cwd event through the widened wire face (no writer API). */
function appendEntered(sess: Session, path: string): void {
  ;(sess.append as unknown as (type: string, payload: { path: string }) => unknown)(WORKTREE_ENTERED_EVENT, { path })
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
    expect(foldSessionCwd(session().snapshotEvents())).toBeUndefined()
  })

  it('folds the last-entered path (last-wins)', () => {
    const sess = session()
    appendEntered(sess, '/tmp/first')
    appendEntered(sess, '/tmp/second')
    expect(foldSessionCwd(sess.snapshotEvents())).toBe('/tmp/second')
  })

  it('folds through unrelated interleaved events', () => {
    const sess = session()
    sess.append('turn/start', { turn: 1 })
    appendEntered(sess, '/tmp/worktree')
    sess.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(foldSessionCwd(sess.snapshotEvents())).toBe('/tmp/worktree')
  })

  it('reads {path} payloads from the log', () => {
    const sess = session()
    appendEntered(sess, '/tmp/worktree')
    const event = sess.eventAt(sess.seq - 1)!
    expect(event.type).toBe('worktree/entered')
    expect(event.data).toEqual({ path: '/tmp/worktree' })
  })

  it('ignores malformed entered events during the fold', () => {
    const sess = session()
    ;(sess.append as unknown as (type: string, payload: unknown) => void)('worktree/entered', {})
    appendEntered(sess, '/tmp/valid')
    expect(foldSessionCwd(sess.snapshotEvents())).toBe('/tmp/valid')
  })
})
