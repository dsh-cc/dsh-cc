import Model

namespace Formal

/- Helper: the merged severity is exactly the maximum of the operand
severities. The verdict lattice is finite, so enumeration is complete. -/
theorem severity_worst (a b : Verdict) :
    severity (worst a b) = max (severity a) (severity b) := by
  cases a <;> cases b <;> simp [worst, severity]

/- **Never improves**: merging never weakens either operand's severity —
a pass or not-run can never erase a fail on the same rule. -/
theorem worst_never_improves (a b : Verdict) :
    severity a ≤ severity (worst a b) ∧ severity b ≤ severity (worst a b) := by
  rw [severity_worst]
  omega

/- **Fail is absorbing**: any merge with a fail is a fail — the strongest
statement of "a later chunk's pass cannot erase a fail". -/
theorem worst_fail_absorbing (a : Verdict) : worst a .fail = .fail := by
  cases a <;> simp [worst, severity]

/- **Bottom identity**: not-run is the neutral element. -/
theorem worst_notRun_identity (a : Verdict) :
    worst a .notRun = a ∧ worst .notRun a = a := by
  constructor
  · cases a <;> simp [worst, severity]
  · cases a <;> simp [worst, severity]

/- **Idempotence**: merging a verdict with itself changes nothing. -/
theorem worst_idempotent (a : Verdict) : worst a a = a := by
  cases a <;> simp [worst, severity]

/- **Associativity**: the merge is associative, so per-rule results are
independent of how chunks are regrouped. -/
theorem worst_associative (a b c : Verdict) :
    worst (worst a b) c = worst a (worst b c) := by
  cases a <;> cases b <;> cases c <;> simp [worst, severity]

/- **Value-level commutativity**: severities are injective on verdicts,
so a tie is value equality and the first-wins tie rule does not affect
the merged value. -/
theorem worst_commutative (a b : Verdict) : worst a b = worst b a := by
  cases a <;> cases b <;> simp [worst, severity]

/- **The merge computes the maximum severity**: the merged verdict's
severity is exactly the maximum severity over the chunk list — no
chunk's severity can be lost, and no severity above the inputs can
appear. -/
theorem mergeVerdicts_severity_is_max (l : List Verdict) :
    severity (mergeVerdicts l) = (l.map severity).foldr max 0 := by
  induction l with
  | nil => simp [mergeVerdicts, severity]
  | cons v rest ih =>
      simp only [mergeVerdicts, List.map_cons, List.foldr_cons]
      rw [severity_worst, ih]

end Formal
