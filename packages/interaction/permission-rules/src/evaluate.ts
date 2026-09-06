/**
 * Pure permission evaluation: given a tool call, a source-labelled rule set,
 * and a mode, fold the decision. The same function backs the plugin's
 * `tools/pre-execute` listener and the host UI's rule preview. Browser-safe.
 *
 * Order (spec): tool-wide deny → tool-wide ask (sandboxed-bash exempt) →
 * source-priority content rules → mode rules (acceptEdits/plan/bypass) →
 * whole-tool allow → passthrough. A final plan-mode wrap converts leftover
 * `ask`/`passthrough` on a non-read-only call into a deny (allow and deny
 * decisions stand). Bypass-immune rules are evaluated first and always deny;
 * the plugin additionally enforces them through the monotonic guard layer.
 * @module @dsh-cc/permission-rules/evaluate
 */

import { ccToolAliases } from '@dsh-cc/tools'
import {
  PLAN_READONLY_REASON,
  SOURCE_PRIORITY,
  type EvaluationInput,
  type PermissionDecision,
  type PermissionRule,
  type PermissionRuleSet,
  type PermissionRuleSource,
} from './types.ts'
import { contentMatches } from './parser.ts'

/**
 * Merge several rule sets into one, consulting rules by source priority. On a
 * tie (same source), earlier rule-set entries win (earlier sets are treated as
 * higher within a source). The result preserves each rule's original source
 * for later priority decisions.
 * @param sets - rule sets ordered from highest to lowest priority within each source.
 * @returns a single merged rule set.
 */
export function mergeRuleSets(...sets: readonly PermissionRuleSet[]): PermissionRuleSet {
  return {
    allow: mergeByPriority(sets.map(set => set.allow)),
    deny: mergeByPriority(sets.map(set => set.deny)),
    ask: mergeByPriority(sets.map(set => set.ask)),
    bypassImmune: mergeByPriority(sets.map(set => set.bypassImmune)),
  }
}

/** Concatenate each behavior's lists, then stable-sort by source priority (high first). */
function mergeByPriority(lists: readonly (readonly PermissionRule[])[]): readonly PermissionRule[] {
  const flat = lists.flat()
  return flat.slice().sort((a, b) => rankOf(a.source) - rankOf(b.source))
}

/** The numeric rank of a source in {@link SOURCE_PRIORITY} (lower rank = higher priority). */
function rankOf(source: PermissionRuleSource): number {
  const index = SOURCE_PRIORITY.indexOf(source)
  return index === -1 ? SOURCE_PRIORITY.length : index
}

/**
 * Fold the decision for one call. Pure: every mode/exemption input is passed
 * in so hosts can resolve them (from plan state, shell sandbox, tool sets)
 * themselves or let the plugin do so.
 * @param input - the call, rule set, mode, and exemption flags.
 * @returns the decision; `passthrough` means no rule matched and mode allowed.
 */
export function evaluatePermission(input: EvaluationInput): PermissionDecision {
  const { toolName, subject, rules, mode } = input
  const effectiveMode: EvaluationInput['mode'] =
    (input.bypassDisabled ?? false) && mode === 'bypassPermissions' ? 'default' : mode
  const decision = foldDecision(input, effectiveMode, toolName, subject, rules)
  // Plan is read-only: leftover ask/passthrough on a mutating call become a
  // deny pointing at exit_plan_mode. Allow (including a matching allow rule)
  // and deny (including deny rules) stand.
  if (effectiveMode === 'plan' && input.isReadOnly !== true
    && (decision.kind === 'ask' || decision.kind === 'passthrough')) {
    return { kind: 'deny', reason: PLAN_READONLY_REASON }
  }
  return decision
}

/** The inner waterfall, before the plan-mode wrap. */
function foldDecision(
  input: EvaluationInput,
  effectiveMode: EvaluationInput['mode'],
  toolName: string,
  subject: string | undefined,
  rules: PermissionRuleSet,
): PermissionDecision {
  // Bypass-immune content rules always deny, regardless of mode — including
  // bypassPermissions. The plugin also enforces these through the guard layer
  // so a later (non-waterfall) override cannot flip the denial.
  const immuneDeny = firstBypassImmune(rules.bypassImmune, toolName, subject)
  if (immuneDeny !== undefined) {
    return denyOf(immuneDeny)
  }

  // (a) whole-tool deny beats everything except bypass-immune.
  const toolDeny = firstToolLevel(rules.deny, toolName)
  if (toolDeny !== undefined) {
    return denyOf(toolDeny)
  }

  // (e) bypassPermissions allows everything once a mode-level override applies.
  if (effectiveMode === 'bypassPermissions') {
    return { kind: 'allow' }
  }

  // (b) whole-tool ask, except an exempted sandboxed bash (which allows instead).
  const toolAsk = firstToolLevel(rules.ask, toolName)
  if (toolAsk !== undefined) {
    if (ccToolAliases(toolName).includes('Bash') && input.sandboxedBashExempt === true) {
      return { kind: 'allow' }
    }
    return askOf(toolAsk)
  }

  // (c) content-level allow/deny/ask by source priority. The first matching
  // rule across all three behaviors (in source-priority order) decides.
  for (const source of SOURCE_PRIORITY) {
    for (const behavior of ['allow', 'deny', 'ask'] as const) {
      const matched = firstContentMatch(rules[behavior], toolName, subject, source)
      if (matched !== undefined) return decisionOf(behavior, matched)
    }
  }

  // (e) acceptEdits auto-allows file-edit calls; plan auto-allows read-only calls.
  if (effectiveMode === 'acceptEdits' && input.isFileEdit === true) {
    return { kind: 'allow' }
  }
  if (effectiveMode === 'plan' && input.isReadOnly === true) {
    return { kind: 'allow' }
  }

  // A whole-tool allow is the coarse default for that tool: no more-specific
  // deny/ask matched, so a bare `Bash` allow admits the call.
  const toolAllow = firstToolLevel(rules.allow, toolName)
  if (toolAllow !== undefined) {
    return { kind: 'allow' }
  }

  // (f) nothing matched — delegate downstream (ultimately the approval seam).
  return { kind: 'passthrough' }
}

/** The first whole-tool rule for `toolName` in a behavior list. */
function firstToolLevel(list: readonly PermissionRule[], toolName: string): PermissionRule | undefined {
  return list.find(rule => rule.content === undefined && ruleMatchesTool(rule, toolName))
}

/** Whether an authored rule's tool name answers to the harness call's tool name. */
function ruleMatchesTool(rule: PermissionRule, toolName: string): boolean {
  // The harness exec.name is lowercase; the rule preserves its authored CC
  // spelling, so compare through the CC↔harness alias map.
  return ccToolAliases(toolName).includes(rule.toolName)
}

/** The first content rule for `toolName`/`subject` at exactly one source, or undefined. */
function firstContentMatch(
  list: readonly PermissionRule[],
  toolName: string,
  subject: string | undefined,
  source: PermissionRule['source'],
): PermissionRule | undefined {
  if (subject === undefined) return undefined
  for (const rule of list) {
    if (rule.source !== source) continue
    if (rule.content === undefined || rule.matcher === undefined) continue
    if (ruleMatchesTool(rule, toolName) && contentMatches(rule.matcher, subject)) return rule
  }
  return undefined
}

/**
 * The first bypass-immune content rule matching `toolName`/`subject`; bypass-
 * immune rules deny regardless of source priority or mode.
 */
function firstBypassImmune(
  list: readonly PermissionRule[],
  toolName: string,
  subject: string | undefined,
): PermissionRule | undefined {
  if (subject === undefined) return undefined
  for (const rule of list) {
    if (rule.content === undefined || rule.matcher === undefined) continue
    if (!ruleMatchesTool(rule, toolName)) continue
    if (contentMatches(rule.matcher, subject)) return rule
  }
  return undefined
}

/** Map a matched rule's behavior to a decision. */
function decisionOf(behavior: 'allow' | 'deny' | 'ask', match: PermissionRule): PermissionDecision {
  if (behavior === 'allow') return { kind: 'allow' }
  if (behavior === 'deny') return denyOf(match)
  return askOf(match)
}

/** Deny decision for a matched rule. */
function denyOf(match: PermissionRule): PermissionDecision {
  return { kind: 'deny', reason: `denied by permission rule ${ruleLabel(match)}` }
}

/** Ask decision for a matched rule. */
function askOf(match: PermissionRule): { kind: 'ask'; reason: string } {
  return { kind: 'ask', reason: `requires approval by permission rule ${ruleLabel(match)}` }
}

/** Human-readable rule label including its source. */
function ruleLabel(match: PermissionRule): string {
  const content = match.content === undefined ? '' : `(${match.content})`
  return `${match.toolName}${content} [${match.source}]`
}
