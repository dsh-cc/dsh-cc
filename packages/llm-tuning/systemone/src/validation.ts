/**
 * Pure, request-aware contract validation for the System One wire protocol
 * (design doc §"Validation rules"). A successful validation means: the
 * envelope is shaped, the answer key set equals the requested question set
 * exactly, every answer matches its question type, every probability map
 * agrees with its criteria, scores agree with their distribution, and usage
 * is auditable.
 *
 * Invariants kept here:
 * - dependency-free and stateless: no network, no Cordis, no zod;
 * - every failure is a fixed `ValidationCode` — never state, prompts,
 *   candidate text or the raw server payload;
 * - every returned map is built via `Object.create(null)`, so server keys can
 *   never land on a plain-object prototype;
 * - unknown fields are dropped, never propagated: each answer keeps only the
 *   fields of the public `SystemOneAnswer` type.
 *
 * @module @dsh-cc/systemone/validation
 */

import type { SystemOneAnswer, SystemOneQuestion, SystemOneUsage } from './client.ts'

/** Fixed failure codes; a code never carries payload or prompt content. */
export type ValidationCode =
  | 'invalid-request'
  | 'invalid-envelope'
  | 'invalid-model'
  | 'question-set-mismatch'
  | 'answer-type-mismatch'
  | 'invalid-choice'
  | 'invalid-probabilities'
  | 'invalid-score'
  | 'invalid-noul'
  | 'invalid-confidence'
  | 'invalid-usage'

/** The normalized, fully validated response. */
export interface ValidatedResponse {
  model: string
  answers: Record<string, SystemOneAnswer>
  usage: SystemOneUsage
}

/** Highest accepted `model` length, matching the gateway limit. */
const MAX_MODEL_CHARS = 256

/** Question-set bounds: 1 to 256 questions per request. */
const MIN_QUESTIONS = 1
const MAX_QUESTIONS = 256

/** Question and option identifier bounds, shared by both namespaces. */
const MAX_IDENTIFIER_CHARS = 128

/** Choice criteria bounds: 2 to 255 options. */
const MIN_CHOICE_OPTIONS = 2
const MAX_CHOICE_OPTIONS = 255

/** Score rubric bounds: 2 to 10 levels, lowest to highest. */
const MIN_SCORE_LEVELS = 2
const MAX_SCORE_LEVELS = 10

/**
 * Tolerance for both the probability sum and the chosen-versus-maximum gap.
 * Values are neither clipped nor renormalized: an out-of-tolerance
 * distribution is a malformed response, not something to repair.
 */
const PROBABILITY_TOLERANCE = 1e-4

/** Identifier alphabet for question ids and choice option ids. */
const IDENTIFIER = /^[A-Za-z0-9_-]+$/

/** Names that must never be writable as dictionary keys. */
const FORBIDDEN_IDENTIFIERS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/** The two criteria keys a `noul` question may carry. */
const NOUL_CRITERIA_KEYS: ReadonlySet<string> = new Set(['true', 'false'])

type Failure = { ok: false; code: ValidationCode }

function failure(code: ValidationCode): Failure {
  return { ok: false, code }
}

/**
 * Plain JSON object check: any object whose prototype is `Object.prototype`
 * or `null`, and which is not an array. Class instances, dates and boxed
 * primitives are rejected so their getters cannot smuggle values in.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** A string with at least one character. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** A question or option id: bounded length, safe alphabet, no prototype names. */
function isValidIdentifier(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= MAX_IDENTIFIER_CHARS &&
    IDENTIFIER.test(value) &&
    !FORBIDDEN_IDENTIFIERS.has(value)
  )
}

/** A finite number inside `[0, 1]`. */
function isUnitInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** A non-negative safe integer (usage counters). */
function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * State must be JSON-serializable per the design: reject cycles, BigInt,
 * non-finite numbers, and undefined/function/symbol values anywhere. The
 * JSON.stringify fallback alone cannot see these (`NaN` stringifies to
 * `null`, cycles throw only at the exact depth) so the walk below is the
 * authority; stringify remains as a belt-and-braces check.
 */
function isJsonSerializable(value: unknown, seen?: Set<object>): boolean {
  if (value === null) return true
  const type = typeof value
  if (type === 'string' || type === 'boolean') return true
  if (type === 'number') return Number.isFinite(value)
  if (type === 'bigint' || type === 'undefined' || type === 'function' || type === 'symbol') return false
  if (type !== 'object') return false
  const track = seen ?? new Set<object>()
  if (track.has(value as object)) return false
  track.add(value as object)
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isJsonSerializable(item, track)) return false
    }
  } else {
    for (const member of Object.values(value as Record<string, unknown>)) {
      if (!isJsonSerializable(member, track)) return false
    }
  }
  track.delete(value as object)
  return true
}

/** Validate one question entry (type, instructions and its criteria). */
function isValidQuestion(id: string, value: unknown): boolean {
  if (!isValidIdentifier(id)) return false
  if (!isPlainObject(value)) return false
  if (!isNonEmptyString(value.instructions)) return false
  const type = value.type
  if (type === 'choice') {
    const criteria = value.criteria
    if (!isPlainObject(criteria)) return false
    const options = Object.keys(criteria)
    if (options.length < MIN_CHOICE_OPTIONS || options.length > MAX_CHOICE_OPTIONS) return false
    return options.every((option) => isValidIdentifier(option) && typeof criteria[option] === 'string')
  }
  if (type === 'score') {
    const criteria = value.criteria
    if (!Array.isArray(criteria)) return false
    if (criteria.length < MIN_SCORE_LEVELS || criteria.length > MAX_SCORE_LEVELS) return false
    return criteria.every((level) => isNonEmptyString(level))
  }
  if (type === 'noul') {
    const criteria = value.criteria
    // Criteria is optional for noul; when present it must carry exactly the
    // two string keys.
    if (criteria === undefined) return true
    if (!isPlainObject(criteria)) return false
    const keys = Object.keys(criteria)
    if (keys.length !== NOUL_CRITERIA_KEYS.size) return false
    return keys.every((key) => NOUL_CRITERIA_KEYS.has(key))
  }
  return false
}

/**
 * Request pre-check, run before any network request: on failure the caller
 * sends nothing and reports `invalid-request`.
 */
export function validateSystemOneRequest(opts: {
  model: string
  state: unknown
  questions: Record<string, SystemOneQuestion>
  timeoutMs: number
}): { ok: true } | Failure {
  if (!isNonEmptyString(opts.model) || opts.model.length > MAX_MODEL_CHARS) return failure('invalid-request')
  if (
    typeof opts.timeoutMs !== 'number' ||
    !Number.isFinite(opts.timeoutMs) ||
    !Number.isInteger(opts.timeoutMs) ||
    opts.timeoutMs <= 0
  ) {
    return failure('invalid-request')
  }
  if (!isPlainObject(opts.questions)) return failure('invalid-request')
  const ids = Object.keys(opts.questions)
  if (ids.length < MIN_QUESTIONS || ids.length > MAX_QUESTIONS) return failure('invalid-request')
  if (!ids.every((id) => isValidQuestion(id, opts.questions[id]))) return failure('invalid-request')
  if (!isJsonSerializable(opts.state)) return failure('invalid-request')
  return { ok: true }
}

/**
 * Read a probability map whose key set must equal `expected` exactly. Each
 * value must be a finite number in `[0, 1]` and the sum must be within
 * `PROBABILITY_TOLERANCE` of 1. Returns a prototype-free map or `undefined`.
 */
function readProbabilities(value: unknown, expected: ReadonlySet<string>): Record<string, number> | undefined {
  if (!isPlainObject(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length !== expected.size) return undefined
  const probabilities: Record<string, number> = Object.create(null)
  let sum = 0
  for (const key of keys) {
    if (!expected.has(key)) return undefined
    const probability = value[key]
    if (!isUnitInterval(probability)) return undefined
    probabilities[key] = probability
    sum += probability
  }
  if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) return undefined
  return probabilities
}

/** Optional confidence: absent is fine, present must be a finite `[0,1]`. */
function readConfidence(raw: Record<string, unknown>): { ok: true; value?: number } | Failure {
  if (raw.confidence === undefined) return { ok: true }
  if (!isUnitInterval(raw.confidence)) return failure('invalid-confidence')
  return { ok: true, value: raw.confidence }
}

/** A choice answer: known option, exact probability map, chosen near the top. */
function validateChoiceAnswer(
  question: SystemOneQuestion,
  raw: Record<string, unknown>,
): { ok: true; value: SystemOneAnswer } | Failure {
  const criteria = question.criteria
  if (!isPlainObject(criteria)) return failure('invalid-request')
  const options = Object.keys(criteria)
  const choice = raw.choice
  if (typeof choice !== 'string' || !Object.hasOwn(criteria, choice)) return failure('invalid-choice')
  const probabilities = readProbabilities(raw.probabilities, new Set(options))
  if (probabilities === undefined) return failure('invalid-probabilities')
  // A tie for the maximum is legal: any tied option may be returned. Only a
  // chosen option that trails the maximum beyond tolerance is malformed.
  let max = 0
  for (const probability of Object.values(probabilities)) max = Math.max(max, probability)
  const chosenProbability = probabilities[choice]
  if (chosenProbability === undefined) return failure('invalid-probabilities')
  if (chosenProbability < max - PROBABILITY_TOLERANCE) return failure('invalid-probabilities')
  const confidence = readConfidence(raw)
  if (!confidence.ok) return confidence
  const answer: SystemOneAnswer = { type: 'choice', choice, probabilities }
  if (confidence.value !== undefined) answer.confidence = confidence.value
  return { ok: true, value: answer }
}

/** A score answer: rubric-sized index map, score equal to its expectation. */
function validateScoreAnswer(
  question: SystemOneQuestion,
  raw: Record<string, unknown>,
): { ok: true; value: SystemOneAnswer } | Failure {
  const criteria = question.criteria
  if (!Array.isArray(criteria)) return failure('invalid-request')
  const levels = criteria.length
  if (levels < MIN_SCORE_LEVELS) return failure('invalid-request')
  const expected = new Set(Array.from({ length: levels }, (_, index) => String(index)))
  const probabilities = readProbabilities(raw.probabilities, expected)
  if (probabilities === undefined) return failure('invalid-probabilities')
  const score = raw.score
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > levels - 1) {
    return failure('invalid-score')
  }
  // A non-integer score is allowed, but it must match its own distribution.
  let expectedScore = 0
  for (const [index, probability] of Object.entries(probabilities)) expectedScore += Number(index) * probability
  if (Math.abs(score - expectedScore) > PROBABILITY_TOLERANCE) return failure('invalid-score')
  const confidence = readConfidence(raw)
  if (!confidence.ok) return confidence
  const answer: SystemOneAnswer = { type: 'score', score, probabilities }
  if (confidence.value !== undefined) answer.confidence = confidence.value
  return { ok: true, value: answer }
}

/** A noul answer: unit-interval number; only `noul` and `confidence` survive. */
function validateNoulAnswer(raw: Record<string, unknown>): { ok: true; value: SystemOneAnswer } | Failure {
  const noul = raw.noul
  if (!isUnitInterval(noul)) return failure('invalid-noul')
  const confidence = readConfidence(raw)
  if (!confidence.ok) return confidence
  const answer: SystemOneAnswer = { type: 'noul', noul }
  if (confidence.value !== undefined) answer.confidence = confidence.value
  return { ok: true, value: answer }
}

/** Validate one answer entry against the question that requested it. */
function validateAnswer(
  question: SystemOneQuestion,
  raw: unknown,
): { ok: true; value: SystemOneAnswer } | Failure {
  if (!isPlainObject(raw)) return failure('answer-type-mismatch')
  if (!isPlainObject(question)) return failure('invalid-request')
  if (raw.type !== question.type) return failure('answer-type-mismatch')
  if (question.type === 'choice') return validateChoiceAnswer(question, raw)
  if (question.type === 'score') return validateScoreAnswer(question, raw)
  return validateNoulAnswer(raw)
}

/**
 * Validate one raw wire response against the questions that were asked. A
 * successful result keeps the server-reported model (never the request alias)
 * and a prototype-free answers map keyed exactly like the request.
 */
export function validateSystemOneResponse(
  questions: Record<string, SystemOneQuestion>,
  raw: unknown,
): { ok: true; value: ValidatedResponse } | Failure {
  if (!isPlainObject(raw)) return failure('invalid-envelope')
  const model = raw.model
  if (!isNonEmptyString(model) || model.length > MAX_MODEL_CHARS) return failure('invalid-model')
  if (!isPlainObject(questions)) return failure('invalid-request')
  const envelopeAnswers = raw.answers
  if (!isPlainObject(envelopeAnswers)) return failure('question-set-mismatch')
  // Exact key-set equality, order-independent: one missing answer, one extra
  // answer or a replaced answer rejects the whole response.
  const requested = Object.keys(questions)
  const answered = Object.keys(envelopeAnswers)
  if (answered.length !== requested.length) return failure('question-set-mismatch')
  const requestedSet = new Set(requested)
  for (const key of answered) {
    if (!requestedSet.has(key)) return failure('question-set-mismatch')
  }
  const answers: Record<string, SystemOneAnswer> = Object.create(null)
  for (const key of requested) {
    const question = questions[key]
    if (question === undefined) return failure('question-set-mismatch')
    const validated = validateAnswer(question, envelopeAnswers[key])
    if (!validated.ok) return validated
    answers[key] = validated.value
  }
  const usage = raw.usage
  if (!isPlainObject(usage)) return failure('invalid-usage')
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  // A legitimate zero is fine; a missing counter is never treated as zero.
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return failure('invalid-usage')
  return {
    ok: true,
    value: { model, answers, usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
  }
}
