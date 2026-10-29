import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  TASK_GRANT_EVENT,
  TaskGrantStore,
  appendTaskGrantEvent,
  buildTaskGrant,
  descriptorFromJson,
  foldTaskGrants,
  validateDescriptor,
  type TaskGrant,
} from '../src/task-grant.ts'

function session(id = `grant-${Math.random()}`): Session {
  return Session.create(SessionId(id))
}

/** A validated capability face with overridable fields. */
function face(overrides: Record<string, unknown> = {}) {
  return validateDescriptor({
    rules: ['Bash(git add)', 'Bash(git commit)'],
    tools: ['argument.*'],
    writePaths: ['docs/vwa-reports/', '.dsh/vwa/batches/b1/'],
    sandboxEscalation: true,
    ...overrides,
  } as never)
}

function grant(overrides: Partial<TaskGrant> = {}): TaskGrant {
  return {
    ...buildTaskGrant({ root: '/work', branch: 'task-grant-chain', goalId: null, face: face() }),
    ...overrides,
  }
}

describe('task grant object + validator (§3.2)', () => {
  it('registers permission/task-grant into KNOWN_SESSION_EVENT_TYPES at module load', () => {
    expect((KNOWN_SESSION_EVENT_TYPES as Set<string>).has(TASK_GRANT_EVENT)).toBe(true)
  })

  it('derives a grant_ id, user provenance, session-end expiry and the conditional contentScope default', () => {
    const built = grant()
    expect(built.grantId.startsWith('grant_')).toBe(true)
    expect(built.createdBy).toBe('user')
    expect(built.expires).toEqual({ kind: 'session-end' })
    expect(built.modeCeiling).toBe('workspace-write')
    expect(built.contentScope).toBe('tracked-md-only')
  })

  it('goal-linked grants expire on goal-complete', () => {
    const built = buildTaskGrant({ root: '/work', branch: 'b', goalId: 'goal-1', face: face() })
    expect(built.expires).toEqual({ kind: 'goal-complete', goalId: 'goal-1' })
  })

  it('contentScope defaults to any when escalation is off (or no git write rule is granted)', () => {
    expect(face({ sandboxEscalation: false }).contentScope).toBe('any')
    expect(face({ rules: ['Bash(echo)'] }).contentScope).toBe('any')
  })

  it('writePaths reject authoritative VWA state and accept the batches subtree', () => {
    expect(() => face({ writePaths: ['.dsh/vwa/prj_1/adjudications.json'] })).toThrow(/authoritative VWA state/)
    expect(() => face({ writePaths: ['.dsh/vwa/current-project.json'] })).toThrow(/authoritative VWA state/)
    expect(face({ writePaths: ['.dsh/vwa/batches/b1/'] }).writePaths).toEqual(['.dsh/vwa/batches/b1'])
  })

  it('writePaths reject absolute paths and root escapes', () => {
    expect(() => face({ writePaths: ['/etc/passwd'] })).toThrow(/root-relative/)
    expect(() => face({ writePaths: ['../outside'] })).toThrow(/escapes the workspace root/)
  })

  it('rules reject whole-tool bash rules, wildcards, ":*" forms and git config overrides', () => {
    expect(() => face({ rules: ['Bash'] })).toThrow(/whole-tool/)
    expect(() => face({ rules: ['Bash(git *)'] })).toThrow(/wildcard/)
    expect(() => face({ rules: ['Bash(git push:*)'] })).toThrow(/colon-prefix/)
    expect(() => face({ rules: ['Bash(git -c user.name=x commit)'] })).toThrow(/overrides git config/)
    expect(() => face({ rules: ['Bash(git --config-env=a=b commit)'] })).toThrow(/overrides git config/)
  })

  it('tools accept exact names and prefix.* but reject bare wildcards', () => {
    expect(face({ tools: ['mcp__argument__review', 'argument.*'] }).tools).toEqual(['mcp__argument__review', 'argument.*'])
    expect(() => face({ tools: ['argument*'] })).toThrow(/exact tool name or "prefix\.\*"/)
  })

  it('descriptorFromJson rejects host-derived and unknown keys', () => {
    expect(() => descriptorFromJson({ rules: [], tools: [], writePaths: [], sandboxEscalation: true, root: '/evil' }))
      .toThrow(/host-derived/)
  })

  it('a descriptor-declared danger-full-access ceiling and explicit any contentScope survive validation', () => {
    const built = face({ modeCeiling: 'danger-full-access', contentScope: 'any' })
    expect(built.modeCeiling).toBe('danger-full-access')
    expect(built.contentScope).toBe('any')
  })
})

describe('task grant storage + lifecycle (§3.2/§3.3)', () => {
  it('folds created grants and drops exactly the revoked grantId (never a wipe-all)', () => {
    const sess = session()
    const first = grant()
    const second = grant()
    appendTaskGrantEvent(sess, { grant: first, timestamp: Date.now() })
    appendTaskGrantEvent(sess, { grant: second, timestamp: Date.now() })
    appendTaskGrantEvent(sess, { cleared: first.grantId, reason: 'manual', timestamp: Date.now() })
    expect(foldTaskGrants(sess.snapshotEvents()).map(entry => entry.grantId)).toEqual([second.grantId])
  })

  it('the store seeds once from the session log (resume folding) and is session-scoped', () => {
    const sess = session()
    const built = grant()
    appendTaskGrantEvent(sess, { grant: built, timestamp: Date.now() })
    const store = new TaskGrantStore()
    const id = String(sess.id)
    expect(store.of(id, () => sess.snapshotEvents()).map(entry => entry.grantId)).toEqual([built.grantId])
    expect(store.byId(id, () => sess.snapshotEvents(), built.grantId)?.root).toBe('/work')
    expect(store.anyActive('another-session')).toBe(false)
    expect(store.of('another-session', () => [])).toHaveLength(0)
  })

  it('add/remove maintain the live set and report whether a revoke hit', () => {
    const sess = session()
    const built = grant()
    const store = new TaskGrantStore()
    const id = String(sess.id)
    store.add(id, () => sess.snapshotEvents(), built)
    expect(store.anyActive(id)).toBe(true)
    expect(store.remove(id, () => sess.snapshotEvents(), 'grant_missing')).toBe(false)
    expect(store.remove(id, () => sess.snapshotEvents(), built.grantId)).toBe(true)
    expect(store.anyActive(id)).toBe(false)
  })

  it('a cleared record never resurrects grants folded before it (replay idempotence)', () => {
    const sess = session()
    const built = grant()
    appendTaskGrantEvent(sess, { grant: built, timestamp: 1 })
    appendTaskGrantEvent(sess, { cleared: built.grantId, reason: 'manual', timestamp: 2 })
    appendTaskGrantEvent(sess, { cleared: built.grantId, reason: 'manual', timestamp: 3 })
    expect(foldTaskGrants(sess.snapshotEvents())).toHaveLength(0)
  })
})
