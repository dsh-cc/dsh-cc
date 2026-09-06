/**
 * Pure `/permissions` rendering: aggregate a permission rule set into counts
 * per source and behavior. READ-ONLY — no mode switch is performed here.
 * @module @dsh-cc/command-permissions/permissions
 */

import {
  SOURCE_PRIORITY,
  type PermissionRule,
  type PermissionRuleSet,
} from '@dsh-cc/permission-rules/types'

/** Aggregated counts for one rule source. */
export interface SourceCounts {
  allow: number
  deny: number
  ask: number
  bypassImmune: number
}

/** A totals row across all sources. */
export interface Totals {
  allow: number
  deny: number
  ask: number
  bypassImmune: number
}

/** Count how many rules of one source fall into each behavior. */
function countsFor(source: string, rules: readonly PermissionRule[]): SourceCounts {
  const out: SourceCounts = { allow: 0, deny: 0, ask: 0, bypassImmune: 0 }
  for (const rule of rules) {
    if (rule.source !== source) continue
    if (rule.behavior === 'allow') out.allow += 1
    else if (rule.behavior === 'deny') out.deny += 1
    else if (rule.behavior === 'ask') out.ask += 1
  }
  return out
}

/** Sum a per-source aggregate into a grand total. */
function addTotals(total: Totals, counts: SourceCounts): void {
  total.allow += counts.allow
  total.deny += counts.deny
  total.ask += counts.ask
}

/**
 * Render the effective permission rule state from a rule set.
 * @param rules - the merged rule set (the engine's `ruleSet`).
 * @param bypassImmune - bypass-immune rule count (deny, guard-enforced).
 * @returns a read-only report of rule counts per source and in total.
 */
export function renderPermissions(rules: PermissionRuleSet, bypassImmune: number): string {
  const lines = ['Permission rules (read-only)']
  const total: Totals = { allow: 0, deny: 0, ask: 0, bypassImmune }
  let any = false
  for (const source of SOURCE_PRIORITY) {
    const counts = countsFor(source, [...rules.allow, ...rules.deny, ...rules.ask])
    if (counts.allow === 0 && counts.deny === 0 && counts.ask === 0) continue
    any = true
    addTotals(total, counts)
    lines.push(`  ${source}: allow=${counts.allow} deny=${counts.deny} ask=${counts.ask}`)
  }
  if (!any) lines.push('  (no rules configured)')
  lines.push(`Total: allow=${total.allow} deny=${total.deny} ask=${total.ask} (bypassImmune=${bypassImmune})`)
  return lines.join('\n')
}
