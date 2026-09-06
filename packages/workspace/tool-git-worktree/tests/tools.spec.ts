/**
 * Unit tests for the git-worktree tools over a scripted fake shell executor and
 * fake filesystem. Exercises schema validation, git-command construction, the
 * non-repo error path, the remove safety gate (refusal with evidence), keep /
 * remove flows, concurrency marking, and the pure presentation functions.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@dsh-cc/tools'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import { FileSystem } from '@deepseek-ai/dsh-fs'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import * as ToolGitWorktree from '@dsh-cc/tool-git-worktree'
import { clearActiveWorktreeSession } from '../src/worktree.ts'

const signal = new AbortController().signal

/** A scripted shell executor: each git command matches a scripted outcome. */
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
    throw new Error('git-worktree never starts background shells')
  }
}

/** Fake file system: resolve() keys targets by path; contains() is path-prefix. */
class FakeFs extends FileSystem {
  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: path as unknown as FsTarget['targetKey'], displayPath: path }
  }
  override processPath(target: FsTarget): string { return target.displayPath }
  override fileUrl(target: FsTarget): string { return `file://${target.displayPath}` }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    return child.displayPath === parent.displayPath || child.displayPath.startsWith(`${parent.displayPath}/`)
  }
  override async stat(): Promise<undefined> { return undefined }
  override async lstat(): Promise<undefined> { return undefined }
  override async readText(): Promise<string> { return '' }
  override async streamText(): Promise<AsyncIterable<string>> { return (async function* () {})() }
  override async readBytes(): Promise<Uint8Array> { return new Uint8Array() }
  override async listDir(): Promise<never[]> { return [] }
  override async writeText(): Promise<never> { throw new Error('unused') }
  override async editText(): Promise<never> { throw new Error('unused') }
}

const sessionCwdAgent = (cwd: string): Agent =>
  ({ inject: () => undefined, session: { header: { version: 0, id: 's', createdAt: 0, cwd } } }) as unknown as Agent

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ScriptedShell)
  await ctx.plugin(FakeFs)
  await ctx.plugin(ToolGitWorktree)
  return { ctx, shell: ctx.shell as ScriptedShell }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({ signal, callId: CallId(`call-${++callCounter}`), name, arguments: args, ...agent ? { agent } : {} })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

beforeEach(() => clearActiveWorktreeSession())

describe('EnterWorktree', () => {
  const repo = join(mkdtempSync(join(tmpdir(), 'dsh-wt-unit-')), 'repo')

  it('rejects schema-invalid args', async () => {
    const { ctx } = await setup()
    const bad = await call(ctx, 'EnterWorktree', { name: 42 }, sessionCwdAgent(repo))
    expect(bad.isError).toBe(true)
    expect(text(bad)).toMatch(/"name" must be a string/)
  })

  it('returns a structured error when not in a git repository', async () => {
    const { ctx } = await setup()
    const notRepo = join(mkdtempSync(join(tmpdir(), 'dsh-wt-notrepo-')), 'plain')
    // git rev-parse --show-toplevel fails (exit 128).
    ;(ctx.shell as ScriptedShell).script.push({ match: /show-toplevel/, result: { exitCode: 128, stderr: { text: 'fatal: not a git repository', truncated: false } } })
    const result = await call(ctx, 'EnterWorktree', {}, sessionCwdAgent(notRepo))
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not in a git repository')
  })

  it('rejects a name that is not a safe slug before running git worktree add', async () => {
    const { ctx, shell } = await setup()
    shell.script = [{ match: /show-toplevel/, result: { stdout: { text: repo, truncated: false } } }]
    const result = await call(ctx, 'EnterWorktree', { name: '../escape' }, sessionCwdAgent(repo))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/invalid worktree name "\.\.\/escape"/)
    expect(text(result)).toMatch(/must not contain/)
    expect(shell.requests.some(r => r.command.includes('worktree add'))).toBe(false)
  })

  it('creates a worktree with a named slug, builds the git command, and declares the cwd', async () => {
    const { ctx, shell } = await setup()
    shell.script = [
      { match: /show-toplevel/, result: { stdout: { text: repo, truncated: false } } },
      { match: /rev-parse HEAD/, result: { stdout: { text: 'abc123', truncated: false } } },
      { match: /worktree add/, result: { exitCode: 0 } },
    ]
    const result = await call(ctx, 'EnterWorktree', { name: 'feature/x' }, sessionCwdAgent(repo))
    expect(result.isError).toBe(false)
    const value = result.value as { worktreePath: string; worktreeBranch: string }
    expect(value.worktreePath).toBe(join(repo, '.claude', 'worktrees', 'feature+x'))
    expect(value.worktreeBranch).toBe('worktree-feature+x')
    expect(text(result)).toContain(value.worktreePath)

    const add = shell.requests.find(r => r.command.includes('worktree add'))
    expect(add?.command).toContain(`git worktree add -B 'worktree-feature+x' '${join(repo, '.claude', 'worktrees', 'feature+x')}' HEAD`)
    expect(add?.workdir).toBe(repo)

    // The runtime context declares the worktree cwd to the model.
    const assembly = await ctx.systemPrompt.assemble()
    expect(renderContextSnapshot(assembly)).toContain(`Current working directory: ${value.worktreePath}`)
  })

  it('generates a random, valid slug when no name is given', async () => {
    const { ctx, shell } = await setup()
    shell.script = [
      { match: /show-toplevel/, result: { stdout: { text: repo, truncated: false } } },
      { match: /rev-parse HEAD/, result: { stdout: { text: 'abc123', truncated: false } } },
      { match: /worktree add/, result: { exitCode: 0 } },
    ]
    const result = await call(ctx, 'EnterWorktree', {}, sessionCwdAgent(repo))
    expect(result.isError).toBe(false)
    const add = shell.requests.find(r => r.command.includes('worktree add'))
    expect(add?.command).toMatch(/\.claude\/worktrees\/[a-z]+-[a-z]+-[a-z0-9]{4}['"]/)
  })

  it('marks EnterWorktree as not concurrency-safe', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('EnterWorktree')?.isConcurrencySafe?.({})).toBe(false)
  })
})

describe('ExitWorktree', () => {
  const repo = join(mkdtempSync(join(tmpdir(), 'dsh-wt-unit-')), 'repo')
  const worktreePath = join(repo, '.claude', 'worktrees', 'feature+x')

  async function entered(ctx: Context): Promise<void> {
    const shell = ctx.shell as ScriptedShell
    shell.script = [
      { match: /show-toplevel/, result: { stdout: { text: repo, truncated: false } } },
      { match: /rev-parse HEAD/, result: { stdout: { text: 'abc123', truncated: false } } },
      { match: /worktree add/, result: { exitCode: 0 } },
    ]
    const result = await call(ctx, 'EnterWorktree', { name: 'feature/x' }, sessionCwdAgent(repo))
    expect(result.isError).toBe(false)
  }

  it('is a no-op when no EnterWorktree session is active', async () => {
    const { ctx } = await setup()
    const result = await call(ctx, 'ExitWorktree', { action: 'keep' }, sessionCwdAgent(repo))
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/No-op: there is no active EnterWorktree session/)
  })

  it('refuses remove with uncommitted files, listing the evidence, unless discard_changes', async () => {
    const { ctx, shell } = await setup()
    await entered(ctx)
    shell.script = [
      { match: /status --porcelain/, result: { stdout: { text: ' M file.txt\n', truncated: false } } },
      { match: /rev-list --count/, result: { stdout: { text: '0', truncated: false } } },
    ]
    const refused = await call(ctx, 'ExitWorktree', { action: 'remove' }, sessionCwdAgent(repo))
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/1 uncommitted file/)
    expect(shell.requests.some(r => r.command.includes('worktree remove'))).toBe(false)

    shell.script = [
      { match: /status --porcelain/, result: { stdout: { text: ' M file.txt\n', truncated: false } } },
      { match: /rev-list --count/, result: { stdout: { text: '0', truncated: false } } },
      { match: /worktree remove/, result: { exitCode: 0 } },
      { match: /branch -D/, result: { exitCode: 0 } },
    ]
    const granted = await call(ctx, 'ExitWorktree', { action: 'remove', discard_changes: true }, sessionCwdAgent(repo))
    expect(granted.isError).toBe(false)
    expect(text(granted)).toContain('Exited and removed')
    expect(text(granted)).toContain('1 uncommitted file')
  })

  it('refuses remove with new commits, listing the evidence', async () => {
    const { ctx, shell } = await setup()
    await entered(ctx)
    shell.script = [
      { match: /status --porcelain/, result: { stdout: { text: '', truncated: false } } },
      { match: /rev-list --count/, result: { stdout: { text: '3', truncated: false } } },
    ]
    const refused = await call(ctx, 'ExitWorktree', { action: 'remove' }, sessionCwdAgent(repo))
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/3 commits on worktree-feature\+x/)
    expect(shell.requests.some(r => r.command.includes('worktree remove'))).toBe(false)
  })

  it('fails closed when the worktree state cannot be verified', async () => {
    const { ctx, shell } = await setup()
    await entered(ctx)
    shell.script = [
      { match: /status --porcelain/, result: { exitCode: 128, stderr: { text: 'fatal', truncated: false } } },
    ]
    const refused = await call(ctx, 'ExitWorktree', { action: 'remove' }, sessionCwdAgent(repo))
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/Could not verify worktree state/)
  })

  it('removes a clean worktree and deletes its branch', async () => {
    const { ctx, shell } = await setup()
    await entered(ctx)
    shell.script = [
      { match: /status --porcelain/, result: { stdout: { text: '', truncated: false } } },
      { match: /rev-list --count/, result: { stdout: { text: '0', truncated: false } } },
      { match: /worktree remove/, result: { exitCode: 0 } },
      { match: /branch -D/, result: { exitCode: 0 } },
    ]
    const result = await call(ctx, 'ExitWorktree', { action: 'remove' }, sessionCwdAgent(repo))
    expect(result.isError).toBe(false)
    const value = result.value as { action: string; worktreePath: string; discardedFiles?: number }
    expect(value.action).toBe('remove')
    expect(value.worktreePath).toBe(worktreePath)
    expect(value.discardedFiles).toBe(0)
    const remove = shell.requests.find(r => r.command.includes('worktree remove'))
    expect(remove?.command).toContain(`git worktree remove --force '${worktreePath}'`)
    expect(remove?.workdir).toBe(repo)
  })

  it('keeps the worktree and returns to the original directory', async () => {
    const { ctx, shell } = await setup()
    await entered(ctx)
    const result = await call(ctx, 'ExitWorktree', { action: 'keep' }, sessionCwdAgent(repo))
    expect(result.isError).toBe(false)
    const value = result.value as { action: string; originalCwd: string }
    expect(value.action).toBe('keep')
    expect(value.originalCwd).toBe(repo)
    expect(text(result)).toContain('preserved')
    expect(shell.requests.some(r => r.command.includes('worktree remove'))).toBe(false)
  })

  it('marks ExitWorktree as not concurrency-safe', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('ExitWorktree')?.isConcurrencySafe?.({ action: 'keep' })).toBe(false)
  })
})

describe('registration and presentation', () => {
  it('registers only EnterWorktree and ExitWorktree by default', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(['EnterWorktree', 'ExitWorktree'])
  })

  it('unregisters everything on plugin disposal (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ScriptedShell)
    await ctx.plugin(FakeFs)
    const fiber = await ctx.plugin(ToolGitWorktree)
    expect(ctx.tools.schemas()).toHaveLength(2)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('presentCall / presentResult are pure functions of args', async () => {
    const { ctx } = await setup()
    const enter = ctx.tools.get('EnterWorktree')!
    expect(enter.presentCall?.({})).toMatchObject({ card: 'generic', kind: 'execute', title: 'Creating worktree' })
    expect(enter.presentCall?.({ name: 'x' })).toMatchObject({ card: 'generic', rawInput: 'x' })
    expect(enter.presentResult?.({}, { content: [{ type: 'text', text: 'Created worktree at /wt' }], isError: false }))
      .toEqual({ card: 'generic', content: [{ type: 'text', text: 'Created worktree at /wt' }] })
    // Errors are shown as fenced text.
    const err = enter.presentResult?.({}, { content: [{ type: 'text', text: 'not a git repo' }], isError: true })
    expect(err).toMatchObject({ card: 'generic' })
    expect((err as { content: { text: string }[] }).content[0]!.text).toContain('```')
  })

  it('ExitWorktree presentCall surfaces remove vs keep distinctly', async () => {
    const { ctx } = await setup()
    const exit = ctx.tools.get('ExitWorktree')!
    expect(exit.presentCall?.({ action: 'remove' })).toMatchObject({ card: 'generic', title: 'Removing worktree' })
    expect(exit.presentCall?.({ action: 'keep' })).toMatchObject({ card: 'generic', title: 'Keeping worktree' })
    expect(exit.presentResult?.({ action: 'remove' }, { content: [{ type: 'text', text: 'Exited and removed' }], isError: false }))
      .toEqual({ card: 'generic', content: [{ type: 'text', text: 'Exited and removed' }] })
  })

  it('config disables a tool when its enable flag is false', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ScriptedShell)
    await ctx.plugin(FakeFs)
    await ctx.plugin(ToolGitWorktree, { enableExitWorktree: false })
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(['EnterWorktree'])
  })
})
