import Lean
import Model

namespace Formal

/-- Canonical decimal grammar `^(0|[1-9][0-9]*)$` (design section 15). -/
def canonicalNat? (value : Lean.Json) : Option Nat :=
  match value with
  | .str text =>
    if text.isEmpty then none
    else if !text.toList.all (fun char => char.isDigit) then none
    else if text.startsWith "0" && text.length != 1 then none
    else text.toNat?
  | _ => none

/-- Pure JSON boundary for the domain-specific reference model. -/
def reference (input : Lean.Json) : Except String Lean.Json :=
  match input.getObj? with
  | .error _ => .error "invalid-amount"
  | .ok fields =>
    if fields.size != 3 then .error "invalid-amount"
    else
      let decode (name : String) : Except String Nat :=
        match fields.get? name with
        | none => .error "invalid-amount"
        | some value =>
          match canonicalNat? value with
          | some number => .ok number
          | none => .error "invalid-amount"
      match decode "budget", decode "reserved", decode "amount" with
      | .ok budget, .ok reserved, .ok amount =>
        match reserve budget reserved amount with
        | .ok value => .ok (.str (toString value))
        | .error code => .error code
      | _, _, _ => .error "invalid-amount"

end Formal
