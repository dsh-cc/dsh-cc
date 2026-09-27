/**
 * Auto-mode rule suspension (design doc D1): in `auto` mode, broad allow
 * rules are dropped from the rule set AT EVALUATION TIME — statelessly, by a
 * pure filter over the merged set. Only `allow` is filtered; deny/ask/
 * bypassImmune lists are untouched. Pure and browser-safe: the only harness
 * import is the CC↔harness alias map.
 * @module @dsh-cc/permission-rules/auto-rule-filter
 */

import { ccToolAliases } from '@dsh-cc/tools'
import { hasUnescapedWildcard } from './parser.ts'
import { parseRuleSafe } from './subsumption.ts'
import type { PermissionRule, PermissionRuleSet, PermissionRuleSource } from './types.ts'

/** Whole-tool allow rules for these spellings are always suspended in auto. */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'subagent', 'subagent_fork'])

/** Interpreter launchers whose allow rules are suspended in auto (too broad). */
const INTERPRETER_TOKENS = new Set([
  'python', 'python3', 'node', 'nodejs', 'ruby', 'perl', 'php', 'deno', 'bun', 'pwsh', 'powershell',
])

/** Package-runner prefixes whose allow rules are suspended in auto. */
const PACKAGE_RUNNER = /^(npm run|npm exec|pnpm( run| exec| dlx)?|yarn( run)?|bun run|bunx|npx|uv run|pipx run)\b/

/**
 * Whether an authored rule's tool name governs the bash tool (via the CC↔
 * harness alias map on the rule's own spelling).
 */
function isBashRuleTool(toolName: string): boolean {
  return ccToolAliases(toolName).includes('Bash')
}

/** Whether an authored tool name is literally a PowerShell spelling. */
function isPowerShellRuleTool(toolName: string): boolean {
  return /^powershell$|^pwsh$/i.test(toolName)
}

/**
 * The literal text before the first unescaped `*` of a content matcher —
 * the effectively-fixed head of what the rule admits. A prefix matcher uses
 * its prefix; a wildcard matcher uses the pattern up to its first unescaped
 * `*` (the whole pattern when none).
 */
function matcherHead(rule: PermissionRule): string {
  if (rule.matcher?.kind === 'prefix') return rule.matcher.prefix
  const pattern = rule.matcher?.kind === 'wildcard' ? rule.matcher.pattern : (rule.content ?? '')
  if (!hasUnescapedWildcard(pattern)) return pattern
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] !== '*') continue
    let backslashes = 0
    for (let j = index - 1; j >= 0 && pattern[j] === '\\'; j -= 1) backslashes += 1
    if (backslashes % 2 === 0) return pattern.slice(0, index)
  }
  return pattern
}

/** The first whitespace-delimited token of a matcher head, colon-stripped, lowercased. */
function firstToken(head: string): string {
  return (head.trim().split(/\s+/)[0] ?? '').replace(/:$/, '').toLowerCase()
}

/** Whether one allow rule is suspended from the rule set under auto mode. */
function suspended(rule: PermissionRule, classifyAllShell: boolean): boolean {
  const bash = isBashRuleTool(rule.toolName)
  const shell = bash || isPowerShellRuleTool(rule.toolName)
  const subagent = SUBAGENT_TOOLS.has(rule.toolName)
    // Content rules for subagent spellings are matched through the same set.
    || (rule.content !== undefined && SUBAGENT_TOOLS.has(rule.toolName))
  if (classifyAllShell && shell) return true
  if (subagent) return true
  if (rule.content === undefined) return shell
  if (!shell) return false
  const head = matcherHead(rule)
  if (head.trim().length < 3) return true
  if (INTERPRETER_TOKENS.has(firstToken(head))) return true
  return PACKAGE_RUNNER.test(head.trim().toLowerCase())
}

/**
 * Why an allow rule is suspended from the rule set under auto mode (D6):
 * the cause categories of {@link suspended}, reported to the user when an
 * "always allow" write lands on a rule class auto mode will ignore.
 */
export type SuspensionCategory =
  | 'whole-tool'
  | 'short-head'
  | 'interpreter'
  | 'package-runner'
  | 'subagent'
  | 'classify-all-shell'

/**
 * The suspension cause of one allow rule under auto mode, in the precedence
 * `subagent` > `whole-tool` > `short-head` > `interpreter` >
 * `package-runner` > `classify-all-shell` — the last reported only when
 * `classifyAllShell` is on, the rule governs a shell tool, and no more
 * specific category applies. Undefined when the rule is not suspended.
 * @param rule - the parsed authored rule.
 * @param opts - `classifyAllShell` from the `autoMode` settings section.
 */
export function autoSuspendedReason(
  rule: PermissionRule,
  opts: { classifyAllShell: boolean },
): SuspensionCategory | undefined {
  const shell = isBashRuleTool(rule.toolName) || isPowerShellRuleTool(rule.toolName)
  if (SUBAGENT_TOOLS.has(rule.toolName)) return 'subagent'
  if (rule.content === undefined) {
    if (shell) return 'whole-tool'
  } else if (shell) {
    const head = matcherHead(rule)
    if (head.trim().length < 3) return 'short-head'
    if (INTERPRETER_TOKENS.has(firstToken(head))) return 'interpreter'
    if (PACKAGE_RUNNER.test(head.trim().toLowerCase())) return 'package-runner'
  }
  return opts.classifyAllShell && shell ? 'classify-all-shell' : undefined
}

/**
 * String-level convenience wrapper over {@link autoSuspendedReason} (D6):
 * parses `ruleText` with the tolerant parser (garbage ⇒ `undefined`, never a
 * throw). Settings-facing callers pass their live autoMode section so the
 * answer follows hot reloads.
 */
export function autoSuspensionReasonOf(
  ruleText: string,
  source: PermissionRuleSource,
  autoMode: { classifyAllShell?: boolean } | undefined,
): SuspensionCategory | undefined {
  const rule = parseRuleSafe(ruleText, 'allow', source)
  if (rule === undefined) return undefined
  return autoSuspendedReason(rule, { classifyAllShell: autoMode?.classifyAllShell === true })
}

/**
 * Drop auto-suspended rules from `allow` ONLY — deny/ask/bypassImmune pass
 * through unchanged. Suspended: whole-tool bash/PowerShell allows, effectively
 * blanket bash content allows (<3 fixed chars), interpreter/package-runner
 * first tokens, any Task/Agent/subagent/subagent_fork allow, and — when
 * `classifyAllShell` — every bash and PowerShell allow rule.
 * @param rules - the merged rule set.
 * @param opts - `classifyAllShell` from the `autoMode` settings section.
 * @returns the rule set with suspended allow rules removed.
 */
export function filterAutoAllowRules(
  rules: PermissionRuleSet,
  opts: { classifyAllShell: boolean },
): PermissionRuleSet {
  const classifyAllShell = opts.classifyAllShell
  return {
    allow: rules.allow.filter(rule => !suspended(rule, classifyAllShell)),
    deny: rules.deny,
    ask: rules.ask,
    bypassImmune: rules.bypassImmune,
  }
}
