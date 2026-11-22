import { describe, expect, it } from 'vitest'
import { SCORER_CONTRACT_VERSION, describeScoringProcedure, scoreCandidate } from '../src/scorer.js'

// Doc-test for the §8.3 uniform scoring contract (docs/plans/2026-11-21-mathematical-research-harness.md):
// the anti-restatement rule is the load-bearing half — a candidate statement
// alone never scores. The kernel-check integration lands in a later wave, so
// the contract is pinned as text while `scoreCandidate` stays a stub.
describe('describeScoringProcedure', () => {
  const procedure = describeScoringProcedure()

  it('pins the version identifier it describes', () => {
    expect(procedure).toContain(SCORER_CONTRACT_VERSION)
    expect(SCORER_CONTRACT_VERSION).toBe('math-eval-scorer@0')
  })

  it('requires kernel statement type-equality against the reference statement', () => {
    expect(procedure).toMatch(/kernel type-equal/i)
    expect(procedure).toMatch(/reference statement/i)
    expect(procedure).toMatch(/equivalence proof/i)
  })

  it('requires the candidate proof to pass the full L2 check (anti-restatement)', () => {
    expect(procedure).toMatch(/candidate's proof/i)
    expect(procedure).toMatch(/full L2 check/i)
    expect(procedure).toMatch(/compile, binding, sorry\/axiom rules/)
    expect(procedure).toMatch(/merely restates the benchmark theorem/i)
    expect(procedure).toMatch(/does not pass/i)
  })

  it('forbids the scorer from supplying proofs or missing reasoning', () => {
    expect(procedure).toMatch(/never supplies proofs/i)
    expect(procedure).toMatch(/charged to the scorer/i)
    expect(procedure).toMatch(/one repair round/i)
  })

  it('is pure and deterministic', () => {
    expect(describeScoringProcedure()).toBe(procedure)
    expect(procedure.startsWith(SCORER_CONTRACT_VERSION)).toBe(true)
  })
})

describe('scoreCandidate', () => {
  it('validates inputs and returns the structured not-implemented result', () => {
    const result = scoreCandidate(
      { statedAnswer: 'The answer is 42; proof: by induction.', formalProof: 'theorem foo : True := trivial' },
      { statementFile: 'fixtures/proofnet/0001_statement.lean' },
    )
    expect(result.status).toBe('not-implemented')
    expect(result.reason).toContain(SCORER_CONTRACT_VERSION)
    expect(result.reason).toContain('fixtures/proofnet/0001_statement.lean')
  })

  it('rejects an empty stated answer or a missing reference file', () => {
    expect(() => scoreCandidate({ statedAnswer: '   ' }, { statementFile: 'x.lean' })).toThrow(/statedAnswer/)
    expect(() => scoreCandidate({ statedAnswer: 'ok' }, { statementFile: '' })).toThrow(/statementFile/)
  })

  it('rejects a blank optional formal field rather than treating it as absent', () => {
    expect(() =>
      scoreCandidate({ statedAnswer: 'ok', formalStatement: '' }, { statementFile: 'x.lean' }),
    ).toThrow(/formalStatement/)
    expect(() =>
      scoreCandidate({ statedAnswer: 'ok', formalProof: '   ' }, { statementFile: 'x.lean' }),
    ).toThrow(/formalProof/)
  })
})
