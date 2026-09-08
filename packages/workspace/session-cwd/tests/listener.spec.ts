import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@dsh-cc/tools'
import {
  DEFAULT_FS_TOOLS,
  boundaryDecision,
  isFsTool,
  isInsideWorkspace,
  readPermissionMode,
  registerSessionCwdBoundary,
  targetPathOf,
} from '../src/listener.ts'
import { appendWorktreeEntered } from '../src/events.ts'

let counter = 0

/** A fake execution over a real Session log, with an optional header cwd. */
function exec(options: {
  name: string
  args?: Record<string, unknown>
  cwd?: string
  entered?: string
  mode?: string
}): ToolExecution {
  counter += 1
  const session = Session.create(SessionId(`listener-${counter}`))
  if (options.entered !== undefined) appendWorktreeEntered(session, options.entered)
  if (options.mode !== undefined) {
    ;(session.append as unknown as (type: string, payload: unknown) => void)('permission/mode', { mode: options.mode })
  }
  const agent = {
    session: {
      id: session.id,
      seq: 0 as number,
      snapshotEvents: (): readonly unknown[] => session.snapshotEvents(),
      eventAt: (i: number): unknown => session.eventAt(i),
      append: session.append.bind(session),
      header: options.cwd === undefined ? {} : { cwd: options.cwd },
    },
  } as unknown as Agent
  return {
    callId: `call-${counter}`,
    name: options.name,
    arguments: options.args ?? {},
    signal: new AbortController().signal,
    agent,
  } as unknown as ToolExecution
}

describe('isFsTool', () => {
  it('matches the default fs tool set case-insensitively', () => {
    expect(isFsTool('Edit')).toBe(true)
    expect(isFsTool('Write')).toBe(true)
    expect(isFsTool('notebook_edit')).toBe(true)
    expect(isFsTool('Bash')).toBe(false)
    expect(isFsTool('EnterWorktree')).toBe(false)
  })

  it('honours a custom tool set', () => {
    expect(isFsTool('CustomFs', ['CustomFs'])).toBe(true)
    expect(isFsTool('edit', ['customfs'])).toBe(false)
  })

  it('defaults to the standard fs set', () => {
    for (const tool of DEFAULT_FS_TOOLS) expect(isFsTool(tool)).toBe(true)
  })
})

describe('targetPathOf', () => {
  it('reads the target keys in declared order', () => {
    expect(targetPathOf(exec({ name: 'Write', args: { file_path: '/a', path: '/b' } }))).toBe('/a')
    expect(targetPathOf(exec({ name: 'Read', args: { path: '/b', cwd: '/c' } }))).toBe('/b')
    expect(targetPathOf(exec({ name: 'Bash', args: { workdir: '/d', command: 'ls' } }))).toBe('/d')
  })

  it('yields undefined for pathless calls and empty values', () => {
    expect(targetPathOf(exec({ name: 'Bash', args: { command: 'ls' } }))).toBeUndefined()
    expect(targetPathOf(exec({ name: 'Write', args: {} }))).toBeUndefined()
  })
})

describe('isInsideWorkspace', () => {
  it('accepts the root itself and paths inside it', () => {
    expect(isInsideWorkspace('/tmp/wt', '/tmp/wt')).toBe(true)
    expect(isInsideWorkspace('/tmp/wt/src/a.ts', '/tmp/wt')).toBe(true)
    expect(isInsideWorkspace('src/a.ts', '/tmp/wt')).toBe(true)
  })

  it('rejects traversal escapes and sibling prefixes', () => {
    expect(isInsideWorkspace('/tmp/wt/../outside', '/tmp/wt')).toBe(false)
    expect(isInsideWorkspace('/tmp/wt-other', '/tmp/wt')).toBe(false)
    expect(isInsideWorkspace('/etc/passwd', '/tmp/wt')).toBe(false)
  })
})

describe('readPermissionMode', () => {
  it('returns undefined without a recorded mode', () => {
    expect(readPermissionMode(exec({ name: 'Edit' }).agent!.session.snapshotEvents())).toBeUndefined()
  })

  it('returns the last recorded mode', () => {
    const execution = exec({ name: 'Edit', mode: 'bypassPermissions' })
    expect(readPermissionMode(execution.agent!.session.snapshotEvents())).toBe('bypassPermissions')
  })
})

describe('boundaryDecision', () => {
  it('passes through non-fs tools', () => {
    expect(boundaryDecision(exec({ name: 'Bash', args: { file_path: '/etc/passwd' }, cwd: '/tmp/wt' }))).toBeUndefined()
  })

  it('passes through pathless fs calls', () => {
    expect(boundaryDecision(exec({ name: 'Write', args: {}, cwd: '/tmp/wt' }))).toBeUndefined()
  })

  it('passes through calls without an agent', () => {
    const execution = exec({ name: 'Write', args: { file_path: '/etc/passwd' }, cwd: '/tmp/wt' })
    delete (execution as { agent?: unknown }).agent
    expect(boundaryDecision(execution)).toBeUndefined()
  })

  it('passes through when no session cwd is resolvable', () => {
    expect(boundaryDecision(exec({ name: 'Write', args: { file_path: '/etc/passwd' } }))).toBeUndefined()
  })

  it('passes through in-workspace targets', () => {
    expect(boundaryDecision(exec({ name: 'Write', args: { file_path: '/tmp/wt/src/a.ts' }, entered: '/tmp/wt' }))).toBeUndefined()
  })
})

describe('boundaryDecision: out-of-workspace targets', () => {
  it('asks with a workspace-referencing reason under the default mode', () => {
    const decision = boundaryDecision(exec({ name: 'Write', args: { file_path: '/etc/passwd' }, entered: '/tmp/wt' }))
    expect(decision).toMatchObject({ kind: 'ask' })
    expect((decision as { reason: string }).reason).toContain('outside session workspace')
    expect((decision as { reason: string }).reason).toContain('/tmp/wt')
  })

  it('allows under bypassPermissions', () => {
    const decision = boundaryDecision(exec({ name: 'Write', args: { file_path: '/etc/passwd' }, entered: '/tmp/wt', mode: 'bypassPermissions' }))
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('asks under non-bypass permission modes', () => {
    const decision = boundaryDecision(exec({ name: 'Write', args: { file_path: '/etc/passwd' }, entered: '/tmp/wt', mode: 'default' }))
    expect((decision as PreToolDecision).kind).toBe('ask')
  })

  it('resolves relative targets against the workspace root', () => {
    expect(boundaryDecision(exec({ name: 'Edit', args: { file_path: 'src/a.ts' }, entered: '/tmp/wt' }))).toBeUndefined()
    expect(boundaryDecision(exec({ name: 'Edit', args: { file_path: '../escape' }, entered: '/tmp/wt' }))?.kind).toBe('ask')
  })

  it('falls back to the session header cwd when the log has none', () => {
    expect(boundaryDecision(exec({ name: 'Write', args: { file_path: '/tmp/wt/a' }, cwd: '/tmp/wt' }))).toBeUndefined()
    expect(boundaryDecision(exec({ name: 'Write', args: { file_path: '/etc/x' }, cwd: '/tmp/wt' }))?.kind).toBe('ask')
  })
})

describe('registerSessionCwdBoundary', () => {
  it('registers a prepended pre-execute listener that forwards pass-throughs', async () => {
    const ctx = new Context()
    const order: string[] = []
    registerSessionCwdBoundary(ctx, { fsTools: DEFAULT_FS_TOOLS })
    ctx.on('tools/pre-execute', async (_exec, next): Promise<PreToolDecision> => {
      order.push('later')
      return next()
    })
    const emit = (ctx as unknown as {
      waterfall(name: string, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    }).waterfall
    const decision = await emit.call(ctx, 'tools/pre-execute', exec({ name: 'Bash', args: {} }), async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'allow' })
    expect(order).toEqual(['later'])
  })

  it('short-circuits with ask before later listeners for out-of-workspace targets', async () => {
    const ctx = new Context()
    let reached = false
    registerSessionCwdBoundary(ctx, { fsTools: DEFAULT_FS_TOOLS })
    ctx.on('tools/pre-execute', async () => {
      reached = true
      return { kind: 'allow' }
    })
    const emit = (ctx as unknown as {
      waterfall(name: string, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>
    }).waterfall
    const decision = await emit.call(ctx, 'tools/pre-execute', exec({ name: 'Write', args: { file_path: '/etc/passwd' }, entered: '/tmp/wt' }), async () => ({ kind: 'allow' }))
    expect(decision).toMatchObject({ kind: 'ask' })
    expect(reached).toBe(false)
  })
})
