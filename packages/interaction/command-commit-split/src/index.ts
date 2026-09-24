/**
 * Advisory dry-run `/commit-split` command: collects the working-tree change
 * through the shell service (three read-only git commands), asks the
 * deep-reasoning lane (alias 'blueprint') for an ordered atomic-commit split
 * plan, and renders it. It NEVER commits — the user (or the model, explicitly
 * asked) executes proposals one by one.
 * @module @dsh-cc/command-commit-split
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { helpable } from '@dsh-cc/command-usage'
import type { SideQueryOptions, SideQueryResult } from '@dsh-cc/side-query'
import { runSideQuery } from '@dsh-cc/side-query'
import { buildPlan, hasNonLockfileChanges, renderPlan, SPLIT_SYSTEM_PROMPT } from './plan.ts'

export { buildPlan, hasNonLockfileChanges, parsePlan, orderPlan, rankOf, renderPlan, SCHEMA_ERROR, DEPS_GROUP_MESSAGE } from './plan.ts'
export type { PlanGroup } from './plan.ts'

export const name = 'command-commit-split'
export const inject = ['commands']

/** Git wall-clock budget for each read (pinned: 5s). */
const GIT_TIMEOUT_MS = 5000

/** The deep-reasoning lane alias (plan C5). */
const ALIAS = 'blueprint'

/** The exact visible note printed when the alias is unconfigured. */
const INHERITED_NOTE = 'note: alias "blueprint" unconfigured; split run on the main model route'

/** Shell-shaped seam used for the git reads (command-doctor git.ts precedent). */
interface ShellLike {
  run?(command: string, options?: { timeout?: number }): Promise<{ stdout?: string } | undefined>
  exec?(command: string, options?: { timeout?: number }): Promise<{ stdout?: string } | undefined>
}

/** Injected collector seam: `run: (cmd, opts) => Promise<{ stdout }>`. */
export type GitRun = (command: string, options?: { timeout?: number }) => Promise<{ stdout?: string } | undefined>

/** Injectable IO seams for the handler (tests inject fakes here). */
export interface CommitSplitIO {
  /** Git collector seam — only ever invoked with `git status|diff` reads. */
  run: GitRun
  /** Side-query seam — defaults to the real `runSideQuery`. */
  runQuery: (ctx: Context, opts: SideQueryOptions) => Promise<SideQueryResult>
}

/** The three exact read-only git commands (plan C5, pinned). */
const GIT_STATUS = 'git status --porcelain'
const GIT_NUMSTAT_CACHED = 'git diff --cached --numstat'
const GIT_NUMSTAT = 'git diff --numstat'

/**
 * Collect the unified staged+unstaged+untracked changed-file list through the
 * injected `run` seam. Only these three commands are ever issued; all reads
 * complete before the side query is awaited.
 * @param run - the git collector seam.
 * @returns the deduplicated changed paths (repo-relative).
 */
export async function collectChangedPaths(run: GitRun): Promise<string[]> {
  const [status, numstatCached, numstat] = await Promise.all([
    run(GIT_STATUS, { timeout: GIT_TIMEOUT_MS }),
    run(GIT_NUMSTAT_CACHED, { timeout: GIT_TIMEOUT_MS }),
    run(GIT_NUMSTAT, { timeout: GIT_TIMEOUT_MS }),
  ])
  const paths = new Set<string>()
  for (const stdout of [status?.stdout, numstatCached?.stdout, numstat?.stdout]) {
    for (const line of (stdout ?? '').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      // `git status --porcelain` rows: `XY path` / `XY orig -> path`.
      // `git diff --numstat` rows: `add\tdeleted\tpath`.
      if (/^[ACDMRTUX?!]{2} /u.test(trimmed)) {
        const path = trimmed.slice(3).split(' -> ').pop() ?? ''
        if (path !== '') paths.add(path)
      } else if (/^\d+\t\d+\t/u.test(trimmed)) {
        const path = trimmed.split('\t')[2] ?? ''
        if (path !== '') paths.add(path)
      }
    }
  }
  return [...paths]
}

/** Build the user prompt listing the changed paths for the split query. */
function splitPrompt(changedPaths: readonly string[]): string {
  return [
    'Changed files (unified staged+unstaged+untracked list):',
    ...changedPaths.map(path => `- ${path}`),
    '',
    'Return the STRICT JSON split plan now.',
  ].join('\n')
}

/**
 * Execute `/commit-split`. All git reads complete before the side query is
 * awaited (never interleaved). Dry-run-only: nothing is ever committed.
 * @param ctx - the host context (`shell` service for git, `llm` for the lane).
 * @param invocation - the command invocation.
 * @param io - injectable seams; defaults to the real shell + runSideQuery.
 * @returns the rendered plan, or an error section without a plan.
 */
export async function executeCommitSplit(
  ctx: Context,
  invocation: CommandInvocation,
  io: CommitSplitIO = defaultIO(ctx),
): Promise<CommandResult> {
  const changedPaths = await collectChangedPaths(io.run)
  // Deterministic shortcut: lockfile-only (or empty) trees need no model call.
  if (!hasNonLockfileChanges(changedPaths)) {
    if (changedPaths.length === 0) {
      return { kind: 'success', text: 'nothing to split: the working tree is clean' }
    }
    const built = buildPlan('[]', changedPaths)
    return 'plan' in built
      ? { kind: 'success', text: renderPlan(built.plan) }
      : { kind: 'error', text: built.error }
  }
  const result = await io.runQuery(ctx, {
    agent: invocation.agent,
    alias: ALIAS,
    system: SPLIT_SYSTEM_PROMPT,
    prompt: splitPrompt(changedPaths),
    // Splitting is not cost-sensitive; give the deep lane room.
    maxTokens: 2048,
  })
  const lines: string[] = []
  if (result.ok && result.inheritedRoute === true) lines.push(INHERITED_NOTE)
  if (!result.ok) return { kind: 'error', text: `error: split query failed (${result.reason})` }
  const built = buildPlan(result.text, changedPaths)
  if ('error' in built) return { kind: 'success', text: [...lines, built.error].join('\n') }
  lines.push(renderPlan(built.plan))
  return { kind: 'success', text: lines.join('\n') }
}

/** Default IO: the mounted shell service's run/exec and the real side query. */
function defaultIO(ctx: Context): CommitSplitIO {
  return {
    run: gitRunFromShell(ctx),
    runQuery: runSideQuery,
  }
}

/** Resolve the shell service's `run` (preferred) or `exec` into a GitRun. */
function gitRunFromShell(ctx: Context): GitRun {
  const shell = ctx.get('shell') as ShellLike | undefined
  const bound = shell?.run?.bind(shell) ?? shell?.exec?.bind(shell)
  if (bound === undefined) return async () => ({ stdout: '' })
  return bound
}

/**
 * Register the `/commit-split` command for every composed command adapter.
 * @param ctx - context carrying the command registry.
 */
export function apply(ctx: Context): void {
  ctx.commands.register(helpable({
    name: 'commit-split',
    description: 'propose an ordered atomic-commit split of the working tree (dry-run only)',
    input: { hint: 'renders the plan; never commits' },
    handler: (invocation: CommandInvocation) => executeCommitSplit(ctx, invocation),
  }, {
    notes: [
      'dry-run only — proposals are executed one by one by you (or the model, if you explicitly ask)',
    ],
  }))
}
