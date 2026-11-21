/-
  Mathlib declaration dumper (design §4.2) — metaprogram compiled once inside
  the environment's wrapper lake project (`lake env lean --run Dumper.lean`).

  Walks the trusted environment produced by `import Mathlib` and emits JSON
  lines to `dumper-output.jsonl` in the working directory:

    * one DECLARATION line per public declaration:
        {"name": "Nat.add_comm", "kind": "theorem", "module": "Mathlib.Algebra.Order.Monoid.Lemmas", "typeText": "∀ ..."}
    * one EDGE line per module:
        {"module": "Mathlib.Algebra.Order.Monoid.Lemmas", "imports": ["Mathlib...", ...]}

  The index (`mathlib-index.mjs`) needs BOTH shapes: the edges power the
  corrected reachability direction of `mathlib-search.mjs --imports`
  (declarations reachable through the transitive import closure of a file's
  OWN import set; r2 finding 5). Modeled on formal-design's `Inspector.lean`:
  the environment is rebuilt at run time via `importModules` exactly as the
  Inspector does, since `main` runs in `IO` where the command-elaboration
  environment is no longer reachable.
-/
import Lean
import Mathlib

open Lean

namespace Dumper

def outputPath : System.FilePath := "dumper-output.jsonl"

def qualifiedKind : ConstantInfo → String
  | .axiomInfo _ => "axiom"
  | .thmInfo _ => "theorem"
  | .defnInfo _ => "def"
  | .opaqueInfo _ => "opaque"
  | .quotInfo _ => "quotient"
  | .inductInfo _ => "inductive"
  | .ctorInfo _ => "ctor"
  | .recInfo _ => "recursor"

/-- Only public, user-facing declarations: internal compiler names and
private-name-mangled constants are not retrievable premises. -/
def publicDeclaration (name : Name) : Bool :=
  !name.isInternal && !isPrivateName name && !name.hasMacroScopes

/-- Module of a declaration via its `ModuleIdx`, or none for the dumper's own
synthetic module (its declarations are excluded anyway). -/
def moduleOf (env : Environment) (name : Name) : Option Name := do
  let idx ← env.getModuleIdxFor? name
  env.header.moduleNames.get? idx.toNat

def declLine (env : Environment) (name : Name) (info : ConstantInfo) : CoreM Json := do
  let typeFormat ← Lean.Meta.ppExpr info.type
  let moduleName := (moduleOf env name).map (·.toString) |>.getD "<unknown>"
  return Json.mkObj [
    ("name", .str name.toString),
    ("kind", .str (qualifiedKind info)),
    ("module", .str moduleName),
    ("typeText", .str (Format.pretty typeFormat))
  ]

/-- Direct import edges of ONE module, read from its own olean's module data:
the `importer` is the module whose source contains the import statement. -/
def edgeLine (module : Name) (imports : Array Lean.Import) : Json :=
  Json.mkObj [
    ("module", .str module.toString),
    ("imports", .arr (imports.map fun imp => .str imp.module.toString))
  ]

/-- The environment produced by `import Mathlib`, loaded from the wrapper
project's search path (Inspector.lean pattern, initializer flag included). -/
unsafe def loadEnvironment : IO Environment := do
  enableInitializersExecution
  importModules #[{ module := `Mathlib }] {} (loadExts := true)

unsafe def dump : IO Unit := do
  let env ← loadEnvironment
  let out ← IO.FS.Handle.mk outputPath .write
  -- Declaration lines over the imported environment (map₂: imported modules'.
  -- constants; the dumper module itself contributes nothing public).
  let coreCtx : Core.Context := { fileName := "<dumper>", fileMap := default }
  let coreState : Core.State := { env := env }
  let (lines, _state) ← Core.CoreM.toIO (ctx := coreCtx) (s := coreState) do
    let mut lines : Array Json := #[]
    for (name, info) in env.constants.map₂.toList do
      if publicDeclaration name then
        lines := lines.push (← declLine env name info)
    return lines
  for line in lines do
    out.putStrLn (Json.compress line)
  -- Edge lines for every transitively imported module.
  for module in env.header.moduleNames do
    try
      let olean ← findOLean module
      let (data, _region) ← readModuleData olean
      out.putStrLn (Json.compress (edgeLine module data.imports))
    catch _ =>
      pure () -- a module without a readable olean contributes declarations only

unsafe def main : IO UInt32 := do
  dump
  return 0

end Dumper

unsafe def main : IO Unit := do
  _ ← Dumper.main
