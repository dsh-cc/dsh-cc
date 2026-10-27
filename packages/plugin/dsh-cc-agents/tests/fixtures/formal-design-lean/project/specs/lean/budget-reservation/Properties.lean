import Model

namespace Formal

theorem reserve_preserves_bound (b r a : Nat) (h : r <= b) (ha : a <= b - r) : r + a <= b := by
  omega

theorem reserve_zero (b r : Nat) (h : r <= b) : reserve b r 0 = .ok r := by
  simp [reserve, Nat.not_lt.2 h]

/-- Witness: an explicit, nonempty instance of the guarded domain. -/
theorem admissible_example : reserve 10 3 4 = .ok 7 := by
  decide

end Formal
