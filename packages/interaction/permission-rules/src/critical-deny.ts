/**
 * C3 critical-bash denylist mounting: curated `CRITICAL_BASH_PATTERNS` plus
 * append-only settings `criticalDeny` sources, built as bypass-immune deny
 * rules (tool `Bash`, source label `curated`) so they flow through both the
 * config rule set and the monotonic guard layer.
 *
 * @module @dsh-cc/permission-rules/critical-deny
 */

import { CRITICAL_BASH_PATTERNS } from './classifier.ts'
import type { PermissionRule } from './types.ts'

/**
 * One curated critical-bash deny rule: a bypass-immune Bash deny with a regex
 * matcher, labelled `curated` (the deny reason shows `Bash(/<source>/) [curated]`).
 */
export function criticalDenyRule(source: string): PermissionRule {
  return {
    toolName: 'Bash',
    content: `/${source}/`,
    matcher: { kind: 'regex', source },
    behavior: 'deny',
    source: 'curated',
  }
}

/**
 * The curated critical-bash deny rules: built-in `CRITICAL_BASH_PATTERNS`
 * plus settings `criticalDeny` (APPEND-ONLY after the built-ins, never
 * replacing). Invalid settings regex sources are skipped with a debug log,
 * never thrown.
 */
export function criticalDenyRules(
  criticalDeny: readonly string[] | undefined,
  debug: (message: string) => void,
): readonly PermissionRule[] {
  const rules = CRITICAL_BASH_PATTERNS.map(pattern => criticalDenyRule(pattern.regex.source))
  for (const source of criticalDeny ?? []) {
    try {
      rules.push(criticalDenyRule(new RegExp(source).source))
    } catch {
      debug(`skipping invalid criticalDeny regex ${JSON.stringify(source)}`)
    }
  }
  return rules
}
