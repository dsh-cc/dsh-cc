/**
 * lean-run L2 check behavioral tests (design §4.1 statement-check mode, §4.4
 * proof binding): report JSON shape, scoped failure semantics (any error
 * fails; sorry-bearing diagnostics match message-code-then-substring and fail
 * PROOF mode while statement-check tolerates exactly those; other warnings
 * pass; axiom whitelist; binding checks incl. definitional-equality of the
 * recorded propositions; unparseable runs fail with raw preserved), and
 * sha256 hash binding that invalidates on any input change. All Lean
 * invocations are mocked — no Lean toolchain is required.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { contentDigest } from '../skills/math-research/scripts/mathlib-env.mjs'
import {
  computeHashBinding, isSorryDiagnostic, main, parseDiagnostics, runLeanRun,
} from '../skills/math-research/scripts/lean-run.mjs'
import { HEX, cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

const FIXTURES = join(import.meta.dirname, 'fixtures')
const SORRY_WARNING = (file: string) => `${file}:1:0: warning: declaration uses 'sorry'`
const STATEMENT_TYPE = '∀ (a b : Nat), a + b = b + a'

// ---------------------------------------------------------------------------
// Fixture env + problem builders
// ---------------------------------------------------------------------------
const ENV_REVISION = 'v4.35.0'

async function makeEnv() {
  const env = await roots.make('mrh-env-')
  await mkdir(join(env, 'lean', 'bin'), { recursive: true })
  await writeFile(join(env, 'lean', 'bin', 'lean'), '#!/bin/sh\n')
  await mkdir(join(env, 'lean', 'lib'), { recursive: true })
  await writeFile(join(env, 'lean', 'lib', 'libleanshared.so'), 'not really a shared library')
  await mkdir(join(env, 'wrapper'), { recursive: true })
  await writeFile(join(env, 'wrapper', 'lean-toolchain'), 'leanprover/lean4:v4.35.0\n')
  await writeFile(join(env, 'wrapper', 'lakefile.lean'), 'import Lake\n')
  await mkdir(join(env, 'mathlib'), { recursive: true })
  const leanDigest = await contentDigest(join(env, 'lean'))
  const platform = process.platform === 'linux' ? 'linux-x64' : 'darwin-arm64'
  await writeFile(join(env, 'env.receipt.json'), JSON.stringify({
    schemaVersion: 1,
    envId: `${ENV_REVISION}-${platform}`,
    pin: { mathlib: { repo: 'leanprover-community/mathlib4', rev: ENV_REVISION, sha256: HEX('a') }, expectedLean: 'leanprover/lean4:v4.35.0', leanToolchain: 'leanprover/lean4:v4.35.0' },
    leanDigest,
    mathlibSha256: HEX('a'),
    cacheArtifactSha256: null,
    platform,
    provisionedAt: isoNow(),
  }))
  return { env, leanDigest }
}

async function makeProblem(leanDigest: string, { withRecordedType = true } = {}) {
  const problem = await roots.make('mrh-problem-')
  await cp(join(FIXTURES, 'problems', 'p1'), problem, { recursive: true })
  const binding: Record<string, unknown> = {
    statementDeclName: 'p1_stmt',
    proofDeclName: 'p1_proof',
    mathlibRev: ENV_REVISION,
    toolchainDigest: leanDigest,
  }
  if (withRecordedType) binding.statementTypeText = STATEMENT_TYPE
  await writeFile(join(problem, 'binding.json'), JSON.stringify(binding, null, 2))
  return problem
}

// Mocked Inspector.lean output for each phase (the real metaprogram produces
// this JSON at runtime; unit tests inject it).
function inspectorReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    toolchainVersion: '4.35.0',
    statement: { declaration: 'p1_stmt', kind: 'theorem', type: STATEMENT_TYPE },
    proof: { declaration: 'p1_proof', kind: 'theorem', type: STATEMENT_TYPE },
    typesMatch: true,
    axioms: ['propext', 'Classical.choice', 'Quot.sound'],
    ...overrides,
  }
}

interface Plan { buildStdout?: string; buildStderr?: string; buildExit?: number; inspector?: Record<string, unknown> | null; inspectorExit?: number; timedOut?: boolean }
const fakeInvokeLean = (plan: Plan) => async ({ phase, cwd }: { phase: string; cwd: string }) => {
  if (phase === 'build') {
    return { exitCode: plan.buildExit ?? 0, stdout: plan.buildStdout ?? '', stderr: plan.buildStderr ?? '', timedOut: plan.timedOut ?? false }
  }
  if (plan.inspector !== null && plan.inspector !== undefined) await writeFile(join(cwd, 'inspector-report.json'), JSON.stringify(plan.inspector))
  return { exitCode: plan.inspectorExit ?? 0, stdout: '', stderr: '', timedOut: false }
}

// ---------------------------------------------------------------------------
// Report shape + hash binding
// ---------------------------------------------------------------------------
describe('lean-run report JSON (§4.4 own report)', () => {
  it('passes a clean proof and emits the full report shape with hash binding', async () => {
    const { env, leanDigest } = await makeEnv()
    const problem = await makeProblem(leanDigest)
    const report = await runLeanRun({ problem, env }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) })
    expect(report.status).toBe('passed')
    expect(report).toMatchObject({
      schemaVersion: 1,
      command: 'lean-run',
      mode: 'proof-check',
      failure: null,
      binding: { statementDeclName: 'p1_stmt', proofDeclName: 'p1_proof', statementTypeText: STATEMENT_TYPE, typesMatch: true },
      axioms: ['propext', 'Classical.choice', 'Quot.sound'],
    })
    expect(Array.isArray(report.diagnostics)).toBe(true)
    for (const key of ['statement', 'proof', 'binding', 'envReceiptDigest', 'combined']) expect(report.hashes[key]).toMatch(/^[a-f0-9]{64}$/)
    // The per-attempt build dir exists with its OWN wrapper-lakefile copy (§4.2 isolation).
    const lakefile = await readFile(join(report.buildDir, 'lakefile.lean'), 'utf8')
    expect(lakefile).toContain(join(env, 'mathlib'))
    // CLI path: passed → exit 0.
    const { exitCode, output } = await cli(main, ['--problem', problem, '--env', env], { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) })
    expect(exitCode).toBe(0)
    expect(output).toMatchObject({ command: 'lean-run', status: 'passed' })
  })

  it('hash binding: recomputed verdict hashes change and --expect-hashes invalidates (status failed)', async () => {
    const { env, leanDigest } = await makeEnv()
    const problem = await makeProblem(leanDigest)
    const receiptDigest = createHash('sha256').update(await readFile(join(env, 'env.receipt.json'))).digest('hex')
    const hashes = await computeHashBinding(problem, receiptDigest)
    const clean = await runLeanRun({ problem, env, expectHashes: null }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) })
    await writeFile(join(problem, 'expected.json'), JSON.stringify({ statement: hashes.statement, proof: hashes.proof, binding: hashes.binding, envReceiptDigest: receiptDigest }))
    const still = await runLeanRun({ problem, env, expectHashes: join(problem, 'expected.json') }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) })
    expect(still.status).toBe('passed')
    // Any change invalidates: alter the statement bytes, expect the old hash.
    await writeFile(join(problem, 'statement.lean'), 'import Mathlib.Core\n\ntheorem p1_stmt : ∀ (a b : Nat), a + b = b + a + 0 := sorry\n')
    const tampered = await runLeanRun({ problem, env, expectHashes: join(problem, 'expected.json') }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) })
    expect(tampered.status).toBe('failed')
    expect(tampered.failure).toMatchObject({ class: 'hash-mismatch' })
    const after = await computeHashBinding(problem, receiptDigest)
    expect(after.combined).not.toBe(clean.hashes.combined)
    expect(after.statement).not.toBe(hashes.statement)
  })
})

// ---------------------------------------------------------------------------
// Scoped failure semantics
// ---------------------------------------------------------------------------
describe('lean-run scoped failure semantics (§4.4)', () => {
  it('sorry-bearing warning fails PROOF mode but is tolerated in statement-check mode', async () => {
    const { env, leanDigest } = await makeEnv()
    const problem = await makeProblem(leanDigest, { withRecordedType: false })
    // Statement-check: the SAME sorry warning is tolerated, and the mode
    // RECORDS the elaborated type into binding.json.
    const stmt = await runLeanRun({ problem, env, statementCheck: true }, { invokeLean: fakeInvokeLean({ buildStdout: SORRY_WARNING('statement.lean'), inspector: inspectorReport({ proof: null, axioms: null, typesMatch: null }) }) })
    expect(stmt.status).toBe('passed')
    expect(stmt.mode).toBe('statement-check')
    const recorded = JSON.parse(await readFile(join(problem, 'binding.json'), 'utf8'))
    expect(recorded.statementTypeText).toBe(STATEMENT_TYPE)
    // Proof mode: sorry anywhere fails (message TEXT fallback above; the
    // structured CODE path is covered below).
    const proof = await runLeanRun({ problem, env }, { invokeLean: fakeInvokeLean({ buildStderr: SORRY_WARNING('proof.lean (proof mode never imports the statement)') }) })
    expect(proof.status).toBe('failed')
    expect(proof.failure).toMatchObject({ class: 'sorry' })
    const { exitCode } = await cli(main, ['--problem', problem, '--env', env], { invokeLean: fakeInvokeLean({ buildStderr: SORRY_WARNING('proof.lean') }) })
    expect(exitCode).toBe(1)
  })

  it('matches sorry by message CODE first when Lean provides one (code path), substring otherwise', () => {
    expect(isSorryDiagnostic({ file: 'f', line: 1, col: 0, severity: 'warning', message: 'anything', code: 'declaration_uses_sorry' })).toBe(true)
    expect(isSorryDiagnostic({ file: 'f', line: 1, col: 0, severity: 'warning', message: "declaration uses 'sorry'", code: null })).toBe(true)
    expect(isSorryDiagnostic({ file: 'f', line: 1, col: 0, severity: 'warning', message: "declaration uses 'sorry'", code: 'unused_variable' })).toBe(false)
    expect(isSorryDiagnostic({ file: 'f', line: 1, col: 0, severity: 'warning', message: 'unused variable `x`', code: null })).toBe(false)
  })

  it('any error diagnostic fails (both modes)', async () => {
    const { env, leanDigest } = await makeEnv()
    const problem = await makeProblem(leanDigest)
    const plan = fakeInvokeLean({ buildStdout: 'proof.lean:3:10: error: type mismatch\n  term has type Nat but is expected to have type Prop' })
    const report = await runLeanRun({ problem, env }, { invokeLean: plan })
    expect(report.status).toBe('failed')
    expect(report.failure).toMatchObject({ class: 'lean-error' })
    const stmt = await runLeanRun({ problem, env, statementCheck: true }, { invokeLean: fakeInvokeLean({ buildStdout: 'statement.lean:1:1: error: unknown identifier' }) })
    expect(stmt.status).toBe('failed')
  })

  it('non-sorry warnings (unused variable, deprecation) do NOT fail the run', async () => {
    const { env, leanDigest } = await makeEnv()
    const problem = await makeProblem(leanDigest)
    const buildStdout = "proof.lean:2:6: warning: unused variable `x`\nproof.lean:1:0: warning: `foo` has been deprecated"
    const report = await runLeanRun({ problem, env }, { invokeLean: fakeInvokeLean({ buildStdout, inspector: inspectorReport() }) })
    expect(report.status).toBe('passed')
    expect(report.diagnostics).toHaveLength(2)
  })

  it('axiom whitelist violation fails (axioms outside propext/Classical.choice/Quot.sound)', async () => {
    const { env, leanDigest } = await makeEnv()
    const problem = await makeProblem(leanDigest)
    const report = await runLeanRun({ problem, env }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport({ axioms: ['propext', 'sorryAx'] }) }) })
    expect(report.status).toBe('failed')
    expect(report.failure).toMatchObject({ class: 'axiom-violation' })
    expect(report.axioms).toContain('sorryAx')
  })

  it('binding failures: wrong kind, missing declaration, and non-defeq propositions each fail', async () => {
    const { env, leanDigest } = await makeEnv()
    const problem = await makeProblem(leanDigest)
    const wrongKind = await runLeanRun({ problem, env }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport({ proof: { declaration: 'p1_proof', kind: 'definition', type: STATEMENT_TYPE } }) }) })
    expect(wrongKind.failure?.class).toBe('binding')
    const missing = await runLeanRun({ problem, env }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport({ proof: { declaration: 'p1_proof', kind: null, type: null } }) }) })
    expect(missing.failure?.class).toBe('binding')
    // §10 ③: a proof of an unrelated `theorem foo : True` type must be rejected.
    const unrelated = await runLeanRun({ problem, env }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport({ proof: { declaration: 'p1_proof', kind: 'theorem', type: 'True' }, typesMatch: false }) }) })
    expect(unrelated.failure).toMatchObject({ class: 'binding' })
    // And the recorded statement type is REQUIRED before proof mode runs.
    const problemNoType = await makeProblem(leanDigest, { withRecordedType: false })
    const noType = await runLeanRun({ problem: problemNoType, env }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) })
    expect(noType.failure).toMatchObject({ class: 'binding', detail: expect.stringContaining('statementTypeText') })
  })

  it('an unparseable run fails the attempt with the raw text preserved verbatim', async () => {
    const { env, leanDigest } = await makeEnv()
    const problem = await makeProblem(leanDigest)
    const garbage = '!!@@ totally unparseable output @@!!\nnot a diagnostic either'
    const report = await runLeanRun({ problem, env }, { invokeLean: fakeInvokeLean({ buildStdout: garbage }) })
    expect(report.status).toBe('failed')
    expect(report.failure).toMatchObject({ class: 'unparseable' })
    expect(report.rawDiagnostics).toContain('@@ totally unparseable output @@')
    // A missing inspector report is structurally invalid too.
    const noReport = await runLeanRun({ problem, env }, { invokeLean: fakeInvokeLean({ inspector: null }) })
    expect(noReport.status).toBe('failed')
    expect(noReport.failure).toMatchObject({ class: 'unparseable' })
  })

  it('statement-check tolerates ONLY sorry: error + sorry together still fails', async () => {
    const { env, leanDigest } = await makeEnv()
    const problem = await makeProblem(leanDigest, { withRecordedType: false })
    const out = `${SORRY_WARNING('statement.lean')}\nstatement.lean:2:0: error: failed to elaborate`
    const report = await runLeanRun({ problem, env, statementCheck: true }, { invokeLean: fakeInvokeLean({ buildStdout: out }) })
    expect(report.status).toBe('failed')
    expect(report.failure).toMatchObject({ class: 'lean-error' })
  })
})

describe('lean-run diagnostics parsing', () => {
  it('parses human-format lines, JSON lines with codes, continuations, and preserves raw noise', () => {
    const human = parseDiagnostics("f.lean:1:2: error: bad\n  more context\nf.lean:3:4: warning: declaration uses 'sorry'\n")
    expect(human.diagnostics).toHaveLength(2)
    expect(human.diagnostics[0]).toMatchObject({ file: 'f.lean', line: 1, col: 2, severity: 'error' })
    expect(human.diagnostics[0].message).toContain('more context')
    expect(human.raw).toBeNull()
    const json = parseDiagnostics(JSON.stringify({ severity: 'warning', caption: '', pos: { fileName: 'f.lean', line: 2, column: 1 }, data: "declaration uses 'sorry'", code: 'declaration_uses_sorry' }) + '\n')
    expect(json.diagnostics[0]).toMatchObject({ code: 'declaration_uses_sorry', severity: 'warning', line: 2, col: 1 })
    expect(isSorryDiagnostic(json.diagnostics[0] as never)).toBe(true)
    const noisy = parseDiagnostics('!! not a diagnostic !!')
    expect(noisy.raw).toBe('!! not a diagnostic !!')
  })
})
