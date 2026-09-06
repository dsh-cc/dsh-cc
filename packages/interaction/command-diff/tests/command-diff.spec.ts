import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import * as commandDiff from '@dsh-cc/command-diff'
import { capDiff, formatDiffStat, MAX_DIFF_LINES } from '@dsh-cc/command-diff/diff'

const LONG_DIFF = Array.from({ length: 500 }, (_, i) => `+line ${i}`).join('\n')

/** Configurable fake shell satisfying the `ctx.shell` seam. */
class FakeShell {
  isRepo = true
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/cwd',
      timeoutMs: request.timeoutMs ?? 0,
      stdoutMaxBytes: 1_000_000,
      sandboxPolicy: undefined,
    }
  }
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const command = spec.command
    if (command.includes('rev-parse')) {
      return this.isRepo
        ? result(0, 'true\n', '')
        : result(128, '', 'fatal: not a git repository')
    }
    if (command.includes('diff --stat')) {
      return result(0, '1 file changed, 2 insertions(+)\n', '')
    }
    if (command.includes('diff --')) {
      return result(0, LONG_DIFF, '')
    }
    return result(0, '', '')
  }
  async start(): Promise<ShellProcess> {
    throw new Error('start not used in tests')
  }
  get sandboxMode() { return undefined }
}

function result(exitCode: number, stdout: string, stderr: string): ShellRunResult {
  return {
    exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 0,
    stdout: { text: stdout, truncated: false },
    stderr: { text: stderr, truncated: false },
  }
}

async function harness(): Promise<{
  ctx: Context
  agent: Agent
  plugin: Awaited<ReturnType<Context['plugin']>>
  shell: FakeShell
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const shell = new FakeShell()
  ctx.reflect.provide('shell', shell)
  const plugin = await ctx.plugin(commandDiff)
  const session = ctx.sessions.create(SessionId(`command-diff-${Math.random()}`))
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
  return { ctx, agent, plugin, shell }
}

describe('@dsh-cc/command-diff registration', () => {
  it('registers one global command with Loader-safe exports and disposes it', async () => {
    expect(commandDiff.name).toBe('command-diff')
    expect(commandDiff.inject).toEqual(['commands', 'shell'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandDiff)).toBe(commandDiff)
    const { ctx, agent, plugin } = await harness()
    expect(ctx.commands.find(agent, 'diff')).toBeDefined()
    await plugin.dispose()
    expect(ctx.commands.find(agent, 'diff')).toBeUndefined()
  })
})

describe('/diff rendering', () => {
  it('caps long diff output to the bounded line count', () => {
    const capped = capDiff(LONG_DIFF, MAX_DIFF_LINES)
    const lines = capped.split('\n')
    expect(lines.length).toBe(MAX_DIFF_LINES + 1) // capped lines + truncation note
    expect(lines.at(-1)).toContain('100 more lines')
  })
  it('does not cap short output and formats an empty stat', () => {
    expect(capDiff('a\nb', 400)).toBe('a\nb')
    expect(formatDiffStat('')).toBe('No changes.')
    expect(formatDiffStat('  1 file changed  ')).toBe('1 file changed')
  })
})

describe('/diff human command', () => {
  it('shows the diff stat with no argument', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/diff', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('1 file changed, 2 insertions(+)')
  })
  it('shows a capped diff for a targeted path', async () => {
    const { ctx, agent } = await harness()
    const execution = await ctx.commands.execute(agent, '/diff src/index.ts', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text.split('\n').length).toBeLessThanOrEqual(MAX_DIFF_LINES + 2)
    expect(text).toContain('100 more lines')
  })
  it('reports a friendly message when not a git repository', async () => {
    const { ctx, agent, shell } = await harness()
    shell.isRepo = false
    const execution = await ctx.commands.execute(agent, '/diff', [], new AbortController().signal)
    const text = (execution?.result as { text: string }).text
    expect(text).toContain('Not a git repository')
  })
})
