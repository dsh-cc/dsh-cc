import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  foldPermissionMode,
  foldResumeSandbox,
  setPermissionMode,
} from '../src/mode.ts'

function session(): Session {
  return Session.create(SessionId(`mode-${Math.random()}`))
}

describe('permission/mode session coupling', () => {
  it('registers permission/mode into KNOWN_SESSION_EVENT_TYPES at module load', () => {
    expect((KNOWN_SESSION_EVENT_TYPES as Set<string>).has('permission/mode')).toBe(true)
  })

  it('folds undefined from an empty log', () => {
    const sess = session()
    expect(foldPermissionMode(sess.snapshotEvents())).toBeUndefined()
    expect(foldResumeSandbox(sess.snapshotEvents())).toBeUndefined()
  })

  it('folds the last-written mode (default then acceptEdits wins)', () => {
    const sess = session()
    setPermissionMode(sess, 'default')
    setPermissionMode(sess, 'acceptEdits')
    expect(foldPermissionMode(sess.snapshotEvents())).toBe('acceptEdits')
  })

  it('folds through unrelated interleaved events', () => {
    const sess = session()
    sess.append('turn/start', { turn: 1 })
    setPermissionMode(sess, 'acceptEdits')
    sess.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(foldPermissionMode(sess.snapshotEvents())).toBe('acceptEdits')
  })

  it('appends {mode} without resumeSandbox when none is provided', () => {
    const sess = session()
    setPermissionMode(sess, 'auto')
    const event = sess.snapshotEvents()[sess.seq - 1]!
    expect(event.type).toBe('permission/mode')
    expect(event.data).toEqual({ mode: 'auto' })
    expect('resumeSandbox' in event.data).toBe(false)
  })

  it('records resumeSandbox when entering bypassPermissions', () => {
    const sess = session()
    setPermissionMode(sess, 'bypassPermissions', 'workspace-write')
    const event = sess.snapshotEvents()[sess.seq - 1]!
    expect(event.data).toEqual({ mode: 'bypassPermissions', resumeSandbox: 'workspace-write' })
  })

  it('foldResumeSandbox returns the most recent bypass event resume even past a later switchable event', () => {
    const sess = session()
    setPermissionMode(sess, 'bypassPermissions', 'read-only')
    setPermissionMode(sess, 'acceptEdits')
    expect(foldResumeSandbox(sess.snapshotEvents())).toBe('read-only')
  })

  it('throws for the reserved plan mode', () => {
    const sess = session()
    expect(() => setPermissionMode(sess, 'plan' as never)).toThrow(TypeError)
  })

  it('throws for an unknown mode', () => {
    const sess = session()
    expect(() => setPermissionMode(sess, 'bogus' as never)).toThrow(TypeError)
  })
})
