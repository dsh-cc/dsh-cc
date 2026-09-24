/**
 * C3 — non-bypassable critical-bash denylist. The curated critical tier
 * (`CRITICAL_BASH_PATTERNS` + settings `criticalDeny`) is mounted as
 * bypass-immune deny rules, so it denies in EVERY mode, with the classifier
 * stage off, and with a settings `dangerousPatterns` replacement that omits
 * the critical patterns. Deny reason is the guard-layer string.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput, type ToolExecutionResult } from '@dsh-cc/tools'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import PermissionRules, { PERMISSION_SETTINGS_NAMESPACE, CRITICAL_BASH_PATTERNS, type Config } from '@dsh-cc/permission-rules'
import type { PermissionMode } from '@dsh-cc/permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'

const testToolSignal = new AbortController().signal

class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: string, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

/** Mount the plugin with the classifier OFF and a `dangerousPatterns` replacement. */
async function mount(config: Config = {}, settings: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(PermissionRules, {
    bashToolName: 'Bash',
    fileEditTools: ['edit'],
    readOnlyTools: ['read'],
    classifierEnabled: false,
    ...config,
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'Bash',
    description: 'shell',
    parameters: { command: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
  }))
  if (Object.keys(settings).length > 0) {
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, settings)
  }
  return ctx
}

function exec(name: string, args: unknown, agent?: Agent): ToolExecutionInput {
  return {
    signal: testToolSignal,
    callId: ToolCallId('c1'),
    name,
    arguments: args,
    ...(agent ? { agent } : {}),
  }
}

function text(result: ToolExecutionResult): string {
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

function agentWithSandbox(id: string, sandbox?: string): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  if (sandbox !== undefined) {
    ;(session.append as (type: string, payload: { mode: string }) => unknown)('sandbox/mode', { mode: sandbox })
  }
  return { id, session, inject: () => {} } as unknown as Agent
}

/** The two curated critical commands, and the deny reason's guard-layer shape. */
const CRITICAL_COMMANDS: Record<string, string> = {
  'rm -rf /': 'force/recursive remove of root',
  ':(){ :|:& };:': 'fork bomb',
}
const GUARD_REASON = /denied by permission rule Bash\(\/.+\/\) \[curated\] \(bypass-immune\)/
const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']
const SANDBOXES: readonly (string | undefined)[] = [undefined, 'workspace-write', 'danger-full-access']

describe('CRITICAL_BASH_PATTERNS', () => {
  it('holds exactly the two pinned patterns', () => {
    expect(CRITICAL_BASH_PATTERNS).toHaveLength(2)
    expect(CRITICAL_BASH_PATTERNS[0]!.regex.source).toBe('\\brm\\s+-[a-z]*[rf][a-z]*\\s+(?:\\/(?:\\s|$)|~(?:\\s|$|\\/))')
    expect(CRITICAL_BASH_PATTERNS[1]!.regex.source).toBe('\\(\\s*\\)\\s*\\{[^{}]*\\|[^{}]*&[^{}]*\\}')
  })
})

describe('critical deny matrix: patterns × modes × sandbox grants', () => {
  for (const command of Object.keys(CRITICAL_COMMANDS)) {
    for (const mode of MODES) {
      for (const sandbox of SANDBOXES) {
        const label = `${command} × ${mode}${sandbox === undefined ? '' : ` × ${sandbox}`}`
        it(`denies ${label} with the guard-layer reason (classifier off, dangerousPatterns replaced)`, async () => {
          const ctx = await mount({}, { dangerousPatterns: ['\\bnevermatches\\b'] })
          const agent = agentWithSandbox(`m-${mode}-${sandbox ?? 'none'}`.replace(/[^a-z0-9-]/gi, '-'), sandbox)
          if (mode === 'plan') {
            ;(agent.session.append as (type: string, payload: { active: boolean }) => unknown)('plan/mode', { active: true })
          } else if (mode !== 'default') {
            ctx.permissionRules.setMode(agent, mode)
          }
          const result = await ctx.tools.execute(exec('Bash', { command }, agent))
          expect(result.isError).toBe(true)
          // Plan mode's pre-existing read-only wrap denies mutating calls
          // before the guard layer; every other mode shows the guard reason.
          if (mode === 'plan') {
            expect(text(result)).toMatch(/plan mode is read-only|bypass-immune/)
          } else {
            expect(text(result)).toMatch(GUARD_REASON)
          }
        })
      }
    }
  }
})

describe('non-critical behavior is unchanged', () => {
  it('with the classifier off and dangerousPatterns replaced, sudo runs (not reclassified)', async () => {
    const ctx = await mount({}, { dangerousPatterns: ['\\bnevermatches\\b'] })
    const result = await ctx.tools.execute(exec('Bash', { command: 'sudo ls' }))
    expect(result.isError).toBe(false)
  })

  it('with the classifier on (default config), a HIGH command still hard-denies via the classifier', async () => {
    const ctx = await mount({ classifierEnabled: true })
    const result = await ctx.tools.execute(exec('Bash', { command: 'sudo ls' }))
    expect(result.isError).toBe(true)
    expect(text(result)).not.toMatch(GUARD_REASON)
  })
})

describe('settings criticalDeny (append-only, hot reload)', () => {
  it('appends a settings pattern AFTER the built-ins and denies with [curated]', async () => {
    const ctx = await mount()
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { criticalDeny: ['\\bshutdown\\b'] })
    const result = await ctx.tools.execute(exec('Bash', { command: 'shutdown now' }))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(GUARD_REASON)
    // Built-ins still deny alongside the appended entry.
    expect((await ctx.tools.execute(exec('Bash', { command: 'rm -rf /' }))).isError).toBe(true)
    // Removal on reload drops only the appended entry.
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { criticalDeny: [] })
    const restored = await ctx.tools.execute(exec('Bash', { command: 'shutdown now' }))
    expect(restored.isError).toBe(false)
  })

  it('skips an invalid criticalDeny regex instead of throwing', async () => {
    const ctx = await mount()
    // Must not throw even with an invalid regex source in the batch.
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, {
      criticalDeny: ['([unclosed', '\\bshutdown\\b'],
    })
    const bad = await ctx.tools.execute(exec('Bash', { command: 'ls (x' }))
    expect(bad.isError).toBe(false)
    const good = await ctx.tools.execute(exec('Bash', { command: 'shutdown now' }))
    expect(good.isError).toBe(true)
    expect(text(good)).toMatch(GUARD_REASON)
  })
})

describe('bypass-immune DSL regression guard', () => {
  it('a wildcard/prefix bypassImmune rule still parses and denies under bypass', async () => {
    const ctx = await mount({ rules: { bypassImmune: ['edit(.git*)'] } })
    const agent = agentWithSandbox('dsl-reg')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('edit', { file_path: '.git/config' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/bypass-immune/)
  })
})
