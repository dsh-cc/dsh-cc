import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  EscalationRegistry,
  GrantEscalations,
  commandHash,
  normalizeCommandText,
  parseEscalationMode,
  withinModeCeiling,
  type EscalationEntry,
} from '../src/grant-escalation.ts'
import type { GitRunner } from '../src/grant-content-scope.ts'
import {
  TaskGrantStore,
  appendTaskGrantEvent,
  buildTaskGrant,
  validateDescriptor,
  type TaskGrant,
} from '../src/task-grant.ts'

function session(id = `esc-${Math.random()}`): Session {
  return Session.create(SessionId(id))
}

function grant(overrides: { branch?: string | null; modeCeiling?: 'workspace-write' | 'danger-full-access'; contentScope?: 'tracked-md-only' | 'any'; rules?: string[] } = {}): TaskGrant {
  const face = validateDescriptor({
    rules: overrides.rules ?? ['Bash(git add)', 'Bash(git commit)', 'Bash(git push)'],
    tools: ['argument.*'],
    writePaths: ['docs/'],
    sandboxEscalation: true,
    ...overrides.modeCeiling === undefined ? {} : { modeCeiling: overrides.modeCeiling },
    ...overrides.contentScope === undefined ? {} : { contentScope: overrides.contentScope },
  } as never)
  return buildTaskGrant({
    root: '/work',
    branch: overrides.branch === undefined ? 'task-grant-chain' : overrides.branch,
    goalId: null,
    face,
  })
}

function entry(overrides: Partial<EscalationEntry> = {}): EscalationEntry {
  return {
    sessionId: 's1',
    agentId: 's1',
    toolName: 'Bash',
    callId: 'c1',
    commandHash: commandHash('git commit -m x'),
    command: 'git commit -m x',
    grantId: 'grant_1',
    modeCeiling: 'workspace-write',
    ts: 0,
    ...overrides,
  }
}

/** A controller whose git runner answers the branch guard and the scope checks. */
function controller(opts: { session: Session; built: TaskGrant; git?: GitRunner }): {
  controller: GrantEscalations
  store: TaskGrantStore
} {
  const store = new TaskGrantStore()
  appendTaskGrantEvent(opts.session, { grant: opts.built, timestamp: Date.now() })
  store.add(String(opts.session.id), () => opts.session.snapshotEvents(), opts.built)
  const controller = new GrantEscalations({
    store,
    // Branch guard answers; every contentScope check sees an empty change set.
    git: opts.git ?? (async (_root, args) => (args[0] === 'rev-parse' ? 'task-grant-chain\n' : '')),
  })
  return { controller, store }
}

describe('command hash + reason parsing (§3.5)', () => {
  it('hashes the normalized command text', () => {
    expect(normalizeCommandText('  git   commit  -m x ')).toBe('git commit -m x')
    expect(commandHash('git  commit -m x')).toBe(commandHash('git commit -m x'))
    expect(commandHash('git commit -m x')).not.toBe(commandHash('git commit -m y'))
  })

  it('parses the known reason prefix and fails closed on every other shape', () => {
    expect(parseEscalationMode('escalate sandbox to workspace-write: ci needs npm')).toBe('workspace-write')
    expect(parseEscalationMode('escalate sandbox to danger-full-access: x')).toBe('danger-full-access')
    expect(parseEscalationMode('sandbox escalation: operation outside the per-call policy')).toBeUndefined()
    expect(parseEscalationMode('escalate sandbox to chaos: x')).toBeUndefined()
    expect(parseEscalationMode(undefined)).toBeUndefined()
  })

  it('compares requested mode against the ceiling', () => {
    expect(withinModeCeiling('workspace-write', 'workspace-write')).toBe(true)
    expect(withinModeCeiling('workspace-write', 'danger-full-access')).toBe(false)
    expect(withinModeCeiling('danger-full-access', 'danger-full-access')).toBe(true)
  })
})

describe('escalation registry', () => {
  it('binds an entry to (session, call) and consumes it exactly once', () => {
    const registry = new EscalationRegistry()
    registry.register(entry())
    expect(registry.peek('s1', 'c1')).toBeDefined()
    expect(registry.consume('s1', 'c1')?.commandHash).toBe(commandHash('git commit -m x'))
    expect(registry.consume('s1', 'c1')).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('P1a: callId reuse with a different command drops the entry (no stale auto-approval)', () => {
    const registry = new EscalationRegistry()
    expect(registry.register(entry({ callId: 'x', command: 'git commit -m a', commandHash: commandHash('git commit -m a') }))).toBe(true)
    expect(registry.register(entry({ callId: 'x', command: 'git commit -m b', commandHash: commandHash('git commit -m b') }))).toBe(false)
    expect(registry.peek('s1', 'x')).toBeUndefined()
  })

  it('registrations die with their grant and with their session', () => {
    const registry = new EscalationRegistry()
    registry.register(entry({ grantId: 'grant_1' }))
    registry.register(entry({ callId: 'c2', grantId: 'grant_2' }))
    registry.clearGrant('grant_1')
    expect(registry.peek('s1', 'c1')).toBeUndefined()
    expect(registry.peek('s1', 'c2')).toBeDefined()
    registry.clearSession('s1')
    expect(registry.size).toBe(0)
  })
})

describe('grant escalation consumption (§3.5)', () => {
  it('auto-approves a registered escalation through the branch guard and mode ceiling', async () => {
    const sess = session()
    const built = grant()
    const { controller: c } = controller({ session: sess, built })
    c.register({ session: sess, agentId: String(sess.id), toolName: 'Bash', callId: 'c1', command: 'git commit -m x', grant: built })
    const verdict = await c.consume({
      session: sess,
      agentId: String(sess.id),
      toolName: 'Bash',
      callId: 'c1',
      reason: 'escalate sandbox to workspace-write: needs the workspace',
    })
    expect(verdict).toMatchObject({ kind: 'allowed-once', grantId: built.grantId, mode: 'workspace-write' })
  })

  it('is one-shot: the second consumption of the same call falls back', async () => {
    const sess = session()
    const built = grant()
    const { controller: c } = controller({ session: sess, built })
    c.register({ session: sess, agentId: String(sess.id), toolName: 'Bash', callId: 'c1', command: 'git commit -m x', grant: built })
    const reason = 'escalate sandbox to workspace-write: x'
    expect((await c.consume({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', reason })).kind).toBe('allowed-once')
    expect((await c.consume({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', reason })).kind).toBe('fallback')
  })

  it('fails closed on an unknown reason shape and on a mode above the ceiling', async () => {
    const sess = session()
    const built = grant()
    const { controller: c } = controller({ session: sess, built })
    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', command: 'git commit -m x', grant: built })
    expect((await c.consume({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', reason: 'sandbox escalation: something' })).kind).toBe('fallback')

    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c2', command: 'git commit -m x', grant: built })
    expect((await c.consume({
      session: sess, agentId: 'a', toolName: 'Bash', callId: 'c2',
      reason: 'escalate sandbox to danger-full-access: x',
    })).kind).toBe('fallback')
  })

  it('danger-full-access only matches an explicit danger-full-access ceiling', async () => {
    const sess = session()
    const built = grant({ modeCeiling: 'danger-full-access' })
    const { controller: c } = controller({ session: sess, built })
    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', command: 'git commit -m x', grant: built })
    expect((await c.consume({
      session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1',
      reason: 'escalate sandbox to danger-full-access: x',
    })).kind).toBe('allowed-once')
  })

  it('branch drift falls back to the user', async () => {
    const sess = session()
    const built = grant()
    const { controller: c } = controller({ session: sess, built, git: async () => 'main\n' })
    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', command: 'git commit -m x', grant: built })
    expect((await c.consume({
      session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1',
      reason: 'escalate sandbox to workspace-write: x',
    })).kind).toBe('fallback')
  })

  it('a revoked grant makes a still-registered entry fall back', async () => {
    const sess = session()
    const built = grant()
    appendTaskGrantEvent(sess, { grant: built, timestamp: Date.now() })
    appendTaskGrantEvent(sess, { cleared: built.grantId, reason: 'manual', timestamp: Date.now() })
    const store = new TaskGrantStore()
    const c = new GrantEscalations({ store, git: async () => 'task-grant-chain\n' })
    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c2', command: 'git commit -m x', grant: built })
    expect((await c.consume({
      session: sess, agentId: 'a', toolName: 'Bash', callId: 'c2',
      reason: 'escalate sandbox to workspace-write: x',
    })).kind).toBe('fallback')
    expect(c.anyActive(sess)).toBe(false)
  })

  it('a contentScope violation revokes the grant, clears its registrations and reports', async () => {
    const sess = session()
    const built = grant()
    const gitRunner: GitRunner = async (_root, args) =>
      args[0] === 'rev-parse' ? 'task-grant-chain\n' : 'M\0src/a.ts\0'
    const { controller: c } = controller({ session: sess, built, git: gitRunner })
    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', command: 'git commit -m x', grant: built })
    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c2', command: 'git add docs/a.md', grant: built })
    const verdict = await c.consume({
      session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1',
      reason: 'escalate sandbox to workspace-write: x',
    })
    expect(verdict).toMatchObject({ kind: 'revoked', grantId: built.grantId })
    // Rule ②: the other registration died with the grant.
    expect(await c.consume({
      session: sess, agentId: 'a', toolName: 'Bash', callId: 'c2',
      reason: 'escalate sandbox to workspace-write: x',
    }).then(value => value.kind)).toBe('fallback')
    expect(c.anyActive(sess)).toBe(false)
  })

  it('takePostHoc verifies a commit -a after it ran and revokes on a violation', async () => {
    const sess = session()
    const built = grant()
    const gitRunner: GitRunner = async (_root, args) => {
      if (args[0] === 'rev-parse') return 'task-grant-chain\n'
      if (args[0] === 'diff-tree') return 'M\0src/a.ts\0'
      return ''
    }
    const { controller: c } = controller({ session: sess, built, git: gitRunner })
    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', command: 'git commit -a -m x', grant: built })
    const verdict = await c.consume({
      session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1',
      reason: 'escalate sandbox to workspace-write: x',
    })
    expect(verdict.kind).toBe('allowed-once')
    const reports = await c.takePostHoc(sess, true)
    expect(reports).toEqual(['M src/a.ts is not markdown'])
    expect(c.anyActive(sess)).toBe(false)
  })

  it('takePostHoc passes an in-scope commit -a and a failed commit is not verified', async () => {
    const sess = session()
    const built = grant()
    let diffTreeCalls = 0
    const gitRunner: GitRunner = async (_root, args) => {
      if (args[0] === 'rev-parse') return 'task-grant-chain\n'
      if (args[0] === 'diff-tree') {
        diffTreeCalls += 1
        return 'M\0docs/a.md\0'
      }
      return ''
    }
    const { controller: c } = controller({ session: sess, built, git: gitRunner })
    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', command: 'git commit -a -m x', grant: built })
    await c.consume({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', reason: 'escalate sandbox to workspace-write: x' })
    expect(await c.takePostHoc(sess, false)).toEqual([])
    expect(diffTreeCalls).toBe(0)
  })

  it('contentScope any skips the git scope checks entirely', async () => {
    const sess = session()
    const built = grant({ contentScope: 'any' })
    const calls: string[] = []
    const gitRunner: GitRunner = async (_root, args) => {
      calls.push(args[0] as string)
      return args[0] === 'rev-parse' ? 'task-grant-chain\n' : 'M\0src/a.ts\0'
    }
    const { controller: c } = controller({ session: sess, built, git: gitRunner })
    c.register({ session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1', command: 'git commit -m x', grant: built })
    expect((await c.consume({
      session: sess, agentId: 'a', toolName: 'Bash', callId: 'c1',
      reason: 'escalate sandbox to workspace-write: x',
    })).kind).toBe('allowed-once')
    expect(calls).toEqual(['rev-parse'])
  })
})
