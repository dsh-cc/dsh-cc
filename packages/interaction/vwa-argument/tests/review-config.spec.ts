/**
 * Frozen review settings tests (Feature C §C.2.2): claimsBatchSize is
 * captured at init with default 1.
 */

import { describe, expect, it } from 'vitest'
import { freezeReviewSettings } from '../src/review-config.ts'
import { DEFAULT_VWA_ARGUMENT_SETTINGS } from '../src/settings.ts'

describe('freezeReviewSettings (Feature C §C.2.2)', () => {
  it('captures claimsBatchSize with the default 1', () => {
    expect(freezeReviewSettings().claimsBatchSize).toBe(1)
    expect(freezeReviewSettings(DEFAULT_VWA_ARGUMENT_SETTINGS).claimsBatchSize).toBe(1)
  })

  it('captures a custom batch size', () => {
    const frozen = freezeReviewSettings({
      ...DEFAULT_VWA_ARGUMENT_SETTINGS,
      'review-claims-batch-size': 3,
    })
    expect(frozen.claimsBatchSize).toBe(3)
  })
})
