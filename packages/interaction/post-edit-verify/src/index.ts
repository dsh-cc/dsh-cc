/**
 * Post-edit auto-verify (design doc docs/plans/2026-09-20-post-edit-auto-verify.md):
 * after an accepted `edit`/`write` result, run a user-declared fast
 * verification command through the harness ShellExecutor and append its
 * outcome to the same tool result — one observation covers both events, no
 * extra model round-trip.
 *
 * Plain plugin (not a Service): `apply(ctx)` with `inject = ['shell']`
 * (tool-use-summary / prompt-suggest idiom). Settings are registered for
 * /config UX only; trigger logic reads the raw user file per use (§3.4).
 *
 * @module @dsh-cc/post-edit-verify
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { registerSettings } from './settings.ts'
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

export const inject = ['shell']

/**
 * Mount the plugin: register the settings namespace and the post-execute
 * listener. Inert without the `shell` service.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  // /config UX + validation only; the listener reads the raw user file per use.
  registerSettings(ctx)
  const shell = ctx.get('shell') as ShellExecutor | undefined
  if (shell === undefined) {
    ctx.logger.warn('post-edit-verify: no shell service on the host context; disabled')
    return
  }
  registerListener(ctx, shell)
}
