/**
 * Proof-search state behavioral tests (design §5.1 schema, §5.2 repair cap,
 * §5.4 scaffolding, §3.3 resume order):
 *
 *  - search.json round-trips through the strict schema (unknown fields are a
 *    config error, never ignored);
 *  - a goal closes ONLY on a passed L2 typed record — a diagnostics-only
 *    "passed" result is refused with exit 2 and closes nothing;
 *  - the scaffold state machine is an explicit enumeration: open →
 *    child-proven → integrated | dead, with the six enumerated death causes,
 *    and only two of them reachable from child-proven;
 *  - depth counts nodes, the cap of 3 terminates THAT BRANCH (goal
 *    abandoned) and never the problem, and the scaffoldOf lineage rejects
 *    cycles;
 *  - resume reconciles in-flight attempts by result hash FIRST, discards
 *    tampered/unsettled ones after, and delegates the budget side to
 *    budget-ledger by reporting the opIds.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEATH_CAUSES, GOAL_STATES, MAX_SCAFFOLD_DEPTH, abandonGoal, addAttempt, addGoal, addRepairRound, advanceScaffold,
  initState, loadState, main, openScaffold, recordResult, resume, setStatus, validateState,
} from '../skills/math-research/scripts/search-state.mjs'
import { HEX, cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

const L2 = () => ({ kind: 'l2-pass', verdict: 'pass', bindingHashes: { combined: HEX('a') } })

async function makeProblem({ problemId = 'p-001', lineage = [] as string[], dir = 'problem' } = {}) {
  const root = await roots.make('mrh-search-')
  const problemDir = join(root, dir)
  await mkdir(problemDir, { recursive: true })
  const path = join(problemDir, 'search.json')
  await initState(path, { runId: 'run-1', problemId, lineage })
  return { root, problemDir, path }
}

async function writeResult(problemDir: string, attemptId: string, record: Record<string, unknown>) {
  const dir = join(problemDir, 'attempts', attemptId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'result.json')
  await writeFile(path, JSON.stringify(record) + '\n')
  return path
}

const passResult = (attemptId: string, closedGoals: string[] = ['g-001']) => ({
  attemptId,
  status: 'passed',
  diagnostics: { status: 'passed', diagnostics: [] },
  usage: { promptTokens: 1200, completionTokens: 800 },
  closedGoals,
  verification: [L2()],
})

describe('search-state schema round-trip (§5.1)', () => {
  it('init writes the §5.1 skeleton and loadState validates it', async () => {
    const { path } = await makeProblem()
    const raw = JSON.parse(await readFile(path, 'utf8'))
    expect(raw).toMatchObject({ schemaVersion: 1, runId: 'run-1', problemId: 'p-001', status: 'running', lineage: [] })
    expect(raw.scheduler).toEqual({ nextAttemptId: 1, branchPolicy: 'serial-2-then-parallel' })
    expect(raw.goals).toEqual([])
    expect(raw.attempts).toEqual([])
    expect(raw.scaffolds).toEqual([])
    expect(validateState(raw)).toBe(raw)
  })

  it('init is idempotent for the same identity and refuses a different one', async () => {
    const { path } = await makeProblem()
    expect((await initState(path, { runId: 'run-1', problemId: 'p-001' })).reused).toBe(true)
    await expect(initState(path, { runId: 'run-2', problemId: 'p-001' })).rejects.toMatchObject({ code: 'config-invalid' })
  })

  it('goals and attempts round-trip; unknown fields are a config error (exit 2)', async () => {
    const { path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'forall n : Nat, n + 0 = n' })
    const added = await addAttempt(path, { goalId: 'g-001', opId: 'op-007' })
    expect(added.attemptId).toBe('attempt-001')
    expect(added.nextAttemptId).toBe(2)
    const state = await loadState(path)
    expect(state.goals[0]).toMatchObject({ id: 'g-001', parent: null, state: 'in-progress', closedBy: null })
    expect(state.attempts[0]).toMatchObject({ id: 'attempt-001', goalId: 'g-001', repairRoundsUsed: 0, opId: 'op-007', status: 'running', resultHash: null })
    // Schema is strict: an unknown field written by hand fails validation.
    const tampered = JSON.parse(await readFile(path, 'utf8'))
    tampered.injected = true
    expect(() => validateState(tampered)).toThrowError(/unknown field/)
    await writeFile(path, JSON.stringify(tampered))
    const { exitCode, output } = await cli(main, ['status', '--search', path])
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ status: 'blocked', reason: { code: 'config-invalid' } })
  })

  it('a duplicate goal, a duplicate opId and a bad goal state are refused', async () => {
    const { path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await expect(addGoal(path, { goalId: 'g-001', statementShape: 'again' })).rejects.toMatchObject({ code: 'config-invalid' })
    await expect(addAttempt(path, { goalId: 'g-999', opId: 'op-1' })).rejects.toMatchObject({ code: 'config-invalid' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    await expect(addAttempt(path, { goalId: 'g-001', opId: 'op-1' })).rejects.toMatchObject({ code: 'config-invalid' })
  })
})

describe('search-state goal closure (§5.1: passed L2 record only)', () => {
  it('a passed result with the L2 typed record closes the goal', async () => {
    const { problemDir, path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    const resultPath = await writeResult(problemDir, 'attempt-001', passResult('attempt-001'))
    const recorded = await recordResult(path, { attemptId: 'attempt-001', resultPath })
    expect(recorded.verified).toBe(true)
    expect(recorded.goals).toEqual([{ id: 'g-001', state: 'closed', closedBy: 'attempt-001' }])
    expect(recorded.problemStatus).toBe('solved')
    expect(recorded.resultHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('a DIAGNOSTICS-ONLY result never closes a goal: exit 2, goal stays open', async () => {
    const { problemDir, path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    // The child says "passed" and carries a lean-run diagnostics report, but
    // no L2 typed verification record: that is an assertion, not a proof.
    const resultPath = await writeResult(problemDir, 'attempt-001', {
      attemptId: 'attempt-001',
      status: 'passed',
      diagnostics: { status: 'passed', diagnostics: [{ severity: 'warning', message: 'unused variable' }] },
      usage: { promptTokens: 10, completionTokens: 5 },
      closedGoals: ['g-001'],
    })
    await expect(recordResult(path, { attemptId: 'attempt-001', resultPath })).rejects.toMatchObject({ code: 'missing-record' })
    const { exitCode, output } = await cli(main, ['record-result', '--search', path, '--attempt-id', 'attempt-001', '--result', resultPath])
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ status: 'blocked', reason: { code: 'missing-record' } })
    const state = await loadState(path)
    expect(state.goals[0]).toMatchObject({ id: 'g-001', state: 'in-progress', closedBy: null })
    expect(state.attempts[0]).toMatchObject({ id: 'attempt-001', status: 'running' })
    expect(state.status).toBe('running')
  })

  it('a non-pass L2 record and a falsified result close nothing either', async () => {
    const { problemDir, path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    const resultPath = await writeResult(problemDir, 'attempt-001', {
      ...passResult('attempt-001', []),
      status: 'failed',
      verification: [{ kind: 'l2-pass', verdict: 'fail', bindingHashes: { combined: HEX('b') } }],
    })
    const recorded = await recordResult(path, { attemptId: 'attempt-001', resultPath })
    expect(recorded.verified).toBe(false)
    expect(recorded.closedGoals).toEqual([])
    const state = await loadState(path)
    expect(state.goals[0]?.state).toBe('open') // released: no attempt in flight
    expect(state.status).toBe('running')
  })

  it('a result claiming a closure while failed is refused, and a second result for one attempt is refused', async () => {
    const { problemDir, path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    const bad = await writeResult(problemDir, 'attempt-001', { ...passResult('attempt-001'), status: 'failed' })
    await expect(recordResult(path, { attemptId: 'attempt-001', resultPath: bad })).rejects.toMatchObject({ code: 'missing-record' })
    const good = await writeResult(problemDir, 'attempt-001', passResult('attempt-001'))
    await recordResult(path, { attemptId: 'attempt-001', resultPath: good })
    await expect(recordResult(path, { attemptId: 'attempt-001', resultPath: good })).rejects.toMatchObject({ code: 'illegal-transition' })
  })

  it('the repair cap is 2 per attempt (§5.2) and a third round is refused', async () => {
    const { path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    expect((await addRepairRound(path, { attemptId: 'attempt-001' })).repairRoundsUsed).toBe(1)
    expect((await addRepairRound(path, { attemptId: 'attempt-001' })).repairRoundsUsed).toBe(2)
    await expect(addRepairRound(path, { attemptId: 'attempt-001' })).rejects.toMatchObject({ code: 'repair-cap-exceeded' })
  })

  it('an explicit terminal status sticks; derivation only moves a running problem', async () => {
    const { path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await setStatus(path, { status: 'budget-exhausted' })
    await abandonGoal(path, { goalId: 'g-001' })
    expect((await loadState(path)).status).toBe('budget-exhausted')
    await expect(setStatus(path, { status: 'running' })).rejects.toMatchObject({ code: 'illegal-transition' })
  })
})

describe('search-state scaffold machine (§5.4)', () => {
  it('open → child-proven needs the child\'s own L2 record; child-proven → integrated needs the parent closed', async () => {
    const { problemDir, path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    const opened = await openScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', connectingImplication: 'lemma → goal' })
    expect(opened).toMatchObject({ created: true, depth: 1, state: 'open' })
    await expect(advanceScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', to: 'child-proven', records: [] })).rejects.toMatchObject({ code: 'missing-record' })
    await advanceScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', to: 'child-proven', records: [L2()] })
    // The parent goal is still open: integrating now would be a fiction.
    await expect(advanceScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', to: 'integrated' })).rejects.toMatchObject({ code: 'illegal-transition' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    const resultPath = await writeResult(problemDir, 'attempt-001', passResult('attempt-001'))
    await recordResult(path, { attemptId: 'attempt-001', resultPath })
    await advanceScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', to: 'integrated' })
    const state = await loadState(path)
    expect(state.scaffolds[0]).toMatchObject({ state: 'integrated', depth: 1, scaffoldOf: 'p-001' })
  })

  it('the death matrix is an explicit enumeration of the six causes', async () => {
    const { path } = await makeProblem()
    // From `open`, every enumerated cause is admissible.
    for (const [index, cause] of DEATH_CAUSES.entries()) {
      await addGoal(path, { goalId: `g-${String(index + 1).padStart(3, '0')}`, statementShape: 'shape' })
      await openScaffold(path, { goalId: `g-${String(index + 1).padStart(3, '0')}`, childProblemId: `p-1${index}`, connectingImplication: 'imp' })
      await advanceScaffold(path, { goalId: `g-${String(index + 1).padStart(3, '0')}`, childProblemId: `p-1${index}`, to: 'dead', cause })
      const state = await loadState(path)
      expect(state.scaffolds.at(-1)).toMatchObject({ state: 'dead', deathCause: cause })
      // …and the parent goal stays open: other branches continue.
      expect(state.goals.find((goal: { id: string }) => goal.id === `g-${String(index + 1).padStart(3, '0')}`)?.state).toBe('open')
    }
    expect(DEATH_CAUSES).toHaveLength(6)
    // A cause outside the enumeration is refused, and `dead` requires one.
    await addGoal(path, { goalId: 'g-100', statementShape: 'shape' })
    await openScaffold(path, { goalId: 'g-100', childProblemId: 'p-200', connectingImplication: 'imp' })
    await expect(advanceScaffold(path, { goalId: 'g-100', childProblemId: 'p-200', to: 'dead' })).rejects.toMatchObject({ code: 'config-invalid' })
    await expect(advanceScaffold(path, { goalId: 'g-100', childProblemId: 'p-200', to: 'dead', cause: 'vibes' })).rejects.toMatchObject({ code: 'illegal-transition' })
  })

  it('advanced states admit only their listed causes, and integrated/dead are terminal', async () => {
    const { problemDir, path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await openScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', connectingImplication: 'imp' })
    await advanceScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', to: 'child-proven', records: [L2()] })
    // child-proven may only die of an undischarged implication or an abandoned parent.
    await expect(advanceScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', to: 'dead', cause: 'child-falsified' })).rejects.toMatchObject({ code: 'illegal-transition' })
    await advanceScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', to: 'dead', cause: 'implication-undischarged' })
    // Nothing leaves `dead`.
    for (const to of ['child-proven', 'integrated', 'open']) {
      const outcome = await advanceScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', to, records: [L2()] }).then(() => 'ok', (error: { code?: string }) => error.code)
      expect(outcome).toBe('illegal-transition')
    }
    // Abandoning the parent kills the scaffolds still in flight.
    await addGoal(path, { goalId: 'g-002', statementShape: 'shape2' })
    await openScaffold(path, { goalId: 'g-002', childProblemId: 'p-003', connectingImplication: 'imp' })
    const abandoned = await abandonGoal(path, { goalId: 'g-002' })
    expect(abandoned.scaffoldsKilled).toEqual(['p-003'])
    const state = await loadState(path)
    expect(state.scaffolds.at(-1)).toMatchObject({ state: 'dead', deathCause: 'parent-abandoned' })
    expect(problemDir).toContain('problem')
  })
})

describe('search-state depth and cycle rules (§5.4)', () => {
  it('depth counts nodes and the cap terminates the BRANCH, not the problem', async () => {
    expect(MAX_SCAFFOLD_DEPTH).toBe(3)
    // Two ancestors → this problem's scaffolds sit at depth 3 (allowed).
    const deep = await makeProblem({ problemId: 'p-003', lineage: ['p-001', 'p-002'], dir: 'deep' })
    await addGoal(deep.path, { goalId: 'g-001', statementShape: 'shape' })
    expect((await openScaffold(deep.path, { goalId: 'g-001', childProblemId: 'p-004', connectingImplication: 'imp' })).depth).toBe(3)
    // Three ancestors → depth 4: the branch terminates (goal abandoned) while
    // the problem keeps its other goals and stays running.
    const deeper = await makeProblem({ problemId: 'p-004', lineage: ['p-001', 'p-002', 'p-003'], dir: 'deeper' })
    await addGoal(deeper.path, { goalId: 'g-001', statementShape: 'shape' })
    await addGoal(deeper.path, { goalId: 'g-002', statementShape: 'other' })
    const capped = await openScaffold(deeper.path, { goalId: 'g-001', childProblemId: 'p-005', connectingImplication: 'imp' })
    expect(capped).toMatchObject({ created: false, reason: 'depth-cap', depth: 4, cap: 3, goal: { id: 'g-001', state: 'abandoned' } })
    const state = await loadState(deeper.path)
    expect(state.scaffolds).toEqual([])
    expect(state.status).toBe('running') // the problem survives; only the branch ended
    expect(state.goals.find((goal: { id: string }) => goal.id === 'g-002')?.state).toBe('open')
    // The remaining branch can still be solved.
    await addAttempt(deeper.path, { goalId: 'g-002', opId: 'op-2' })
    const resultPath = await writeResult(deeper.problemDir, 'attempt-001', passResult('attempt-001', ['g-002']))
    const recorded = await recordResult(deeper.path, { attemptId: 'attempt-001', resultPath })
    // One branch was abandoned, so the problem reports progress, not a proof of
    // every goal it started with.
    expect(recorded.problemStatus).toBe('unsolved-with-progress')
  })

  it('the scaffoldOf lineage rejects cycles and duplicate children', async () => {
    const { path } = await makeProblem({ problemId: 'p-002', lineage: ['p-001'] })
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await expect(openScaffold(path, { goalId: 'g-001', childProblemId: 'p-001', connectingImplication: 'imp' })).rejects.toMatchObject({ code: 'cycle-rejected' })
    await expect(openScaffold(path, { goalId: 'g-001', childProblemId: 'p-002', connectingImplication: 'imp' })).rejects.toMatchObject({ code: 'cycle-rejected' })
    await openScaffold(path, { goalId: 'g-001', childProblemId: 'p-003', connectingImplication: 'imp' })
    await expect(openScaffold(path, { goalId: 'g-001', childProblemId: 'p-003', connectingImplication: 'again' })).rejects.toMatchObject({ code: 'config-invalid' })
    const state = await loadState(path)
    expect(state.scaffolds).toHaveLength(1)
    expect(state.scaffolds[0]).toMatchObject({ childProblemId: 'p-003', state: 'open', scaffoldOf: 'p-002' })
    expect(GOAL_STATES).toContain(state.goals[0]?.state)
  })
})

describe('search-state resume (§3.3/§5.1 fixed order)', () => {
  it('reconciles a running attempt from its result.json and closes the goal', async () => {
    const { problemDir, path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    await writeResult(problemDir, 'attempt-001', passResult('attempt-001'))
    const report = await resume(path, {})
    expect(report.reconciled).toEqual([{ attemptId: 'attempt-001', status: 'passed', resultHash: expect.stringMatching(/^[a-f0-9]{64}$/), file: expect.stringContaining('result.json') }])
    expect(report.discarded).toEqual([])
    expect(report.problemStatus).toBe('solved')
    expect(report.goals).toEqual([{ id: 'g-001', state: 'closed', closedBy: 'attempt-001' }])
  })

  it('discards an unsettled attempt AFTER reconciliation and hands the opIds to budget-ledger', async () => {
    const { path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    await addGoal(path, { goalId: 'g-002', statementShape: 'shape2' })
    await addAttempt(path, { goalId: 'g-002', opId: 'op-2' })
    const report = await resume(path, {})
    expect(report.reconciled).toEqual([])
    expect(report.discarded.map((entry: { opId: string }) => entry.opId)).toEqual(['op-1', 'op-2'])
    expect(report.discarded.every((entry: { reason: string }) => entry.reason === 'unsettled-at-resume')).toBe(true)
    // The budget side is budget-ledger's: this script only reports the opIds
    // (rollback never refunds, §3.3).
    expect(report.budgetDelegation.opIds).toEqual(['op-1', 'op-2'])
    const state = await loadState(path)
    expect(state.attempts.map((attempt: { status: string }) => attempt.status)).toEqual(['discarded', 'discarded'])
    expect(state.goals.map((goal: { state: string }) => goal.state)).toEqual(['open', 'open'])
  })

  it('a result whose bytes changed after adoption is a tampered attempt: discarded, goal reopened', async () => {
    const { problemDir, path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    const resultPath = await writeResult(problemDir, 'attempt-001', passResult('attempt-001'))
    await recordResult(path, { attemptId: 'attempt-001', resultPath })
    expect((await loadState(path)).status).toBe('solved')
    await writeFile(resultPath, JSON.stringify(passResult('attempt-001')) + '\n ') // one byte of tampering
    const report = await resume(path, {})
    expect(report.discarded).toEqual([expect.objectContaining({ attemptId: 'attempt-001', reason: 'result-hash-mismatch' })])
    const state = await loadState(path)
    expect(state.attempts[0]).toMatchObject({ id: 'attempt-001', status: 'discarded' })
    expect(state.goals[0]).toMatchObject({ id: 'g-001', state: 'open', closedBy: null })
    expect(state.status).toBe('running')
    // Idempotent: a second resume changes nothing further.
    const again = await resume(path, {})
    expect(again.discarded).toEqual([])
  })

  it('a result produced against a different dispatch is discarded (input hash mismatch)', async () => {
    const { root, problemDir, path } = await makeProblem()
    const inputs = join(root, 'inputs.json')
    await writeFile(inputs, '{"prompt":"attempt one"}\n')
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1', inputs })
    // A stale result from a previous dispatch carries a different inputHash.
    await writeResult(problemDir, 'attempt-001', { ...passResult('attempt-001'), inputHash: HEX('f') })
    const report = await resume(path, {})
    expect(report.reconciled).toEqual([])
    expect(report.discarded).toEqual([expect.objectContaining({ attemptId: 'attempt-001', reason: 'input-hash-mismatch' })])
    expect((await loadState(path)).goals[0]?.state).toBe('open')
  })

  it('a malformed result file discards the attempt instead of adopting it', async () => {
    const { problemDir, path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    await writeResult(problemDir, 'attempt-001', { attemptId: 'attempt-001', status: 'passed' })
    const report = await resume(path, {})
    expect(report.discarded).toEqual([expect.objectContaining({ attemptId: 'attempt-001', reason: 'result-invalid' })])
    expect((await loadState(path)).attempts[0]?.status).toBe('discarded')
  })

  it('resume is exposed on the CLI and prints one line of JSON', async () => {
    const { path } = await makeProblem()
    await addGoal(path, { goalId: 'g-001', statementShape: 'shape' })
    await addAttempt(path, { goalId: 'g-001', opId: 'op-1' })
    const { exitCode, output, raw } = await cli(main, ['resume', '--search', path])
    expect(exitCode).toBe(0)
    expect(raw.trim().split('\n')).toHaveLength(1)
    expect(output).toMatchObject({ command: 'search-state', subcommand: 'resume', budgetDelegation: { opIds: ['op-1'] } })
    expect(isoNow()).toMatch(/^\d{4}-/)
  })
})
