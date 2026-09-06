/**
 * The explicit runtime policy for resume gates (plan §4.9): the
 * `subagents-resume` settings namespace (the plan's `subagents.resume` —
 * the settings namespace grammar only accepts kebab-case). Read LIVE on
 * every gate evaluation: a policy flip is authoritative for the next
 * evaluation, and a persisted `blocked` state never short-circuits it.
 *
 * Every value is an explicit, inspectable choice — there is no silent
 * substitution anywhere. `WORKSPACE_MISSING`, `PIN_ORPHANED`,
 * `PINNED_TOOL_UNAVAILABLE`, and `PIN_UNREADABLE` always block regardless of
 * this policy: no safe fallback exists for them.
 *
 * @module @dsh-cc/subagent-resume-pins/policy
 */

import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** The settings namespace carrying the resume policy. */
export const RESUME_POLICY_NAMESPACE: SettingsNamespace = settingsNamespace('subagents-resume')

/** What happens when the pinned provider/model route is no longer available. */
export type OnUnavailableModel = 'block' | 'route-current'

/** What happens when a named definition's fingerprint changed (or is gone). */
export type OnDefinitionChanged = 'resume-with-notice' | 'block'

/** What happens when the workspace's canonical repo identity changed. */
export type OnWorkspaceChanged = 'resume-with-notice' | 'block'

/** The resolved resume policy consumed by the gate. */
export interface ResumePolicy {
  readonly onUnavailableModel: OnUnavailableModel
  readonly onDefinitionChanged: OnDefinitionChanged
  readonly onWorkspaceChanged: OnWorkspaceChanged
}

/** The defaults every value falls back to; fail-closed on the model knob. */
export const RESUME_POLICY_DEFAULTS: ResumePolicy = {
  onUnavailableModel: 'block',
  onDefinitionChanged: 'resume-with-notice',
  onWorkspaceChanged: 'resume-with-notice',
}

const ON_UNAVAILABLE = ['block', 'route-current'] as const
const ON_CHANGED = ['resume-with-notice', 'block'] as const

/**
 * Resolve the live policy from one raw settings section: unknown fields are
 * ignored; an invalid value falls back to its default (the section schema and
 * write-time validation are the first line — this keeps a hand-edited document
 * from being read as an unintended policy). Absent section → the defaults.
 * @param raw - the live `subagents-resume` section (any shape).
 * @returns the resolved policy.
 */
export function readResumePolicy(raw: unknown): ResumePolicy {
  if (typeof raw !== 'object' || raw === null) return RESUME_POLICY_DEFAULTS
  const record = raw as Record<string, unknown>
  const pick = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
    typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback
  return {
    onUnavailableModel: pick(record['onUnavailableModel'], ON_UNAVAILABLE, RESUME_POLICY_DEFAULTS.onUnavailableModel),
    onDefinitionChanged: pick(record['onDefinitionChanged'], ON_CHANGED, RESUME_POLICY_DEFAULTS.onDefinitionChanged),
    onWorkspaceChanged: pick(record['onWorkspaceChanged'], ON_CHANGED, RESUME_POLICY_DEFAULTS.onWorkspaceChanged),
  }
}
