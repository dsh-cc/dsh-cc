#!/usr/bin/env node
/**
 * eval-recommendation.mjs — offline replay evaluator for the S1-06 advisory
 * skill-recommendation slice (`packages/skill/skill-recommender`).
 *
 * Design: `docs/plans/2026-11-02-systemone-06-skill-recommendation.md`
 * § "Implementation tasks and acceptance" (the corpus + script row) and
 * § "Release, rollback, and documentation" (the offline task battery).
 *
 * run: node packages/skill/skill-recommender/scripts/eval-recommendation.mjs \
 *        --corpus packages/skill/skill-recommender/tests/fixtures/recommendation-corpus.json \
 *        --mode replay
 *
 * NO MODEL CALL, EVER. Replay drives the REAL pure pipeline (`recommendSkills`
 * from `src/recommend.ts`: eligible pool, per-skill question pair, batches,
 * thresholds, ordering) with a deterministic fake runner whose answers come from
 * the corpus itself: for each judged skill, relevance 4.0 and prerequisites 1.0
 * when the case expects that skill, 0.0/0.0 otherwise, with a per-case `scores`
 * override so a case can miss one threshold while clearing the other (the
 * missing-prerequisites cases do exactly that). Answers carry full 0..4
 * probability mass, so the shipped `expectedScore` weighted path and
 * `scoreBatch` validation run for real. The single local re-derivation below is
 * a corpus-consistency cross-check, marked as such — eligibility, batching,
 * thresholds, ordering and truncation are the shipped code's, never a mirror.
 *
 * Approach — import the real source. Node ≥ 22.18 strips TypeScript types, so
 * this `.mjs` imports the sibling `.ts` modules directly, exactly as
 * `packages/core/tool-search/scripts/eval-discovery.mjs` does. `src/recommend.ts`
 * and `src/pool.ts` are dependency-free by design; `src/settings.ts` supplies
 * `DEFAULT_RECOMMENDATION_SETTINGS` and pulls the schemastery settings runtime,
 * so the workspace must be installed (`pnpm install --frozen-lockfile`).
 *
 * Corpus schema (documented here because the fixture is data, not a test):
 *   { schemaVersion: 1, description?, cases: Case[] }; a bare Case[] also works.
 *   Case = { id, rationale, task, skills: Descriptor[], expected: string[],
 *            scores?: { [name]: { relevance?, prerequisites? } },
 *            forbidden?, withheld?: { name, reason }[], mandated?, notes? }
 *   Descriptor = { name, description?, whenToUse?, source, modelInvocable }
 *   Rationale = 'complementary' | 'chinese-synonym' | 'missing-prerequisites'
 *     | 'explicit-skill' | 'mandatory-skill' | 'paths-gated'
 *     | 'user-invocable-only' | 'model-invocation-forbidden'
 *
 * Schema invariants (exit 2): ≥12 cases and the per-rationale minimums below;
 * every `expected` name is visible and model-invocable, never forbidden or
 * withheld; `forbidden` names are absent or `modelInvocable: false`;
 * `withheld` names are absent from `skills`; `mandated` names stay in the
 * catalog; a `chinese-synonym` task carries no ASCII letters, a
 * `missing-prerequisites` case carries a skill above `min-relevance-index` but
 * below `min-prerequisites-met`, an `explicit-skill` task names a skill
 * verbatim, `complementary` expects ≥2 skills, and `mandatory-skill` carries a
 * `mandated` name.
 *
 * Per case the replay also asserts: judgments cover exactly the eligible pool
 * (visible, model-invocable, unique-name, ascending name order); two questions
 * per judged skill; no forbidden, withheld or non-model-invocable name was ever
 * sent; every recommendation clears both thresholds; the returned set and order
 * equal `expected`; and two replays are identical.
 *
 * Privacy: only case ids, rationales, counts and failure reasons are printed —
 * never task text or skill metadata.
 *
 * Exit codes: 0 = every case passed; 1 = at least one failing case; 2 = usage
 * or corpus schema violation.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { recommendSkills } from '../src/recommend.ts'
import { DEFAULT_RECOMMENDATION_SETTINGS } from '../src/settings.ts'

/** Coverage categories, in report order, with the minimum cases each one needs. */
const REQUIRED_COUNTS = {
  complementary: 2,
  'chinese-synonym': 3,
  'missing-prerequisites': 2,
  'explicit-skill': 2,
  'mandatory-skill': 1,
  'paths-gated': 1,
  'user-invocable-only': 1,
  'model-invocation-forbidden': 1,
}
const RATIONALES = Object.keys(REQUIRED_COUNTS)

/** The release battery starts at 120 human tasks; the offline fixture floor is 12. */
const MIN_CASES = 12

/** Replay scoring of an expected skill: clears both default thresholds. */
const EXPECTED_RELEVANCE = 4
const EXPECTED_PREREQUISITES = 1

/** A withheld skill's reason (absence from the catalog is always "not visible"). */
const WITHHELD_REASONS = [
  'paths-not-triggered', 'user-invocable-only', 'model-invocation-forbidden', 'plugin-not-loaded', 'other-scope',
]

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CORPUS = join(here, '..', 'tests', 'fixtures', 'recommendation-corpus.json')
const DEFAULT_CORPUS_DISPLAY = 'packages/skill/skill-recommender/tests/fixtures/recommendation-corpus.json'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const fail = (message, code = 2) => {
  console.error(`eval-recommendation: ${message}`)
  process.exit(code)
}

for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index]
  if (flag === '--corpus' || flag === '--mode') index += 1
  else fail(`unknown argument ${JSON.stringify(flag)} — usage: eval-recommendation.mjs [--corpus <path>] [--mode replay]`)
}

const mode = argOf('--mode', 'replay')
if (mode !== 'replay') fail(`unknown --mode ${JSON.stringify(mode)} (expected replay)`)
const corpusArg = argOf('--corpus', DEFAULT_CORPUS)
const corpusDisplay = argv.includes('--corpus') ? corpusArg : DEFAULT_CORPUS_DISPLAY

let raw
try {
  raw = JSON.parse(readFileSync(corpusArg, 'utf8'))
} catch (error) {
  fail(`cannot read corpus ${corpusDisplay}: ${error instanceof Error ? error.message : String(error)}`)
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isName = value => typeof value === 'string' && value.trim().length > 0
const isFiniteIn = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/**
 * Validate the corpus against the schema and the category invariants. Messages
 * name the case id and the field path only — never task text.
 * @param parsed - the parsed JSON document.
 * @returns the violations, plus the usable cases and per-category counts.
 */
function validateCorpus(parsed) {
  const errors = []
  const document = Array.isArray(parsed) ? { schemaVersion: 1, cases: parsed } : parsed
  if (!isObject(document)) return { errors: ['corpus must be an object or an array of cases'], cases: [], counts: {} }
  if (!Array.isArray(document.cases)) return { errors: ['cases must be an array'], cases: [], counts: {} }
  if (document.schemaVersion !== undefined && document.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion ${JSON.stringify(document.schemaVersion)} (expected 1)`)
  }

  const seenIds = new Set()
  const counts = Object.fromEntries(RATIONALES.map(rationale => [rationale, 0]))

  document.cases.forEach((entry, index) => {
    const where = isObject(entry) && isName(entry.id) ? entry.id : `cases[${index}]`
    if (!isObject(entry)) return errors.push(`${where}: case must be an object`)
    if (!isName(entry.id)) errors.push(`${where}: id must be a non-empty string`)
    else if (seenIds.has(entry.id)) errors.push(`${where}: duplicate id`)
    else seenIds.add(entry.id)
    if (entry.notes !== undefined && typeof entry.notes !== 'string') errors.push(`${where}: notes must be a string`)
    if (!RATIONALES.includes(entry.rationale)) {
      return errors.push(`${where}: rationale must be one of ${RATIONALES.join(' | ')}`)
    }
    counts[entry.rationale] += 1
    if (!isName(entry.task)) errors.push(`${where}: task must be a non-empty string`)
    if (!Array.isArray(entry.skills) || entry.skills.length === 0) {
      return errors.push(`${where}: skills must be a non-empty array`)
    }
    if (!Array.isArray(entry.expected) || entry.expected.some(name => !isName(name))) {
      return errors.push(`${where}: expected must be an array of non-empty names`)
    }

    const byName = new Map()
    for (const [skillIndex, skill] of entry.skills.entries()) {
      const at = `${where}: skills[${skillIndex}]`
      if (!isObject(skill)) {
        errors.push(`${at} must be an object`)
        continue
      }
      if (!isName(skill.name)) errors.push(`${at}.name must be a non-empty string`)
      else if (byName.has(skill.name)) errors.push(`${at}.name duplicates ${skill.name}`)
      else byName.set(skill.name, skill)
      for (const field of ['description', 'whenToUse']) {
        if (skill[field] !== undefined && !isName(skill[field])) {
          errors.push(`${at}.${field} must be a non-empty string`)
        }
      }
      if (!isName(skill.source)) errors.push(`${at}.source must be a non-empty string`)
      if (typeof skill.modelInvocable !== 'boolean') errors.push(`${at}.modelInvocable must be a boolean`)
    }

    const stringList = (field) => {
      const value = entry[field]
      if (value === undefined) return []
      if (Array.isArray(value) && value.every(isName)) return value
      errors.push(`${where}: ${field} must be an array of non-empty names`)
      return []
    }
    const forbidden = stringList('forbidden')
    const mandated = stringList('mandated')

    const withheldNames = []
    if (entry.withheld !== undefined && !Array.isArray(entry.withheld)) {
      errors.push(`${where}: withheld must be an array`)
    } else {
      for (const [withheldIndex, withheld] of (entry.withheld ?? []).entries()) {
        const at = `${where}: withheld[${withheldIndex}]`
        if (!isObject(withheld) || !isName(withheld.name)) {
          errors.push(`${at}.name must be a non-empty string`)
          continue
        }
        if (!WITHHELD_REASONS.includes(withheld.reason)) {
          errors.push(`${at}.reason must be one of ${WITHHELD_REASONS.join(' | ')}`)
        }
        withheldNames.push(withheld.name)
        if (byName.has(withheld.name)) errors.push(`${at}: ${withheld.name} is both withheld and visible`)
      }
    }
    for (const name of entry.expected) {
      const skill = byName.get(name)
      if (skill === undefined) errors.push(`${where}: expected ${name} is not a skill`)
      else if (skill.modelInvocable !== true) errors.push(`${where}: expected ${name} is not model-invocable`)
      if (forbidden.includes(name)) errors.push(`${where}: expected ${name} is forbidden`)
      if (withheldNames.includes(name)) errors.push(`${where}: expected ${name} is withheld`)
    }
    for (const name of forbidden) {
      const skill = byName.get(name)
      if (skill !== undefined && skill.modelInvocable !== false) {
        errors.push(`${where}: forbidden ${name} must be absent or modelInvocable: false`)
      }
    }
    for (const name of mandated) if (!byName.has(name)) errors.push(`${where}: mandated ${name} left the catalog`)

    const scores = entry.scores
    if (scores !== undefined && !isObject(scores)) errors.push(`${where}: scores must be an object`)
    else {
      for (const [name, score] of Object.entries(scores ?? {})) {
        if (!byName.has(name)) errors.push(`${where}: scores.${name} is not a skill`)
        if (!isObject(score)) {
          errors.push(`${where}: scores.${name} must be an object`)
          continue
        }
        if (score.relevance !== undefined && !isFiniteIn(score.relevance, 0, 4)) {
          errors.push(`${where}: scores.${name}.relevance must be a finite number in 0..4`)
        }
        if (score.prerequisites !== undefined && !isFiniteIn(score.prerequisites, 0, 1)) {
          errors.push(`${where}: scores.${name}.prerequisites must be a finite number in 0..1`)
        }
      }
    }

    // Category invariants: without them a case would pass for the wrong reason.
    if (entry.rationale === 'chinese-synonym' && /[A-Za-z]/.test(entry.task ?? '')) errors.push(`${where}: ASCII in a Chinese task`)
    if (entry.rationale === 'complementary' && entry.expected.length < 2) errors.push(`${where}: needs two expected skills`)
    if (entry.rationale === 'mandatory-skill' && mandated.length === 0) errors.push(`${where}: needs a mandated name`)
    if (entry.rationale === 'explicit-skill'
      && ![...byName.keys()].some(name => String(entry.task ?? '').includes(name))) {
      errors.push(`${where}: explicit-skill task must name one skill verbatim`)
    }
    if (entry.rationale === 'missing-prerequisites') {
      const effective = name => ({
        relevance: scores?.[name]?.relevance ?? (entry.expected.includes(name) ? EXPECTED_RELEVANCE : 0),
        prerequisites: scores?.[name]?.prerequisites ?? (entry.expected.includes(name) ? EXPECTED_PREREQUISITES : 0),
      })
      const missesOnlyPrerequisites = [...byName.keys()].some(name =>
        effective(name).relevance >= DEFAULT_RECOMMENDATION_SETTINGS.minRelevanceIndex
        && effective(name).prerequisites < DEFAULT_RECOMMENDATION_SETTINGS.minPrerequisitesMet)
      if (!missesOnlyPrerequisites) errors.push(`${where}: needs relevance ≥ threshold but prerequisites below it`)
    }
  })

  for (const rationale of RATIONALES) {
    if (counts[rationale] < REQUIRED_COUNTS[rationale]) {
      errors.push(`rationale ${rationale}: ${counts[rationale]} case(s), expected at least ${REQUIRED_COUNTS[rationale]}`)
    }
  }
  if (document.cases.length < MIN_CASES) {
    errors.push(`corpus has ${document.cases.length} case(s), expected at least ${MIN_CASES}`)
  }
  return { errors, cases: document.cases.filter(isObject), counts }
}

const validation = validateCorpus(raw)
if (validation.errors.length > 0) {
  for (const message of validation.errors) console.error(`eval-recommendation: schema: ${message}`)
  fail(`${validation.errors.length} schema violation(s) in ${corpusDisplay}`)
}

const cases = validation.cases
const settings = DEFAULT_RECOMMENDATION_SETTINGS

/** The relevance answer for a target expected value: probability mass on the two
 * rubric indices that bracket it, so the shipped `expectedScore` computes the
 * weighted value (the design's 3.7 / 0.1 code-writer example). */
function probabilitiesFor(relevance) {
  const base = Math.min(4, Math.floor(relevance))
  const fraction = relevance - base
  return fraction === 0 ? { [base]: 1 } : { [base]: 1 - fraction, [base + 1]: fraction }
}

/** The effective relevance/prerequisites pair per skill, corpus defaults included. */
function effectiveScores(entry) {
  const scores = new Map()
  for (const skill of entry.skills) {
    const override = entry.scores?.[skill.name]
    const expected = entry.expected.includes(skill.name)
    scores.set(skill.name, {
      relevance: override?.relevance ?? (expected ? EXPECTED_RELEVANCE : 0),
      prerequisites: override?.prerequisites ?? (expected ? EXPECTED_PREREQUISITES : 0),
    })
  }
  return scores
}

/** The deterministic fake runner: answers from the corpus's own expectations and
 * records every request, so the replay can assert what was and was not sent. */
function createFakeRunner(scores) {
  const requests = []
  return {
    requests,
    identifyRoute: () => ({
      provider: 'offline-replay', model: 'offline-replay', revision: 'offline-replay-v1',
      perRequestTokens: settings.maxInputTokens, perQuestionTokens: 256, maxQuestions: 256, maxOutputTokens: 256,
    }),
    scope: (originSeq = 0) => ({
      projectKey: 'offline-replay', sessionId: 'offline-replay', agentId: 'offline-replay', originSeq,
    }),
    async run(request) {
      requests.push(request)
      const answers = {}
      for (const item of request.state.skills) {
        const score = scores.get(item.name) ?? { relevance: 0, prerequisites: 0 }
        answers[`${item.id}_relevance`] = {
          type: 'score',
          probabilities: probabilitiesFor(score.relevance),
          score: score.relevance,
          confidence: 1,
        }
        answers[`${item.id}_prerequisites`] = { type: 'noul', noul: score.prerequisites, confidence: 1 }
      }
      return { status: 'answered', answers, decisionId: `replay-${requests.length}` }
    },
  }
}

/** Run one case through the real pure pipeline and return what the runner saw. */
async function runCase(entry) {
  const scores = effectiveScores(entry)
  const runner = createFakeRunner(scores)
  const outcome = await recommendSkills({
    task: entry.task,
    scope: runner.scope(0),
    signal: new AbortController().signal,
    // The pure layer only distinguishes the two judging modes; `off` never
    // reaches it (the wiring layer returns the off result without a runner call).
    mode: 'active',
    candidates: entry.skills,
    limits: settings,
    routeAlias: 'offline-replay',
  }, runner)

  const names = outcome.kind === 'recommended' ? outcome.recommendations.map(item => item.name) : []
  const sent = runner.requests.flatMap(request => request.state.skills)
  const questionKeys = runner.requests.flatMap(request => Object.keys(request.questions))
  return { outcome, scores, names, sent, questionKeys, requests: runner.requests.length }
}

const sameOrder = (left, right) => left.length === right.length && left.every((value, index) => value === right[index])

/** Corpus-consistency cross-check (NOT the policy): derive which skills clear both
 * thresholds from the case's own scores, so corpus and shipped ordering agree. */
function expectedSelection(entry, scores) {
  return [...new Set(entry.skills.filter(skill => skill.modelInvocable).map(skill => skill.name))]
    .filter(name => {
      const score = scores.get(name)
      return score.relevance >= settings.minRelevanceIndex && score.prerequisites >= settings.minPrerequisitesMet
    })
    .sort((left, right) =>
      scores.get(right).relevance - scores.get(left).relevance
      || scores.get(right).prerequisites - scores.get(left).prerequisites
      || left.localeCompare(right))
    .slice(0, settings.maxRecommendations)
}

/** Collect one case's failures; an empty list means the case passed. */
function checkCase(entry, first, second) {
  const problems = []
  const pool = [...new Set(entry.skills.filter(skill => skill.modelInvocable).map(skill => skill.name))]
    .sort((left, right) => left.localeCompare(right))
  const sentNames = first.sent.map(item => item.name)

  // 1. Eligibility: judgments cover exactly the eligible pool, ascending by name.
  if (!sameOrder(sentNames, pool)) {
    problems.push(`judged pool ${JSON.stringify(sentNames)} differs from the eligible pool ${JSON.stringify(pool)}`)
  }
  const excluded = [...(entry.forbidden ?? []), ...(entry.withheld ?? []).map(withheld => withheld.name)]
  for (const name of excluded) if (sentNames.includes(name)) problems.push(`excluded skill ${name} was judged`)
  for (const skill of entry.skills) {
    if (!skill.modelInvocable && sentNames.includes(skill.name)) {
      problems.push(`${skill.name} was judged but is not model-invocable`)
    }
  }
  for (const name of entry.expected) if (!sentNames.includes(name)) problems.push(`expected skill ${name} unjudged`)
  for (const name of entry.mandated ?? []) {
    if (!entry.skills.some(skill => skill.name === name)) problems.push(`mandated skill ${name} left the catalog`)
  }

  // 2. Questions: one relevance and one prerequisite question per judged skill.
  if (first.questionKeys.length !== sentNames.length * 2) {
    problems.push(`sent ${first.questionKeys.length} question(s), expected ${sentNames.length * 2}`)
  }
  for (const item of first.sent) {
    for (const key of [`${item.id}_relevance`, `${item.id}_prerequisites`]) {
      if (!first.questionKeys.includes(key)) problems.push(`missing question ${key}`)
    }
  }

  // 3. Result: `recommended` with exactly the corpus's target set, in order.
  if (first.outcome.kind !== 'recommended') problems.push(`outcome is ${first.outcome.kind}, expected recommended`)
  else if (!sameOrder(first.names, entry.expected)) {
    problems.push(`recommendations ${JSON.stringify(first.names)} differ from expected ${JSON.stringify(entry.expected)}`)
  }

  // 4. Thresholds: every recommendation clears both, per the case's own scores.
  for (const name of first.names) {
    const score = first.scores.get(name)
    if (score.relevance < settings.minRelevanceIndex) {
      problems.push(`recommended ${name} is below min-relevance-index (${score.relevance})`)
    }
    if (score.prerequisites < settings.minPrerequisitesMet) {
      problems.push(`recommended ${name} is below min-prerequisites-met (${score.prerequisites})`)
    }
  }

  // 5. Corpus consistency: selection, order and cap agree with those scores.
  const derived = expectedSelection(entry, first.scores)
  if (!sameOrder(first.names, derived)) {
    problems.push(`selection ${JSON.stringify(first.names)} disagrees with the corpus scores ${JSON.stringify(derived)}`)
  }

  // 6. Reproducibility: same corpus in, same judgments out.
  if (!sameOrder(first.names, second.names) || !sameOrder(sentNames, second.sent.map(item => item.name))) {
    problems.push('replay is not reproducible across two runs')
  }
  return problems
}

const totals = { cases: 0, recommendations: 0, requests: 0, questions: 0 }
const failedIds = []

console.log('skill-recommendation offline replay — per-case report')
console.log(`corpus: ${corpusDisplay} (${cases.length} cases, schemaVersion 1)`)
console.log('mode: replay — pure recommendation policy layer; deterministic fake scorer derived from each case')
console.log(`limits: cc-skill-recommendation defaults (min-relevance-index ${settings.minRelevanceIndex}, `
  + `min-prerequisites-met ${settings.minPrerequisitesMet}, max-recommendations ${settings.maxRecommendations}, `
  + `batch-size ${settings.batchSize}, max-candidates ${settings.maxCandidates})`)
console.log('')

for (const entry of cases) {
  const first = await runCase(entry)
  const second = await runCase(entry)
  const problems = checkCase(entry, first, second)

  totals.cases += 1
  totals.recommendations += first.names.length
  totals.requests += first.requests
  totals.questions += first.questionKeys.length

  const verdict = problems.length === 0 ? 'PASS' : 'FAIL'
  console.log(`${verdict} ${entry.id} [${entry.rationale}] expected ${entry.expected.length}, got ${first.names.length}`)
  if (problems.length > 0) {
    failedIds.push(entry.id)
    for (const problem of problems) console.log(`  - ${problem}`)
  }
}

const passed = totals.cases - failedIds.length
const rate = totals.cases === 0 ? 0 : passed / totals.cases

console.log('')
console.log('by rationale:')
for (const rationale of RATIONALES) {
  const total = validation.counts[rationale]
  const failed = cases.filter(entry => entry.rationale === rationale && failedIds.includes(entry.id)).length
  console.log(`  ${rationale.padEnd(28)} ${String(total - failed).padStart(3)}/${String(total).padEnd(3)} passed`)
}
console.log('')
console.log(
  `summary: ${passed}/${totals.cases} cases passed (pass rate ${rate.toFixed(3)}); `
  + `${totals.recommendations} recommendation(s), ${totals.requests} fake runner request(s), `
  + `${totals.questions} question(s) across the corpus`,
)
console.log('no model call was made: replay drives the pure policy layer with corpus-derived answers')

if (failedIds.length > 0) {
  console.error(`eval-recommendation: replay failure — failing case(s): ${failedIds.join(', ')}`)
  process.exit(1)
}
console.log('result: OK')
process.exit(0)
