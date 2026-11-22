import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicJson, ensureWritable, fail, hashFile, parseFlags, readJson, runCli } from './storage.lib.mjs'

// Proof-search state (design §5.1, §5.2, §5.4) — `search.json`, one per
// problem dir:
//
//   { schemaVersion, runId, problemId, lineage, status, goals, attempts,
//     scaffolds, scheduler }
//
// Write discipline (§3.3): exactly one writer — the main conversation's
// process — and every mutation rewrites the whole file atomically. A
// delegated child owns only its own attempt dir and returns a result file.
//
// Closure rule (§5.1): a goal closes ONLY when an attempt's result carries a
// passed L2 verification record (`{kind:'l2-pass', verdict:'pass',
// bindingHashes}`) produced by lean-run. A result that merely reports
// diagnostics never closes anything — it is refused (exit 2) rather than
// silently downgraded to an assertion.
//
// Scaffolding (§5.4): a subgoal scaffold needs a connecting implication and
// walks `open → child-proven → integrated | dead`. The death causes are
// enumerated — child falsified / fidelity-failed / unsolved-with-progress /
// budget-exhausted / implication undischarged / parent abandoned — and any
// child terminal other than a proven claim is a `dead` scaffold while the
// parent goal stays open (other branches continue). Depth counts nodes and
// the cap (3) terminates THAT BRANCH (goal → abandoned), never the problem.
// Cycles are rejected through the `lineage`/`scaffoldOf` chain.
//
// Resume (§3.3 v4, §5.1): fixed order — (1) reconcile in-flight attempts by
// result.json hash, (2) then mark what is still unsettled `discarded`. The
// budget side is NOT duplicated here: the discarded opIds are reported so the
// caller runs budget-ledger.mjs' rollback, which never refunds.

export const SEARCH_SCHEMA_VERSION = 1
export const PROBLEM_STATUSES = Object.freeze(['running', 'solved', 'unsolved-with-progress', 'budget-exhausted', 'fidelity-failed'])
// Terminal outcomes: the two derived ones follow the goal graph; the two
// decision ones are recorded by the main conversation and stick (below).
export const PROBLEM_TERMINAL_STATUSES = Object.freeze(['solved', 'unsolved-with-progress', 'budget-exhausted', 'fidelity-failed'])
export const GOAL_STATES = Object.freeze(['open', 'in-progress', 'closed', 'abandoned'])
export const ATTEMPT_STATUSES = Object.freeze(['pending', 'running', 'passed', 'failed', 'discarded'])
export const IN_FLIGHT = Object.freeze(['pending', 'running'])
export const SCAFFOLD_STATES = Object.freeze(['open', 'child-proven', 'integrated', 'dead'])
export const DEATH_CAUSES = Object.freeze([
  'child-falsified',
  'child-fidelity-failed',
  'child-unsolved-with-progress',
  'child-budget-exhausted',
  'implication-undischarged',
  'parent-abandoned',
])
export const MAX_SCAFFOLD_DEPTH = 3
export const MAX_REPAIR_ROUNDS = 2
export const BRANCH_POLICY = 'serial-2-then-parallel'
const SCAFFOLD_EDGES = Object.freeze({
  'open→child-proven': [],
  'open→dead': [...DEATH_CAUSES],
  'child-proven→integrated': [],
  'child-proven→dead': ['implication-undischarged', 'parent-abandoned'],
})

const GOAL_ID = /^g-[0-9]{3,}$/
const ATTEMPT_ID = /^attempt-[0-9]{3,}$/
const OP_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/
const PROBLEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const HEX64 = /^[a-f0-9]{64}$/
const RESULT_FIELDS = ['attemptId', 'status', 'diagnostics', 'usage', 'closedGoals', 'inputHash', 'verification']

export const searchPath = problemDir => join(problemDir, 'search.json')

// ---------------------------------------------------------------------------
// Shape validation: strict field sets, enumerated values, id grammars. An
// unknown field is a config error, never ignored (§6.3 forward compatibility
// by explicit enumeration, not silently).
// ---------------------------------------------------------------------------
function unknownFields(value, allowed, label) {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  assert(unknown.length === 0, `${label} has unknown field(s): ${unknown.join(',')}`)
}

export function emptyState({ runId, problemId, lineage = [] }) {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    runId,
    problemId,
    lineage,
    status: 'running',
    goals: [],
    attempts: [],
    scaffolds: [],
    scheduler: { nextAttemptId: 1, branchPolicy: BRANCH_POLICY },
  }
}

function validateGoal(goal, index) {
  const label = `goals[${index}]`
  assert(goal && typeof goal === 'object' && !Array.isArray(goal), `${label} must be an object`)
  unknownFields(goal, ['id', 'parent', 'statementShape', 'state', 'closedBy'], label)
  assert(GOAL_ID.test(goal.id ?? ''), `${label}.id must look like g-001`)
  assert(goal.parent === null || GOAL_ID.test(goal.parent ?? ''), `${label}.parent must be null or a goal id`)
  assert(typeof goal.statementShape === 'string', `${label}.statementShape must be a string`)
  assert(GOAL_STATES.includes(goal.state), `${label}.state must be one of ${GOAL_STATES.join('|')}`)
  assert(goal.closedBy === null || ATTEMPT_ID.test(goal.closedBy ?? ''), `${label}.closedBy must be null or an attempt id`)
  if (goal.state === 'closed') assert(goal.closedBy !== null, `${label} is closed without a closing attempt`)
}

function validateAttempt(attempt, index) {
  const label = `attempts[${index}]`
  assert(attempt && typeof attempt === 'object' && !Array.isArray(attempt), `${label} must be an object`)
  unknownFields(attempt, ['id', 'goalId', 'repairRoundsUsed', 'dir', 'opId', 'status', 'inputHash', 'resultHash'], label)
  assert(ATTEMPT_ID.test(attempt.id ?? ''), `${label}.id must look like attempt-003`)
  assert(GOAL_ID.test(attempt.goalId ?? ''), `${label}.goalId must be a goal id`)
  assert(Number.isInteger(attempt.repairRoundsUsed) && attempt.repairRoundsUsed >= 0 && attempt.repairRoundsUsed <= MAX_REPAIR_ROUNDS, `${label}.repairRoundsUsed must be an integer in 0..${MAX_REPAIR_ROUNDS}`)
  assert(typeof attempt.dir === 'string' && attempt.dir.length > 0, `${label}.dir is required`)
  assert(OP_ID.test(attempt.opId ?? ''), `${label}.opId must match the op-id grammar`)
  assert(ATTEMPT_STATUSES.includes(attempt.status), `${label}.status must be one of ${ATTEMPT_STATUSES.join('|')}`)
  assert(attempt.inputHash === null || HEX64.test(attempt.inputHash ?? ''), `${label}.inputHash must be null or sha256 hex`)
  assert(attempt.resultHash === null || HEX64.test(attempt.resultHash ?? ''), `${label}.resultHash must be null or sha256 hex`)
}

function validateScaffold(scaffold, index) {
  const label = `scaffolds[${index}]`
  assert(scaffold && typeof scaffold === 'object' && !Array.isArray(scaffold), `${label} must be an object`)
  unknownFields(scaffold, ['goalId', 'childProblemId', 'depth', 'connectingImplication', 'state', 'scaffoldOf', 'deathCause'], label)
  assert(GOAL_ID.test(scaffold.goalId ?? ''), `${label}.goalId must be a goal id`)
  assert(PROBLEM_ID.test(scaffold.childProblemId ?? ''), `${label}.childProblemId must be a problem id`)
  assert(Number.isInteger(scaffold.depth) && scaffold.depth >= 1 && scaffold.depth <= MAX_SCAFFOLD_DEPTH, `${label}.depth must be an integer in 1..${MAX_SCAFFOLD_DEPTH}`)
  assert(typeof scaffold.connectingImplication === 'string' && scaffold.connectingImplication.trim().length > 0, `${label}.connectingImplication is required`)
  assert(SCAFFOLD_STATES.includes(scaffold.state), `${label}.state must be one of ${SCAFFOLD_STATES.join('|')}`)
  assert(PROBLEM_ID.test(scaffold.scaffoldOf ?? ''), `${label}.scaffoldOf must name the owning problem`)
  if (scaffold.state === 'dead') assert(DEATH_CAUSES.includes(scaffold.deathCause), `${label}.deathCause must be one of ${DEATH_CAUSES.join('|')}`)
  else assert(scaffold.deathCause === undefined, `${label}.deathCause is only written on a dead scaffold`)
}

export function validateState(state) {
  assert(state && typeof state === 'object' && !Array.isArray(state), 'search.json must be an object')
  unknownFields(state, ['schemaVersion', 'runId', 'problemId', 'lineage', 'status', 'goals', 'attempts', 'scaffolds', 'scheduler'], 'search.json')
  assert(state.schemaVersion === SEARCH_SCHEMA_VERSION, `search.json schemaVersion must be ${SEARCH_SCHEMA_VERSION}`)
  assert(typeof state.runId === 'string' && state.runId.length > 0, 'search.json runId is required')
  assert(PROBLEM_ID.test(state.problemId ?? ''), 'search.json problemId must look like p-001')
  assert(Array.isArray(state.lineage), 'search.json lineage must be an array of problem ids')
  state.lineage.forEach((id, index) => assert(PROBLEM_ID.test(id ?? ''), `lineage[${index}] must be a problem id`))
  assert(!state.lineage.includes(state.problemId), 'search.json lineage must not contain the problem itself (cycle)')
  assert(PROBLEM_STATUSES.includes(state.status), `search.json status must be one of ${PROBLEM_STATUSES.join('|')}`)
  for (const field of ['goals', 'attempts', 'scaffolds']) assert(Array.isArray(state[field]), `search.json ${field} must be an array`)
  state.goals.forEach(validateGoal)
  state.attempts.forEach(validateAttempt)
  state.scaffolds.forEach(validateScaffold)
  const scheduler = state.scheduler
  assert(scheduler && typeof scheduler === 'object' && !Array.isArray(scheduler), 'search.json scheduler must be an object')
  unknownFields(scheduler, ['nextAttemptId', 'branchPolicy'], 'scheduler')
  assert(Number.isInteger(scheduler.nextAttemptId) && scheduler.nextAttemptId >= 1, 'scheduler.nextAttemptId must be a positive integer')
  assert(typeof scheduler.branchPolicy === 'string' && scheduler.branchPolicy.length > 0, 'scheduler.branchPolicy is required')
  for (const goal of state.goals) {
    if (goal.parent !== null) assert(state.goals.some(other => other.id === goal.parent), `goal ${goal.id} names a parent goal that does not exist`)
  }
  for (const attempt of state.attempts) assert(state.goals.some(goal => goal.id === attempt.goalId), `attempt ${attempt.id} belongs to an unknown goal`)
  for (const scaffold of state.scaffolds) assert(state.goals.some(goal => goal.id === scaffold.goalId), `scaffold ${scaffold.childProblemId} belongs to an unknown goal`)
  return state
}

export async function loadState(path, { io = fs } = {}) {
  let state
  try { state = await readJson(path, 'search.json') }
  catch (e) { if (e.code === 'ENOENT') fail('state-missing', `no search state at ${path}; run init first`); throw e }
  return validateState(state)
}

export const saveState = (path, state, io = fs) => atomicJson(path, state, io)

// ---------------------------------------------------------------------------
// Status derivation (§5.1). `solved` and `unsolved-with-progress` are
// consequences of the goal graph and are recomputed on every mutation; the
// two DECISION statuses (`budget-exhausted`, `fidelity-failed`) are recorded
// by the main conversation and are never overwritten by derivation.
// ---------------------------------------------------------------------------
export const STICKY_STATUSES = Object.freeze(['budget-exhausted', 'fidelity-failed'])

export function deriveStatus(state) {
  if (state.goals.length === 0) return 'running'
  if (state.goals.every(goal => goal.state === 'closed')) return 'solved'
  if (state.goals.every(goal => goal.state === 'closed' || goal.state === 'abandoned')) return 'unsolved-with-progress'
  return 'running'
}
function refreshStatus(state) {
  if (STICKY_STATUSES.includes(state.status)) return state
  state.status = deriveStatus(state)
  return state
}

const findGoal = (state, goalId) => {
  const goal = state.goals.find(entry => entry.id === goalId)
  if (!goal) fail('config-invalid', `unknown goal ${goalId}`)
  return goal
}
const findAttempt = (state, attemptId) => {
  const attempt = state.attempts.find(entry => entry.id === attemptId)
  if (!attempt) fail('config-invalid', `unknown attempt ${attemptId}`)
  return attempt
}

/** An attempt finished: its goal is `open` again unless another attempt flies. */
function releaseGoal(state, goalId) {
  const goal = state.goals.find(entry => entry.id === goalId)
  if (!goal || goal.state === 'closed' || goal.state === 'abandoned') return
  const flying = state.attempts.some(attempt => attempt.goalId === goalId && IN_FLIGHT.includes(attempt.status))
  goal.state = flying ? 'in-progress' : 'open'
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------
export async function initState(path, { runId, problemId, lineage = [] }, { io = fs } = {}) {
  assert(typeof runId === 'string' && runId.length > 0, 'runId is required')
  assert(PROBLEM_ID.test(problemId ?? ''), 'problemId must look like p-001 (letters, digits, dot, dash, underscore)')
  const state = emptyState({ runId, problemId, lineage })
  validateState(state)
  try {
    const existing = await loadState(path, { io })
    if (existing.runId !== runId || existing.problemId !== problemId) fail('config-invalid', 'search.json already exists for a different run/problem; refusing to clobber')
    return { subcommand: 'init', reused: true, path: resolve(path), state: existing }
  } catch (error) {
    if (error.code !== 'state-missing') throw error
  }
  await io.mkdir(dirname(path), { recursive: true })
  await saveState(path, state, io)
  return { subcommand: 'init', reused: false, path: resolve(path), state }
}

export async function addGoal(path, { goalId, parent = null, statementShape }, { io = fs } = {}) {
  const state = await loadState(path, { io })
  assert(GOAL_ID.test(goalId ?? ''), 'goalId must match g-001')
  assert(state.goals.every(goal => goal.id !== goalId), `goal ${goalId} already exists`, 'config-invalid')
  assert(typeof statementShape === 'string' && statementShape.trim().length > 0, 'statementShape is required')
  if (parent !== null) findGoal(state, parent)
  state.goals.push({ id: goalId, parent, statementShape, state: 'open', closedBy: null })
  await saveState(path, state, io)
  return { subcommand: 'add-goal', goalId, state: 'open', goals: state.goals.length }
}

const nextAttemptId = state => `attempt-${String(state.scheduler.nextAttemptId).padStart(3, '0')}`

export async function addAttempt(path, { attemptId = null, goalId, opId, dir = null, status = 'running', inputs = null }, { io = fs } = {}) {
  const state = await loadState(path, { io })
  const goal = findGoal(state, goalId)
  assert(!['closed', 'abandoned'].includes(goal.state), `goal ${goalId} is ${goal.state}; it takes no new attempt`, 'illegal-transition')
  const id = attemptId ?? nextAttemptId(state)
  assert(ATTEMPT_ID.test(id), 'attemptId must match attempt-003')
  assert(state.attempts.every(attempt => attempt.id !== id), `attempt ${id} already exists`, 'config-invalid')
  assert(OP_ID.test(opId ?? ''), 'opId must match the op-id grammar')
  assert(state.attempts.every(attempt => attempt.opId !== opId), `opId ${opId} is already recorded`, 'config-invalid')
  assert(IN_FLIGHT.includes(status), `a new attempt starts pending|running, not ${status}`)
  const inputHash = inputs === null ? null : await hashFile(resolve(inputs)).catch(error => {
    if (error.code === 'ENOENT') fail('config-invalid', `prompt inputs file ${inputs} does not exist`)
    throw error
  })
  const attemptDir = dir ?? `attempts/${id}/`
  state.attempts.push({ id, goalId, repairRoundsUsed: 0, dir: attemptDir, opId, status, inputHash, resultHash: null })
  if (id === nextAttemptId(state)) state.scheduler.nextAttemptId += 1
  else state.scheduler.nextAttemptId = Math.max(state.scheduler.nextAttemptId, Number(id.slice('attempt-'.length)) + 1)
  goal.state = 'in-progress'
  await saveState(path, state, io)
  return { subcommand: 'add-attempt', attemptId: id, goalId, status, dir: attemptDir, inputHash, nextAttemptId: state.scheduler.nextAttemptId }
}

/** §5.2: at most 2 repair rounds per attempt; they consume the attempt's envelope. */
export async function addRepairRound(path, { attemptId }, { io = fs } = {}) {
  const state = await loadState(path, { io })
  const attempt = findAttempt(state, attemptId)
  assert(IN_FLIGHT.includes(attempt.status), `attempt ${attemptId} is ${attempt.status}; repair rounds apply to an in-flight attempt`, 'illegal-transition')
  if (attempt.repairRoundsUsed + 1 > MAX_REPAIR_ROUNDS) {
    fail('repair-cap-exceeded', `attempt ${attemptId} already used ${attempt.repairRoundsUsed} repair rounds (cap ${MAX_REPAIR_ROUNDS}); open a new attempt`)
  }
  attempt.repairRoundsUsed += 1
  await saveState(path, state, io)
  return { subcommand: 'add-repair', attemptId, repairRoundsUsed: attempt.repairRoundsUsed, remaining: MAX_REPAIR_ROUNDS - attempt.repairRoundsUsed }
}

// ---------------------------------------------------------------------------
// result.json (per attempt): the typed record that decides closure.
// ---------------------------------------------------------------------------
export function validateResultRecord(record, attempt) {
  assert(record && typeof record === 'object' && !Array.isArray(record), 'result.json must be an object')
  unknownFields(record, RESULT_FIELDS, 'result.json')
  assert(record.attemptId === attempt.id, `result.json attemptId ${record.attemptId} does not match ${attempt.id}`)
  assert(['passed', 'failed'].includes(record.status), 'result.json status must be passed|failed')
  assert(record.diagnostics === undefined || record.diagnostics === null || typeof record.diagnostics === 'object', 'result.json diagnostics must be an object or null')
  const usage = record.usage
  assert(usage && typeof usage === 'object' && !Array.isArray(usage), 'result.json usage is required')
  unknownFields(usage, ['promptTokens', 'completionTokens'], 'result.json usage')
  for (const field of ['promptTokens', 'completionTokens']) {
    assert(Number.isInteger(usage[field]) && usage[field] >= 0, `result.json usage.${field} must be a non-negative integer`)
  }
  assert(Array.isArray(record.closedGoals), 'result.json closedGoals must be an array of goal ids')
  record.closedGoals.forEach((goalId, index) => assert(GOAL_ID.test(goalId ?? ''), `result.json closedGoals[${index}] must be a goal id`))
  if (record.inputHash !== undefined) assert(HEX64.test(record.inputHash ?? ''), 'result.json inputHash must be sha256 hex')
  const verification = record.verification ?? []
  assert(Array.isArray(verification), 'result.json verification must be an array of typed records')
  verification.forEach((entry, index) => {
    const label = `result.json verification[${index}]`
    assert(entry && typeof entry === 'object' && !Array.isArray(entry), `${label} must be an object`)
    unknownFields(entry, ['kind', 'verdict', 'bindingHashes'], label)
    assert(typeof entry.kind === 'string' && entry.kind.length > 0, `${label}.kind must be a non-empty string`)
    assert(typeof entry.verdict === 'string' && entry.verdict.length > 0, `${label}.verdict must be a non-empty string`)
    if (entry.bindingHashes !== undefined) {
      assert(entry.bindingHashes && typeof entry.bindingHashes === 'object' && !Array.isArray(entry.bindingHashes), `${label}.bindingHashes must be an object`)
      for (const [name, hex] of Object.entries(entry.bindingHashes)) assert(HEX64.test(hex ?? ''), `${label}.bindingHashes.${name} must be lowercase sha256 hex`)
    }
  })
  return verification
}

/** §5.1: closure needs the L2 typed record; a diagnostics-only result closes nothing. */
export function l2ClosureRecord(record) {
  const verification = record.verification ?? []
  return verification.find(entry => entry.kind === 'l2-pass' && entry.verdict === 'pass'
    && entry.bindingHashes && Object.keys(entry.bindingHashes).length > 0) ?? null
}

export async function recordResult(path, { attemptId, resultPath }, { io = fs, now = () => new Date().toISOString() } = {}) {
  const state = await loadState(path, { io })
  const attempt = findAttempt(state, attemptId)
  assert(IN_FLIGHT.includes(attempt.status), `attempt ${attemptId} is already ${attempt.status}; a result is recorded once`, 'illegal-transition')
  const file = resolve(resultPath)
  const result = await readJson(file, 'result.json').catch(error => {
    if (error.code === 'ENOENT') fail('config-invalid', `result file ${resultPath} does not exist`)
    throw error
  })
  const verification = validateResultRecord(result, attempt)
  if (result.inputHash !== undefined && attempt.inputHash !== null) {
    assert(result.inputHash === attempt.inputHash, 'result.json inputHash does not match the dispatch input hash: the result belongs to another dispatch', 'hash-mismatch')
  }
  const closure = l2ClosureRecord(result)
  // A claimed pass is only a pass when the L2 typed record backs it, and a
  // closure claim is only a closure when that record exists (§5.1).
  if (result.status === 'passed') {
    assert(closure !== null, 'result.json claims passed without a {kind:"l2-pass", verdict:"pass", bindingHashes} record; diagnostics alone never pass', 'missing-record')
  }
  if (result.closedGoals.length > 0) {
    assert(closure !== null && result.status === 'passed', 'result.json cannot close a goal without a passed L2 typed record', 'missing-record')
  }
  for (const goalId of result.closedGoals) {
    const goal = findGoal(state, goalId)
    assert(['open', 'in-progress'].includes(goal.state), `goal ${goalId} is already ${goal.state}`, 'illegal-transition')
  }
  attempt.status = result.status
  attempt.resultHash = await hashFile(file)
  for (const goalId of result.closedGoals) {
    const goal = findGoal(state, goalId)
    goal.state = 'closed'
    goal.closedBy = attemptId
  }
  releaseGoal(state, attempt.goalId)
  refreshStatus(state)
  await saveState(path, state, io)
  return {
    subcommand: 'record-result',
    attemptId,
    status: attempt.status,
    resultHash: attempt.resultHash,
    closedGoals: result.closedGoals,
    verified: closure !== null,
    verificationKinds: verification.map(entry => `${entry.kind}:${entry.verdict}`),
    at: now(),
    problemStatus: state.status,
    goals: state.goals.map(goal => ({ id: goal.id, state: goal.state, closedBy: goal.closedBy })),
  }
}

// ---------------------------------------------------------------------------
// Scaffolds (§5.4)
// ---------------------------------------------------------------------------
export async function openScaffold(path, { goalId, childProblemId, connectingImplication }, { io = fs } = {}) {
  const state = await loadState(path, { io })
  const goal = findGoal(state, goalId)
  assert(['open', 'in-progress'].includes(goal.state), `goal ${goalId} is ${goal.state}; no scaffold opens under it`, 'illegal-transition')
  assert(PROBLEM_ID.test(childProblemId ?? ''), 'childProblemId must be a problem id')
  assert(typeof connectingImplication === 'string' && connectingImplication.trim().length > 0, 'connectingImplication is required (§5.4)')
  // Cycle rejection through the scaffoldOf lineage: a child may never be this
  // problem or one of its ancestors.
  const lineage = [...state.lineage, state.problemId]
  assert(!lineage.includes(childProblemId), `scaffolded problem ${childProblemId} is on the lineage ${lineage.join(' → ')}: that is a cycle`, 'cycle-rejected')
  assert(state.scaffolds.every(scaffold => scaffold.childProblemId !== childProblemId), `a scaffold for ${childProblemId} already exists`, 'config-invalid')
  const depth = lineage.length
  // Depth cap (§5.4): terminate THAT branch, never the problem.
  if (depth > MAX_SCAFFOLD_DEPTH) {
    goal.state = 'abandoned'
    for (const scaffold of state.scaffolds) {
      if (scaffold.goalId === goalId && ['open', 'child-proven'].includes(scaffold.state)) {
        scaffold.state = 'dead'
        scaffold.deathCause = 'parent-abandoned'
      }
    }
    refreshStatus(state)
    await saveState(path, state, io)
    return {
      subcommand: 'scaffold-open',
      created: false,
      reason: 'depth-cap',
      depth,
      cap: MAX_SCAFFOLD_DEPTH,
      goal: { id: goalId, state: goal.state },
      problemStatus: state.status,
      note: 'the depth cap terminates the branch (goal abandoned); the problem keeps its other branches',
    }
  }
  state.scaffolds.push({
    goalId,
    childProblemId,
    depth,
    connectingImplication,
    state: 'open',
    scaffoldOf: state.problemId,
  })
  await saveState(path, state, io)
  return { subcommand: 'scaffold-open', created: true, goalId, childProblemId, depth, state: 'open', lineage }
}

export async function advanceScaffold(path, { goalId, childProblemId, to, cause = null, records = [] }, { io = fs } = {}) {
  const state = await loadState(path, { io })
  assert(SCAFFOLD_STATES.includes(to), `target scaffold state must be one of ${SCAFFOLD_STATES.join('|')}`, 'illegal-transition')
  const scaffold = state.scaffolds.find(entry => entry.goalId === goalId && entry.childProblemId === childProblemId)
  if (!scaffold) fail('config-invalid', `no scaffold for ${childProblemId} under goal ${goalId}`)
  const edge = `${scaffold.state}→${to}`
  const causes = SCAFFOLD_EDGES[edge]
  if (!causes) fail('illegal-transition', `${edge} is not a scaffold edge (open → child-proven → integrated | dead)`)
  if (to === 'dead') {
    assert(cause !== null, `scaffold → dead needs --cause from ${DEATH_CAUSES.join('|')}`)
    if (!causes.includes(cause)) fail('illegal-transition', `${edge} does not admit death cause ${cause}; admitted: ${causes.join('|') || 'none'}`)
  } else {
    assert(cause === null, `--cause applies only to a dead scaffold`)
  }
  if (to === 'child-proven') {
    // The child's claim is recorded independently: its own L2 pass is the
    // only evidence that lifts a scaffold out of `open` (§5.4).
    const passed = records.some(record => record?.kind === 'l2-pass' && record.verdict === 'pass'
      && record.bindingHashes && Object.keys(record.bindingHashes).length > 0)
    assert(passed, 'scaffold → child-proven requires the child\'s own {kind:"l2-pass", verdict:"pass", bindingHashes} record', 'missing-record')
  }
  if (to === 'integrated') {
    const goal = findGoal(state, goalId)
    assert(goal.state === 'closed', `scaffold integrates only after the parent goal closes through its own checked proof; goal ${goalId} is ${goal.state}`, 'illegal-transition')
  }
  scaffold.state = to
  if (to === 'dead') scaffold.deathCause = cause
  await saveState(path, state, io)
  return { subcommand: 'scaffold-advance', goalId, childProblemId, from: edge.split('→')[0], to, cause: cause ?? null, note: to === 'dead' ? 'the parent goal stays open; other branches continue' : null }
}

export async function abandonGoal(path, { goalId, cause = 'parent-abandoned' }, { io = fs } = {}) {
  const state = await loadState(path, { io })
  const goal = findGoal(state, goalId)
  assert(goal.state !== 'closed', `goal ${goalId} is already closed`, 'illegal-transition')
  assert(DEATH_CAUSES.includes(cause), `cause must be one of ${DEATH_CAUSES.join('|')}`)
  goal.state = 'abandoned'
  const killed = []
  for (const scaffold of state.scaffolds) {
    if (scaffold.goalId !== goalId || !['open', 'child-proven'].includes(scaffold.state)) continue
    scaffold.state = 'dead'
    scaffold.deathCause = cause
    killed.push(scaffold.childProblemId)
  }
  refreshStatus(state)
  await saveState(path, state, io)
  return { subcommand: 'abandon-goal', goalId, cause, scaffoldsKilled: killed, problemStatus: state.status }
}

export async function setStatus(path, { status }, { io = fs } = {}) {
  const state = await loadState(path, { io })
  assert(PROBLEM_STATUSES.includes(status), `status must be one of ${PROBLEM_STATUSES.join('|')}`)
  if (STICKY_STATUSES.includes(state.status) && state.status !== status) {
    fail('illegal-transition', `problem ${state.problemId} already recorded the terminal decision ${state.status}`)
  }
  state.status = status
  await saveState(path, state, io)
  return { subcommand: 'set-status', problemId: state.problemId, status: state.status, derived: deriveStatus(state) }
}

// ---------------------------------------------------------------------------
// Resume (§3.3 v4 / §5.1 fixed order)
// ---------------------------------------------------------------------------
async function collectResults(dir, io) {
  const found = []
  async function walk(current) {
    for (const entry of await io.readdir(current, { withFileTypes: true })) {
      const next = join(current, entry.name)
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile() && entry.name === 'result.json') found.push(next)
    }
  }
  await walk(dir)
  return found.sort()
}

/** Reconcile one in-flight attempt against a candidate result file. Returns the attempt status or null. */
async function reconcile(attempt, files, io) {
  for (const file of files) {
    let record
    try { record = await readJson(file, `result file ${file}`) } catch { continue }
    if (!record || record.attemptId !== attempt.id) continue
    let hash
    try { hash = await hashFile(file) } catch { continue }
    if (record.inputHash !== undefined && attempt.inputHash !== null && record.inputHash !== attempt.inputHash) {
      return { status: 'discarded', reason: 'input-hash-mismatch', file, resultHash: hash }
    }
    if (attempt.resultHash !== null && attempt.resultHash !== hash) {
      return { status: 'discarded', reason: 'result-hash-mismatch', file, resultHash: hash }
    }
    // A malformed typed record is not adopted: the attempt is discarded and
    // its goal stays/become open for a fresh dispatch.
    try { validateResultRecord(record, attempt) }
    catch { return { status: 'discarded', reason: 'result-invalid', file, resultHash: hash } }
    return { status: record.status === 'passed' ? 'passed' : 'failed', reason: null, file, resultHash: hash, record }
  }
  return null
}

export async function resume(path, { resultsDir = null }, { io = fs, now = () => new Date().toISOString() } = {}) {
  const state = await loadState(path, { io })
  const root = dirname(path)
  const external = resultsDir === null ? [] : await collectResults(resolve(resultsDir), io).catch(() => [])
  const reconciled = []
  const discarded = []
  // Phase 1 — reconcile in-flight attempts by result.json hash. A tampered or
  // foreign result discards the attempt instead of adopting it.
  for (const attempt of state.attempts) {
    if (!IN_FLIGHT.includes(attempt.status)) continue
    const local = attempt.dir ? [join(root, attempt.dir, 'result.json')] : []
    const files = [...local.filter(file => file), ...external]
    const outcome = await reconcile(attempt, files, io)
    if (outcome === null) continue
    if (outcome.status === 'discarded') {
      attempt.status = 'discarded'
      discarded.push({ attemptId: attempt.id, opId: attempt.opId, reason: outcome.reason, at: now() })
    } else {
      attempt.status = outcome.status
      attempt.resultHash = outcome.resultHash
      const record = outcome.record ?? {}
      for (const goalId of Array.isArray(record.closedGoals) ? record.closedGoals : []) {
        if (!Array.isArray(record.verification) || l2ClosureRecord(record) === null || record.status !== 'passed') continue
        const goal = state.goals.find(entry => entry.id === goalId)
        if (!goal || goal.state === 'closed') continue
        goal.state = 'closed'
        goal.closedBy = attempt.id
      }
      reconciled.push({ attemptId: attempt.id, status: attempt.status, resultHash: attempt.resultHash, file: outcome.file })
    }
    releaseGoal(state, attempt.goalId)
  }
  // Phase 1b — a result already recorded on the attempt row is re-verified
  // against the file on disk: a result.json whose bytes changed since it was
  // adopted is a tampered attempt, so the attempt is discarded rather than
  // trusted (its closing goal reopens below).
  for (const attempt of state.attempts) {
    if (attempt.resultHash === null || attempt.status === 'discarded') continue
    const file = join(root, attempt.dir, 'result.json')
    const actual = await hashFile(file).catch(() => null)
    if (actual === null || actual === attempt.resultHash) continue
    attempt.status = 'discarded'
    discarded.push({ attemptId: attempt.id, opId: attempt.opId, reason: 'result-hash-mismatch', at: now() })
    releaseGoal(state, attempt.goalId)
  }
  // Phase 2 — everything still unsettled is discarded. The budget side of the
  // rollback belongs to budget-ledger (never refunds); this script reports the
  // opIds so the caller can run it.
  const opIds = []
  for (const attempt of state.attempts) {
    if (!IN_FLIGHT.includes(attempt.status)) continue
    attempt.status = 'discarded'
    opIds.push(attempt.opId)
    discarded.push({ attemptId: attempt.id, opId: attempt.opId, reason: 'unsettled-at-resume', at: now() })
    releaseGoal(state, attempt.goalId)
  }
  // Finally: a previously closed goal whose closing attempt was discarded reopens.
  for (const goal of state.goals) {
    if (goal.state !== 'closed') continue
    const closer = state.attempts.find(attempt => attempt.id === goal.closedBy)
    if (closer && closer.status === 'discarded') { goal.state = 'open'; goal.closedBy = null }
  }
  refreshStatus(state)
  await saveState(path, state, io)
  return {
    subcommand: 'resume',
    problemId: state.problemId,
    reconciled,
    discarded,
    budgetDelegation: { note: 'budget-ledger.mjs resume/rollback-unsettled owns the charge side (rollback never refunds)', opIds },
    problemStatus: state.status,
    goals: state.goals.map(goal => ({ id: goal.id, state: goal.state, closedBy: goal.closedBy })),
  }
}

export async function inspect(path, { io = fs } = {}) {
  const state = await loadState(path, { io })
  const counts = {
    goals: state.goals.length,
    closed: state.goals.filter(goal => goal.state === 'closed').length,
    abandoned: state.goals.filter(goal => goal.state === 'abandoned').length,
    attempts: state.attempts.length,
    inFlight: state.attempts.filter(attempt => IN_FLIGHT.includes(attempt.status)).length,
    scaffolds: state.scaffolds.length,
    liveScaffolds: state.scaffolds.filter(scaffold => scaffold.state !== 'dead').length,
  }
  return { subcommand: 'status', path: resolve(path), status: state.status, derived: deriveStatus(state), counts, scheduler: state.scheduler }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'search-state — proof-search state for one problem (design §5.1, §5.2, §5.4)',
  'usage: search-state.mjs <subcommand> --search <problem-dir/search.json> [options]',
  '  init --run-id <id> --problem-id <p> [--lineage p-001,p-000]   create (idempotent identity check)',
  '  add-goal --goal-id g-001 --statement-shape "<shape>" [--parent g-000]',
  '  add-attempt --goal-id g-001 --op-id op-7 [--attempt-id attempt-003] [--inputs <file>] [--dir attempts/attempt-003/] [--status pending|running]',
  '  add-repair --attempt-id attempt-003        one of at most 2 repair rounds per attempt (§5.2)',
  '  record-result --attempt-id a --result <result.json>',
  '  scaffold-open --goal-id g --child-problem-id p-002 --connecting-implication "<prop>"',
  '  scaffold-advance --goal-id g --child-problem-id p --to child-proven|integrated|dead [--cause c] [--records <file>]',
  '  abandon-goal --goal-id g [--cause c]',
  '  set-status --status running|solved|unsolved-with-progress|budget-exhausted|fidelity-failed',
  '  resume [--results <dir>]                  reconcile in-flight attempts by result hash, THEN discard the rest',
  '  status',
  `goal states: ${GOAL_STATES.join('|')} · attempt states: ${ATTEMPT_STATUSES.join('|')}`,
  `scaffold: open→child-proven→integrated | dead · death causes: ${DEATH_CAUSES.join('|')} · depth cap ${MAX_SCAFFOLD_DEPTH}`,
  'closure: an attempt closes a goal only with a {kind:"l2-pass", verdict:"pass", bindingHashes} record — diagnostics never close (exit 2)',
  'exit codes: 0 ok · 2 blocked (config-invalid, state-missing, missing-record, illegal-transition, cycle-rejected, repair-cap-exceeded, hash-mismatch) · single-line JSON on stdout',
].join('\n')

const need = (options, keys) => { for (const key of keys) if (options[key] === undefined || options[key] === true) fail('config-invalid', `--${key} is required`) }

async function handle(argv) {
  const options = parseFlags(
    argv,
    ['search', 'run-id', 'problem-id', 'lineage', 'goal-id', 'parent', 'statement-shape', 'attempt-id', 'op-id', 'inputs', 'dir', 'status', 'result', 'child-problem-id', 'connecting-implication', 'to', 'cause', 'records', 'results'],
    { required: ['search'] },
  )
  if (options.help) return 'help'
  if (!options.subcommand) fail('config-invalid', 'a subcommand is required')
  const path = resolve(options.search)
  await ensureWritable(dirname(path))
  const wrap = result => ({ exitCode: 0, report: { schemaVersion: 1, command: 'search-state', status: 'ok', ...result } })
  switch (options.subcommand) {
    case 'init': {
      need(options, ['run-id', 'problem-id'])
      const lineage = (options.lineage ?? '').split(',').map(part => part.trim()).filter(Boolean)
      return wrap(await initState(path, { runId: options['run-id'], problemId: options['problem-id'], lineage }))
    }
    case 'add-goal': {
      need(options, ['goal-id', 'statement-shape'])
      return wrap(await addGoal(path, { goalId: options['goal-id'], parent: options.parent ?? null, statementShape: options['statement-shape'] }))
    }
    case 'add-attempt': {
      need(options, ['goal-id', 'op-id'])
      return wrap(await addAttempt(path, {
        attemptId: options['attempt-id'] ?? null,
        goalId: options['goal-id'],
        opId: options['op-id'],
        dir: options.dir ?? null,
        status: options.status ?? 'running',
        inputs: options.inputs ?? null,
      }))
    }
    case 'add-repair': {
      need(options, ['attempt-id'])
      return wrap(await addRepairRound(path, { attemptId: options['attempt-id'] }))
    }
    case 'record-result': {
      need(options, ['attempt-id', 'result'])
      return wrap(await recordResult(path, { attemptId: options['attempt-id'], resultPath: resolve(options.result) }))
    }
    case 'scaffold-open': {
      need(options, ['goal-id', 'child-problem-id', 'connecting-implication'])
      return wrap(await openScaffold(path, {
        goalId: options['goal-id'],
        childProblemId: options['child-problem-id'],
        connectingImplication: options['connecting-implication'],
      }))
    }
    case 'scaffold-advance': {
      need(options, ['goal-id', 'child-problem-id', 'to'])
      const records = options.records === undefined ? [] : await readJson(resolve(options.records), 'records file')
      assert(Array.isArray(records), '--records must contain a JSON array')
      return wrap(await advanceScaffold(path, {
        goalId: options['goal-id'],
        childProblemId: options['child-problem-id'],
        to: options.to,
        cause: options.cause ?? null,
        records,
      }))
    }
    case 'abandon-goal': {
      need(options, ['goal-id'])
      return wrap(await abandonGoal(path, { goalId: options['goal-id'], cause: options.cause ?? 'parent-abandoned' }))
    }
    case 'set-status': {
      need(options, ['status'])
      return wrap(await setStatus(path, { status: options.status }))
    }
    case 'resume': return wrap(await resume(path, { resultsDir: options.results ?? null }))
    case 'status': return wrap(await inspect(path))
    default: fail('config-invalid', `unknown subcommand ${options.subcommand}`)
  }
}

export async function main(argv = process.argv.slice(2)) {
  return runCli('search-state', HELP, argv, handle)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
