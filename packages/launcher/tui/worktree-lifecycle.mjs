/**
 * WS-4 lifecycle logic for the plain-JS launcher (docs/plans/
 * 2026-09-14-cc-worktree-parity.md §6 WS-4): the fail-open `worktree`
 * settings subset read, `worktree.baseRef` resolution, the boot-time
 * worktree sweep, and the name-reuse merged-reset predicate. Pure over an
 * injected `git` runner (spawnSync result shape) so tests drive every
 * decision table without spawning git. Mirrors
 * packages/workspace/tool-git-worktree/src/lifecycle.ts — keep in sync.
 * @module @dsh-cc/cli/worktree-lifecycle
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Consumption-time defaults for the `worktree` settings section. */
export const WORKTREE_DEFAULTS = { baseRef: 'fresh', cleanupPeriodDays: 30 }

/** How stale the cached origin/HEAD may be before a refresh fetch. */
export const FRESH_CACHE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Overall sweep wall-clock cap (ms). */
export const SWEEP_CAP_MS = 10_000

/** Refresh-fetch cap (ms). */
export const FETCH_CAP_MS = 5_000

/** Lock-reason prefix marking dsh-cc-owned worktree locks (sweep key). */
export const DSH_CC_LOCK_PREFIX = 'dsh-cc '

/** Convention path segment under the main root. */
export const WORKTREES_DIR_SEGMENTS = ['.claude', 'worktrees']

/** Branch prefix marking dsh-cc-owned worktree branches. */
export const WORKTREE_BRANCH_PREFIX = 'worktree-'

/**
 * The settings files the cascade reads for user → project → local, mirrored
 * from packages/settings/settings-cascade/src/index.ts (userSettings =
 * `<home>/settings.json`, projectSettings = `<project>/.claude/settings.json`,
 * localSettings = `<project>/.claude/settings.local.json`). The launcher
 * cannot load the cascade (pre-build, dependency-free) — this is the
 * documented subset read; flag/policy layers are ignored.
 * @param {{ home: string, projectRoot: string }} p
 */
export function worktreeSettingsPaths({ home, projectRoot }) {
  return {
    user: join(home, 'settings.json'),
    project: join(projectRoot, '.claude', 'settings.json'),
    local: join(projectRoot, '.claude', 'settings.local.json'),
  }
}

/**
 * Merge parsed settings documents (low → high precedence) into the
 * `worktree` section. First defined key wins; unknown shapes ignored.
 * @param {(Record<string, unknown> | undefined)[]} docs
 * @returns {{ baseRef: 'fresh' | 'head', cleanupPeriodDays: number }}
 */
export function worktreeSettingsFromDocs(docs) {
  const section = { ...WORKTREE_DEFAULTS }
  for (const doc of docs) {
    const worktree = doc && typeof doc === 'object' ? doc.worktree : undefined
    if (!worktree || typeof worktree !== 'object') continue
    if (worktree.baseRef === 'fresh' || worktree.baseRef === 'head') section.baseRef = worktree.baseRef
    if (typeof worktree.cleanupPeriodDays === 'number' && worktree.cleanupPeriodDays >= 0) {
      section.cleanupPeriodDays = worktree.cleanupPeriodDays
    }
  }
  return section
}

/**
 * Fail-open file read of the three settings layers. Any unreadable or
 * unparseable file is skipped; the defaults survive.
 * @param {{ user: string, project: string, local: string }} paths
 * @param {(path: string) => string} [read] - Injectable reader.
 */
export function readWorktreeSettings(paths, read = readFileSync) {
  const docs = []
  for (const path of [paths.user, paths.project, paths.local]) {
    try {
      docs.push(JSON.parse(read(path)))
    } catch {
      docs.push(undefined)
    }
  }
  return worktreeSettingsFromDocs(docs)
}

/**
 * Resolve the worktree base (WS-4 `worktree.baseRef`). `head` → literal
 * HEAD; `fresh` → cached `origin/HEAD` symbolic ref, refreshed with one
 * fetch when its reflog is older than 24h (or unreadable); fallback chain:
 * cached ref → local HEAD. Any probe error degrades to the next fallback.
 * @param {(argv: string[], opts?: { timeoutMs?: number, cwd?: string }) => { status: number | null, stdout: string } | undefined} git
 * @param {'fresh' | 'head'} baseRef
 * @param {{ now?: number, onFetch?: (branch: string) => void }} [opts]
 * @returns {Promise<string>} the base to hand to `git worktree add`.
 */
export async function resolveBaseRef(git, baseRef, opts = {}) {
  if (baseRef === 'head') return 'HEAD'
  const now = opts.now ?? Date.now()
  const symbolic = git(['symbolic-ref', 'refs/remotes/origin/HEAD'])
  if (!symbolic || symbolic.status !== 0) return 'HEAD'
  const ref = symbolic.stdout.trim()
  if (ref.length === 0) return 'HEAD'
  const defaultBranch = ref.replace(/^refs\/remotes\/[^/]+\//, '')
  const reflog = git(['reflog', 'show', ref, '--format=%ct', '-n', '1'])
  const ageMs = reflog && reflog.status === 0 ? now - Number.parseInt(reflog.stdout.trim(), 10) * 1000 : Number.NaN
  if (Number.isNaN(ageMs) || ageMs > FRESH_CACHE_WINDOW_MS) {
    opts.onFetch?.(defaultBranch)
    git(['fetch', 'origin', defaultBranch], { timeoutMs: FETCH_CAP_MS })
  }
  return ref
}

// --- sweep -------------------------------------------------------------------

/**
 * One parsed `git worktree list --porcelain` entry.
 * @typedef {{ path: string, branch: string, locked: boolean, lockReason: string }} WorktreeEntry
 */

/**
 * Parse `git worktree list --porcelain` output. Locked entries carry the
 * reason text (empty when `lock` has none).
 * @param {string} text
 * @returns {WorktreeEntry[]}
 */
export function parseWorktreeListPorcelain(text) {
  const entries = []
  let current = null
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length), branch: '', locked: false, lockReason: '' }
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    } else if (current && line === 'locked') {
      current.locked = true
    } else if (current && line.startsWith('locked ')) {
      current.locked = true
      current.lockReason = line.slice('locked '.length)
    }
  }
  if (current) entries.push(current)
  return entries
}

/**
 * Sweep decision for one candidate (all probes pre-run by the caller — this
 * is the pure decision table). Removal requires ALL of: path under the
 * convention dir, `worktree-` branch prefix, not locked, age strictly
 * greater than the window, clean status, nothing unpushed. Locked dsh-cc
 * worktrees older than the window become advisories (dsh-cc NEVER
 * auto-releases locks — no trustworthy cross-process liveness oracle).
 * @param {{
 *   underConventionDir: boolean
 *   ownedBranch: boolean
 *   locked: boolean
 *   lockReason: string
 *   ageSeconds: number | undefined
 *   dirty: boolean | undefined
 *   unpushed: boolean | undefined
 *   cleanupPeriodDays: number
 *   nowSeconds: number
 * }} p
 * @returns {'keep' | 'remove' | 'advisory'}
 */
export function sweepDecision(p) {
  const stale = p.ageSeconds !== undefined
    && p.ageSeconds > p.cleanupPeriodDays * 24 * 60 * 60
  if (p.locked) {
    return stale && p.lockReason.startsWith(DSH_CC_LOCK_PREFIX) ? 'advisory' : 'keep'
  }
  if (!stale) return 'keep'
  if (!p.underConventionDir || !p.ownedBranch) return 'keep'
  if (p.dirty === undefined || p.dirty || p.unpushed === undefined || p.unpushed) return 'keep'
  return 'remove'
}

/**
 * Run the boot-time sweep for a repository. Degrades to a silent no-op on
 * any probe failure (like the pre-existing `git worktree prune`); never
 * touches the network; bounded by `deadline` (default {@link SWEEP_CAP_MS}).
 * @param {{
 *   repoRoot: string
 *   cleanupPeriodDays: number
 *   nowSeconds?: number
 *   git: (argv: string[], opts?: { timeoutMs?: number, cwd?: string }) => { status: number | null, stdout: string, stderr?: string } | undefined
 *   deadline?: number
 *   onAdvisory?: (line: string) => void
 * }} p
 * @returns {{ removed: string[], advisories: string[] }}
 */
export function sweepWorktrees(p) {
  const nowSeconds = p.nowSeconds ?? Math.floor(Date.now() / 1000)
  const deadline = p.deadline ?? SWEEP_CAP_MS
  const start = Date.now()
  const expired = () => Date.now() - start >= deadline
  const git = p.git
  const noTime = () => expired()
  const removed = []
  const advisories = []
  let list
  try {
    list = git(['worktree', 'list', '--porcelain'], { cwd: p.repoRoot })
  } catch {
    list = undefined
  }
  if (!list || list.status !== 0) return { removed, advisories }
  if (noTime()) return { removed, advisories }
  for (const entry of parseWorktreeListPorcelain(list.stdout)) {
    if (expired()) break
    const underConventionDir = entry.path.includes(WORKTREES_DIR_SEGMENTS.join('/'))
    const ownedBranch = entry.branch.startsWith(WORKTREE_BRANCH_PREFIX)
    let ageSeconds
    try {
      // PRIMARY age: last commit inside the worktree.
      const lastCommit = git(['-C', entry.path, 'log', '-1', '--format=%ct'], { timeoutMs: 2000, cwd: p.repoRoot })
      const parsed = lastCommit && lastCommit.status === 0
        ? Number.parseInt(lastCommit.stdout.trim(), 10)
        : Number.NaN
      if (Number.isNaN(parsed)) throw new Error('unreadable')
      ageSeconds = nowSeconds - parsed
    } catch {
      // FALLBACK age: directory mtime (only when the commit probe is unreadable).
      try {
        ageSeconds = nowSeconds - Math.floor(statSync(entry.path).mtimeMs / 1000)
      } catch {
        ageSeconds = undefined
      }
    }
    // No age at all (both probes failed) → fail closed, skip the entry.
    if (ageSeconds === undefined) continue
    let dirty
    let unpushed
    if (!entry.locked) {
      try {
        const status = git(['-C', entry.path, 'status', '--porcelain'], { timeoutMs: 2000, cwd: p.repoRoot })
        if (!status || status.status !== 0) {
          dirty = undefined
        } else {
          dirty = status.stdout.split('\n').some(line => line.trim().length > 0)
        }
      } catch {
        dirty = undefined
      }
      try {
        const unpushedProbe = git(['-C', entry.path, 'rev-list', '@{u}..HEAD'], { timeoutMs: 2000, cwd: p.repoRoot })
        if (!unpushedProbe || unpushedProbe.status !== 0) {
          unpushed = undefined
        } else {
          unpushed = unpushedProbe.stdout.trim().length > 0
        }
      } catch {
        unpushed = undefined
      }
    }
    const decision = sweepDecision({
      underConventionDir,
      ownedBranch,
      locked: entry.locked,
      lockReason: entry.lockReason,
      ageSeconds,
      dirty,
      unpushed,
      cleanupPeriodDays: p.cleanupPeriodDays,
      nowSeconds,
    })
    if (decision === 'advisory') {
      const line = `dsh-cc: stale session lock (age > ${p.cleanupPeriodDays}d) on ${entry.path} — run: git worktree unlock ${entry.path}`
      advisories.push(line)
      p.onAdvisory?.(line)
    } else if (decision === 'remove') {
      const remove = git(['worktree', 'remove', '--force', entry.path], { timeoutMs: 4000, cwd: p.repoRoot })
      if (!remove || remove.status !== 0) continue
      git(['branch', '-D', entry.branch], { timeoutMs: 2000, cwd: p.repoRoot })
      removed.push(entry.path)
      p.onAdvisory?.(`dsh-cc: swept stale worktree ${entry.path} (branch ${entry.branch})`)
    }
  }
  return { removed, advisories }
}

// --- name-reuse merged reset ---------------------------------------------------

/**
 * Reuse-reset predicate for the launcher's named-reuse path (WS-4, CC
 * merged-reset rule). Pure over pre-run probes. Reset requires ALL of:
 * clean target, still on its `worktree-` branch, and either no own commits
 * beyond the base, OR the upstream is gone AND every own commit is
 * reachable from the resolved fresh base. ANY unverifiable probe keeps the
 * old tip. A `source` other than 'name' (WS-6 PR reuse) never resets.
 * @param {{
 *   source?: 'name' | string
 *   clean: boolean | undefined
 *   ownedBranch: boolean
 *   ownCommits: number | undefined
 *   upstreamGone: boolean | undefined
 *   mergedIntoFreshBase: boolean | undefined
 * }} p
 * @returns {'reset' | 'keep-tip'}
 */
export function reuseResetDecision(p) {
  if (p.source !== 'name') return 'keep-tip'
  if (p.clean === undefined || !p.clean) return 'keep-tip'
  if (!p.ownedBranch) return 'keep-tip'
  if (p.ownCommits === undefined) return 'keep-tip'
  if (p.ownCommits === 0) return 'reset'
  if (p.upstreamGone === true && p.mergedIntoFreshBase === true) return 'reset'
  return 'keep-tip'
}

/**
 * Probe a reused worktree and (when the predicate holds) hard-reset it to
 * the resolved fresh base before handover. Every probe failure degrades to
 * keep-tip; the reset itself failing also degrades (worktree is still
 * handed over as-is).
 * @param {{
 *   plan: { worktreePath: string, branch: string }
 *   repoRoot: string
 *   freshBase: string
 *   source?: string
 *   git: (argv: string[], opts?: { timeoutMs?: number, cwd?: string }) => { status: number | null, stdout: string } | undefined
 *   onReset?: (freshBase: string) => void
 * }} p
 * @returns {{ action: 'reset' | 'keep-tip' }}
 */
export function worktreeReuseReset(p) {
  const git = p.git
  const probe = (argv) => {
    try {
      const r = git(argv, { timeoutMs: 2000, cwd: p.repoRoot })
      return r && r.status === 0 ? r : undefined
    } catch {
      return undefined
    }
  }
  const status = probe(['-C', p.plan.worktreePath, 'status', '--porcelain'])
  const clean = status !== undefined ? status.stdout.trim().length === 0 : undefined
  const headBranch = probe(['-C', p.plan.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'])
  const ownedBranch = headBranch !== undefined && headBranch.stdout.trim() === p.plan.branch
    && p.plan.branch.startsWith(WORKTREE_BRANCH_PREFIX)
  // Own commits: everything on the branch not reachable from the worktree's
  // recorded base. The branch was created with -B from a base commit; treat
  // the fresh base as the reference point.
  let ownCommits
  if (ownedBranch) {
    const count = probe(['-C', p.plan.worktreePath, 'rev-list', '--count', `${p.freshBase}..HEAD`])
    ownCommits = count !== undefined ? Number.parseInt(count.stdout.trim(), 10) : undefined
    if (Number.isNaN(ownCommits)) ownCommits = undefined
  }
  const upstream = probe(['-C', p.plan.worktreePath, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const upstreamGone = upstream === undefined
    ? undefined
    : !probe(['-C', p.plan.worktreePath, 'rev-parse', '--verify', '--quiet', `${upstream.stdout.trim()}^{}`])
  let mergedIntoFreshBase
  if (ownCommits !== undefined && ownCommits > 0 && upstreamGone === true) {
    const merged = probe(['-C', p.plan.worktreePath, 'merge-base', '--is-ancestor', 'HEAD', p.freshBase])
    mergedIntoFreshBase = merged !== undefined
  }
  const action = reuseResetDecision({
    source: p.source,
    clean,
    ownedBranch,
    ownCommits,
    upstreamGone,
    mergedIntoFreshBase,
  })
  if (action === 'reset') {
    const reset = probe(['-C', p.plan.worktreePath, 'reset', '--hard', p.freshBase])
    if (reset !== undefined) {
      p.onReset?.(p.freshBase)
      return { action: 'reset' }
    }
  }
  return { action: 'keep-tip' }
}
