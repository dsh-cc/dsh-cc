import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type ToolExecutionInput, type ToolExecutionResult } from '@dsh-cc/tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { foldPlanMode, foldPermissionMode, foldSandboxMode } from '@dsh-cc/permission-rules'
import PermissionRules, { PERMISSION_SETTINGS_NAMESPACE, type Config } from '@dsh-cc/permission-rules'
import type { Agent } from '@deepseek-ai/dsh-agent'

const testToolSignal = new AbortController().signal

/** Writable memory provider for the permission/settings lifecycle specs. */
class MemorySettings extends SettingsProvider {
  readonly doc: Record<string, unknown> = {}
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function mount(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  ctx.on('approval/request', async () => 'allowed-once')
  await ctx.plugin(PermissionRules, {
    fileEditTools: ['edit'],
    readOnlyTools: ['read'],
    bashToolName: 'Bash',
    ...config,
  })
  // A fake Bash tool reading a command string.
  ctx.tools.register(defineContentToolFixture({
    name: 'Bash',
    description: 'shell',
    parameters: { command: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
  }))
  // A fake file-edit tool reading a file path.
  ctx.tools.register(defineContentToolFixture({
    name: 'edit',
    description: 'edit file',
    parameters: { file_path: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
  }))
  // A fake read-only tool.
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'read file',
    parameters: { file_path: { type: 'string' } },
    async execute(args) { return [{ type: 'text', text: `read:${(args as { file_path: string }).file_path}` }] },
  }))
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

function openTurnAgent(id: string): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}

/** An agent whose session carries a working directory (enables the escape check). */
function openAgentWithCwd(id: string, cwd: string): Agent {
  const session = Session.create(SessionId(id), undefined, {
    version: 3,
    isSeeded: false,
    id: SessionId(id),
    createdAt: Date.now(),
    cwd,
  })
  session.append('turn/start', { turn: 1 })
  return { id, session, inject: () => {} } as unknown as Agent
}

describe('plugin pre-execute decisions', () => {
  it('allows a call with no matching rule', async () => {
    const ctx = await mount()
    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:ls')
  })

  it('denies a whole-tool deny rule', async () => {
    const ctx = await mount({ rules: { deny: ['Bash'] } })
    const result = await ctx.tools.execute(exec('Bash', { command: 'anything' }))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/denied by permission rule Bash \[config\]/)
  })

  it('denies a content prefix deny rule', async () => {
    const ctx = await mount({ rules: { deny: ['Bash(rm -rf)'] } })
    const ok = await ctx.tools.execute(exec('Bash', { command: 'echo hi' }))
    expect(ok.isError).toBe(false)
    const denied = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /tmp/x' }))
    expect(denied.isError).toBe(true)
    expect(text(denied)).toMatch(/Bash\(rm -rf\)/)
  })

  it('routes a whole-tool ask through approval and runs on allowed-once', async () => {
    const ctx = await mount({ rules: { ask: ['Bash'] } })
    const agent = openTurnAgent('ask-agent')
    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:ls')
  })

  it('denies a whole-tool ask without an approval channel (fail closed)', async () => {
    const ctx = await mount({ rules: { ask: ['Bash'] } })
    // No agent in the input: the approval seam cannot route, so it denies.
    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }))
    expect(result.isError).toBe(true)
  })
})

describe('bypass-immune guards', () => {
  it('denies a bypass-immune match even under bypassPermissions mode', async () => {
    const ctx = await mount({ rules: { bypassImmune: ['edit(.git*)'] } })
    const agent = openTurnAgent('imm')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('edit', { file_path: '.git/config' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/bypass-immune/)
  })

  it('allows a non-matching subject under bypassPermissions mode', async () => {
    const ctx = await mount({ rules: { bypassImmune: ['edit(.git*)'] } })
    const agent = openTurnAgent('ok')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('edit', { file_path: 'src/main.ts' }, agent))
    expect(result.isError).toBe(false)
  })

  it('enforces the guard even when no pre-execute rule denies', async () => {
    const ctx = await mount({ rules: { bypassImmune: ['edit(.git*)'] } })
    const result = await ctx.tools.execute(exec('edit', { file_path: '.git/config' }))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/bypass-immune/)
  })
})

describe('modes via the plugin', () => {
  it('acceptEdits auto-allows a file-edit call with no rule', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('ae')
    ctx.permissionRules.setMode(agent, 'acceptEdits')
    const result = await ctx.tools.execute(exec('edit', { file_path: 'a.ts' }, agent))
    expect(result.isError).toBe(false)
  })

  it('plan mode auto-allows a read-only call (no rule)', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('plan')
    agent.session.append('plan/mode', { active: true })
    const result = await ctx.tools.execute(exec('read', { file_path: 'a.ts' }, agent))
    expect(result.isError).toBe(false)
  })

  it('bypassPermissions allows a denied tool', async () => {
    const ctx = await mount({ rules: { deny: ['Bash(rm -rf)'] } })
    const agent = openTurnAgent('bypass')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /tmp/x' }, agent))
    expect(result.isError).toBe(false)
  })
})

describe('settings config and hot reload', () => {
  it('merges settings rules with config rules by source priority', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    // no approval service needed here — all cases are allow/deny.
    await ctx.plugin(PermissionRules, { rules: { deny: ['Bash(npm install)'] } })
    ctx.tools.register(defineContentToolFixture({
      name: 'Bash',
      description: 'shell',
      parameters: { command: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
    }))
    // config denies the prefix; settings (higher priority) allows it.
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, {
      allow: ['Bash(npm install)'],
    })
    const result = await ctx.tools.execute(exec('Bash', { command: 'npm install --save x' }))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:npm install --save x')
  })

  it('hot-reloads on settings change (old listener re-reads merged state)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(PermissionRules)
    ctx.tools.register(defineContentToolFixture({
      name: 'Bash',
      description: 'shell',
      parameters: { command: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
    }))
    const before = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /tmp/x' }))
    expect(before.isError).toBe(false)

    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, {
      deny: ['Bash(rm -rf)'],
    })
    const after = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /tmp/x' }))
    expect(after.isError).toBe(true)
    expect(text(after)).toMatch(/Bash\(rm -rf\)/)
  })

  it('fails loud when settings carry a malformed rule', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(PermissionRules)
    await expect(ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, {
      deny: ['Bash(unclosed'],
    })).rejects.toThrow(TypeError)
  })
})

describe('session mode overrides (durable)', () => {
  it('applies the latest setMode and leaves other sessions at the deployment default', async () => {
    const ctx = await mount({ rules: { deny: ['edit(/tmp/private*)'] } })
    const agent = openTurnAgent('one')
    const other = openTurnAgent('two')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    // bypassPermissions overrides the content-deny for the first session…
    const allowed = await ctx.tools.execute(exec('edit', { file_path: '/tmp/private/x' }, agent))
    expect(allowed.isError).toBe(false)
    // …while another session stays at the default mode and remains denied.
    const denied = await ctx.tools.execute(exec('edit', { file_path: '/tmp/private/x' }, other))
    expect(denied.isError).toBe(true)
  })

  it('isolation: one session in bypass while another is denied', async () => {
    const ctx = await mount({ rules: { deny: ['edit(/tmp/private*)'] } })
    const agent = openTurnAgent('iso-one')
    const other = openTurnAgent('iso-two')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const allowed = await ctx.tools.execute(exec('edit', { file_path: '/tmp/private/x' }, agent))
    expect(allowed.isError).toBe(false)
    const denied = await ctx.tools.execute(exec('edit', { file_path: '/tmp/private/x' }, other))
    expect(denied.isError).toBe(true)
  })

  it('records acceptEdits durably as a permission/mode event and re-folds it', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('dur-ae')
    ctx.permissionRules.setMode(agent, 'acceptEdits')
    expect(foldPermissionMode(agent.session.snapshotEvents())).toBe('acceptEdits')
    // An edit still auto-allows under the durable acceptEdits mode.
    const result = await ctx.tools.execute(exec('edit', { file_path: 'a.ts' }, agent))
    expect(result.isError).toBe(false)
  })

  it('entering bypass pins the sandbox to danger-full-access and records resumeSandbox', async () => {
    const ctx = await mount()
    ctx.reflect.provide('shell', { sandboxMode: 'workspace-write' } as never)
    const agent = openTurnAgent('bypass-pin')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const events = agent.session.snapshotEvents()
    const modeEvent = events.filter(e => e.type === 'permission/mode').pop()!
    expect(modeEvent.data).toMatchObject({ mode: 'bypassPermissions', resumeSandbox: 'workspace-write' })
    const sandboxEvent = events.filter(e => e.type === 'sandbox/mode').pop()!
    expect(sandboxEvent.data.mode).toBe('danger-full-access')
  })

  it('leaving bypass restores the recorded resume sandbox', async () => {
    const ctx = await mount()
    ctx.reflect.provide('shell', { sandboxMode: 'workspace-write' } as never)
    const agent = openTurnAgent('bypass-leave')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    ctx.permissionRules.setMode(agent, 'acceptEdits')
    expect(foldSandboxMode(agent.session.snapshotEvents())).toBe('workspace-write')
  })

  it('leaving bypass with no recorded resume falls back to workspace-write', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('bypass-norec')
    ;(agent.session.append as (type: string, payload: { mode: string }) => unknown)('permission/mode', { mode: 'bypassPermissions' })
    ctx.permissionRules.setMode(agent, 'default')
    expect(foldSandboxMode(agent.session.snapshotEvents())).toBe('workspace-write')
  })

  it('auto mode auto-allows a classifier-LOW ask without hitting approval', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const asked: unknown[] = []
    ctx.on('approval/request', async request => { asked.push(request); return 'allowed-once' })
    await ctx.plugin(PermissionRules, {
      fileEditTools: ['edit'], readOnlyTools: ['read'], bashToolName: 'Bash',
      rules: { ask: ['Bash'] },
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'Bash',
      description: 'shell',
      parameters: { command: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
    }))
    const agent = openTurnAgent('auto-low')
    ctx.permissionRules.setMode(agent, 'auto')
    const result = await ctx.tools.execute(exec('Bash', { command: 'ls' }, agent))
    expect(asked).toHaveLength(0)
    expect(result.isError).toBe(false)
  })

  it('auto mode still asks on a classifier-MEDIUM call', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const asked: unknown[] = []
    ctx.on('approval/request', async request => { asked.push(request); return 'allowed-once' })
    await ctx.plugin(PermissionRules, { fileEditTools: ['edit'], readOnlyTools: ['read'], bashToolName: 'Bash' })
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'edit file',
      parameters: { file_path: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
    }))
    const agent = openAgentWithCwd('auto-medium', '/work')
    ctx.permissionRules.setMode(agent, 'auto')
    const result = await ctx.tools.execute(exec('edit', { file_path: '/tmp/out.txt' }, agent))
    expect(asked).toHaveLength(1)
    expect(result.isError).toBe(false)
  })

  it('disableBypassPermissionsMode makes setMode(bypass) throw', async () => {
    const ctx = await mount({ disableBypassPermissionsMode: true })
    const agent = openTurnAgent('disable-bypass')
    expect(() => ctx.permissionRules.setMode(agent, 'bypassPermissions')).toThrow(/disabled/)
  })

  it('setMode(plan) throws because plan is owned by plan-mode', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('plan-owned')
    expect(() => ctx.permissionRules.setMode(agent, 'plan')).toThrow(/plan-mode/)
  })

  it('injects a user-visible mode-change notice when the agent supports inject', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('inject-notice')
    const session = agent.session
    const inject = vi.fn()
    ;(agent as unknown as { inject: () => void }).inject = inject
    ctx.permissionRules.setMode(agent, 'acceptEdits')
    expect(inject).toHaveBeenCalledTimes(1)
    expect(session.snapshotEvents().some(e => e.type === 'permission/mode')).toBe(true)
  })

  it('session/created pin: bypassPermissions default pins the new session to full access', async () => {
    const ctx = await mount({ defaultMode: 'bypassPermissions' })
    ctx.reflect.provide('shell', { sandboxMode: 'workspace-write' } as never)
    const session = ctx.sessions.create(SessionId('pin-bypass'))
    expect(foldPermissionMode(session.snapshotEvents())).toBe('bypassPermissions')
    expect(foldSandboxMode(session.snapshotEvents())).toBe('danger-full-access')
  })

  it('session/created pin: plan default seeds plan/mode active on the new session', async () => {
    const ctx = await mount({ defaultMode: 'plan' })
    const session = ctx.sessions.create(SessionId('pin-plan'))
    expect(foldPlanMode(session.snapshotEvents())).toBe(true)
  })

  it('plan non-read-only is denied at the plugin layer with exit_plan_mode guidance', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('plan-deny')
    agent.session.append('plan/mode', { active: true })
    const result = await ctx.tools.execute(exec('edit', { file_path: 'a.ts' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/exit_plan_mode/)
  })
})

describe('CC-vs-harness tool-name alias matching', () => {
  // The harness dispatches tool calls under lowercase names (e.g. `bash`,
  // `edit`); CC-authored rules keep their authored spelling (`Bash`, `Edit`).
  // A lowercase harness tool answers to the CC-cased rule and vice versa.
  function registerLowercaseBash(ctx: Context): void {
    ctx.tools.register(defineContentToolFixture({
      name: 'bash',
      description: 'shell',
      parameters: { command: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `ran:${(args as { command: string }).command}` }] },
    }))
  }

  it('a CC-cased `Bash(npm run *)` rule matches harness exec.name `bash`', async () => {
    const ctx = await mount({ rules: { deny: ['Bash(npm run *)'] } })
    registerLowercaseBash(ctx)
    const ok = await ctx.tools.execute(exec('bash', { command: 'echo hi' }))
    expect(ok.isError).toBe(false)
    const denied = await ctx.tools.execute(exec('bash', { command: 'npm run build' }))
    expect(denied.isError).toBe(true)
    expect(text(denied)).toMatch(/Bash\(npm run/)
  })

  it('a lowercase-authored `bash(...)` rule also matches harness exec.name `bash`', async () => {
    const ctx = await mount({ rules: { deny: ['bash(echo hi)'] } })
    registerLowercaseBash(ctx)
    const denied = await ctx.tools.execute(exec('bash', { command: 'echo hi' }))
    expect(denied.isError).toBe(true)
    expect(text(denied)).toMatch(/bash\(echo hi\)/)
  })

  it('a CC-cased `Edit(...)` rule matches harness exec.name `edit`', async () => {
    const ctx = await mount({ rules: { deny: ['Edit(a.ts)'] } })
    const ok = await ctx.tools.execute(exec('edit', { file_path: 'b.ts' }))
    expect(ok.isError).toBe(false)
    const denied = await ctx.tools.execute(exec('edit', { file_path: 'a.ts' }))
    expect(denied.isError).toBe(true)
    expect(text(denied)).toMatch(/Edit\(a\.ts\)/)
  })

  it('the sandboxed-bash exemption fires for exec.name `bash` under the default `Bash` config', async () => {
    const ctx = await mount({ rules: { ask: ['Bash'] }, exemptSandboxedBashFromToolAsk: true })
    ctx.reflect.provide('shell', { get sandboxMode() { return 'workspace-write' } } as never)
    registerLowercaseBash(ctx)
    const agent = openTurnAgent('sbx')
    // Sandbox-confined `bash` is exempted from the whole-tool ask, so it runs.
    const result = await ctx.tools.execute(exec('bash', { command: 'ls' }, agent))
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('ran:ls')
  })

  it('risk classification extracts the command for exec.name `bash`', async () => {
    const ctx = await mount()
    registerLowercaseBash(ctx)
    const agent = openTurnAgent('rc-bash')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('bash', { command: 'rm -rf /' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/risk classifier/)
  })
})

describe('risk-classifier escalation', () => {
  it('hard-denies a catastrophic command in every mode, including bypassPermissions', async () => {
    const ctx = await mount()
    const agent = openTurnAgent('high-bypass')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/risk classifier/)
  })

  it('hard-denies a protected-file write', async () => {
    const ctx = await mount()
    const agent = openAgentWithCwd('high-file', '/work')
    const result = await ctx.tools.execute(exec('edit', { file_path: '/work/.bashrc' }, agent))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/risk classifier/)
  })

  it('allows an out-of-scope write under bypassPermissions (MEDIUM → allow)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const asked: unknown[] = []
    ctx.on('approval/request', async request => { asked.push(request); return 'allowed-once' })
    await ctx.plugin(PermissionRules, { fileEditTools: ['edit'], readOnlyTools: ['read'], bashToolName: 'Bash' })
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'edit file',
      parameters: { file_path: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
    }))

    const agent = openAgentWithCwd('medium-bypass', '/work')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    const result = await ctx.tools.execute(exec('edit', { file_path: '/tmp/out.txt' }, agent))
    expect(result.isError).toBe(false)
    expect(asked).toHaveLength(0)
  })

  it('asks on an out-of-scope write under default mode (MEDIUM → ask)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    const asked: unknown[] = []
    ctx.on('approval/request', async request => { asked.push(request); return 'allowed-once' })
    await ctx.plugin(PermissionRules, { fileEditTools: ['edit'], readOnlyTools: ['read'], bashToolName: 'Bash' })
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'edit file',
      parameters: { file_path: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: `edited:${(args as { file_path: string }).file_path}` }] },
    }))

    const agent = openAgentWithCwd('medium-default', '/work')
    const result = await ctx.tools.execute(exec('edit', { file_path: '/tmp/out.txt' }, agent))
    expect(asked).toHaveLength(1)
    expect(result.isError).toBe(false)
  })

  it('skips the classifier stage when classifierEnabled is false', async () => {
    const ctx = await mount({ classifierEnabled: false })
    const agent = openTurnAgent('disabled')
    ctx.permissionRules.setMode(agent, 'bypassPermissions')
    // The catastrophic command is no longer hard-denied once the stage is off.
    const result = await ctx.tools.execute(exec('Bash', { command: 'rm -rf /' }, agent))
    expect(result.isError).toBe(false)
  })
})

describe('defaultMode getter (live merged settings default)', () => {
  it('returns the constructor-config defaultMode', async () => {
    const ctx = await mount({ defaultMode: 'acceptEdits' })
    expect(ctx.permissionRules.defaultMode).toBe('acceptEdits')
  })

  it('reflects a settings reload (live state, not a boot snapshot)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(MemorySettings)
    await ctx.plugin(PermissionRules, { defaultMode: 'auto' })
    expect(ctx.permissionRules.defaultMode).toBe('auto')
    await ctx.settings.update(PERMISSION_SETTINGS_NAMESPACE, { defaultMode: 'acceptEdits' })
    expect(ctx.permissionRules.defaultMode).toBe('acceptEdits')
  })
})
