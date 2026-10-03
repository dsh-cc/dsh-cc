/**
 * Post-edit auto-verify (design doc docs/plans/2026-09-20-post-edit-auto-verify.md):
 * after an accepted `edit`/`write` result, run a user-declared fast
 * verification command through the harness ShellExecutor and append its
 * outcome to the same tool result — one observation covers both events, no
 * extra model round-trip.
 *
 * Also hosts the merged edit-recovery-hint feature (design doc
 * docs/plans/2026-09-21-edit-fuzzy-matching-and-read-state.md, Track B,
 * former @dsh-cc/edit-recovery-hint): appends a fixed static recovery-advice
 * message on an edit not-found failure — no shell service required.
 *
 * Plain plugin (not a Service): `apply(ctx)` with `inject = ['shell']`
 * (tool-use-summary / prompt-suggest idiom). Settings are registered for
 * /config UX only; trigger logic reads the raw user file per use (§3.4).
 *
 * @module @dsh-cc/post-edit-verify
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { registerRecoveryListener } from './recovery-wiring.ts'
import { registerRecoveryHintSettings, registerSettings } from './settings.ts'
import { registerListener } from './wiring.ts'

export type { VerifyRule } from './rules.ts'
export { matchRule } from './rules.ts'
export { composeVerifyBlock, buildVerifyBlock, type ComposeOutcome } from './compose.ts'
export { burstLabel, verifyBlockLabel } from './burst.ts'
export {
  SETTINGS_NAMESPACE,
  SettingsSchema,
  DEFAULT_RULES_SETTINGS,
  registerSettings,
  readUserRules,
  rulesOf,
  type RulesSettings,
} from './settings.ts'
export { createRunner, clampTimeoutMs, keepOutput, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, type VerifyOutcome } from './runner.ts'
// Merged edit-recovery-hint surface (former @dsh-cc/edit-recovery-hint exports).
export { RECOVERY_HINT, isRecoveryCandidate, resultTextOf } from './hint.ts'
export {
  RECOVERY_HINT_SETTINGS_NAMESPACE,
  RecoveryHintSettingsSchema,
  DEFAULT_RECOVERY_HINT_SETTINGS,
  registerRecoveryHintSettings,
  readUserEnabled,
  type RecoveryHintSettings,
} from './settings.ts'
export { registerRecoveryListener } from './recovery-wiring.ts'

export const inject = ['shell']

/**
 * Mount the plugin: register both settings namespaces, then the
 * post-execute listeners. The verify listener is inert without the `shell`
 * service; the recovery-hint listener needs no shell and is registered
 * regardless.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  // /config UX + validation only; the listeners read the raw user file per use.
  registerSettings(ctx)
  registerRecoveryHintSettings(ctx)
  const shell = ctx.get('shell') as ShellExecutor | undefined
  if (shell === undefined) {
    ctx.logger.warn('post-edit-verify: no shell service on the host context; disabled')
  } else {
    registerListener(ctx, shell)
  }
  // Recovery hints are shell-independent — always mounted.
  registerRecoveryListener(ctx)
}
