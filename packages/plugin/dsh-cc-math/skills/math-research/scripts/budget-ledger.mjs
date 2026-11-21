import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicJson, ensureWritable, exists, fail, hashFile, parseFlags, readJson, runCli } from './storage.lib.mjs'
import { validateRunManifest } from './run-manifest.lib.mjs'

// Budget ledger (design §3.3, §5.3): per-run reservation/settlement
// bookkeeping with write-ahead intents. Exactly one writer — the main
// conversation's process — ever touches budget.json, and every mutation
// rewrites the whole file atomically (temp + rename); there is no append.
//
// Semantics:
//  * reserve: admission `charged + new envelope ≤ cap.tokens` (charged =
//    settled usage + retained discarded charges + outstanding envelopes) and
//    `intents + 1 ≤ cap.attempts`; the run deadline is checked too
//    (cooperative; refusal codes below). Exit 2 on refusal.
//  * settle: keyed by opId, idempotent — replaces the reservation (or a
//    retained rollback charge, when late evidence arrives) with actual usage.
//  * rollback-unsettled: outstanding intents are marked `discarded` and their
//    envelope is RETAINED as a conservative charge (§3.3: rollback never
//    refunds — actual usage is unknowable, so the envelope is settled at
//    face value until a later reconciliation replaces it).
//  * resume: fixed replay order — (1) reconcile by result.json hash against
//    a results directory, then (2) roll back what is still unsettled.

export const REASON_CODES = ['config-invalid', 'ledger-missing', 'budget-exceeded', 'attempt-cap-exceeded', 'deadline-exceeded', 'unknown-op', 'io']

const OP_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/
const BUDGET_FILE = 'budget.json'

export const budgetPath = runDir => join(runDir, BUDGET_FILE)

function emptyLedger(manifest, deadline) {
  return {
    schemaVersion: 1,
    cap: { attempts: manifest.budget.attempts, tokens: manifest.budget.tokens, wallClockMs: manifest.budget.wallClockMs, deadline },
    intents: [],
  }
}

function validateLedgerShape(ledger) {
  assert(ledger && typeof ledger === 'object' && !Array.isArray(ledger), 'budget.json must be an object', 'ledger-missing')
  assert(ledger.schemaVersion === 1, 'budget.json must be schemaVersion 1', 'ledger-missing')
  const cap = ledger.cap
  assert(cap && Number.isInteger(cap.attempts) && Number.isInteger(cap.tokens), 'budget.json cap is malformed', 'ledger-missing')
  assert(Array.isArray(ledger.intents), 'budget.json intents must be an array', 'ledger-missing')
  for (const intent of ledger.intents) {
    assert(intent && typeof intent === 'object' && typeof intent.opId === 'string', 'ledger intent is malformed', 'ledger-missing')
    assert(['outstanding', 'settled', 'discarded'].includes(intent.status), `ledger intent ${intent.opId} has unknown status`, 'ledger-missing')
  }
}

async function loadLedger(runDir, { io = fs } = {}) {
  const path = budgetPath(runDir)
  let ledger
  try { ledger = await readJson(path, 'budget.json') }
  catch (e) { if (e.code === 'ENOENT') fail('ledger-missing', `no budget ledger at ${path}; run init first`); throw e }
  validateLedgerShape(ledger)
  return ledger
}

/** Settled/discarded intents charge their recorded total; outstanding ones charge their envelope. */
export function totals(ledger, nowIso = null) {
  let settled = 0
  let discarded = 0
  let outstanding = 0
  for (const intent of ledger.intents) {
    if (intent.status === 'outstanding') outstanding += intent.envelopeTokens
    else {
      const charged = intent.settlement?.totalTokens ?? intent.envelopeTokens
      if (intent.status === 'settled') settled += charged
      else discarded += charged
    }
  }
  const charged = settled + discarded + outstanding
  const afterDeadline = Boolean(ledger.cap.deadline && nowIso && nowIso > ledger.cap.deadline)
  return {
    attemptsUsed: ledger.intents.length,
    attemptsCap: ledger.cap.attempts,
    settledTokens: settled,
    discardedChargeTokens: discarded,
    outstandingReservedTokens: outstanding,
    chargedTokens: charged,
    tokensCap: ledger.cap.tokens,
    remainingTokens: ledger.cap.tokens - charged,
    deadline: ledger.cap.deadline ?? null,
    afterDeadline,
  }
}

async function loadManifestForInit(runDir) {
  const result = validateRunManifest(await readJson(join(runDir, 'run-manifest.json'), 'run-manifest.json'))
  if (!result.ok) fail('config-invalid', `run-manifest.json is invalid: ${result.errors.join('; ')}`)
  return result.value
}

export async function initLedger(runDir, { io = fs, now = () => new Date().toISOString() } = {}) {
  const manifest = await loadManifestForInit(runDir, io)
  const created = Date.parse(manifest.createdAt)
  const deadline = Number.isFinite(created) ? new Date(created + manifest.budget.wallClockMs).toISOString() : null
  const path = budgetPath(runDir)
  if (await exists(path)) {
    const existing = await readJson(path, 'budget.json')
    const wanted = emptyLedger(manifest, deadline).cap
    const same = existing.schemaVersion === 1 && existing.cap && existing.cap.attempts === wanted.attempts && existing.cap.tokens === wanted.tokens && existing.cap.wallClockMs === wanted.wallClockMs
    if (!same) fail('config-invalid', 'budget.json already exists with different caps; refusing to clobber')
    return { subcommand: 'init', reused: true, ...report(runDir, await loadLedger(runDir, { io }), now()) }
  }
  await io.mkdir(runDir, { recursive: true })
  const ledger = emptyLedger(manifest, deadline)
  await atomicJson(path, ledger, io)
  return { subcommand: 'init', reused: false, ...report(runDir, ledger, now()) }
}

const report = (runDir, ledger, nowIso) => ({ runDir: resolve(runDir), cap: ledger.cap, totals: totals(ledger, nowIso), intents: ledger.intents })

function admit(ledger, envelopeTokens, nowIso) {
  const current = totals(ledger, nowIso)
  if (current.afterDeadline) fail('deadline-exceeded', `run deadline ${ledger.cap.deadline} has passed; no new reservations`)
  if (current.attemptsUsed + 1 > current.attemptsCap) fail('attempt-cap-exceeded', `reservation would exceed maxAttempts (${current.attemptsCap})`)
  if (current.chargedTokens + envelopeTokens > current.tokensCap) {
    fail('budget-exceeded', `admission refused: charged ${current.chargedTokens} + new ${envelopeTokens} > cap ${current.tokensCap} (settled ${current.settledTokens}, discarded ${current.discardedChargeTokens}, outstanding ${current.outstandingReservedTokens})`)
  }
}

export async function reserve(runDir, { opId, envelopeTokens, problemId = null, attemptId = null, kind = 'attempt-dispatch' }, { io = fs, now = () => new Date().toISOString() } = {}) {
  assert(typeof opId === 'string' && OP_ID.test(opId), 'opId must match the op-id grammar')
  assert(Number.isInteger(envelopeTokens) && envelopeTokens > 0, 'envelopeTokens must be a positive integer')
  const ledger = await loadLedger(runDir, { io })
  assert(!ledger.intents.some(intent => intent.opId === opId), `opId ${opId} is already reserved`, 'unknown-op')
  const at = now()
  admit(ledger, envelopeTokens, at)
  ledger.intents.push({ opId, kind, problemId, attemptId, envelopeTokens, status: 'outstanding', recordedAt: at, settledAt: null, discardedAt: null, settlement: null })
  await atomicJson(budgetPath(runDir), ledger, io)
  return { subcommand: 'reserve', accepted: true, opId, ...report(runDir, ledger, at) }
}

const usageOf = (promptTokens, completionTokens) => {
  assert(Number.isInteger(promptTokens) && promptTokens >= 0, 'promptTokens must be a non-negative integer')
  assert(Number.isInteger(completionTokens) && completionTokens >= 0, 'completionTokens must be a non-negative integer')
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

export async function settle(runDir, { opId, promptTokens, completionTokens, resultHash = null, source = 'settle' }, { io = fs, now = () => new Date().toISOString() } = {}) {
  const ledger = await loadLedger(runDir, { io })
  const intent = ledger.intents.find(entry => entry.opId === opId)
  if (!intent) fail('unknown-op', `no reservation recorded for opId ${opId}`)
  const usage = usageOf(promptTokens, completionTokens)
  const at = now()
  const afterDeadline = Boolean(ledger.cap.deadline && at > ledger.cap.deadline)
  if (intent.status === 'settled' && intent.settlement
    && intent.settlement.promptTokens === usage.promptTokens && intent.settlement.completionTokens === usage.completionTokens
    && intent.settlement.resultHash === resultHash && intent.settlement.source === source) {
    return { subcommand: 'settle', changed: false, opId, ...report(runDir, ledger, at) }
  }
  intent.settlement = { ...usage, source, resultHash, afterDeadline }
  intent.status = 'settled'
  intent.settledAt = at
  await atomicJson(budgetPath(runDir), ledger, io)
  return { subcommand: 'settle', changed: true, opId, ...report(runDir, ledger, at) }
}

function rollbackInPlace(ledger, at) {
  const discarded = []
  for (const intent of ledger.intents) {
    if (intent.status !== 'outstanding') continue
    // Rollback never refunds (§3.3): the envelope stays on the books as a
    // conservative charge; only a later settlement with real usage may
    // replace it.
    intent.status = 'discarded'
    intent.discardedAt = at
    intent.settlement = { promptTokens: 0, completionTokens: 0, totalTokens: intent.envelopeTokens, source: 'rollback', resultHash: null, afterDeadline: false, conservativeCharge: true }
    discarded.push(intent.opId)
  }
  return discarded
}

export async function rollbackUnsettled(runDir, { io = fs, now = () => new Date().toISOString() } = {}) {
  const ledger = await loadLedger(runDir, { io })
  const at = now()
  const discarded = rollbackInPlace(ledger, at)
  await atomicJson(budgetPath(runDir), ledger, io)
  return { subcommand: 'rollback-unsettled', discarded, ...report(runDir, ledger, at) }
}

async function collectResults(dir, { io = fs } = {}) {
  const found = []
  async function walk(current) {
    for (const entry of await io.readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name === 'result.json') found.push(path)
    }
  }
  await walk(dir)
  return found.sort()
}

export async function resume(runDir, resultsDir, { io = fs, now = () => new Date().toISOString() } = {}) {
  const ledger = await loadLedger(runDir, { io })
  const at = now()
  const reconciled = []
  // Fixed replay order (§3.3/§5.1): first reconcile unsettled intents by
  // result.json hash, THEN roll back whatever remains unsettled.
  if (resultsDir) {
    for (const path of await collectResults(resultsDir, { io })) {
      let result
      try { result = await readJson(path, `result file ${path}`) } catch { continue }
      if (!result || typeof result.opId !== 'string' || !result.usage) continue
      const promptTokens = Number(result.usage.promptTokens)
      const completionTokens = Number(result.usage.completionTokens)
      if (!Number.isInteger(promptTokens) || !Number.isInteger(completionTokens) || promptTokens < 0 || completionTokens < 0) continue
      const intent = ledger.intents.find(entry => entry.opId === result.opId && entry.status !== 'settled')
      if (!intent) continue
      const resultHash = await hashFile(path)
      intent.settlement = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, source: 'reconcile', resultHash, afterDeadline: false }
      intent.status = 'settled'
      intent.settledAt = at
      reconciled.push({ opId: result.opId, resultHash })
    }
  }
  const discarded = rollbackInPlace(ledger, at)
  await atomicJson(budgetPath(runDir), ledger, io)
  return { subcommand: 'resume', reconciled, discarded, ...report(runDir, ledger, at) }
}

export async function ledgerStatus(runDir, { io = fs, now = () => new Date().toISOString() } = {}) {
  const ledger = await loadLedger(runDir, { io })
  return { subcommand: 'status', ...report(runDir, ledger, now()) }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'budget-ledger — run budget reservation/settlement (design §3.3, §5.3)',
  'usage: budget-ledger.mjs <subcommand> --run <dir> [options]',
  '  init                                                   create budget.json from run-manifest.json (idempotent)',
  '  reserve --op-id <id> --envelope-tokens <n> [--problem-id p] [--attempt-id a] [--kind k]',
  '  settle --op-id <id> --prompt-tokens <n> --completion-tokens <n> [--result-hash h]',
  '  rollback-unsettled                                     discard outstanding intents (never refunds)',
  '  resume --results <dir>                                 reconcile by result.json hash, then roll back',
  '  status                                                 print totals',
  'exit codes: 0 ok · 2 blocked/refused (budget-exceeded, attempt-cap-exceeded, deadline-exceeded, config-invalid, ledger-missing, unknown-op) · single-line JSON on stdout',
].join('\n')

const integer = (value, label) => {
  const parsed = Number(value)
  assert(value !== undefined && Number.isInteger(parsed) && String(parsed) === String(value).trim(), `${label} must be an integer`)
  return parsed
}

async function handle(argv) {
  const options = parseFlags(argv, ['run', 'op-id', 'envelope-tokens', 'prompt-tokens', 'completion-tokens', 'problem-id', 'attempt-id', 'kind', 'result-hash', 'results'], { required: ['run'] })
  if (options.help) return 'help'
  if (!options.subcommand) fail('config-invalid', 'a subcommand is required')
  await ensureWritable(options.run)
  switch (options.subcommand) {
    case 'init': {
      const result = await initLedger(options.run)
      return { exitCode: 0, report: { schemaVersion: 1, command: 'budget-ledger', status: 'ok', ...result } }
    }
    case 'reserve': {
      for (const key of ['op-id', 'envelope-tokens']) if (!options[key]) fail('config-invalid', `--${key} is required`)
      const result = await reserve(options.run, {
        opId: options['op-id'],
        envelopeTokens: integer(options['envelope-tokens'], 'envelopeTokens'),
        problemId: options['problem-id'] ?? null,
        attemptId: options['attempt-id'] ?? null,
        kind: options.kind ?? 'attempt-dispatch',
      })
      return { exitCode: 0, report: { schemaVersion: 1, command: 'budget-ledger', status: 'ok', ...result } }
    }
    case 'settle': {
      for (const key of ['op-id', 'prompt-tokens', 'completion-tokens']) if (!options[key]) fail('config-invalid', `--${key} is required`)
      const result = await settle(options.run, {
        opId: options['op-id'],
        promptTokens: integer(options['prompt-tokens'], 'promptTokens'),
        completionTokens: integer(options['completion-tokens'], 'completionTokens'),
        resultHash: options['result-hash'] ?? null,
      })
      return { exitCode: 0, report: { schemaVersion: 1, command: 'budget-ledger', status: 'ok', ...result } }
    }
    case 'rollback-unsettled': {
      const result = await rollbackUnsettled(options.run)
      return { exitCode: 0, report: { schemaVersion: 1, command: 'budget-ledger', status: 'ok', ...result } }
    }
    case 'resume': {
      if (!options.results) fail('config-invalid', '--results is required')
      const result = await resume(options.run, options.results)
      return { exitCode: 0, report: { schemaVersion: 1, command: 'budget-ledger', status: 'ok', ...result } }
    }
    case 'status': {
      const result = await ledgerStatus(options.run)
      return { exitCode: 0, report: { schemaVersion: 1, command: 'budget-ledger', status: 'ok', ...result } }
    }
    default: fail('config-invalid', `unknown subcommand ${options.subcommand}`)
  }
}

export async function main(argv = process.argv.slice(2)) {
  return runCli('budget-ledger', HELP, argv, handle)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
