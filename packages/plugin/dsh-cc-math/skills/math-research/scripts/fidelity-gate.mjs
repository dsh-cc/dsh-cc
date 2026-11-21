import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicJson, ensureWritable, fail, parseFlags, readJson, runCli } from './storage.lib.mjs'

// Formalization fidelity gate (design §4.3) — the record/verify/decide
// machinery. The two MODEL judgments (back-translation, premise audit) and the
// candidate-b dual formalization are performed by the main conversation; this
// script never judges. It reads `fidelity-input.json` (written by the main
// conversation, with `anchorCheck` contributed by lean-run's statement-check +
// anchor-check.mjs), applies the NINE-ROW decision table verbatim and writes
// `fidelity.json` {grade, disputeReason?, pairEquivalence (pass-through
// advisory), checks, decidedAt}.
//
// Authority (§4.3): the kernel pair-equivalence proves only that two
// formalizations agree WITH EACH OTHER, so `pairEquivalence` is recorded and is
// never a grade input. `anchored` requires a trusted reference whose
// kernel-checked equivalence passes; `model-assessed` requires check 1 =
// equivalent AND check 3 clean AND no reference; anything else is `disputed`.
//
// Dispute reasons: `anchor-failed` (kernel evidence of infidelity) ·
// `model-judgment` (rows 5–8) · `infra-failure` (rows 4/9 — the tooling
// produced no evidence, which is not evidence of infidelity). An
// `infra-failure` outcome is retried INSIDE the gate before any dispute is
// committed: on the first infra outcome the gate writes nothing and exits 3
// asking for one re-run of the named checks; only a second infra outcome
// commits disputeReason=infra-failure. The retry window is therefore strictly
// PRE-COMMITMENT — once a dispute is committed it is never retried (§4.3 v6,
// carving the retry out of §3.3's terminal rule by construction).

export const GRADES = Object.freeze(['anchored', 'human-confirmed', 'model-assessed', 'disputed'])
export const DISPUTE_REASONS = Object.freeze(['anchor-failed', 'model-judgment', 'infra-failure'])
export const PAIR_EQUIVALENCE_OUTCOMES = Object.freeze(['equivalent', 'unknown', 'skipped'])
export const ANCHOR_STATUSES = Object.freeze(['not-run', 'passes', 'fails', 'cannot-run'])
export const MAX_INFRA_RETRIES = 1
/** Grades that are "model-assessed or better" for the measurement protocol (§4.3). */
export const ACCEPTED_GRADES = Object.freeze(['anchored', 'human-confirmed', 'model-assessed'])

const INPUT_FIELDS = ['schemaVersion', 'pairId', 'corrupted', 'backTranslation', 'premiseAudit', 'pairEquivalence', 'anchorCheck', 'retryCount']

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string')

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  assert(unknown.length === 0, `${label} has unknown field(s): ${unknown.join(',')}`)
}

// ---------------------------------------------------------------------------
// Input validation (malformed input is config-invalid → exit 2)
// ---------------------------------------------------------------------------
function validateBackTranslation(value) {
  if (value === undefined || value === null) return null // check did not run (row 9)
  assert(isPlainObject(value), 'backTranslation must be an object or null')
  rejectUnknown(value, ['equivalent', 'differences'], 'backTranslation')
  const { equivalent } = value
  assert(equivalent === true || equivalent === false || equivalent === 'uncertain', "backTranslation.equivalent must be true, false or the string 'uncertain'")
  const differences = value.differences ?? []
  assert(isStringArray(differences), 'backTranslation.differences must be an array of strings')
  return { equivalent, differences }
}

function validatePremiseAudit(value) {
  if (value === undefined || value === null) return null // check did not run (row 9)
  assert(isPlainObject(value), 'premiseAudit must be an object or null')
  rejectUnknown(value, ['missing', 'extra'], 'premiseAudit')
  assert(isStringArray(value.missing), 'premiseAudit.missing must be an array of strings')
  assert(isStringArray(value.extra), 'premiseAudit.extra must be an array of strings')
  return { missing: value.missing, extra: value.extra }
}

function validateAnchorCheck(value) {
  if (value === undefined || value === null) return null // no reference exists (row 1)
  assert(isPlainObject(value), 'anchorCheck must be an object or null')
  rejectUnknown(value, ['status', 'evidenceRef'], 'anchorCheck')
  assert(ANCHOR_STATUSES.includes(value.status), `anchorCheck.status must be one of ${ANCHOR_STATUSES.join('|')}`)
  const evidenceRef = value.evidenceRef ?? null
  assert(evidenceRef === null || (typeof evidenceRef === 'string' && evidenceRef.length > 0), 'anchorCheck.evidenceRef must be a non-empty string or null')
  return { status: value.status, evidenceRef }
}

/** Strict `fidelity-input.json` (§4.3): unknown fields rejected at every level. */
export function validateFidelityInput(raw) {
  assert(isPlainObject(raw), 'fidelity-input.json must be a JSON object')
  rejectUnknown(raw, INPUT_FIELDS, 'fidelity-input.json')
  assert(raw.schemaVersion === 1, 'fidelity-input.json schemaVersion must be 1')
  if (raw.pairId !== undefined && raw.pairId !== null) assert(typeof raw.pairId === 'string' && raw.pairId.length > 0, 'pairId must be a non-empty string')
  if (raw.corrupted !== undefined && raw.corrupted !== null) assert(typeof raw.corrupted === 'boolean', 'corrupted must be a boolean (measurement-protocol corruption flag)')
  if (raw.pairEquivalence !== undefined && raw.pairEquivalence !== null) assert(PAIR_EQUIVALENCE_OUTCOMES.includes(raw.pairEquivalence), `pairEquivalence must be one of ${PAIR_EQUIVALENCE_OUTCOMES.join('|')}`)
  const retryCount = raw.retryCount ?? 0
  assert(Number.isInteger(retryCount) && retryCount >= 0, 'retryCount must be a non-negative integer')
  return {
    schemaVersion: 1,
    pairId: raw.pairId ?? null,
    corrupted: raw.corrupted ?? null,
    backTranslation: validateBackTranslation(raw.backTranslation),
    premiseAudit: validatePremiseAudit(raw.premiseAudit),
    pairEquivalence: raw.pairEquivalence ?? null,
    anchorCheck: validateAnchorCheck(raw.anchorCheck),
    retryCount,
  }
}

// ---------------------------------------------------------------------------
// The nine-row decision table (§4.3) — the exact rows, in table order
// ---------------------------------------------------------------------------
function composeChecks(input) {
  const backTranslation = input.backTranslation
  const premiseAudit = input.premiseAudit
  const anchor = input.anchorCheck
  const clean = premiseAudit !== null && premiseAudit.missing.length === 0 && premiseAudit.extra.length === 0
  let backOutcome = 'not-run'
  if (backTranslation !== null) {
    if (backTranslation.equivalent === true) backOutcome = 'equivalent'
    else if (backTranslation.equivalent === false) backOutcome = 'false'
    else backOutcome = 'uncertain'
  }
  return {
    backTranslation: { outcome: backOutcome, differences: backTranslation?.differences ?? [] },
    premiseAudit: {
      outcome: premiseAudit === null ? 'not-run' : clean ? 'clean' : 'differences',
      missing: premiseAudit?.missing ?? [],
      extra: premiseAudit?.extra ?? [],
    },
    anchorCheck: { outcome: anchor === null ? 'not-run' : anchor.status, evidenceRef: anchor?.evidenceRef ?? null },
  }
}

const DECISIONS = {
  1: { grade: 'model-assessed', disputeReason: null },
  2: { grade: 'anchored', disputeReason: null },
  3: { grade: 'disputed', disputeReason: 'anchor-failed' },
  4: { grade: 'disputed', disputeReason: 'infra-failure' },
  5: { grade: 'disputed', disputeReason: 'model-judgment' },
  6: { grade: 'disputed', disputeReason: 'model-judgment' },
  7: { grade: 'disputed', disputeReason: 'model-judgment' },
  8: { grade: 'disputed', disputeReason: 'model-judgment' },
  9: { grade: 'disputed', disputeReason: 'infra-failure' },
}

/**
 * Pure decision function: validated input → decision. No IO, no model calls.
 * Returns {grade, disputeReason, decisionRow, retryRequested, checksToRetry,
 * checks, retryCount, retryExhausted}. A `retryRequested` decision is NOT a
 * grade: nothing may be committed for it (the pre-commitment window).
 */
export function decideFidelity(input) {
  const checks = composeChecks(input)
  const retryCount = input.retryCount
  const failedToRun = []
  if (checks.backTranslation.outcome === 'not-run') failedToRun.push('back-translation')
  if (checks.premiseAudit.outcome === 'not-run') failedToRun.push('premise-audit')
  if (checks.anchorCheck.outcome === 'cannot-run') failedToRun.push('anchor-check')

  const decision = (row, retryRequested = false) => ({
    grade: retryRequested ? null : DECISIONS[row].grade,
    disputeReason: retryRequested ? null : DECISIONS[row].disputeReason,
    decisionRow: row,
    retryRequested,
    checksToRetry: retryRequested ? failedToRun : [],
    retryCount,
    retryExhausted: !retryRequested && DECISIONS[row].disputeReason === 'infra-failure',
    checks,
  })

  // Infra outcomes: retried once BEFORE any dispute commits (§4.3 v6).
  const infraDecision = () => {
    const clean = checks.premiseAudit.outcome === 'clean'
    const anchorOnly = failedToRun.length === 1 && failedToRun[0] === 'anchor-check'
    const row = anchorOnly && checks.backTranslation.outcome === 'equivalent' && clean ? 4 : 9
    return retryCount >= MAX_INFRA_RETRIES ? decision(row) : decision(row, true)
  }

  // Row 8 first: check 1 = false is positive model evidence of infidelity, and
  // row 8 admits "any" premise audit; a missing check cannot explain it away.
  if (checks.backTranslation.outcome === 'false') return decision(8)
  if (failedToRun.length > 0) return infraDecision()
  // Rows 6/7: `uncertain` is never a pass (check 1 must be `equivalent`).
  if (checks.backTranslation.outcome === 'uncertain') return decision(checks.premiseAudit.outcome === 'clean' ? 6 : 7)
  // Row 5: equivalent but the premise audit found differences.
  if (checks.premiseAudit.outcome !== 'clean') return decision(5)
  // Rows 1–3: check 1 equivalent AND check 3 clean; only the anchor outcome differs.
  switch (checks.anchorCheck.outcome) {
    case 'passes': return decision(2)
    case 'fails': return decision(3)
    case 'not-run': return decision(1)
    default: return infraDecision() // 'cannot-run' — unreachable (collected above)
  }
}

/** Design §4.3: under allowHumanFidelity=false a committed dispute is terminal. */
export const escalationFor = (grade, allowHumanFidelity) =>
  grade !== 'disputed' ? null : allowHumanFidelity ? 'human-escalation' : 'terminal-fidelity-failed'

// ---------------------------------------------------------------------------
// IO: read the input, decide, write fidelity.json
// ---------------------------------------------------------------------------
export const fidelityInputPath = problemDir => join(problemDir, 'fidelity-input.json')
export const fidelityOutputPath = problemDir => join(problemDir, 'fidelity.json')

export async function runFidelityGate(options, deps = {}) {
  const { io = fs, now = () => new Date().toISOString() } = deps
  const problemDir = resolve(options.problem)
  const inputPath = options.input ? resolve(options.input) : fidelityInputPath(problemDir)
  const raw = await readJson(inputPath, 'fidelity-input.json')
  const input = validateFidelityInput(raw)
  const decision = decideFidelity(input)
  const allowHumanFidelity = Boolean(options.allowHumanFidelity)

  if (decision.retryRequested) {
    return {
      status: 'retry-requested',
      outputPath: null,
      record: {
        schemaVersion: 1,
        command: 'fidelity-gate',
        status: 'retry-requested',
        pairId: input.pairId,
        corrupted: input.corrupted,
        decisionRow: decision.decisionRow,
        checks: decision.checks,
        retry: {
          requested: true,
          attempt: decision.retryCount + 1,
          maxRetries: MAX_INFRA_RETRIES,
          retryCount: decision.retryCount,
          checksToRetry: decision.checksToRetry,
          instruction: 're-run the named check(s), record the outcomes in fidelity-input.json with retryCount=1, then re-run the gate; the retry window is strictly pre-commitment and nothing is written now',
        },
        reason: { code: 'infra-retry', detail: `${decision.checksToRetry.join(', ')} produced no evidence; one pre-commitment retry is available` },
      },
    }
  }

  const record = {
    schemaVersion: 1,
    command: 'fidelity-gate',
    status: 'ok',
    pairId: input.pairId,
    corrupted: input.corrupted,
    grade: decision.grade,
    disputeReason: decision.disputeReason,
    pairEquivalence: input.pairEquivalence,
    checks: decision.checks,
    decisionRow: decision.decisionRow,
    retry: { requested: false, attempts: decision.retryCount, exhausted: decision.retryExhausted },
    escalation: escalationFor(decision.grade, allowHumanFidelity),
    decidedAt: now(),
  }
  const outputPath = options.out ? resolve(options.out) : fidelityOutputPath(problemDir)
  await atomicJson(outputPath, record, io)
  return { status: 'ok', outputPath, record }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'fidelity-gate — formalization fidelity gate: nine-row decision table (design §4.3)',
  'usage: fidelity-gate.mjs --problem <dir> [--input <fidelity-input.json>] [--out <fidelity.json>] [--allow-human-fidelity]',
  '  reads  <problem>/fidelity-input.json: {schemaVersion:1, backTranslation:{equivalent,differences},',
  '         premiseAudit:{missing,extra}, anchorCheck?:{status,evidenceRef}, pairEquivalence?, retryCount?}',
  '  writes <problem>/fidelity.json: {grade, disputeReason, pairEquivalence, checks, decisionRow, retry, escalation, decidedAt}',
  '  grades: anchored | human-confirmed | model-assessed | disputed',
  '  disputeReason: anchor-failed (kernel evidence) · model-judgment (rows 5-8) · infra-failure (rows 4/9)',
  '  infra-failure is retried ONCE inside the gate before a dispute commits: exit 3 asks for the re-run;',
  '  set retryCount=1 on the re-run, and a second infra outcome commits disputeReason=infra-failure (never retried again)',
  '  --allow-human-fidelity  a committed dispute escalates (human-escalation) instead of terminal-fidelity-failed',
  'exit codes: 0 decided grade written · 3 retry-requested (nothing written) · 2 blocked (config-invalid) · single-line JSON on stdout',
].join('\n')

async function handle(argv, deps = {}) {
  const options = parseFlags(argv, ['problem', 'input', 'out', 'allow-human-fidelity'], { required: ['problem'], booleans: ['allow-human-fidelity'] })
  if (options.help) return 'help'
  await ensureWritable(options.problem)
  const result = await runFidelityGate({
    problem: options.problem,
    input: options.input ?? null,
    out: options.out ?? null,
    allowHumanFidelity: Boolean(options['allow-human-fidelity']),
  }, deps)
  return { exitCode: result.status === 'ok' ? 0 : 3, report: result.record }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli('fidelity-gate', HELP, argv, (args => handle(args, deps)))
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
