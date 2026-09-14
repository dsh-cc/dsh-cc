/**
 * WS-3 unit coverage: `isolation: worktree` dispatch over the REAL Task tool
 * with a scripted fake shell (docs/plans/2026-09-14-cc-worktree-parity.md §6
 * flow 1–4, §8 WS-3 row). Pins the creation argv (filter neutralization),
 * the persona/prompt contract, `setSessionCwd` on the child only, the
 * dispatch-time sandbox refusal, old-git lock tolerance, and the
 * clean→remove vs dirty→keep end cleanup (with the remove-notify line).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { AgentRegistry } from '../src/registry.ts'
import { registerTaskTool, TASK_TOOL } from '../src/tool.ts'
import { sessionCwdStore } from '@dsh-cc/session-cwd'

const signal = new AbortController().signal

/** Scripted shell executor (same shape as tool-git-worktree's tools.spec). */
class ScriptedShell extends ShellExecutor {
  requests: ShellExecRequest[] = []
  script: Array<{ match: RegExp; result?: Partial<ShellRunResult> }> = []

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 1000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      sandboxPolicy: undefined,
      ...(request.signal ? { signal: request.signal } : {}),
    }
  }

  private outcome(spec: ShellExecSpec): ShellRunResult {
    const hit = this.script.find(entry => entry.match.test(spec.command))
    const base: ShellRunResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    }
    return {
      ...base,
      ...hit?.result,
      stdout: { ...base.stdout, ...hit?.result?.stdout },
      stderr: { ...base.stderr, ...hit?.result?.stderr },
    }
  }

  run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.requests.push({ command: spec.command, workdir: spec.workdir })
    return Promise.resolve(this.outcome(spec))
  }

  start(_spec: ShellExecSpec): ShellProcess {
    throw new Error('isolation never starts background shells')
  }
}

/** Fake lifecycle agent for the adopt probe: records appended session events. */
function fakeChildAgent(id: string): Agent & { appended: { type: string; data?: unknown }[] } {
  const appended: { type: string; data?: unknown }[] = []
  return {
    session: {
      id,
      header: { cwd: '/child-header-cwd' },
      append: (type: string, data: unknown) => { appended.push({ type, data }) },
      snapshotEvents: () => appended,
    },
    appended,
  } as never
}

const COMPLETED = { stopReason: 'completed', output: [{ type: 'text', text: 'done' }] } as const

/**
 * The scripted git outcomes for one isolated dispatch against workspace root
 * `ws`. `filters` feeds the local-config scan; extra entries override.
 */
function creationScript(ws: string): Array<{ match: RegExp; result?: Partial<ShellRunResult> }> {
  const configEntries = ['core.bare=false', 'filter.lfs.smudge=git lfs smudge %f'].join('\0')
  return [
    { match: /rev-parse --git-common-dir/, result: { stdout: { text: `${ws}/.git`, truncated: false } } },
    { match: /config --local --list/, result: { stdout: { text: `${configEntries}\0`, truncated: false } } },
    { match: /rev-parse HEAD/, result: { stdout: { text: 'abc123def456', truncated: false } } },
    { match: /worktree add/, result: {} },
    { match: /worktree lock/, result: {} },
  ]
}

interface Mount {
  ctx: Context
  requests(): ShellExecRequest[]
  setScript(entries: Array<{ match: RegExp; result?: Partial<ShellRunResult> }>): void
  emit(event: string, info: Record<string, unknown>): void
  continuableStarts(): Record<string, unknown>[]
  childAgent: Agent & { appended: { type: string; data?: unknown }[] }
  agent: Agent
}

const tmpRoots: string[] = []
afterEach(() => {
  for (const dir of tmpRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
  sessionCwdStore.clear()
})

async function mount(opts: { parentCwdInSubdir?: boolean } = {}): Promise<Mount> {
  const ws = mkdtempSync(join(tmpdir(), 'task-isolation-'))
  tmpRoots.push(ws)
  mkdirSync(join(ws, '.claude', 'agents'), { recursive: true })
  writeFileSync(
    join(ws, '.claude', 'agents', 'isolated.md'),
    '---\nname: isolated\ndescription: isolated worker\nisolation: worktree\n---\nISOLATED PERSONA MARKER\n',
  )
  const parentCwd = opts.parentCwdInSubdir === true ? join(ws, 'packages', 'app') : ws

  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ScriptedShell)
  const shell = ctx.shell as ScriptedShell
  shell.script = creationScript(ws)
  const childAgent = fakeChildAgent('child-iso-1')

  // Fake agents registry: the adopt listener resolves the child by id.
  ctx.provide('agents', { get: () => childAgent })

  // Fake subagents seam: continuable-capable; records the request and emits
  // the lifecycle events like the in-process runtime (tool.spec pattern).
  const continuableStarts: Record<string, unknown>[] = []
  const emit = (event: string, info: Record<string, unknown>): void => {
    ;(ctx as unknown as { emit(event: string, info: unknown): void }).emit(event, info)
  }
  ctx.provide('subagents', {
    async start() { throw new Error('not used') },
    async startContinuable(spec: Record<string, unknown>) {
      const childId = (spec['childId'] as string | undefined) ?? 'child-iso-1'
      emit('subagent/start', { runId: 'run-1', provider: spec['provider'], id: childId, local: true })
      continuableStarts.push(spec['request'] as Record<string, unknown>)
      emit('subagent/end', {
        runId: 'run-1', provider: 'spawn', id: childId, local: true,
        stopReason: COMPLETED.stopReason, lastAssistantMessage: COMPLETED.output,
      })
      return { childId, messageId: 'm-1' }
    },
    getProvider: () => ({ prepareContinuable: async () => ({}) }),
    list: () => ['spawn'],
  })

  const registry = new AgentRegistry()
  registerTaskTool(ctx, registry)

  const agent = { session: { header: { cwd: parentCwd } } } as unknown as Agent
  return {
    ctx,
    requests: () => shell.requests,
    setScript: overrides => { shell.script = [...overrides, ...creationScript(ws)] },
    emit,
    continuableStarts: () => continuableStarts,
    childAgent,
    agent,
  }
}

let callCounter = 0
async function call(ctx: Context, args: Record<string, unknown>, agent: Agent) {
  return (await ctx.tools.execute({
    signal,
    callId: `call-${++callCounter}` as never,
    name: TASK_TOOL,
    arguments: args,
    agent,
  })) as { isError: boolean; content: { type: string; text: string }[] }
}

const text = (result: { content: { type: string; text: string }[] }): string =>
  result.content.map(block => block.text).join('')

describe('WS-3 subagent isolation: worktree (fake shell)', () => {
  it('creates a neutralized worktree, folds the contract, adopts the child cwd', async () => {
    const m = await mount()
    const result = await call(m.ctx, {
      subagent_type: 'isolated', description: 'work', prompt: 'task body',
    }, m.agent)
    expect(result.isError).toBe(false)

    const reqs = m.requests()
    // Creation went through the WS-1 hardened path: local-config scan first,
    // then `worktree add` with every local filter neutralized.
    expect(reqs.some(r => r.command.includes('config --local --list'))).toBe(true)
    const add = reqs.find(r => r.command.includes('worktree add'))
    expect(add).toBeDefined()
    for (const key of ['command', 'smudge', 'clean', 'process']) {
      expect(add!.command).toContain(`'-c' 'filter.lfs.${key}='`)
    }
    expect(add!.command).toContain("'filter.lfs.required=false'")
    expect(add!.command).toMatch(/worktree add -B 'worktree-subagent-[0-9a-f-]+' '[^']+' HEAD/)
    // Lock carries the WS-4 sweep reason.
    const lock = reqs.find(r => r.command.includes('worktree lock'))
    expect(lock!.command).toMatch(/lock --reason='dsh-cc subagent [0-9a-f-]+'/)

    // Persona: definition prompt + the absolute-path contract.
    const persona = m.continuableStarts()[0]!['persona'] as string
    expect(persona).toContain('ISOLATED PERSONA MARKER')
    expect(persona).toContain('## Isolated worktree')
    expect(persona).toMatch(/Your working directory is [^ ]*\.claude\/worktrees\/subagent-[0-9a-f-]+/)
    // Prompt: first-line worktree note.
    const prompt = m.continuableStarts()[0]!['prompt'] as { type: string; text: string }[]
    expect(prompt[0]!.text.startsWith('Working directory: ')).toBe(true)
    expect(prompt[0]!.text).toContain('parent checkout off-limits')
    expect(prompt[0]!.text).toContain('\ntask body')

    // Adopt: setSessionCwd targeted the CHILD (durable event on its log only).
    const entered = m.childAgent.appended.filter(e => e.type === 'worktree/entered')
    expect(entered).toHaveLength(1)
    expect((entered[0]!.data as { path: string }).path).toMatch(/\.claude\/worktrees\/subagent-/)
    // The parent's header cwd is untouched.
    expect((m.agent as { session: { header: { cwd: string } } }).session.header.cwd).not.toContain('.claude/worktrees')
  })

  it('removes the worktree + branch on a clean end and stays silent about leftovers', async () => {
    const m = await mount()
    m.setScript([
      { match: /git status --porcelain/, result: {} },
      { match: /rev-list --count/, result: { stdout: { text: '0', truncated: false } } },
      { match: /worktree unlock/, result: {} },
      { match: /worktree remove/, result: {} },
      { match: /branch -D/, result: {} },
    ])
    const result = await call(m.ctx, { subagent_type: 'isolated', description: 'w', prompt: 't' }, m.agent)
    expect(result.isError).toBe(false)
    const reqs = m.requests()
    expect(reqs.some(r => r.command.includes('worktree remove --force'))).toBe(true)
    expect(reqs.some(r => r.command.includes("branch -D 'worktree-subagent-"))).toBe(true)
    expect(reqs.some(r => r.command.includes('worktree unlock'))).toBe(true)
    expect(text(result)).not.toContain('left on disk')
  })

  it('keeps a dirty tree on disk and says so in the final text', async () => {
    const m = await mount()
    m.setScript([
      { match: /git status --porcelain/, result: { stdout: { text: ' M file.txt\n', truncated: false } } },
    ])
    const result = await call(m.ctx, { subagent_type: 'isolated', description: 'w', prompt: 't' }, m.agent)
    expect(result.isError).toBe(false)
    expect(m.requests().some(r => r.command.includes('worktree remove'))).toBe(false)
    expect(m.requests().some(r => r.command.includes('branch -D'))).toBe(false)
    expect(text(result)).toContain('LEFT on disk')
  })

  it('tolerates pre-2.15 git ("unknown option" lock failure) as a no-op', async () => {
    const m = await mount()
    m.setScript([
      { match: /worktree lock/, result: { exitCode: 129, stderr: { text: 'error: unknown option `reason\'', truncated: false } } },
      { match: /git status --porcelain/, result: {} },
      { match: /rev-list --count/, result: { stdout: { text: '0', truncated: false } } },
      { match: /worktree unlock/, result: { exitCode: 129, stderr: { text: "error: unknown option", truncated: false } } },
      { match: /worktree remove/, result: {} },
      { match: /branch -D/, result: {} },
    ])
    const result = await call(m.ctx, { subagent_type: 'isolated', description: 'w', prompt: 't' }, m.agent)
    expect(result.isError).toBe(false)
    expect(m.requests().some(r => r.command.includes('worktree remove --force'))).toBe(true)
  })

  it('refuses the dispatch when the worktree path falls outside the parent sandbox root', async () => {
    const m = await mount({ parentCwdInSubdir: true })
    const result = await call(m.ctx, { subagent_type: 'isolated', description: 'w', prompt: 't' }, m.agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('falls outside the parent session')
    expect(m.requests().some(r => r.command.includes('worktree add'))).toBe(false)
  })

  it('fails the dispatch when worktree creation fails (never falls back silently)', async () => {
    const m = await mount()
    m.setScript([
      { match: /worktree add/, result: { exitCode: 128, stderr: { text: 'fatal: bad object HEAD', truncated: false } } },
    ])
    const result = await call(m.ctx, { subagent_type: 'isolated', description: 'w', prompt: 't' }, m.agent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('worktree isolation for subagent')
  })
})
