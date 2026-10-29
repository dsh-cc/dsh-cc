/** Per-project review limits are frozen at init; enablement and model routing remain live. */
import type { ReviewBudget } from './review-budget.ts'
import { DEFAULT_VWA_ARGUMENT_SETTINGS, type VwaArgumentSettings } from './settings.ts'
/** Feature 3 §4.2: how an unresolved reviewer disagreement drives delivery. */
export type DisagreementPolicy = 'blocking' | 'deferred'
export interface FrozenReviewSettings {
  budget: ReviewBudget
  maxArtifactChars: number
  maxContextChars: number
  // Feature C §C.2.2: frozen at init; 1 = no batching.
  claimsBatchSize: number
  // Feature 3 §4.2: absent on pre-existing snapshots = 'blocking'.
  disagreementPolicy?: DisagreementPolicy
}
export function freezeReviewSettings(
  settings: VwaArgumentSettings = DEFAULT_VWA_ARGUMENT_SETTINGS,
): FrozenReviewSettings {
  return {
    budget: {
      maxCallsPerRun: settings['review-max-calls-per-run'],
      maxInputTokensPerRun: settings['review-max-input-tokens-per-run'],
      maxOutputTokensPerRun: settings['review-max-output-tokens-per-run'],
      maxOutputTokensPerCall: settings['review-max-output-tokens-per-call'],
      wallMs: settings['review-max-wall-ms'],
      callTimeoutMs: settings['review-call-timeout-ms'],
      concurrency: settings['review-concurrency'],
    },
    maxArtifactChars: settings['review-max-artifact-chars'],
    maxContextChars: settings['review-max-context-chars-per-task'],
    claimsBatchSize: settings['review-claims-batch-size'],
    disagreementPolicy: 'blocking',
  }
}
