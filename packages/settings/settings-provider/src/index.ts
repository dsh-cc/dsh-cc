/**
 * `@dsh-cc/settings-provider` — the dsh-cc-vendored user-settings contract.
 *
 * Vendored from harness `@deepseek-ai/dsh-settings` at pin `1ef9c1fa9a`
 * (0.1.5-rc.1) per migration plan Q3 Option A: dsh-cc's CC settings.json
 * cascade and the rc.2 profile-patch settings model are different products,
 * so the old `SettingsProvider` seam is transplanted here verbatim (one
 * deliberate addition: the no-op `configure()` facade on the provider).
 *
 * @module @dsh-cc/settings-provider
 */

export { SettingsProvider, default } from './provider.ts'
export { SettingsConflictError } from './contract.ts'
export { parseSettingsNamespace } from './namespace.ts'
export { redactSecrets } from './redact.ts'
export type { SettingsNamespace, SettingsUpdateSource } from './types.ts'
export type { SettingsNamespaceInput } from './namespace.ts'
export type { RedactedSecret, RedactedValue } from './redact.ts'
export type {
  SettingsApplies,
  SettingsDescriptor,
  SettingsDescribeOptions,
  SettingsPathOp,
  SettingsRegisterOptions,
  SettingsScope,
  SettingsSectionHooks,
} from './contract.ts'
export type { SettingsRegistration, SettingsWatcher } from './events.ts'
