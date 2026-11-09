#!/usr/bin/env node
/**
 * eval-discovery.mjs — offline evaluator for the S1-05 semantic tool-discovery
 * slice (`src/discovery.ts`). Design § "Implementation tasks and tests" and
 * § "Release gates and rollback".
 *
 * run: node packages/core/tool-search/scripts/eval-discovery.mjs \
 *        --corpus packages/core/tool-search/tests/fixtures/discovery-corpus.json \
 *        --mode replay
 *      node packages/core/tool-search/scripts/eval-discovery.mjs --mode selfcheck
 *
 * No network access, ever: this script reads one local corpus file and runs the
 * PURE policy layer. It never constructs a runner, opens a socket, or writes a
 * file. Aggregate numbers and case ids are printed; query text, candidate
 * descriptions, and notes never are (design § "Release gates": comparison
 * reports only, for explicitly supplied redacted fixtures).
 *
 * Approach — import the real source, not a mirror. Node ≥ 22.18 strips TypeScript
 * types by default, so a `.mjs` script can `import` a sibling `.ts` module
 * directly: the same precedent as `packages/interaction/permission-rules/scripts/
 * eval-gauge.mjs` (which imports `../src/gauge-adapter.ts`), minus the
 * `--experimental-strip-types` flag its older Node needed. `src/discovery.ts` is
 * dependency-free by design (no cordis, no clock, no I/O), which is exactly why
 * replay can drive the shipped `buildEligiblePool`, `buildQuestions`,
 * `expectedScore`, and `selectNames` instead of a structural copy that could
 * drift. `src/discovery-settings.ts` supplies `DEFAULT_DISCOVERY_SETTINGS`; it
 * pulls the schemastery settings runtime, so the workspace must be installed
 * (`pnpm install --frozen-lockfile`) — a missing install fails loudly instead of
 * silently scoring against invented defaults.
 *
 * Corpus schema (documented here because the fixture is data, not a test):
 *   { schemaVersion: 1, description?: string, cases: Case[] }   (a bare Case[]
 *   is also accepted, so a hand-written slice of the corpus works)
 *   Case = {
 *     id: string,                 // unique, kebab-case; the only case text ever printed
 *     subset: 'chinese' | 'synonym' | 'none' | 'restricted',
 *     query: string,
 *     candidates: Candidate[],
 *     expectedNames: string[],    // the human target set, post-admission
 *     notes?: string,
 *   }
 *   Candidate = {
 *     name: string, description: string, searchHint?: string,
 *     lexicalScore: number,       // the lexical baseline's score for this query
 *     admitted?: boolean,         // false = the scope's permission gate denies it
 *   }
 * Invariants enforced by `--mode selfcheck`: at least 8 `chinese`, 6 `synonym`,
 * 4 `none`, and 2 `restricted` cases; every `chinese`/`synonym` case keeps at
 * least one expected candidate at `lexicalScore: 0` (otherwise the subset does
 * not demonstrate the lexical blind spot it exists for); `restricted` cases
 * carry at least one `admitted: false` candidate; an expected name is never a
 * denied candidate, because a denied tool cannot be an activation target.
 *
 * Method (`--mode replay`): build the pool with the default admission and bounds
 * policy, build the two questions per candidate, then synthesize a deterministic
 * judgment from the corpus itself — a candidate is judged relevant iff its name
 * is in `expectedNames` (relevance answer Score 4 / direct-fit 0.9), irrelevant
 * otherwise (Score 0 / Noul 0.1). The score is read back through the shipped
 * `expectedScore`, so the probability-weighted path is exercised, and
 * `selectNames` runs with the default thresholds and `max_results = 3`
 * (Recall@3). The lexical control mirrors the existing `search()`: admitted
 * candidates with `lexicalScore > 0`, ranked by score and capped at five
 * (`LEXICAL_TOP_N`); its first three entries are what Recall@3 compares.
 *
 * Exit codes: 0 = replay/selfcheck succeeded; 1 = replay completed but was not
 * reproducible or not internally consistent; 2 = schema or usage violation.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEligiblePool, buildQuestions, expectedScore, selectNames } from '../src/discovery.ts'
import { DEFAULT_DISCOVERY_SETTINGS } from '../src/discovery-settings.ts'

/** The caller's `max_results` for the evaluator: Recall@3. */
const MAX_RESULTS = 3

/** The existing `search()` default result count, which the lexical control mirrors. */
const LEXICAL_TOP_N = 5

/** Corpus subsets, in report order. */
const SUBSETS = ['chinese', 'synonym', 'none', 'restricted']

/** Minimum number of cases each subset must carry (design § "Release gates"). */
const REQUIRED_COUNTS = { chinese: 8, synonym: 6, none: 4, restricted: 2 }

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CORPUS = join(here, '..', 'tests', 'fixtures', 'discovery-corpus.json')
const DEFAULT_CORPUS_DISPLAY = 'packages/core/tool-search/tests/fixtures/discovery-corpus.json'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const mode = argOf('--mode', 'replay')
if (mode !== 'replay' && mode !== 'selfcheck') {
  console.error(`eval-discovery: unknown --mode ${JSON.stringify(mode)} (expected replay | selfcheck)`)
  process.exit(2)
}

const corpusArg = argOf('--corpus', DEFAULT_CORPUS)
const corpusDisplay = argv.includes('--corpus') ? corpusArg : DEFAULT_CORPUS_DISPLAY

const fail = (message) => {
  console.error(`eval-discovery: ${message}`)
  process.exit(2)
}

let raw
try {
  raw = JSON.parse(readFileSync(corpusArg, 'utf8'))
} catch (error) {
  fail(`cannot read corpus ${corpusDisplay}: ${error instanceof Error ? error.message : String(error)}`)
}

/** Whether a parsed value is a plain object with the given own keys. */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0

/**
 * Validate the corpus against the schema above. Messages name the case id and
 * the field path only — never the query or a candidate description.
 * @param parsed - the parsed JSON document.
 * @returns the schema violations, and the cases when the top level is usable.
 */
function validateCorpus(parsed) {
  const errors = []
  const document = Array.isArray(parsed) ? { schemaVersion: 1, cases: parsed } : parsed
  if (!isObject(document)) return { errors: ['corpus must be an object or an array of cases'], cases: [] }
  if (!Array.isArray(document.cases)) return { errors: ['cases must be an array'], cases: [] }
  if (document.schemaVersion !== undefined && document.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion ${JSON.stringify(document.schemaVersion)} (expected 1)`)
  }

  const seenIds = new Set()
  const counts = Object.fromEntries(SUBSETS.map(subset => [subset, 0]))

  document.cases.forEach((entry, index) => {
    const where = isObject(entry) && isNonEmptyString(entry.id) ? entry.id : `cases[${index}]`
    if (!isObject(entry)) {
      errors.push(`${where}: case must be an object`)
      return
    }
    if (!isNonEmptyString(entry.id)) errors.push(`${where}: id must be a non-empty string`)
    else if (seenIds.has(entry.id)) errors.push(`${where}: duplicate id`)
    else seenIds.add(entry.id)
    if (entry.notes !== undefined && typeof entry.notes !== 'string') errors.push(`${where}: notes must be a string`)
    if (!SUBSETS.includes(entry.subset)) {
      errors.push(`${where}: subset must be one of ${SUBSETS.join(' | ')}`)
    } else {
      counts[entry.subset] += 1
    }
    if (!isNonEmptyString(entry.query)) errors.push(`${where}: query must be a non-empty string`)
    if (!Array.isArray(entry.candidates) || entry.candidates.length === 0) {
      errors.push(`${where}: candidates must be a non-empty array`)
      return
    }
    if (!Array.isArray(entry.expectedNames)) errors.push(`${where}: expectedNames must be an array`)
    else if (entry.expectedNames.some(name => !isNonEmptyString(name))) {
      errors.push(`${where}: every expectedNames entry must be a non-empty string`)
    }

    const byName = new Map()
    for (const [candidateIndex, candidate] of entry.candidates.entries()) {
      const at = `${where}: candidates[${candidateIndex}]`
      if (!isObject(candidate)) {
        errors.push(`${at} must be an object`)
        continue
      }
      if (!isNonEmptyString(candidate.name)) errors.push(`${at}.name must be a non-empty string`)
      else if (byName.has(candidate.name)) errors.push(`${at}.name duplicates ${candidate.name}`)
      else byName.set(candidate.name, candidate)
      if (!isNonEmptyString(candidate.description)) errors.push(`${at}.description must be a non-empty string`)
      if (candidate.searchHint !== undefined && typeof candidate.searchHint !== 'string') {
        errors.push(`${at}.searchHint must be a string`)
      }
      if (typeof candidate.lexicalScore !== 'number' || !Number.isFinite(candidate.lexicalScore)
        || candidate.lexicalScore < 0) {
        errors.push(`${at}.lexicalScore must be a finite number >= 0`)
      }
      if (candidate.admitted !== undefined && typeof candidate.admitted !== 'boolean') {
        errors.push(`${at}.admitted must be a boolean`)
      }
    }

    if (!Array.isArray(entry.expectedNames)) return
    for (const name of entry.expectedNames) {
      if (!isNonEmptyString(name)) continue
      const candidate = byName.get(name)
      if (candidate === undefined) errors.push(`${where}: expectedNames entry ${name} is not a candidate`)
      else if (candidate.admitted === false) {
        errors.push(`${where}: expectedNames entry ${name} is a denied candidate`)
      }
    }

    if (entry.subset === 'chinese' || entry.subset === 'synonym') {
      if (entry.expectedNames.length === 0) errors.push(`${where}: subset ${entry.subset} needs a target`)
      const zeroScored = entry.expectedNames.some(name => {
        const candidate = byName.get(name)
        return isObject(candidate) && candidate.lexicalScore === 0
      })
      if (entry.expectedNames.length > 0 && !zeroScored) {
        errors.push(`${where}: subset ${entry.subset} needs an expected candidate at lexicalScore 0`)
      }
    }
    if (entry.subset === 'restricted') {
      const denied = [...byName.values()].some(candidate => candidate.admitted === false)
      if (!denied) errors.push(`${where}: subset restricted needs an admitted: false candidate`)
    }
    if (entry.subset === 'none' && Array.isArray(entry.expectedNames) && entry.expectedNames.length > 0) {
      errors.push(`${where}: subset none must have an empty expectedNames`)
    }
  })

  for (const subset of SUBSETS) {
    if (counts[subset] < REQUIRED_COUNTS[subset]) {
      errors.push(`subset ${subset}: ${counts[subset]} case(s), expected at least ${REQUIRED_COUNTS[subset]}`)
    }
  }

  return { errors, cases: document.cases.filter(isObject), counts }
}

const validation = validateCorpus(raw)
if (validation.errors.length > 0) {
  for (const message of validation.errors) console.error(`eval-discovery: schema: ${message}`)
  fail(`${validation.errors.length} schema violation(s) in ${corpusDisplay}`)
}

const cases = validation.cases

if (mode === 'selfcheck') {
  console.log(`tool-discovery corpus selfcheck — ${corpusDisplay}`)
  console.log(`schemaVersion 1: ${cases.length} case(s) valid`)
  for (const subset of SUBSETS) {
    console.log(`  ${subset.padEnd(11)} ${String(validation.counts[subset]).padStart(3)}`)
  }
  process.exit(0)
}

/** One deferred entry per candidate; a denied candidate is never admitted. */
const entriesOf = (entry) => entry.candidates.map(candidate => ({
  name: candidate.name,
  description: candidate.description,
  ...candidate.searchHint !== undefined ? { searchHint: candidate.searchHint } : {},
  alwaysLoad: false,
  activated: false,
  admitted: candidate.admitted !== false,
  lexicalScore: candidate.lexicalScore,
}))

/**
 * The deterministic judgment: relevant iff the name is in the human target set.
 * `probabilities` carries the full 0..4 mass so the shipped `expectedScore`
 * computes the weighted value; `score` is the same value as a fallback.
 */
const answersFor = (candidates, expected) => {
  const answers = {}
  for (const candidate of candidates) {
    const relevant = expected.has(candidate.name)
    answers[`${candidate.id}_relevance`] = {
      type: 'score',
      probabilities: relevant ? { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1 } : { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 },
      score: relevant ? 4 : 0,
      confidence: 1,
    }
    answers[`${candidate.id}_direct`] = { type: 'noul', noul: relevant ? 0.9 : 0.1, confidence: 1 }
  }
  return answers
}

/**
 * Run one case through the pure layer.
 * @returns the activation names, the built question count, and whether the pool
 * fell back as a whole.
 */
const runCase = (entry) => {
  const expected = new Set(entry.expectedNames)
  const pool = buildEligiblePool(entriesOf(entry), entry.query, DEFAULT_DISCOVERY_SETTINGS)
  if (pool.kind !== 'pool') return { names: [], questions: 0, fallback: true }

  const questions = buildQuestions(pool.candidates)
  const answers = answersFor(pool.candidates, expected)
  const questionCount = Object.keys(questions).length
  // Every built question must have an answer: a key mismatch would silently
  // score an item as unusable instead of judging it.
  for (const key of Object.keys(questions)) {
    if (answers[key] === undefined) throw new Error(`no answer for question ${key}`)
  }

  const scored = []
  for (const candidate of pool.candidates) {
    const scoreIndex = expectedScore(answers, candidate.id)
    if (scoreIndex === undefined) throw new Error(`expectedScore returned undefined for ${candidate.id}`)
    scored.push({
      id: candidate.id,
      name: candidate.name,
      scoreIndex,
      noul: answers[`${candidate.id}_direct`].noul,
      lexicalScore: candidate.lexicalScore,
    })
  }

  const names = selectNames(scored, DEFAULT_DISCOVERY_SETTINGS, MAX_RESULTS)
  return { names, questions: questionCount, fallback: false }
}

/** The lexical control: what the existing `search()` would have activated. */
const lexicalControl = (entry) => {
  const ranked = entry.candidates
    .filter(candidate => candidate.admitted !== false && candidate.lexicalScore > 0)
    .sort((left, right) => right.lexicalScore - left.lexicalScore || left.name.localeCompare(right.name))
    .slice(0, LEXICAL_TOP_N)
    .map(candidate => candidate.name)
  return { top: ranked, top3: ranked.slice(0, MAX_RESULTS) }
}

const emptyBucket = () => ({
  cases: 0,
  targets: 0,
  semanticHits: 0,
  semanticActivations: 0,
  semanticCorrect: 0,
  lexicalHits: 0,
  lexicalActivations: 0,
  lexicalCorrect: 0,
  questions: 0,
  fallbacks: 0,
  leaks: 0,
  mismatches: 0,
})

const buckets = Object.fromEntries([...SUBSETS, 'overall'].map(name => [name, emptyBucket()]))
const mismatchedIds = []
const nonReproducibleIds = []
const leakedIds = []
const fallbackIds = []

for (const entry of cases) {
  const expected = new Set(entry.expectedNames)
  const denied = new Set(entry.candidates.filter(c => c.admitted === false).map(c => c.name))

  const first = runCase(entry)
  const second = runCase(entry)
  if (JSON.stringify(first) !== JSON.stringify(second)) nonReproducibleIds.push(entry.id)

  const selected = first.names
  const activationSet = new Set(selected)
  const semanticCorrect = selected.filter(name => expected.has(name)).length
  const leaked = selected.filter(name => denied.has(name)).length

  const control = lexicalControl(entry)
  const lexicalHits = control.top3.filter(name => expected.has(name)).length
  const lexicalCorrect = control.top.filter(name => expected.has(name)).length

  const matched = semanticCorrect === expected.size && activationSet.size === semanticCorrect
  if (!matched) mismatchedIds.push(entry.id)
  if (leaked > 0) leakedIds.push(entry.id)
  if (first.fallback) fallbackIds.push(entry.id)

  for (const bucket of [buckets[entry.subset], buckets.overall]) {
    bucket.cases += 1
    bucket.targets += expected.size
    bucket.semanticHits += semanticCorrect
    bucket.semanticActivations += selected.length
    bucket.semanticCorrect += semanticCorrect
    bucket.lexicalHits += lexicalHits
    bucket.lexicalActivations += control.top.length
    bucket.lexicalCorrect += lexicalCorrect
    bucket.questions += first.questions
    bucket.fallbacks += first.fallback ? 1 : 0
    bucket.leaks += leaked
    bucket.mismatches += matched ? 0 : 1
  }
}

const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator)
const show = value => (value === null ? 'n/a' : value.toFixed(3))
const column = (text, width) => String(text).padStart(width)

const header = [
  'subset'.padEnd(11),
  column('cases', 6),
  column('targets', 8),
  column('hit@3', 7),
  column('R@3', 7),
  column('lex hit@3', 10),
  column('lex R@3', 8),
  column('act', 5),
  column('ok', 4),
  column('P', 7),
  column('lex act', 8),
  column('lex ok', 7),
  column('lex P', 7),
].join(' ')

console.log('tool-discovery offline replay — aggregate report')
console.log(`corpus: ${corpusDisplay} (${cases.length} cases, schemaVersion 1)`)
console.log(
  `mode: replay — pure policy layer only; deterministic judgment derived from each case's expectedNames`,
)
console.log(
  `settings: cc-tool-discovery defaults (min-relevance-index ${DEFAULT_DISCOVERY_SETTINGS.minRelevanceIndex}, `
  + `min-direct-fit ${DEFAULT_DISCOVERY_SETTINGS.minDirectFit}, max-activations ${DEFAULT_DISCOVERY_SETTINGS.maxActivations}, `
  + `max-candidates ${DEFAULT_DISCOVERY_SETTINGS.maxCandidates}); max_results ${MAX_RESULTS} per case`,
)
console.log(
  `questions built: ${buckets.overall.questions} (two per pooled candidate); lexical control: admitted candidates with `
  + `lexicalScore > 0, top ${LEXICAL_TOP_N} by score, first ${MAX_RESULTS} scored as Recall@${MAX_RESULTS}`,
)
console.log('')
console.log(header)
for (const name of [...SUBSETS, 'overall']) {
  const bucket = buckets[name]
  console.log([
    name.padEnd(11),
    column(bucket.cases, 6),
    column(bucket.targets, 8),
    column(bucket.semanticHits, 7),
    column(show(ratio(bucket.semanticHits, bucket.targets)), 7),
    column(bucket.lexicalHits, 10),
    column(show(ratio(bucket.lexicalHits, bucket.targets)), 8),
    column(bucket.semanticActivations, 5),
    column(bucket.semanticCorrect, 4),
    column(show(ratio(bucket.semanticCorrect, bucket.semanticActivations)), 7),
    column(bucket.lexicalActivations, 8),
    column(bucket.lexicalCorrect, 7),
    column(show(ratio(bucket.lexicalCorrect, bucket.lexicalActivations)), 7),
  ].join(' '))
}
console.log('')

const overall = buckets.overall
const ids = list => (list.length === 0 ? 'none' : list.join(', '))

console.log(
  `recall@${MAX_RESULTS} vs lexical control: ${show(ratio(overall.semanticHits, overall.targets))} vs `
  + `${show(ratio(overall.lexicalHits, overall.targets))} (semantic minus lexical: `
  + `${show(ratio(overall.semanticHits - overall.lexicalHits, overall.targets))})`,
)
console.log(
  `activation precision: ${show(ratio(overall.semanticCorrect, overall.semanticActivations))} vs lexical `
  + `${show(ratio(overall.lexicalCorrect, overall.lexicalActivations))}; `
  + `activations ${overall.semanticActivations} vs ${overall.lexicalActivations}`,
)
console.log(`admission leaks: ${overall.leaks} (cases: ${ids(leakedIds)})`)
console.log(`whole-path pool fallbacks: ${overall.fallbacks} (cases: ${ids(fallbackIds)})`)
console.log(`target-set mismatches: ${overall.mismatches} (cases: ${ids(mismatchedIds)})`)
console.log(`reproducibility: ${nonReproducibleIds.length === 0 ? 'identical across two replays' : `DIFFERS (cases: ${ids(nonReproducibleIds)})`}`)

// Replay completed, but a result the policy layer must never produce did
// happen: a non-reproducible run or a denied activation. Distinct from a
// schema violation (exit 2) so a harness can tell the two apart.
if (nonReproducibleIds.length > 0 || overall.leaks > 0) {
  console.error('eval-discovery: replay failure — see the report above')
  process.exit(1)
}
process.exit(0)
