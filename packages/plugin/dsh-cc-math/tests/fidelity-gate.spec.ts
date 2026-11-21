/**
 * Fidelity gate behavioral tests (design §4.3): the nine-row decision table
 * exactly as written, `uncertain` never counting as a pass, the authority rule
 * (pairEquivalence advisory only; anchored needs a passing reference check),
 * the disputeReason taxonomy (anchor-failed / model-judgment / infra-failure),
 * and the pre-commitment infra retry (one re-run request, nothing written;
 * then a committed dispute that is never retried).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCEPTED_GRADES, DISPUTE_REASONS, GRADES, MAX_INFRA_RETRIES, decideFidelity, escalationFor,
  main, runFidelityGate, validateFidelityInput,
} from '../skills/math-research/scripts/fidelity-gate.mjs'
import { exists } from '../skills/math-research/scripts/storage.lib.mjs'
import { cli, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

type Input = Record<string, unknown>

const EQUIVALENT = { equivalent: true, differences: [] }
const UNCERTAIN = { equivalent: 'uncertain', differences: ['hedged hypothesis'] }
const DIFFERING = { equivalent: false, differences: ['statement.lean drops the a ≠ 0 hypothesis'] }
const CLEAN = { missing: [], extra: [] }
const DIRTY = { missing: ['a ≠ 0'], extra: ['Continuity f'] }

const input = (overrides: Input = {}): Input => ({
  schemaVersion: 1,
  backTranslation: EQUIVALENT,
  premiseAudit: CLEAN,
  ...overrides,
})

async function problemWith(contents: Input | string): Promise<string> {
  const dir = await roots.make('mrh-gate-')
  await writeFile(join(dir, 'fidelity-input.json'), typeof contents === 'string' ? contents : JSON.stringify(contents))
  return dir
}

const decide = (overrides: Input = {}) => decideFidelity(validateFidelityInput(input(overrides)))

describe('fidelity gate — nine-row decision table (§4.3)', () => {
  it('row 1: equivalent + clean + no reference → model-assessed', () => {
    const decision = decide()
    expect(decision).toMatchObject({ decisionRow: 1, grade: 'model-assessed', disputeReason: null, retryRequested: false })
    // An explicit `not-run` anchor status is the same statement as "no reference".
    expect(decide({ anchorCheck: { status: 'not-run', evidenceRef: null } })).toMatchObject({ decisionRow: 1, grade: 'model-assessed' })
  })

  it('row 2: equivalent + clean + kernel check passes → anchored', () => {
    expect(decide({ anchorCheck: { status: 'passes', evidenceRef: 'anchor-check.json' } })).toMatchObject({
      decisionRow: 2, grade: 'anchored', disputeReason: null,
    })
  })

  it('row 3: equivalent + clean + kernel check FAILS → disputed (anchor-failed), never retried', () => {
    const decision = decide({ anchorCheck: { status: 'fails', evidenceRef: 'anchor-check.json' } })
    expect(decision).toMatchObject({ decisionRow: 3, grade: 'disputed', disputeReason: 'anchor-failed', retryRequested: false })
    // Kernel evidence of infidelity is not an infra failure: no retry window.
    expect(decide({ retryCount: 0, anchorCheck: { status: 'fails', evidenceRef: null } }).retryRequested).toBe(false)
  })

  it('row 4: equivalent + clean + anchor cannot run → infra retry, then disputed(infra-failure)', () => {
    const first = decide({ anchorCheck: { status: 'cannot-run', evidenceRef: null } })
    expect(first).toMatchObject({ decisionRow: 4, grade: null, retryRequested: true, checksToRetry: ['anchor-check'] })
    const second = decide({ retryCount: 1, anchorCheck: { status: 'cannot-run', evidenceRef: null } })
    expect(second).toMatchObject({ decisionRow: 4, grade: 'disputed', disputeReason: 'infra-failure', retryRequested: false, retryExhausted: true })
  })

  it('row 5: equivalent + premise differences → disputed (model-judgment)', () => {
    expect(decide({ premiseAudit: DIRTY })).toMatchObject({ decisionRow: 5, grade: 'disputed', disputeReason: 'model-judgment' })
    // A passing reference check does not rescue dirty premises (row 5 has no anchor column).
    expect(decide({ premiseAudit: DIRTY, anchorCheck: { status: 'passes', evidenceRef: null } })).toMatchObject({
      decisionRow: 5, grade: 'disputed', disputeReason: 'model-judgment',
    })
  })

  it('row 6/7: uncertain is never a pass, clean or dirty', () => {
    expect(decide({ backTranslation: UNCERTAIN })).toMatchObject({ decisionRow: 6, grade: 'disputed', disputeReason: 'model-judgment' })
    expect(decide({ backTranslation: UNCERTAIN, premiseAudit: DIRTY })).toMatchObject({ decisionRow: 7, grade: 'disputed', disputeReason: 'model-judgment' })
    // ...even with a passing anchor: check 1 must be `equivalent` for any
    // non-disputed grade (v4).
    expect(decide({ backTranslation: UNCERTAIN, anchorCheck: { status: 'passes', evidenceRef: null } })).toMatchObject({
      decisionRow: 6, grade: 'disputed', disputeReason: 'model-judgment',
    })
  })

  it('row 8: back-translation false → disputed (model-judgment) regardless of the other checks', () => {
    expect(decide({ backTranslation: DIFFERING })).toMatchObject({ decisionRow: 8, grade: 'disputed', disputeReason: 'model-judgment' })
    expect(decide({ backTranslation: DIFFERING, premiseAudit: DIRTY, anchorCheck: { status: 'passes', evidenceRef: null } })).toMatchObject({
      decisionRow: 8, grade: 'disputed', disputeReason: 'model-judgment',
    })
    // A check that merely failed to run cannot explain away positive evidence.
    expect(decide({ backTranslation: DIFFERING, premiseAudit: null })).toMatchObject({ decisionRow: 8, grade: 'disputed', disputeReason: 'model-judgment' })
  })

  it('row 9: a check that failed to run → infra retry, then disputed(infra-failure)', () => {
    for (const broken of [{ premiseAudit: null }, { backTranslation: null }]) {
      const first = decide(broken)
      expect(first).toMatchObject({ decisionRow: 9, grade: null, retryRequested: true })
      expect(first.checksToRetry.length).toBe(1)
      const second = decide({ ...broken, retryCount: 1 })
      expect(second).toMatchObject({ decisionRow: 9, grade: 'disputed', disputeReason: 'infra-failure' })
    }
    // Both checks missing retries both, in one window.
    expect(decide({ backTranslation: null, premiseAudit: null }).checksToRetry).toEqual(['back-translation', 'premise-audit'])
  })

  it('every decided row uses one of the four grades and the three dispute reasons', () => {
    for (const decision of [decide(), decide({ anchorCheck: { status: 'passes' } }), decide({ anchorCheck: { status: 'fails' } }), decide({ premiseAudit: DIRTY })]) {
      expect(GRADES).toContain(decision.grade)
      if (decision.grade === 'disputed') expect(DISPUTE_REASONS).toContain(decision.disputeReason)
      else expect(decision.disputeReason).toBeNull()
    }
  })
})

describe('fidelity gate — authority + retry semantics (§4.3)', () => {
  it('pairEquivalence is recorded as advisory pass-through and never changes the grade', () => {
    const decision = decide({ pairEquivalence: 'equivalent' })
    expect(decision.grade).toBe('model-assessed')
    // Two formalizations agreeing with each other is not evidence about the NL
    // statement: with differing back-translation the grade stays disputed.
    expect(decide({ pairEquivalence: 'equivalent', backTranslation: DIFFERING }).grade).toBe('disputed')
    expect(decide({ pairEquivalence: 'skipped' })).toMatchObject({ grade: 'model-assessed' })
  })

  it('model-assessed means exactly row 1: a reference whose check cannot run is row 4', () => {
    expect(decide({ anchorCheck: { status: 'cannot-run' } }).grade).toBeNull() // retry first
    expect(decide({ retryCount: 1, anchorCheck: { status: 'cannot-run' } }).grade).toBe('disputed')
  })

  it('the pre-commitment retry writes nothing; the committed dispute is written and never retried', async () => {
    const problem = await problemWith(input({ premiseAudit: null }))
    const first = await runFidelityGate({ problem })
    expect(first.status).toBe('retry-requested')
    expect(first.record.retry).toMatchObject({ requested: true, attempt: 1, maxRetries: MAX_INFRA_RETRIES, checksToRetry: ['premise-audit'] })
    expect(await exists(join(problem, 'fidelity.json'))).toBe(false) // no dispute committed

    // Re-run after re-performing the check succeeded: normal grade, no retry.
    await writeFile(join(problem, 'fidelity-input.json'), JSON.stringify(input({ retryCount: 1 })))
    const recovered = await runFidelityGate({ problem })
    expect(recovered.status).toBe('ok')
    expect(recovered.record).toMatchObject({ grade: 'model-assessed', decisionRow: 1 })

    // Second infra outcome commits the dispute...
    await writeFile(join(problem, 'fidelity-input.json'), JSON.stringify(input({ premiseAudit: null, retryCount: 1 })))
    const committed = await runFidelityGate({ problem })
    expect(committed.status).toBe('ok')
    expect(committed.record).toMatchObject({ grade: 'disputed', disputeReason: 'infra-failure', decisionRow: 9 })
    expect(committed.record.retry).toMatchObject({ requested: false, attempts: 1, exhausted: true })
    expect(await exists(join(problem, 'fidelity.json'))).toBe(true)

    // ...and a committed dispute is NEVER retried, however often it is re-run.
    for (const retryCount of [1, 2, 9]) {
      await writeFile(join(problem, 'fidelity-input.json'), JSON.stringify(input({ premiseAudit: null, retryCount })))
      const again = await runFidelityGate({ problem })
      expect(again.status).toBe('ok')
      expect(again.record).toMatchObject({ grade: 'disputed', disputeReason: 'infra-failure' })
    }
  })

  it('escalation follows allowHumanFidelity: terminal by default, escalates when enabled', async () => {
    const problem = await problemWith(input({ backTranslation: DIFFERING }))
    const terminal = await runFidelityGate({ problem })
    expect(terminal.record.escalation).toBe('terminal-fidelity-failed')
    const escalated = await runFidelityGate({ problem, allowHumanFidelity: true })
    expect(escalated.record.escalation).toBe('human-escalation')
    expect(escalationFor('anchored', false)).toBeNull()
    expect(ACCEPTED_GRADES).toEqual(['anchored', 'human-confirmed', 'model-assessed'])
  })
})

describe('fidelity gate — output record + CLI', () => {
  it('writes fidelity.json {grade, disputeReason, pairEquivalence, checks, decidedAt} and exits 0', async () => {
    const problem = await problemWith(input({
      pairId: 'proofnet-42', corrupted: false, pairEquivalence: 'unknown', anchorCheck: { status: 'passes', evidenceRef: 'anchor-check.json' },
    }))
    const { exitCode, output } = await cli(main, ['--problem', problem])
    expect(exitCode).toBe(0)
    expect(output).toMatchObject({ command: 'fidelity-gate', status: 'ok', grade: 'anchored', disputeReason: null, pairEquivalence: 'unknown', decisionRow: 2 })
    const record = JSON.parse((await (await import('node:fs/promises')).readFile(join(problem, 'fidelity.json'), 'utf8')) as string)
    expect(record).toMatchObject({
      schemaVersion: 1, grade: 'anchored', disputeReason: null, pairEquivalence: 'unknown', decisionRow: 2,
      checks: {
        backTranslation: { outcome: 'equivalent', differences: [] },
        premiseAudit: { outcome: 'clean', missing: [], extra: [] },
        anchorCheck: { outcome: 'passes', evidenceRef: 'anchor-check.json' },
      },
    })
    expect(typeof record.decidedAt).toBe('string')
    expect(Number.isNaN(Date.parse(record.decidedAt))).toBe(false)
    // measurement-protocol pass-through (§4.3)
    expect(record).toMatchObject({ pairId: 'proofnet-42', corrupted: false })
  })

  it('CLI exits 3 for the retry window and prints the single-line JSON request', async () => {
    const problem = await problemWith(input({ anchorCheck: { status: 'cannot-run' } }))
    const { exitCode, output } = await cli(main, ['--problem', problem])
    expect(exitCode).toBe(3)
    expect(output).toMatchObject({ status: 'retry-requested', decisionRow: 4, retry: { requested: true, checksToRetry: ['anchor-check'] } })
  })

  it('malformed input is config-invalid: exit 2 and nothing written', async () => {
    const cases: Array<Input | string> = [
      '',
      'not json',
      input({ schemaVersion: 2 }),
      input({ extraField: true }),
      input({ backTranslation: { equivalent: 'yes' } }),
      input({ backTranslation: { equivalent: true, differences: 'none' } }),
      input({ premiseAudit: { missing: [] } }),
      input({ anchorCheck: { status: 'maybe' } }),
      input({ pairEquivalence: 'equal' }),
      input({ retryCount: -1 }),
      input({ corrupted: 'yes' }),
    ]
    for (const contents of cases) {
      const problem = await problemWith(contents as Input | string)
      const { exitCode, output } = await cli(main, ['--problem', problem])
      expect(exitCode, JSON.stringify(contents)).toBe(2)
      expect(output).toMatchObject({ status: 'blocked', reason: { code: 'config-invalid' } })
      expect(await exists(join(problem, 'fidelity.json'))).toBe(false)
    }
  })

  it('a missing fidelity-input.json is config-invalid (never an assumed grade)', async () => {
    const problem = await roots.make('mrh-gate-empty-')
    await mkdir(problem, { recursive: true })
    const { exitCode } = await cli(main, ['--problem', problem])
    expect(exitCode).toBe(2)
  })
})
