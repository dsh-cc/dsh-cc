import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  SESSION_ALLOW_EVENT,
  SessionAllowlist,
  appendSessionAllow,
  foldSessionAllows,
} from '../src/session-allowlist.ts'

function session(id = `allow-${Math.random()}`): Session {
  return Session.create(SessionId(id))
}

/** The last appended event through the extended face. */
function lastEvent(sess: Session): { type: string; data: Record<string, unknown> } {
  const event = sess.snapshotEvents()[sess.seq - 1]!
  return event as unknown as { type: string; data: Record<string, unknown> }
}

describe('session-scoped allowlist', () => {
  it('registers permission/session-allow into KNOWN_SESSION_EVENT_TYPES at module load', () => {
    expect((KNOWN_SESSION_EVENT_TYPES as Set<string>).has(SESSION_ALLOW_EVENT)).toBe(true)
  })

  it('add grants a whole-tool rule scoped to the granting session only', () => {
    const allowlist = new SessionAllowlist()
    const sess = session()
    allowlist.add(sess, 'Bash')
    expect(allowlist.matches(String(sess.id), 'Bash', undefined)).toBe(true)
    expect(allowlist.matches('another-session', 'Bash', undefined)).toBe(false)
  })

  it('add appends a permission/session-allow audit event with timestamp and rule', () => {
    const allowlist = new SessionAllowlist()
    const sess = session()
    const before = Date.now()
    allowlist.add(sess, 'Bash(npm )')
    const event = lastEvent(sess)
    expect(event.type).toBe(SESSION_ALLOW_EVENT)
    expect(event.data.rule).toBe('Bash(npm )')
    expect(event.data.scope).toBe('session')
    expect(event.data.toolName).toBe('Bash')
    expect((event.data.timestamp as number) >= before).toBe(true)
  })

  it('matches a content rule against the call subject', () => {
    const allowlist = new SessionAllowlist()
    const sess = session()
    allowlist.add(sess, 'Bash(npm )')
    expect(allowlist.matches(String(sess.id), 'Bash', 'npm install')).toBe(true)
    expect(allowlist.matches(String(sess.id), 'Bash', 'npmx install')).toBe(false)
    expect(allowlist.matches(String(sess.id), 'Bash', undefined)).toBe(false)
  })

  it('add is idempotent per rule', () => {
    const allowlist = new SessionAllowlist()
    const sess = session()
    allowlist.add(sess, 'Bash')
    allowlist.add(sess, 'Bash')
    expect(allowlist.rulesOf(String(sess.id))).toHaveLength(1)
  })

  it('clear drops the session rules and appends an audited clear record', () => {
    const allowlist = new SessionAllowlist()
    const sess = session()
    allowlist.add(sess, 'Bash')
    allowlist.clear(sess)
    expect(allowlist.matches(String(sess.id), 'Bash', undefined)).toBe(false)
    expect(allowlist.rulesOf(String(sess.id))).toHaveLength(0)
    const event = lastEvent(sess)
    expect(event.type).toBe(SESSION_ALLOW_EVENT)
    expect(event.data.cleared).toBe(true)
  })

  it('clear on a session with no grants appends nothing', () => {
    const allowlist = new SessionAllowlist()
    const sess = session()
    allowlist.clear(sess)
    expect(sess.snapshotEvents()).toHaveLength(0)
  })

  it('foldSessionAllows collects granted rules from a log in order', () => {
    const sess = session()
    appendSessionAllow(sess, { rule: 'Bash(npm )', scope: 'session', toolName: 'Bash', timestamp: 1 })
    sess.append('turn/start', { turn: 1 })
    appendSessionAllow(sess, { rule: 'edit', scope: 'session', toolName: 'edit', timestamp: 2 })
    const rules = foldSessionAllows(sess.snapshotEvents())
    expect(rules).toHaveLength(2)
    expect(rules[0]!.toolName).toBe('Bash')
    expect(rules[1]!.toolName).toBe('edit')
  })

  it('foldSessionAllows treats a cleared record as resetting the set', () => {
    const sess = session()
    appendSessionAllow(sess, { rule: 'Bash', scope: 'session', toolName: 'Bash', timestamp: 1 })
    appendSessionAllow(sess, { scope: 'session', toolName: '*', timestamp: 2, cleared: true })
    appendSessionAllow(sess, { rule: 'read', scope: 'session', toolName: 'read', timestamp: 3 })
    expect(foldSessionAllows(sess.snapshotEvents()).map(rule => rule.toolName)).toEqual(['read'])
  })

  it('foldSessionAllows ignores sandbox-auto records (they carry no rule)', () => {
    const sess = session()
    appendSessionAllow(sess, { scope: 'sandbox-auto', toolName: 'Bash', timestamp: 1 })
    expect(foldSessionAllows(sess.snapshotEvents())).toHaveLength(0)
  })

  it('seed replaces a session rule set; empty seeds clear it', () => {
    const allowlist = new SessionAllowlist()
    const sess = session()
    allowlist.add(sess, 'Bash')
    const id = String(sess.id)
    allowlist.seed(id, foldSessionAllows([
      { type: SESSION_ALLOW_EVENT, data: { rule: 'read', scope: 'session', toolName: 'read', timestamp: 1 } } as never,
    ]))
    expect(allowlist.rulesOf(id).map(rule => rule.toolName)).toEqual(['read'])
    allowlist.seed(id, [])
    expect(allowlist.rulesOf(id)).toHaveLength(0)
  })

  it('never touches the settings namespace (no persistence side effects)', () => {
    // The allowlist's only I/O is the session log; assert the audit event is
    // the sole artifact an add produces.
    const allowlist = new SessionAllowlist()
    const sess = session()
    const before = sess.seq
    allowlist.add(sess, 'Bash')
    expect(sess.snapshotEvents()).toHaveLength(before + 1)
    expect(lastEvent(sess).type).toBe(SESSION_ALLOW_EVENT)
  })
})
