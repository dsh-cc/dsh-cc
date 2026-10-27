/-
  Shipped trusted conformance driver (design section 7).

  Reads JSON lines `{ "id": ..., "input": ... }` from stdin until EOF, calls the
  project's `Formal.reference` in the freshly compiled `Reference` module, and
  writes exactly one JSON line `{ "id": ..., "result": ... }` per input, in
  order, where `result` is either `{"ok": <Lean.Json>}` or
  `{"error": {"code": "..."}}`.

  Reference `Except.error` strings become protocol error codes and must match
  `[a-z][a-z0-9-]{0,63}`; an invalid code, a malformed line, or an unknown field
  is a protocol error. Diagnostics go to stderr and the process exits nonzero;
  exception text is never compared.
-/
import Lean
import Reference

open Lean

namespace Driver

/-- Error-code grammar (design section 7). -/
def validErrorCode (code : String) : Bool :=
  let chars := code.toList
  match chars with
  | [] => false
  | first :: rest =>
    first.isLower && first.isAlpha && rest.length <= 63
      && rest.all (fun char => char.isLower || char.isDigit || char == '-')

def protocolError (message : String) : IO UInt32 := do
  IO.eprintln s!"driver: protocol error: {message}"
  return 1

structure Input where
  id : String
  input : Json

def decodeLine (line : String) : Except String Input := do
  let value ← Json.parse line
  let fields ← value.getObj?
  if fields.size != 2 then throw s!"line must contain exactly id and input, found {fields.size} field(s)"
  let id ← match fields.get? "id" with
    | some (.str id) => pure id
    | some _ => throw "id must be a string"
    | none => throw "missing id"
  let input ← match fields.get? "input" with
    | some input => pure input
    | none => throw "missing input"
  return { id, input }

def encodeResult (id : String) (result : Json) : String :=
  Json.compress (Json.mkObj [("id", .str id), ("result", result)])

/-- One protocol line: `{"ok": ...}` or `{"error": {"code": ...}}`. -/
def encodeOk (value : Json) : Json := Json.mkObj [("ok", value)]

def encodeError (code : String) : Json := Json.mkObj [("error", Json.mkObj [("code", .str code)])]

def run : IO UInt32 := do
  let stdin ← IO.getStdin
  let text ← stdin.readToEnd
  let mut lines := text.splitOn "\n"
  -- A trailing newline terminates the last line; it does not add an empty one.
  if lines.length > 0 && lines.getLast! == "" then lines := lines.dropLast
  let mut output : Array String := #[]
  let mut position := 0
  for line in lines do
    position := position + 1
    if line.isEmpty then return (← protocolError s!"blank line at position {position}")
    let input ← match decodeLine line with
      | .ok input => pure input
      | .error message => return (← protocolError s!"line {position}: {message}")
    match Formal.reference input.input with
    | .ok value => output := output.push (encodeResult input.id (encodeOk value))
    | .error code =>
      if !validErrorCode code then return (← protocolError s!"line {position}: invalid error code {repr code}")
      output := output.push (encodeResult input.id (encodeError code))
  let stdout ← IO.getStdout
  for line in output do
    stdout.putStr (line ++ "\n")
  stdout.flush
  return 0

end Driver

def main : IO UInt32 := Driver.run
