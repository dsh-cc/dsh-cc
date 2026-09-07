/**
 * Human-facing `/diff` command: show `git diff --stat` (no arg) or a capped
 * `git diff <path>` through `ctx.shell`. Timeboxed; a non-git working directory
 * yields a friendly message, never a thrown error.
 * @module @dsh-cc/command-diff
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { helpable } from '@dsh-cc/command-usage'
import { capDiff, formatDiffStat, MAX_DIFF_LINES } from './diff.ts'

export const name = 'command-diff'
export const inject = ['commands', 'shell']

/** Foreground timeout for each git invocation. */
const TIMEOUT_MS = 10_000

/** Wrap a path for safe single-argument use inside the shell command string. */
function shellq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Run one git command through the shell seam. */
async function runGit(ctx: Context, req: ShellExecRequest): Promise<ShellRunResult> {
  const spec = ctx.shell.resolve(req)
  return ctx.shell.run(spec)
}

/** Execute `/diff [path]`. */
async function executeDiff(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const cwd = invocation.agent.session.header.cwd ?? process.cwd()

  const probe = await runGit(ctx, {
    command: `git -C ${shellq(cwd)} rev-parse --is-inside-work-tree`,
    workdir: cwd,
    timeoutMs: TIMEOUT_MS,
  })
  if (probe.exitCode !== 0) {
    return { kind: 'success', text: 'Not a git repository (or git could not run here).' }
  }

  const screenPath = invocation.rawInput.trim()
  if (screenPath.length === 0) {
    const stat = await runGit(ctx, {
      command: `git -C ${shellq(cwd)} diff --stat`,
      workdir: cwd,
      timeoutMs: TIMEOUT_MS,
    })
    return { kind: 'success', text: formatDiffStat(stat.stdout.text) }
  }

  const full = await runGit(ctx, {
    command: `git -C ${shellq(cwd)} diff -- ${shellq(screenPath)}`,
    workdir: cwd,
    timeoutMs: TIMEOUT_MS,
  })
  return { kind: 'success', text: capDiff(full.stdout.text, MAX_DIFF_LINES) }
}

/**
 * Register the `/diff` command for every composed command adapter.
 * @param ctx - context carrying the command registry and shell service.
 */
export function apply(ctx: Context): void {
  ctx.commands.register(helpable({
    name: 'diff',
    description: 'show git diff statistics, or the capped diff for one path',
    input: { hint: '[path]' },
    handler: (invocation: CommandInvocation) => executeDiff(ctx, invocation),
  }))
}
