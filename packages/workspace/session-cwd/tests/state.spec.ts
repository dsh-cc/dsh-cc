import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionCwdStore } from '../src/state.ts'
import { appendWorktreeEntered } from '../src/events.ts'

function session(): Session {
  return Session.create(SessionId(`state-${Math.random()}`))
}

describe('SessionCwdStore', () => {
  it('starts empty and resolves undefined', () => {
    const store = new SessionCwdStore()
    expect(store.get('s1')).toBeUndefined()
  })

  it('set then get returns the live value', () => {
    const store = new SessionCwdStore()
    store.set('s1', '/tmp/a')
    store.set('s2', '/tmp/b')
    expect(store.get('s1')).toBe('/tmp/a')
    expect(store.get('s2')).toBe('/tmp/b')
  })

  it('a later set overwrites the live value', () => {
    const store = new SessionCwdStore()
    store.set('s1', '/tmp/a')
    store.set('s1', '/tmp/c')
    expect(store.get('s1')).toBe('/tmp/c')
  })

  it('resolve prefers the live overlay over the event fold', () => {
    const store = new SessionCwdStore()
    const sess = session()
    appendWorktreeEntered(sess, '/tmp/from-log')
    store.set(String(sess.id), '/tmp/live')
    expect(store.resolve(String(sess.id), sess.snapshotEvents())).toBe('/tmp/live')
  })

  it('resolve falls through to the event fold without a live write', () => {
    const store = new SessionCwdStore()
    const sess = session()
    appendWorktreeEntered(sess, '/tmp/from-log')
    expect(store.resolve(String(sess.id), sess.snapshotEvents())).toBe('/tmp/from-log')
  })

  it('resolve returns undefined when neither layer recorded a cwd', () => {
    const store = new SessionCwdStore()
    const sess = session()
    expect(store.resolve(String(sess.id), sess.snapshotEvents())).toBeUndefined()
  })

  it('keys are per session: clearing one leaves others intact', () => {
    const store = new SessionCwdStore()
    store.set('s1', '/tmp/a')
    store.set('s2', '/tmp/b')
    store.clear('s1')
    expect(store.get('s1')).toBeUndefined()
    expect(store.get('s2')).toBe('/tmp/b')
  })
})
