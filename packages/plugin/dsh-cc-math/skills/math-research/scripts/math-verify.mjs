import { spawn as nodeSpawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicJson, ensureWritable, exists, fail, hashFile, parseFlags, readJson, runCli, SCRIPTS_DIR } from './storage.lib.mjs'
import { GRADES, runFidelityGate } from './fidelity-gate.mjs'

// Three-layer verification (design §4.4) — one problem directory, one verdict
// per layer, never merged:
//
//   L2 formal_proof_valid   `lean-run.mjs` (subprocess): the kernel's answer and
//                           the ONLY source of proof correctness. Its hash
//                           binding (statement.lean + proof.lean + binding.json
//                           + env receipt digest) is carried into the typed
//                           record, so any input change invalidates the verdict.
//   L1 computation_verified `sympy-run.mjs` (subprocess, OPTIONAL, tri-state
//                           pass|fail|not-applicable) with the isolation tier
//                           honoured: only a `full`-tier failure may become
//                           `fail` (authoritative counterexample evidence). A
//                           `partial`-tier failure is advisory and is REFUSED
//                           here — the ledger would call it an error, so this
//                           script never writes it (exit 2, isolation-violation).
//   L3 statement_faithful   the §4.3 fidelity grade, read from fidelity.json (or
//                           computed from fidelity-input.json by the gate).
//
// L1/L2 conflict rule (§6.3, r2 finding 13): an authoritative full-tier L1
// failure while L2 passes sets statement_faithful=disputed and emits an
// explicit conflict marker — never silently resolved. Exit code 4 is that
// dedicated status; the skill escalates (or terminates fidelity-failed per
// allowHumanFidelity) instead of auto-resolving it.
//
// Output: the three verdicts plus `records` — typed verification records
// {kind, verdict, bindingHashes} ready for `claim-ledger.mjs --records`.

export const L1_STATUSES = Object.freeze(['pass', 'fail', 'not-applicable', 'error'])
export const CONFLICT_KIND = 'l1-counterexample-vs-l2-pass'
export const HEX64 = /^[a-f0-9]{64}$/

// ---------------------------------------------------------------------------
// Subprocess runner (injectable: tests never spawn lean or python)
// ---------------------------------------------------------------------------
const STREAM_CAP = 10 * 1024 * 1024
function defaultRunScript(argv, { timeoutMs = 1800000 } = {}) {
  return new Promise(resolveRun => {
    let child
    try { child = nodeSpawn(process.execPath, argv, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (e) { resolveRun({ exitCode: null, stdout: '', stderr: `spawn failed: ${e.message}`, spawnError: true, timedOut: false }); return }
    let stdout = ''
    let stderr = ''
    const append = (chunk, which) => {
      const text = chunk.toString('utf8')
      if (which === 'out') { if (stdout.length < STREAM_CAP) stdout += text.slice(0, STREAM_CAP - stdout.length) }
      else if (stderr.length < STREAM_CAP) stderr += text.slice(0, STREAM_CAP - stderr.length)
    }
    child.stdout.on('data', chunk => append(chunk, 'out'))
    child.stderr.on('data', chunk => append(chunk, 'err'))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 2000).unref()
    }, timeoutMs)
    child.once('error', e => { clearTimeout(timer); resolveRun({ exitCode: null, stdout, stderr: `spawn failed: ${e.message}`, spawnError: true, timedOut: false }) })
    child.once('close', exitCode => { clearTimeout(timer); resolveRun({ exitCode, stdout, stderr, spawnError: false, timedOut }) })
  })
}

/** The verifier scripts print single-line JSON on their result path (§3.4). */
export function parseScriptReport(run, label) {
  if (run.timedOut) fail('io', `${label} exceeded its time budget`)
  if (run.spawnError || run.exitCode === null) fail('io', `${label} could not run: ${String(run.stderr ?? '').trim() || 'unknown spawn failure'}`)
  const lines = String(run.stdout ?? '').trim().split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) fail('io', `${label} printed no JSON result (exit ${run.exitCode})`)
  let report
  try { report = JSON.parse(lines.at(-1)) }
  catch { fail('io', `${label} printed an unparseable result line: ${lines.at(-1).slice(0, 200)}`) }
  assert(report && typeof report === 'object' && !Array.isArray(report), `${label} result must be a JSON object`, 'io')
  if (report.status === 'blocked') fail(report.reason?.code ?? 'io', `${label} is blocked: ${report.reason?.detail ?? 'unknown reason'}`)
  return report
}

// ---------------------------------------------------------------------------
// L1 tri-state + isolation-tier enforcement (§4.4)
// ---------------------------------------------------------------------------
/** Only a full-isolation failure is authoritative; anything else is advisory. */
export function computationVerdict(l1) {
  if (!l1 || l1.status === 'not-applicable' || l1.status === 'error') return 'not-applicable'
  if (l1.status === 'pass') return 'pass'
  return l1.isolation === 'full' ? 'fail' : 'not-applicable'
}

/**
 * Refuse to write the forbidden state: a partial-tier L1 `fail` never becomes
 * `computation_verified: fail` (design §4.4 — the claim layer calls that a
 * ledger error). This is the one place that can write the state, so it refuses.
 */
export function enforceIsolationTier(l1) {
  if (!l1 || l1.status !== 'fail') return
  if (l1.isolation !== 'full') {
    fail('isolation-violation', `an L1 failure at isolation=${l1.isolation ?? 'unknown'} is advisory only and may never be written as computation_verified:fail (§4.4); re-run with a network-isolated (full) tier or feed the result to repair`)
  }
}

// ---------------------------------------------------------------------------
// Typed verification records (§6.3)
// ---------------------------------------------------------------------------
const hexOnly = hashes => Object.fromEntries(Object.entries(hashes ?? {}).filter(([, value]) => typeof value === 'string' && HEX64.test(value)))

async function fidelityHashes(problemDir) {
  const candidates = { fidelity: join(problemDir, 'fidelity.json'), fidelityInput: join(problemDir, 'fidelity-input.json'), statement: join(problemDir, 'statement.lean') }
  const hashes = {}
  for (const [key, path] of Object.entries(candidates)) {
    if (await exists(path)) hashes[key] = await hashFile(path)
  }
  return hexOnly(hashes)
}

export async function buildRecords({ l2, l1, fidelity, problemDir, computationScript = null, conflict = null }) {
  const records = []
  records.push({
    kind: 'l2-pass',
    verdict: l2.status === 'passed' ? 'pass' : 'fail',
    mechanism: 'lean',
    bindingHashes: hexOnly(l2.hashes),
  })
  records.push({
    kind: 'fidelity',
    verdict: fidelity.grade,
    bindingHashes: await fidelityHashes(problemDir),
  })
  if (l1?.status === 'fail' && l1.isolation === 'full') {
    const binding = computationScript ? { script: await hashFile(computationScript) } : {}
    records.push({ kind: 'counterexample', verdict: 'confirmed', mechanism: 'computation', isolation: 'full', bindingHashes: binding })
  }
  if (conflict?.detected) {
    // §6.3: the conflict is an explicit state pair (statement_faithful=disputed
    // + fidelity-failed/escalation), so the record set carries the dispute
    // itself. `confirmed` here means "the counterexample evidence exists" — a
    // human ruling is still a separate record, so nothing is auto-resolved.
    records.push({ kind: 'dispute', verdict: 'confirmed', mechanism: 'computation', isolation: 'full' })
  }
  return records
}

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------
export async function runVerification(options, deps = {}) {
  const { io = fs, runScript = defaultRunScript, now = () => new Date().toISOString() } = deps
  const problemDir = resolve(options.problem)
  if (!(await exists(join(problemDir, 'binding.json')))) fail('config-invalid', `${problemDir} has no binding.json; formalize the statement and write the binding first`)
  const leanRun = join(SCRIPTS_DIR, 'lean-run.mjs')
  const sympyRun = join(SCRIPTS_DIR, 'sympy-run.mjs')

  // ---- L2: the soundness core (subprocess; kernel verdict only) -----------
  const l2Args = [leanRun, '--problem', problemDir, '--env', resolve(options.env)]
  if (options.attemptId) l2Args.push('--attempt-id', options.attemptId)
  if (options.timeoutMs) l2Args.push('--timeout-ms', String(options.timeoutMs))
  const l2 = parseScriptReport(await runScript(l2Args, { label: 'lean-run' }), 'lean-run')
  assert(l2.command === 'lean-run', 'lean-run result is missing the command field', 'io')
  const l2Verdict = l2.status === 'passed' ? 'pass' : 'fail'

  // ---- L1: optional computation (tri-state, tier-honest) ------------------
  let l1 = null
  if (options.computation) {
    const scriptPath = resolve(options.computation)
    if (!(await exists(scriptPath))) fail('config-invalid', `computation checker ${scriptPath} does not exist`)
    const l1Args = [sympyRun, '--script', scriptPath]
    if (options.l1TimeoutMs) l1Args.push('--timeout-ms', String(options.l1TimeoutMs))
    if (options.workRoot) l1Args.push('--work-root', resolve(options.workRoot))
    const report = parseScriptReport(await runScript(l1Args, { label: 'sympy-run' }), 'sympy-run')
    assert(report.command === 'sympy-run', 'sympy-run result is missing the command field', 'io')
    assert(L1_STATUSES.includes(report.status), `sympy-run returned an unknown status ${report.status}`, 'io')
    l1 = report
    enforceIsolationTier(l1) // refuses the forbidden partial-tier `fail` before anything is written
  }
  const computation = computationVerdict(l1)

  // ---- L3: the §4.3 fidelity grade ---------------------------------------
  let fidelity
  let gate = null
  const fidelityPath = join(problemDir, 'fidelity.json')
  if (await exists(fidelityPath)) fidelity = await readJson(fidelityPath, 'fidelity.json')
  else if (await exists(join(problemDir, 'fidelity-input.json'))) {
    gate = await runFidelityGate({ problem: problemDir, allowHumanFidelity: Boolean(options.allowHumanFidelity) }, { io, now })
    if (gate.status !== 'ok') {
      // The gate's pre-commitment retry window is pending: no verdict yet.
      return { status: 'retry', report: gate.record }
    }
    fidelity = gate.record
  } else fail('fidelity-missing', `no fidelity.json (or fidelity-input.json) in ${problemDir}; run fidelity-gate first — L3 is never assumed`)
  assert(fidelity && typeof fidelity === 'object' && !Array.isArray(fidelity), 'fidelity.json must be a JSON object')
  assert(GRADES.includes(fidelity.grade), `fidelity.json grade must be one of ${GRADES.join('|')}`)

  // ---- Verdicts + the L1/L2 conflict rule (§4.4, §6.3) -------------------
  const conflict = l2Verdict === 'pass' && l1?.status === 'fail' && l1.isolation === 'full'
    ? {
        detected: true,
        kind: CONFLICT_KIND,
        detail: 'an authoritative full-isolation L1 failure coexists with a passing L2 proof: statement_faithful is forced to disputed and the claim escalates — the conflict is never auto-resolved (§6.3)',
      }
    : { detected: false, kind: null, detail: null }
  const statementFaithful = conflict.detected ? 'disputed' : fidelity.grade

  const records = await buildRecords({ l2, l1, fidelity, problemDir, conflict, computationScript: options.computation ? resolve(options.computation) : null })
  let recordsPath = null
  if (options.records) {
    recordsPath = resolve(options.records)
    await atomicJson(recordsPath, records, io)
  }

  const report = {
    schemaVersion: 1,
    command: 'math-verify',
    status: conflict.detected ? 'conflict' : 'ok',
    problem: problemDir,
    verdicts: { computation_verified: computation, formal_proof_valid: l2Verdict, statement_faithful: statementFaithful },
    fidelity: { grade: fidelity.grade, disputeReason: fidelity.disputeReason ?? null, decisionRow: fidelity.decisionRow ?? null, gateRan: Boolean(gate) },
    l2: { mode: l2.mode, status: l2.status, failure: l2.failure ?? null, binding: l2.binding ?? null, hashes: l2.hashes ?? null, axioms: l2.axioms ?? null },
    l1: l1
      ? { status: l1.status, isolation: l1.isolation, authoritative: l1.isolation === 'full', advisory: Boolean(l1.advisory), reason: l1.reason ?? null, elapsedMs: l1.elapsedMs ?? null, stdoutTail: l1.stdoutTail ?? null, stderrTail: l1.stderrTail ?? null }
      : { status: 'not-run', isolation: null, authoritative: false, advisory: false, reason: 'no computation checker supplied (L1 is optional)' },
    conflict,
    records,
    recordsPath,
    verifiedAt: now(),
  }
  return { status: report.status, report }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'math-verify — three-layer verification for one problem dir (design §4.4)',
  'usage: math-verify.mjs --problem <dir> --env <env-dir> [--computation <checker.py>] [--l1-timeout-ms n] [--work-root <dir>]',
  '                     [--attempt-id <id>] [--timeout-ms n] [--records <records.json>] [--out <report.json>] [--allow-human-fidelity]',
  '  L2 formal_proof_valid    lean-run.mjs subprocess: kernel pass|fail + hash binding (the soundness core)',
  '  L1 computation_verified  sympy-run.mjs subprocess, optional, tri-state: pass|fail|not-applicable',
  '                           only a FULL-isolation failure may become fail; a partial-tier fail is refused (exit 2)',
  '  L3 statement_faithful    fidelity.json (or computed from fidelity-input.json by fidelity-gate.mjs)',
  '  L1/L2 conflict           full-isolation L1 fail + L2 pass => statement_faithful forced disputed, exit 4 (escalate)',
  'failures: config-invalid · fidelity-missing · isolation-violation · io',
  'exit codes: 0 verified (any verdicts) · 4 conflict (escalate, never auto-resolve) · 3 fidelity retry pending · 2 blocked · single-line JSON on stdout',
].join('\n')

async function handle(argv, deps = {}) {
  const options = parseFlags(argv, ['problem', 'env', 'computation', 'l1-timeout-ms', 'work-root', 'attempt-id', 'timeout-ms', 'records', 'out', 'allow-human-fidelity'], { required: ['problem', 'env'], booleans: ['allow-human-fidelity'] })
  if (options.help) return 'help'
  await ensureWritable(options.problem)
  for (const [flag, value] of [['l1-timeout-ms', options['l1-timeout-ms']], ['timeout-ms', options['timeout-ms']]]) {
    if (value === undefined) continue
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 1800000) fail('config-invalid', `--${flag} must be an integer in 1000..1800000`)
  }
  const result = await runVerification({
    problem: options.problem,
    env: options.env,
    computation: options.computation ?? null,
    l1TimeoutMs: options['l1-timeout-ms'] === undefined ? null : Number(options['l1-timeout-ms']),
    workRoot: options['work-root'] ?? null,
    attemptId: options['attempt-id'] ?? null,
    timeoutMs: options['timeout-ms'] === undefined ? null : Number(options['timeout-ms']),
    records: options.records ?? null,
    allowHumanFidelity: Boolean(options['allow-human-fidelity']),
  }, deps)
  if (result.status === 'retry') return { exitCode: 3, report: result.report }
  if (options.out) await atomicJson(resolve(options.out), result.report, fs)
  return { exitCode: result.status === 'conflict' ? 4 : 0, report: result.report }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli('math-verify', HELP, argv, (args => handle(args, deps)))
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
