#!/usr/bin/env node
// Underspec-detector ambiguity evaluation against a live System One gateway.
// run: pnpm exec tsc -b packages/llm-tuning/systemone
//      node --experimental-strip-types scripts/eval-ambiguity.mjs [--criteria FILE] [--corpus FILE] [--model ID] [--base URL]
//
// A/B protocol (PR #149 corpus governance): every run appends to a ledger keyed
// by the criteria fingerprint, so a before/after table never depends on
// unrecorded local runs. Repeating the same fingerprint must reproduce the same
// rowHash — that is the determinism evidence, not an assertion.
//
// The verdict question is sent alongside the ambiguity question because
// production sends the pair in ONE System One call (gauge-adapter §3.1).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { prepareSystemOneInput, buildAmbiguityQuestion, DEFAULT_GAUGE_CONTEXT_WINDOW } from '../src/gauge-adapter.ts'
import { systemoneDecide } from '@dsh-cc/systemone'

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const here = dirname(fileURLToPath(import.meta.url))
const baseURL = argOf('--base', 'http://127.0.0.1:8080')
const model = argOf('--model', 'llmbox_systemone/bjev')
const criteriaFile = argOf('--criteria', undefined)
const corpusFile = argOf('--corpus', join(here, 'ambiguity-corpus.json'))
const resultsFile = join(here, 'ambiguity-corpus-results.json')

const corpus = JSON.parse(readFileSync(corpusFile, 'utf8'))
const EMPTY_SLOTS = { hardDeny: [], softDeny: [], allowExceptions: [], environment: [] }

// `--criteria` injects a candidate wording without touching the source tree; the
// ledger key is the full question, so a variant run can never be mistaken for a
// shipped-criteria run.
const question = criteriaFile === undefined
  ? buildAmbiguityQuestion(EMPTY_SLOTS)
  : JSON.parse(readFileSync(criteriaFile, 'utf8'))
const criteriaSha = createHash('sha256').update(JSON.stringify(question)).digest('hex').slice(0, 16)
const corpusKey = corpusFile.split('/').pop().replace(/\.json$/, '')

const rows = []
for (const entry of corpus.cases) {
  const prepared = prepareSystemOneInput(
    { name: 'Bash', arguments: { command: entry.command } },
    EMPTY_SLOTS,
    DEFAULT_GAUGE_CONTEXT_WINDOW,
    { ambiguityAsk: true, task: entry.task },
  )
  if (prepared.budgetExhausted || prepared.questions.ambiguity === undefined) {
    rows.push({ id: entry.id, family: entry.family, expect: entry.expect, failure: 'budget', reason: 'ambiguity question dropped by budget' })
    console.log(`${entry.id} [${entry.expect}] BUDGET-DROPPED`)
    continue
  }
  // Build the state with the injected wording too (the criteria text consumes
  // context-window budget, so a variant must be sized like production).
  const state = prepared.state
  let result
  for (let attempt = 0; ; attempt++) {
    result = await systemoneDecide({
      baseURL,
      model,
      state,
      questions: { verdict: prepared.questions.verdict, ambiguity: question },
      timeoutMs: 20000,
    })
    if (!(!result.ok && result.reason.startsWith('http 429') && attempt < 3)) break
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
  }
  await new Promise((r) => setTimeout(r, 1200))
  if (!result.ok) {
    rows.push({ id: entry.id, family: entry.family, expect: entry.expect, failure: result.failure, reason: result.reason })
    console.log(`${entry.id} [${entry.expect}] FAILURE ${result.failure}: ${result.reason}`)
    continue
  }
  const a = result.answers.ambiguity
  const choice = a !== undefined && a.type === 'choice' && (a.choice === 'specified' || a.choice === 'underspecified')
    ? a.choice
    : undefined
  rows.push({
    id: entry.id,
    family: entry.family,
    expect: entry.expect,
    choice,
    ok: choice !== undefined && choice === entry.expect,
    confidence: a?.confidence,
    probabilities: a?.probabilities,
  })
  console.log(`${entry.id} ${entry.family.padEnd(24)} expect=${entry.expect.padEnd(14)} got=${String(choice).padEnd(14)} ${choice === entry.expect ? 'OK' : 'MISS'} conf=${a?.confidence?.toFixed(4) ?? '-'}`)
}

const byFamily = {}
for (const r of rows) {
  const f = (byFamily[r.family] ??= { cases: 0, failures: 0, correct: 0, misses: [] })
  f.cases++
  if (r.failure !== undefined) f.failures++
  else if (r.ok) f.correct++
  else f.misses.push(r.id)
}
const readFamilies = ['read-only-mined', 'read-only-unrelated-task', 'holdout-read']
const riskFamilies = ['genuine-underspecified', 'holdout-risk']
const namedFamilies = ['named-target-mutation', 'holdout-named']
const slice = (families) => rows.filter((r) => families.includes(r.family) && r.failure === undefined)
const count = (list, choice) => list.filter((r) => r.choice === choice)
const readRows = slice(readFamilies)
const riskRows = slice(riskFamilies)
const namedRows = slice(namedFamilies)
const falseUnderspec = count(readRows, 'underspecified')
const falseSpecified = count(riskRows, 'specified')
const namedFalse = count(namedRows, 'underspecified')
const rate = (list, n) => (list.length === 0 ? null : Number((n / list.length).toFixed(4)))
const summary = {
  criteriaSha,
  readOnly: { cases: readRows.length, falseUnderspecified: falseUnderspec.length, rate: rate(readRows, falseUnderspec.length), missedIds: falseUnderspec.map((r) => r.id) },
  genuine: { cases: riskRows.length, falseSpecified: falseSpecified.length, rate: rate(riskRows, falseSpecified.length), missedIds: falseSpecified.map((r) => r.id) },
  namedTarget: { cases: namedRows.length, falseUnderspecified: namedFalse.length, rate: rate(namedRows, namedFalse.length), missedIds: namedFalse.map((r) => r.id) },
  byFamily,
}
const rowHash = createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)

console.log('\n--- summary ---')
console.log(`criteriaSha=${criteriaSha} corpus=${corpusKey} rowHash=${rowHash}`)
console.log(`read-only: ${summary.readOnly.falseUnderspecified}/${summary.readOnly.cases} false-underspecified (${summary.readOnly.rate}) ids=${summary.readOnly.missedIds.join(',')}`)
console.log(`genuine  : ${summary.genuine.falseSpecified}/${summary.genuine.cases} false-specified (${summary.genuine.rate}) ids=${summary.genuine.missedIds.join(',')}`)
console.log(`named    : ${summary.namedTarget.falseUnderspecified}/${summary.namedTarget.cases} false-underspecified (${summary.namedTarget.rate}) ids=${summary.namedTarget.missedIds.join(',')}`)

// Append-only ledger: one entry per (corpus, criteria) with every row, so any
// table cell in the docs can be recomputed from a committed artifact. A repeated
// key with a different rowHash is a determinism failure and is kept, not hidden.
const ledger = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : { meta: {}, runs: [] }
ledger.meta = { description: 'Underspec-detector ambiguity A/B ledger: one entry per corpus × criteria fingerprint.', model, baseURL }
// Append-only, never deduplicated: two entries with the same fingerprint and
// different rowHash are the determinism evidence, and hiding them would launder
// the exact claim this file exists to prove.
ledger.runs.push({
  corpus: corpusKey,
  criteriaSha,
  rowHash,
  runDate: new Date().toISOString(),
  corpusSize: corpus.cases.length,
  questionSnapshot: question,
  summary,
  rows,
})
writeFileSync(resultsFile, `${JSON.stringify(ledger, null, 2)}\n`)
console.log(`\nledger entries: ${ledger.runs.length} (${resultsFile})`)
console.log(`EVAL_JSON:${JSON.stringify({ corpus: corpusKey, criteriaSha, rowHash, summary })}`)
