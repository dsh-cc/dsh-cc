/**
 * WS-3 subagent `isolation: worktree` (docs/plans/2026-09-14-cc-worktree-parity.md
 * §6): per-dispatch worktree creation for Task children whose agent definition
 * pins `isolation: 'worktree'`, the lifecycle listeners that adopt the child
 * into the worktree (`setSessionCwd` on the CHILD only) and clean it up after
 * a clean end, and the dispatch entry that wires creation → persona contract →
 * start.
 *
 * Creation deliberately reuses the WS-1-hardened command constructors from
 * `@dsh-cc/tool-git-worktree` (common-dir root pin, local-config scan,
 * filter-driver neutralization) — never re-implemented here.
 *
 * Documented deviation (manifest `subagents.isolation`): the child's
 * `header.cwd`, the harness sandbox root, and the bash default workdir stay
 * the parent's — only the session-cwd overlay moves. Containment is therefore
 * strongest when the parent runs at the repo root; a parent cwd that cannot
 * contain the worktree path is a dispatch-time refusal.
 *
 * @module @dsh-cc/subagent-task/worktree-isolation
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import type { DetailedRoute, ModelRoutes } from '@dsh-cc/model-aliases'
import { setSessionCwd } from '@dsh-cc/session-cwd'
import {
  addWorktree,
  commitsAhead,
  deleteBranch,
  forceRemoveWorktree,
  repoRootFromCommonDir,
  scanLocalConfig,
  status,
  validateSlug,
  worktreeBranch,
  worktreePathFor,
  type GitCmd,
} from '@dsh-cc/tool-git-worktree'
import { SpawnPinCapture } from './resume-capture.ts'
import type { BackgroundRequest } from './background-start.ts'
import type { ShellRunResult } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell'

/** The isolation record kept per child id between creation and cleanup. */
export interface WorktreeIsolationRecord {
  /** Main repository root the worktree was created under. */
  repoRoot: string
  /** Absolute worktree path (the child's adopted session cwd). */
  worktreePath: string
  /** The `worktree-` branch backing the worktree. */
  branch: string
  /** The commit the worktree was created from (cleanliness baseline). */
  baseHead: string
  /** The lock reason written into `git worktree lock` (WS-4's sweep key). */
  lockReason: string
  /** Parent session cwd at dispatch (the sandbox-root anchor). */
  parentCwd: string
  /** True once the tree has been force-removed. */
  removed: boolean
  /** In-flight settle promise (kept results clear it — re-probe next epoch). */
  pending?: Promise<'removed' | 'kept'> | undefined
}

/** Per-child bookkeeping shared by the dispatch path and the end listener. */
interface IsolationEntry extends WorktreeIsolationRecord {}

/**
 * The dispatch-time refusal: a worktree lives under `<mainRoot>/.claude/worktrees/`,
 * but the harness sandbox root is the parent's session cwd ancestry — when the
 * parent cwd cannot contain the worktree path the child's writes would be
 * fs-sandbox-denied and hard-fail (delegated children cannot answer approvals).
 * @param parentCwd - the parent session's cwd.
 * @param worktreePath - the computed worktree path.
 * @returns the refusal reason, or `null` when contained.
 */
export function sandboxRefusal(parentCwd: string, worktreePath: string): string | null {
  const rel = relative(parentCwd, worktreePath)
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  if (inside) return null
  return (
    `refusing isolated subagent dispatch: the worktree at ${worktreePath} falls outside the `
    + `parent session's sandbox root (${parentCwd}). Isolation: worktree is only supported when `
    + 'the parent runs at (or inside) a directory that contains <repoRoot>/.claude/worktrees — '
    + 'run the session at the repository root, or drop `isolation: worktree` from the agent definition.'
  )
}

/** The persona paragraph appended to an isolated child's system prompt. */
export function worktreeContract(worktreePath: string, parentCwd: string): string {
  return [
    '## Isolated worktree',
    '',
    `Your working directory is ${worktreePath} (an isolated git worktree). Pass absolute paths `,
    `inside it to every tool, and pass \`workdir: ${worktreePath}\` to every shell call. `,
    `The parent checkout at ${parentCwd} is off-limits — never read or write there. `
      + 'Writes outside the worktree are denied, and a delegated subagent cannot answer approval '
      + 'prompts, so a denied write hard-fails: the absolute-path contract is not optional.',
  ].join('')
}

/** Prepend the one-line worktree note to the child's first user message. */
export function promptWithWorktreeNote(prompt: string, worktreePath: string): string {
  return `Working directory: ${worktreePath} (isolated git worktree — absolute paths inside it only; parent checkout off-limits).\n${prompt}`
}

/** The slug derived from a preallocated child id (validated at creation). */
export function worktreeSlugForChild(childId: string): string {
  return `subagent-${childId}`
}

/** Quote an argument for a `bash -c` command line (single-quote escaping). */
function quote(arg: string): string {
  return `'${arg.replaceAll('\'', '\'\\\'\'')}'`
}

/** `git worktree lock --reason <reason> <path>` — the WS-4 sweep key. */
export function lockWorktree(worktreePath: string, reason: string): GitCmd {
  return {
    command: `git worktree lock --reason=${quote(reason)} ${quote(worktreePath)}`,
    workdir: worktreePath,
    label: `lock worktree "${worktreePath}"`,
  }
}

/** `git worktree unlock <path>` — release before removal. */
export function unlockWorktree(worktreePath: string): GitCmd {
  return {
    command: `git worktree unlock ${quote(worktreePath)}`,
    workdir: worktreePath,
    label: `unlock worktree "${worktreePath}"`,
  }
}

/**
 * Pre-2.15 git lacks `worktree lock/unlock`; an "unknown option" failure is
 * tolerated as a no-op so the isolation flow still works on old git.
 */
export function isUnknownOptionFailure(result: ShellRunResult): boolean {
  const text = result.stderr.text || result.stdout.text
  return /unknown option|unknown switch/i.test(text)
}

/** Run one constructed git command through the `ctx.shell` seam. */
async function runGit(ctx: Context, cmd: GitCmd, signal?: AbortSignal): Promise<ShellRunResult> {
  return ctx.shell.run(ctx.shell.resolve({
    command: cmd.command,
    workdir: cmd.workdir,
    ...(signal !== undefined ? { signal } : {}),
  }))
}

/** Git failure copy for dispatch-time errors. */
function gitFailure(result: ShellRunResult): string {
  return (result.stderr.text ?? '').trim() || (result.stdout.text ?? '').trim() || `exit code ${result.exitCode}`
}

/** The raw stdout text of a shell result (undefined-free). */
function stdoutOf(result: ShellRunResult): string {
  return result.stdout.text ?? ''
}

/**
 * Create the isolated worktree for one child (WS-3 flow 1 + 4): hardened
 * `addWorktree` at the pinned main root, then `git worktree lock` with the
 * dsh-cc reason (old-git "unknown option" tolerated as a no-op). Every
 * failure is a named dispatch error — never a silent fallback to the parent
 * tree.
 */
/** Named dispatch failure (never returns) — narrowing anchor for the guards below. */
function isolationFailure(childId: string, message: string): never {
  throw new Error(`worktree isolation for subagent ${childId} failed: ${message}`)
}

export async function createIsolationWorktree(
  ctx: Context,
  opts: { parentCwd: string; childId: string; signal?: AbortSignal },
): Promise<WorktreeIsolationRecord> {
  const { parentCwd, childId, signal } = opts
  const fail: (message: string) => never = message =>
    isolationFailure(childId, message)

  const probe = await runGit(
    ctx,
    { command: 'git rev-parse --git-common-dir', workdir: parentCwd, label: 'locate repository common dir' },
    signal,
  )
  if (probe.exitCode !== 0) {
    fail(`not a git repository (cwd: ${parentCwd}): ${gitFailure(probe)}`)
  }
  const repoRoot = repoRootFromCommonDir(parentCwd, stdoutOf(probe))
  if (repoRoot === undefined) fail(`could not resolve the repository root from ${parentCwd}`)

  const slug = worktreeSlugForChild(childId)
  validateSlug(slug)
  const worktreePath = worktreePathFor(repoRoot, slug)
  const refusal = sandboxRefusal(parentCwd, worktreePath)
  if (refusal !== null) fail(refusal)

  // Same hardened creation sequence as EnterWorktree (WS-1): scan the local
  // config, refuse on includeIf/ambiguous filters, neutralize the rest.
  const cfg = await runGit(
    ctx,
    { command: 'git config --local --list -z', workdir: repoRoot, label: 'read local config' },
    signal,
  )
  if (cfg.exitCode !== 0) fail(`repository local config is unreadable at ${repoRoot}: ${gitFailure(cfg)}`)
  const scan = scanLocalConfig(stdoutOf(cfg))
  if (scan.refusals.length > 0) fail(scan.refusals.join('; '))

  const head = await runGit(ctx, { command: 'git rev-parse HEAD', workdir: repoRoot, label: 'resolve HEAD' }, signal)
  if (head.exitCode !== 0) fail(`cannot resolve repository HEAD at ${repoRoot}: ${gitFailure(head)}`)
  const baseHead = stdoutOf(head).trim()

  const create = await runGit(ctx, addWorktree(repoRoot, slug, scan.filters), signal)
  if (create.exitCode !== 0) fail(`failed to create worktree: ${gitFailure(create)}`)

  const lockReason = `dsh-cc subagent ${childId}`
  const lock = await runGit(ctx, lockWorktree(worktreePath, lockReason), signal)
  if (lock.exitCode !== 0 && !isUnknownOptionFailure(lock)) {
    // The tree exists and is usable; a failed lock only weakens WS-4's sweep
    // protection. Surface it, don't fail the dispatch.
    ctx.logger?.warn?.(`worktree lock failed for ${worktreePath}: ${gitFailure(lock)}`)
  }

  return { repoRoot, worktreePath, branch: worktreeBranch(slug), baseHead, lockReason, parentCwd, removed: false }
}

/**
 * End-of-life probe (WS-3 flow 3): fail-closed on unreadable state; remove
 * (unlock → force remove → delete branch) only when the tree is clean AND
 * has no commits ahead of its recorded base. Re-probed per epoch, so a dirty
 * tree stays for a continuable child's next epoch.
 */
export async function settleIsolationWorktree(
  ctx: Context,
  entry: IsolationEntry,
): Promise<'removed' | 'kept'> {
  if (entry.removed) return 'removed'
  const failClosed = 'kept'
  const statusResult = await runGit(ctx, status(entry.worktreePath))
  if (statusResult.exitCode !== 0) return failClosed
  const changed = stdoutOf(statusResult).split('\n').some(line => line.trim() !== '')
  const rev = await runGit(ctx, commitsAhead(entry.worktreePath, entry.baseHead))
  if (rev.exitCode !== 0) return failClosed
  const commits = parseInt(stdoutOf(rev).trim(), 10) || 0
  if (changed || commits > 0) return failClosed

  const unlock = await runGit(ctx, unlockWorktree(entry.worktreePath))
  if (unlock.exitCode !== 0 && !isUnknownOptionFailure(unlock)) {
    ctx.logger?.warn?.(`worktree unlock failed for ${entry.worktreePath}: ${gitFailure(unlock)}`)
    return failClosed
  }
  const removed = await runGit(ctx, forceRemoveWorktree(entry.repoRoot, entry.worktreePath))
  if (removed.exitCode !== 0) {
    ctx.logger?.warn?.(`worktree removal failed for ${entry.worktreePath}: ${gitFailure(removed)}`)
    return failClosed
  }
  const branch = await runGit(ctx, deleteBranch(entry.repoRoot, entry.branch))
  if (branch.exitCode !== 0) {
    ctx.logger?.warn?.(`worktree branch delete failed for ${entry.branch}: ${gitFailure(branch)}`)
  }
  entry.removed = true
  return 'removed'
}

/** The context face the lifecycle listeners need. */
export interface WorktreeIsolationDeps {
  /** Live agent registry (`ctx.agents`) for the `subagent/start` adopt probe. */
  agents?: { get?(id: string): Agent | undefined } | undefined
}

/**
 * The per-child registry shared by the dispatch path and the lifecycle
 * listeners. One instance per Task plugin mount; entries are keyed by the
 * preallocated durable child id.
 */
export class SubagentWorktreeRegistry {
  readonly entries = new Map<string, IsolationEntry>()
  readonly deps: WorktreeIsolationDeps

  constructor(deps: WorktreeIsolationDeps = {}) {
    this.deps = deps
  }

  record(childId: string, record: WorktreeIsolationRecord): void {
    this.entries.set(childId, record)
  }

  get(childId: string): IsolationEntry | undefined {
    return this.entries.get(childId)
  }

  /**
   * Resolve (once per epoch) the end-of-life decision for a child that has
   * just ended. The in-flight decision is cached so the `subagent/end`
   * listener and a foreground dispatch awaiting the same end observe ONE
   * probe/remove; a `kept` outcome clears the cache so the next epoch of a
   * continuable child re-probes.
   */
  settle(childId: string, ctx: Context): Promise<'removed' | 'kept'> | undefined {
    const entry = this.entries.get(childId)
    if (entry === undefined) return undefined
    entry.pending ??= settleIsolationWorktree(ctx, entry).then(result => {
      if (result === 'kept') entry.pending = undefined
      return result
    })
    return entry.pending
  }
}

/**
 * Mount the WS-3 lifecycle listeners (flow 2 + 3) on the bus:
 * - `subagent/start`: adopt — `setSessionCwd` on the CHILD agent (never the
 *   parent; the fold is last-wins per session).
 * - `subagent/end`: settle — clean probe → remove + delete branch; dirty →
 *   leave on disk (continuable children re-fire per epoch, and a dirty tree
 *   must survive to the next one). Removal only ever fires on a clean probe.
 * @returns the disposer.
 */
export function mountWorktreeIsolation(ctx: Context, registry: SubagentWorktreeRegistry): () => void {
  const agents = registry.deps.agents ?? (ctx.get('agents') as WorktreeIsolationDeps['agents'] | undefined)
  const offStart = ctx.on('subagent/start', info => {
    const childId = String(info.id)
    const entry = registry.get(childId)
    if (entry === undefined) return
    const child = agents?.get?.(childId)
    if (child === undefined) return
    try {
      setSessionCwd(child, entry.worktreePath)
    } catch (error) {
      ctx.logger?.warn?.(`could not adopt worktree cwd for subagent ${childId}: ${(error as Error).message}`)
    }
  })
  const offEnd = ctx.on('subagent/end', info => {
    const outcome = registry.settle(String(info.id), ctx)
    if (outcome !== undefined) void outcome.catch(() => undefined)
  })
  return () => {
    offStart?.()
    offEnd?.()
  }
}

/**
 * The WS-3 dispatch entry (flow 1): create the worktree, fold the contract
 * into the persona and the first prompt line, and start the child with the
 * preallocated child id pinned to that worktree. Lifecycle handling is the
 * mounted listeners' job; the foreground path additionally awaits the settle
 * outcome so the final text can state when the worktree was left on disk.
 */
export async function dispatchWorktreeIsolation(
  ctx: Context,
  capture: SpawnPinCapture | undefined,
  routes: ModelRoutes | undefined,
  definition: AgentDefinition,
  worktrees: SubagentWorktreeRegistry,
  parts: {
    parent: Agent
    argsPrompt: string
    label: string
    signal: AbortSignal
    maxDepth: number
    toolFilter?: unknown
    agentOptions?: Record<string, string> | undefined
  },
  start: (request: BackgroundRequest) => Promise<
    | { text: string; status: 'completed' }
    | { text: string; status: 'async_launched'; agentId: string }
  >,
): Promise<
  | { text: string; status: 'completed' }
  | { text: string; status: 'async_launched'; agentId: string }
> {
  const childId = capture?.preallocateChildId() ?? randomUUID()
  const parentCwd = parts.parent.session.header.cwd ?? process.cwd()
  const record = await createIsolationWorktree(ctx, { parentCwd, childId, signal: parts.signal })
  worktrees.record(childId, record)

  const persona = `${definition.systemPrompt}\n\n${worktreeContract(record.worktreePath, record.parentCwd)}`
  const request: BackgroundRequest = {
    label: parts.label,
    prompt: [{ type: 'text', text: promptWithWorktreeNote(parts.argsPrompt, record.worktreePath) }],
    parent: parts.parent,
    signal: parts.signal,
    maxDepth: parts.maxDepth,
    persona,
    ...(parts.toolFilter !== undefined
      ? { toolFilter: parts.toolFilter as NonNullable<BackgroundRequest['toolFilter']> }
      : {}),
    ...(parts.agentOptions !== undefined ? { agentOptions: parts.agentOptions } : {}),
    childId,
    captureDefinition: definition,
    captureSelector: (routes !== undefined
      ? routes.resolveDetailed(definition.model)
      : SpawnPinCapture.inheritSelector(definition.model)) as DetailedRoute,
  }

  const result = await start(request)
  if (result.status === 'async_launched') {
    return {
      ...result,
      text: `${result.text}\nisolated worktree: ${record.worktreePath} (branch ${record.branch}) — removed automatically when the child ends cleanly, left on disk otherwise.`,
    }
  }
  // Foreground: the end event has fired; await the settle decision so the
  // final text reports a tree left on disk (remove-notify contract).
  const outcome = await worktrees.settle(childId, ctx)
  return {
    ...result,
    text: `${result.text}\nisolated worktree ${record.worktreePath} (branch ${record.branch}): `
      + (outcome === 'removed'
        ? 'removed after the child finished cleanly.'
        : 'LEFT on disk (not clean) — clean it up manually before reuse.'),
  }
}
