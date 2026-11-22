/**
 * Reference-anchor check tests (design §4.3 row 2): the thin `anchor-check.mjs`
 * wrapper over lean-run's anchor mode. A trusted reference formalization is the
 * only thing that lifts fidelity from a model judgement to `anchored`, so the
 * wrapper must produce exactly one of passes / fails / cannot-run from the
 * kernel's definitional-equality verdict — never a string comparison, never an
 * assumed equality — and record the evidence the gate's `anchorCheck` points at.
 * All Lean invocations are mocked.
 */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contentDigest } from '../skills/math-research/scripts/mathlib-env.mjs'
import { main, runAnchorCheck } from '../skills/math-research/scripts/anchor-check.mjs'
import { runLeanRun } from '../skills/math-research/scripts/lean-run.mjs'
import { exists } from '../skills/math-research/scripts/storage.lib.mjs'
import { HEX, cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

const FIXTURES = join(import.meta.dirname, 'fixtures')
const ENV_REVISION = 'v4.35.0'
const STATEMENT_TYPE = '∀ (a b : Nat), a + b = b + a'

async function makeEnv() {
  const env = await roots.make('mrh-anchor-env-')
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
  const problem = await roots.make('mrh-anchor-problem-')
  await cp(join(FIXTURES, 'problems', 'p1'), problem, { recursive: true })
  const binding: Record<string, unknown> = {
    statementDeclName: 'p1_stmt', proofDeclName: 'p1_proof', mathlibRev: ENV_REVISION, toolchainDigest: leanDigest,
  }
  if (withRecordedType) binding.statementTypeText = STATEMENT_TYPE
  await writeFile(join(problem, 'binding.json'), JSON.stringify(binding, null, 2))
  // A benchmark-style reference formalization: sorry-ed, as fixtures usually are.
  const reference = join(problem, 'reference.lean')
  await writeFile(reference, 'import Mathlib.Core\n\ntheorem proofnet_ref_stmt : ∀ (a b : Nat), a + b = b + a := sorry\n')
  return { problem, reference }
}

function inspectorReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    toolchainVersion: '4.35.0',
    statement: { declaration: 'p1_stmt', kind: 'theorem', type: STATEMENT_TYPE },
    proof: { declaration: 'proofnet_ref_stmt', kind: 'theorem', type: STATEMENT_TYPE },
    typesMatch: true,
    axioms: ['propext', 'Classical.choice', 'Quot.sound', 'sorryAx'],
    ...overrides,
  }
}

const SORRY_WARNING = "proof.lean:3:0: warning: declaration uses 'sorry'"
interface Plan { buildStdout?: string; buildStderr?: string; inspector?: Record<string, unknown> | null; inspectorExit?: number }
const fakeInvokeLean = (plan: Plan) => async ({ phase, cwd }: { phase: string; cwd: string }) => {
  if (phase === 'build') return { exitCode: 0, stdout: plan.buildStdout ?? SORRY_WARNING, stderr: plan.buildStderr ?? '', timedOut: false }
  if (plan.inspector !== null && plan.inspector !== undefined) await writeFile(join(cwd, 'inspector-report.json'), JSON.stringify(plan.inspector))
  return { exitCode: plan.inspectorExit ?? 0, stdout: '', stderr: '', timedOut: false }
}

describe('lean-run --anchor mode (§4.3 row 2)', () => {
  it('tolerates sorry in the reference and passes on definitional equality (no axiom audit)', async () => {
    const { env, leanDigest } = await makeEnv()
    const { problem, reference } = await makeProblem(leanDigest)
    // Stage the reference as the built module, exactly as anchor-check does.
    const anchorDir = join(problem, 'anchor')
    await mkdir(anchorDir, { recursive: true })
    await cp(reference, join(anchorDir, 'proof.lean'))
    await writeFile(join(anchorDir, 'binding.json'), JSON.stringify({
      statementDeclName: 'p1_stmt', proofDeclName: 'proofnet_ref_stmt', mathlibRev: ENV_REVISION,
      toolchainDigest: leanDigest, statementTypeText: STATEMENT_TYPE,
    }))
    const report = await runLeanRun({ problem: anchorDir, env, anchor: true }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) })
    expect(report).toMatchObject({
      mode: 'anchor-check', status: 'passed', failure: null,
      binding: { statementDeclName: 'p1_stmt', proofDeclName: 'proofnet_ref_stmt', typesMatch: true, proofTypeText: STATEMENT_TYPE },
    })
    // The reference's own axioms (it is sorry-ed) are reported but never fail the anchor.
    expect(report.axioms).toContain('sorryAx')
    // Proof mode on the same sorry-ed file still fails: the tolerance is scoped.
    const proofMode = await runLeanRun({ problem: anchorDir, env }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) })
    expect(proofMode.failure).toMatchObject({ class: 'sorry' })
  })

  it('a definitional mismatch is kernel evidence of infidelity (failure class types-differ)', async () => {
    const { env, leanDigest } = await makeEnv()
    const { problem, reference } = await makeProblem(leanDigest)
    const anchorDir = join(problem, 'anchor')
    await mkdir(anchorDir, { recursive: true })
    await cp(reference, join(anchorDir, 'proof.lean'))
    await writeFile(join(anchorDir, 'binding.json'), JSON.stringify({
      statementDeclName: 'p1_stmt', proofDeclName: 'proofnet_ref_stmt', mathlibRev: ENV_REVISION,
      toolchainDigest: leanDigest, statementTypeText: STATEMENT_TYPE,
    }))
    const report = await runLeanRun({ problem: anchorDir, env, anchor: true }, {
      invokeLean: fakeInvokeLean({ inspector: inspectorReport({ typesMatch: false, proof: { declaration: 'proofnet_ref_stmt', kind: 'theorem', type: '∀ (a b : Nat), a + b = b + a + 1' } }) }),
    })
    expect(report.status).toBe('failed')
    expect(report.failure).toMatchObject({ class: 'types-differ' })
    expect(report.binding.typesMatch).toBe(false)
  })

  it('--statement-check and --anchor are mutually exclusive (exit 2)', async () => {
    const { env, leanDigest } = await makeEnv()
    const { problem } = await makeProblem(leanDigest)
    const { exitCode, output } = await cli(main, ['--problem', problem, '--env', env, '--statement-check', '--anchor'], {})
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ status: 'blocked', reason: { code: 'config-invalid' } })
  })
})

describe('anchor-check wrapper (§4.3 row 2 → gate input)', () => {
  it('passes, writes the evidence record, and patches an existing fidelity-input.json', async () => {
    const { env, leanDigest } = await makeEnv()
    const { problem, reference } = await makeProblem(leanDigest)
    const gateInput = join(problem, 'fidelity-input.json')
    await writeFile(gateInput, JSON.stringify({
      schemaVersion: 1, backTranslation: { equivalent: true, differences: [] }, premiseAudit: { missing: [], extra: [] },
    }))
    const result = await runAnchorCheck(
      { problem, env, reference, referenceDecl: 'proofnet_ref_stmt', patch: gateInput },
      { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) },
    )
    expect(result.status).toBe('passes')
    expect(result.record).toMatchObject({
      command: 'anchor-check', status: 'passes', typesMatch: true,
      anchorCheck: { status: 'passes', evidenceRef: 'anchor-check.json' },
      reference: { declName: 'proofnet_ref_stmt' },
      patchedInput: gateInput,
    })
    // Evidence record on disk carries the full lean-run report.
    const evidence = JSON.parse(await readFile(join(problem, 'anchor-check.json'), 'utf8'))
    expect(evidence).toMatchObject({ status: 'passes', typesMatch: true, leanRun: { mode: 'anchor-check', status: 'passed' } })
    expect(evidence.reference.sha256).toMatch(/^[a-f0-9]{64}$/)
    // The gate now reads the anchor outcome from its own input.
    const patched = JSON.parse(await readFile(gateInput, 'utf8'))
    expect(patched.anchorCheck).toEqual({ status: 'passes', evidenceRef: 'anchor-check.json' })
    expect(patched.backTranslation).toMatchObject({ equivalent: true })
  })

  it('a reference mismatch is `fails` — evidence of infidelity, not an error', async () => {
    const { env, leanDigest } = await makeEnv()
    const { problem, reference } = await makeProblem(leanDigest)
    const result = await runAnchorCheck({ problem, env, reference, referenceDecl: 'proofnet_ref_stmt' }, {
      invokeLean: fakeInvokeLean({ inspector: inspectorReport({ typesMatch: false }) }),
    })
    expect(result.status).toBe('fails')
    expect(result.record).toMatchObject({ status: 'fails', typesMatch: false })
    expect(await exists(join(problem, 'anchor-check.json'))).toBe(true)
  })

  it('without a recorded statement type the outcome is cannot-run and no Lean run happens', async () => {
    const { env, leanDigest } = await makeEnv()
    const { problem, reference } = await makeProblem(leanDigest, { withRecordedType: false })
    let invoked = 0
    const result = await runAnchorCheck({ problem, env, reference, referenceDecl: 'proofnet_ref_stmt' }, {
      invokeLean: async () => { invoked += 1; throw new Error('must not run') },
    })
    expect(result.status).toBe('cannot-run')
    expect(invoked).toBe(0)
    expect(result.record.detail).toContain('statementTypeText')
  })

  it('an inspector without a defeq verdict is cannot-run (no evidence, row 4)', async () => {
    const { env, leanDigest } = await makeEnv()
    const { problem, reference } = await makeProblem(leanDigest)
    const result = await runAnchorCheck({ problem, env, reference, referenceDecl: 'proofnet_ref_stmt' }, {
      invokeLean: fakeInvokeLean({ inspector: inspectorReport({ typesMatch: null }) }),
    })
    expect(result.status).toBe('cannot-run')
  })

  it('CLI: exit 0 records the outcome; a missing reference or bad decl is config-invalid (exit 2)', async () => {
    const { env, leanDigest } = await makeEnv()
    const { problem, reference } = await makeProblem(leanDigest)
    const { exitCode, output } = await cli(main, ['--problem', problem, '--env', env, '--reference', reference, '--reference-decl', 'proofnet_ref_stmt'], {
      invokeLean: fakeInvokeLean({ inspector: inspectorReport() }),
    })
    expect(exitCode).toBe(0)
    expect(output).toMatchObject({ command: 'anchor-check', status: 'passes' })

    const missing = await cli(main, ['--problem', problem, '--env', env, '--reference', join(problem, 'nope.lean'), '--reference-decl', 'x'], {})
    expect(missing.exitCode).toBe(2)
    const badDecl = await cli(main, ['--problem', problem, '--env', env, '--reference', reference, '--reference-decl', 'not a name'], {})
    expect(badDecl.exitCode).toBe(2)
    expect(badDecl.output).toMatchObject({ status: 'blocked', reason: { code: 'config-invalid' } })
  })

  it('the recorded anchorCheck outcome drives the gate to `anchored` end to end', async () => {
    const { env, leanDigest } = await makeEnv()
    const { problem, reference } = await makeProblem(leanDigest)
    const gateInput = join(problem, 'fidelity-input.json')
    await writeFile(gateInput, JSON.stringify({
      schemaVersion: 1, pairId: 'proofnet-7', backTranslation: { equivalent: true, differences: [] }, premiseAudit: { missing: [], extra: [] },
    }))
    await runAnchorCheck({ problem, env, reference, referenceDecl: 'proofnet_ref_stmt', patch: gateInput }, { invokeLean: fakeInvokeLean({ inspector: inspectorReport() }) })
    const { main: gateMain } = await import('../skills/math-research/scripts/fidelity-gate.mjs')
    const gate = await cli(gateMain, ['--problem', problem])
    expect(gate.exitCode).toBe(0)
    expect(gate.output).toMatchObject({ grade: 'anchored', decisionRow: 2, pairId: 'proofnet-7' })
  })
})
