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
import type { PermissionRule } from './types.ts'

/** Whether an authored rule's tool name answers to a harness call's tool name. */
export function ruleMatchesTool(rule: PermissionRule, toolName: string): boolean {
  // The harness exec.name is lowercase; the rule preserves its authored CC
  // spelling, so compare through the CC↔harness alias map.
  return ccToolAliases(toolName).includes(rule.toolName)
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
