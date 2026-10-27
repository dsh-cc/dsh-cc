# Lean verification for the formal-design skill

Status: Proposed implementation specification. This document adds a complete Lean
path to the existing skill. It does not claim that the path is already implemented.

Baseline: `836487abfda9808f81faff713fc2422827245f00` on `main`.

## 1. Problem and intended outcome

The current `formal-design` skill verifies bounded TLA+ models of protocols and
state machines. Its screening rules cover asynchronous ownership, retries,
timeouts, recovery, and shared-state ordering. Deterministic computation does not
trigger verification by default. This leaves important business rules outside
its normal scope: permission composition, configuration precedence, budget
arithmetic, selection constraints, and deterministic data transformations.

Tests sample behavior. TLC explores a specified finite state space. Neither
mechanism, as currently integrated, proves an algebraic property for every input
represented by an unbounded mathematical type. Lean can supply that evidence.
However, proving a separately written Lean model does not prove the repository's
TypeScript implementation correct. The new path must expose this boundary and
supply implementation conformance checks.

| Problem | Required solution | Acceptance evidence |
| --- | --- | --- |
| Deterministic rules escape screening | Add risk-based Lean triggers to the same skill | Screening records and session acceptance cases |
| Sample tests miss general rule violations | Prove named properties over explicit domains | Checked declarations, exact proposition types, axiom reports |
| A successful build can contain incomplete proofs | Audit theorem existence, declaration kind, and transitive axioms | Structured audit from a shipped inspector |
| The model can reproduce a production bug | Separate requirement statements from extracted behavior | Reviewed requirements and independent negative examples |
| Correct model, incorrect implementation | Execute one reference model and compare production results | Reproducible differential tests and explicit source bindings |
| TLA+ and Lean can disagree about one operation | Record and test their shared operation contract | Explicit bridge rows and bounded bridge fixtures |
| Cached or stale results can be mistaken for proof | Clean isolated runs and digest-bound evidence | Full logs, tool identity, source and execution digests |
| An agent may weaken a property to pass | Preserve existing review and change rules | Semantic diffs and new approval when required |

The deliverable is an optional verification capability inside `formal-design`.
It introduces no agent type, model alias, startup dependency, runtime gate, or
new reviewer lane. Existing effective project rules remain authoritative.

## 2. Scope and assurance boundary

The initial supported target is a deterministic pure function with a finite JSON
input/output representation and properties expressible in Lean using its bundled
standard libraries. The proof domain may be infinite, such as `Nat` or lists.
The executable comparison corpus is always finite.

Version one supports Linux x86-64 and macOS arm64 with Node versions already
supported by the repository. Unsupported platforms fail preflight explicitly.
Lean is a separately provisioned development tool. Do not bundle it in the npm
package, install it at startup, or download it from a check command.

Out of scope: automatic TypeScript-to-Lean translation; formal equivalence proofs
between arbitrary TypeScript and Lean; verified TypeScript code generation;
Mathlib and third-party Lean packages; proving I/O or FFI implementations;
universal automatic proof search; security isolation for hostile project code;
and a machine-checked composition proof between TLA+ and Lean.

A Lean result means that specified declarations have kernel-checked proofs under
the recorded assumptions and permitted axioms. Conformance means that a finite
recorded corpus matched the reference implementation. Neither result establishes
whole-program or deployment correctness.

## 3. Relationship to TLA+

Keep the existing TLC runner, manifest version, CLI, artifact paths, output
vocabulary, and verdict unchanged for TLA-only use. Add Lean-specific commands
and schemas beside it. Do not add backend branches to the TLC parser or
reinterpret old evidence. The only permitted TLC runner change is the opt-in
`--bridge` flag and the version-two evidence schema from section 10, which
preserve version-one behavior entirely when the flag is absent.

| Behavior under review | Selection | Required work |
| --- | --- | --- |
| Event ordering, cancellation, retries, ownership, recovery | `tla` | Existing bounded TLC workflow |
| High-impact deterministic rules or algorithms | `lean` | Proof workflow, followed by implementation conformance |
| Both kinds of behavior | `both` | Both workflows plus shared operation contracts |
| Formatting, layout, ordinary low-risk glue | `none` | Normal project workflow |

These are engineering selection rules, not language expressiveness limits.
Lean can model transition systems, and TLA+ can specify arithmetic.

Retain FD-T1 through FD-T4. Add these trigger IDs:

- FD-L1: permission, policy, eligibility, or configuration composition with a
  stated invariant whose violation changes authorization or effective behavior.
- FD-L2: budget, quota, allocation, accounting, or ranking arithmetic with a
  stated conservation, bound, monotonicity, or ordering requirement.
- FD-L3: a deterministic transformation or algorithm with a requested general
  correctness property, or a previously verified Lean contract that changes.
- FD-L4: an explicit user request for Lean verification.

Mere determinism does not trigger Lean. A trigger record must identify the
business property and the consequence of violating it. Explicit scoped user
instructions and existing waiver/conflict rules retain priority.

Keep the existing Formal design fields. Add `backends` (ordered subset of
`["tla", "lean"]`) and `modelDirs` (object with exactly the selected backend
keys). For a legacy TLA-only record, retain `modelDir` and infer `backends=["tla"]`.
New records also write `modelDir` for TLA-only compatibility; omit it otherwise.
For `not-needed` or `waived`, record selected scope and rationale without claiming
successful verification. No runner reads Markdown to authorize execution.

When both backends apply, one requirement ID can have several proof obligations.
Passing one backend never substitutes for a missing or failing obligation in the
other. Do not silently select a cheaper backend after failure or tool absence.

## 4. File layout and ownership

All paths below are relative to the repository root. Add the following files:

```text
packages/plugin/dsh-cc-agents/skills/formal-design/
  references/lean-modeling-guide.md
  references/lean-conformance.md
  references/combined-models.md
  scripts/lean-preflight.mjs
  scripts/lean-check.mjs
  scripts/lean-check-conformance.mjs
  scripts/lean-check-evidence.mjs
  scripts/lean-provision.mjs
  scripts/lean-manifest.lib.mjs
  scripts/lean-fingerprint.lib.mjs
  scripts/lean-process.lib.mjs
  scripts/lean-evidence.lib.mjs
  scripts/check-combined-evidence.mjs
  scripts/lean-toolchain.json
  lean/Inspector.lean
  lean/Driver.lean
packages/plugin/dsh-cc-agents/tests/
  formal-design-lean.spec.ts
  formal-design-lean-integration.spec.ts
  formal-design-lean-conformance.spec.ts
  fixtures/formal-design-lean/...
```

All paths in this document are repository-root-relative. Short forms in the
section 11 table are relative to `packages/plugin/dsh-cc-agents/`. The worked
example from section 15 ships as the committed model
`specs/lean/budget-reservation`; no duplicate copy lives under the skill
directory.

A project model has this exact layout:

```text
specs/lean/<model-id>/
  design.md
  checks.json
  Model.lean
  Properties.lean
  Reference.lean
  conformance/
    adapter.mjs
    cases.jsonl
  implementation.md
  evidence.json                 # generated current proof evidence
  current-run.json              # generated current proof pointer
  conformance-evidence.json      # generated current conformance evidence
```

`<model-id>` uses the existing ID grammar. Do not permit arbitrary entry paths,
extra local Lean modules, Lake configuration, local `.olean` files, or dependency
packages in this first version. `Properties.lean` imports `Model`; `Reference.lean`
imports `Model`. `Model.lean` may import bundled Lean libraries only.
The shipped `Driver` and `Inspector` are trusted runner inputs, never project
replacement files. The driver imports `Reference` and calls `Formal.reference`.
The inspector imports `Properties` and obtains the listed declarations from the
elaborated environment. It does not parse success messages from project stdout.

The main dialog owns requirements, models, property scope, and finding
resolution. Executors implement approved semantics and conformance adapters.
Existing review identities and approval thresholds do not change.

Keep generated artifacts under `.formal-design/lean/<model-id>/<run-id>/`.
Extend the existing explicit `.gitignore` adoption instruction to also ignore
`specs/**/conformance-evidence.json`. A runner must not
edit `.gitignore`, source files, project rules, or configuration. Persist only
current evidence/pointers under the model directory. Commit source inputs and
corpus files; treat generated current evidence like the existing TLC evidence.

## 5. Lean manifest: exact version-one contract

The Lean `checks.json` is a separate strict schema, not an extension of the TLC
schema. Reject unknown fields, duplicate decoded JSON keys, duplicate IDs,
absolute paths, traversal, symlinks, nonregular input files, and invalid UTF-8.
Use these exact fields:

```json
{
  "schemaVersion": 1,
  "backend": "lean",
  "modelId": "budget-reservation",
  "properties": [
    {
      "id": "budget-bound",
      "requirementId": "REQ-1",
      "declaration": "Formal.reserve_preserves_bound",
      "statement": "forall b r a : Nat, r <= b -> a <= b - r -> r + a <= b",
      "witnessDeclaration": "Formal.admissible_example"
    }
  ],
  "conformance": {
    "adapter": "conformance/adapter.mjs",
    "corpus": "conformance/cases.jsonl",
    "implementationFiles": ["packages/example/src/budget.ts"],
    "executionFiles": ["package.json", "pnpm-lock.yaml", "tsconfig.base.json"],
    "command": ["node", "conformance/adapter.mjs"],
    "comparison": "canonical-json"
  },
  "limits": {
    "proofTimeoutMs": 120000,
    "conformanceTimeoutMs": 120000,
    "maxHeartbeats": 2000000,
    "maxRecDepth": 2048,
    "maxCases": 10000
  }
}
```

The example implementation path is illustrative. The shipped worked example
must bind a real fixture implementation, not a nonexistent project module.

Validation rules:

- `properties`: 1..64 entries. IDs use the existing ID grammar. Requirement IDs
  match `REQ-[1-9][0-9]*`. Declarations are dot-separated ASCII Lean identifiers,
  each segment matching `[A-Za-z_][A-Za-z0-9_]*`; quoted names are unsupported.
- `statement`: 1..16384 UTF-8 bytes. It is a Lean proposition expression,
  elaborated as a closed term of type `Prop` in the environment produced by
  `import Properties` (which transitively imports `Model`). Every identifier
  referring to a declaration outside the Lean prelude must be fully qualified;
  unqualified names are legal only for prelude names. It must not be a command,
  declaration, or source-file fragment.
- `witnessDeclaration`: null when the recorded statement contains no
  top-level implication arrow (`->` or `→`); otherwise a qualified theorem name
  proving an explicit, nonempty instance of the precondition domain. The
  top-level arrow test is a conservative syntactic rule enforced at preflight:
  it scans the matrix of the statement, so a leading `forall`/`∀` telescope
  does not hide `->`/`→` in the matrix, and a null witness on such a form is a
  `config-invalid` block. The
  machine checks only that a non-null witness exists, is a theorem, and has a
  stored proof; conditionality hidden behind a definition, and whether the
  witness actually addresses the preconditions, remain review findings. The
  inspector records its exact type and audits it like a required property.
- `implementationFiles`: nonempty unique project-relative regular source paths.
  Existence is validated at conformance preflight only; proof preflight and
  proof checks accept paths that do not exist yet and record the declared
  bindings as planned (section 9).
  Include all behavior-bearing transitive project dependencies used by the
  adapter. `executionFiles` is a unique array of additional project-relative
  files, including build scripts, runtime loaders, and lockfiles affecting it.
  Review must confirm closure completeness; the runner cannot infer arbitrary
  dynamic JavaScript imports. Duplicate paths across the two arrays are invalid.
- Adapter and corpus paths must equal the fixed paths shown above. `command`
  must equal `["node", "conformance/adapter.mjs"]`; it is not a shell command.
  Imported loaders and compilation steps must be in the committed adapter and
  declared execution closure. No runner-provided shell evaluation is allowed.
- `comparison` must be `canonical-json`. The corpus line count must not exceed
  `maxCases`. Proof and conformance timeouts are
  integers in 1000..600000. Heartbeats are integers in 1000..10000000. Recursion
  depth is an integer in 128..4096. `maxCases` is an integer in 1..100000.
- Fixed Lean sources are at most 1 MiB each. All proof inputs total at most
  10 MiB. Corpus size is at most 20 MiB, with at most 64 KiB per line. Bound
  source/execution inputs to 50 MiB total. Reject excess before execution.

Conditional properties need a witness and a design explanation. Do not certify
that a witness mechanically eliminates all vacuity. A reviewer must inspect
quantification, branches, assumptions, and whether the claimed result is useful.

## 6. Toolchain and execution contract

Pin Lean to `leanprover/lean4:v4.35.0` for version one — the release the
`stable` channel resolved to when this document was written, and the version
installed in the development environment. Pinning the moving `stable` label
itself, nightly, or per-model version overrides is not allowed. The
pin-check exists precisely because a developer's locally installed toolchain
can be a different version. `lean-toolchain.json` contains exactly
`schemaVersion`, `toolchain`, `platforms`, and `allowedAxioms`. Set schema version
to 1 and allowed axioms to `["propext", "Classical.choice", "Quot.sound"]`.
`platforms` maps `linux-x64` and `darwin-arm64` to objects containing `archiveUrl`
and the SHA-256 of the corresponding official release archive. Use the following release asset metadata, verified against the official GitHub
release API on October 26, 2026. Provisioning must also hash the downloaded bytes
before extraction; metadata alone is not a successful installation check.

| Platform | Official release asset | SHA-256 |
| --- | --- | --- |
| `linux-x64` | `lean-4.35.0-linux.tar.zst` | `7289597a44543246c9227b8cae501767e095ce17f6d448b95fc4a8dc97268f6d` |
| `darwin-arm64` | `lean-4.35.0-darwin_aarch64.tar.zst` | `c0c6f34f35ba1dcc5c4a5fd106fefab9eb5e8469712624dd2c868d51b63177c2` |

Each archive URL is `https://github.com/leanprover/lean4/releases/download/v4.35.0/`
followed by its exact asset name. Do not infer filenames from operating-system
names. Placeholders or mismatched downloaded bytes block release.

Provision the toolchain explicitly before checks. A shipped provisioning guide
lists official release URLs and hash verification steps. CI performs that step
with pinned metadata. The runner never provisions it. Resolve the direct tool
root using `--lean-root`, then `FORMAL_DESIGN_LEAN_ROOT`; absence is a blocker.
Do not run an elan shim, search PATH, or permit environment-driven fallback.
Read and execute `<root>/bin/lean` directly. In the pinned release,
`--version` prints a long header while `--short-version` prints the bare
version string: verify the pin with `--short-version`, whose trimmed stdout
must equal exactly `4.35.0`.

An administrator provisions a read-only verified installation using the
shipped `scripts/lean-provision.mjs`. The helper downloads the pinned archive,
verifies its SHA-256 against `lean-toolchain.json`, extracts it, and records a
receipt. The content digest is defined exactly: enumerate every regular file
reachable under the installation root by walking `bin/` and `lib/` recursively
plus any top-level shared runtime library; a symlink whose resolved target lies
inside the root is hashed as the target's bytes under the symlink's relative
path (targets outside the root are rejected); model and artifact symlinks
remain forbidden. Sort the resulting `[relativePath, sha256]` pairs by Unicode
code-point comparison of the path; the content digest is the SHA-256 of the
canonical JSON serialization of that sorted array. The receipt is a JSON object
with exactly `schemaVersion`, `toolchain`, `archiveSha256`, and `contentDigest`,
written to the fixed sibling path `<lean-root>.receipt.json` — outside the
hashed installation tree. Preflight locates the receipt at that same path
derived from the resolved `--lean-root`, recomputes the content digest with the
same enumeration, and blocks on a missing receipt, a mismatched
`archiveSha256`, or a mismatched `contentDigest`. CI verifies the release archive
before extraction. This establishes reproducibility, not defense against a host
administrator who can replace both files and receipts.

Use Lean core and bundled standard libraries only. Do not invoke Lake, accept a
project `lakefile`, use local caches, or load third-party packages. Construct
the child environment explicitly: inherit `PATH` and standard locale variables
only, clear `LEAN_SRC_PATH` and every other Lean/tool override variable, and set
`LEAN_PATH` to the absolute path of the fresh per-run workspace. In the pinned
release, `initSearchPath` prepends `LEAN_PATH` entries and always appends
`<sysroot>/lib/lean` (resolved relative to the `lean` binary), so builtin
libraries resolve without further configuration while freshly compiled modules
resolve through the workspace entry. Do not pass any other search-path flag. Set
the working directory to the fresh workspace for Lean phases. Pass argv arrays.

The fixed build sequence is:

1. Acquire the exclusive per-model lock `.formal-design/locks/lean-<modelId>.lock`,
   reusing the existing lock ownership rules; never delete it by age.
2. Snapshot exact input bytes and identity before compiling anything.
3. Copy only the three declared Lean source files and the shipped inspector
   and driver to a new empty workspace. Never copy `.olean`, native libraries,
   generated C, Lake artifacts, or project build output. A preexisting `.olean`,
   `lakefile.*`, or `lake-manifest.json` anywhere in the model directory is a
   `blocked` configuration failure, never `rejected`.
4. Compile `Model.lean`, then `Properties.lean`, then `Reference.lean`, then
   the shipped `Inspector.lean` and `Driver.lean`, each with
   `<root>/bin/lean -o <module>.olean <module>.lean` executed in the fresh
   workspace with `LEAN_PATH` set to the workspace. Pass the manifest limits as
   `-DmaxHeartbeats=<limits.maxHeartbeats> -DmaxRecDepth=<limits.maxRecDepth>`
   and `-D Elab.async=false` in every Lean invocation (command-line elaboration
   otherwise forces async elaboration in the pinned release). The manifest
   heartbeat value is the option value itself, not a post-multiplied count.
   Every `-D` option must precede the input file and, for `--run`
   invocations, precede `--run` itself: option parsing stops at `--run`, so a
   `-D` flag placed after it becomes a script argument and is silently
   ignored.
   Project sources must not contain `set_option maxHeartbeats`,
   `set_option maxRecDepth`, or any `debug.` kernel-bypass option such as
   `debug.skipKernelTC`; reject those by mechanical source scan before
   compilation.
5. Run the shipped inspector in the same workspace. The runner first writes
   `inspector-inputs.json` (the property list from `checks.json`) into the
   workspace, then executes
   `<root>/bin/lean --run Inspector.lean inspector-inputs.json` with the same
   `LEAN_PATH` and `-D` options. The inspector reads the input file, elaborates
   each `statement` as a closed term of type `Prop` in the `Properties`
   environment, and requires definitional equality, without adding proof
   hypotheses, between that expression and the declared theorem's type,
   capturing both fully elaborated types. It writes one JSON report object to
   `inspector-report.json` in the workspace (schema in section 8).
6. Require every named property and witness to be a theorem declaration with
   a stored proof value. Collect axioms with `Lean.collectAxioms` applied to
   each required constant; it walks exactly the constants the recorded proof
   and type depend on. Do not scan all declarations of imported modules — the
   Lean prelude itself contains `sorryAx` and unsafe `lc*` axioms, so an
   indiscriminate scan rejects every proof. Reject any axiom outside the fixed
   allowlist.
7. Require a clean completion of every phase and a complete inspector report.
   Record all warnings. A warning containing an incomplete proof is a failure;
   axiom inspection remains mandatory even if there are no warnings. On
   failure, retain the partial inspector report with every unchecked property
   marked `not-checked`.
8. Hash source inputs again before publishing. Any change marks the run
   `incomplete` with reason `input-changed`; retain the attempted-run logs.
9. Atomically publish evidence and its pointer, then release the lock.

The inspector must use Lean's declaration and expression APIs. Regex scans of
`sorry` or `#print axioms` console text are supplementary diagnostics only.
`admit` and indirect imported `sorryAx` must fail. Reject `Lean.ofReduceBool`,
`Lean.trustCompiler`-style axioms, and any other axiom outside the allowlist, even
if introduced by a convenient computation tactic. Never extend the allowlist
from a project manifest. Use proof-producing tactics compatible with the pin.

Project proof code can execute metaprograms. Treat it as project code with the
same execution trust as a build script, not as sandboxed data. Reject deliberate
kernel-bypass options and unexplained metaprograms in review. The initial claim
assumes honest Lean elaboration and a trusted pinned toolchain; it does not
claim resistance to adversarial Lean code or a compromised compiler. Document
this boundary, including the stronger independent checking options in section 17.

No phase has an unlimited timeout. Enforce manifest timeouts on the whole proof
phase and whole comparison phase, including process startup. Use the existing
process cancellation semantics as the behavioral reference, with tests for child
cleanup. Cap each stdout/stderr stream at 50 MiB; overflow terminates the phase
as `incomplete`, never successful truncated evidence. A lock conflict is a
blocker; do not kill an unrelated run or auto-delete a lock based on age.

## 7. Reference model and conformance protocol

`Reference.lean` defines exactly:

```lean
namespace Formal
-- Pure JSON boundary for the domain-specific reference model.
def reference (input : Lean.Json) : Except String Lean.Json := ...
end Formal
```

The reference must call the same `Model.lean` functions named in the properties.
Do not reimplement the algorithm in the reference wrapper. Review decoding,
validation, and encoding as part of the contract. `Model.lean` must not import
`Reference` or use JSON-dependent branches merely to match corpus cases.

The corpus is UTF-8 JSON Lines without blank lines. Each line has exactly
`id`, `input`, and `covers`. IDs use the existing grammar and are unique.
`covers` is a nonempty unique list of declared property IDs. Each declared
property must have at least one case; this syntactic condition is not a coverage
sufficiency claim. Each line must be a JSON object with no duplicate decoded keys.

The runner starts the trusted Lean interpreter driver and the Node adapter as
separate processes. The driver is executed as
`<root>/bin/lean --run Driver.lean` in the fresh workspace with the same
`LEAN_PATH` and `-D` options used for compilation; the adapter is executed as
`node conformance/adapter.mjs`. Supply each the same ordered lines
`{ "id": ..., "input": ... }` on stdin and close stdin after the corpus. Both must emit exactly one JSON line
per input, in order, with exactly `id` and `result`. Result is exactly one of:

```json
{"ok": {"remaining": "12"}}
```

```json
{"error": {"code": "invalid-input"}}
```

The outer `ok` and `error` keys are mutually exclusive. `error` contains exactly
one string `code` matching `[a-z][a-z0-9-]{0,63}`. The shipped driver maps reference
`Except.error` strings to that error code and validates its grammar. Invalid
reference error codes are protocol errors. Never compare exception text.

Canonical comparison is defined on raw JSON tokens, before any parser handles
the text, so that Lean and Node cannot disagree on duplicate keys or numeric
spelling. The token grammar is: object keys unique at every depth; numbers must
match `^-?(0|[1-9][0-9]*)$`, lie within the safe-integer range, and not be
`-0`; fractions, exponents, and nonfinite values are rejected. This grammar
applies to the manifest, every corpus line, both stdout streams, and bridge
JSON. After token validation, comparison recursively sorts object keys by
Unicode code point and preserves array order, strings, booleans, and null.
Model larger integers and fixed-point decimals as canonical decimal strings
under the domain's reviewed codec. Strings must use valid Unicode scalar values.
Compare parsed values, not original whitespace or escape spelling. Domain codecs
must decide missing versus null, error behavior, overflow, rounding, and
collection ordering explicitly.

The adapter is executed in place, not staged: its working directory is the model
directory `specs/lean/<model-id>`, so `conformance/adapter.mjs` resolves exactly
as declared. The adapter must resolve production imports relative to its own
module location (Node ESM resolution), never relative to the process working
directory. The runner hashes the full execution closure before and after the
phase; any change marks the run `incomplete` with reason `input-changed`. The
repository Node line (`^22.19 || >=24`) strips erasable TypeScript syntax when
importing `.ts` files; the adapter may import such files directly when they use
only erasable syntax. Non-erasable constructs require a committed, deterministic
build step declared in the execution closure. The adapter must not contain a
second copy of the reference algorithm or print precomputed expected outputs.
Its stdout is protocol-only; diagnostics use stderr. Missing, extra, duplicated,
reordered, malformed, or oversized output fails; oversized means exceeding the
50 MiB stream cap from section 6. A thrown exception or nonzero exit fails, even
if prior lines matched. The driver runs first over the whole corpus, then the
adapter runs over the whole corpus, then the runner compares both outputs in
corpus order; the first mismatch is the earliest corpus line whose results
differ. Persist all outputs.

Corpus generation is an explicit authoring step, not hidden check behavior.
Commit generated corpus bytes and generation provenance (algorithm, version,
seed, bounds) in `design.md`. Require boundary cases, invalid inputs, relevant
branch combinations, and a known-bad implementation mutant. For small finite
domains, enumerate all cases where practical. Review larger-domain sampling
limits explicitly. A mutation test must show that at least one relevant wrong
implementation is rejected; it cannot establish complete fault detection.

Before implementation exists, proof verification may pass independently.
Conformance remains `not-run`, and implementation acceptance remains pending.
An empty or placeholder production adapter must not produce an accepted result.

## 8. CLI, status, and artifact contracts

All commands accept `--project <root> --model specs/lean/<id>`. Preflight and producer commands
also accept `--lean-root <root>`; the read-only auditor must not require a local
Lean installation or execute project code. Reject unknown flags and repeated
flags. `--help` prints plain text, performs no filesystem writes or tool
execution, and is the only output that is not a JSON object.

| Command | Behavior | Exit status |
| --- | --- | --- |
| `lean-preflight.mjs` | Validate files, pin, installation and limits; no compilation or writes | 0 ready; 2 blocked |
| `lean-check.mjs` | Fresh proof build, inspector, proof evidence | 0 verified; 1 rejected; 2 blocked; 3 incomplete |
| `lean-check-conformance.mjs` | Validate fresh successful proof, rebuild reference from pinned proof inputs, run both sides | 0 passed; 1 failed; 2 blocked; 3 incomplete |
| `lean-check-evidence.mjs --stage proof` | Replay integrity checks for current proof evidence | 0 valid; 2 invalid |
| `lean-check-evidence.mjs --stage acceptance` | Audit proof plus conformance evidence and their binding | 0 valid; 2 invalid |

Each command writes exactly one final machine-readable JSON result to stdout.
Child streams go to artifact files, never mix with the final JSON. Preflight may
execute `lean --short-version` to validate the installation; it starts no
compilation.
The auditor reads files and recomputes hashes only. For the proof stage, exit
zero means the evidence is valid and fresh, not that the verdict was `verified`.
For the acceptance stage, exit zero means `acceptanceReady` (section 8).

Use these distinct fields:

- `proofVerdict`: `verified | rejected | blocked | incomplete`.
- `conformanceVerdict`: `passed | failed | blocked | incomplete | not-run`.
- `integrity`: `valid | invalid`; `fresh`: boolean.
- `acceptanceReady`: boolean, computed only for acceptance auditing.

A proof failure is `rejected` only when Lean reports a type/proof error or the
inspector rejects a declaration, proposition match, or axiom dependency. Timeout,
cancellation, signal, overflow, unknown output, missing report, and source drift
are `incomplete`. Missing tools, invalid configuration, unsafe paths, missing
proof prerequisites, and lock conflicts are `blocked`. An unproved statement is
not a counterexample. Preserve the reason code and diagnostic location.

Proof evidence is a strict version-one object containing `schemaVersion`,
`backend`, `modelId`, `runId`, `inputFiles`, `inputDigest`, `runnerFiles`,
`runnerDigest`, `runnerPackage`, `toolchain`, `proofVerdict`, `reason`,
`properties`, `phases`, `startedAt`, and `finishedAt`. Set backend to `lean`.
`reason` is null only on success; otherwise use a stable code and detail object.
Each input/runner file entry has exactly `path` and `sha256`. Each phase records
its ID, argv, exit code, signal, timeout/cancellation flags, and stdout/stderr
project-relative paths, byte lengths, and SHA-256 hashes. Every phase records
both stdout and stderr; a zero-length stream is recorded as an empty artifact
file with length 0 and the SHA-256 of empty input, never omitted as an absent
field.
Each property report records ID, declaration, exact elaborated proposition,
axiom list, witness report or null, and a verdict from
`verified | rejected | not-checked`. The toolchain record includes pinned
name, platform, archive hash, installed content digest, and the observed
`--short-version` output (`4.35.0`). `reason` codes come from the closed list `config-invalid`,
`unsafe-path`, `missing-input`, `toolchain-missing`, `toolchain-mismatch`,
`lock-conflict`, `input-changed`, `artifact-changed`, `timeout`, `cancelled`,
`signal`, `stream-overflow`, `output-invalid`, `protocol-invalid`, `io`.
Phase identifiers come from the closed list `compile-model`,
`compile-properties`, `compile-reference`, `compile-inspector`, `inspector`,
`driver`, `adapter`, `compare`. `evidenceSha256` is the SHA-256 of the exact
published evidence bytes.

Conformance evidence contains `schemaVersion`, `backend`, `modelId`, `runId`,
`proofRunId`, `proofInputDigest`, `executionFiles`, `executionDigest`,
`runnerDigest`, `toolchain`, `conformanceVerdict`, `reason`, `caseCount`,
`matchedCount`, `firstMismatch`, `phases`, `startedAt`, and `finishedAt`.
`firstMismatch` is null unless a mismatch occurred; otherwise it contains case
ID, input, reference result, and implementation result. A protocol failure uses
`reason` rather than fabricated results. Retain both full output streams.

The inspector report is a strict JSON object with exactly `schemaVersion`,
`properties`, and `toolchainVersion`, where each property entry has exactly
`id`, `declaration`, `kind`, `statementType`, `theoremType`, `typesMatch`,
`axioms`, `witness`, and `verdict`. `kind` is the Lean declaration kind string
for the named declaration (`theorem` is required for acceptance); when the
declaration cannot be found in the environment, `kind` is `null`. For
`rejected` or `not-checked` properties, fields that could not be computed
(`statementType`, `theoremType`, `axioms`, `witness`) are `null`, and `verdict`
explains the distinction. `typesMatch` is `null` whenever either `statementType`
or `theoremType` is `null`; otherwise it is the boolean result of the
definitional-equality check. `witness` is `null` when no witness is declared;
otherwise it is an object with exactly `declaration`, `kind`, `type`, and
`verdict`. The comparison report is a strict JSON object with exactly
`schemaVersion`, `caseCount`, `matchedCount`, and `cases`,
where each case entry has exactly `id`, `referenceResult`,
`implementationResult`, and `matched`. Both reports are persisted as hashed
phase artifacts and referenced from the phase records; auditors recompute
verdicts from them.

`current-run.json` contains exactly `schemaVersion`, `runId`, `inputDigest`, and
`evidenceSha256`. It names proof evidence only. Conformance evidence binds its
proof run directly; an independent new proof run makes old conformance evidence
ineligible until conformance runs again. Run IDs are fresh UUIDs. Timestamps are
informational and do not define freshness.

Proof input enumeration includes `design.md`, `checks.json`, and the three Lean
sources. `implementation.md` is an acceptance record outside the proof digest.
Execution input enumeration includes the corpus, adapter, all manifest-declared
implementation/execution files, the Node executable identity, and the proof
input digest. `executionDigest` is the SHA-256 of the canonical JSON
serialization (sorted keys, no insignificant whitespace, UTF-8) of the object
`{ "files": <the digestEntries array of sorted, project-relative
[path, sha256] entries>, "node": "<resolved node executable path>|<output of
node --version>", "proofInputDigest": "<hex>" }`, where `digestEntries` is the
existing algorithm. Changes to execution inputs stale conformance, even when
proofs remain fresh. Changes to a conformance field inside `checks.json`
conservatively stale proof as well. The runner digest enumerates, from
`packages/plugin/dsh-cc-agents/skills/formal-design/`, every `scripts/lean-*.mjs`,
`scripts/check-combined-evidence.mjs`, `lean/Inspector.lean`, `lean/Driver.lean`,
and `scripts/lean-toolchain.json`.

The proof-stage auditor exits 0 only when evidence is valid and fresh; stale
evidence exits 2 as `invalid`, matching the existing TLC auditor. The
acceptance-stage auditor exits 0 only when `acceptanceReady` is true; otherwise
2. The two-stage exit semantics above supersede any generic integrity-only
phrasing. Readers reject missing files, duplicate entries, path escapes, hash
mismatches, wrong run IDs, mismatched pins, unknown schema versions, incomplete
report coverage, and internally inconsistent success records. Recompute verdicts from
complete stored phase metadata and inspector/comparison reports. These reports
and their hashes must be referenced in phase artifacts. Hash integrity is not
cryptographic attestation of an untrusted producer. Reviewers can request a
fresh independent run through the existing main-dialog workflow.

`acceptanceReady` requires valid/fresh proof and conformance evidence, proof
`verified`, conformance `passed`, and matching run/digest/tool identities.
Human approval and coverage sufficiency remain separate. The runner must not
convert this boolean into project review approval.

## 9. Design, review, and implementation workflow

1. Screen behavior using both trigger families. Record requirements and backend
   selection before modeling. Preserve current adoption and missing-rule notices.
2. Write each business property in plain English with an ID, domain, preconditions,
   forbidden outcomes, boundary behavior, and independently chosen examples.
3. Write `Model.lean` and property statements. Separate observed legacy behavior
   from intended behavior. Raise ambiguous business semantics before proving them.
4. Record a coverage table in `design.md`: requirement ID, property ID, theorem,
   assumptions, witness, implementation symbol, codec, corpus cases, negative
   control, and excluded scope. Planned symbols are explicitly marked planned.
5. Complete proofs and run proof checks/audit. Proof checks do not require the
   implementation or conformance inputs to exist yet. Failed proof search is
   pending work; never delete a property or strengthen assumptions merely to
   pass.
6. Submit the full same-run proof package to existing review lanes. Include exact
   inputs, Lean statements, inspector results, both streams for every phase,
   tool identities, corpus, planned source bindings, and outstanding conformance.
   Existing full-log transport and receiver rules apply without relaxation.
7. After required design approval, implement pinned semantics and the adapter.
   Run conformance and project regression tests. Record actual symbols and
   results in `implementation.md`, keyed to the approved proof digest.
8. Audit acceptance evidence. Resolve implementation deviations and obtain the
   effective project's required acceptance approvals. A proof-only result never
   means implementation acceptance passed.

Changes to requirements, theorem types, assumptions, model semantics, codec, or
shared operation contracts require new proof and review. A proof-body-only
change still requires fresh evidence; review may reuse semantic approvals only
when the existing project's rules permit it and the record explains why types
and definitions did not change. Do not infer equivalence from equal names.
Tool-only reuse follows the existing documented policy with fresh checks.

Source-only changes invalidate conformance. Review whether they preserve the
approved model; if uncertain, stop affected handoff and resolve semantics.
Never edit a model to conceal an implementation deviation. A behavioral
implementation mismatch is either a defect, a model defect, or requirement
ambiguity; classify it and update the appropriate reviewed artifact.

## 10. Combined TLA+ and Lean contracts

For selection `both`, add `specs/formal/<feature-id>/bridge.json` and `bridge.md`.
Use a strict bridge JSON schema with exactly `schemaVersion` (1), `featureId`,
`tlaModel` (a `specs/tla/<id>` path), `leanModel` (a `specs/lean/<id>` path), and
`operations` (1..64 unique rows). `featureId` uses the existing model-id grammar.
Each row contains exactly `id`, `requirementId`,
`tlaOperator`, `leanFunction`, `propertyIds`, `domain`, `casesFile`, and
`implementationFiles`. Operation IDs use the bridge case ID grammar below;
property IDs must exist in the selected Lean manifest. Implementation file
paths must be a subset of that manifest's implementation closure. Names use
their backend identifier grammars; domain is a nonempty explanation, and
`casesFile` is a regular project-relative JSON file path (project-relative
means repository-root-relative, as defined in section 4).

Each cases file is an array of rows with exactly `id`, `input`, `expected`, and
`tlaExpression`. `id` must equal the ID of a committed Lean corpus case (IDs use
the existing corpus grammar, which excludes underscores, so the join key is ID
equality). The bridge row `propertyIds` must equal that corpus case's `covers`
set, and `input` must be canonically equal to that corpus case's `input`.
`expected` is the conformance protocol result from section 7 — exactly an
`{ "ok": ... }` or `{ "error": { "code": ... } }` object — and both the Lean
reference and the implementation must return it for `input`. The
`tlaExpression` is a TLA+ expression authored and reviewed as source, never
shell text. For each row, the main dialog adds a derived TLA+ invariant named
`Bridge_<id>` with every hyphen in `id` replaced by an underscore (injective,
because the corpus grammar excludes underscores), asserting the corresponding
operator expression equals the TLA+ encoding of `expected`, and includes it in a
declared TLC case. The invariant is checked, not assumed: the combined
auditor requires each derived invariant name to occur in the digested cfg bytes
of a case whose recorded verdict is `verified`, matched as a complete cfg
identifier token (delimited by whitespace or line boundaries), never as a
substring — `Bridge_a` must not satisfy the check when only `Bridge_a_b` is
present. Record the exact JSON-to-TLA+
encoding in `bridge.md`. All bridge artifacts and cases must be
listed in both models' design documents with SHA-256 hashes; a changed bridge
requires updating both design inputs and rerunning both workflows.

A budget example separates the obligations:

- Lean: a guarded reservation preserves `reserved <= budget`, rejection preserves
  the prior balance, and release respects the defined amount/domain.
- TLA+: reservation admission and balance updates are atomic; concurrent callers
  cannot use the same stale balance; duplicate release does not happen.
- Bridge: both use the same admission guard, numeric units, rejection behavior,
  and state update. Bounded examples exercise zero, exact exhaustion, and excess.

State the crucial distinction: arithmetic proofs do not establish atomicity;
TLC's bounded arithmetic examples do not establish the general Lean theorem.
Shared examples provide conformance evidence, not a composition theorem.

Implement `scripts/check-combined-evidence.mjs` as a read-only auditor. It
accepts `--project` and `--bridge specs/formal/<id>/bridge.json`, validates the
strict schema and case files, invokes both read-only backend auditors, verifies
pinned bridge hashes from both evidence packages, and checks every bridge
invariant and corpus case is represented in successful current evidence (TLC
`status: verified`; Lean `proofVerdict: verified` and `conformanceVerdict:
passed`). It writes exactly one JSON result object to stdout and exits 0 only
when combined acceptance is valid; otherwise 2. Evidence must include the
complete ordered per-case ID/result list in a hashed comparison report; aggregate
counts alone cannot establish bridge coverage. For each TLA invariant, bind its
name to a configured successful case and inspect the digested module declaration.
Human review confirms that its expression is the specified bridge assertion. Version-two evidence for both backends adds exactly one field, `bridgeFiles`:
an array of `{ "path", "sha256" }` entries for `bridge.json`, `bridge.md`, and
every declared casesFile, included in each backend's input enumeration before
hashing. Old TLA version-one evidence remains readable and valid for TLA-only
use. The TLC runner writes version-two evidence only when supplied `--bridge`;
without that flag it preserves version-one behavior and shape. The same rule
binds Lean: without `--bridge`, Lean evidence stays the section 8 version-one
object; with `--bridge`, it uses its schema version two, which adds exactly
`bridgeFiles`. The auditor rejects mixed bridge
versions or successful records missing a bridge row. Both-mode producer commands require the same `--bridge` argument, a unique
project-relative `specs/formal/<id>/bridge.json` path. The argument is also
accepted by preflight and auditors; it is forbidden with a nonmatching model.
Derive `bridgeFiles` by enumerating bridge.json, bridge.md, and every declared
casesFile with regular-file and size checks. Add these entries directly to each
backend's input enumeration before hashing; do not extract hashes from Markdown.
Each case file is at most 1 MiB and the bridge package at most 10 MiB.
Both mode cannot enter
combined acceptance on unrelated successful runs with stale bridge bindings.

## 11. Compatibility and integration changes

Update these existing files during implementation:

| File | Required change |
| --- | --- |
| `skills/formal-design/SKILL.md` | Add routing, Lean workflow, commands, assurance wording, and links |
| `references/agents-snippet.md` | Add Lean screening IDs; rewrite the review-admission predicate for `backends`, proof and conformance verdicts, and both digests (a Lean-only task must not be admitted by vacuous TLC-case verification); retain explicit project adoption |
| `agents/executor.md` | Extend the handoff keys with the proof input digest and execution digest alongside the approved input digest |
| Skill `.gitignore` adoption instruction | Also ignore `specs/**/conformance-evidence.json` |
| `references/modeling-guide.md` | Explain selection and point to Lean/combined guides |
| `references/review-contract.md` | Add proof-stage review versus acceptance-stage conformance |
| Existing TLC evidence/CLI modules | Add opt-in bridge schema two without changing schema-one contracts |
| `tests/formal-design.spec.ts` | Retain legacy contracts; add opt-in bridge compatibility tests |
| `tests/package-shape.spec.ts` | Assert inspector, driver, guides, example, and scripts ship |
| `.github/workflows/formal-design.yml` | Keep TLC tests; add separate Lean jobs and checked model discovery |
| Root and plugin `README.md` / `README.zh.md` | Describe selection, installation, commands, limits, and evidence claims |
| README pairing record | Regenerate with the existing README checker |

Use the existing plugin packaging rules (`files` already includes `skills`).
Do not increase skill or agent counts. Do not add a new runtime setting.
Do not modify AGENTS.md automatically or repair its current self-reference as
part of this feature. Missing effective review rules remain a recorded workflow
limitation; they do not authorize invented reviewer identities.

## 12. CI and release behavior

Keep the current Java/TLC job. Add `formal-design-lean` with the same checkout and
workspace dependency installation conventions. Provision the exact Lean archive
with checksum validation in a separate explicit step. Run contract tests plus
real Lean integration tests with `FORMAL_DESIGN_LEAN_CI=1`; that variable makes
missing tools a test failure, never a skip. Upload complete diagnostics on failure.

Add a model validation step that enumerates regular `specs/lean/*/checks.json`
files in code-point path order, validates every manifest, runs proof and
conformance, and audits acceptance. Reject malformed discovered model directories
instead of silently excluding them. Run all committed Lean models for version
one; do not implement dependency-based selective skipping. In the feature PR,
ship one accepted budget-reservation fixture/model with a real implementation
binding. Unfinished production models must remain outside committed `specs/lean`.

Enumerate `specs/formal/*/bridge.json` before executing checks. The Lean job
also installs Java. For each bridge, run the TLC producer with `--bridge` for
the referenced `specs/tla` model, then run the Lean producer and conformance
commands with `--bridge` for the referenced `specs/lean` model, then run the
combined auditor; the shared checkout provides both evidence packages. Keep
`.formal-design` in the checkout and upload it explicitly; artifacts must keep
the project-relative paths recorded in the evidence packages. Use a dedicated
30-minute Lean job timeout; individual phase limits still apply.

Run package-shape checks against the packed plugin as well as the source tree.
A clean npm installation must expose the guides and scripts without requiring
Lean for ordinary startup. Provisioning failure blocks Lean verification but
must not silently disable it or disturb the independent TLC job.

## 13. TDD implementation sequence

Each work package starts with failing behavioral tests, then implementation,
then the real-tool acceptance checks appropriate to that package.

1. **Manifest and identity.** Implement strict parsing, input closure, path checks,
   pins, installation receipts, and preflight. Test duplicate keys, unknown fields,
   symlinks, limits, missing/version-mismatched tools, and unchanged legacy TLC.
2. **Proof execution.** Add process lifecycle handling, fresh workspaces, inspector,
   driver, reports, and proof evidence. Demonstrate valid proofs and indirect
   `sorryAx` rejection using the real pinned Lean binary.
3. **Conformance.** Add JSON protocol validation, source closure fingerprinting,
   corpus replay, comparison, implementation bindings, and acceptance audit.
4. **Combined contracts.** Add strict bridge parsing, opt-in TLC evidence version
   two, bridge case coverage, and combined evidence auditing. Preserve v1 fixtures.
5. **Workflow and delivery.** Update skill/reference text, worked examples, CI,
   packaging, and bilingual documentation. Complete actual session acceptance.

Do not release a proof-only first version as the complete feature. Packages 1
and 2 can be separate reviewable commits, but the feature is complete only when
conformance, bridge support, documentation, and release checks pass.

## 14. Required tests and observable results

| Scenario | Required observation |
| --- | --- |
| Valid arithmetic theorem and matching implementation | Proof verified, conformance passed, fresh acceptance audit |
| False property without proof | Rejected; no fabricated counterexample |
| Missing or non-theorem declaration | Rejected, with the named property |
| Theorem type differs from manifest proposition | Rejected, even if both independently have proofs |
| Direct/indirect `sorry`, `admit`, custom axiom | Rejected by transitive axiom audit |
| Allowed standard axioms | Accepted and listed, never described as axiom-free |
| Unsupported computation axiom | Rejected without widening the allowlist |
| Top-level implication without a witness | Manifest blocked at preflight; vacuity hidden behind definitions remains a review finding |
| Source containing `set_option debug.skipKernelTC` | Blocked before compilation by source scan; never claim hostile-code isolation |
| Preexisting `.olean` or project Lake file | Blocked before compilation |
| Wrong tool version, missing archive receipt, modified installation | Preflight blocked |
| Lean missing but TLA-only task | Existing TLC behavior unchanged |
| Model/corpus/source changes during a run | Incomplete or stale, never accepted |
| Proof input changes after a run | Proof audit stale; conformance cannot reuse it |
| Production transitive source or lockfile changes | Conformance stale |
| Same model with a new proof run | Old conformance binding invalid |
| Boundary numeric values, big decimal strings, missing/null | Match the reviewed codec or explicitly reject input |
| Fraction, unsafe integer, duplicate JSON key | Protocol/config failure, not rounded equality |
| Extra, reordered, duplicate, missing output | Conformance failed |
| Adapter exception after matching outputs | Conformance failed |
| Deliberately wrong implementation mutant | Conformance failed on recorded case ID |
| Timeout, cancellation, child signal, log overflow | Incomplete with full lifecycle metadata |
| Missing stderr, truncated report, wrong run, tampered hash | Integrity invalid |
| Concurrent run or unsafe artifact path | Blocked without modifying another run |
| Proof-only evidence | Design review possible; implementation acceptance pending |
| Both backends pass but bridge is stale | Combined acceptance blocked |
| Lean passes but TLC fails, or reverse | Combined acceptance blocked |
| Changed bridge guard/units/domain | Both evidence packages stale after recorded design updates |
| Packed plugin on a clean checkout | Scripts and assets present; no startup tool download |

Test the inspector against actual declaration environments rather than mocked
success text. Contract tests may use fake child processes to exercise cleanup
and corruption, but real-tool tests must cover meaningful successful and rejected
proofs, codec execution, and implementation mismatches. No production verdict
may rely solely on keyword checks in Markdown.

Actual session acceptance must demonstrate explicit invocation, risk screening,
missing adoption/review-rule handling, waived scope, proof failure classification,
implementation mismatch resolution, and both-backend selection. Record actual
review transport outcomes under the existing contract. Missing authorized review
lanes leave workflow acceptance pending; they do not invalidate completed runner
contract tests or permit a claim that full workflow acceptance passed.

## 15. Required worked example

Ship a budget reservation example with `Nat` state and request values. Define
`reserve budget reserved amount` to reject when `reserved > budget` or
`amount > budget - reserved`; otherwise return `reserved + amount`. Define the
error cases explicitly, including an already invalid state. Prove:

- Success implies the returned reservation is at most the budget.
- Success adds exactly the requested amount.
- Rejection preserves the caller's prior state under the documented API contract.
- A zero request succeeds for a valid state and returns the same reservation.

Avoid saturating-subtraction mistakes by stating and checking `reserved <= budget`
before using `Nat` subtraction. Use canonical decimal strings for numeric JSON
values so the Lean domain and JavaScript BigInt implementation agree. The
canonical grammar is `^(0|[1-9][0-9]*)$`. Production code converts strings to
BigInt under that grammar. Do not silently coerce JSON numbers to BigInt. The
reference returns the error codes `invalid-state` (already invalid state:
`reserved > budget`), `insufficient-budget` (`amount > budget - reserved`), and
`invalid-amount` (malformed or negative string).

Include exact exhaustion, excess by one, zero, invalid prior state, malformed
string, negative string, and values above JavaScript's safe integer range.
Enumerate a small finite domain and add seeded larger values. The known-bad
mutant omits the `reserved > budget` admission guard. A combined example additionally models atomic
admission and duplicate-release behavior in TLC and records bridge cases.
Do not claim that this example proves the project's unrelated budget code.

## 16. Completion and reporting

The implementation is complete when every contract above has a shipped component,
all required negative controls fail for the intended reason, all accepted
examples pass with real tools, existing TLC tests remain green, and the packed
plugin works on a clean checkout. Pending workflow prerequisites must be visible.

Use separate report lines for selection, model coverage, proof verdict, axiom
basis, conformance corpus/result, bridge result, review approval, and excluded
scope. Permitted wording:

> Lean checked the listed propositions under the recorded definitions,
> assumptions, and allowed axioms. The implementation matched the reference on
> the recorded corpus. This does not prove arbitrary TypeScript code equivalent
> to the model.

For TLC, retain the existing bounded-check conclusion. Never collapse both into
“the feature is formally proved correct.”

## 17. References and future extensions

Primary references, consulted on October 26, 2026:

- [Lean: Validating a Lean Proof](https://lean-lang.org/doc/reference/latest/ValidatingProofs/)
  distinguishes proof validity, theorem meaning, axioms, and stronger checking.
- [Lean: Axioms](https://lean-lang.org/doc/reference/latest/Axioms/)
  explains standard axioms and incomplete-proof dependencies.
- [Lean: Lake](https://lean-lang.org/doc/reference/latest/Build-Tools-and-Distribution/Lake/)
  documents build configuration and cache behavior. Version one deliberately uses
  direct compilation to keep project build hooks outside the proof pipeline.
- [Lean 4.35.0 release](https://github.com/leanprover/lean4/releases/tag/v4.35.0)
  is the selected version-one toolchain. Implement against this release, not
  assumptions derived from newer `latest` documentation.
- [Existing formal-design skill](../../packages/plugin/dsh-cc-agents/skills/formal-design/SKILL.md)
  and [review contract](../../packages/plugin/dsh-cc-agents/skills/formal-design/references/review-contract.md).
- [Original TLA+ design](2026-10-23-formal-design-skills.md) and
  [implementation plan](2026-10-24-formal-design-implementation.md).

Future separately designed work may add an independent proof checker, pinned
Mathlib support, verified translation for a restricted production language,
property-based corpus shrinking, or machine-checked refinement between models.
None is an implicit dependency or an assurance claim of this implementation.

## 18. Review ledger

This revision was produced by a three-seat blind review of the initial
document. Reviewers worked independently from the same brief. Rounds after
the first verified only the folds from their own seat's findings; they were
delta rounds, not full re-reviews. The reviewer lane identities and the
verdict counts below are recorded as delivered; the underlying outputs are
not committed to the repository.

| Round | Scope | Seat verdicts | Outcome |
| --- | --- | --- | --- |
| r1 | Full document | internal critic GO-WITH-CHANGES (16 findings); external reviewer A NO-GO (8 findings, 1 blocker); external reviewer B NO-GO (14 findings, 1 blocker) | 34 merged folds applied |
| r2 | Delta on own folds | critic GO-WITH-CHANGES (15 OK, 1 problem, 1 new minor); reviewer A GO-WITH-CHANGES (6 OK, 2 problems); reviewer B NO-GO (8 OK, 6 problems, 7 new incl. 1 blocker) | 14 further folds applied |
| r3 | Micro-confirmation of r2 residuals | critic GO; reviewer B GO; reviewer A NO-GO on one narrow item | 1 fold applied |
| r3b | Single-item confirmation | reviewer A GO | Converged |

Adjudications worth recording:

- The Lean import-path defect (clearing `LEAN_PATH` cannot resolve freshly
  compiled modules) was reported independently by all three seats and was
  verified against the upstream `initSearchPath` implementation and then
  reproduced live on the installed v4.35.0 toolchain before folding.
- Reviewer A's round-1 claim that `--version` prints the bare version string
  was corrected by reviewer B in round 2 and verified against the upstream
  shell source and the installed v4.35.0 binary: `--version` prints a long
  header; `--short-version` prints the bare string. The pin check now uses
  `--short-version`.
- Reviewer B's round-2 blocker on `-D` option placement after `--run` was
  verified against the same source (option parsing stops at `--run`).
- Witness conditionality is enforced only by a conservative top-level arrow
  scan of the statement matrix; everything deeper remains a review finding.
  This split was proposed by two seats and adopted.

Facts verified by the orchestrator during the cycle: the baseline commit
exists on `main`; both pinned release asset SHA-256 digests match the values
in section 6; the repository Node engines are `^22.19 || >=24`; the
existing skill layout matches section 4.

The initial draft pinned v4.24.0. The pin was raised to v4.35.0 (the current
`stable` release, and the version installed in the development environment)
after live probes against the local toolchain: clearing `LEAN_PATH` fails to
resolve a freshly compiled sibling module with `unknown module prefix`
(the search path then contains only the toolchain's `lib/lean`); setting
`LEAN_PATH` to the workspace resolves it while core libraries still load;
`-D` options before `--run` reach the compiler while `-D` after `--run`
becomes a script argument; `-D Elab.async=false`, `-DmaxHeartbeats`, and
`-DmaxRecDepth` are accepted; `Lean.Util.CollectAxioms` ships in the
toolchain; `#print axioms` reports `[propext, Quot.sound]` for a proved
theorem, nothing for a constructive example, and `sorryAx` for a `sorry`;
`set_option debug.skipKernelTC` exists; and `Lean.Json` /
`Except String Lean.Json` have the signatures section 7 assumes. Both
v4.35.0 release asset digests were verified through the GitHub release API.
Developers whose local toolchain differs from the pin are blocked at
preflight by design; provision the pinned archive rather than relaxing the
check.

Status of this document: three-seat review converged (all seats GO on the
final text). User sign-off pending. r2 through r3b verified folds only; the
first round was the only full review of the initial text.
