import Model

namespace Formal

/-- Success implies the returned reservation stays within the budget. The
premise `r <= b` is stated explicitly so `Nat` subtraction is not saturating. -/
theorem reserve_preserves_bound (b r a : Nat) (h : r <= b) (ha : a <= b - r) : r + a <= b := by
  omega

/-- Success adds exactly the requested amount to the prior reservation. -/
theorem reserve_adds_amount (b r a v : Nat) (h : reserve b r a = .ok v) : v = r + a := by
  unfold reserve at h
  split at h <;> simp_all
  split at h <;> simp_all

/-- Rejection preserves the caller's prior state under the documented API
contract (`reserveState` keeps `reserved` on every error). -/
theorem reserve_rejection_preserves_state (b r a : Nat) (code : String)
    (h : reserve b r a = .error code) : (reserveState b r a).1 = r := by
  unfold reserveState
  simp [h]

theorem reserve_zero (b r : Nat) (h : r <= b) : reserve b r 0 = .ok r := by
  simp [reserve, Nat.not_lt.2 h]

/-- Witness: an explicit, nonempty instance of the success domain. -/
theorem admissible_example : reserve 10 3 4 = .ok 7 := by
  simp [reserve]

/-- Witness: an explicit, nonempty instance of the rejection domain. -/
theorem rejection_example : reserve 10 11 1 = .error "invalid-state" := by
  simp [reserve]

end Formal
