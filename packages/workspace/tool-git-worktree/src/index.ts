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
import { join } from 'node:path'
import { adoptionRefusal, scanLocalConfig } from './harden.ts'
import { defineTool } from '@dsh-cc/tools'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-shell'
import {
  addWorktree,
  clearActiveWorktreeSession,
  deleteBranch,
  forceRemoveWorktree,
  getActiveWorktreeSession,
  randomSlug,
  repoLabel,
  setActiveWorktreeSession,
  validateSlug,
  worktreeBranch,
  worktreePathFor,
  worktreesDir,
  quote,
} from './worktree.ts'
import { presentEnterCall, presentWorktreeResult, presentExitCall } from './render.ts'
import {
  assertNotSymlink,
  assertPathInRepo,
  countWorktreeChanges,
  findRepoRoot,
  gitFailure,
  releaseLock,
  runGit,
  sessionCwd,
  updateSessionCwd,
  includeGitRunner,
} from './exec.ts'
import { isUnknownOptionFailure, lockWorktree, resolveBaseRef, sessionLockReason } from './lifecycle.ts'
import { copyIncludedFiles } from './include.ts'
import { runWorktreeCreateHook, runWorktreeRemoveHook } from './hooks.ts'
import { branchOfAdopted, headOfAdopted, resolveAdoptPath } from './pathform.ts'
import { worktreeSettings, WorktreeSchema, type Worktree } from '@dsh-cc/settings-cascade'

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
  /** WS-6: adopt an existing directory instead of creating one. */
  path?: string
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

  // WS-4 `worktree` settings section (baseRef, cleanupPeriodDays). The
  // cascade may be absent (headless) — then only the documented defaults
  // apply. The live merged section is snapshotted here and read at
  // EnterWorktree time via the thunk.
  let sectionSource: (() => Worktree | undefined) | undefined
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, 'worktree', WorktreeSchema, {}, {
      setSource: (current: () => Worktree | undefined) => { sectionSource = current },
      onChange: () => {},
    })
  })

  if (config.enableEnterWorktree ?? true) {
    ctx.tools.register(defineTool({
      name: 'EnterWorktree',
      description:
        'Creates an isolated git worktree under <repo>/.claude/worktrees/ and switches the session into it. '
        + 'Run an uncommitted or speculative change in the worktree without touching the main working tree. '
        + 'Because the session working directory is fixed at creation, subsequent shell and fs calls should pass '
        + '`workdir` equal to the reported worktreePath to operate inside it; the runtime context and this result '
        + 'both declare the current working directory. This tool is NOT concurrency-safe and must not overlap '
        + 'other tools. Only call it when the user explicitly asks to work in a worktree. '
        + 'Repository-local filter drivers (e.g. git-lfs) are neutralized during creation, so LFS-tracked files '
        + 'arrive as pointer files; run `git lfs pull` inside the worktree to fetch real content. '
        + 'Refuses when .claude, .claude/worktrees, or the target path is a symlink, when the repository local '
        + 'config is unreadable or uses includeIf/ambiguous filter drivers, or when the target directory already '
        + 'exists and is not a registered worktree of this repository. '
        + 'Optional `path` argument: adopt an EXISTING directory as the worktree instead of creating one. '
        + 'A path under the repository\'s .claude/worktrees/ is adopted directly (after an identity check). '
        + 'Any path OUTSIDE that directory ALWAYS asks for confirmation — "don\'t ask again" persistence never '
        + 'suppresses this prompt; only bypassPermissions mode skips it. From within a worktree session, `path` '
        + 'must stay under the same repository\'s worktrees directory. '
        + 'Files matched by the repository\'s .worktreeinclude (and confirmed gitignored) are copied into every '
        + 'newly created worktree.',
      parameters: {
        name: {
          type: 'string',
          description: 'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.',
        },
        path: {
          type: 'string',
          description: 'Optional absolute or repository-relative path to an existing directory to adopt as the worktree. Under .claude/worktrees/ it is adopted directly; anywhere else it ALWAYS asks for confirmation (never suppressed by "don\'t ask again"; only bypassPermissions skips it). When both `name` and `path` are given, `path` wins.',
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

        // WS-6 item 4: the `path` form adopts an existing directory (name
        // creation stays available per WS-1's pinned root).
        if (args.path !== undefined) {
          const adopted = await resolveAdoptPath(ctx, exec, { rawPath: args.path, cwd, repoRoot })
          const adoptedBranch = await branchOfAdopted(ctx, adopted, exec.signal)
          const adoptedHead = await headOfAdopted(ctx, adopted, exec.signal)
          setActiveWorktreeSession({ originalCwd: cwd, repoRoot, worktreePath: adopted, worktreeBranch: adoptedBranch, originalHead: adoptedHead })
          updateSessionCwd(exec, adopted)
          return {
            worktreePath: adopted,
            worktreeBranch: adoptedBranch,
            message:
              `Adopted existing directory ${adopted} as the worktree (branch ${adoptedBranch}). `
              + `The session's working directory is now the worktree; pass \`workdir: ${adopted}\` to shell and fs calls. `
              + 'Use ExitWorktree to leave it (keep or remove).',
          }
        }

        const worktreePath = worktreePathFor(repoRoot, slug)
        await assertPathInRepo(ctx, repoRoot, worktreePath)
        await assertNotSymlink(ctx, join(repoRoot, '.claude'), '.claude')
        await assertNotSymlink(ctx, worktreesDir(repoRoot), '.claude/worktrees')
        await assertNotSymlink(ctx, worktreePath, 'worktree target path')

        // Adoption gate (WS-1): the target directory already exists (a -B
        // reuse). Verify its git identity before touching it.
        if (await ctx.fs.lstat(worktreePath) !== undefined) {
          const refusal = adoptionRefusal(worktreePath, repoRoot)
          if (refusal !== null) throw new WorktreeError(refusal)
        }

        // Neutralize repository-local filter drivers before `worktree add`
        // (WS-1): unreadable local config or CC-parity refusal shapes abort
        // creation; remaining filter names get empty `-c` overrides so no
        // driver executes during the checkout.
        const cfg = await runGit(
          ctx,
          { command: 'git config --local --list -z', workdir: repoRoot, label: 'read local config' },
          exec.signal,
        )
        if (cfg.exitCode !== 0) {
          throw new WorktreeError(
            `refusing to create a worktree: repository local config is unreadable at ${repoRoot}: ${gitFailure(cfg)}`,
          )
        }
        const scan = scanLocalConfig(cfg.stdout.text)
        if (scan.refusals.length > 0) {
          throw new WorktreeError(`refusing to create a worktree: ${scan.refusals.join('; ')}`)
        }

        const branch = worktreeBranch(slug)
        const headResult = await runGit(ctx, { command: 'git rev-parse HEAD', workdir: repoRoot, label: 'resolve HEAD' }, exec.signal)
        if (headResult.exitCode !== 0) {
          throw new WorktreeError(`cannot resolve repository HEAD at ${repoRoot}: ${gitFailure(headResult)}`)
        }
        const originalHead = headResult.stdout.text.trim()

        // WS-6 item 2: WorktreeCreate hooks may replace default creation. A
        // hook exiting 0 with a stdout path adopts that path (WS-1-style
        // verification inside runWorktreeCreateHook); any non-zero hook exit
        // falls back to git-direct creation below.
        const hookOutcome = await runWorktreeCreateHook(ctx, {
          sessionId: exec.agent?.session.header.id ?? '',
          cwd,
          name: slug,
          worktreePath,
          branch,
          source: 'enter-worktree',
        }, { mainRoot: repoRoot, signal: exec.signal })
        if (hookOutcome.kind === 'adopt') {
          const hookHead = await headOfAdopted(ctx, hookOutcome.path, exec.signal)
          const hookBranch = (await branchOfAdopted(ctx, hookOutcome.path, exec.signal)) || branch
          setActiveWorktreeSession({ originalCwd: cwd, repoRoot, worktreePath: hookOutcome.path, worktreeBranch: hookBranch, originalHead: hookHead })
          updateSessionCwd(exec, hookOutcome.path)
          await copyIncludedFiles(repoRoot, hookOutcome.path, includeGitRunner(ctx, exec.signal))
          return {
            worktreePath: hookOutcome.path,
            worktreeBranch: hookBranch,
            message:
              `WorktreeCreate hook adopted ${hookOutcome.path} for "${slug}" (branch ${hookBranch}). `
              + `The session's working directory is now the worktree; pass \`workdir: ${hookOutcome.path}\` to shell and fs calls. `
              + 'Use ExitWorktree to leave it (keep or remove).',
          }
        }

        // WS-4: resolve the creation base from the `worktree` settings
        // section. `fresh` refreshes the cached origin/HEAD with one fetch
        // (creation path only — the sweep never does network I/O); every
        // probe failure degrades toward local HEAD inside resolveBaseRef.
        const base = await resolveBaseRef({
          baseRef: worktreeSettings(sectionSource?.()).baseRef,
          git: async (argv) => {
            const result = await runGit(
              ctx,
              { command: `git ${argv.map(quote).join(' ')}`, workdir: repoRoot, label: argv.join(' ') },
              exec.signal,
            )
            return { ok: result.exitCode === 0, stdout: result.stdout.text }
          },
        })

        const create = await runGit(ctx, addWorktree(repoRoot, slug, scan.filters, base), exec.signal)
        if (create.exitCode !== 0) {
          throw new WorktreeError(`failed to create worktree: ${gitFailure(create)}`)
        }

        // WS-4: lock the worktree to this session (sweep ownership key).
        // Pre-2.15 git lacks `worktree lock`: an "unknown option" failure
        // is a tolerated no-op with a one-line warn.
        const lock = await runGit(ctx, lockWorktree(repoRoot, worktreePath, sessionLockReason(slug)), exec.signal)
        if (lock.exitCode !== 0) {
          if (!isUnknownOptionFailure(lock.stderr.text + lock.stdout.text)) {
            ctx.logger.warn(`could not lock worktree ${worktreePath}: ${gitFailure(lock)}`)
          } else {
            ctx.logger.warn(`git worktree lock unsupported by this git version; ${worktreePath} left unlocked`)
          }
        }

        // WS-6 item 1: copy .worktreeinclude-matched, git-ignored files into
        // every newly created worktree (tool-side only).
        await copyIncludedFiles(repoRoot, worktreePath, includeGitRunner(ctx, exec.signal))

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
          await releaseLock(ctx, session, exec.signal)
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

        // WS-6 item 2: WorktreeRemove hooks replace the default removal.
        // A failing hook keeps the tree (CC parity); a successful run skips
        // git-direct removal AND the owned-branch delete entirely.
        const hookOutcome = await runWorktreeRemoveHook(ctx, {
          sessionId: exec.agent?.session.header.id ?? '',
          cwd: session.worktreePath,
          worktreePath: session.worktreePath,
          reason: 'exit',
        }, exec.signal)
        if (hookOutcome === 'kept') {
          throw new WorktreeError(
            `WorktreeRemove hook failed for ${session.worktreePath}: the worktree was KEPT. `
            + 'Inspect the hook output, then re-invoke with action "keep" or retry "remove".',
          )
        }
        await releaseLock(ctx, session, exec.signal)
        if (hookOutcome === 'default') {
          const removed = await runGit(ctx, forceRemoveWorktree(session.repoRoot, session.worktreePath), exec.signal)
          if (removed.exitCode !== 0) {
            throw new WorktreeError(`failed to remove worktree: ${gitFailure(removed)}`)
          }
          const branchDeleted = await runGit(ctx, deleteBranch(session.repoRoot, session.worktreeBranch), exec.signal)
          if (branchDeleted.exitCode !== 0) {
            // The worktree directory is gone; a surviving branch is a lint residue, not a locked failure.
            ctx.logger.warn(`could not delete worktree branch ${session.worktreeBranch}: ${gitFailure(branchDeleted)}`)
          }
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

export {
  validateSlug,
  worktreeBranch,
  worktreePathFor,
  randomSlug,
  flattenSlug,
  // Pure git-command constructors + probes (WS-3 subagent isolation reuses
  // the same creation/cleanup commands the EnterWorktree path runs).
  addWorktree,
  commitsAhead,
  deleteBranch,
  forceRemoveWorktree,
  status,
} from './worktree.ts'
export type { GitCmd } from './worktree.ts'
// WS-4 lifecycle surface (locks, baseRef resolution) — subagent isolation and
// tests reuse the same constructors.
export {
  DSH_CC_LOCK_PREFIX,
  isUnknownOptionFailure,
  lockWorktree,
  resolveBaseRef,
  sessionLockReason,
  unlockWorktree,
} from './lifecycle.ts'
export { adoptionRefusal, repoRootFromCommonDir, scanLocalConfig } from './harden.ts'
// WS-6 ecosystem surface: .worktreeinclude matcher/copy, WorktreeCreate/
// WorktreeRemove hook adapters, and the path-form adoption helpers.
export { copyIncludedFiles, includeMatches, parseWorktreeInclude } from './include.ts'
export { runWorktreeCreateHook, runWorktreeRemoveHook } from './hooks.ts'
export type { WorktreeCreateOutcome, WorktreeRemoveOutcome } from './hooks.ts'
export { resolveAdoptPath, resolvePathArgument } from './pathform.ts'
