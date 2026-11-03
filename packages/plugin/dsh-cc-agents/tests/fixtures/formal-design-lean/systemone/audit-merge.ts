// Conformance fixture for the worst-verdict merge lattice.
//
// This is a model-local reference implementation, NOT production code: the
// shipped merge lives in `packages/interaction/vwa-argument/src/audit-align.ts`
// (`mergeChunkTargets`'s VERDICT_SEVERITY comparison) but is not exported, and
// S1-08 has not yet extracted it. When the split work exposes that helper, the
// adapter must be re-pointed at it and this fixture removed.
//
// Semantics mirror Model.lean: `not-run` is the identity, `fail` absorbs,
// and the merge is the severity maximum of its operands.

export type Verdict = 'not-run' | 'pass' | 'needs-review' | 'fail'

const SEVERITY: Record<Verdict, number> = {
  'not-run': 0,
  pass: 1,
  'needs-review': 2,
  fail: 3,
}

const BY_SEVERITY: Verdict[] = ['not-run', 'pass', 'needs-review', 'fail']

export function mergeWorst(verdicts: readonly string[]): Verdict {
  let worst = 0
  for (const verdict of verdicts) {
    const severity = SEVERITY[verdict as Verdict]
    if (severity === undefined) throw new Error(`unknown verdict: ${verdict}`)
    if (severity > worst) worst = severity
  }
  return BY_SEVERITY[worst]
}
