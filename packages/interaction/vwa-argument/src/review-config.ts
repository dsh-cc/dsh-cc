/** Per-project review limits are frozen at init; enablement and model routing remain live. */
import type { ReviewBudget } from './review-budget.ts'
import { DEFAULT_VWA_ARGUMENT_SETTINGS, type VwaArgumentSettings } from './settings.ts'
export interface FrozenReviewSettings {
  budget: ReviewBudget
  maxArtifactChars: number
  maxContextChars: number
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
  }
}
