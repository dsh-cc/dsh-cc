#!/usr/bin/env node
/**
 * eval-reducer-gate.mjs — offline replay evaluator for the S1-12 reducer
 * decision gate (`packages/context/context-crusher`).
 *
 * Design: `docs/plans/2026-11-02-systemone-12-reducer-gate.md`
 * § "Implementation tasks and tests" (the corpus + script row) and
 * § "Release gates, rollback and docs" (the offline log battery and the
 * cost-bearing acceptance).
 *
 * run: node packages/context/context-crusher/scripts/eval-reducer-gate.mjs \
 *        --corpus packages/context/context-crusher/tests/fixtures/reducer-gate-corpus.json \
 *        --mode replay
 *
 * NO MODEL CALL, EVER. Replay drives the REAL pipeline (`evaluateReducerGate`
 * from `src/reducer-gate.ts`: chunk planning, request shaping, transactional
 * aggregation, coalescing cache) with a deterministic fake runner whose
 * answers come from the corpus itself (cycled per chunk). Chunk planning runs
 * the shipped `planGateChunks`; cost accounting reuses S1-02's
 * `estimateDecisionInputTokens`; the fabricated-receipt cases additionally run
 * the shipped `parseReceipt`/`verifyReceipt` to prove the gate never weakens
 * the deterministic verifier. The corpus's pinned `expectedRuns` is
 * cross-checked against the planner, so a drift between the fixture and the
 * shipped code fails loudly instead of silently passing.
 *
 * Corpus schema (documented here because the fixture is data, not a test):
 *   { schemaVersion: 1, description?, cases: Case[] }; a bare Case[] also works.
 *   Case = { id, rationale, command, text, sourceTokens, answers,
 *            expectedGate: 'attempt'|'skip', expectedRuns?,
 *            view?, isError?, minSavingsRatio?, gate?, receipt?,
 *            expectVerifier?, notes? }
 *   rationale = 'failure-output' | 'repeated-logs' | 'independent-kv'
 *     | 'unicode' | 'long-line' | 'fabricated-receipt' | 'truncated-view'
 *   answers = [{ score: finite 0..4, noul: finite 0..1 }, …] cycled per chunk.
 *   gate = raw reducer-decision-gate overrides, resolved through the shipped
 *          tolerant `resolveGateConfig` over ACTIVE defaults.
 *
 * Schema invariants (exit 2): ≥10 cases; every rationale ≥1; unique ids; a
 * `truncated-view` case must carry `view !== text` and expect legacy behavior
 * (0 wire attempts); verifier cases carry `receipt` with expectedGate
 * 'attempt' and expectVerifier 'decline'.
 *
 * Per case the replay asserts: the verdict matches expectedGate; skip ⇒
 * reason 'low-opportunity'; the wire-attempt count equals the corpus pin AND
 * the real planner (0 for the no-model rows); decisionIds cover exactly the
 * requests sent; two replays are identical; a verifier case's fabricated
 * receipt is declined by the shipped verifier.
 *
 * Cost report (the design's "cost-bearing" requirement, as ESTIMATES, never
 * billed usage): per case the decision-estimator input tokens actually sent,
 * and the generation cost estimate of the original side query it replaced;
 * totals compare the gate's spend plus remaining generation against the
 * control where every case reached the generator. A net-negative delta means
 * the gate spent more deciding than it saved generating.
 *
 * Privacy: only case ids, rationales, counts and failure reasons are printed
 * — never tool text or answers.
 *
 * Exit codes: 0 = every case passed; 1 = at least one failing case; 2 = usage
 * or corpus schema violation.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { estimateDecisionInputTokens } from '@dsh-cc/systemone'
import { DEFAULT_REDUCER_GATE, resolveGateConfig } from '../src/config.ts'
import { evaluateReducerGate, planGateChunks, REDUCER_GATE_QUESTIONS } from '../src/reducer-gate.ts'
import { ReducerGateCache } from '../src/reducer-gate-cache.ts'
import { parseReceipt } from '../src/receipt.ts'
import { verifyReceipt } from '../src/verifier.ts'

/** Coverage categories, in report order (the design's release battery). */
const RATIONALES = [
  'failure-output',
  'repeated-logs',
  'independent-kv',
  'unicode',
  'long-line',
  'fabricated-receipt',
  'truncated-view',
]

/** The offline fixture floor; the deployment battery is ≥100 logs, ≥10 per category. */
const MIN_CASES = 10

/** The replayed decision lane route (the shape S1-02's resolveRoute returns). */
const ROUTE = {
  provider: 'replay-gauge', model: 'replay-model', revision: 'replay-rev',
  perRequestTokens: 8192, perQuestionTokens: 8192, maxQuestions: 4, maxOutputTokens: 64,
}

/** The replayed metering scope. */
const SCOPE = { projectKey: 'corpus', sessionId: 'replay', agentId: 'eval', originSeq: 0 }

/** Verifier estimator, the same chars/4 convention the unit specs use. */
const estimateChars = (text) => Math.ceil(text.length / 4)

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_CORPUS = join(here, '..', 'tests', 'fixtures', 'reducer-gate-corpus.json')
const DEFAULT_CORPUS_DISPLAY = 'packages/context/context-crusher/tests/fixtures/reducer-gate-corpus.json'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const fail = (message, code = 2) => {
  console.error(`eval-reducer-gate: ${message}`)
  process.exit(code)
}

for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index]
  if (flag === '--corpus' || flag === '--mode') index += 1
  else fail(`unknown argument ${JSON.stringify(flag)} — usage: eval-reducer-gate.mjs [--corpus <path>] [--mode replay]`)
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

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isName = (value) => typeof value === 'string' && value.trim().length > 0
const isFiniteIn = (value, min, max) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max

/** Validate the corpus (ids and field paths only — never tool text). */
function validateCorpus(parsed) {
  const errors = []
  const document = Array.isArray(parsed) ? { schemaVersion: 1, cases: parsed } : parsed
  if (!isObject(document)) return { errors: ['corpus must be an object or an array of cases'], cases: [] }
  if (!Array.isArray(document.cases)) return { errors: ['cases must be an array'], cases: [] }
  if (document.schemaVersion !== undefined && document.schemaVersion !== 1) {
    errors.push(`unsupported schemaVersion ${JSON.stringify(document.schemaVersion)} (expected 1)`)
  }
  const seen = new Set()
  const counts = Object.fromEntries(RATIONALES.map((r) => [r, 0]))
  document.cases.forEach((entry, index) => {
    const where = isObject(entry) && isName(entry.id) ? entry.id : `cases[${index}]`
    if (!isObject(entry)) return errors.push(`${where}: case must be an object`)
    if (!isName(entry.id)) errors.push(`${where}: id must be a non-empty string`)
    else if (seen.has(entry.id)) errors.push(`${where}: duplicate id`)
    else seen.add(entry.id)
    if (!RATIONALES.includes(entry.rationale)) {
      errors.push(`${where}: rationale must be one of ${RATIONALES.join(' | ')}`)
      return
    }
    counts[entry.rationale] += 1
    if (!isName(entry.command)) errors.push(`${where}: command must be a non-empty string`)
    if (typeof entry.text !== 'string') errors.push(`${where}: text must be a string`)
    if (!isFiniteIn(entry.sourceTokens, 0, 10_000_000)) errors.push(`${where}: sourceTokens must be a finite number ≥ 0`)
    if (entry.view !== undefined && typeof entry.view !== 'string') errors.push(`${where}: view must be a string`)
    if (entry.isError !== undefined && typeof entry.isError !== 'boolean') errors.push(`${where}: isError must be boolean`)
    if (entry.minSavingsRatio !== undefined && !isFiniteIn(entry.minSavingsRatio, 0, 1)) {
      errors.push(`${where}: minSavingsRatio must be a finite number in 0..1`)
    }
    if (entry.notes !== undefined && typeof entry.notes !== 'string') errors.push(`${where}: notes must be a string`)
    if (entry.gate !== undefined && !isObject(entry.gate)) errors.push(`${where}: gate must be an object`)
    if (entry.expectedGate !== 'attempt' && entry.expectedGate !== 'skip') {
      errors.push(`${where}: expectedGate must be attempt | skip`)
    }
    if (entry.expectedRuns !== undefined
      && (!Number.isInteger(entry.expectedRuns) || entry.expectedRuns < 0)) {
      errors.push(`${where}: expectedRuns must be a non-negative integer`)
    }
    if (!Array.isArray(entry.answers) || entry.answers.length === 0) {
      errors.push(`${where}: answers must be a non-empty array`)
    } else {
      entry.answers.forEach((answer, answerIndex) => {
        const at = `${where}: answers[${answerIndex}]`
        if (!isObject(answer)) return errors.push(`${at} must be an object`)
        if (!isFiniteIn(answer.score, 0, 4)) errors.push(`${at}.score must be a finite number in 0..4`)
        if (!isFiniteIn(answer.noul, 0, 1)) errors.push(`${at}.noul must be a finite number in 0..1`)
      })
    }
    // Category invariants: without them a case could pass for the wrong reason.
    if (entry.rationale === 'truncated-view') {
      if (typeof entry.view !== 'string' || entry.view === entry.text) {
        errors.push(`${where}: truncated-view needs view !== text`)
      }
      if (entry.expectedGate !== 'attempt' || entry.expectedRuns !== 0) {
        errors.push(`${where}: truncated-view must expect attempt with expectedRuns 0`)
      }
    }
    if (entry.rationale === 'fabricated-receipt') {
      if (!isName(entry.receipt)) errors.push(`${where}: fabricated-receipt needs a receipt string`)
      if (entry.expectVerifier !== 'decline') errors.push(`${where}: expectVerifier must be 'decline'`)
      if (entry.expectedGate !== 'attempt') errors.push(`${where}: fabricated receipts expect attempt`)
    }
    if (entry.rationale === 'long-line' && typeof entry.text === 'string' && entry.text.includes('\n')) {
      errors.push(`${where}: long-line text must be ONE line`)
    }
  })
  for (const rationale of RATIONALES) {
    if (counts[rationale] < 1) errors.push(`rationale ${rationale}: ${counts[rationale]} case(s), expected at least 1`)
  }
  if (document.cases.length < MIN_CASES) {
    errors.push(`corpus has ${document.cases.length} case(s), expected at least ${MIN_CASES}`)
  }
  return { errors, cases: document.cases.filter(isObject), counts }
}

const validation = validateCorpus(raw)
if (validation.errors.length > 0) {
  for (const message of validation.errors) console.error(`eval-reducer-gate: schema: ${message}`)
  fail(`${validation.errors.length} schema violation(s) in ${corpusDisplay}`)
}
const cases = validation.cases

/** A deterministic runner off the corpus answers (cycled per chunk). */
function replayRunner(entry) {
  const calls = []
  return {
    calls,
    identifyRoute: () => ROUTE,
    run: async (request) => {
      calls.push(request)
      const answer = entry.answers[(calls.length - 1) % entry.answers.length]
      return {
        status: 'answered',
        answers: {
          receiptOpportunity: { type: 'score', score: answer.score, probabilities: { '0': 1 } },
          compressible: { type: 'noul', noul: answer.noul },
        },
        model: ROUTE.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        decisionId: `replay-${calls.length}`,
        inputHash: `h-${calls.length}`,
      }
    },
  }
}

/** One replay of a case; pure — returns the verdict plus the observed wire facts. */
async function replayCase(entry) {
  const gate = resolveGateConfig(entry.gate ?? {}, { ...DEFAULT_REDUCER_GATE, mode: 'active' })
  const runner = replayRunner(entry)
  const cache = new ReducerGateCache({ limits: () => ({ maxEntries: 0, ttlMs: 0 }) })
  const view = entry.view ?? entry.text
  const decision = await evaluateReducerGate({
    tool: 'bash',
    command: entry.command,
    view,
    originalHash: `sha256:${createHash('sha256').update(entry.text).digest('hex')}`,
    viewHash: `sha256:${createHash('sha256').update(view).digest('hex')}`,
    sourceTokens: entry.sourceTokens,
    isError: entry.isError ?? false,
    viewTruncated: view !== entry.text,
    minSavingsRatio: entry.minSavingsRatio ?? 0.5,
    scope: SCOPE,
    signal: new AbortController().signal,
    generativeRoute: { alias: 'haiku', provider: 'replay-cheap', model: 'replay-cheap-model' },
  }, { gate, runner, cache })
  return { decision, gate, runner, view }
}

/** The real planner's expectation of the wire-attempt count for the model-contact rows. */
function plannedRuns(entry, gate, view) {
  const legacyRow = (entry.isError ?? false) || view !== entry.text || entry.sourceTokens > gate.maxSourceTokens
  if (legacyRow || !gate.valid || gate.mode === 'off') return 0
  const chunks = planGateChunks(
    { tool: 'bash', command: entry.command, view, sourceTokens: entry.sourceTokens, minSavingsRatio: entry.minSavingsRatio ?? 0.5 },
    ROUTE,
    gate,
  )
  return chunks === undefined ? 0 : chunks.length
}

const results = []
for (const entry of cases) {
  const first = await replayCase(entry)
  const second = await replayCase(entry)
  const mismatches = []
  const { decision, gate, runner } = first
  const expectedAttempt = entry.expectedGate === 'attempt'
  if (decision.attempt !== expectedAttempt) {
    mismatches.push(`expected gate ${entry.expectedGate}, got ${decision.attempt ? 'attempt' : 'skip'} (${decision.reason})`)
  }
  if (entry.expectedGate === 'skip' && decision.reason !== 'low-opportunity') {
    mismatches.push(`skip must carry reason 'low-opportunity', got '${decision.reason}'`)
  }
  if (entry.rationale === 'truncated-view' && decision.reason !== 'legacy') {
    mismatches.push(`truncated view must continue on 'legacy', got '${decision.reason}'`)
  }
  const planned = plannedRuns(entry, gate, first.view)
  if (runner.calls.length !== planned) {
    mismatches.push(`wire attempts ${runner.calls.length} ≠ planner ${planned}`)
  }
  if (entry.expectedRuns !== undefined && runner.calls.length !== entry.expectedRuns) {
    mismatches.push(`wire attempts ${runner.calls.length} ≠ corpus expectedRuns ${entry.expectedRuns}`)
  }
  if (decision.reason === 'low-opportunity' || decision.reason === 'compressible') {
    if (decision.decisionIds.length !== runner.calls.length) {
      mismatches.push(`decisionIds ${decision.decisionIds.length} ≠ wire attempts ${runner.calls.length}`)
    }
  } else if (decision.decisionIds.length !== 0) {
    mismatches.push(`a '${decision.reason}' outcome must drop every decisionId`)
  }
  // Two questions per request, in order, pinning the state+chunk reassembly.
  for (const [index, request] of runner.calls.entries()) {
    if (Object.keys(request.questions).sort().join(',') !== 'compressible,receiptOpportunity') {
      mismatches.push(`request ${index}: wrong question keys`)
    }
    if (request.state?.chunk?.index !== index || request.state?.chunk?.count !== runner.calls.length) {
      mismatches.push(`request ${index}: chunk counter mismatch`)
    }
  }
  if (runner.calls.length > 0
    && runner.calls.map((c) => c.state.chunk.text).join('') !== first.view) {
    mismatches.push('request chunk texts do not reassemble the complete view')
  }
  // Determinism: two replays disagree ⇒ a hidden clock or shared cache leaked in.
  if (JSON.stringify(second.decision) !== JSON.stringify(first.decision)
    || second.runner.calls.length !== first.runner.calls.length) {
    mismatches.push('replay is not deterministic (two runs disagreed)')
  }
  // Fabricated receipts: the shipped verifier must still decline what the gate attempted.
  if (entry.rationale === 'fabricated-receipt') {
    let parsed = null
    try {
      parsed = parseReceipt(JSON.parse(entry.receipt))
    } catch {
      parsed = null
    }
    const verdict = parsed === null
      ? { ok: false, reason: 'malformed' }
      : verifyReceipt(first.view, parsed, entry.isError ?? false, estimateChars, { minSavingsRatio: entry.minSavingsRatio ?? 0.5 })
    if (entry.expectVerifier === 'decline' && verdict.ok === true) {
      mismatches.push('fabricated receipt was ACCEPTED by the verifier')
    }
  }
  // Cost accounting (estimates, never billed usage): what the decision lane
  // actually consumed vs. the generation the original reducer would have run.
  const decisionTokens = runner.calls.reduce(
    (total, request) => total + estimateDecisionInputTokens(request.state, request.questions).requestTokens,
    0,
  )
  const generationEstimate = estimateDecisionInputTokens(
    { prompt: first.view },
    { receipt: { type: 'noul', instructions: 'generation proxy' } },
  ).requestTokens
  results.push({
    id: entry.id,
    rationale: entry.rationale,
    outcome: decision.attempt ? 'attempt' : 'skip',
    reason: decision.reason,
    runs: runner.calls.length,
    decisionTokens,
    generationEstimate,
    mismatches,
  })
}

// ---- report ---------------------------------------------------------------

const byRationale = new Map(RATIONALES.map((r) => [r, []]))
for (const row of results) byRationale.get(row.rationale)?.push(row)

console.log(`eval-reducer-gate — replay of ${cases.length} case(s) from ${corpusDisplay}`)
console.log('')
const num = (value) => String(Math.round(value * 100) / 100).padEnd(18)
const header = ['rationale'.padEnd(18), 'cases'.padEnd(8), 'runs'.padEnd(8), 'decision-tokens'.padEnd(18), 'generation-est'.padEnd(18), 'skipped'.padEnd(8), 'net-delta'.padEnd(18)].join('')
console.log(header)
console.log('-'.repeat(header.length))
const totals = { cases: 0, runs: 0, decision: 0, generation: 0, skipped: 0, net: 0 }
for (const rationale of RATIONALES) {
  const rows = byRationale.get(rationale) ?? []
  if (rows.length === 0) continue
  const runs = rows.reduce((t, r) => t + r.runs, 0)
  const decision = rows.reduce((t, r) => t + r.decisionTokens, 0)
  const generation = rows.reduce((t, r) => t + r.generationEstimate, 0)
  const skipped = rows.filter((r) => r.outcome === 'skip')
  const skippedGeneration = skipped.reduce((t, r) => t + r.generationEstimate, 0)
  // Gate cost + generation still paid vs. the control (every case generates).
  const net = decision + (generation - skippedGeneration) - generation
  totals.cases += rows.length
  totals.runs += runs
  totals.decision += decision
  totals.generation += generation
  totals.skipped += skipped.length
  totals.net += net
  console.log([
    rationale.padEnd(18),
    String(rows.length).padEnd(8),
    String(runs).padEnd(8),
    num(decision),
    num(generation),
    String(skipped.length).padEnd(8),
    num(net),
  ].join(''))
}
console.log('-'.repeat(header.length))
console.log([
  'TOTAL'.padEnd(18),
  String(totals.cases).padEnd(8),
  String(totals.runs).padEnd(8),
  num(totals.decision),
  num(totals.generation),
  String(totals.skipped).padEnd(8),
  num(totals.net),
].join(''))
console.log('')
console.log('cost note: token counts are the S1-02 lower-bound ESTIMATES, never billed usage;')
console.log('net-delta = decision spend − generation avoided vs. the always-generate control.')

const failures = results.filter((row) => row.mismatches.length > 0)
console.log('')
for (const row of results) {
  const mark = row.mismatches.length === 0 ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${row.id} [${row.rationale}] gate=${row.outcome}(${row.reason}) runs=${row.runs} decision=${Math.round(row.decisionTokens)} generation-est=${Math.round(row.generationEstimate)}`)
  for (const message of row.mismatches) console.log(`     - ${message}`)
}
if (failures.length > 0) {
  console.error(`eval-reducer-gate: ${failures.length} of ${results.length} case(s) failed`)
  process.exit(1)
}
console.log(`eval-reducer-gate: all ${results.length} case(s) passed`)
