/** Persisted diagnostics must satisfy the same strict JSON contract as review records. */
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import authorSchema from '../src/contracts/author.schema.json' with { type: 'json' }
import reviewSchema from '../src/contracts/review.schema.json' with { type: 'json' }
import type { ReviewErrorDetail } from '../src/types.ts'

const ajv = new Ajv2020({ strict: true, allErrors: true })
ajv.addSchema(authorSchema)
ajv.addSchema(reviewSchema)

const detail: ReviewErrorDetail = {
  message: 'upstream unavailable', httpStatus: 503, providerCode: 'overloaded',
  providerRetryAfterMs: 5000, rawResponseTail: '{', retryAttempts: 2,
}

for (const definition of ['ReviewRecord', 'ExtractionRecord']) {
  const validate = ajv.compile({ $ref: `${reviewSchema.$id}#/$defs/${definition}` })
  const record = {
    runId: 'run_11111111-2222-4333-8444-555555555555',
    stage: definition === 'ExtractionRecord' ? 'extract' : 'claims',
    targetRefs: [], dependencyDigest: 'a'.repeat(64), contractHash: 'a'.repeat(64),
    policyHash: 'a'.repeat(64), reviewerConfigHash: 'a'.repeat(64),
    promptHash: 'a'.repeat(64), inputHash: 'a'.repeat(64), status: 'error',
    inputTokens: 0, outputTokens: 0, startedAt: '2026-10-20T00:00:00.000Z',
    endedAt: '2026-10-20T00:00:00.000Z', errorCode: 'REVIEW_UNAVAILABLE',
    ...(definition === 'ExtractionRecord' ? { response: { items: [] } } : {}),
  }
  describe(`${definition} failure diagnostics`, () => {
    it('keeps older records without diagnostics valid', () => {
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true)
    })
    it('accepts all diagnostic fields', () => {
      expect(validate({ ...record, errorDetail: detail }), JSON.stringify(validate.errors)).toBe(true)
    })
    it('accepts zero attempts and absent optional fields', () => {
      expect(validate({ ...record, errorDetail: { message: 'refused', retryAttempts: 0 } })).toBe(true)
    })
    it.each([
      { ...detail, retryAttempts: -1 }, { ...detail, retryAttempts: 1.5 },
      { ...detail, httpStatus: '503' }, { ...detail, providerCode: 503 },
      { ...detail, providerRetryAfterMs: -1 }, { ...detail, rawResponseTail: 42 },
      { ...detail, message: 'x'.repeat(501) }, { ...detail, rawResponseTail: 'x'.repeat(2001) },
      { ...detail, extra: true }, { message: 'missing attempt count' }, { retryAttempts: 0 },
    ])('rejects malformed diagnostics: %j', (errorDetail) => {
      expect(validate({ ...record, errorDetail })).toBe(false)
    })
  })
}
