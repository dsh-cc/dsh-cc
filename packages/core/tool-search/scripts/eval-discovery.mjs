#!/usr/bin/env node
/**
 * eval-discovery.mjs — offline evaluator for the SystemOne tool-discovery
 * layer. Design: `docs/plans/2026-11-12-tool-discovery-activation.md`
 * § "Runner" and § "Scoring".
 *
 * run: node packages/core/tool-search/scripts/eval-discovery.mjs --mode replay
 *      node packages/core/tool-search/scripts/eval-discovery.mjs --mode selfcheck
 *      node packages/core/tool-search/scripts/eval-discovery.mjs --mode judge-stub [--split tune|held-out|full]
 *      node packages/core/tool-search/scripts/eval-discovery.mjs --mode live
 *
 * Four arms, one corpus:
 *
 * - `replay` — the ORACLE pin. The judgment is synthesized from each case's
 *   `expectedNames`, so an F1 line here would be tautological. It stays a pure
 *   policy-layer pin (pool, questions, expectedScore, selectNames, lexical
 *   control) and is never gated on F1.
 * - `selfcheck` — schema integrity, per-subset and per-class counts.
 * - `judge-stub` — the CI-safe F1 GATE arm. A deterministic, non-oracle keyword
 *   judge (`scripts/lib/judge-stub.mjs`) scores candidate metadata; gold labels
 *   are only used for scoring, never for judging. Gated on the tune split.
 * - `live` — EVIDENCE arm. Drives the production `createDiscoveryRuntime` over
 *   the corpus through a scripted fake lane adapter (deterministic, CI-safe; a
 *   real-lane adapter is out of scope). Nominal latency/latency-tail and
 *   micro-F1 are reported UNGATED, and the failure battery (`unavailable`,
 *   `cancelled`, deadline exhaustion, over-cap pool, exact short-circuit) is
 *   asserted.
 *
 * No network access, ever: every arm reads one local corpus file and runs
 * in-process code. Aggregate numbers, class labels and case ids are printed;
 * query text, candidate descriptions and notes never are.
 *
 * Importing the real source, not a mirror: Node ≥ 22.18 strips TypeScript types
 * by default, so a `.mjs` script can `import` a sibling `.ts` module directly.
 * `src/discovery.ts` is dependency-free by design, which is exactly why the arms
 * drive the shipped `buildEligiblePool`, `buildQuestions`, `planBatches`,
 * `expectedScore` and `selectNames` instead of a structural copy that could
 * drift. `src/discovery-settings.ts` supplies `DEFAULT_DISCOVERY_SETTINGS`; it
 * pulls the schemastery settings runtime, so the workspace must be installed
 * and built (`pnpm install --frozen-lockfile && pnpm exec tsc -b`) — a missing
 * build fails loudly instead of silently scoring against invented defaults.
 *
 * Corpus schema, class labels and privacy rules: `scripts/lib/eval-corpus.mjs`.
 * Metric definitions (the pre-registration): `scripts/lib/eval-metrics.mjs`.
 *
 * Exit codes: 0 = the selected arm succeeded; 1 = the arm completed but a gate,
 * an assertion, or reproducibility failed; 2 = schema, configuration or usage
 * violation.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEligiblePool, buildQuestions, expectedScore, planBatches, selectNames } from '../src/discovery.ts'
import { DEFAULT_DISCOVERY_SETTINGS } from '../src/discovery-settings.ts'
import {
  CLASSES,
  REQUIRED_CLASS_COUNTS,
  REQUIRED_SUBSET_COUNTS,
  SUBSETS,
  validateCorpus,
} from './lib/eval-corpus.mjs'
import { stubAnswers } from './lib/judge-stub.mjs'
import {
  exactSetAccuracy,
  falseActivationRate,
  microF1,
  percentiles,
  splitCorpus,
} from './lib/eval-metrics.mjs'

/** The caller's `max_results` for the evaluator: Recall@3. */
const MAX_RESULTS = 3

/** The existing `search()` default result count, which the lexical control mirrors. */
const LEXICAL_TOP_N = 5

/** The arms this script offers. */
const MODES = ['replay', 'selfcheck', 'judge-stub', 'live']

/** The pre-registered splits; only `tune` is ever gated. */
const SPLITS = ['tune', 'held-out', 'full']

/** Pre-registered gate lines (design § "Scoring"; tune split only). */
const GATE = {
  /** Aggregate restricted micro-F1 floor. */
  aggregateF1: 0.85,
  /** Per-class restricted micro-F1 floor (classes with enough items and positives). */
  classF1: 0.8,
  /** False-activation ceiling for the negative-only class. */
  negativeFalseActivation: 0.1,
  /** Exact-set accuracy required for the negative-only class. */
  negativeExactSetAccuracy: 1,
}

/** A deliberately wide route: the offline arms are never window-limited. */
const ROUTE = {
  provider: 'offline',
  model: 'eval-route',
  revision: 'rev-1',
  perRequestTokens: 100_000,
  perQuestionTokens: 10_000,
  maxQuestions: 64,
  maxOutputTokens: 512,
}

/** The metering scope the fake lane reports; a judgment is pinned to it. */
const SCOPE = { projectKey: 'eval', sessionId: 'eval', agentId: 'eval', originSeq: 1 }

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CORPUS = join(here, '..', 'tests', 'fixtures', 'discovery-corpus.json')
const DEFAULT_CORPUS_DISPLAY = 'packages/core/tool-search/tests/fixtures/discovery-corpus.json'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

/** Print a usage/schema violation and stop with exit code 2. */
const fail = (message) => {
  console.error(`eval-discovery: ${message}`)
  process.exit(2)
}

const mode = argOf('--mode', 'replay')
if (!MODES.includes(mode)) {
  fail(`unknown --mode ${JSON.stringify(mode)} (expected ${MODES.join(' | ')})`)
}

const splitName = argOf('--split', 'tune')
if (!SPLITS.includes(splitName)) {
  fail(`unknown --split ${JSON.stringify(splitName)} (expected ${SPLITS.join(' | ')})`)
}

const corpusArg = argOf('--corpus', DEFAULT_CORPUS)
const corpusDisplay = argv.includes('--corpus') ? corpusArg : DEFAULT_CORPUS_DISPLAY

let raw
try {
  raw = JSON.parse(readFileSync(corpusArg, 'utf8'))
} catch (error) {
  fail(`cannot read corpus ${corpusDisplay}: ${error instanceof Error ? error.message : String(error)}`)
}

const validation = validateCorpus(raw)
// A malformed document is fatal for every arm. A coverage-floor deficit is
// fatal for `selfcheck` (the corpus-health gate) but not for a scoring arm: the
// corpus is grown by a separate slice, and a scoring run must still be able to
// report over the corpus as it stands. Floors are printed either way.
const structuralErrors = validation.errors.filter(message => !validation.floors.includes(message))
if (structuralErrors.length > 0) {
  for (const message of validation.errors) console.error(`eval-discovery: schema: ${message}`)
  fail(`${structuralErrors.length} schema violation(s) in ${corpusDisplay}`)
}
if (validation.floors.length > 0) {
  for (const message of validation.floors) console.error(`eval-discovery: corpus floor: ${message}`)
  if (mode === 'selfcheck') fail(`${validation.floors.length} corpus floor violation(s) in ${corpusDisplay}`)
}

const cases = validation.cases
const counts = validation.counts
const corpusVersion = raw.corpusVersion

/** One deferred entry per candidate; a denied candidate is never admitted. */
const entriesOf = caseEntry => caseEntry.candidates.map(candidate => ({
  name: candidate.name,
  description: candidate.description,
  ...candidate.searchHint !== undefined ? { searchHint: candidate.searchHint } : {},
  alwaysLoad: false,
  activated: false,
  admitted: candidate.admitted !== false,
  lexicalScore: candidate.lexicalScore,
}))

/** The lexical control: what the existing `search()` would have activated. */
const lexicalControl = caseEntry => {
  const ranked = caseEntry.candidates
    .filter(candidate => candidate.admitted !== false && candidate.lexicalScore > 0)
    .sort((left, right) => right.lexicalScore - left.lexicalScore || left.name.localeCompare(right.name))
    .slice(0, LEXICAL_TOP_N)
    .map(candidate => candidate.name)
  return { top: ranked, top3: ranked.slice(0, MAX_RESULTS) }
}

const ratio = (numerator, denominator) => (denominator === 0 ? null : numerator / denominator)
const show = value => (value === null || value === undefined ? 'n/a' : value.toFixed(3))
const column = (text, width) => String(text).padStart(width)
const ids = list => (list.length === 0 ? 'none' : list.join(', '))

/** The class labels one case belongs to, primary first. */
const membershipsOf = caseEntry => [caseEntry.class, ...(caseEntry.alsoClasses ?? [])]

/** The pre-registered split over the corpus cases. */
const splitOf = () => {
  const split = splitCorpus(cases)
  if (splitName === 'tune') return split.tune
  if (splitName === 'held-out') return split.heldOut
  return cases
}

// ---------------------------------------------------------------------------
// selfcheck — schema pin, per-subset and per-class counts
// ---------------------------------------------------------------------------

if (mode === 'selfcheck') {
  console.log(`tool-discovery corpus selfcheck — ${corpusDisplay}`)
  console.log(`schemaVersion 2, corpusVersion ${corpusVersion}: ${cases.length} case(s) valid`)
  console.log('subset counts (legacy filter):')
  for (const subset of SUBSETS) {
    console.log(`  ${subset.padEnd(12)} ${String(counts[subset]).padStart(3)}  (floor ${REQUIRED_SUBSET_COUNTS[subset]})`)
  }
  console.log('class counts (gating dimension, primary + alsoClasses):')
  for (const label of CLASSES) {
    console.log(`  ${label.padEnd(17)} ${String(counts[label]).padStart(3)}  (floor ${REQUIRED_CLASS_COUNTS[label]})`)
  }
  process.exit(0)
}

// ---------------------------------------------------------------------------
// replay — the oracle pin (behavior preserved from the pre-v2 evaluator)
// ---------------------------------------------------------------------------

/** The deterministic oracle judgment: relevant iff the name is in the target set. */
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
 * Run one case through the pure layer with the oracle judgment.
 * @returns the activation names, the built question count, and whether the pool
 * fell back as a whole.
 */
const runOracleCase = (caseEntry) => {
  const expected = new Set(caseEntry.expectedNames)
  const pool = buildEligiblePool(entriesOf(caseEntry), caseEntry.query, DEFAULT_DISCOVERY_SETTINGS)
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

  return { names: selectNames(scored, DEFAULT_DISCOVERY_SETTINGS, MAX_RESULTS), questions: questionCount, fallback: false }
}

if (mode === 'replay') {
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

  for (const caseEntry of cases) {
    const expected = new Set(caseEntry.expectedNames)
    const denied = new Set(caseEntry.candidates.filter(candidate => candidate.admitted === false).map(candidate => candidate.name))

    const first = runOracleCase(caseEntry)
    const second = runOracleCase(caseEntry)
    if (JSON.stringify(first) !== JSON.stringify(second)) nonReproducibleIds.push(caseEntry.id)

    const selected = first.names
    const activationSet = new Set(selected)
    const semanticCorrect = selected.filter(name => expected.has(name)).length
    const leaked = selected.filter(name => denied.has(name)).length

    const control = lexicalControl(caseEntry)
    const lexicalHits = control.top3.filter(name => expected.has(name)).length
    const lexicalCorrect = control.top.filter(name => expected.has(name)).length

    const matched = semanticCorrect === expected.size && activationSet.size === semanticCorrect
    if (!matched) mismatchedIds.push(caseEntry.id)
    if (leaked > 0) leakedIds.push(caseEntry.id)
    if (first.fallback) fallbackIds.push(caseEntry.id)

    for (const bucket of [buckets[caseEntry.subset], buckets.overall]) {
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
  console.log(`corpus: ${corpusDisplay} (${cases.length} cases, schemaVersion 2, corpusVersion ${corpusVersion})`)
  console.log(
    'mode: replay — pure policy layer only; deterministic judgment derived from each case\'s expectedNames',
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
}

// ---------------------------------------------------------------------------
// Shared case runner for the scoring arms (judge-stub, live)
// ---------------------------------------------------------------------------

/**
 * Judge one case with a caller-supplied answer function and collapse it through
 * the shipped `expectedScore` / `selectNames`.
 * @returns the ordered plan facts and the activation names.
 */
const judgeCase = (caseEntry, answersOf) => {
  const pool = buildEligiblePool(entriesOf(caseEntry), caseEntry.query, DEFAULT_DISCOVERY_SETTINGS)
  if (pool.kind !== 'pool') return { fallback: true, names: [], judged: 0, batches: 0, answers: {}, questions: {} }
  const plan = planBatches(pool.candidates, DEFAULT_DISCOVERY_SETTINGS.batchSize, ROUTE, caseEntry.query)
  const questions = buildQuestions(pool.candidates)
  const answers = answersOf(pool.candidates, caseEntry.query)
  for (const key of Object.keys(questions)) {
    if (answers[key] === undefined) throw new Error(`no answer for question ${key}`)
  }
  const scored = []
  for (const candidate of pool.candidates) {
    const scoreIndex = expectedScore(answers, candidate.id)
    const noul = answers[`${candidate.id}_direct`]?.noul
    if (scoreIndex === undefined || noul === undefined) {
      throw new Error(`unusable answer for ${candidate.id}`)
    }
    scored.push({ id: candidate.id, name: candidate.name, scoreIndex, noul, lexicalScore: candidate.lexicalScore })
  }
  return {
    fallback: plan.kind !== 'batches',
    names: selectNames(scored, DEFAULT_DISCOVERY_SETTINGS, MAX_RESULTS),
    judged: pool.candidates.length,
    batches: plan.kind === 'batches' ? plan.batches.length : 0,
    answers,
    questions,
  }
}

/** Empty aggregation bucket for one class (or the aggregate row). */
const emptyBucket = () => ({ cases: 0, restricted: [], unrestricted: [], exact: [], activated: [], candidates: [] })

/** Score one case's labels into every bucket it belongs to. */
const scoreCase = (caseEntry, names) => {
  const predicted = new Set(names)
  const gold = new Set(caseEntry.expectedNames)
  const admitted = caseEntry.candidates.filter(candidate => candidate.admitted !== false)
  const restricted = admitted.map(candidate => ({ gold: gold.has(candidate.name), predicted: predicted.has(candidate.name) }))
  const unrestricted = caseEntry.candidates.map(candidate => ({
    gold: gold.has(candidate.name),
    predicted: predicted.has(candidate.name),
  }))
  return {
    restricted,
    unrestricted,
    exact: { predicted: [...predicted], gold: [...gold] },
    activated: names.length,
    candidates: caseEntry.candidates.length,
  }
}

/** Render one scoring table row. */
const tableRow = (label, bucket) => {
  const restricted = microF1(bucket.restricted)
  const unrestricted = microF1(bucket.unrestricted)
  const exact = exactSetAccuracy(bucket.exact)
  return [
    label.padEnd(17),
    column(bucket.cases, 6),
    column(bucket.restricted.filter(pair => pair.gold).length, 6),
    column(restricted.f1 === null ? 'n/a' : show(restricted.f1), 9),
    column(unrestricted.f1 === null ? 'n/a' : show(unrestricted.f1), 9),
    column(exact === null ? 'n/a' : show(exact), 7),
  ].join(' ')
}

// ---------------------------------------------------------------------------
// judge-stub — the deterministic non-oracle F1 gate arm
// ---------------------------------------------------------------------------

if (mode === 'judge-stub') {
  const selected = splitOf()
  const buckets = { overall: emptyBucket() }
  for (const label of CLASSES) buckets[label] = emptyBucket()
  const fallbackIds = []
  const divergentIds = []
  let judged = 0
  let batches = 0
  let questionBytes = 0

  for (const caseEntry of selected) {
    const first = judgeCase(caseEntry, stubAnswers)
    const second = judgeCase(caseEntry, stubAnswers)
    if (JSON.stringify({ names: first.names, judged: first.judged, batches: first.batches })
      !== JSON.stringify({ names: second.names, judged: second.judged, batches: second.batches })) {
      divergentIds.push(caseEntry.id)
    }
    if (first.fallback) fallbackIds.push(caseEntry.id)
    judged += first.judged
    batches += first.batches
    questionBytes += Buffer.byteLength(JSON.stringify(first.questions), 'utf8')

    const scored = scoreCase(caseEntry, first.names)
    for (const bucket of [buckets.overall, ...membershipsOf(caseEntry).map(label => buckets[label])]) {
      bucket.cases += 1
      bucket.restricted.push(...scored.restricted)
      bucket.unrestricted.push(...scored.unrestricted)
      bucket.exact.push(scored.exact)
      bucket.activated.push(scored.activated)
      bucket.candidates.push(scored.candidates)
    }
  }

  console.log('tool-discovery eval — judge-stub arm (deterministic keyword judge, non-oracle)')
  console.log(`corpus: ${corpusDisplay} (${cases.length} cases, schemaVersion 2, corpusVersion ${corpusVersion})`)
  console.log(`split: ${splitName} (${selected.length} of ${cases.length} cases; only tune is gated, held-out is reserved for the flip evaluation)`)
  console.log(
    `settings: cc-tool-discovery defaults (min-relevance-index ${DEFAULT_DISCOVERY_SETTINGS.minRelevanceIndex}, `
    + `min-direct-fit ${DEFAULT_DISCOVERY_SETTINGS.minDirectFit}, batch-size ${DEFAULT_DISCOVERY_SETTINGS.batchSize}); `
    + `max_results ${MAX_RESULTS} per case`,
  )
  console.log(`judged: ${judged} candidate(s) in ${batches} batch(es); question-map JSON ${questionBytes} bytes`)
  console.log(`whole-path pool fallbacks: ${fallbackIds.length} (cases: ${ids(fallbackIds)})`)
  console.log('')
  console.log([
    'class'.padEnd(17),
    column('items', 6),
    column('gold+', 6),
    column('F1 restr', 9),
    column('F1 unre', 9),
    column('exact', 7),
  ].join(' '))
  for (const label of CLASSES) console.log(tableRow(label, buckets[label]))
  console.log(tableRow('overall', buckets.overall))
  const negative = falseActivationRate(buckets['negative-only'].activated, buckets['negative-only'].candidates)
  console.log('')
  console.log(
    `negative-only false activation: ${negative.rate === null ? 'n/a' : show(negative.rate)} `
    + `(${negative.activated}/${negative.candidates} candidates over ${buckets['negative-only'].cases} case(s))`,
  )

  // Gate evaluation: tune split only (held-out and full are reported, never gated).
  const gateLines = []
  const gated = splitName === 'tune'
  const addGate = (label, value, floor, comparator) => {
    const ok = value !== null && (comparator === 'atLeast' ? value >= floor : value <= floor)
    gateLines.push({
      label,
      ok,
      detail: value === null ? 'n/a (undefined)' : `${show(value)} ${comparator === 'atLeast' ? '>=' : '<='} ${show(floor)}`,
    })
  }
  const aggregate = microF1(buckets.overall.restricted)
  if (gated) {
    addGate('aggregate restricted micro-F1', aggregate.f1, GATE.aggregateF1, 'atLeast')
    for (const label of CLASSES) {
      const bucket = buckets[label]
      if (label === 'negative-only') {
        if (bucket.cases === 0) continue
        const miss = falseActivationRate(bucket.activated, bucket.candidates)
        addGate(`class negative-only false-activation`, miss.rate, GATE.negativeFalseActivation, 'atMost')
        addGate(`class negative-only exact-set accuracy`, exactSetAccuracy(bucket.exact), GATE.negativeExactSetAccuracy, 'atLeast')
        continue
      }
      const hasPositive = bucket.restricted.some(pair => pair.gold)
      if (bucket.cases < REQUIRED_CLASS_COUNTS[label] || !hasPositive) {
        const reason = bucket.cases < REQUIRED_CLASS_COUNTS[label]
          ? `${bucket.cases} item(s), below the ${REQUIRED_CLASS_COUNTS[label]}-item class floor`
          : 'no gold positives in this split'
        gateLines.push({ label: `class ${label} restricted micro-F1`, ok: null, detail: `n/a (${reason})` })
        continue
      }
      addGate(`class ${label} restricted micro-F1`, microF1(bucket.restricted).f1, GATE.classF1, 'atLeast')
    }
  }

  console.log('')
  console.log(`gates (split: ${splitName}${gated ? '' : ' — NOT gated: only the tune split gates'})`)
  if (!gated) console.log('  report-only  held-out and full splits are reported, never gated')
  for (const line of gateLines) {
    const verdict = line.ok === null ? 'n/a ' : line.ok ? 'PASS' : 'FAIL'
    console.log(`  ${verdict}  ${line.label.padEnd(42)} ${line.detail}`)
  }
  console.log(`determinism: ${divergentIds.length === 0 ? 'identical across two runs per case' : `DIFFERS (cases: ${ids(divergentIds)})`}`)

  const failed = gateLines.filter(line => line.ok === false).length
  const blocked = divergentIds.length > 0
  const verdict = blocked
    ? `FAIL (${failed} gate(s), ${divergentIds.length} divergent case(s))`
    : gated && failed > 0
      ? `FAIL (${failed} gate(s))`
      : gated ? 'PASS' : `report-only (split ${splitName} is not gated)`
  console.log(`result: ${verdict}`)
  process.exit(blocked || (gated && failed > 0) ? 1 : 0)
}

// ---------------------------------------------------------------------------
// live — the production runtime over a scripted fake lane (evidence arm)
// ---------------------------------------------------------------------------

/**
 * One scripted lane: the `identifyRoute` / `scope` / `run` faces the runtime
 * consumes. Deterministic, in-process, and never a network call.
 */
class ScriptedLane {
  constructor() {
    /** Every request this lane was asked to answer. */
    this.requests = []
    /** `answered` (stub judge) or `unavailable` (a runner refusal). */
    this.behavior = 'answered'
  }

  identifyRoute() {
    return ROUTE
  }

  scope() {
    return SCOPE
  }

  async run(request) {
    this.requests.push(request)
    if (this.behavior === 'unavailable') return { status: 'unavailable', reason: 'timeout', decisionId: 'd1' }
    const state = request.state
    return {
      status: 'answered',
      answers: stubAnswers(state.candidates, state.query),
      decisionId: `d${this.requests.length}`,
    }
  }
}

/** A fresh runtime per scenario, with a fresh in-memory cache. */
const makeRuntime = async ({ runtimeMode, entries, lane, now }) => {
  const { createDiscoveryRuntime } = await import('../src/discovery-runtime.ts')
  const { DiscoveryCache } = await import('../src/discovery-cache.ts')
  return createDiscoveryRuntime({
    readSettings: () => ({ ...DEFAULT_DISCOVERY_SETTINGS, mode: runtimeMode }),
    snapshotEntries: () => entries,
    resolveRunner: () => lane,
    cache: new DiscoveryCache({ maxEntries: 16, ttlMs: 60_000 }),
    warn: () => {},
    ...now === undefined ? {} : { now },
  })
}

/** One synthesized entry list: replicated candidates, unique names. */
const replicateEntries = (caseEntry, total) => {
  const entries = []
  for (let index = 0; index < total; index += 1) {
    const source = caseEntry.candidates[index % caseEntry.candidates.length]
    entries.push({
      name: `${source.name}_${index}`,
      description: source.description,
      alwaysLoad: false,
      activated: false,
      admitted: true,
      lexicalScore: 0,
    })
  }
  return entries
}

/** Run one `evaluate` call and classify its outcome for an assertion. */
const outcomeOf = evaluation => (evaluation.kind === 'lexical' ? `lexical:${evaluation.reason}` : evaluation.kind)

const assertions = []
const assert = (label, ok, detail) => {
  assertions.push({ label, ok: Boolean(ok), detail })
}

if (mode === 'live') {
  let createRuntimeFailure
  try {
    await makeRuntime({ runtimeMode: 'shadow', entries: [], lane: new ScriptedLane() })
  } catch (error) {
    createRuntimeFailure = error
  }
  if (createRuntimeFailure !== undefined) {
    fail(
      `cannot load the production runtime (${createRuntimeFailure instanceof Error ? createRuntimeFailure.message : String(createRuntimeFailure)})`,
    )
  }

  const selected = splitOf()
  const latency = []
  let selectedCount = 0
  let lexicalCount = 0
  let cancelledCount = 0
  let requestCount = 0
  let questionBytes = 0
  let judgedCount = 0
  const nominalPairs = []
  const fallbackIds = []

  const baseCase = cases[0]
  for (const caseEntry of selected) {
    const lane = new ScriptedLane()
    const entries = entriesOf(caseEntry)
    const runtime = await makeRuntime({ runtimeMode: 'active', entries, lane })
    const startedAt = Date.now()
    const evaluation = await runtime.evaluate({
      query: caseEntry.query,
      maxResults: MAX_RESULTS,
      actor: {},
      lexicalNames: lexicalControl(caseEntry).top,
    })
    latency.push(Date.now() - startedAt)

    for (const request of lane.requests) {
      requestCount += 1
      questionBytes += Buffer.byteLength(JSON.stringify(request.questions), 'utf8')
      judgedCount += request.state.candidates.length
    }

    const names = evaluation.kind === 'selected' ? evaluation.names : []
    if (evaluation.kind === 'selected') selectedCount += 1
    else if (evaluation.kind === 'lexical') lexicalCount += 1
    else cancelledCount += 1
    if (evaluation.kind === 'lexical' && evaluation.reason === 'bounds') fallbackIds.push(caseEntry.id)

    const gold = new Set(caseEntry.expectedNames)
    const predicted = new Set(names)
    for (const candidate of caseEntry.candidates) {
      if (candidate.admitted === false) continue
      nominalPairs.push({ gold: gold.has(candidate.name), predicted: predicted.has(candidate.name) })
    }
  }

  const nominal = microF1(nominalPairs)
  const latencyPercentiles = percentiles(latency)

  assert('nominal: every case judged (no lexical fallback, no cancellation)',
    selectedCount === selected.length && lexicalCount === 0 && cancelledCount === 0,
    `${selectedCount} selected, ${lexicalCount} lexical, ${cancelledCount} cancelled of ${selected.length}`)
  assert('nominal: the fake lane answered at least one request', requestCount > 0, `${requestCount} request(s)`)

  const unavailableLane = new ScriptedLane()
  unavailableLane.behavior = 'unavailable'
  const unavailableRuntime = await makeRuntime({
    runtimeMode: 'active',
    entries: entriesOf(baseCase),
    lane: unavailableLane,
  })
  const unavailableOutcome = outcomeOf(await unavailableRuntime.evaluate({
    query: baseCase.query,
    maxResults: MAX_RESULTS,
    actor: {},
    lexicalNames: [],
  }))
  assert('unavailable: a runner timeout maps to lexical:unavailable',
    unavailableOutcome === 'lexical:unavailable', unavailableOutcome)

  const abortController = new AbortController()
  abortController.abort()
  const cancelledLane = new ScriptedLane()
  const cancelledRuntime = await makeRuntime({
    runtimeMode: 'active',
    entries: entriesOf(baseCase),
    lane: cancelledLane,
  })
  const cancelledOutcome = outcomeOf(await cancelledRuntime.evaluate({
    query: baseCase.query,
    maxResults: MAX_RESULTS,
    actor: {},
    lexicalNames: [],
    signal: abortController.signal,
  }))
  assert('cancelled: a pre-aborted caller signal activates nothing',
    cancelledOutcome === 'cancelled' && cancelledLane.requests.length === 0,
    `${cancelledOutcome}, ${cancelledLane.requests.length} request(s)`)

  // A clock that runs 600 ms per read against the 1200 ms ceiling: the second
  // batch can never start, which is the shared-deadline exhaustion path.
  let ticks = 0
  const accelerated = () => { ticks += 600; return ticks }
  const deadlineLane = new ScriptedLane()
  const deadlineRuntime = await makeRuntime({
    runtimeMode: 'active',
    entries: replicateEntries(baseCase, DEFAULT_DISCOVERY_SETTINGS.batchSize + 2),
    lane: deadlineLane,
    now: accelerated,
  })
  const deadlineOutcome = outcomeOf(await deadlineRuntime.evaluate({
    query: baseCase.query,
    maxResults: MAX_RESULTS,
    actor: {},
    lexicalNames: [],
  }))
  assert('deadline: an exhausted shared deadline maps to lexical:incomplete',
    deadlineOutcome === 'lexical:incomplete' && deadlineLane.requests.length > 0,
    `${deadlineOutcome}, ${deadlineLane.requests.length} request(s)`)

  const overCapLane = new ScriptedLane()
  const overCapRuntime = await makeRuntime({
    runtimeMode: 'active',
    entries: replicateEntries(baseCase, DEFAULT_DISCOVERY_SETTINGS.maxCandidates + 1),
    lane: overCapLane,
  })
  const overCapOutcome = outcomeOf(await overCapRuntime.evaluate({
    query: baseCase.query,
    maxResults: MAX_RESULTS,
    actor: {},
    lexicalNames: [],
  }))
  assert('over-cap: a pool above max-candidates maps to lexical:bounds',
    overCapOutcome === 'lexical:bounds' && overCapLane.requests.length === 0,
    `${overCapOutcome}, ${overCapLane.requests.length} request(s)`)

  const exactName = entriesOf(baseCase).find(entry => entry.admitted)?.name ?? baseCase.candidates[0].name
  const shadowLane = new ScriptedLane()
  const shadowRuntime = await makeRuntime({
    runtimeMode: 'shadow',
    entries: entriesOf(baseCase),
    lane: shadowLane,
  })
  const shadowOutcome = outcomeOf(await shadowRuntime.evaluate({
    query: exactName,
    maxResults: MAX_RESULTS,
    actor: {},
    lexicalNames: [],
  }))
  assert('exact: shadow mode keeps the lexical path (lexical:exact)',
    shadowOutcome === 'lexical:exact' && shadowLane.requests.length === 0,
    `${shadowOutcome}, ${shadowLane.requests.length} request(s)`)

  const activeLane = new ScriptedLane()
  const activeRuntime = await makeRuntime({
    runtimeMode: 'active',
    entries: entriesOf(baseCase),
    lane: activeLane,
  })
  const activeEvaluation = await activeRuntime.evaluate({
    query: exactName,
    maxResults: MAX_RESULTS,
    actor: {},
    lexicalNames: [],
  })
  const exactShortCircuit = activeEvaluation.kind === 'selected'
    && activeEvaluation.names.length === 1
    && activeEvaluation.names[0] === exactName
  assert('exact: active mode activates only that name with zero requests',
    exactShortCircuit && activeLane.requests.length === 0,
    `${outcomeOf(activeEvaluation)}, ${activeLane.requests.length} request(s)`)

  console.log('tool-discovery eval — live arm (production runtime + scripted fake lane)')
  console.log(`corpus: ${corpusDisplay} (${cases.length} cases, schemaVersion 2, corpusVersion ${corpusVersion})`)
  console.log(`split: ${splitName} (${selected.length} of ${cases.length} cases)`)
  console.log('adapter: scripted fake lane (deterministic, in-process; a real-lane adapter is out of scope)')
  console.log('')
  console.log('nominal evidence — UNGATED (the judge-stub arm is the gate)')
  console.log(
    `  restricted micro-F1 ${show(nominal.f1)} (precision ${show(nominal.precision)}, recall ${show(nominal.recall)}, `
    + `tp ${nominal.tp} fp ${nominal.fp} fn ${nominal.fn})`,
  )
  console.log(`  outcomes: ${selectedCount} selected, ${lexicalCount} lexical, ${cancelledCount} cancelled`)
  console.log(`  pool fallbacks: ${fallbackIds.length} (cases: ${ids(fallbackIds)})`)
  console.log(
    `  latency ms: p50 ${latencyPercentiles.p50} p90 ${latencyPercentiles.p90} max ${latencyPercentiles.max} `
    + `(small sample: ${latency.length} case(s) — p90 is the ~2nd-largest sample, read max alongside)`,
  )
  console.log(`  input bytes (question-map JSON, utf8): ${questionBytes} over ${requestCount} request(s); candidates judged ${judgedCount}`)
  console.log('')
  console.log('scenario assertions')
  for (const assertion of assertions) {
    console.log(`  ${assertion.ok ? 'PASS' : 'FAIL'}  ${assertion.label} — ${assertion.detail}`)
  }
  const failures = assertions.filter(assertion => !assertion.ok)
  console.log(`result: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length} assertion(s))`}`)
  process.exit(failures.length === 0 ? 0 : 1)
}
