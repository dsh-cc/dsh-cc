import Model

namespace Formal

/-- Pure JSON boundary for the domain-specific reference model. -/
def reference (input : Lean.Json) : Except String Lean.Json :=
  match input with
  | .arr #[budget, reserved, amount] =>
    match budget.getNat?, reserved.getNat?, amount.getNat? with
    | some b, some r, some a =>
      match reserve b r a with
      | .ok value => .ok (.str (toString value))
      | .error code => .error code
    | _, _, _ => .error "invalid-input"
  | _ => .error "invalid-input"

end Formal
