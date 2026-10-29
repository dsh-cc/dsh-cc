import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskGrant } from '@dsh-cc/permission-rules'
import * as commandPermissions from '@dsh-cc/command-permissions'
import { renderGrantList, renderGrantView } from '@dsh-cc/command-permissions/permissions'

function grant(overrides: Partial<TaskGrant> = {}): TaskGrant {
  return {
    grantId: 'grant_abc',
    root: '/work',
    branch: 'task-grant-chain',
    goalId: null,
    expires: { kind: 'session-end' },
    rules: ['Bash(git add)', 'Bash(git commit)'],
    tools: ['argument.*'],
    writePaths: ['docs/vwa-reports/'],
    sandboxEscalation: true,
    modeCeiling: 'workspace-write',
    contentScope: 'tracked-md-only',
    createdBy: 'user',
    ts: '2026-10-28T00:00:00.000Z',
    ...overrides,
  }
}

describe('task grant rendering (§3.3 complete post-derivation view)', () => {
  it('renders every rule, every writePath, the expiry and the contentScope', () => {
    const view = renderGrantView(grant(), { confirmed: false, descriptorPath: 'd.json' })
    expect(view).toContain('Bash(git add)')
    expect(view).toContain('Bash(git commit)')
    expect(view).toContain('argument.*')
    expect(view).toContain('    docs/vwa-reports/')
    expect(view).toContain('session-end')
    expect(view).toContain('tracked-md-only')
    expect(view).toContain('modeCeiling: workspace-write')
    expect(view).not.toContain('DANGER')
    expect(view).toContain('--confirm')
  })

  it('highlights danger-full-access and an explicit any contentScope', () => {
    const view = renderGrantView(
      grant({ modeCeiling: 'danger-full-access', contentScope: 'any' }),
      { confirmed: false },
    )
    expect(view).toContain('DANGER: full sandbox access')
    expect(view).toContain('WARNING: no markdown-only check')
  })

  it('lists live grants and explains the revoke form', () => {
    expect(renderGrantList([])).toContain('No task grants are active')
    const list = renderGrantList([grant()])
    expect(list).toContain('grant_abc')
    expect(list).toContain('/permissions revoke <grantId>')
  })
})

type GrantFace = {
  propose: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  of: ReturnType<typeof vi.fn>
  revoke: ReturnType<typeof vi.fn>
}

async function harness(face: Partial<GrantFace> = {}): Promise<{ ctx: Context; agent: Agent; face: GrantFace }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const grants: GrantFace = {
    propose: vi.fn(async () => grant()),
    create: vi.fn(async () => grant()),
    of: vi.fn(() => [grant()]),
    revoke: vi.fn(() => true),
    ...face,
  }
  ctx.reflect.provide('permissionRules', {
    ruleSet: { allow: [], deny: [], ask: [], bypassImmune: [] },
    defaultMode: 'default',
    effectiveRuleSet: () => ({ allow: [], deny: [], ask: [], bypassImmune: [] }),
    setMode: () => {},
    grants,
  })
  await ctx.plugin(commandPermissions)
  const session = ctx.sessions.create(SessionId(`grant-command-${Math.random()}`))
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: null as never,
    ctx: new Context(),
    get status(): 'idle' { return 'idle' },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return { ctx, agent, face: grants }
}

async function run(ctx: Context, agent: Agent, line: string): Promise<CommandResult> {
  const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
  return execution!.result
}

describe('/permissions grant | grants | revoke (§3.3)', () => {
  it('grant <path> renders the view and creates nothing', async () => {
    const { ctx, agent, face } = await harness()
    const result = await run(ctx, agent, '/permissions grant .dsh/vwa/batches/b1/grant-descriptor.json')
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('review and confirm')
    expect(face.propose).toHaveBeenCalledWith(agent, '.dsh/vwa/batches/b1/grant-descriptor.json')
    expect(face.create).not.toHaveBeenCalled()
  })

  it('grant <path> --confirm creates the grant and renders the created state', async () => {
    const { ctx, agent, face } = await harness()
    const result = await run(ctx, agent, '/permissions grant d.json --confirm')
    expect(result.kind).toBe('success')
    expect((result as { text: string }).text).toContain('Task grant created')
    expect(face.create).toHaveBeenCalledWith(agent, 'd.json')
  })

  it('only a standalone trailing --confirm confirms (no silent create)', async () => {
    const { ctx, agent, face } = await harness()
    await run(ctx, agent, '/permissions grant d.json --confirm extra')
    expect(face.create).not.toHaveBeenCalled()
    await run(ctx, agent, '/permissions grant x--confirm')
    expect(face.create).not.toHaveBeenCalled()
    await run(ctx, agent, '/permissions grant d.json --confirm')
    expect(face.create).toHaveBeenCalledWith(agent, 'd.json')
  })

  it('a rejected descriptor surfaces the validator message as an error', async () => {
    const { ctx, agent } = await harness({
      propose: vi.fn(async () => { throw new Error('writePaths: ".dsh/vwa/x.json" is authoritative VWA state') }),
    })
    const result = await run(ctx, agent, '/permissions grant d.json')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('authoritative VWA state')
  })

  it('grant without a path is a usage error', async () => {
    const { ctx, agent } = await harness()
    expect((await run(ctx, agent, '/permissions grant')).kind).toBe('error')
  })

  it('grants lists the session grants', async () => {
    const { ctx, agent, face } = await harness()
    const result = await run(ctx, agent, '/permissions grants')
    expect((result as { text: string }).text).toContain('grant_abc')
    expect(face.of).toHaveBeenCalledWith(agent)
  })

  it('revoke revokes exactly the named grant and reports a miss', async () => {
    const { ctx, agent, face } = await harness({
      revoke: vi.fn((_agent: Agent, id: string) => id === 'grant_abc'),
    })
    expect((await run(ctx, agent, '/permissions revoke grant_abc')).kind).toBe('success')
    const miss = await run(ctx, agent, '/permissions revoke grant_zzz')
    expect(miss.kind).toBe('error')
    expect((miss as { text: string }).text).toContain('No live task grant')
    expect(face.revoke).toHaveBeenCalledWith(agent, 'grant_zzz')
  })

  it('grant subcommands report unavailability on an engine without the grant surface', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(AgentRegistry)
    ctx.reflect.provide('permissionRules', {
      ruleSet: { allow: [], deny: [], ask: [], bypassImmune: [] },
      defaultMode: 'default',
      effectiveRuleSet: () => ({ allow: [], deny: [], ask: [], bypassImmune: [] }),
      setMode: () => {},
    })
    await ctx.plugin(commandPermissions)
    const session = ctx.sessions.create(SessionId(`grant-noface-${Math.random()}`))
    const agent = { id: session.id, session, inject: () => {}, send: () => {} } as unknown as Agent
    await ctx.agents.register(agent)
    const result = await run(ctx, agent, '/permissions grant d.json')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('not available')
  })
})
