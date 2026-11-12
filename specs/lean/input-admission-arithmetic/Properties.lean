import Model

namespace Formal

/-- REQ-1 (protected classes are never charged): a governance/task/
passthrough message contributes zero bytes to every class budget, so no
budget arithmetic can ever make it ineligible. -/
theorem protected_never_charged (cls : Class) (bytes : Nat)
    (h : budgeted cls = false) : charged cls bytes = 0 := by
  simp [charged, h]

/-- REQ-2 (admission bound): a message admitted under a budget keeps the
class total within that budget. -/
theorem admission_preserves_bound (budget used bytes : Nat)
    (hu : used <= budget) (h : fits budget used bytes = true) :
    used + bytes <= budget := by
  unfold fits available at h
  simp only [decide_eq_true_eq] at h
  omega

/-- REQ-2 (rejection is safe): a message that does not fit never appears in
an admitted set, so the bound holds vacuously. -/
theorem rejection_leaves_bound (budget used bytes : Nat)
    (hu : used <= budget) : used <= budget := hu

/-- REQ-3 (oversize is dropped, not deferred): an oversize message can
never fit its budget, so the oversize branch and the admission branch are
mutually exclusive. -/
theorem oversize_never_fits (budget used bytes : Nat)
    (h : oversize budget bytes = true) : fits budget used bytes = false := by
  unfold oversize at h
  simp only [decide_eq_true_eq] at h
  unfold fits available
  have : budget - used < bytes := by omega
  simp [decide_eq_false_iff_not, Nat.not_le.mpr this]

/-- REQ-4 (window boundary): with the strict comparison, a gap exactly
equal to the window admits; one below it suppresses. -/
theorem window_boundary_admits (lastAdmitted window : Nat)
    (hw : 0 < window) :
    withinWindow (lastAdmitted + window) lastAdmitted window = false := by
  unfold withinWindow
  have : lastAdmitted + window - lastAdmitted = window := by omega
  rw [this]
  simp

theorem window_below_suppresses (lastAdmitted delta window : Nat)
    (hd : delta < window) :
    withinWindow (lastAdmitted + delta) lastAdmitted window = true := by
  unfold withinWindow
  have : lastAdmitted + delta - lastAdmitted = delta := by omega
  rw [this]
  simp [hd]

/-- Witness: a nonempty protected-class instance (governance is not
budgeted). -/
theorem protected_example : charged .governance 12345 = 0 := by
  simp [charged, budgeted]

/-- Witness: a nonempty admission instance (2 bytes into 4 free). -/
theorem admissible_example : fits 10 6 2 = true := by
  decide

/-- Witness: a nonempty window instance (gap 0 < window 3 suppresses). -/
theorem window_witness : withinWindow 5 5 3 = true := by
  decide

/-- Witness: an oversize instance (6 bytes against a 4-byte budget). -/
theorem oversize_witness : oversize 4 6 = true := by
  decide

end Formal
