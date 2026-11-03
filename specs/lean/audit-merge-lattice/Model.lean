namespace Formal

/- The per-rule verdict lattice of the VWA audit alignment merge
(S1-08 / existing audit-align.ts). Every chunk is required to check the
same artifact target against all AUDIT rules, so duplicate
(targetId, ruleId) pairs are the normal case; the merge keeps the WORST
verdict so a later chunk's pass can never erase an earlier chunk's
fail. Verdict order: fail > needs-review > pass > not-run. Ties keep the
first chunk's entry — at verdict-value level a tie is equality, so the
value-level merge is a commutative semilattice. -/
inductive Verdict where
  | notRun
  | pass
  | needsReview
  | fail

def severity : Verdict → Nat
  | .notRun => 0
  | .pass => 1
  | .needsReview => 2
  | .fail => 3

/-- The worst-wins merge of two verdicts: strictly worse replaces, ties
keep the first operand (same value either way). -/
def worst : Verdict → Verdict → Verdict
  | a, b => if severity b > severity a then b else a

/-- The per-rule merge over a whole chunk list: the verdict a (targetId,
ruleId) pair carries after merging every chunk. -/
def mergeVerdicts : List Verdict → Verdict
  | [] => .notRun
  | v :: rest => worst v (mergeVerdicts rest)

end Formal
