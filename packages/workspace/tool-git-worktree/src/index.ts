/**
 * Model-facing `EnterWorktree` / `ExitWorktree` tools over the `ctx.shell`
 * executor seam. EnterWorktree creates an isolated git worktree under
 * `<repo>/.claude/worktrees/` and declares the cwd switch; ExitWorktree keeps
 * or removes it after a fail-closed safety gate. Software is `git` today, but
 * every command is constructed in one module so a pure-JS git backend can
 * replace it later.
 * @module @dsh-cc/tool-git-worktree
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { relative, sep } from 'node:path'
import { defineTool, TOOL_ABORTED } from '@dsh-cc/tools'
import type { ToolRunContext } from '@dsh-cc/tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import {
  addWorktree,
  clearActiveWorktreeSession,
  commitsAhead,
  deleteBranch,
  forceRemoveWorktree,
  getActiveWorktreeSession,
  randomSlug,
  repoLabel,
  setActiveWorktreeSession,
  status,
  validateSlug,
  worktreeBranch,
  worktreePathFor,
} from './worktree.ts'
import type { GitCmd, WorktreeSession } from './worktree.ts'
import { presentEnterCall, presentWorktreeResult, presentExitCall } from './render.ts'
import { setSessionCwd } from '@dsh-cc/session-cwd'

export const name = 'tool-git-worktree'
export const inject = ['tools', 'shell', 'systemPrompt', 'fs']

/** Runtime configuration for the git-worktree tools. */
export interface Config {
  /** Whether `EnterWorktree` may create worktrees (default true). */
  enableEnterWorktree?: boolean
  /** Whether `ExitWorktree` may remove worktrees (default true). */
  enableExitWorktree?: boolean
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  enableEnterWorktree: z.boolean().default(true),
  enableExitWorktree: z.boolean().default(true),
})

/** Arguments accepted by the EnterWorktree tool. */
interface EnterWorktreeArgs {
  name?: string
}

/** Arguments accepted by the ExitWorktree tool. */
interface ExitWorktreeArgs {
  action: 'keep' | 'remove'
  discard_changes?: boolean
}

/** A structured, model-visible failure (maps to an isError tool result). */
class WorktreeError extends Error {}

/**
 * Resolve the canonical session working directory this tool operates in.
 * Follows the bash/fs convention of reading the agent's durable session cwd,
 * falling back to the process working directory.
 * @param exec - the running tool call.
 * @returns the absolute cwd, or `undefined` when none is known.
 */
function sessionCwd(exec: ToolRunContext): string | undefined {
  return exec.agent?.session.header.cwd
}

/**
 * Propagate a cwd change into the session-cwd plugin (WS1): a durable
 * `worktree/entered` event plus the live overlay. Tolerant of test fakes and
 * headless contexts whose session face lacks the append seam — the tool must
 * not fail because a non-persistent session cannot record the move.
 * @param exec - the running tool call.
 * @param path - the new absolute session working directory.
 */
function updateSessionCwd(exec: ToolRunContext, path: string): void {
  const agent = exec.agent
  if (agent === undefined) return
  const session = agent.session as unknown as { append?: unknown } | undefined
  if (session === undefined || typeof session.append !== 'function') return
  // Fail-soft: a session that cannot persist the event still completes the
  // worktree operation; the worktree session singleton remains authoritative.
  try {
    setSessionCwd(agent, path)
  } catch {
    // cwd bookkeeping is best-effort here.
  }
}

/**
 * Run one git command to completion through the `ctx.shell` seam. Resolves a
 * fresh request (never passing an unresolved one to `run`) and maps abort /
 * spawn failures to a structured {@link HarnessError}; a nonzero git exit
 * resolves normally for the caller to interpret.
 * @param ctx - the Cordis context.
 * @param cmd - the constructed git command.
 * @param signal - the tool-call cancellation signal.
 * @returns the shell result, with `exitCode` nonzero representing a git-level failure.
 */
async function runGit(
  ctx: Context,
  cmd: GitCmd,
  signal: AbortSignal,
): Promise<ShellRunResult> {
  const result = await ctx.shell.run(ctx.shell.resolve({
    command: cmd.command,
    workdir: cmd.workdir,
    signal,
  }))
  if (result.aborted) {
    const error = new HarnessError('tool call aborted', TOOL_ABORTED)
    error.name = 'AbortError'
    throw error
  }
  return result
}

/** Truncated stderr tail used to surface git failure causes in messages. */
function gitFailure(result: ShellRunResult): string {
  return result.stderr.text.trim() || result.stdout.text.trim() || `exit code ${result.exitCode}`
}

/**
 * Assert a computed worktree path is contained by this repo's `worktrees`
 * directory. All paths a tool will act on are validated here before any git
 * command runs.
 * @param ctx - the Cordis context.
 * @param repoRoot - the canonical repository root.
 * @param worktreePath - candidate absolute worktree path.
 */
async function assertPathInRepo(ctx: Context, repoRoot: string, worktreePath: string): Promise<void> {
  if (relative(repoRoot, worktreePath).startsWith(`..${sep}`)) {
    throw new WorktreeError(`refusing worktree path outside the repository: "${worktreePath}"`)
  }
  const rootTarget = await ctx.fs.resolve(repoRoot)
  const pathTarget = await ctx.fs.resolve(worktreePath)
  if (!ctx.fs.contains(rootTarget, pathTarget)) {
    throw new WorktreeError(`refusing worktree path outside the repository: "${worktreePath}"`)
  }
}

/**
 * Find the canonical repository root for a working directory using git. A
 * nonzero exit means the cwd is not inside a git working tree.
 * @param ctx - the Cordis context.
 * @param cwd - the working directory to search from.
 * @param signal - the tool-call cancellation signal.
 * @returns the canonical root, or `undefined` when not a git repository.
 */
async function findRepoRoot(ctx: Context, cwd: string, signal: AbortSignal): Promise<string | undefined> {
  const result = await runGit(ctx, { command: 'git rev-parse --show-toplevel', workdir: cwd, label: 'locate repository root' }, signal)
  const root = result.stdout.text.trim()
  return result.exitCode === 0 && root.length > 0 ? root : undefined
}

/**
 * Probe whether the (remove-gate) worktree currently differs from the commit it
 * was created from, counting both uncommitted files and new commits. Returns
 * `null` when the state cannot be determined reliably — callers treat that as
 * "unknown, assume unsafe" (fail-closed) so a silent 0/0 can never let a remove
 * destroy real work.
 * @param ctx - the Cordis context.
 * @param session - the active worktree session.
 * @returns the change counts, or `null` when unknown.
 */
async function countWorktreeChanges(
  ctx: Context,
  session: WorktreeSession,
  signal: AbortSignal,
): Promise<{ changedFiles: number; commits: number } | null> {
  const statusResult = await runGit(ctx, status(session.worktreePath), signal)
  if (statusResult.exitCode !== 0) return null
  const changedFiles = statusResult.stdout.text.split('\n').filter(line => line.trim() !== '').length
  const revResult = await runGit(ctx, commitsAhead(session.worktreePath, session.originalHead), signal)
  if (revResult.exitCode !== 0) return null
  const commits = parseInt(revResult.stdout.text.trim(), 10) || 0
  return { changedFiles, commits }
}

/**
 * Register the runtime-context entry that surfaces the active worktree cwd to
 * the model. When no worktree is active the provider contributes nothing, so
 * the entry is inert outside an EnterWorktree session.
 * @param ctx - the Cordis context.
 */
function registerWorktreeCwdContext(ctx: Context): void {
  ctx.systemPrompt.context({
    name: 'tool:worktree:cwd',
    order: 120,
    text: () => {
      const session = getActiveWorktreeSession()
      if (session === null) return ''
      return `Current working directory: ${session.worktreePath}`
    },
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  registerWorktreeCwdContext(ctx)

  if (config.enableEnterWorktree ?? true) {
    ctx.tools.register(defineTool({
      name: 'EnterWorktree',
      description:
        'Creates an isolated git worktree under <repo>/.claude/worktrees/ and switches the session into it. '
        + 'Run an uncommitted or speculative change in the worktree without touching the main working tree. '
        + 'Because the session working directory is fixed at creation, subsequent shell and fs calls should pass '
        + '`workdir` equal to the reported worktreePath to operate inside it; the runtime context and this result '
        + 'both declare the current working directory. This tool is NOT concurrency-safe and must not overlap '
        + 'other tools. Only call it when the user explicitly asks to work in a worktree.',
      parameters: {
        name: {
          type: 'string',
          description: 'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            worktreePath: { type: 'string', required: true },
            worktreeBranch: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args: EnterWorktreeArgs, value: { worktreePath: string; worktreeBranch: string; message: string }) =>
          [{ type: 'text', text: value.message }],
      },
      isConcurrencySafe: () => false,
      presentCall: presentEnterCall,
      presentResult: presentWorktreeResult,
      async execute(args: EnterWorktreeArgs, exec) {
        const cwd = sessionCwd(exec) ?? process.cwd()
        const repoRoot = await findRepoRoot(ctx, cwd, exec.signal)
        if (repoRoot === undefined) {
          throw new WorktreeError(
            `cannot create a worktree: not in a git repository (cwd: ${cwd}). EnterWorktree requires a git working tree.`,
          )
        }
        const slug = args.name ?? randomSlug()
        validateSlug(slug)

        const worktreePath = worktreePathFor(repoRoot, slug)
        await assertPathInRepo(ctx, repoRoot, worktreePath)

        const branch = worktreeBranch(slug)
        const headResult = await runGit(ctx, { command: 'git rev-parse HEAD', workdir: repoRoot, label: 'resolve HEAD' }, exec.signal)
        if (headResult.exitCode !== 0) {
          throw new WorktreeError(`cannot resolve repository HEAD at ${repoRoot}: ${gitFailure(headResult)}`)
        }
        const originalHead = headResult.stdout.text.trim()

        const create = await runGit(ctx, addWorktree(repoRoot, slug), exec.signal)
        if (create.exitCode !== 0) {
          throw new WorktreeError(`failed to create worktree: ${gitFailure(create)}`)
        }

        setActiveWorktreeSession({ originalCwd: cwd, repoRoot, worktreePath, worktreeBranch: branch, originalHead })
        updateSessionCwd(exec, worktreePath)

        return {
          worktreePath,
          worktreeBranch: branch,
          message:
            `Created worktree at ${worktreePath} on branch ${branch} in ${repoLabel(repoRoot)}. `
            + `The session's working directory is now the worktree; pass \`workdir: ${worktreePath}\` to shell and fs calls. `
            + 'Use ExitWorktree to leave it (keep or remove).',
        }
      },
    }))
  }

  if (config.enableExitWorktree ?? true) {
    ctx.tools.register(defineTool({
      name: 'ExitWorktree',
      description:
        'Leaves a worktree session created by EnterWorktree and returns the session to its original directory. '
        + 'This tool ONLY operates on worktrees created by EnterWorktree in this session; it never touches '
        + 'manually-created worktrees or worktrees from a previous session, and is a no-op when EnterWorktree '
        + 'was never called. action "remove" deletes the worktree directory AND its branch (DESTRUCTIVE, permanent): '
        + 'it refuses unless discard_changes is true when the worktree has uncommitted files or new commits, and '
        + 'lists the evidence otherwise. action "keep" leaves the worktree and branch on disk untouched. '
        + 'This tool is NOT concurrency-safe and must not overlap other tools.',
      parameters: {
        action: {
          type: 'string',
          enum: ['keep', 'remove'],
          description: '"keep" leaves the worktree and branch intact on disk; "remove" deletes both (destructive).',
        },
        discard_changes: {
          type: 'boolean',
          description: 'Required true when action is "remove" and the worktree has uncommitted files or unmerged commits. The tool refuses and lists them otherwise.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true },
            originalCwd: { type: 'string', required: true },
            worktreePath: { type: 'string', required: true },
            worktreeBranch: { type: 'string', required: true },
            discardedFiles: { type: 'integer' },
            discardedCommits: { type: 'integer' },
            message: { type: 'string', required: true },
          },
        },
        render: (_args: ExitWorktreeArgs, value: { message: string }) => [{ type: 'text', text: value.message }],
      },
      isConcurrencySafe: () => false,
      presentCall: presentExitCall,
      presentResult: presentWorktreeResult,
      async execute(args: ExitWorktreeArgs, exec) {
        const session = getActiveWorktreeSession()
        if (session === null) {
          throw new WorktreeError(
            'No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees '
            + 'created by EnterWorktree in the current session — it will not touch manually-created worktrees '
            + 'or worktrees from a previous session. No filesystem changes were made.',
          )
        }

        if (args.action === 'keep') {
          clearActiveWorktreeSession()
          updateSessionCwd(exec, session.originalCwd)
          return {
            action: 'keep' as const,
            originalCwd: session.originalCwd,
            worktreePath: session.worktreePath,
            worktreeBranch: session.worktreeBranch,
            message:
              `Exited worktree. Your work is preserved at ${session.worktreePath} on branch `
              + `${session.worktreeBranch}. Session is now back in ${session.originalCwd}.`,
          }
        }

        // action === 'remove': gate on the safety probe.
        const summary = await countWorktreeChanges(ctx, session, exec.signal)
        if (summary === null) {
          throw new WorktreeError(
            `Could not verify worktree state at ${session.worktreePath}. Refusing to remove without explicit `
            + 'confirmation. Re-invoke with discard_changes: true to proceed, or use action: "keep" to preserve it.',
          )
        }
        const { changedFiles, commits } = summary
        if (!args.discard_changes && (changedFiles > 0 || commits > 0)) {
          const parts: string[] = []
          if (changedFiles > 0) parts.push(`${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`)
          if (commits > 0) parts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'} on ${session.worktreeBranch}`)
          throw new WorktreeError(
            `Worktree has ${parts.join(' and ')}. Removing will discard this work permanently. Confirm with '
            + 'the user, then re-invoke with discard_changes: true — or use action: "keep" to preserve the worktree.`,
          )
        }

        await assertPathInRepo(ctx, session.repoRoot, session.worktreePath)
        const removed = await runGit(ctx, forceRemoveWorktree(session.repoRoot, session.worktreePath), exec.signal)
        if (removed.exitCode !== 0) {
          throw new WorktreeError(`failed to remove worktree: ${gitFailure(removed)}`)
        }
        const branchDeleted = await runGit(ctx, deleteBranch(session.repoRoot, session.worktreeBranch), exec.signal)
        if (branchDeleted.exitCode !== 0) {
          // The worktree directory is gone; a surviving branch is a lint residue, not a locked failure.
          ctx.logger.warn(`could not delete worktree branch ${session.worktreeBranch}: ${gitFailure(branchDeleted)}`)
        }

        clearActiveWorktreeSession()
        updateSessionCwd(exec, session.originalCwd)
        const discardParts: string[] = []
        if (commits > 0) discardParts.push(`${commits} ${commits === 1 ? 'commit' : 'commits'}`)
        if (changedFiles > 0) discardParts.push(`${changedFiles} uncommitted ${changedFiles === 1 ? 'file' : 'files'}`)
        const discardNote = discardParts.length > 0 ? ` Discarded ${discardParts.join(' and ')}.` : ''
        return {
          action: 'remove' as const,
          originalCwd: session.originalCwd,
          worktreePath: session.worktreePath,
          worktreeBranch: session.worktreeBranch,
          discardedFiles: changedFiles,
          discardedCommits: commits,
          message:
            `Exited and removed worktree at ${session.worktreePath}.${discardNote} `
            + `Session is now back in ${session.originalCwd}.`,
        }
      },
    }))
  }
}

export { validateSlug, worktreeBranch, worktreePathFor, randomSlug, flattenSlug } from './worktree.ts'
