/**
 * @dsh-cc/vwa-argument — VWA lane-2 argumentation contracts (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md). Slice 1 (P0): package
 * face, JSON Schema contracts + Ajv validation entry, settings namespace.
 * The feature is INERT and DEFAULT-OFF: `apply` registers settings and
 * nothing else — no listeners, no tools, no review runs yet (§23 P0).
 *
 * Ownership boundaries (§3): `@dsh-cc/vwa-evidence` stays the sole receipt
 * writer and does NOT import this package; this package imports it one-way
 * (stableJson/sha256Hex re-exports). `ReceiptV2` as a TS type lives in
 * vwa-evidence; the validating schema lives here (§16.1).
 *
 * @module @dsh-cc/vwa-argument
 */

import type { Context } from '@deepseek-ai/cordis'
import { registerSettings } from './settings.ts'

export {
  DEFAULT_VWA_ARGUMENT_SETTINGS,
  SETTINGS_NAMESPACE,
  SettingsSchema,
  readUserSettingsSync,
  registerSettings,
  type VwaArgumentSettings,
} from './settings.ts'

export {
  codeUnitLength,
  isHash,
  isPrefixedId,
  isUuidV4,
  sha256Hex,
  spanError,
  spanInString,
  stableJson,
  validateAdjudicationRecord,
  validateAssessment,
  validateExtractionRecord,
  validateExtractedAtomicClaim,
  validateProjectSnapshot,
  validateReceiptV2,
  validateReviewRecord,
  validateReviewResponse,
} from './schema.ts'

export * from './types.ts'

/** Cordis plugin id (mount-row name `@dsh-cc/vwa-argument`). */
export const name = 'vwa-argument'

/**
 * No services touched yet: this slice is inert by design (§23 P0 — feature
 * not enabled). A later slice widens this to the review/jobs seams.
 */
export const inject: string[] = []

/**
 * Mount the plugin: register the settings namespace only (§23 P0).
 * @param ctx - the plug context.
 */
export function apply(ctx: Context): void {
  registerSettings(ctx)
}
