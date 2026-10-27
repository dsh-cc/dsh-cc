# Lean conformance and evidence

Read [lean-modeling-guide.md](lean-modeling-guide.md) for statement and corpus
authoring. This guide covers executing the reference and the implementation,
comparing them, and auditing acceptance.

## Command and status contract

All commands accept `--project <root> --model specs/lean/<id>`. Producer and
preflight commands also accept `--lean-root <root>`; the read-only auditor must
not require a local Lean installation and executes no project code. Both-mode
commands also require one `--bridge specs/formal/<id>/bridge.json`; it is
forbidden with a nonmatching model. Unknown and repeated flags are rejected.
`--help` prints plain text, performs no writes or tool execution, and is the
only output that is not a JSON object.

| Command | Behavior | Exit status |
| --- | --- | --- |
| `lean-preflight.mjs` | Validate files, pin, installation and limits; no compilation or writes | 0 ready; 2 blocked |
| `lean-check.mjs` | Fresh proof build, inspector, proof evidence | 0 verified; 1 rejected; 2 blocked; 3 incomplete |
| `lean-check-conformance.mjs` | Rebuild the reference from pinned proof inputs, run both sides | 0 passed; 1 failed; 2 blocked; 3 incomplete |
| `lean-check-evidence.mjs --stage proof` | Replay integrity checks for current proof evidence | 0 valid; 2 invalid |
| `lean-check-evidence.mjs --stage acceptance` | Audit proof plus conformance evidence and their binding | 0 valid; 2 invalid |

Read the named verdict fields, not just the exit status: `proofVerdict`
(`verified | rejected | blocked | incomplete`), `conformanceVerdict` (`passed |
failed | blocked | incomplete | not-run`), `integrity` (`valid | invalid`),
`fresh` and `acceptanceReady`. A proof-stage audit exit 0 means the evidence is
valid and fresh, not that the verdict was `verified`. A timeout, cancellation,
signal, stream overflow, unknown output, missing report or source drift is
`incomplete`; missing tools, invalid configuration, unsafe paths, missing proof
prerequisites and lock conflicts are `blocked`. An unproved statement is not a
counterexample.

The toolchain is provisioned outside the package by an administrator, never by
a runner or check command. Preflight resolves the tool root from `--lean-root`,
then `FORMAL_DESIGN_LEAN_ROOT`, and blocks otherwise; it does not use an elan
shim, search `PATH` or accept an environment fallback. Verify the pin with
`<root>/bin/lean --short-version` (`4.35.0`) and require the sibling
`<lean-root>.receipt.json` with matching archive and content digests.

## Adapter contract

- The adapter is executed in place, not staged. Its working directory is the
  model directory `specs/lean/<model-id>/`, so `conformance/adapter.mjs`
  resolves exactly as declared. The command is exactly
  `["node", "conformance/adapter.mjs"]`; it is not a shell command and no
  runner-provided shell evaluation is allowed.
- Resolve production imports relative to the adapter's own module location
  (Node ESM resolution), never relative to the process working directory. The
  repository Node line (`^22.19 || >=24`) strips erasable TypeScript syntax when
  importing `.ts` files, so an adapter may import such files directly when they
  use only erasable syntax. Non-erasable constructs require a committed,
  deterministic build step declared in the execution closure, never an implicit
  compile at check time.
- Do not reimplement the reference algorithm in the adapter and do not print
  precomputed expected outputs. The adapter is implementation evidence; a second
  algorithm copy makes the comparison vacuous.
- The adapter's stdout is protocol-only. Diagnostics go to stderr. A thrown
  exception or nonzero exit fails the phase even if prior lines matched.

Declare the full behavior closure in the manifest: every behavior-bearing
transitive project dependency in `implementationFiles`, and build scripts,
runtime loaders and lockfiles in `executionFiles`. Duplicate paths across the two
arrays are invalid. Review must confirm closure completeness; the runner cannot
infer arbitrary dynamic imports. Source-only changes stale conformance, and
changes to a conformance field inside `checks.json` conservatively stale proof.

## Protocol

The runner starts the trusted Lean interpreter driver and the Node adapter as
separate processes and supplies each the same ordered lines
`{"id": ..., "input": ...}` on stdin, closing stdin after the corpus. Both must
emit exactly one JSON line per input, in order, with exactly `id` and `result`.
`result` is exactly one of:

```json
{"ok": {"remaining": "12"}}
```

```json
{"error": {"code": "invalid-input"}}
```

The outer `ok` and `error` keys are mutually exclusive. `error` contains exactly
one string `code` matching `[a-z][a-z0-9-]{0,63}`. The driver maps reference
`Except.error` strings to that code and validates its grammar; invalid reference
codes are protocol errors. Never compare exception text.

The driver runs first over the whole corpus, then the adapter over the whole
corpus, then the runner compares outputs in corpus order. The first mismatch is
the earliest corpus line whose results differ. Missing, extra, duplicated,
reordered, malformed or oversized output fails; oversized means exceeding the
50 MiB stream cap. Retain both full output streams and persist them as hashed
phase artifacts.

## Canonical JSON

Comparison is defined on raw JSON tokens, before any parser handles the text, so
Lean and Node cannot disagree on duplicate keys or numeric spelling. Object keys
are unique at every depth and numbers must match `^-?(0|[1-9][0-9]*)$`, lie
within the safe-integer range and not be `-0`; fractions, exponents and nonfinite
values are rejected. This grammar applies to the manifest, every corpus line,
both stdout streams and bridge JSON. After token validation, comparison
recursively sorts object keys by Unicode code point and preserves array order,
strings, booleans and null. Compare parsed values, not original whitespace or
escape spelling.

Model larger integers and fixed-point decimals as canonical decimal strings
under the domain's reviewed codec. The codec must decide explicitly: missing
versus null, error behavior, overflow, rounding and collection ordering; do not
silently coerce JSON numbers.

## Execution closure and evidence

The proof input digest enumerates `design.md`, `checks.json` and the three Lean
sources. The execution digest is the SHA-256 of the canonical JSON serialization
(sorted keys, no insignificant whitespace, UTF-8) of
`{ "files": <sorted project-relative [path, sha256] entries>, "node":
"<resolved node executable path>|<node --version output>", "proofInputDigest":
"<hex>" }`. Execution inputs are the corpus, adapter, all manifest-declared
implementation and execution files, the Node identity and the proof input
digest. Conformance evidence binds its proof run directly; an independent new
proof run makes old conformance evidence ineligible until conformance runs again.

The auditor reads files and recomputes hashes only. Reject missing files,
duplicate entries, path escapes, hash mismatches, wrong run IDs, mismatched pins,
unknown schema versions, incomplete report coverage and internally inconsistent
success records. Recompute verdicts from complete stored phase metadata and the
inspector/comparison reports; both reports must be referenced from phase
artifacts. Hash integrity is not cryptographic attestation of an untrusted
producer. Reviewers can request a fresh independent run through the existing
main-dialog workflow.

`acceptanceReady` requires valid/fresh proof and conformance evidence, proof
`verified`, conformance `passed`, and matching run/digest/tool identities. It is
not project review approval and does not cover unrecorded inputs.
