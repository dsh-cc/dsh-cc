import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { PermissionRule, PermissionRuleSet } from '@dsh-cc/permission-rules/types'
import { parseRuleSafe } from '@dsh-cc/permission-rules'
import * as commandPermissions from '@dsh-cc/command-permissions'
import { lintRuleSet, lintUserSection, renderLint } from '@dsh-cc/command-permissions/src/lint'

function parsed(rule: string, behavior: 'allow' | 'deny' | 'ask', source: PermissionRule['source']): PermissionRule {
  const shape = parseRuleSafe(rule, behavior, source)
  if (shape === undefined) throw new Error(`fixture rule "${rule}" must parse`)
  return shape
}

const RULESET = (): PermissionRuleSet => ({
  allow: [
    parsed('Bash(git )', 'allow', 'config'),
    parsed('Bash(git status)', 'allow', 'config'),
    parsed('Bash', 'allow', 'userSettings'),
    parsed('Frobnicate', 'allow', 'config'),
  ],
  deny: [parsed('Bash(git status)', 'deny', 'config'), parsed('Bash(git status)', 'deny', 'config')],
  ask: [],
  bypassImmune: [],
})

async function harness(): Promise<{ ctx: Context; agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(commandPermissions)
  const session = ctx.sessions.create(SessionId(`command-permissions-lint-${Math.random()}`))
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
  ctx.agents.register(agent)
  return { ctx, agent }
}

function execute(ctx: Context, agent: Agent, input: string) {
  return ctx.commands.execute(agent, `/permissions ${input}`.trim(), [], new AbortController().signal)
}

describe('lintRuleSet', () => {
  it('flags prefix-subsumed rules only within the same source and behavior group', () => {
    const findings = lintRuleSet(RULESET())
    expect(findings.filter(f => f.kind === 'subsumed')).toEqual([
      expect.objectContaining({ rule: 'Bash(git status)', source: 'config', behavior: 'allow', detail: expect.stringContaining('Bash(git )') }),
    ])
  })
  it('flags exact duplicates within one group', () => {
    const findings = lintRuleSet(RULESET())
    expect(findings.filter(f => f.kind === 'duplicate')).toEqual([
      expect.objectContaining({ rule: 'Bash(git status)', behavior: 'deny' }),
    ])
  })
  it('flags bare whole-tool Bash allow as broad', () => {
    expect(lintRuleSet(RULESET()).filter(f => f.kind === 'broad')).toEqual([
      expect.objectContaining({ rule: 'Bash', source: 'userSettings' }),
    ])
  })
  it('flags unknown tool names', () => {
    expect(lintRuleSet(RULESET()).filter(f => f.kind === 'unknownTool')).toEqual([
      expect.objectContaining({ toolName: 'Frobnicate' }),
    ])
  })
  it('reports nothing on a clean rule set', () => {
    const rules: PermissionRuleSet = {
      allow: [parsed('Bash(git )', 'allow', 'config'), parsed('read', 'allow', 'config')],
      deny: [], ask: [], bypassImmune: [],
    }
    expect(lintRuleSet(rules)).toEqual([])
  })
})

describe('lintUserSection', () => {
  it('flags malformed strings (kept) and proposes duplicate/subsumed removals', () => {
    const lint = lintUserSection({
      allow: ['Bash(git )', 'Bash(git status)', 'Bash(git status)', 'Bash(grep'],
      deny: ['Bash(rm )', 'Bash(rm -rf /)'],
      defaultMode: 'default',
    })
    const malformed = lint.findings.filter(f => f.kind === 'malformed')
    expect(malformed).toHaveLength(1)
    expect(malformed[0]).toMatchObject({ rule: 'Bash(grep', behavior: 'allow' })
    expect(lint.after.allow).toEqual(['Bash(git )', 'Bash(grep'])
    expect(lint.after.deny).toEqual(['Bash(rm )'])
    expect(lint.before.deny).toEqual(['Bash(rm )', 'Bash(rm -rf /)'])
  })
})

describe('renderLint', () => {
  it('renders findings and a before/after diff with removal markers', () => {
    const lint = lintUserSection({ allow: ['Bash(git )', 'Bash(git status)'] })
    const text = renderLint(lintRuleSet({ allow: [], deny: [], ask: [], bypassImmune: [] }), lint)
    expect(text).toContain('Permission rules lint (read-only)')
    expect(text).toContain('    - Bash(git status)')
    expect(text).toContain('      Bash(git )')
  })
  it('degrades the diff line when the user layer is unreachable', () => {
    expect(renderLint([], undefined)).toContain('(user settings layer not reachable)')
  })
})

describe('/permissions lint command dispatch', () => {
  it('prints the report read-only and mutates nothing', async () => {
    const { ctx, agent } = await harness()
    ctx.reflect.provide('permissionRules', { ruleSet: RULESET(), setMode: () => {} })
    ctx.reflect.provide('settings', { writable: true, describe: () => [] })
    const execution = await execute(ctx, agent, 'lint')
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('subsumed by a broader rule')
    expect(text).toContain('(no changes proposed)')
  })
  it('applies only the user layer via editUserSection', async () => {
    const { ctx, agent } = await harness()
    ctx.reflect.provide('permissionRules', { ruleSet: RULESET(), setMode: () => {} })
    const rawUser: Record<string, unknown> = {
      allow: ['Bash(git )', 'Bash(git status)'],
      deny: ['Bash(rm )'],
      defaultMode: 'default',
    }
    let applied: Record<string, unknown> | undefined
    ctx.reflect.provide('settings', {
      writable: true,
      describe: () => [{ ns: 'permissions', revision: 1, user: rawUser }],
      editUserSection: async (_ns: string, edit: (raw: Record<string, unknown>) => Record<string, unknown> | undefined) => {
        applied = edit(rawUser) ?? undefined
      },
    })
    const execution = await execute(ctx, agent, 'lint --apply')
    expect(execution?.result.kind).toBe('success')
    expect(applied).toEqual({ allow: ['Bash(git )'], deny: ['Bash(rm )'], defaultMode: 'default' })
    expect((execution?.result as { text: string }).text).toContain('Applied: removed 1 redundant user-layer rule(s).')
  })
  it('degrades with a friendly message when the settings provider is absent (--apply)', async () => {
    const { ctx, agent } = await harness()
    ctx.reflect.provide('permissionRules', { ruleSet: RULESET(), setMode: () => {} })
    const execution = await execute(ctx, agent, 'lint --apply')
    expect((execution?.result as { text: string }).text).toContain('no writable settings provider')
  })
  it('degrades when the permission engine is not mounted', async () => {
    const { ctx, agent } = await harness()
    const execution = await execute(ctx, agent, 'lint')
    expect(execution?.result.kind).toBe('error')
    expect((execution?.result as { text: string }).text).toContain('not mounted')
  })
})
