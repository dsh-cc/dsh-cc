/-
  Binding inspector (design §4.1, §4.4) — metaprogram run inside the attempt's
  own build directory (per-attempt isolation, §4.2), where the staged module
  `Attempt` (statement.lean or proof.lean) was just compiled.

  Modes (`inspector-inputs.json`, written by lean-run.mjs):

    * statement — after statement-check: record the declaration kind and the
      elaborated type of `statementDeclName` (the statement file elaborates
      with `sorry`, which this mode's caller tolerates; the Inspector itself
      only INSPECTS the elaborated environment).
    * binding — after the proof build: check that `proofDeclName` exists and
      is a theorem, elaborate the RECORDED `statementTypeText` as a closed
      term of type `Prop`, require definitional equality (term-level
      `Lean.Meta.isDefEq` of the two exact elaborated propositions — string
      comparison is never used), and audit the transitive axioms of
      `proofDeclName` against the fixed allowlist {propext, Classical.choice,
      Quot.sound}. The audit is scoped to that constant only: the prelude and
      unrelated elaborations carry `sorryAx`/unsafe axioms, so an
      indiscriminate scan would reject every proof (Inspector pattern).

  Writes exactly one strict JSON object to `inspector-report.json`.
  Modeled on formal-design's `Inspector.lean`.
-/
import Lean
import Lean.Elab.Term
import Lean.Util.CollectAxioms

open Lean
open Lean.Elab.Term

namespace BindingInspector

/-- Fixed axiom allowlist (design §4.4). Never extended by a manifest. -/
def allowedAxioms : Array Name := #[``propext, ``Classical.choice, ``Quot.sound]

def reportPath : System.FilePath := "inspector-report.json"

structure Input where
  mode : String
  statementDeclName : String
  statementTypeText : Option String
  proofDeclName : Option String
  deriving Inhabited

structure DeclReport where
  declaration : String
  kind : Option String
  type : Option String
  deriving Inhabited

def optStrJson : Option String → Json
  | some s => .str s
  | none => .null

def DeclReport.toJson (r : DeclReport) : Json :=
  Json.mkObj [
    ("declaration", .str r.declaration),
    ("kind", optStrJson r.kind),
    ("type", optStrJson r.type)
  ]

def reportJson (statement : DeclReport) (proof : Option DeclReport)
    (typesMatch : Option Bool) (axioms : Option (Array String)) : Json :=
  Json.mkObj [
    ("schemaVersion", .num 1),
    ("statement", statement.toJson),
    ("proof", match proof with | some p => p.toJson | none => .null),
    ("typesMatch", match typesMatch with | some b => .bool b | none => .null),
    ("axioms", match axioms with | some xs => .arr (xs.map Json.str) | none => .null),
    ("toolchainVersion", .str Lean.versionString)
  ]

/-! ## Input decoding (strict, like formal-design's inspector) -/

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
  | .error _ => .ok none

def decodeInput (j : Json) : Except String Input := do
  match j.getObjVal? "schemaVersion" with
  | .ok (.num 1) => pure ()
  | _ => throw "schemaVersion must be 1"
  return {
    mode := (← getStr j "mode"),
    statementDeclName := (← getStr j "statementDeclName"),
    statementTypeText := (← getOptionalStr j "statementTypeText"),
    proofDeclName := (← getOptionalStr j "proofDeclName")
  }

/-! ## Environment and elaboration (formal-design Inspector pattern) -/

/-- The environment produced by the staged `Attempt` module, loaded from the
attempt build directory's search path. -/
unsafe def loadEnvironment : IO Environment := do
  enableInitializersExecution
  importModules #[{ module := `Attempt }] {} (loadExts := true)

def runTermElab (env : Environment) (act : TermElabM α) : IO (α × MessageLog) := do
  let coreCtx : Core.Context := { fileName := "<binding-inspector>", fileMap := default }
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

def prettyExpr (env : Environment) (expr : Expr) : IO (Option String) :=
  try
    let format ← runTermElabValue env (Lean.Meta.ppExpr expr)
    return some (Format.pretty format)
  catch _ => return none

/-- Declaration existence, kind and elaborated type — the record consumed by
lean-run.mjs for both modes. -/
def declReport (env : Environment) (declaration : String) : IO DeclReport := do
  let name := qualifiedName declaration
  match env.find? name with
  | none => return { declaration, kind := none, type := none }
  | some info => return { declaration, kind := some (kindOf info), type := (← prettyExpr env info.type) }

/-- Elaborate the RECORDED statement type text as a closed term of type
`Prop`. This is the re-elaborated proposition compared against the proof
declaration's type by definitional equality. -/
def elaboratePropText (env : Environment) (text : String) : IO (Except String Expr) := do
  match Parser.runParserCategory env `term text "<statementTypeText>" with
  | .error e => return .error e
  | .ok stx =>
    try
      let (expr, log) ← runTermElab env do
        let expr ← Elab.Term.elabTermEnsuringType stx (some (.sort .zero))
        Elab.Term.synthesizeSyntheticMVarsNoPostponing
        let expr ← instantiateMVars expr
        if expr.hasMVar then throwError "statement type elaboration left metavariables"
        if !(← Meta.isProp expr) then throwError "statement type is not a Prop"
        return expr
      if log.hasErrors then return .error (← messageText log)
      return .ok expr
    catch e => return .error (toString e)

/-- Definitional equality of the two EXACT elaborated propositions. -/
def definitionalEquality (env : Environment) (statement theoremType : Expr) : IO (Option Bool) :=
  try
    let (result, log) ← runTermElab env (Lean.Meta.isDefEq statement theoremType)
    if log.hasErrors then return none
    return some result
  catch _ => return none

/-- Scoped axiom audit of the proof constant only — never the whole
environment (the audit scope IS the soundness boundary). -/
def collectAxiomNames (env : Environment) (name : Name) : IO (Option (Array String)) :=
  try return some ((← runTermElabValue env (Lean.collectAxioms name)).map (·.toString))
  catch _ => return none

/-! ## Modes -/

def auditStatement (env : Environment) (input : Input) : IO Json := do
  let statement ← declReport env input.statementDeclName
  return reportJson statement none none none

def auditBinding (env : Environment) (input : Input) : IO Json := do
  let some proofDeclName := input.proofDeclName
    | do
      IO.eprintln "binding mode requires proofDeclName"
      return reportJson { declaration := input.statementDeclName, kind := none, type := none } none none none
  let proofReport ← declReport env proofDeclName
  let typesMatch ← match input.statementTypeText with
    | none => pure none
    | some text => do
      match (← elaboratePropText env text) with
      | .error _ => pure none
      | .ok proposition =>
        match env.find? (qualifiedName proofDeclName) with
        | none => pure none
        | some info => definitionalEquality env proposition info.type
  let axioms ← match env.find? (qualifiedName proofDeclName) with
    | none => pure none
    | some _ => collectAxiomNames env (qualifiedName proofDeclName)
  let statementReport : DeclReport := {
    declaration := input.statementDeclName
    kind := some "theorem" -- recorded by statement-check; presence here is lineage
    type := input.statementTypeText
  }
  return reportJson statementReport (some proofReport) typesMatch axioms

unsafe def main (args : List String) : IO UInt32 := do
  let some path := args.head?
    | do
      IO.eprintln "usage: lean --run Inspector.lean <inspector-inputs.json>"
      return 2
  let text ← IO.FS.readFile path
  let document ← match Json.parse text with
    | .ok value => pure value
    | .error message =>
      IO.eprintln s!"binding inspector: invalid input JSON: {message}"
      return 2
  let input ← match decodeInput document with
    | .ok value => pure value
    | .error message =>
      IO.eprintln s!"binding inspector: {message}"
      return 2
  let env ← loadEnvironment
  let report ← match input.mode with
    | "statement" => auditStatement env input
    | "binding" => auditBinding env input
    | other => do
      IO.eprintln s!"binding inspector: unknown mode {other}"
      return 2
  IO.FS.writeFile reportPath (Json.compress report ++ "\n")
  return 0

end BindingInspector

unsafe def main (args : List String) : IO UInt32 := BindingInspector.main args
