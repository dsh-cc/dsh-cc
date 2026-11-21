/**
 * Three-layer verification behavioral tests (design §4.4): the three verdicts
 * stay separate (L2 kernel verdict, L1 tri-state with the isolation tier
 * honoured, L3 §4.3 grade), the L1/L2 conflict rule forces
 * statement_faithful=disputed and exits with the dedicated escalate status, a
 * partial-tier L1 failure is REFUSED rather than written, and the emitted
 * typed verification records {kind, verdict, bindingHashes} are accepted by
 * claim-ledger (hash binding included). lean-run / sympy-run are mocked as
 * subprocesses — no Lean, no Python.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildRecords, computationVerdict, enforceIsolationTier, main, parseScriptReport, runVerification,
} from '../skills/math-research/scripts/math-verify.mjs'
import { openClaim, transition } from '../skills/math-research/scripts/claim-ledger.mjs'
import { exists } from '../skills/math-research/scripts/storage.lib.mjs'
import { HEX, cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

const STATEMENT_TYPE = '∀ (a b : Nat), a + b = b + a'
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

// ---------------------------------------------------------------------------
// Fixtures + mocked subprocesses
// ---------------------------------------------------------------------------
async function makeProblem({ fidelity = 'anchored', fidelityInput = null }: { fidelity?: string | null; fidelityInput?: unknown } = {}) {
  const problem = await roots.make('mrh-verify-')
  const statement = 'import Mathlib.Core\n\ntheorem p1_stmt : ∀ (a b : Nat), a + b = b + a := sorry\n'
  const proof = 'import Mathlib.Core\n\ntheorem p1_proof : ∀ (a b : Nat), a + b = b + a := fun a b => Nat.add_comm a b\n'
  const binding = JSON.stringify({
    statementDeclName: 'p1_stmt', proofDeclName: 'p1_proof', mathlibRev: 'v4.35.0',
    toolchainDigest: HEX('d'), statementTypeText: STATEMENT_TYPE,
  }, null, 2)
  await writeFile(join(problem, 'statement.lean'), statement)
  await writeFile(join(problem, 'proof.lean'), proof)
  await writeFile(join(problem, 'binding.json'), binding)
  if (fidelity !== null) {
    await writeFile(join(problem, 'fidelity.json'), JSON.stringify({
      schemaVersion: 1, command: 'fidelity-gate', status: 'ok', pairId: 'p1', corrupted: false,
      grade: fidelity, disputeReason: fidelity === 'disputed' ? 'model-judgment' : null,
      pairEquivalence: null, checks: {}, decisionRow: 1, retry: {}, escalation: null, decidedAt: isoNow(),
    }, null, 2))
  }
  if (fidelityInput !== null) await writeFile(join(problem, 'fidelity-input.json'), JSON.stringify(fidelityInput))
  const script = join(problem, 'checker.py')
  await writeFile(script, 'raise SystemExit(0)\n')
  return { problem, script, hashes: { statement: sha256(statement), proof: sha256(proof), binding: sha256(binding) } }
}

const L2_HASHES = { statement: HEX('1'), proof: HEX('2'), binding: HEX('3'), envReceiptDigest: HEX('4'), combined: HEX('5') }

function leanReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, command: 'lean-run', mode: 'proof-check', status: 'passed', failure: null,
    binding: { statementDeclName: 'p1_stmt', proofDeclName: 'p1_proof', statementTypeText: STATEMENT_TYPE, proofTypeText: STATEMENT_TYPE, typesMatch: true },
    axioms: ['propext', 'Classical.choice', 'Quot.sound'],
    hashes: { ...L2_HASHES },
    diagnostics: [], rawDiagnostics: null,
    ...overrides,
  }
}

const sympyReport = (status: string, isolation: 'full' | 'partial') => ({
  schemaVersion: 1, command: 'sympy-run', status, isolation, advisory: isolation === 'partial',
  timedOut: false, exitCode: status === 'pass' ? 0 : 1, elapsedMs: 12, cwd: '/tmp/l1', python: { python: '3.12.0', sympy: true },
  stdoutTail: '', stderrTail: '',
})

interface Plan { leanRun?: Record<string, unknown>; sympyRun?: Record<string, unknown> }
const fakeRunScript = (plan: Plan) => async (argv: string[]) => {
  const script = argv[0]?.split('/').pop()
  const report = script === 'lean-run.mjs' ? plan.leanRun : script === 'sympy-run.mjs' ? plan.sympyRun : undefined
  if (!report) throw new Error(`unexpected subprocess: ${script}`)
  return { exitCode: report.status === 'passed' || report.status === 'ok' ? 0 : 1, stdout: `${JSON.stringify(report)}\n`, stderr: '', spawnError: false, timedOut: false }
}

const run = (problem: string, extra: Record<string, unknown>, plan: Plan) =>
  runVerification({ problem, env: '/env', ...extra }, { runScript: fakeRunScript(plan) })

// ---------------------------------------------------------------------------
// Three verdicts, one per layer
// ---------------------------------------------------------------------------
describe('math-verify — three-layer verdicts (§4.4)', () => {
  it('records all three verdicts independently, with L2 hash binding', async () => {
    const { problem, script, hashes } = await makeProblem({ fidelity: 'anchored' })
    const recordsPath = join(problem, 'records.json')
    const { status, report } = await run(problem, { computation: script, records: recordsPath }, { leanRun: leanReport(), sympyRun: sympyReport('pass', 'full') })
    expect(status).toBe('ok')
    expect(report.verdicts).toEqual({ computation_verified: 'pass', formal_proof_valid: 'pass', statement_faithful: 'anchored' })
    expect(report.l2).toMatchObject({ status: 'passed', failure: null, hashes: L2_HASHES })
    expect(report.l1).toMatchObject({ status: 'pass', isolation: 'full', authoritative: true, advisory: false })
    expect(report.conflict).toMatchObject({ detected: false })
    expect(report.fidelity).toMatchObject({ grade: 'anchored', gateRan: false })

    // Typed records: ledger shapes, hex hash binding, no evidence paths.
    expect(report.records.map((record: { kind: string }) => record.kind)).toEqual(['l2-pass', 'fidelity'])
    expect(report.records[0]).toMatchObject({ kind: 'l2-pass', verdict: 'pass', mechanism: 'lean', bindingHashes: L2_HASHES })
    // The fidelity record binds the actual artifacts on disk.
    expect(report.records[1].bindingHashes).toEqual({ fidelity: sha256(await readFile(join(problem, 'fidelity.json'), 'utf8')), statement: hashes.statement })
    for (const record of report.records) for (const hex of Object.values(record.bindingHashes)) expect(hex).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(await readFile(recordsPath, 'utf8'))).toEqual(report.records)
  })

  it('an L2 failure is a normal verdict: exit 0, formal_proof_valid=fail, record verdict fail', async () => {
    const { problem } = await makeProblem({ fidelity: 'model-assessed' })
    const plan = { leanRun: leanReport({ status: 'failed', failure: { class: 'sorry', detail: 'proof mode tolerates no sorry' } }) }
    const { status, report } = await run(problem, { records: join(problem, 'records.json') }, plan)
    expect(status).toBe('ok')
    expect(report.verdicts).toMatchObject({ formal_proof_valid: 'fail', computation_verified: 'not-applicable' })
    expect(report.l2.failure).toMatchObject({ class: 'sorry' })
    expect(report.records[0]).toMatchObject({ kind: 'l2-pass', verdict: 'fail' })
  })

  it('L3 comes from fidelity.json; without any L3 record the verification blocks', async () => {
    const { problem } = await makeProblem({ fidelity: null })
    const { exitCode, output } = await cli(main, ['--problem', problem, '--env', '/env'], { runScript: fakeRunScript({ leanRun: leanReport() }) })
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ status: 'blocked', reason: { code: 'fidelity-missing' } })
  })

  it('a fidelity-input.json is computed by the gate when fidelity.json is absent', async () => {
    const { problem } = await makeProblem({
      fidelity: null,
      fidelityInput: { schemaVersion: 1, pairId: 'p1', backTranslation: { equivalent: true, differences: [] }, premiseAudit: { missing: [], extra: [] } },
    })
    const { status, report } = await run(problem, {}, { leanRun: leanReport() })
    expect(status).toBe('ok')
    expect(report.verdicts.statement_faithful).toBe('model-assessed')
    expect(report.fidelity).toMatchObject({ grade: 'model-assessed', decisionRow: 1, gateRan: true })
    expect(await exists(join(problem, 'fidelity.json'))).toBe(true)
  })

  it('a pending gate retry propagates as exit 3 / status retry and writes no records', async () => {
    const { problem } = await makeProblem({
      fidelity: null,
      fidelityInput: { schemaVersion: 1, backTranslation: { equivalent: true, differences: [] }, premiseAudit: { missing: [], extra: [] }, anchorCheck: { status: 'cannot-run' } },
    })
    const recordsPath = join(problem, 'records.json')
    const { exitCode, output } = await cli(main, ['--problem', problem, '--env', '/env', '--records', recordsPath], { runScript: fakeRunScript({ leanRun: leanReport() }) })
    expect(exitCode).toBe(3)
    expect(output).toMatchObject({ status: 'retry-requested', retry: { requested: true } })
    expect(await exists(recordsPath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// L1 tri-state + isolation tiers
// ---------------------------------------------------------------------------
describe('math-verify — L1 tri-state and honest isolation (§4.4)', () => {
  it('absent python/sympy is not-applicable, never pass or fail', async () => {
    const { problem, script } = await makeProblem()
    const { report } = await run(problem, { computation: script }, { leanRun: leanReport(), sympyRun: { ...sympyReport('not-applicable', 'partial'), python: { python: null, sympy: false }, reason: 'python3 >=3.10 with sympy is unavailable' } })
    expect(report.verdicts.computation_verified).toBe('not-applicable')
    expect(report.records.map((record: { kind: string }) => record.kind)).toEqual(['l2-pass', 'fidelity'])
  })

  it('an omitted checker leaves L1 not-run', async () => {
    const { problem } = await makeProblem()
    const { report } = await run(problem, {}, { leanRun: leanReport() })
    expect(report.verdicts.computation_verified).toBe('not-applicable')
    expect(report.l1).toMatchObject({ status: 'not-run', isolation: null, authoritative: false, advisory: false })
  })

  it('a PARTIAL-tier failure is refused outright: exit 2, no records written', async () => {
    const { problem, script } = await makeProblem()
    const recordsPath = join(problem, 'records.json')
    const { exitCode, output } = await cli(main, ['--problem', problem, '--env', '/env', '--computation', script, '--records', recordsPath], {
      runScript: fakeRunScript({ leanRun: leanReport(), sympyRun: sympyReport('fail', 'partial') }),
    })
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ status: 'blocked', reason: { code: 'isolation-violation' } })
    expect(String((output.reason as { detail: string }).detail)).toContain('advisory')
    expect(await exists(recordsPath)).toBe(false)
    // The refusal is the enforcement, not a downstream convention.
    expect(() => enforceIsolationTier({ status: 'fail', isolation: 'partial' })).toThrow(/advisory/)
    expect(computationVerdict({ status: 'fail', isolation: 'partial' })).toBe('not-applicable')
    expect(computationVerdict({ status: 'fail', isolation: 'full' })).toBe('fail')
  })

  it('a partial-tier PASS is still recorded as pass (positive support needs no network isolation)', async () => {
    const { problem, script } = await makeProblem()
    const { report } = await run(problem, { computation: script }, { leanRun: leanReport(), sympyRun: sympyReport('pass', 'partial') })
    expect(report.verdicts.computation_verified).toBe('pass')
    expect(report.l1).toMatchObject({ isolation: 'partial', authoritative: false, advisory: true })
  })

  it('a sympy-run error yields not-applicable without counterexample evidence', async () => {
    const { problem, script } = await makeProblem()
    const { report } = await run(problem, { computation: script }, { leanRun: leanReport(), sympyRun: { ...sympyReport('error', 'full'), timedOut: true } })
    expect(report.verdicts.computation_verified).toBe('not-applicable')
    expect(report.records.some((record: { kind: string }) => record.kind === 'counterexample')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The L1/L2 conflict rule (§4.4, §6.3)
// ---------------------------------------------------------------------------
describe('math-verify — L1/L2 conflict rule (§4.4, §6.3)', () => {
  it('authoritative L1 fail + L2 pass forces statement_faithful=disputed and exits 4', async () => {
    const { problem, script } = await makeProblem({ fidelity: 'anchored' })
    const recordsPath = join(problem, 'records.json')
    const { exitCode, output } = await cli(main, ['--problem', problem, '--env', '/env', '--computation', script, '--records', recordsPath], {
      runScript: fakeRunScript({ leanRun: leanReport(), sympyRun: sympyReport('fail', 'full') }),
    })
    expect(exitCode).toBe(4)
    expect(output).toMatchObject({
      status: 'conflict',
      verdicts: { computation_verified: 'fail', formal_proof_valid: 'pass', statement_faithful: 'disputed' },
      conflict: { detected: true, kind: 'l1-counterexample-vs-l2-pass' },
      fidelity: { grade: 'anchored' },
    })
    // The conflict is recorded as a full-isolation counterexample record.
    const records = JSON.parse(await readFile(recordsPath, 'utf8'))
    expect(records.find((record: { kind: string }) => record.kind === 'counterexample')).toMatchObject({
      kind: 'counterexample', verdict: 'confirmed', mechanism: 'computation', isolation: 'full',
    })
  })

  it('a full-tier L1 fail with a FAILING L2 proof is no conflict (nothing silently resolved)', async () => {
    const { problem, script } = await makeProblem({ fidelity: 'model-assessed' })
    const { status, report } = await run(problem, { computation: script }, {
      leanRun: leanReport({ status: 'failed', failure: { class: 'lean-error', detail: '2 error diagnostic(s)' } }),
      sympyRun: sympyReport('fail', 'full'),
    })
    expect(status).toBe('ok')
    expect(report.conflict).toMatchObject({ detected: false })
    expect(report.verdicts).toEqual({ computation_verified: 'fail', formal_proof_valid: 'fail', statement_faithful: 'model-assessed' })
  })

  it('a full-tier L1 pass never disturbs the L3 grade', async () => {
    const { problem, script } = await makeProblem({ fidelity: 'model-assessed' })
    const { report } = await run(problem, { computation: script }, { leanRun: leanReport(), sympyRun: sympyReport('pass', 'full') })
    expect(report.verdicts.statement_faithful).toBe('model-assessed')
    expect(report.conflict.detected).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Records are claim-ledger ready (§6.3)
// ---------------------------------------------------------------------------
describe('math-verify — typed records feed claim-ledger (§6.3)', () => {
  it('model-assessed records carry open → proven-of-formal-statement', async () => {
    const { problem } = await makeProblem({ fidelity: 'model-assessed' })
    const runDir = await roots.make('mrh-run-')
    const recordsPath = join(runDir, 'records.json')
    const { report } = await run(problem, { records: recordsPath }, { leanRun: leanReport() })
    await openClaim(runDir, 'p1')
    const result = await transition(runDir, 'p1', 'proven-of-formal-statement', report.records, {})
    expect(result).toMatchObject({ from: 'open', to: 'proven-of-formal-statement', subcommand: 'transition' })
  })

  it('a conflict record set represents the §6.3 state pair in the ledger', async () => {
    const { problem } = await makeProblem({ fidelity: 'model-assessed' })
    const runDir = await roots.make('mrh-run-')
    const { report } = await run(problem, {}, { leanRun: leanReport() })
    expect(report.conflict.detected).toBe(false)
    // Re-run with an authoritative counterexample on a model-assessed problem:
    // the grade stays model-assessed, the verdict is forced to disputed, and
    // the conflict rides in the record set as counterexample + dispute.
    const { problem: problem2, script } = await makeProblem({ fidelity: 'model-assessed' })
    const conflictRun = await run(problem2, { computation: script }, { leanRun: leanReport(), sympyRun: sympyReport('fail', 'full') })
    expect(conflictRun.report.records.map((record: { kind: string }) => record.kind)).toEqual(['l2-pass', 'fidelity', 'counterexample', 'dispute'])
    await openClaim(runDir, 'p2')
    // open → proven-of-formal-statement carries the records...
    const opened = await transition(runDir, 'p2', 'proven-of-formal-statement', conflictRun.report.records, {})
    expect(opened).toMatchObject({ from: 'open', to: 'proven-of-formal-statement' })
    // ...and the counterexample guard then blocks promotion to `proven` (§6.3).
    await expect(transition(runDir, 'p2', 'proven', [{ kind: 'fidelity', verdict: 'anchored' }], {})).rejects.toMatchObject({ code: 'counterexample-outstanding' })
  })

  it('buildRecords keeps only sha256-shaped hashes (ledger record validation)', async () => {
    const { problem } = await makeProblem()
    const records = await buildRecords({
      l2: leanReport({ hashes: { statement: HEX('a'), proof: HEX('b'), broken: 'not-a-hash', missing: null } }),
      l1: null,
      fidelity: { grade: 'anchored' },
      problemDir: problem,
      computationScript: null,
    })
    expect(records[0].bindingHashes).toEqual({ statement: HEX('a'), proof: HEX('b') })
    expect(records).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Failure propagation from the verifier subprocesses
// ---------------------------------------------------------------------------
describe('math-verify — subprocess contract', () => {
  it('a blocked lean-run propagates its reason code and exit 2', async () => {
    const { problem } = await makeProblem()
    const blocked = { schemaVersion: 1, command: 'lean-run', status: 'blocked', reason: { code: 'toolchain-missing', detail: 'no env receipt' } }
    const { exitCode, output } = await cli(main, ['--problem', problem, '--env', '/env'], { runScript: fakeRunScript({ leanRun: blocked }) })
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ status: 'blocked', reason: { code: 'toolchain-missing' } })
  })

  it('an unparseable or empty subprocess result blocks with io', async () => {
    const { problem } = await makeProblem()
    const { exitCode, output } = await cli(main, ['--problem', problem, '--env', '/env'], { runScript: async () => ({ exitCode: 0, stdout: 'not json\n', stderr: '', spawnError: false, timedOut: false }) })
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ status: 'blocked', reason: { code: 'io' } })
    expect(() => parseScriptReport({ exitCode: 0, stdout: '', stderr: '', spawnError: false, timedOut: false }, 'lean-run')).toThrow(/no JSON/)
  })
})
