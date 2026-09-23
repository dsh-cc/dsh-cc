/**
 * Pure risk classifier for tool calls, a conservative port of Claude Code's
 * `dangerousPatterns` / `pathValidation` heuristics. High-risk shell commands
 * and protected/externally-scoped file writes escalate before the normal rule
 * waterfall. Pure functions — no Cordis/session coupling — mirroring the
 * {@link evaluatePermission} style, so hosts can classify a call directly.
 * @module @dsh-cc/permission-rules/classifier
 */

import { isAbsolute, relative, resolve } from 'node:path'

/** The severity a classifier assigns to one call. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH'

/** The outcome of classifying one call, with the reasons that raised it. */
export interface RiskAssessment {
  /** The raised risk level for the call. */
  level: RiskLevel
  /** Human-readable reasons for a non-`LOW` level; empty for `LOW`. */
  reasons: string[]
}

/** One curated dangerous-command pattern and the reason it is high risk. */
export interface DangerousPattern {
  readonly regex: RegExp
  readonly reason: string
}

/**
 * The curated conservative set of catastrophic shell command patterns. Matched
 * against a command string; any match raises the command to `HIGH`. Ports the
 * spirit of Claude Code's table, deliberately conservative (catastrophic only).
 */
export const DEFAULT_DANGEROUS_PATTERNS: readonly DangerousPattern[] = [
  { regex: /\brm\s+-[a-z]*[rf][a-z]*\s+(?:\/(?:\s|$)|~(?:\s|$|\/))/, reason: 'force/recursive remove of root or home' },
  { regex: /\bsudo\s+/i, reason: 'privilege escalation' },
  { regex: /\bchmod\s+[^\n]*\b777\b/, reason: 'world-writable permission change' },
  { regex: /\bdd\b[^\n]*\bof=\/dev\//, reason: 'write directly to a block device' },
  { regex: /\bmkfs(?:\.|$|\s)/, reason: 'create a file system (destructive)' },
  { regex: /\bshutdown\b|\breboot\b|\bhalt\b/, reason: 'system shutdown or reboot' },
  { regex: /\bkill\s+-9\s+1\b/, reason: 'kill PID 1 (system init)' },
  { regex: /\b(?:curl|wget)\b[^\n]*\|\s*(?:sh|bash)\b/i, reason: 'pipe a remote script into a shell' },
  { regex: /(?:^|[;&\n|\s])\s*\b(?:echo|printf|cat|tee)\b[^\n]*>\s*(?:\/etc\/|\/usr\/|\/bin\/)/, reason: 'redirect output into a system path' },
]

/**
 * The curated set of protected file paths — dotfiles, credential stores, and
 * sensitive config. Simple wildcard matching: `**` matches any depth, `*`
 * matches a single path segment. A match raises a file write to `HIGH`.
 */
export const DEFAULT_PROTECTED_FILES: readonly string[] = [
  '.gitconfig',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.bash_profile',
  '.zprofile',
  '.ssh/**',
  '.aws/**',
  '.netrc',
  '.git-credentials',
  '.mcp.json',
]

/**
 * The curated MEDIUM tier: destructive-but-not-catastrophic shell commands
 * (force-pushes, hard resets, force-recursive removes of ordinary targets,
 * package publishing, resource deletion). Matched only when no HIGH pattern
 * matched; any match raises the command to `MEDIUM`. When `mediumPatterns`
 * is given (raw regex sources, e.g. from `permissions.mediumPatterns`), they
 * replace the curated defaults.
 */
export const DEFAULT_MEDIUM_PATTERNS: readonly DangerousPattern[] = [
  { regex: /\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)/, reason: 'force-push history overwrite' },
  { regex: /\bgit\s+reset\b[^\n]*--hard\b/, reason: 'git reset --hard discards working-tree changes' },
  { regex: /\bgit\s+clean\b[^\n]*\s-[a-z]*f/i, reason: 'git clean -f removes untracked files' },
  { regex: /\brm\s+(?=(?:\S+\s+){0,4}-\w*r\w*)(?=(?:\S+\s+){0,4}-\w*f\w*)/, reason: 'force/recursive remove of a target (non-root/home)' },
  { regex: /\b(?:npm|pnpm|yarn)\s+publish\b/, reason: 'publishes a package to a registry' },
  { regex: /\bgh\s+(?:repo|release)\s+delete\b/, reason: 'deletes a GitHub repo or release' },
  { regex: /\bdocker\s+rm\b[^\n]*-\w*f/, reason: 'force-removes a container' },
  { regex: /\bdocker\s+system\s+prune\b/, reason: 'prunes docker system data' },
  { regex: /\bdocker\s+volume\s+(?:rm|prune)\b/, reason: 'removes or prunes docker volumes' },
  { regex: /\bkubectl\s+delete\b/, reason: 'deletes kubernetes resources' },
  { regex: /\bhelm\s+uninstall\b/, reason: 'uninstalls a helm release' },
  { regex: /\bterraform\s+(?:apply|destroy)\b/, reason: 'applies or destroys terraform infrastructure' },
]

/**
 * Classify a shell command by its riskiness, three levels: HIGH when any
 * dangerous pattern matches; otherwise MEDIUM when any medium pattern
 * matches; otherwise LOW. When `patterns` is given (raw regex sources, e.g.
 * from `permissions.dangerousPatterns`), they replace the curated HIGH
 * defaults; `mediumPatterns` (from `permissions.mediumPatterns`) likewise
 * replaces the curated MEDIUM tier.
 * @param command - the shell command string to classify.
 * @param patterns - optional raw regex sources to use instead of the HIGH defaults.
 * @param mediumPatterns - optional raw regex sources to use instead of the MEDIUM defaults.
 * @returns the assessment — HIGH/MEDIUM with the matching reasons, else LOW.
 */
export function assessBashCommand(command: string, patterns?: string[], mediumPatterns?: string[]): RiskAssessment {
  const highReasons = matchReasons(command, patterns ?? [], DEFAULT_DANGEROUS_PATTERNS)
  if (highReasons.length > 0) return { level: 'HIGH', reasons: highReasons }
  const mediumReasons = matchReasons(command, mediumPatterns ?? [], DEFAULT_MEDIUM_PATTERNS)
  if (mediumReasons.length > 0) return { level: 'MEDIUM', reasons: mediumReasons }
  return { level: 'LOW', reasons: [] }
}

/** Collect the reasons of every pattern (raw sources, falling back to curated) matching `command`. */
function matchReasons(command: string, sources: readonly string[], defaults: readonly DangerousPattern[]): string[] {
  const list: readonly DangerousPattern[] = sources.length > 0
    ? sources.map(pattern => ({ regex: compileSafe(pattern), reason: `command matches configured pattern ${JSON.stringify(pattern)}` }))
    : defaults
  const reasons: string[] = []
  for (const { regex, reason } of list) {
    regex.lastIndex = 0
    if (regex.test(command)) reasons.push(reason)
  }
  return reasons
}

/**
 * Classify the target path of a file write. HIGH when it matches a protected
 * file; MEDIUM when it resolves outside the working directory and its
 * additional directories (an escape from the permission scope); else LOW.
 * @param filePath - the target file path (absolute or relative).
 * @param opts - the working directory scope and classification overrides.
 * @returns the assessment with the matching reasons, or LOW.
 */
export function assessFilePath(
  filePath: string,
  opts: { cwd: string; additionalDirectories?: string[]; protectedFiles?: string[] },
): RiskAssessment {
  const protectedFiles = opts.protectedFiles ?? DEFAULT_PROTECTED_FILES
  if (protectedMatch(filePath, protectedFiles)) {
    return { level: 'HIGH', reasons: [`path matches a protected file pattern`] }
  }
  // A non-empty cwd enables the escape check; without one we cannot scope the
  // path and conservatively leave the escape determination at LOW.
  const scope = [opts.cwd, ...(opts.additionalDirectories ?? [])]
  if (opts.cwd !== '' && !inScope(resolve(opts.cwd, filePath), scope)) {
    return { level: 'MEDIUM', reasons: ['path resolves outside the permission scope'] }
  }
  return { level: 'LOW', reasons: [] }
}

/** Whether a path (or its basename) matches any protected wildcard pattern. */
function protectedMatch(filePath: string, protectedFiles: readonly string[]): boolean {
  const base = filePath.split('/').at(-1) ?? filePath
  const candidates = [
    filePath,
    filePath.replace(/^~\/?/, ''),
    base,
  ]
  for (const pattern of protectedFiles) {
    const regex = wildcardToRegExp(pattern)
    for (const candidate of candidates) {
      regex.lastIndex = 0
      if (regex.test(candidate)) return true
    }
  }
  return false
}

/** Translate a `**`/`*` wildcard pattern into a whole-string matcher. */
function wildcardToRegExp(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map(segment => (segment === '**' ? '.*' : segment === '*' ? '[^/]*' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${body}$`)
}

/** Whether `target` is at or under any of `dirs` (all pre-resolved absolute). */
function inScope(target: string, dirs: readonly string[]): boolean {
  return dirs.some(dir => {
    const rel = relative(dir, target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

/** Compile a raw pattern source into a RegExp, ignoring an invalid one. */
function compileSafe(source: string): RegExp {
  try {
    return new RegExp(source)
  } catch {
    // An invalid pattern must not crash classification; the defaults still run.
    return /(?!)/  // never matches
  }
}
