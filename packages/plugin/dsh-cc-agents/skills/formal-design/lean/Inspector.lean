/-
  Shipped trusted inspector (design sections 6 and 8).

  Reads `inspector-inputs.json` (the property list of `checks.json`) from argv,
  elaborates every recorded `statement` as a closed term of type `Prop` in the
  environment produced by `import Properties`, requires definitional equality
  without added proof hypotheses with the declared theorem's elaborated type,
  records the Lean declaration kind, and audits the transitive axioms of each
  required constant. Writes exactly one strict JSON report object to
  `inspector-report.json`.

  Axioms are collected with `Lean.collectAxioms` applied to each required
  constant only. The Lean prelude itself contains `sorryAx` and unsafe `lc*`
  axioms, so an indiscriminate scan of every imported declaration would reject
  every proof.

  The trusted environment is rebuilt at run time from the freshly compiled
  `Properties` module in the workspace search path: `main` runs in `IO`, where
  the module's elaboration environment is no longer reachable, so the report is
  produced from `importModules` of exactly that module.
-/
import Lean
import Lean.Elab.Term
import Lean.Util.CollectAxioms
import Properties

open Lean
open Lean.Elab.Term

namespace Inspector

/-- Fixed axiom allowlist (design section 6). Never extended by a manifest. -/
def allowedAxioms : Array Name := #[``propext, ``Classical.choice, ``Quot.sound]

def reportPath : System.FilePath := "inspector-report.json"

structure Input where
  id : String
  declaration : String
  statement : String
  witness : Option String
  deriving Inhabited

structure WitnessReport where
  declaration : String
  kind : Option String
  type : Option String
  verdict : String
  deriving Inhabited

structure PropertyReport where
  id : String
  declaration : String
  kind : Option String
  statementType : Option String
  theoremType : Option String
  typesMatch : Option Bool
  axioms : Option (Array String)
  witness : Option WitnessReport
  verdict : String
  deriving Inhabited

/-! ## JSON encoding -/

def optStrJson : Option String → Json
  | some s => .str s
  | none => .null

def optBoolJson : Option Bool → Json
  | some b => .bool b
  | none => .null

def optStrsJson : Option (Array String) → Json
  | some xs => .arr (xs.map Json.str)
  | none => .null

def WitnessReport.toJson (w : WitnessReport) : Json :=
  Json.mkObj [
    ("declaration", .str w.declaration),
    ("kind", optStrJson w.kind),
    ("type", optStrJson w.type),
    ("verdict", .str w.verdict)
  ]

/-- Exactly the fields of the inspector report (design section 8). -/
def PropertyReport.toJson (r : PropertyReport) : Json :=
  Json.mkObj [
    ("id", .str r.id),
    ("declaration", .str r.declaration),
    ("kind", optStrJson r.kind),
    ("statementType", optStrJson r.statementType),
    ("theoremType", optStrJson r.theoremType),
    ("typesMatch", optBoolJson r.typesMatch),
    ("axioms", optStrsJson r.axioms),
    ("witness", match r.witness with | some w => w.toJson | none => .null),
    ("verdict", .str r.verdict)
  ]

def witnessJson : Option WitnessReport → Json
  | some w => w.toJson
  | none => .null

def reportJson (reports : Array PropertyReport) : Json :=
  Json.mkObj [
    ("schemaVersion", .num 1),
    ("properties", .arr (reports.map PropertyReport.toJson)),
    ("toolchainVersion", .str Lean.versionString)
  ]

/-! ## Input decoding -/

def getStr (j : Json) (field : String) : Except String String :=
  match j.getObjVal? field with
  | .ok (.str s) => .ok s
  | .ok _ => .error s!"field '{field}' must be a string"
  | .error e => .error e

def getOptionalStr (j : Json) (field : String) : Except String (Option String) :=
  match j.getObjVal? field with
  | .ok .null => .ok none
  | .ok (.str s) => .ok (some s)
  | .ok _ => .error s!"field '{field}' must be a string or null"
  | .error e => .error e

def decodeInput (j : Json) : Except String Input := do
  let id ← getStr j "id"
  let declaration ← getStr j "declaration"
  let statement ← getStr j "statement"
  let witness ← getOptionalStr j "witnessDeclaration"
  return { id, declaration, statement, witness }

/-- `{ "schemaVersion": 1, "properties": [...] }`, the property list of
`checks.json` as written by the runner. -/
def decodeDocument (j : Json) : Except String (Array Input) := do
  match j.getObjVal? "schemaVersion" with
  | .ok (.num 1) => pure ()
  | .ok _ => throw "schemaVersion must be 1"
  | .error e => throw e
  match j.getObjVal? "properties" with
  | .ok (.arr items) => items.mapM decodeInput
  | .ok _ => throw "properties must be an array"
  | .error e => throw e

/-! ## Environment and elaboration -/

/-- The environment produced by `import Properties`, loaded from the workspace
search path into this process. Loading environment extensions requires the
initializer-execution flag that the frontend sets at startup. -/
unsafe def loadEnvironment : IO Environment := do
  enableInitializersExecution
  importModules #[{ module := `Properties }] {} (loadExts := true)

/-- Run a `TermElabM` action in the given environment, returning its message log.

Elaboration reports failures in the log and may still return an error-recovery
term (`sorryAx`), so callers must inspect the log instead of trusting the value. -/
def runTermElab (env : Environment) (act : TermElabM α) : IO (α × MessageLog) := do
  let coreCtx : Core.Context := { fileName := "<inspector>", fileMap := default }
  let coreState : Core.State := { env := env }
  let (result, core, _meta, _term) ← TermElabM.toIO act coreCtx coreState {} {} {} {}
  return (result, core.messages)

def runTermElabValue (env : Environment) (act : TermElabM α) : IO α :=
  return (← runTermElab env act).1

def messageText (log : MessageLog) : IO String :=
  return String.intercalate "; " (← log.toList.mapM (fun message => message.data.toString))

def qualifiedName (s : String) : Name :=
  s.splitOn "." |>.foldl (fun acc part => acc.str part) .anonymous

def kindOf : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .thmInfo _ => "theorem"
  | .defnInfo _ => "definition"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quotient"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "constructor"
  | .recInfo _ => "recursor"

/-- Elaborate one statement as a closed term of type `Prop`. Elaboration runs in
the `Properties` environment with no section variables, so every identifier
outside the prelude must be fully qualified. -/
def elaborateStatement (env : Environment) (statement : String) : IO (Except String Expr) := do
  match Parser.runParserCategory env `term statement "<statement>" with
  | .error e => return .error e
  | .ok stx =>
    try
      let (expr, log) ← runTermElab env do
        let expr ← Elab.Term.elabTermEnsuringType stx (some (.sort .zero))
        Elab.Term.synthesizeSyntheticMVarsNoPostponing
        let expr ← instantiateMVars expr
        if expr.hasMVar then throwError "statement elaboration left metavariables"
        if expr.hasSorry then throwError "statement elaboration produced a synthetic sorry"
        if !(← Meta.isProp expr) then throwError "statement is not a Prop"
        return expr
      if log.hasErrors then return .error (← messageText log)
      return .ok expr
    catch e => return .error (toString e)

def prettyExpr (env : Environment) (expr : Expr) : IO (Option String) :=
  try
    let format ← runTermElabValue env (Lean.Meta.ppExpr expr)
    return some (Format.pretty format)
  catch _ => return none

/-- Definitional equality of the elaborated statement and the theorem type. -/
def definitionalEquality (env : Environment) (statement theoremType : Expr) : IO (Option Bool) :=
  try
    let (result, log) ← runTermElab env (Lean.Meta.isDefEq statement theoremType)
    if log.hasErrors then return none
    return some result
  catch _ => return none

def collectAxiomNames (env : Environment) (name : Name) : IO (Option (Array String)) :=
  try return some ((← runTermElabValue env (Lean.collectAxioms name)).map (·.toString))
  catch _ => return none

def axiomsAllowed (axioms : Array String) : Bool :=
  axioms.toList.all (fun name => allowedAxioms.contains (qualifiedName name))

/-! ## Per-property audit -/

def witnessReport (env : Environment) (declaration : String) : IO WitnessReport := do
  let name := qualifiedName declaration
  let decl := env.find? name
  let axioms ← match decl with
    | some _ => collectAxiomNames env name
    | none => pure none
  let typeText ← match decl with
    | some info => prettyExpr env info.type
    | none => pure none
  let isTheorem := match decl with
    | some info => kindOf info == "theorem"
    | none => false
  let axiomsOk := match axioms with
    | some names => axiomsAllowed names
    | none => false
  return {
    declaration,
    kind := decl.map kindOf,
    type := typeText,
    verdict := if isTheorem && axiomsOk then "verified" else "rejected"
  }

def audit (env : Environment) (input : Input) : IO PropertyReport := do
  let name := qualifiedName input.declaration
  let decl := env.find? name
  let statement ← elaborateStatement env input.statement
  let statementExpr := statement.toOption
  -- `statementType` / `theoremType` are null when the elaborated form could not
  -- be computed; `typesMatch` is null whenever either of them is null.
  let statementType ← match statementExpr with
    | some expr => prettyExpr env expr
    | none => pure none
  let theoremType ← match decl with
    | some info => prettyExpr env info.type
    | none => pure none
  let typesMatch ← match statementExpr, decl with
    | some expr, some info => definitionalEquality env expr info.type
    | _, _ => pure none
  let axioms ← match decl with
    | some _ => collectAxiomNames env name
    | none => pure none
  let witness ← match input.witness with
    | none => pure (none : Option WitnessReport)
    | some declaration => do
      let report ← witnessReport env declaration
      pure (some report)
  let isTheorem := match decl with
    | some info => kindOf info == "theorem"
    | none => false
  let axiomsOk := match axioms with
    | some names => axiomsAllowed names
    | none => false
  let matchOk := match typesMatch with
    | some result => result
    | none => false
  let witnessOk := match witness with
    | some report => report.verdict == "verified"
    | none => true
  let verdict := if isTheorem && axiomsOk && statementExpr.isSome && matchOk && witnessOk then "verified" else "rejected"
  return {
    id := input.id,
    declaration := input.declaration,
    kind := decl.map kindOf,
    statementType,
    theoremType,
    typesMatch,
    axioms,
    witness,
    verdict
  }

unsafe def main (args : List String) : IO UInt32 := do
  let some path := args.head?
    | do
      IO.eprintln "usage: lean --run Inspector.lean <inspector-inputs.json>"
      return 2
  let text ← IO.FS.readFile path
  let document ← match Json.parse text with
    | .ok value => pure value
    | .error message =>
      IO.eprintln s!"inspector: invalid input JSON: {message}"
      return 2
  let inputs ← match decodeDocument document with
    | .ok value => pure value
    | .error message =>
      IO.eprintln s!"inspector: {message}"
      return 2
  let env ← loadEnvironment
  let reports ← inputs.mapM (audit env)
  IO.FS.writeFile reportPath (Json.compress (reportJson reports) ++ "\n")
  return 0

end Inspector

unsafe def main (args : List String) : IO UInt32 := Inspector.main args
