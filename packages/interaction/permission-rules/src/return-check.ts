/**
 * S6/D9 subagent-handoff return checks (arm (a)): when the parent's
 * post-execute path resolves the child session, fold the child's
 * `permission/classifier` + `permission/probe` audit records and warn when
 * the child hit a deny, a breaker/trip failure, or an ask storm (≥5 asks).
 * Pure: no I/O, no session access — the caller supplies the folded event
 * lists. Warn-only by design: a warning never discards or rewrites results.
 * @module @dsh-cc/permission-rules/return-check
 */

import type { ClassifierAuditEventData } from './auto-stage.ts'
import type { ProbeAuditEventData } from './pi-probe.ts'

/** D9 ask-storm threshold: ≥5 escalated verdicts in one child ⇒ warn. */
export const HANDOFF_ASK_STORM = 5

/** The fold outcome for one child's audit: whether to warn and why. */
export type ChildHandoffSummary = { warn: boolean; reason: string }

/**
 * Summarize one child's folded audit records. Warn when ANY verdict is
 * `deny`, ANY record failed with `breaker`/`trip`, or `ask` verdicts reach
 * {@link HANDOFF_ASK_STORM}. The reason names the counts (≤120 chars by
 * construction — counts + fixed prose).
 */
export function summarizeChildHandoff(
  classifiers: readonly ClassifierAuditEventData[],
  probes: readonly ProbeAuditEventData[],
): ChildHandoffSummary {
  const denies = classifiers.filter(event => event.verdict === 'deny').length
  const failures = [...classifiers, ...probes].filter(event => event.failure === 'breaker' || event.failure === 'trip').length
  const asks = classifiers.filter(event => event.verdict === 'ask').length
  const parts: string[] = []
  if (denies > 0) parts.push(`${denies} denied tool call${denies === 1 ? '' : 's'}`)
  if (failures > 0) parts.push(`${failures} breaker/trip failure${failures === 1 ? '' : 's'}`)
  if (asks >= HANDOFF_ASK_STORM) parts.push(`${asks} escalated (ask) calls`)
  return parts.length === 0
    ? { warn: false, reason: '' }
    : { warn: true, reason: parts.join(', ') }
}

/**
 * The arm-(a) warning text (prose, plugin-sourced, warn-only): names the
 * child label and the counts; instructs the parent to weigh the child's
 * autonomy signals before acting further on the delegated work.
 */
export function handoffWarningText(label: string, reason: string): string {
  return `Auto-mode subagent handoff notice: subagent "${label}" recorded ${reason} in its own permission audit. The delegated work ran with elevated autonomy — weigh those events before acting further on the child's report, and re-anchor on the user's actual request.`
}
