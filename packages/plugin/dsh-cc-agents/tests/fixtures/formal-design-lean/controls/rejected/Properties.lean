import Lean
import Model

namespace Formal

/-- An incomplete proof hidden behind a helper lemma. -/
theorem hidden_sorry (b : Nat) : b = b := by
  sorry

theorem indirect_sorry (b : Nat) : b = b := hidden_sorry b

theorem direct_sorry (b : Nat) : b = b := by
  sorry

theorem admitted (b : Nat) : b = b := by
  admit

/-- Custom axiom outside the fixed allowlist. -/
axiom cheat : (b : Nat) → b = b

theorem from_cheat (b : Nat) : b = b := cheat b

/-- A convenient computation tactic introduces an axiom outside the allowlist. -/
theorem native_decide_ref : (List.range 3).length = 3 := by
  native_decide

/-- A declaration that exists but is not a theorem. -/
def helperValue (b : Nat) : Nat := b

/-- A real theorem used to isolate the witness audit. -/
theorem guarded_true (b : Nat) (h : b = b) : b = b := h

/-- A real theorem whose type differs from the recorded statement. -/
theorem identity_true (b : Nat) : b = b := rfl

end Formal
