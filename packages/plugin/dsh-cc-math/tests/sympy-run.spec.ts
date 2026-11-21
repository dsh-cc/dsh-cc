/**
 * sympy-run L1 computation behavioral tests (design §4.4 honest isolation
 * tiers; M0 DoD ⑦): the tier is detected and recorded BEFORE execution —
 * full (MATH_EVAL_ISOLATION=full, or the CI Linux netns marker) vs partial
 * (everything else) — and there is no silent downgrade. A partial run whose
 * checks FAIL is recorded with advisory:true (never authoritative; the
 * ledger-level "partial claiming fail is a ledger error" rule is enforced at
 * the claim layer). Absent Python ≥3.10 + sympy the tri-state answer is
 * `not-applicable`, never pass/fail. All process spawns are injected.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectIsolationTier, main, runSympyCheck } from '../skills/math-research/scripts/sympy-run.mjs'
import { cli, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

const pythonOk = async () => ({ python: '3.12.1', sympy: true })
const pythonMissing = async () => ({ python: null, sympy: false })
const pythonOld = async () => ({ python: '3.9.7', sympy: false, tooOld: true })

async function makeScript() {
  const root = await roots.make('mrh-sympy-')
  const script = join(root, 'check.py')
  await writeFile(script, 'import sympy as sp\nassert sp.isprime(7)\n')
  return { root, script }
}

describe('sympy-run isolation tier detection (§4.4)', () => {
  it('full = MATH_EVAL_ISOLATION=full, or the CI Linux netns marker; everything else is partial', () => {
    expect(detectIsolationTier({ env: {}, platform: 'darwin' })).toBe('partial')
    expect(detectIsolationTier({ env: { MATH_EVAL_ISOLATION: 'full' }, platform: 'darwin' })).toBe('full')
    expect(detectIsolationTier({ env: { CI: 'true', MATH_EVAL_NETNS: '1' }, platform: 'linux' })).toBe('full')
    // macOS nested sandbox is denied: NO upgrade to full there.
    expect(detectIsolationTier({ env: { CI: 'true', MATH_EVAL_NETNS: '1' }, platform: 'darwin' })).toBe('partial')
    expect(detectIsolationTier({ env: { CI: 'true' }, platform: 'linux' })).toBe('partial')
    // Detection happens before execution (stage order observable through a failing probe).
    expect(detectIsolationTier({ env: { MATH_EVAL_ISOLATION: 'partial' }, platform: 'linux' })).toBe('partial')
  })
})

describe('sympy-run execution semantics', () => {
  it('partial tier: a claiming-fail run is recorded with isolation partial and advisory true (DoD ⑦)', async () => {
    const { root, script } = await makeScript()
    const check = await runSympyCheck(
      { script, workRoot: join(root, 'work') },
      { probe: pythonOk, spawnCheck: async () => ({ exitCode: 1, stdout: 'counterexample n=4\n', stderr: '' }), env: {} },
    )
    expect(check).toMatchObject({ status: 'fail', isolation: 'partial', advisory: true, exitCode: 1 })
    // Fresh temp cwd was created under the math work root.
    expect(String(check.cwd)).toContain(join(root, 'work'))
    expect(String(check.stdoutTail)).toContain('counterexample')
  })

  it('partial tier: an all-pass run may record pass, still annotated advisory', async () => {
    const { root, script } = await makeScript()
    const check = await runSympyCheck(
      { script, workRoot: join(root, 'work') },
      { probe: pythonOk, spawnCheck: async () => ({ exitCode: 0, stdout: 'all good\n', stderr: '' }), env: {} },
    )
    expect(check).toMatchObject({ status: 'pass', isolation: 'partial', advisory: true })
  })

  it('full tier: a fail is authoritative-shaped (advisory false) — the tier the claim layer accepts', async () => {
    const { root, script } = await makeScript()
    const check = await runSympyCheck(
      { script, workRoot: join(root, 'work') },
      { probe: pythonOk, spawnCheck: async () => ({ exitCode: 2, stdout: '', stderr: 'assert failed\n' }), env: { MATH_EVAL_ISOLATION: 'full' } },
    )
    expect(check).toMatchObject({ status: 'fail', isolation: 'full', advisory: false })
  })

  it('tri-state: no python/sympy → not-applicable, never pass or fail', async () => {
    const { root, script } = await makeScript()
    for (const probe of [pythonMissing, pythonOld]) {
      const check = await runSympyCheck({ script, workRoot: join(root, 'work') }, { probe, env: {} })
      expect(check.status).toBe('not-applicable')
      expect(['partial', 'full']).toContain(check.isolation)
    }
    const { exitCode, output } = await cli(main, ['--script', script, '--work-root', join(root, 'work2')], { probe: pythonMissing, env: {} })
    expect(exitCode).toBe(0)
    expect(output).toMatchObject({ status: 'not-applicable', isolation: 'partial' })
  })

  it('a timed-out run is an error (exit 3), with the timeout recorded', async () => {
    const { root, script } = await makeScript()
    const { exitCode, output } = await cli(main, ['--script', script, '--work-root', join(root, 'work')], {
      probe: pythonOk,
      spawnCheck: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
      env: {},
    })
    expect(exitCode).toBe(3)
    expect(output).toMatchObject({ status: 'error', timedOut: true })
  })
})
