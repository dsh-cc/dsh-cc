import { describe, expect, it } from 'vitest'
import { validateSystemOneRequest, validateSystemOneResponse } from '../src/validation.ts'
import type { SystemOneQuestion } from '../src/client.ts'

// Boundary matrix for the System One contract (design doc
// docs/plans/2026-11-02-systemone-01-contract-validation.md §"Validation rules").
// Every case here is a pure request/response pair; no network is involved.

const CHOICE_Q: SystemOneQuestion = {
  type: 'choice',
  instructions: 'Judge the call.',
  criteria: { allow: 'read-only', ask: 'writes' },
}

const SCORE_Q: SystemOneQuestion = {
  type: 'score',
  instructions: 'Rate the risk.',
  criteria: ['low', 'mid', 'high'],
}

const NOUL_Q: SystemOneQuestion = {
  type: 'noul',
  instructions: 'Probability the call is safe.',
}

/** A legal envelope skeleton; cases override the parts under test. */
function envelope(answers: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'laya-rl-agent',
    answers,
    usage: { input_tokens: 83, output_tokens: 0 },
    ...extra,
  }
}

const REQUEST = {
  model: 'llmbox_systemone/laya',
  state: { tool: 'Bash', command: 'git status' },
  questions: { verdict: CHOICE_Q } as Record<string, SystemOneQuestion>,
  timeoutMs: 1000,
}

/** Build a request payload with one field overridden (pre-check cases). */
function request(overrides: Record<string, unknown>): Parameters<typeof validateSystemOneRequest>[0] {
  return { ...REQUEST, ...overrides } as unknown as Parameters<typeof validateSystemOneRequest>[0]
}

describe('validateSystemOneResponse: choice', () => {
  it('accepts a legal choice distribution and keeps the server model', () => {
    const result = validateSystemOneResponse(
      { verdict: CHOICE_Q },
      envelope({ verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.7, ask: 0.3 } } }),
    )
    expect(result).toEqual({
      ok: true,
      value: {
        model: 'laya-rl-agent',
        answers: { verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.7, ask: 0.3 } } },
        usage: { input_tokens: 83, output_tokens: 0 },
      },
    })
  })

  it('builds the answer and probability maps without an Object prototype', () => {
    const result = validateSystemOneResponse(
      { verdict: CHOICE_Q },
      envelope({ verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.7, ask: 0.3 } } }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.getPrototypeOf(result.value.answers)).toBe(null)
    const answer = result.value.answers.verdict
    expect(Object.getPrototypeOf(answer.probabilities)).toBe(null)
  })

  it('drops unknown envelope and answer fields', () => {
    const result = validateSystemOneResponse(
      { verdict: CHOICE_Q },
      envelope(
        {
          verdict: {
            type: 'choice',
            choice: 'allow',
            probabilities: { allow: 0.7, ask: 0.3 },
            confidence: 0.4,
            action: { act_probability: 1 },
            legend: 'ignored',
          },
        },
        { request_id: 'r-1', legend: 'ignored' },
      ),
    )
    expect(result).toEqual({
      ok: true,
      value: {
        model: 'laya-rl-agent',
        answers: {
          verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.7, ask: 0.3 }, confidence: 0.4 },
        },
        usage: { input_tokens: 83, output_tokens: 0 },
      },
    })
  })

  it('rejects a choice outside the request criteria', () => {
    expect(
      validateSystemOneResponse(
        { verdict: CHOICE_Q },
        envelope({ verdict: { type: 'choice', choice: 'deny', probabilities: { allow: 0.7, ask: 0.3 } } }),
      ),
    ).toEqual({ ok: false, code: 'invalid-choice' })
  })

  it('accepts a tie for the maximum probability', () => {
    const questions = { verdict: { type: 'choice', instructions: 'Judge.', criteria: { a: 'A', b: 'B' } } as SystemOneQuestion }
    expect(
      validateSystemOneResponse(
        questions,
        envelope({ verdict: { type: 'choice', choice: 'b', probabilities: { a: 0.5, b: 0.5 } } }),
      ).ok,
    ).toBe(true)
  })

  it('accepts a chosen option roughly 1e-4 below the maximum', () => {
    const questions = { verdict: { type: 'choice', instructions: 'Judge.', criteria: { a: 'A', b: 'B' } } as SystemOneQuestion }
    // Binary-exact values: the gap is 6.1e-5, inside the 1e-4 tolerance.
    expect(
      validateSystemOneResponse(
        questions,
        envelope({
          verdict: { type: 'choice', choice: 'a', probabilities: { a: 0.499969482421875, b: 0.500030517578125 } },
        }),
      ).ok,
    ).toBe(true)
  })

  it('rejects a chosen option 1e-3 below the maximum', () => {
    const questions = { verdict: { type: 'choice', instructions: 'Judge.', criteria: { a: 'A', b: 'B' } } as SystemOneQuestion }
    expect(
      validateSystemOneResponse(
        questions,
        envelope({ verdict: { type: 'choice', choice: 'a', probabilities: { a: 0.499, b: 0.501 } } }),
      ),
    ).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('rejects an invalid choice confidence', () => {
    expect(
      validateSystemOneResponse(
        { verdict: CHOICE_Q },
        envelope({ verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.7, ask: 0.3 }, confidence: 1.5 } }),
      ),
    ).toEqual({ ok: false, code: 'invalid-confidence' })
  })
})

describe('validateSystemOneResponse: probability map', () => {
  const questions = { verdict: CHOICE_Q }

  function choice(probabilities: unknown) {
    return validateSystemOneResponse(questions, envelope({ verdict: { type: 'choice', choice: 'allow', probabilities } }))
  }

  it('rejects a missing criteria key', () => {
    expect(choice({ allow: 1 })).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('rejects an extra criteria key', () => {
    expect(choice({ allow: 0.5, ask: 0.3, deny: 0.2 })).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('rejects a sum outside tolerance', () => {
    expect(choice({ allow: 0.5, ask: 0.3 })).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('rejects a stringified probability', () => {
    expect(choice({ allow: '0.7', ask: 0.3 })).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('rejects NaN', () => {
    expect(choice({ allow: Number.NaN, ask: 0.3 })).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('rejects a negative probability', () => {
    expect(choice({ allow: -0.1, ask: 1.1 })).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('rejects a probability above one', () => {
    expect(choice({ allow: 1.2, ask: -0.2 })).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('rejects a non-object probability map', () => {
    expect(choice([0.7, 0.3])).toEqual({ ok: false, code: 'invalid-probabilities' })
  })
})

describe('validateSystemOneResponse: score', () => {
  const questions = { risk: SCORE_Q }

  it('accepts score 1 for the three-level distribution {0.25,0.5,0.25}', () => {
    const result = validateSystemOneResponse(
      questions,
      envelope({ risk: { type: 'score', score: 1, probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 } } }),
    )
    expect(result).toEqual({
      ok: true,
      value: {
        model: 'laya-rl-agent',
        answers: { risk: { type: 'score', score: 1, probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 } } },
        usage: { input_tokens: 83, output_tokens: 0 },
      },
    })
  })

  it('rejects score 2 for that distribution', () => {
    expect(
      validateSystemOneResponse(
        questions,
        envelope({ risk: { type: 'score', score: 2, probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 } } }),
      ),
    ).toEqual({ ok: false, code: 'invalid-score' })
  })

  it('rejects a probability index set that does not match the rubric', () => {
    const raw = envelope({ risk: { type: 'score', score: 1, probabilities: { '0': 0.25, '1': 0.5 } } })
    expect(validateSystemOneResponse(questions, raw)).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('rejects an out-of-range score', () => {
    const raw = envelope({ risk: { type: 'score', score: 3, probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 } } })
    expect(validateSystemOneResponse(questions, raw)).toEqual({ ok: false, code: 'invalid-score' })
  })

  it('rejects a missing score', () => {
    const raw = envelope({ risk: { type: 'score', probabilities: { '0': 0.25, '1': 0.5, '2': 0.25 } } })
    expect(validateSystemOneResponse(questions, raw)).toEqual({ ok: false, code: 'invalid-score' })
  })
})

describe('validateSystemOneResponse: noul', () => {
  const questions = { safe: NOUL_Q }

  it('accepts a legal noul', () => {
    expect(validateSystemOneResponse(questions, envelope({ safe: { type: 'noul', noul: 0.42 } }))).toEqual({
      ok: true,
      value: {
        model: 'laya-rl-agent',
        answers: { safe: { type: 'noul', noul: 0.42 } },
        usage: { input_tokens: 83, output_tokens: 0 },
      },
    })
  })

  it('rejects an out-of-range noul', () => {
    expect(validateSystemOneResponse(questions, envelope({ safe: { type: 'noul', noul: 1.2 } }))).toEqual({
      ok: false,
      code: 'invalid-noul',
    })
  })

  it('rejects an invalid noul confidence', () => {
    const raw = envelope({ safe: { type: 'noul', noul: 0.42, confidence: 1.5 } })
    expect(validateSystemOneResponse(questions, raw)).toEqual({ ok: false, code: 'invalid-confidence' })
  })

  it('drops non-standard fields from the noul answer', () => {
    const result = validateSystemOneResponse(
      questions,
      envelope({ safe: { type: 'noul', noul: 0.42, confidence: 0.9, rationale: 'text', reason: 'text' } }),
    )
    expect(result).toEqual({
      ok: true,
      value: {
        model: 'laya-rl-agent',
        answers: { safe: { type: 'noul', noul: 0.42, confidence: 0.9 } },
        usage: { input_tokens: 83, output_tokens: 0 },
      },
    })
  })
})

describe('validateSystemOneResponse: question set and answer type', () => {
  const questions = { a: NOUL_Q, b: NOUL_Q }

  function answers(value: Record<string, unknown>) {
    return validateSystemOneResponse(questions, envelope(value))
  }

  it('rejects a missing answer', () => {
    expect(answers({ a: { type: 'noul', noul: 0.5 } })).toEqual({ ok: false, code: 'question-set-mismatch' })
  })

  it('rejects an extra answer', () => {
    expect(answers({ a: { type: 'noul', noul: 0.5 }, b: { type: 'noul', noul: 0.5 }, c: { type: 'noul', noul: 0.5 } })).toEqual({
      ok: false,
      code: 'question-set-mismatch',
    })
  })

  it('accepts the same set in a different order', () => {
    expect(answers({ b: { type: 'noul', noul: 0.4 }, a: { type: 'noul', noul: 0.6 } }).ok).toBe(true)
  })

  it('rejects a non-object answers field', () => {
    expect(validateSystemOneResponse(questions, envelope([]))).toEqual({ ok: false, code: 'question-set-mismatch' })
  })

  it('rejects a type mismatch between question and answer', () => {
    expect(
      validateSystemOneResponse(
        { verdict: CHOICE_Q },
        envelope({ verdict: { type: 'score', score: 1, probabilities: { allow: 0.7, ask: 0.3 } } }),
      ),
    ).toEqual({ ok: false, code: 'answer-type-mismatch' })
  })

  it('rejects an unknown answer type', () => {
    expect(validateSystemOneResponse({ verdict: CHOICE_Q }, envelope({ verdict: { type: 'quantum' } }))).toEqual({
      ok: false,
      code: 'answer-type-mismatch',
    })
  })
})

describe('validateSystemOneResponse: envelope, model and usage', () => {
  const questions = { verdict: CHOICE_Q }
  const legal = { verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.7, ask: 0.3 } } }

  it('rejects a non-object envelope', () => {
    for (const raw of ['not json', null, 42]) {
      expect(validateSystemOneResponse(questions, raw)).toEqual({ ok: false, code: 'invalid-envelope' })
    }
  })

  it('rejects an array envelope', () => {
    expect(validateSystemOneResponse(questions, [envelope(legal)])).toEqual({ ok: false, code: 'invalid-envelope' })
  })

  it('rejects an empty model and never backfills the request alias', () => {
    for (const model of ['', undefined, 42]) {
      expect(validateSystemOneResponse(questions, envelope(legal, { model }))).toEqual({ ok: false, code: 'invalid-model' })
    }
    const result = validateSystemOneResponse(questions, envelope(legal, { model: 'gateway-served-alias' }))
    expect(result.ok && result.value.model).toBe('gateway-served-alias')
  })

  it('rejects a missing usage', () => {
    expect(validateSystemOneResponse(questions, { model: 'm', answers: legal })).toEqual({
      ok: false,
      code: 'invalid-usage',
    })
  })

  it('rejects a usage with only one counter', () => {
    expect(validateSystemOneResponse(questions, envelope(legal, { usage: { input_tokens: 1 } }))).toEqual({
      ok: false,
      code: 'invalid-usage',
    })
  })

  it('rejects negative, fractional and unsafe token counts', () => {
    for (const usage of [
      { input_tokens: -1, output_tokens: 0 },
      { input_tokens: 1.5, output_tokens: 0 },
      { input_tokens: 2 ** 53, output_tokens: 0 },
    ]) {
      expect(validateSystemOneResponse(questions, envelope(legal, { usage }))).toEqual({
        ok: false,
        code: 'invalid-usage',
      })
    }
  })

  it('accepts a legitimate zero usage', () => {
    expect(validateSystemOneResponse(questions, envelope(legal, { usage: { input_tokens: 0, output_tokens: 0 } }))).toEqual({
      ok: true,
      value: {
        model: 'laya-rl-agent',
        answers: { verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.7, ask: 0.3 } } },
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  })
})

describe('validateSystemOneRequest', () => {
  const INVALID = { ok: false, code: 'invalid-request' }

  it('accepts the baseline request', () => {
    expect(validateSystemOneRequest(REQUEST)).toEqual({ ok: true })
  })

  it('accepts a noul question without criteria and a score question', () => {
    const questions = { safe: NOUL_Q, risk: SCORE_Q } as Record<string, SystemOneQuestion>
    expect(validateSystemOneRequest(request({ questions }))).toEqual({ ok: true })
  })

  it('rejects an empty question set', () => {
    expect(validateSystemOneRequest(request({ questions: {} }))).toEqual(INVALID)
  })

  it('rejects more than 256 questions', () => {
    const questions: Record<string, SystemOneQuestion> = {}
    for (let i = 0; i < 300; i++) questions[`q${i}`] = NOUL_Q
    expect(validateSystemOneRequest(request({ questions }))).toEqual(INVALID)
  })

  it('rejects a question id with illegal characters', () => {
    for (const id of ['bad id', 'bad.id']) {
      expect(validateSystemOneRequest(request({ questions: { [id]: NOUL_Q } }))).toEqual(INVALID)
    }
  })

  it('rejects a prototype-polluting question id', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      expect(validateSystemOneRequest(request({ questions: { [id]: NOUL_Q } }))).toEqual(INVALID)
    }
  })

  it('rejects empty instructions', () => {
    expect(validateSystemOneRequest(request({ questions: { q: { type: 'noul', instructions: '' } } }))).toEqual(INVALID)
  })

  it('rejects an unknown question type', () => {
    expect(validateSystemOneRequest(request({ questions: { q: { type: 'quantum', instructions: 'x' } } }))).toEqual(INVALID)
  })

  it('rejects a choice question with one option', () => {
    const questions = { q: { type: 'choice', instructions: 'x', criteria: { only: 'one' } } }
    expect(validateSystemOneRequest(request({ questions }))).toEqual(INVALID)
  })

  it('rejects a score question with eleven levels', () => {
    const criteria = Array.from({ length: 11 }, (_, i) => `level ${i}`)
    const questions = { q: { type: 'score', instructions: 'x', criteria } }
    expect(validateSystemOneRequest(request({ questions }))).toEqual(INVALID)
  })

  it('rejects a noul question whose criteria is incomplete', () => {
    const questions = { q: { type: 'noul', instructions: 'x', criteria: { true: 'yes' } } }
    expect(validateSystemOneRequest(request({ questions }))).toEqual(INVALID)
  })

  it('rejects a cyclical state', () => {
    const cyclic: Record<string, unknown> = { tool: 'Bash' }
    cyclic.self = cyclic
    expect(validateSystemOneRequest(request({ state: cyclic }))).toEqual(INVALID)
  })

  it('rejects a BigInt state', () => {
    expect(validateSystemOneRequest(request({ state: { tokens: 1n } }))).toEqual(INVALID)
  })

  it('rejects a state that serializes to undefined', () => {
    expect(validateSystemOneRequest(request({ state: undefined }))).toEqual(INVALID)
    expect(validateSystemOneRequest(request({ state: () => 1 }))).toEqual(INVALID)
  })

  it('rejects undefined-valued members anywhere in the state', () => {
    expect(validateSystemOneRequest(request({ state: { tool: 'Bash', extra: undefined } }))).toEqual(INVALID)
    expect(validateSystemOneRequest(request({ state: { rows: [1, undefined] } }))).toEqual(INVALID)
  })

  it('rejects non-finite numbers nested in the state', () => {
    expect(validateSystemOneRequest(request({ state: { ratio: Number.NaN } }))).toEqual(INVALID)
    expect(validateSystemOneRequest(request({ state: { edges: [1, Number.POSITIVE_INFINITY] } }))).toEqual(INVALID)
  })

  it('rejects a non-positive timeout', () => {
    for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(validateSystemOneRequest(request({ timeoutMs }))).toEqual(INVALID)
    }
  })

  it('rejects an empty or oversized model', () => {
    expect(validateSystemOneRequest(request({ model: '' }))).toEqual(INVALID)
    expect(validateSystemOneRequest(request({ model: 'm'.repeat(257) }))).toEqual(INVALID)
  })

  it('rejects a non-object question set', () => {
    expect(validateSystemOneRequest(request({ questions: null }))).toEqual(INVALID)
  })
})

// Rounding-scaled tolerance matrix (issue #361): the deployed gateway quantizes
// every emitted probability and score to 4 decimal places, so independent
// rounding of the score and of each probability introduces drift the old flat
// 1e-4 tolerance rejected. Every case here pins the derived tolerances —
// 2× the worst-case 4-dp drift at the sum and score sites, one quantization
// unit plus FP slack at the choice site — at positions immediately inside and
// outside each bound (exact boundaries are FP-sensitive and deliberately not
// tested directly).

/** A score question with `levels` rubric rows. */
function scoreQuestionOf(levels: number): SystemOneQuestion {
  return {
    type: 'score',
    instructions: 'Rate the risk.',
    criteria: Array.from({ length: levels }, (_, index) => `level-${index}`),
  }
}

/** Probabilities concentrated on rubric row 0 (expectation exactly 0). */
function concentratedProbabilities(levels: number): Record<string, number> {
  const probabilities: Record<string, number> = {}
  for (let index = 0; index < levels; index += 1) probabilities[String(index)] = index === 0 ? 1 : 0
  return probabilities
}

/** The score-site tolerance for `levels` rubric rows: (1 + levels(levels-1)/2) × 1e-4. */
function scoreTolerance(levels: number): number {
  return (1 + (levels * (levels - 1)) / 2) * 1e-4
}

describe('validateSystemOneResponse: rounding-scaled tolerances (issue #361)', () => {
  it('accepts the live 5-level replay fixture whose drift is pure 4-dp rounding', () => {
    // Live tool-discovery decision 2026-11-10: the model's score 1.0159 against
    // E[p] = 1.0157 (drift 2e-4) was rejected as invalid-score by the flat 1e-4.
    const questions = { risk: scoreQuestionOf(5) }
    const result = validateSystemOneResponse(
      questions,
      envelope({
        risk: {
          type: 'score',
          score: 1.0159,
          probabilities: { '0': 0.1711, '1': 0.6969, '2': 0.0958, '3': 0.0172, '4': 0.0189 },
        },
      }),
    )
    expect(result.ok).toBe(true)
  })

  for (const levels of [2, 5, 10]) {
    it(`accepts a ${levels}-level score drift immediately inside the derived tolerance`, () => {
      const drift = scoreTolerance(levels) - 1e-6
      const questions = { risk: scoreQuestionOf(levels) }
      const result = validateSystemOneResponse(
        questions,
        envelope({ risk: { type: 'score', score: drift, probabilities: concentratedProbabilities(levels) } }),
      )
      expect(result.ok).toBe(true)
    })

    it(`rejects a ${levels}-level score drift immediately outside the derived tolerance`, () => {
      const drift = scoreTolerance(levels) + 1e-6
      const questions = { risk: scoreQuestionOf(levels) }
      const result = validateSystemOneResponse(
        questions,
        envelope({ risk: { type: 'score', score: drift, probabilities: concentratedProbabilities(levels) } }),
      )
      expect(result).toEqual({ ok: false, code: 'invalid-score' })
    })
  }

  it('still rejects a semantically inconsistent score (gap 0.1)', () => {
    const questions = { risk: scoreQuestionOf(10) }
    const result = validateSystemOneResponse(
      questions,
      envelope({ risk: { type: 'score', score: 0.1, probabilities: concentratedProbabilities(10) } }),
    )
    expect(result).toEqual({ ok: false, code: 'invalid-score' })
  })

  it('accepts a sum drift immediately inside the option-count-scaled tolerance', () => {
    // 2 options: tolerance 2e-4; this distribution sums to 1.00015.
    const questions = { risk: scoreQuestionOf(2) }
    const result = validateSystemOneResponse(
      questions,
      envelope({
        risk: { type: 'score', score: 0.5001, probabilities: { '0': 0.50005, '1': 0.5001 } },
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a sum drift immediately outside the option-count-scaled tolerance', () => {
    // 2 options: tolerance 2e-4; this distribution sums to 1.00021.
    const questions = { risk: scoreQuestionOf(2) }
    const result = validateSystemOneResponse(
      questions,
      envelope({
        risk: { type: 'score', score: 0.5001, probabilities: { '0': 0.50011, '1': 0.5001 } },
      }),
    )
    expect(result).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('accepts the gauge-shaped 3-option sum drift of 1.5e-4', () => {
    // The approval lane's typical 3-option question: worst-case 4-dp sum drift
    // is 1.5e-4, above the old flat 1e-4.
    const questions = {
      verdict: { type: 'choice', instructions: 'Judge.', criteria: { allow: 'a', ask: 'b', deny: 'c' } } as SystemOneQuestion,
    }
    const result = validateSystemOneResponse(
      questions,
      envelope({
        verdict: {
          type: 'choice',
          choice: 'allow',
          probabilities: { allow: 0.33345, ask: 0.3334, deny: 0.3331 },
        },
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('accepts a chosen option one 4-dp unit below the maximum (FP boundary repair)', () => {
    // {0.3334, 0.3335, 0.3331} sums to 1 and the chosen option trails the max
    // by exactly one quantization unit; today `0.3334 < 0.3335 - 1e-4` evaluates
    // true in IEEE (the subtraction inflates), wrongly rejecting the envelope.
    const questions = {
      verdict: { type: 'choice', instructions: 'Judge.', criteria: { allow: 'a', ask: 'b', deny: 'c' } } as SystemOneQuestion,
    }
    const result = validateSystemOneResponse(
      questions,
      envelope({
        verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.3334, ask: 0.3335, deny: 0.3331 } },
      }),
    )
    expect(result.ok).toBe(true)
  })

  it('still rejects a chosen option two 4-dp units below the maximum', () => {
    const questions = {
      verdict: { type: 'choice', instructions: 'Judge.', criteria: { allow: 'a', ask: 'b' } } as SystemOneQuestion,
    }
    const result = validateSystemOneResponse(
      questions,
      envelope({ verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.4999, ask: 0.5001 } } }),
    )
    expect(result).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('still rejects a chosen option 0.1 below the maximum', () => {
    const questions = {
      verdict: { type: 'choice', instructions: 'Judge.', criteria: { allow: 'a', ask: 'b' } } as SystemOneQuestion,
    }
    const result = validateSystemOneResponse(
      questions,
      envelope({ verdict: { type: 'choice', choice: 'allow', probabilities: { allow: 0.45, ask: 0.55 } } }),
    )
    expect(result).toEqual({ ok: false, code: 'invalid-probabilities' })
  })

  it('accepts a 255-option distribution with the documented large-set sum drift', () => {
    // The 255-option sum tolerance is 0.0255 (2× the worst-case 4-dp drift of
    // 255 terms). A uniform distribution with a 0.02 uplift is deliberately
    // inside it; this ceiling is documented in the S1-01 amendment.
    const entries: Record<string, string> = {}
    const probabilities: Record<string, number> = {}
    for (let index = 0; index < 255; index += 1) {
      const key = `o${String(index).padStart(3, '0')}`
      entries[key] = 'option'
      probabilities[key] = (1 + 0.02) / 255
    }
    const questions = { verdict: { type: 'choice', instructions: 'Judge.', criteria: entries } as SystemOneQuestion }
    const result = validateSystemOneResponse(
      questions,
      envelope({ verdict: { type: 'choice', choice: 'o000', probabilities } }),
    )
    expect(result.ok).toBe(true)
  })

  it('rejects a 255-option distribution drifting beyond the large-set ceiling', () => {
    const entries: Record<string, string> = {}
    const probabilities: Record<string, number> = {}
    for (let index = 0; index < 255; index += 1) {
      const key = `o${String(index).padStart(3, '0')}`
      entries[key] = 'option'
      probabilities[key] = (1 + 0.03) / 255
    }
    const questions = { verdict: { type: 'choice', instructions: 'Judge.', criteria: entries } as SystemOneQuestion }
    const result = validateSystemOneResponse(
      questions,
      envelope({ verdict: { type: 'choice', choice: 'o000', probabilities } }),
    )
    expect(result).toEqual({ ok: false, code: 'invalid-probabilities' })
  })
})
