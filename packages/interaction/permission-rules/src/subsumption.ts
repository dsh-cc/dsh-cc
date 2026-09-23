/**
 * Conservative rule subsumption helpers, used by write-time dedup and the
 * `/permissions lint` surface. Pure string logic, browser-safe.
 *
 * Subsumption soundness: under per-source allow→deny→ask first-match
 * evaluation, deleting allow B covered by a same-source, same-behavior,
 * same-tool allow A is decision-preserving. Whole-tool rules never subsume
 * content rules — content rules evaluate before whole-tool rules, so
 * removing a content allow under a whole-tool allow can flip a decision.
 * @module @dsh-cc/permission-rules/subsumption
 */

import type { ContentMatcher, PermissionBehavior, PermissionRule, PermissionRuleSource } from './types.ts'
import { parseRuleString } from './parser.ts'

/**
 * Parsed rule-string shape: the tool name, plus content/matcher when the rule
 * carries content (whole-tool rules have neither).
 */
export type ParsedRuleShape = { toolName: string; content?: string; matcher?: ContentMatcher }

/**
 * Parse one rule string without throwing, for linting untrusted persisted
 * strings. Behavior/source are caller-supplied context, NOT derived from the
 * string.
 * @param rule - the rule string to parse.
 * @param behavior - the behavior to attribute to the rule.
 * @param source - the rule's provenance.
 * @returns the parsed rule, or `undefined` when the string is malformed.
 */
export function parseRuleSafe(
  rule: string,
  behavior: PermissionBehavior,
  source: PermissionRuleSource,
): PermissionRule | undefined {
  try {
    return { ...parseRuleString(rule), behavior, source } as PermissionRule
  } catch {
    return undefined
  }
}

/**
 * Whether content matcher A covers content matcher B, compared on unescaped
 * values (post-`unescapeRuleContent`, which `parseRuleString` already applies).
 * Conservative: prefix A subsumes prefix B iff B starts with A; equal wildcard
 * values subsume; equal domain values subsume; everything else false.
 * @param a - the (potentially) broader matcher.
 * @param b - the (potentially) narrower matcher.
 * @returns true when A subsumes B.
 */
export function contentSubsumes(a: ContentMatcher, b: ContentMatcher): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'prefix' && b.kind === 'prefix') return b.prefix.startsWith(a.prefix)
  if (a.kind === 'wildcard' && b.kind === 'wildcard') return a.pattern === b.pattern
  if (a.kind === 'domain' && b.kind === 'domain') return a.hostname === b.hostname
  return false
}

/**
 * Whether rule A subsumes rule B (B may be deleted without changing any
 * decision): equal behavior, equal source, exact-equal authored tool name
 * (alias-folding is a non-goal), both content rules, and content coverage.
 * @param a - the (potentially) broader rule.
 * @param b - the (potentially) narrower rule.
 * @returns true when A subsumes B.
 */
export function ruleSubsumes(a: PermissionRule, b: PermissionRule): boolean {
  return (
    a.behavior === b.behavior &&
    a.source === b.source &&
    a.toolName === b.toolName &&
    a.content !== undefined &&
    b.content !== undefined &&
    a.matcher !== undefined &&
    b.matcher !== undefined &&
    contentSubsumes(a.matcher, b.matcher)
  )
}
