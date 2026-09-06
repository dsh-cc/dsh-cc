/**
 * First-run helpers for the dsh-cc launcher. Pure so tests can drive the
 * decision table without spawning dsh.
 */

import { join } from 'node:path'

export const PROFILE = 'tui'
export const BUNDLES = [
  '@dsh-cc/bundle-permissions',
  '@dsh-cc/bundle-shell',
  '@dsh-cc/bundle-tui',
]

/**
 * Scan dsh-cc args for resume-mode flags and translate them into the env
 * contract the TUI plugin consumes. Collection is order-independent: all
 * flags are gathered during the scan, then applied once afterwards with
 * fixed precedence `--resume <id>` / `--resume=<id>` > `--new` > `-c`.
 *
 * After precedence resolution the env is finished:
 * - `DSH_CC_CONTINUE='1'` when `-c`/`--continue` was requested (the TUI
 *   shows a "no previous session to continue" notice when no marker exists).
 * - `DSH_CC_AUTO_RESUME='1'` exactly when `DSH_CC_RESUME_SESSION` is left
 *   undefined — i.e. no explicit `--resume`/`--new` chose the session. The
 *   TUI then reads its own project resume marker. An explicit `--resume` or
 *   `--new` naturally suppresses AUTO_RESUME.
 *
 * Every resume-mode flag is stripped from the forwarded args; combined
 * shorts (e.g. -cn) are not recognized — each flag must be its own token.
 * The launcher never reads a marker itself: the TUI owns marker reads.
 *
 * @param {string | undefined} resumeFlag
 * @param {string[]} rest
 * @param {Record<string, string>} env
 * @returns {{ env: Record<string, string>, args: string[], continueRequested: boolean }}
 */
export function interceptResume(resumeFlag, rest, env = {}) {
  const nextEnv = { ...env }
  const args = []
  if (typeof resumeFlag === 'string' && resumeFlag.length > 0) {
    nextEnv.DSH_CC_RESUME_SESSION = resumeFlag
  }
  let resumeId
  let hasResumeId = false
  let newSession = false
  let continueRequested = false
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === '--resume') {
      const value = rest[i + 1]
      if (value !== undefined && !value.startsWith('-')) {
        resumeId = value
        hasResumeId = true
        i += 1
        continue
      }
    }
    if (token.startsWith('--resume=')) {
      resumeId = token.slice('--resume='.length)
      hasResumeId = true
      continue
    }
    if (token === '--new' || token === '-n') {
      newSession = true
      continue
    }
    if (token === '--continue' || token === '-c') {
      continueRequested = true
      continue
    }
    args.push(token)
  }
  if (hasResumeId) {
    nextEnv.DSH_CC_RESUME_SESSION = resumeId
  } else if (newSession) {
    // Empty string is the fresh-session sentinel (--new / freshly created
    // worktree): the TUI starts fresh and must not read a marker.
    nextEnv.DSH_CC_RESUME_SESSION = ''
  }
  if (continueRequested) nextEnv.DSH_CC_CONTINUE = '1'
  if (nextEnv.DSH_CC_RESUME_SESSION === undefined) nextEnv.DSH_CC_AUTO_RESUME = '1'
  return { env: nextEnv, args, continueRequested }
}

/**
 * Strip the launcher-owned resume-session env vars that a parent dsh-cc TUI
 * process leaks into a child launcher. The launcher must re-derive these
 * from its own argv only (via {@link interceptResume}): an inherited
 * `DSH_CC_AUTO_RESUME=1` would otherwise defeat the `--new`/`--worktree`
 * gate (an explicit fresh start being ignored in favour of auto-resume), and
 * an inherited `DSH_CC_RESUME_SESSION`/`DSH_CC_CONTINUE` would inject a
 * session the user never asked this invocation to resume.
 *
 * Called once at the bin's entry, before any flag is parsed or the worktree
 * block runs. Returns a NEW object — the input is never mutated.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function sanitizeInheritedEnv(env) {
  const out = { ...env }
  delete out.DSH_CC_RESUME_SESSION
  delete out.DSH_CC_AUTO_RESUME
  delete out.DSH_CC_CONTINUE
  return out
}

/**
 * Guidance printed on every path where the `dsh` CLI cannot be spawned
 * (not on PATH). Two lines: what happened, then how to fix it.
 * @returns {string}
 */
export function dshUnavailableMessage() {
  return 'dsh-cc: the `dsh` CLI is not on PATH.\n'
    + 'Install deepseek-harness first, e.g.:  npm install -g @deepseek-ai/dsh'
}

/**
 * Environment for the final `dsh` spawn. Defaults `NODE_COMPILE_CACHE` to
 * `<dshHome>/.cache/node-compile-cache` so the child's module-compile work is
 * reused across boots (Node creates the dir itself — never mkdir here). A
 * user-set `NODE_COMPILE_CACHE` always wins. Returns a NEW object — the
 * input is never mutated.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} dshHome
 * @returns {Record<string, string | undefined>}
 */
export function spawnEnv(env, dshHome) {
  const out = { ...env }
  out.NODE_COMPILE_CACHE ??= join(dshHome, '.cache', 'node-compile-cache')
  return out
}

/**
 * @param {boolean} profileExists
 * @param {string} version
 */
export function bootstrapCommand(profileExists, version) {
  if (profileExists) return undefined
  return ['plugin', '--profile', PROFILE, 'add', ...BUNDLES.map(name => `${name}@${version}`)]
}

// --- worktree support (--worktree) ------------------------------------------
// Slug, path, and branch rules mirror
// packages/workspace/tool-git-worktree/src/worktree.ts exactly — keep the two
// in sync. The tool package cannot be imported here: the launcher is plain
// dependency-free JS that runs before any build.

/** Env var carrying the launcher's worktree-session descriptor to the TUI. */
export const WORKTREE_ENV = 'DSH_CC_WORKTREE'

const MAX_SLUG_LENGTH = 64
const SEGMENT = /^[a-zA-Z0-9._-]+$/
const ADJECTIVES = ['swift', 'bright', 'calm', 'keen', 'bold']
const NOUNS = ['fox', 'owl', 'elm', 'oak', 'ray']

/**
 * Scan dsh-cc args for the `--worktree` flag and strip it. Name forms:
 * `--worktree <name>`, `--worktree=<name>`, or bare `--worktree` (random
 * name). A following token that starts with `-` is NOT taken as the name.
 * @param {string[]} args
 * @returns {{ name: string | null | undefined, args: string[] }}
 *   `name` is undefined when the flag is absent, null when present without a
 *   name, and the slug otherwise; `args` is the remainder to forward.
 */
export function parseWorktreeFlag(args) {
  let name
  const rest = []
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === '--worktree') {
      const value = args[i + 1]
      if (value !== undefined && !value.startsWith('-')) {
        name = value
        i += 1
      } else {
        name = null
      }
      continue
    }
    if (token.startsWith('--worktree=')) {
      const value = token.slice('--worktree='.length)
      name = value.length > 0 ? value : null
      continue
    }
    rest.push(token)
  }
  return { name, args: rest }
}

/**
 * Validate a worktree slug. Identical rules and messages to the tool
 * package's validateSlug.
 * @param {string} slug
 */
export function validateWorktreeSlug(slug) {
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new Error(
      `invalid worktree name: must be ${MAX_SLUG_LENGTH} characters or fewer (got ${slug.length})`,
    )
  }
  for (const segment of slug.split('/')) {
    if (segment === '.' || segment === '..') {
      throw new Error(
        `invalid worktree name "${slug}": must not contain "." or ".." path segments`,
      )
    }
    if (!SEGMENT.test(segment)) {
      throw new Error(
        `invalid worktree name "${slug}": each "/"-separated segment must be non-empty and contain only letters, digits, dots, underscores, and dashes`,
      )
    }
  }
}

/**
 * @param {string} slug - A validated worktree slug.
 * @returns {string} the flattened single-directory name (`user/feature` → `user+feature`).
 */
export function flattenSlug(slug) {
  return slug.replaceAll('/', '+')
}

/**
 * @param {string} slug - A validated worktree slug.
 * @returns {string} the branch backing the worktree.
 */
export function worktreeBranch(slug) {
  return `worktree-${flattenSlug(slug)}`
}

/**
 * @param {string} repoRoot
 * @param {string} slug - A validated worktree slug.
 * @returns {string} the absolute on-disk worktree path.
 */
export function worktreePathFor(repoRoot, slug) {
  return join(repoRoot, '.claude', 'worktrees', flattenSlug(slug))
}

/**
 * Generate a random slug (`swift-fox-8f3a`), same word lists as the tool
 * package. Injectable `rand` keeps tests deterministic.
 * @param {() => number} [rand]
 * @returns {string}
 */
export function randomWorktreeSlug(rand = Math.random) {
  const adjective = ADJECTIVES[Math.floor(rand() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(rand() * NOUNS.length)]
  const suffix = rand().toString(36).slice(2, 6)
  return `${adjective}-${noun}-${suffix}`
}

/**
 * @param {string} repoRoot
 * @param {string | null} name - Requested slug, or null for a random one.
 * @param {() => number} [rand]
 * @returns {{ slug: string, worktreePath: string, branch: string }}
 */
export function planWorktree(repoRoot, name, rand) {
  const slug = name === null || name === undefined ? randomWorktreeSlug(rand) : name
  validateWorktreeSlug(slug)
  return { slug, worktreePath: worktreePathFor(repoRoot, slug), branch: worktreeBranch(slug) }
}

/**
 * argv for `git worktree add -B <branch> <path> HEAD` (execFile form — no
 * shell, so no quoting concerns). `-B` resets a stale orphan branch left by
 * a removed worktree.
 * @param {{ worktreePath: string, branch: string }} plan
 * @returns {string[]}
 */
export function worktreeAddArgv(plan) {
  return ['worktree', 'add', '-B', plan.branch, plan.worktreePath, 'HEAD']
}

/**
 * Env fragment handed to the spawned dsh process so the TUI can recognize
 * this session as launcher-managed worktree session at /quit time.
 * @param {{ worktreePath: string, branch: string }} plan
 * @param {string} repoRoot
 * @param {string} baseHead - The commit the worktree was based on.
 * @returns {Record<string, string>}
 */
export function worktreeEnv(plan, repoRoot, baseHead) {
  return {
    [WORKTREE_ENV]: JSON.stringify({
      repoRoot,
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      baseHead,
    }),
  }
}

/**
 * Collision policy for a *named* `--worktree <slug>` whose path already
 * exists: reuse it (do not `git worktree add`). Random slugs still fail so
 * they can retry a fresh name.
 * @param {{ named: boolean, pathExists: boolean }} params
 * @returns {'reuse' | 'create'}
 */
export function existingWorktreeDecision({ named, pathExists }) {
  return named && pathExists ? 'reuse' : 'create'
}

/**
 * Collision policy for `git worktree add`: a random slug may retry with a
 * fresh name; a user-named slug fails immediately with an actionable error.
 * @param {{ named: boolean, attempt: number, maxAttempts?: number }} params
 * @returns {'retry' | 'fail'}
 */
export function slugRetryDecision({ named, attempt, maxAttempts = 5 }) {
  return !named && attempt < maxAttempts ? 'retry' : 'fail'
}
