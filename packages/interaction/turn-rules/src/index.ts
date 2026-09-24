/**
 * Turn rules (plan docs/plans/2026-09-23-turn-rules.md): a non-interrupting
 * rule engine that fires only when the model goes off-script. Trigger-bearing
 * cursor-plugin rules pay zero context until their trigger matches a completed
 * tool call/result or a user prompt; on the first match the body is injected
 * as an advisory reminder at that seam — as an `additionalContexts` entry on
 * the tool-result accept decision, or as an attributed injected message at the
 * prompt seam. Fired state is per-session, durable across compaction and
 * resume, with `once` (default) and `after-gap: N` repeat policies. All
 * failure modes fail open; nothing may turn a tool result into an error.
 *
 * Plain plugin (not a Service): `apply(ctx)`, no isolate key. Settings are
 * registered for /config UX only; the listeners read the raw user file per
 * use. Ship-on: `cc-turn-rules.enabled` defaults to true (behavior-neutral —
 * zero trigger-bearing rules exist by default).
 *
 * @module @dsh-cc/turn-rules
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerSettings } from './settings.ts'
import { registerListeners } from './wiring.ts'

export {
  SETTINGS_NAMESPACE,
  SettingsSchema,
  DEFAULT_TURN_RULES_SETTINGS,
  registerSettings,
  readUserSettings,
  type TurnRulesSettings,
} from './settings.ts'
export { discoverTurnRules, type TurnRule } from './discovery.ts'
export { createRegexCache, type RegexCache } from './regex-cache.ts'
export { emptyLedger, ledgerFileFor, loadLedger, writeLedger, type TurnRulesLedger } from './ledger.ts'
export {
  buildPromptCandidate,
  buildToolUnit,
  shouldFire,
  truncateUtf8,
  INJECTED_SOURCE_DENYLIST,
  TURN_RULES_SOURCE_KIND,
} from './matcher.ts'
export { registerListeners, MAX_INJECTIONS } from './wiring.ts'

/**
 * Mount the plugin: register the settings namespace and the three listeners.
 * Plain plugin — no Service, no isolate key.
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  // /config UX + validation only; the listeners read the raw user file per use.
  registerSettings(ctx)
  registerListeners(ctx)
}
