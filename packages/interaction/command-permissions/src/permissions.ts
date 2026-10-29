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
import type { TaskGrant } from '@dsh-cc/permission-rules'

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
 * @param opts - when `suspendedAllow` > 0 (auto mode only), annotate the
 *   count of allow rules suspended at evaluation time (design doc D1).
 * @returns a read-only report of rule counts per source and in total.
 */
export function renderPermissions(rules: PermissionRuleSet, bypassImmune: number, opts: { suspendedAllow?: number } = {}): string {
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
  const suspended = opts.suspendedAllow ?? 0
  if (suspended > 0) lines.push(`Total: ${suspended} allow rule(s) suspended in auto mode`)
  return lines.join('\n')
}

/**
 * Render the COMPLETE post-derivation approval view of a task grant (design
 * §3.3): every rule, every writePath line, the expiry conditions, the sandbox
 * escalation flag and the contentScope. `danger-full-access` and an explicit
 * `any` contentScope are highlighted — those are the trust-bearing wideners.
 * @param grant - the derived grant the user is confirming.
 * @param opts - `confirmed` switches the trailing line to the created state.
 * @returns the multi-line view.
 */
export function renderGrantView(
  grant: TaskGrant,
  opts: { confirmed: boolean; descriptorPath?: string } = { confirmed: false },
): string {
  const lines: string[] = []
  lines.push(opts.confirmed ? 'Task grant created' : 'Task grant — review and confirm')
  lines.push(`  id:        ${opts.confirmed ? grant.grantId : '(assigned on confirmation)'}`)
  lines.push(`  root:      ${grant.root}`)
  lines.push(`  branch:    ${grant.branch ?? '(no git branch)'}`)
  lines.push(`  createdBy: ${grant.createdBy}`)
  lines.push(`  created:   ${grant.ts}`)
  lines.push(`  expires:   ${expiryText(grant)}`)
  lines.push(`  rules (${grant.rules.length}):`)
  for (const rule of grant.rules) lines.push(`    ${rule}`)
  if (grant.rules.length === 0) lines.push('    (none)')
  lines.push(`  tools (${grant.tools.length}):`)
  for (const tool of grant.tools) lines.push(`    ${tool}`)
  if (grant.tools.length === 0) lines.push('    (none)')
  lines.push(`  writePaths (${grant.writePaths.length}):`)
  for (const path of grant.writePaths) lines.push(`    ${path}`)
  if (grant.writePaths.length === 0) lines.push('    (none)')
  lines.push(`  sandboxEscalation: ${grant.sandboxEscalation ? 'YES (auto-approves registered escalations within the checks)' : 'no'}`)
  lines.push(`  modeCeiling: ${grant.modeCeiling}${grant.modeCeiling === 'danger-full-access' ? '  ** DANGER: full sandbox access **' : ''}`)
  lines.push(`  contentScope: ${grant.contentScope}${grant.contentScope === 'any' ? '  ** WARNING: no markdown-only check **' : ' (tracked .md/.mdx only)'}`)
  if (!opts.confirmed) {
    lines.push('')
    const target = opts.descriptorPath ?? '<descriptorPath>'
    lines.push(`Nothing is granted yet. Re-run \`/permissions grant ${target} --confirm\` to approve the grant above.`)
  }
  return lines.join('\n')
}

/** One-line expiry description. */
function expiryText(grant: TaskGrant): string {
  const expiry = grant.expires
  if (expiry.kind === 'goal-complete') return `goal-complete (goal ${expiry.goalId})`
  if (expiry.kind === 'manual') return 'manual (/permissions revoke)'
  return 'session-end (this session only; a new session needs a fresh grant)'
}

/**
 * Render the live task grants of a session (§3.3 `/permissions grants`).
 * @param grants - the session's live grants.
 * @returns the list, or a one-liner when none are live.
 */
export function renderGrantList(grants: readonly TaskGrant[]): string {
  if (grants.length === 0) return 'No task grants are active in this session.'
  const lines = [`Task grants (${grants.length})`]
  for (const grant of grants) {
    lines.push(`  ${grant.grantId}`)
    lines.push(`    branch=${grant.branch ?? '(none)'} expires=${grant.expires.kind} contentScope=${grant.contentScope} modeCeiling=${grant.modeCeiling}`)
    lines.push(`    rules=${grant.rules.join(', ') || '(none)'}`)
    lines.push(`    tools=${grant.tools.join(', ') || '(none)'} writePaths=${grant.writePaths.join(', ') || '(none)'}`)
  }
  lines.push('Revoke one with `/permissions revoke <grantId>`.')
  return lines.join('\n')
}
