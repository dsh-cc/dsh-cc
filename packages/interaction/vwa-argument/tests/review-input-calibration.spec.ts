/**
 * Fix 6 review follow-up — input-token estimate calibration (PR #282 review).
 *
 * The no-tokenizer `countInput` fallback is `ceil(bytes / 3)` labelled
 * `bytes/3-estimate`. It is an ESTIMATE, not a strict upper bound: the input
 * budget is approximate control (see review-adapter.ts and design doc
 * docs/plans/2026-10-23-vwa-input-reservation-caliber.md §F6.1).
 *
 * Reference token counts live in `fixtures/input-calibration.json`, measured
 * with tiktoken (`cl100k_base` / `o200k_base`) over the EXACT `text` values in
 * that file (provenance line included). Re-measuring process: read the fixture's
 * `text` fields and tokenize them with the same encodings; the file carries the
 * command's provenance so the numbers stay reproducible.
 *
 * Documented behavior per class:
 *  - conservative (English prose, JSON envelopes, code, mixed text): the
 *    estimate stays ABOVE the measured count;
 *  - dense (CJK prose, rare CJK glyphs, emoji/symbols): the estimate sits
 *    BELOW the measured count, bounded by the documented worst case.
 *
 * @module tests/review-input-calibration
 */

import { describe, expect, it } from 'vitest'
import { createReviewAdapter } from '../src/review-adapter.ts'
import fixture from './fixtures/input-calibration.json' with { type: 'json' }

const ROUTE = { provider: 'fake', model: 'fake-model' }

/** The documented worst observed under-reservation factor (rare-CJK, cl100k). */
const MAX_DOCUMENTED_UNDER_RESERVE = 2.5

interface Sample {
  class: 'conservative' | 'dense'
  text: string
  bytes: number
  cl100k: number
  o200k: number
}

const SAMPLES = (fixture as { samples: Record<string, Sample> }).samples

function adapter() {
  return createReviewAdapter({
    llm: { prepareCall: async () => ({ config: {}, stream: async function* () {} }) },
    route: ROUTE,
  })
}

describe('Fix 6 review — input-token estimate calibration', () => {
  it('conservative classes: the estimate stays above the measured token count', async () => {
    const probe = adapter()
    for (const [name, sample] of Object.entries(SAMPLES)) {
      if (sample.class !== 'conservative') continue
      const counted = await probe.countInput([{ role: 'user', content: sample.text }])
      expect(counted.method).toBe('bytes/3-estimate')
      expect(counted.tokens, `${name}: ${counted.tokens} must be ≥ ${sample.cl100k}`).toBeGreaterThanOrEqual(
        sample.cl100k,
      )
    }
  })

  it('dense classes: the estimate under-reserves, bounded by the documented worst factor', async () => {
    const probe = adapter()
    for (const [name, sample] of Object.entries(SAMPLES)) {
      if (sample.class !== 'dense') continue
      const counted = await probe.countInput([{ role: 'user', content: sample.text }])
      const worst = Math.max(sample.cl100k, sample.o200k) / counted.tokens
      expect(counted.tokens, `${name}: documented under-reserve (not a bound)`).toBeLessThan(sample.cl100k)
      expect(worst, `${name}: worst factor ${worst.toFixed(2)} within documented bound`).toBeLessThanOrEqual(
        MAX_DOCUMENTED_UNDER_RESERVE,
      )
    }
  })

  it('the estimate is exactly ceil(bytes / 3) and the fixture bytes match the encoded text', async () => {
    const probe = adapter()
    for (const [name, sample] of Object.entries(SAMPLES)) {
      expect(Buffer.from(sample.text, 'utf8').length, `${name}: fixture byte count`).toBe(sample.bytes)
      const counted = await probe.countInput([{ role: 'user', content: sample.text }])
      expect(counted.tokens, name).toBe(Math.ceil(sample.bytes / 3))
    }
  })

  it('a countTokens callback bypasses the estimate entirely (labelled tokenizer)', async () => {
    const probe = createReviewAdapter({
      llm: { prepareCall: async () => ({ config: {}, stream: async function* () {} }) },
      route: ROUTE,
      countTokens: async () => 1234,
    })
    expect(await probe.countInput([{ role: 'user', content: 'whatever' }])).toEqual({
      tokens: 1234,
      method: 'tokenizer',
    })
  })
})
