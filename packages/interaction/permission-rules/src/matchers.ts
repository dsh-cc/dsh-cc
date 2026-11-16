/**
 * Pure rule-matching predicates extracted from PermissionRulesService.
 * Stateless on purpose: callers thread the configured `bashToolName` through,
 * so these stay trivially testable and free of service state.
 *
 * @module
 */
import { ccToolAliases, type ToolExecution } from '@dsh-cc/tools'
import { canonicalizeHostname } from './domain.ts'
import { contentMatches } from './parser.ts'
import { splitShellCommand } from './shell-segments.ts'
import type { PermissionRule } from './types.ts'

/** The model-facing MCP tool-name prefix; `mcp__<server>__<rawName>` names use it. */
const MCP_PREFIX = 'mcp__'

/** Whether an authored rule's tool name answers to a harness call's tool name. */
export function ruleMatchesTool(rule: PermissionRule, toolName: string): boolean {
  // The harness exec.name is lowercase; the rule preserves its authored CC
  // spelling, so compare through the CC↔harness alias map.
  if (ccToolAliases(toolName).includes(rule.toolName)) return true
  // Claude Code server-wide form: a content-less `mcp__<server>` rule covers
  // every `mcp__<server>__<rawName>` call on that server. Exact (three-segment)
  // MCP tool rules and every non-MCP rule keep exact-name semantics; content
  // rules are untouched (they only match a call subject, which MCP calls lack).
  return rule.content === undefined
    && isServerWideMcpRule(rule.toolName)
    && (toolName === rule.toolName || toolName.startsWith(`${rule.toolName}__`))
}

/**
 * Whether a tool name is the MCP server-wide form `mcp__<server>`: the MCP
 * prefix plus exactly one `__` segment separator. Sound as a discriminator
 * because the mcp-client namespace contract keeps both the server and the raw
 * tool segment `__`-free, so a three-segment name is always an exact tool name.
 * @param toolName - an authored rule tool name or a harness call name.
 * @returns true for the `mcp__<server>` form only.
 */
export function isServerWideMcpRule(toolName: string): boolean {
  if (!toolName.startsWith(MCP_PREFIX)) return false
  return toolName.split('__').length === 2
}

/** Whether a rule's tool name and content (when present) match a call. */
export function ruleMatches(rule: PermissionRule, toolName: string, subject: string): boolean {
  if (!ruleMatchesTool(rule, toolName)) return false
  if (rule.content === undefined || rule.matcher === undefined) return false
  return contentMatches(rule.matcher, subject)
}

/** Whether a harness call name counts as the configured bash tool. */
export function isBashToolName(name: string, bashToolName: string): boolean {
  return name === bashToolName || ccToolAliases(name).includes(bashToolName)
}

/** Extract the call subject for content matching (shell command or file path). */
export function subjectOf(exec: ToolExecution, bashToolName: string): string | undefined {
  const args = exec.arguments as Record<string, unknown>
  if (isBashToolName(exec.name, bashToolName) && typeof args.command === 'string') return args.command
  if (typeof args.file_path === 'string') return args.file_path
  // A WebFetch call's subject is its URL's canonical hostname (undefined for
  // an unparsable URL, so the call falls through to whole-tool matching).
  if (ccToolAliases(exec.name).includes('WebFetch') && typeof args.url === 'string') {
    return canonicalizeHostname(args.url)
  }
  return undefined
}

/** Bash bypass-immune guard helper (D2): any segment's raw OR subject matches; opaque ⇒ raw whole-subject fallback. */
export function ruleMatchesAnyShellSegment(rule: PermissionRule, toolName: string, subject: string): boolean {
  const result = splitShellCommand(subject)
  if (result.kind === 'opaque') return ruleMatches(rule, toolName, subject)
  return result.segments.some(segment =>
    ruleMatches(rule, toolName, segment.raw) || ruleMatches(rule, toolName, segment.subject))
}
