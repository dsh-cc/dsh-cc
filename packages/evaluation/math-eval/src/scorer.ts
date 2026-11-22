/**
 * Scorer skeleton (docs/plans/2026-11-21-mathematical-research-harness.md §8.3).
 *
 * The uniform scoring contract is pinned here as text; the kernel-check
 * integration (statement type-equality against the reference, then the full
 * L2 check of the candidate's own proof) lands in a later wave. This module
 * never calls a model and never supplies proofs or missing reasoning.
 *
 * @module @dsh-cc/math-eval/scorer
 */

/** Frozen contract identifier; the scorer implementation must not drift silently. */
export const SCORER_CONTRACT_VERSION = 'math-eval-scorer@0'

/** What the config under test asserted. For proof benchmarks: statement AND proof. */
export interface CandidateAnswer {
  /** The candidate's stated final answer — for A/B the NL text including its proof. */
  statedAnswer: string
  /** Formal statement produced by the candidate (C–H/F1). Optional for A/B. */
  formalStatement?: string
  /** Formal proof produced by the candidate (C–H/F1). Optional for A/B. */
  formalProof?: string
}

/** The benchmark's trusted reference formalization (§8.1 fixtures, §4.3 anchors). */
export interface BenchmarkReference {
  statementFile: string
}

/** Placeholder outcome until the kernel-check wave wires real verdicts in. */
export interface ScoreResult {
  status: 'not-implemented'
  reason: string
}

/**
 * Score one candidate against one benchmark reference.
 *
 * Inputs are validated now (a blank answer, blank formal text or a missing
 * reference file is a caller bug, not a benchmark outcome); the verdict itself
 * is deferred. It will never derive a proof for the candidate — the scorer
 * only translates what the candidate itself asserted.
 */
export function scoreCandidate(
  candidate: CandidateAnswer,
  reference: BenchmarkReference,
): ScoreResult {
  const stated = candidate.statedAnswer?.trim() ?? ''
  if (stated.length === 0) {
    throw new TypeError('scoreCandidate: candidate.statedAnswer must be a non-empty string')
  }
  for (const field of ['formalStatement', 'formalProof'] as const) {
    const given = candidate[field]
    if (given !== undefined && given.trim().length === 0) {
      throw new TypeError(`scoreCandidate: candidate.${field} must be a non-empty string when present`)
    }
  }
  const statementFile = reference?.statementFile?.trim() ?? ''
  if (statementFile.length === 0) {
    throw new TypeError('scoreCandidate: reference.statementFile must be a non-empty string')
  }
  return {
    status: 'not-implemented',
    reason: `kernel-check integration lands in a later wave (${SCORER_CONTRACT_VERSION}); no verdict is derived from ${statementFile}`,
  }
}

/**
 * The §8.3 scoring contract as prose, for the doc test that pins it. Pure:
 * no fs, no model calls, identical output on every call.
 */
export function describeScoringProcedure(): string {
  return [
    `${SCORER_CONTRACT_VERSION} — uniform scoring for every config A–H incl. F1 (§8.3).`,
    '1. The candidate supplies a stated final answer; for proof benchmarks that answer consists of a statement AND a proof (A/B: the NL answer text including its proof; C–H/F1: the formal statement and proof produced).',
    '2. The scorer formalizes-or-passes the candidate\'s OWN statement and proof. It never supplies proofs, lemmas or missing reasoning — it only translates what the candidate itself asserted.',
    '3. Statement check: the candidate statement must be kernel type-equal to the benchmark reference statement, or come with a kernel-checked equivalence proof between the two, recorded by the scorer under its own pre-declared budget and its own one-round repair rule.',
    '4. Proof check: the candidate\'s proof must pass the full L2 check against the candidate statement — compile, binding, sorry/axiom rules. A candidate that merely restates the benchmark theorem supplies no valid proof and does not pass.',
    '5. Scorer formalization is model-assisted under a fixed, pre-declared budget charged to the scorer (never to the config under test), with one repair round.',
    '6. Reference formalizations come from the benchmark fixtures (trusted anchors, §4.3); metrics per §8.2: pass@1 with a fixed cap, pass@k for k ∈ {4,8} where each of the k runs is a full independent run of the config, plus tokens-per-solved and wall-clock-per-solved with actual usage reported separately.',
  ].join('\n')
}
