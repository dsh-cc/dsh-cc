/**
 * Task-grant matching (design §3.4): what one grant admits. Pure — every
 * host fact (branch, file-edit tool set, bash tool name) is threaded in, so
 * the matcher is directly testable.
 *
 * Bash commands reuse the shell evaluator's allow-segment path verbatim
 * (`grantAdmitsSegment`: assignment-bearing segments match raw only, tainted
 * segments are never admissible, opaque syntax fails closed) plus the grant
 * token boundary. `git push` never takes the bare-prefix path: it is matched
 * by argv structure (exactly `<remote> <refspec>`, same-branch refspec, no
 * non-fast-forward flags).
 *
 * @module @dsh-cc/permission-rules/task-grant-match
 */

import { resolve } from 'node:path'
import type { ToolExecution } from '@dsh-cc/tools'
import { grantAdmitsSegment } from './evaluate.ts'
import { isBashToolName, ruleMatchesTool } from './matchers.ts'
import { parseRule } from './parser.ts'
import { splitShellCommand, type ShellSegment } from './shell-segments.ts'
import { parseTaskGrantGitInvocation } from './task-grant-git.ts'
import {
  TASK_GRANT_RULE_SOURCE,
  isPathWithin,
  normalizePath,
  writePathBase,
  type TaskGrant,
} from './task-grant.ts'
import type { PermissionRule } from './types.ts'
import { isCanonicalVwaStateWrite } from './vwa-state.ts'

/** The per-call host facts the matcher needs. */
export interface GrantMatchContext {
  bashToolName: string
  fileEditTools: ReadonlySet<string>
}

/** The grant's rules parsed once, in the grant source (user-authored precedence). */
export function grantRules(grant: TaskGrant): PermissionRule[] {
  return grant.rules.map(raw => parseRule(raw, 'allow', TASK_GRANT_RULE_SOURCE))
}

/** The whitespace tokens of one shell segment's stripped subject. */
function segmentTokens(segment: ShellSegment): string[] {
  return segment.subject.trim().split(/\s+/).filter(token => token !== '')
}

/** Whether the rule list grants the `git push` prefix at all (structure still has to match). */
function grantsPushPrefix(rules: readonly PermissionRule[], toolName: string): boolean {
  return rules.some(rule => {
    if (rule.matcher?.kind !== 'prefix') return false
    if (!ruleMatchesTool(rule, toolName)) return false
    const tokens = (rule.content ?? '').trim().split(/\s+/)
    return tokens.length === 2 && tokens[0] === 'git' && tokens[1] === 'push'
  })
}

/**
 * Structured push admission (§3.4): exactly `git push origin <refspec>`, the
 * refspec's target equal to the grant branch (`<branch>` or
 * `<branch>:<branch>`), no flags anywhere (so `--force`/`-f` never match), no
 * quoting (argv structure is unknown with quotes). The remote is PINNED to
 * `origin` — the contentScope push check reads `origin/<branch>..HEAD`, so an
 * arbitrary remote would exfiltrate the branch past the md-only check. A
 * `git -C <dir> push ...` shape never matches — it is not the structured form.
 */
function structuredPushAdmits(
  rules: readonly PermissionRule[],
  toolName: string,
  segment: ShellSegment,
  branch: string | null,
): boolean {
  if (branch === null || segment.tainted) return false
  // Assignments define the launch environment; push structure is judged on the
  // stripped subject only when it equals raw (no assignment prefix).
  if (segment.subject !== segment.raw) return false
  if (/['"`\\]/.test(segment.subject)) return false
  const tokens = segmentTokens(segment)
  if (tokens.length !== 4) return false
  if (tokens[0] !== 'git' || tokens[1] !== 'push') return false
  const remote = tokens[2] as string
  const refspec = tokens[3] as string
  if (remote !== 'origin') return false
  if (refspec.startsWith('-')) return false
  if (refspec !== branch && refspec !== `${branch}:${branch}`) return false
  return grantsPushPrefix(rules, toolName)
}

/** Whether one segment is admitted by the grant (structured push or the shell-segment path). */
function segmentAdmitted(
  rules: readonly PermissionRule[],
  toolName: string,
  segment: ShellSegment,
  branch: string | null,
): boolean {
  if (segment.tainted) return false
  const git = parseTaskGrantGitInvocation(segment)
  if (git.kind === 'unsupported') return false
  if (git.kind === 'git' && git.subcommand === 'push') return structuredPushAdmits(rules, toolName, segment, branch)
  return grantAdmitsSegment(rules, toolName, segment, TASK_GRANT_RULE_SOURCE) !== undefined
}

/**
 * Whether the grant admits a bash command: EVERY top-level segment must be
 * admitted by some grant rule; opaque syntax (quotes, heredocs, subshells,
 * groups, reserved words) never matches.
 */
export function grantAdmitsCommand(grant: TaskGrant, command: string, bashToolName: string): boolean {
  const result = splitShellCommand(command)
  if (result.kind !== 'segments' || result.segments.length === 0) return false
  const rules = grantRules(grant)
  return result.segments.every(segment => segmentAdmitted(rules, bashToolName, segment, grant.branch))
}

/** Whether the grant lists the tool exactly, or through a `prefix.*` entry. */
export function grantAdmitsTool(grant: TaskGrant, toolName: string): boolean {
  return grant.tools.some(entry => {
    if (entry === toolName) return true
    if (!entry.endsWith('.*')) return false
    const prefix = entry.slice(0, -2)
    return toolName.startsWith(`${prefix}.`)
  })
}

/**
 * Whether the grant admits a write target: canonical targets and grant prefixes
 * must stay inside the canonical workspace root. Authoritative VWA state never
 * matches, even through a broad prefix or a symlink retargeted since approval.
 * Prefixes and targets are resolved on every call before separator-aware matching.
 */
export function grantAdmitsWritePath(grant: TaskGrant, target: string): boolean {
  const normalizedRoot = normalizePath(grant.root)
  const normalizedTarget = normalizePath(resolve(grant.root, target))
  if (!isPathWithin(normalizedRoot, normalizedTarget)) return false
  if (isCanonicalVwaStateWrite(normalizedTarget, normalizedRoot)) return false
  return grant.writePaths.some(writePath => {
    const base = writePathBase(grant.root, writePath)
    return isPathWithin(normalizedRoot, base) && isPathWithin(base, normalizedTarget)
  })
}

/** The write target of a file-writing call (`file_path`, else `notebook_path`). */
function writeTargetOf(exec: ToolExecution): string | undefined {
  const args = exec.arguments as Record<string, unknown>
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.notebook_path === 'string') return args.notebook_path
  return undefined
}

/**
 * Whether this call is a task-grant hit — a deterministic allow, no LLM
 * arbitration. Bash → segment/push matching; Edit/Write/NotebookEdit → write
 * target under a granted writePath; every other tool (VWA/MCP) → tool list.
 * @param grant - the live grant to test.
 * @param exec - the call.
 * @param context - the host tool sets.
 * @returns true when the grant admits the call.
 */
export function grantAdmitsExec(grant: TaskGrant, exec: ToolExecution, context: GrantMatchContext): boolean {
  if (isBashToolName(exec.name, context.bashToolName)) {
    const command = (exec.arguments as Record<string, unknown>).command
    return typeof command === 'string' && grantAdmitsCommand(grant, command, context.bashToolName)
  }
  if (context.fileEditTools.has(exec.name)) {
    const target = writeTargetOf(exec)
    return target !== undefined && grantAdmitsWritePath(grant, target)
  }
  return grantAdmitsTool(grant, exec.name)
}
