/**
 * Rule matching for post-edit auto-verify (design doc §3.2). Pure: given the
 * declared rules and an editing tool call, pick the first matching rule.
 *
 * Globs are Claude Code path patterns evaluated via {@link ccPathMatcher} —
 * the same matcher the skill provider uses for CC `paths` frontmatter —
 * against the call's `file_path` taken RELATIVE to the session cwd when the
 * path sits under it, else against the absolute path (matching how users
 * author CC path globs such as packages-pkg-star-ts patterns).
 *
 * @module
 */

import { isAbsolute, relative } from 'node:path'
import { ccPathMatcher } from '@dsh-cc/skill-loader'
import type { ToolExecution } from '@dsh-cc/tools'

/** One declared verify rule (config keys are kebab `timeout-ms`, mapped here). */
export interface VerifyRule {
  /** CC path glob over the edited path (star-star spans directories). */
  glob: string
  /** POSIX shell verification command. */
  command: string
  /** Per-rule timeout in ms (default 60 s at the runner seam). */
  timeoutMs?: number
}

/** Extract the edited path from an editing tool call's arguments, guarded. */
function editedPath(exec: ToolExecution): string | undefined {
  const args = exec.arguments as { file_path?: unknown }
  return typeof args?.file_path === 'string' && args.file_path.length > 0 ? args.file_path : undefined
}

/** Match the CC glob against the path relative to the session cwd when under it. */
function candidatePath(filePath: string, sessionCwd: string | undefined): string {
  if (sessionCwd === undefined) return filePath
  const base = isAbsolute(filePath) ? filePath : undefined
  if (base === undefined) return filePath
  const rel = relative(sessionCwd, filePath)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return filePath
  return rel
}

/**
 * First-match-wins rule selection (doc §3.2.3). Returns `undefined` when the
 * call has no usable `file_path` or no rule matches.
 * @param rules - declared rules, in authored order.
 * @param exec - the editing tool call.
 * @param sessionCwd - the session cwd (plain argument in Phase 0; the
 *   `getSessionCwd` seam is wired in a later phase). May be `undefined`.
 */
export function matchRule(
  rules: readonly VerifyRule[],
  exec: ToolExecution,
  sessionCwd: string | undefined,
): VerifyRule | undefined {
  const filePath = editedPath(exec)
  if (filePath === undefined) return undefined
  const candidate = candidatePath(filePath, sessionCwd)
  for (const rule of rules) {
    if (ccPathMatcher([rule.glob])(candidate)) return rule
  }
  return undefined
}
