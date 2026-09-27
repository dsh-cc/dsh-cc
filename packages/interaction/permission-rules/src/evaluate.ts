/**
 * Pure permission evaluation: given a tool call, a source-labelled rule set,
 * and a mode, fold the decision. The same function backs the plugin's
 * `tools/pre-execute` listener. Browser-safe.
 *
 * Order (D2, deny-first): bypass-immune deny → tool-wide deny → bypass
 * short-circuit → content deny (all sources) → tool-wide ask (sandboxed-bash
 * exempt) → content ask → content allow → mode rules (acceptEdits/plan/
 * bypass) → tool-wide allow → passthrough. Within the content phases,
 * behavior is outer (deny → ask → allow) and sources inner by priority, with
 * declaration order preserved within behavior+source. A final plan-mode wrap converts leftover
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
import { type SegmentResult, type ShellSegment } from './shell-segments.ts'
import { stripLeadingAssignments } from './shell-words.ts'
import { exemptShortHeadBoundaryOf } from './auto-rule-filter.ts'

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

  // (c) content deny, all sources: deny wins over any ask/allow (D2).
  for (const source of SOURCE_PRIORITY) {
    const matched = firstContentMatch(rules.deny, toolName, subject, source)
    if (matched !== undefined) return denyOf(matched)
  }

  // (b) whole-tool ask, except an exempted sandboxed bash (which allows instead).
  const toolAsk = firstToolLevel(rules.ask, toolName)
  if (toolAsk !== undefined) {
    if (ccToolAliases(toolName).includes('Bash') && input.sandboxedBashExempt === true) {
      return { kind: 'allow' }
    }
    return askOf(toolAsk)
  }

  // (d) content ask, then content allow — behavior outer (ask before allow),
  // sources inner by priority (D2).
  for (const source of SOURCE_PRIORITY) {
    const matched = firstContentMatch(rules.ask, toolName, subject, source)
    if (matched !== undefined) return askOf(matched)
  }
  for (const source of SOURCE_PRIORITY) {
    const matched = firstContentMatch(rules.allow, toolName, subject, source)
    if (matched !== undefined) return { kind: 'allow' }
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

/** The first whitespace-delimited token of a command string (D4 boundary). */
function commandToken(text: string): string {
  return text.trim().split(/\s+/)[0] ?? ''
}

/**
 * The bash-specific evaluation entry point (D2): folds the SAME global
 * waterfall, but the content phases run per top-level segment (`raw` OR
 * `subject` candidates) for segmented commands and fail-closed (content
 * allow skipped) for opaque ones. Returns the FINAL decision including the
 * plan-mode wrap, which applies ONCE here — `evaluatePermission` retains its
 * own wrap for its existing callers; `decide.ts` applies no second wrap.
 * @param input - the call, rule set, mode, and exemption flags.
 * @param result - the {@link splitShellCommand} output for the command.
 * @returns the final decision.
 */
export function evaluateShell(input: EvaluationInput, result: SegmentResult): PermissionDecision {
  const effectiveMode: EvaluationInput['mode'] =
    (input.bypassDisabled ?? false) && input.mode === 'bypassPermissions' ? 'default' : input.mode
  const decision = result.kind === 'segments'
    ? foldSegmented(input, effectiveMode, input.toolName, result.segments, input.rules)
    : foldOpaque(input, effectiveMode, input.toolName, input.subject, input.rules)
  // Plan is read-only: leftover ask/passthrough on a mutating call become a
  // deny pointing at exit_plan_mode. Allow (including a matching allow rule)
  // and deny (including deny rules) stand.
  if (effectiveMode === 'plan' && input.isReadOnly !== true
    && (decision.kind === 'ask' || decision.kind === 'passthrough')) {
    return { kind: 'deny', reason: PLAN_READONLY_REASON }
  }
  return decision
}

/** The segmented waterfall: content phases loop over segments (D2). */
function foldSegmented(
  input: EvaluationInput,
  effectiveMode: EvaluationInput['mode'],
  toolName: string,
  segments: readonly ShellSegment[],
  rules: PermissionRuleSet,
): PermissionDecision {
  const immuneDeny = firstSegmentMatch(rules.bypassImmune, toolName, segments)
  if (immuneDeny !== undefined) return denyOf(immuneDeny)
  const toolDeny = firstToolLevel(rules.deny, toolName)
  if (toolDeny !== undefined) return denyOf(toolDeny)
  if (effectiveMode === 'bypassPermissions') return { kind: 'allow' }
  for (const source of SOURCE_PRIORITY) {
    const matched = firstSegmentMatch(rules.deny, toolName, segments, source)
    if (matched !== undefined) return denyOf(matched)
  }
  const toolAsk = firstToolLevel(rules.ask, toolName)
  if (toolAsk !== undefined) {
    if (ccToolAliases(toolName).includes('Bash') && input.sandboxedBashExempt === true) {
      return { kind: 'allow' }
    }
    return askOf(toolAsk)
  }
  for (const source of SOURCE_PRIORITY) {
    const matched = firstSegmentMatch(rules.ask, toolName, segments, source)
    if (matched !== undefined) return askOf(matched)
  }
  // Content allow: EVERY segment must be admissible (deny/ask already had
  // their segment-wide shot above; taint never allow-matches).
  for (const source of SOURCE_PRIORITY) {
    if (allSegmentsAdmissible(rules.allow, toolName, segments, source)) return { kind: 'allow' }
  }
  if (effectiveMode === 'acceptEdits' && input.isFileEdit === true) {
    return { kind: 'allow' }
  }
  if (effectiveMode === 'plan' && input.isReadOnly === true) {
    return { kind: 'allow' }
  }
  const toolAllow = firstToolLevel(rules.allow, toolName)
  if (toolAllow !== undefined) return { kind: 'allow' }
  return { kind: 'passthrough' }
}

/**
 * The opaque waterfall (D2): the command's structure is unknown, so matching
 * runs on the raw whole subject and content allow is skipped entirely —
 * prefix approval must never launder heredocs, substitutions, subshells,
 * group syntax, or control flow.
 */
function foldOpaque(
  input: EvaluationInput,
  effectiveMode: EvaluationInput['mode'],
  toolName: string,
  subject: string | undefined,
  rules: PermissionRuleSet,
): PermissionDecision {
  const immuneDeny = firstBypassImmune(rules.bypassImmune, toolName, subject)
  if (immuneDeny !== undefined) return denyOf(immuneDeny)
  const toolDeny = firstToolLevel(rules.deny, toolName)
  if (toolDeny !== undefined) return denyOf(toolDeny)
  if (effectiveMode === 'bypassPermissions') return { kind: 'allow' }
  for (const source of SOURCE_PRIORITY) {
    const matched = firstContentMatch(rules.deny, toolName, subject, source)
    if (matched !== undefined) return denyOf(matched)
  }
  const toolAsk = firstToolLevel(rules.ask, toolName)
  if (toolAsk !== undefined) {
    if (ccToolAliases(toolName).includes('Bash') && input.sandboxedBashExempt === true) {
      return { kind: 'allow' }
    }
    return askOf(toolAsk)
  }
  for (const source of SOURCE_PRIORITY) {
    const matched = firstContentMatch(rules.ask, toolName, subject, source)
    if (matched !== undefined) return askOf(matched)
  }
  // Content allow skipped (fail-closed, R12).
  if (effectiveMode === 'acceptEdits' && input.isFileEdit === true) {
    return { kind: 'allow' }
  }
  if (effectiveMode === 'plan' && input.isReadOnly === true) {
    return { kind: 'allow' }
  }
  const toolAllow = firstToolLevel(rules.allow, toolName)
  if (toolAllow !== undefined) return { kind: 'allow' }
  return { kind: 'passthrough' }
}

/**
 * The first rule in `list` whose `raw` OR `subject` matches any segment —
 * source outer, then segment order, then rule declaration order.
 */
function firstSegmentMatch(
  list: readonly PermissionRule[],
  toolName: string,
  segments: readonly ShellSegment[],
  source?: PermissionRule['source'],
): PermissionRule | undefined {
  for (const segment of segments) {
    for (const rule of list) {
      if (source !== undefined && rule.source !== source) continue
      if (rule.content === undefined || rule.matcher === undefined) continue
      if (!ruleMatchesTool(rule, toolName)) continue
      if (contentMatches(rule.matcher, segment.raw) || contentMatches(rule.matcher, segment.subject)) return rule
    }
  }
  return undefined
}

/**
 * The one content-allow rule (in `source`) that admits `segment`, or
 * undefined. Matching policy per D2 phase 7:
 * - tainted segments are never admissible;
 * - assignment-only segments match on `raw` only; an assignment-only rule
 *   (`Bash(FOO=1)`) matches verbatim only (R16);
 * - assignment-bearing segments match on `raw` ONLY (assignments define the
 *   launch environment); a literal-prefix rule with an assignment-headed
 *   content additionally enforces the executable-token boundary (R15);
 * - plain segments match their text; an exempted safe short-head rule
 *   additionally enforces the token boundary (D4/R10).
 */
function matchAllowForSegment(
  list: readonly PermissionRule[],
  toolName: string,
  segment: ShellSegment,
  source: PermissionRule['source'],
): PermissionRule | undefined {
  if (segment.tainted) return undefined
  const boundaryToken = segment.first
  for (const rule of list) {
    if (rule.source !== source) continue
    if (rule.content === undefined || rule.matcher === undefined) continue
    if (!ruleMatchesTool(rule, toolName)) continue
    if (segment.assignmentOnly || segment.subject !== segment.raw) {
      // Assignment-leading segments (including assignment-only ones) are
      // allow-matched against `raw` ONLY — never the stripped subject.
      if (!contentMatches(rule.matcher, segment.raw)) continue
      if (rule.matcher.kind !== 'prefix') return rule
      const headExecutable = commandToken(stripLeadingAssignments(rule.matcher.prefix))
      if (segment.assignmentOnly && stripLeadingAssignments(rule.matcher.prefix).trim() === '') {
        // Assignment-only rule: verbatim equality, never prefix (R16).
        if (segment.raw !== rule.matcher.prefix) continue
        return rule
      }
      if (rule.matcher.prefix !== stripLeadingAssignments(rule.matcher.prefix)
        && commandToken(stripLeadingAssignments(segment.raw)) !== headExecutable) continue
      return rule
    }
    // Plain segment: matched on its (raw === subject) text.
    if (!contentMatches(rule.matcher, segment.raw)) continue
    const safeHead = exemptShortHeadBoundaryOf(rule)
    if (safeHead !== undefined && boundaryToken !== safeHead) continue
    return rule
  }
  return undefined
}

/** Whether EVERY segment finds an admissible allow rule at one source. */
function allSegmentsAdmissible(
  list: readonly PermissionRule[],
  toolName: string,
  segments: readonly ShellSegment[],
  source: PermissionRule['source'],
): boolean {
  if (segments.length === 0) return false
  for (const segment of segments) {
    if (matchAllowForSegment(list, toolName, segment, source) === undefined) return false
  }
  return true
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
