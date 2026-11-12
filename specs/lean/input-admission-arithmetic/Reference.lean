import Lean
import Model

namespace Formal

/-- Pure JSON boundary: decode {class, bytes, budget, used, now, lastAdmitted,
window} and answer the four arithmetic decisions the gate takes. -/
def reference (input : Lean.Json) : Except String Lean.Json :=
  match input.getObj? with
  | .error _ => .error "invalid-input"
  | .ok fields =>
    let natOf (name : String) : Except String Nat :=
      match fields.get? name with
      | some (.str text) =>
        if text.isEmpty || !text.toList.all (fun c => c.isDigit) then .error "invalid-input"
        else match text.toNat? with
             | some n => .ok n
             | none => .error "invalid-input"
      | _ => .error "invalid-input"
    let classOf : Except String Class :=
      match fields.get? "class" with
      | some (.str "governance") => .ok .governance
      | some (.str "task") => .ok .task
      | some (.str "memory") => .ok .memory
      | some (.str "advisory") => .ok .advisory
      | some (.str "passthrough") => .ok .passthrough
      | _ => .error "invalid-input"
    match classOf, natOf "budget", natOf "used", natOf "bytes",
          natOf "now", natOf "lastAdmitted", natOf "window" with
    | .ok cls, .ok budget, .ok used, .ok bytes, .ok now, .ok last, .ok window =>
      .ok (.mkObj [
        ("charged", .str (toString (charged cls bytes))),
        ("fits", .bool (fits budget used bytes)),
        ("oversize", .bool (oversize budget bytes)),
        ("suppressed", .bool (withinWindow now last window)),
      ])
    | _, _, _, _, _, _, _ => .error "invalid-input"

end Formal
