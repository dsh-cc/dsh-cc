/**
 * First-run helpers for the dsh-cc launcher. Pure so tests can drive the
 * decision table without spawning dsh.
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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
 * WS-6 item 3: parse a PR reference `--worktree` value — `#<n>`, a GitHub PR
 * URL, or a GitLab MR URL. Runs BEFORE any slug validation so `#12` never
 * reaches validateWorktreeSlug. Anything else is not a PR reference.
 * @param {string | null | undefined} value - the parsed flag value.
 * @returns {{ pr: number, host?: string } | undefined}
 *   `host` is the URL's host when the value was a URL (it selects the fetch
 *   ref shape); undefined for a bare `#<n>`.
 */
export function parseWorktreeRef(value) {
  if (value === null || value === undefined) return undefined
  let m = /^#(\d+)$/.exec(value)
  if (m !== null) return { pr: Number(m[1]) }
  m = /^https:\/\/([^/]+)\/.+(?:\/pull|\/-\/merge_requests|\/merge_requests)\/(\d+)\/?$/.exec(value)
  if (m !== null) return { pr: Number(m[2]), host: m[1] }
  return undefined
}

/**
 * The origin fetch refs for a PR head, in try order (WS-6 item 3):
 * `pull/<n>/head` on github.com, `merge-requests/<n>/head` on gitlab.com,
 * first-then-second on any other (or unknown) host.
 * @param {string | undefined} host
 * @param {number} n
 * @returns {string[]}
 */
export function prFetchRefs(host, n) {
  if (host === 'github.com') return [`pull/${n}/head`]
  if (host === 'gitlab.com') return [`merge-requests/${n}/head`]
  return [`pull/${n}/head`, `merge-requests/${n}/head`]
}

/**
 * Host of a git remote URL (`https://…`, `git@host:…`, `ssh://…`), or
 * undefined when it has none.
 * @param {string} url
 * @returns {string | undefined}
 */
export function remoteHost(url) {
  const m = /^(?:(?:https?|ssh):\/\/)?(?:[^/@]+@)?([^/:]+)/.exec(url.trim())
  return m !== null ? m[1] : undefined
}

/**
 * The fixed PR plan: slug `pr-<n>`, branch `worktree-pr-<n>`, path under the
 * convention dir. Deliberately NOT routed through validateWorktreeSlug —
 * the `pr-<n>` shape is generated here and always valid.
 * @param {string} repoRoot
 * @param {number} n
 * @returns {{ slug: string, worktreePath: string, branch: string }}
 */
export function planWorktreeRef(repoRoot, n) {
  const slug = `pr-${n}`
  return { slug, worktreePath: join(repoRoot, '.claude', 'worktrees', slug), branch: `worktree-pr-${n}` }
}

/**
 * argv for `git worktree add -B <branch> <path> HEAD` (execFile form — no
 * shell, so no quoting concerns). `-B` resets a stale orphan branch left by
 * a removed worktree. When `filterNames` is nonempty, empty-string `-c`
 * overrides neutralize every repository-local filter driver first
 * (mechanism verified empirically — content-marker experiment, git 2.54:
 * overriding all `filter.<name>.*` keys + `required=false` suppresses
 * execution; `required=false` alone does NOT). Consequence (CC parity):
 * LFS content arrives as pointer files; `git lfs pull` restores it.
 * @param {{ worktreePath: string, branch: string }} plan
 * @param {readonly string[]} [filterNames]
 * @param {string} [base] - Resolved base ref/commit (WS-4 `worktree.baseRef`);
 *   defaults to the literal `HEAD`.
 * @returns {string[]}
 */
export function worktreeAddArgv(plan, filterNames = [], base = 'HEAD') {
  const neutralize = []
  for (const filter of filterNames) {
    for (const key of ['command', 'smudge', 'clean', 'process']) {
      neutralize.push('-c', `filter.${filter}.${key}=`)
    }
    neutralize.push('-c', `filter.${filter}.required=false`)
  }
  return [...neutralize, 'worktree', 'add', '-B', plan.branch, plan.worktreePath, base]
}

/**
 * WS-1 root pinning: main repository root from `git rev-parse
 * --git-common-dir` output run at `cwd`. Inside a linked worktree the
 * common dir already points at the main checkout's `.git`, so creation
 * always anchors at the main root (sibling worktrees, never nested).
 * @param {string} cwd - Directory the git probe ran in.
 * @param {string} output - Raw stdout of the probe.
 * @returns {string | undefined}
 */
export function repoRootFromCommonDir(cwd, output) {
  const raw = output.trim()
  if (raw.length === 0) return undefined
  return dirname(isAbsolute(raw) ? raw : resolve(cwd, raw))
}

/**
 * Parse `git config --local --list -z` output (NUL-separated `key\nvalue`
 * entries — the NUL form keeps filter names containing `=` decidable).
 * Refuses includeIf and filter names containing `=`; collects the rest.
 * Keep in sync with tool-git-worktree/src/harden.ts.
 * @param {string} text
 * @returns {{ filters: string[], refusals: string[] }}
 */
export function parseLocalConfig(text) {
  const filters = new Set()
  const refusals = []
  for (const entry of text.split('\0')) {
    if (entry.length === 0) continue
    const nl = entry.indexOf('\n')
    const rawKey = nl < 0 ? entry : entry.slice(0, nl)
    const key = rawKey.toLowerCase()
    if (key.startsWith('includeif.')) {
      refusals.push(`refusing local config with includeIf: ${rawKey}`)
      continue
    }
    if (!key.startsWith('filter.')) continue
    const name = key.slice('filter.'.length, key.lastIndexOf('.'))
    if (name.length === 0) continue
    if (name.includes('=') || name.includes('\n')) {
      refusals.push(`refusing filter driver with ambiguous name: filter.${name}.*`)
      continue
    }
    filters.add(name)
  }
  return { filters: [...filters], refusals }
}

/**
 * WS-1 symlink refusal: the first path in the list that is itself a symlink
 * (CC v2.1.212 parity). Callers check `.claude`, `.claude/worktrees`, and
 * the computed target path.
 * @param {string[]} paths
 * @returns {string | null} the offending path, or null when none is a symlink.
 */
export function symlinkedPath(paths) {
  for (const path of paths) {
    try {
      if (lstatSync(path).isSymbolicLink()) return path
    } catch {
      // missing is fine
    }
  }
  return null
}

/**
 * WS-1 adoption identity check for reusing an existing directory as a
 * worktree: its `.git` entry must be a gitdir pointer file resolving into
 * the main checkout's `.git/worktrees/` registration. Refuses plain clones,
 * core.worktree redirects, unreadable entries, directories that contain the
 * main checkout, and directories with no git metadata (may hold user work).
 * Keep in sync with tool-git-worktree/src/harden.ts.
 * @param {string} target - Absolute path of the existing directory.
 * @param {string} mainRoot - Main checkout repository root.
 * @returns {string | null} the refusal reason, or null when adoptable.
 */
export function worktreeIdentityRefusal(target, mainRoot) {
  const rel = relative(target, mainRoot)
  if (rel === '' || !rel.startsWith(`..${sep}`)) {
    return `refusing to reuse ${target}: it contains the main checkout at ${mainRoot}. Remove or rename the directory (or pick another name) and retry.`
  }
  const gitEntry = join(target, '.git')
  let info
  try {
    info = lstatSync(gitEntry)
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      return `refusing to reuse ${target}: it holds no git worktree (no .git entry) and may contain user work. Remove or rename the directory (or pick another name) and retry.`
    }
    return `refusing to reuse ${target}: its .git entry is unreadable (${/** @type {NodeJS.ErrnoException} */ (error).message}). Inspect the directory manually; remove or rename it (or pick another name) and retry.`
  }
  if (!info.isFile()) {
    let detail = 'it is a separate checkout (directory .git), not a linked worktree'
    try {
      const common = readFileSync(join(gitEntry, 'commondir'), 'utf8').trim()
      const gitRoot = join(mainRoot, '.git')
      const resolved = resolve(gitEntry, common)
      if (resolved.startsWith(gitRoot + sep) || resolved === gitRoot) {
        detail = 'its .git commondir resolves into the main checkout\'s own .git (plain-clone/core.worktree redirect shape)'
      }
    } catch {
      // no commondir file — separate-checkout message stands
    }
    return `refusing to reuse ${target}: ${detail}. Remove or rename the directory (or pick another name) and retry.`
  }
  let gitdir
  try {
    gitdir = readFileSync(gitEntry, 'utf8').trim()
  } catch {
    return `refusing to reuse ${target}: its .git pointer file is unreadable. Inspect the directory manually; remove or rename it (or pick another name) and retry.`
  }
  if (!gitdir.startsWith('gitdir:')) {
    return `refusing to reuse ${target}: its .git entry is a file but not a gitdir pointer. Remove or rename the directory (or pick another name) and retry.`
  }
  const registered = resolve(target, gitdir.slice('gitdir:'.length).trim())
  const registrations = join(mainRoot, '.git', 'worktrees')
  if (!registered.startsWith(registrations + sep) && registered !== registrations) {
    return `refusing to reuse ${target}: its .git pointer resolves to ${registered}, which is not this repository's worktree registration (.git/worktrees/). It may be a clone, redirect, or foreign worktree. Remove or rename the directory (or pick another name) and retry.`
  }
  return null
}

/**
 * Env fragment handed to the spawned dsh process so the TUI can recognize
 * this session as launcher-managed worktree session at /quit time.
 * `named` records whether the slug was user-chosen (WS-5's auto-remove
 * predicate consumes it — keep in sync with the worktree-exit marker parse).
 * @param {{ worktreePath: string, branch: string }} plan
 * @param {string} repoRoot
 * @param {string} baseHead - The commit the worktree was based on.
 * @param {boolean} named - True when the user supplied the slug.
 * @returns {Record<string, string>}
 */
export function worktreeEnv(plan, repoRoot, baseHead, named) {
  return {
    [WORKTREE_ENV]: JSON.stringify({
      repoRoot,
      worktreePath: plan.worktreePath,
      branch: plan.branch,
      baseHead,
      named: Boolean(named),
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

// --- minimum harness version gate --------------------------------------------
// This gate runs ONLY on the bootstrap/install path (when bootstrapCommand
// returns non-undefined), never on every launch: docs/plans/
// 2026-09-05-startup-boot-first-frame.md W2 deliberately removed the
// launcher's per-launch `dsh --version` probe (~60 ms of extra Node cold
// start before the first frame). A version check on the install path is
// acceptable — it happens once, before the profile exists.

/** Lowest harness version the published bundles are known to work with. */
export const MIN_DSH_VERSION = '0.1.5-rc.1'

const VERSION_RE = /\d+\.\d+\.\d+(?:-[\w.+-]+)?/

/**
 * Extract the first `x.y.z[-pre][+build]` version string from `dsh --version`
 * output. Lenient on purpose: returns null when nothing matches so callers
 * can fail open.
 * @param {string | undefined} output - Raw stdout (may be undefined).
 * @returns {string | null}
 */
export function extractDshVersion(output) {
  if (typeof output !== 'string') return null
  const match = output.match(VERSION_RE)
  return match === null ? null : match[0]
}

/**
 * Prerelease-aware semver compare (hand-rolled — the launcher has zero
 * dependencies). Returns <0, 0, >0 as a sorts before/equal/after b.
 * Numeric identifiers compare numerically; absence of a prerelease outranks
 * any prerelease; alphanumeric identifiers compare lexically (alpha < rc).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const parse = (v) => {
    const [core, pre = ''] = v.split('-')
    const [numbers, build = ''] = pre.split('+')
    return {
      core: core.split('.').map(Number),
      pre: numbers.length === 0 ? [] : numbers.split('.'),
      build,
    }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 3; i += 1) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
  }
  if (pa.pre.length !== pb.pre.length) {
    return pa.pre.length === 0 ? 1 : pb.pre.length === 0 ? -1 : 0
  }
  for (let i = 0; i < pa.pre.length; i += 1) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y)
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

/**
 * True when the found version is strictly below {@link MIN_DSH_VERSION}.
 * @param {string} version
 * @returns {boolean}
 */
export function belowMinimumVersion(version) {
  return compareSemver(version, MIN_DSH_VERSION) < 0
}

/**
 * Actionable below-minimum error: what was found, what is required, how to
 * fix it.
 * @param {string} found
 * @returns {string}
 */
export function belowMinimumMessage(found) {
  return `dsh-cc: dsh version ${found} is too old; this launcher requires >= ${MIN_DSH_VERSION}.\n`
    + 'Upgrade the harness first, e.g.:  npm install -g @deepseek-ai/dsh@latest'
}

/**
 * Full gate decision for the bootstrap path: run `dsh --version` (via the
 * injectable runner, spawnSync in production), parse, compare.
 * Garbage/unparseable output fails OPEN with a one-line warning — a parse
 * failure must never brick the launcher.
 * @param {() => { stdout?: string | Buffer } | undefined} runVersion
 * @returns {{ ok: boolean, message?: string, warning?: string }}
 */
export function versionGate(runVersion) {
  let result
  try {
    result = runVersion()
  } catch {
    result = undefined
  }
  const found = extractDshVersion(result?.stdout?.toString())
  if (found === null) {
    return {
      ok: true,
      warning: 'dsh-cc: could not parse `dsh --version` output; skipping the minimum-version check.',
    }
  }
  if (belowMinimumVersion(found)) {
    return { ok: false, message: belowMinimumMessage(found) }
  }
  return { ok: true }
}

// --- dev-build version stamp + store restore ---------------------------------

/**
 * Read a dev-build stamp written by scripts/stamp-build-info.mjs into the
 * profile's @dsh-cc scope. Any problem (missing file, EACCES, malformed
 * JSON) fails open to null — the launcher must never brick on a stamp.
 *
 * @param {string} stampPath
 * @returns {Record<string, unknown> | null}
 */
export function readBuildInfo(stampPath) {
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Version label for `dsh-cc --version`: bare semver for release installs,
 * `<base>-dev+<commit>[.dirty]` for a dev-synced profile. The stamp's own
 * version wins over the launcher's — the commit describes that tree.
 *
 * @param {string} version launcher's own package.json version
 * @param {Record<string, unknown> | null} info parsed stamp or null
 * @returns {string}
 */
export function formatVersionLabel(version, info) {
  if (info?.channel !== 'dev') return version
  const base = (typeof info.version === 'string' && info.version) || version
  const commit = (typeof info.commit === 'string' && info.commit) || 'unknown'
  return `${base}-dev+${commit}${info.dirty === true ? '.dirty' : ''}`
}

/**
 * Decide whether the profile's dev store copy must be restored to store
 * bundles: only when the stamp pairs this profile with a DIFFERENT launcher
 * version than the one now running. Unknown pairing (no launcherVersion)
 * never destroys dev state.
 *
 * @param {Record<string, unknown> | null} info
 * @param {string} ownVersion
 * @returns {{ from: string, to: string } | null}
 */
export function devStoreRestoreDecision(info, ownVersion) {
  if (info?.channel !== 'dev') return null
  const seen = info.launcherVersion
  if (typeof seen !== 'string' || seen.length === 0 || seen === ownVersion) return null
  return { from: seen, to: ownVersion }
}

/**
 * Restore a dev-synced profile to store bundles after a launcher update
 * (plan §3.4). Set-aside + rename dance is atomic per step; any unexpected
 * throw is rolled back best-effort and reported, never escaping to the bin.
 *
 * @param {string} profileDir
 * @param {string} ownVersion
 * @param {{ spawnSyncImpl?: typeof import('node:child_process').spawnSync, log?: (...a: unknown[]) => void, now?: () => number }} [deps]
 * @returns {{ restored: boolean, reason?: string, from?: string, to?: string }>}
 */
export function runStoreRestore(profileDir, ownVersion, deps = {}) {
  const { spawnSyncImpl = spawnSync, log = console.error, now = Date.now } = deps
  const scope = join(profileDir, 'node_modules', '@dsh-cc')
  const backup = `${scope}.__dev-restore-backup`
  const lock = join(profileDir, 'node_modules', '.dsh-cc-restore.lock')
  const stamp = join(scope, 'dsh-cc-build.json')
  const home = dirname(dirname(profileDir))
  const presetDir = join(home, '.agent-presets', 'cc')
  // The bin always hands us <home>/profiles/<PROFILE>; deriving the name keeps
  // the function honest when tests pass tmp profile dirs.
  const profileName = basename(profileDir)
  let locked = false
  // Rollback cleanup may only touch `scope` once the dev state is safely in
  // `backup` — a throw BEFORE the set-aside must leave the profile untouched.
  let setAside = false

  const tryRename = (from, to) => {
    try {
      renameSync(from, to)
      return true
    } catch (error) {
      log(`dsh-cc: dev-store restore: rename ${from} -> ${to} failed: ${/** @type {Error} */ (error).message}`)
      return false
    }
  }
  const tryRm = (target, recursive) => {
    try {
      rmSync(target, { recursive, force: true })
      return true
    } catch (error) {
      log(`dsh-cc: dev-store restore: failed to remove ${target}: ${/** @type {Error} */ (error).message}`)
      return false
    }
  }

  try {
    // 1. Lock FIRST: exclusive create; a lock younger than ten minutes means
    // another launch is mid-restore — skip (launch as-is; transient until the
    // holder finishes). Stale locks are taken over. Crash recovery MUST run
    // only with the lock held: recovering backup->scope while a live holder
    // re-materializes would let the holder delete the stamp out of the
    // recovered dev scope and report success — dev code booting while
    // --version claims a release, with no retry ever firing again.
    let handle
    try {
      handle = openSync(lock, 'wx')
      locked = true
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error
      let fresh = true
      try {
        fresh = now() - statSync(lock).mtimeMs < 10 * 60 * 1000
      } catch { /* lock vanished between EEXIST and stat: proceed to retry */ }
      if (fresh) {
        log('dsh-cc: dev-store restore already in progress, skipping')
        return { restored: false, reason: 'locked' }
      }
      tryRm(lock, false)
      try {
        handle = openSync(lock, 'wx')
        locked = true
      } catch {
        log('dsh-cc: dev-store restore already in progress, skipping')
        return { restored: false, reason: 'locked' }
      }
    }
    closeSync(handle)

    // 2. Crash recovery: a previous restore died between set-aside and commit.
    if (existsSync(backup) && !existsSync(scope)) {
      log('dsh-cc: dev-store restore: recovering interrupted restore (backup -> scope)')
      if (!tryRename(backup, scope)) return { restored: false, reason: 'error' }
    }

    // Read the stamp BEFORE renaming the scope away, for the notice's `from`.
    const info = readBuildInfo(stamp)
    const from = (typeof info?.launcherVersion === 'string' && info.launcherVersion) || 'unknown'

    // 3. Set aside the whole dev scope — presence is not content (pnpm trusts
    // name+version), so it must never stay in place during re-materialize.
    if (!tryRename(scope, backup)) return { restored: false, reason: 'error' }
    setAside = true

    // 4. Re-materialize from the registry, same command surface as first boot.
    const result = spawnSyncImpl('dsh', ['plugin', '--profile', profileName, 'add', ...BUNDLES.map(n => `${n}@${ownVersion}`)], {
      stdio: 'inherit',
      env: spawnEnv(sanitizeInheritedEnv(process.env), home),
    })
    const success = !result.error && result.status === 0

    if (success) {
      // 5. Commit: drop backup + stamp, then preset cleanup.
      tryRm(backup, true)
      tryRm(stamp, false)
      try {
        if (existsSync(presetDir)) {
          const marker = JSON.parse(readFileSync(join(presetDir, '.dsh-cc-managed.json'), 'utf8'))
          if (marker?.owner !== '@dsh-cc/tui') throw new Error('unowned preset copy')
        }
      } catch {
        tryRm(presetDir, true)
        log('dsh-cc: removed dev preset copy at .agent-presets/cc (store boot will reinstall it)')
      }
      log(`dsh-cc: launcher updated ${from} → ${ownVersion}; restored store bundles in profile "${profileName}" (re-run scripts/sync-local-profile.sh to resume a dev build)`)
      return { restored: true, from, to: ownVersion }
    }

    // 6. Failure: drop pnpm's partials and put the dev state back.
    tryRm(scope, true)
    if (!tryRename(backup, scope)) return { restored: false, reason: 'plugin-add-failed' }
    log(`dsh-cc: dev-store restore failed (will retry on next launch; if the new dsh-cc version was just published, npm/pnpm's minimum-release-age window may still be hiding it)`)
    return { restored: false, reason: 'plugin-add-failed' }
  } catch (error) {
    log(`dsh-cc: dev-store restore failed unexpectedly: ${/** @type {Error} */ (error).message}`)
    // Roll back ONLY if the set-aside happened: removing the scope before
    // that point would destroy intact dev state over a transient error
    // (e.g. EACCES creating the lock) and brick the profile.
    if (setAside) tryRm(scope, true)
    if (existsSync(backup) && !existsSync(scope)) tryRename(backup, scope)
    return { restored: false, reason: 'error' }
  } finally {
    if (locked) tryRm(lock, false)
  }
}

// --- store heal: converge an existing profile after a launcher update --------

/** Marker file recording the launcher version that last installed the bundles. */
export const BOOTSTRAP_STAMP = '.dsh-cc-bootstrap.json'
/** Exclusive lock for the heal path (same freshness semantics as the restore lock). */
export const HEAL_LOCK = '.dsh-cc-heal.lock'

/**
 * Read the launcher version recorded by the last successful bundle install.
 * Missing/malformed stamp -> null (pre-heal profiles, i.e. every install made
 * before this mechanism existed) — that is a HEAL, not a skip: those profiles
 * carry whatever the first bootstrap pinned, forever.
 *
 * @param {string} stampPath
 * @returns {string | null}
 */
export function readBootstrapVersion(stampPath) {
  try {
    const value = JSON.parse(readFileSync(stampPath, 'utf8'))
    return typeof value.launcherVersion === 'string' && value.launcherVersion.length > 0
      ? value.launcherVersion
      : null
  } catch {
    return null
  }
}

/**
 * Decide whether an EXISTING profile needs its store bundles re-added at this
 * launcher's version. Skipped for dev pairings (channel `dev`, regardless of
 * version match): the registry `plugin add` here would clobber the
 * workspace-symlinked dev scope — dev convergence is `runStoreRestore`'s job
 * alone. The first-install path is separate (`bootstrapCommand`), so callers
 * must not heal on a launch that just bootstrapped.
 *
 * @param {{ profileExists: boolean, stampVersion: string | null, ownVersion: string, buildInfo?: Record<string, unknown> | null }} input
 * @returns {{ from: string } | null}
 */
export function healDecision({ profileExists, stampVersion, ownVersion, buildInfo = null }) {
  if (!profileExists) return null
  if (buildInfo?.channel === 'dev') return null
  if (stampVersion === ownVersion) return null
  return { from: stampVersion ?? 'unknown (pre-heal profile)' }
}

/**
 * Write the bootstrap stamp. A failure here is reported LOUDLY, not swallowed:
 * a launcher that heals but cannot record it re-runs a full network install on
 * every single launch — silent degradation is unacceptable.
 *
 * @param {string} stampPath
 * @param {string} ownVersion
 * @param {(...a: unknown[]) => void} [log]
 */
export function writeBootstrapStamp(stampPath, ownVersion, log = console.error) {
  try {
    writeFileSync(stampPath, `${JSON.stringify({ launcherVersion: ownVersion }, null, 2)}\n`)
  } catch (error) {
    log(`dsh-cc: CRITICAL: profile healed to ${ownVersion} but the stamp could not be written `
      + `(${/** @type {Error} */ (error).message}); the full plugin install will repeat on every launch until this is fixed`)
  }
}

/**
 * Re-run the bundle add against an existing profile (launcher update path).
 * `pnpm add` upserts the pinned ranges and `dsh plugin add` reconciles
 * `dsh.profile.bundles` idempotently — the same command surface the first
 * bootstrap and `runStoreRestore` rely on. A failed add warns and continues
 * launching (the stale stamp retries next launch); a failed stamp write is
 * loud (see writeBootstrapStamp).
 *
 * @param {string} profileDir
 * @param {string} ownVersion
 * @param {{ from?: string, spawnSyncImpl?: typeof import('node:child_process').spawnSync, log?: (...a: unknown[]) => void, now?: () => number }} [options]
 * @returns {{ healed: boolean, reason?: 'locked' | 'plugin-add-failed' }}
 */
export function runStoreHeal(profileDir, ownVersion, options = {}) {
  const { from, spawnSyncImpl = spawnSync, log = console.error, now = Date.now } = options
  const lock = join(profileDir, HEAL_LOCK)
  const stamp = join(profileDir, BOOTSTRAP_STAMP)
  const home = dirname(dirname(profileDir))
  const profileName = basename(profileDir)
  let locked = false

  try {
    // Exclusive create; a lock younger than ten minutes means another launch
    // is mid-heal — launch as-is rather than race pnpm on one profile dir.
    try {
      closeSync(openSync(lock, 'wx'))
      locked = true
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error
      let fresh = true
      try {
        fresh = now() - statSync(lock).mtimeMs < 10 * 60 * 1000
      } catch { /* lock vanished between EEXIST and stat: proceed */ }
      if (fresh) {
        log('dsh-cc: profile heal already in progress, skipping')
        return { healed: false, reason: 'locked' }
      }
      try {
        rmSync(lock, { force: true })
        closeSync(openSync(lock, 'wx'))
        locked = true
      } catch {
        log('dsh-cc: profile heal already in progress, skipping')
        return { healed: false, reason: 'locked' }
      }
    }

    const result = spawnSyncImpl('dsh', ['plugin', '--profile', profileName, 'add', ...BUNDLES.map(n => `${n}@${ownVersion}`)], {
      stdio: 'inherit',
      env: spawnEnv(sanitizeInheritedEnv(process.env), home),
    })
    const success = !result.error && result.status === 0
    if (!success) {
      log(`dsh-cc: profile heal to ${ownVersion} failed (will retry on next launch; if the new dsh-cc version was just published, npm/pnpm's minimum-release-age window may still be hiding it)`)
      return { healed: false, reason: 'plugin-add-failed' }
    }
    writeBootstrapStamp(stamp, ownVersion, log)
    log(`dsh-cc: launcher updated ${from ?? 'unknown'} → ${ownVersion}; re-installed store bundles in profile "${profileName}"`)
    return { healed: true }
  } catch (error) {
    log(`dsh-cc: profile heal failed unexpectedly: ${/** @type {Error} */ (error).message}`)
    return { healed: false, reason: 'plugin-add-failed' }
  } finally {
    if (locked) {
      try {
        rmSync(lock, { force: true })
      } catch { /* best-effort; a stale lock is taken over next launch */ }
    }
  }
}
