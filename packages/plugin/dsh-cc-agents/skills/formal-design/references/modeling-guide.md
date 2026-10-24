# Modeling and runner guide

## Business contract and coverage

Restate all correctness requirements in design.md. A mutable external link
alone is not a tracked requirement. Include state variables, actions and
atomicity, S-* safety properties, L-* liveness or explicit exclusion,
A-* environment assumptions with real justification, F-* faults, finite
bounds, property/operator/case mappings, planned code/test mappings,
counterexample dispositions and the current Formal design screening section.

Use every column of this planned coverage table, with no empty cell or
unexplained N/A:

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|

Every relevant correctness requirement needs a property or explicit exclusion;
every property needs a core case. For each applicable trigger model adverse
orders (both competing event orders), late/duplicate delivery, timeout/retry
and crash/restart when relevant, or justify a specific exclusion. Map each
atomic action to an actual intended transaction, CAS or equivalent guard/update
mechanism. Separate writes cannot be called atomic without that explanation.
Every assumption owes a code/infrastructure guarantee or a declared external
obligation; unsupported assumptions block review. Safety properties need code
regression assertions. Liveness needs explicit fairness and eventual-response
assumptions; do not add fairness simply to terminate a safety exploration.

For each critical abstraction name omitted state/events, affected properties,
why omission preserves them and an adverse concrete trace challenging that
claim. Model outcome-changing omissions or obtain the project's required
scoped exclusion approval. A complete table is necessary, not sufficient.
A known defect cannot be excluded merely to pass.

Reject “cancellation rolls back an already-sent payment” unless an enforceable
compensating protocol and guarantees are modeled. Trace: send effect → accept
cancel → effect commits. Logical cancellation stability does not prove absence
of that effect. Reject a coverage table omitting a relevant at-most-one-charge
requirement even if its other properties pass. A bounded logical-state model
may be eligible when its claims really are just cancellation stability and
attempt filtering, with relevant omissions approved. The minimal example's
stale stutter must be challenged by a delivered-tag receiver model and the
actual guard/update mechanism; it is not itself proof of a handler guard.

## Package and input boundary

Copy the example into specs/tla/<model-id>. Inputs are root design.md,
checks.json, all direct-child .tla files and cases/<declared-id>.cfg only.
All non-standard modules live in that flat root and have their module name
as filename. Nested .tla files, symlinks, unsafe file types and Java override
.class/.jar/.java files are rejected. Bundled TLC standard modules are allowed.
No PlusCal translation, TLAPS, Apalache, external module directory, arbitrary
commands, custom classpath or JVM/TLC argument pass-through is supported.
A file is at most 1 MiB; total inputs at most 10 MiB. Undeclared cfgs and
support files are not dependencies or digested inputs. implementation.md,
evidence.json and current-run.json remain outside inputDigest.

All commands require exactly one --project and --model, except --help alone.
The project exists; model is exactly specs/tla/<modelId>, project-relative,
with no absolute path, dot/empty segment or escaping symlink. preflight/check
accept one --jar and --java; check-evidence rejects them. Explicit tool paths
(and the JAR environment fallback) are realpath-normalized once to regular
files. PATH java is recorded literally in argv; its resolved location is
separate metadata. Java options/classpath/TLA-library injection variables
are scrubbed. v1 supports macOS/Linux termination; Windows blocks. Heap caps
are not total RSS limits. A TLA+ execution is not a general security sandbox.

## checks.json and cfgs

```json
{"schemaVersion":1,"modelId":"task-lifecycle","module":"Model","cases":[{"id":"small","coverage":"core","specification":"Spec","constants":{"MaxAttempts":"2"},"invariants":["TypeOK","CancelledStable","StaleCannotComplete"],"properties":[],"limits":{"timeoutMs":120000,"heapMiB":1024}}]}
```

Every field shown is required; unknown fields and duplicate JSON keys are
rejected. IDs match [a-z][a-z0-9-]{0,63}; module/operator/constant identifiers
match [A-Za-z][A-Za-z0-9_]* and must not be cfg directive words. There are
1..16 uniquely named cases and at least one core case. coverage is core or
expansion, never required/optional. Every case needs an invariant. Name arrays
have no duplicates. timeoutMs is 1000..600000 and heapMiB is 256..4096, integers.

Constant strings are consumed in full, at most 512 characters: TRUE/FALSE,
naturals 0..2147483647, model-value identifiers, or a non-nested finite set
of those atoms. Only an optional single ASCII space after a comma is allowed.
No other whitespace, quotes, negative numbers, comments, override expressions
or trailing text. Canonical sets use one space after commas and preserve
order/duplicates. `C = Derived` is a model value, not operator evaluation;
derive complex values in TLA+ from primitive parameters. Unsupported cases
are blockers, never arbitrary cfg text. Reserved exact-case directive words:
SPECIFICATION, CONSTANT, CONSTANTS, INVARIANT, PROPERTIES, PROPERTY, CONSTRAINT,
ACTION_CONSTRAINT, SYMMETRY, VIEW, CHECK_DEADLOCK, INIT, NEXT, CONSTRAINTS,
ACTION_CONSTRAINTS, INVARIANTS, TYPE, TYPE_CONSTRAINT.

Cfg bytes: SPECIFICATION first; nonempty constants have a CONSTANTS header
and key-sorted `key = value` lines; INVARIANT and PROPERTY lines follow array
order; fixed final CHECK_DEADLOCK TRUE, LF endings and one trailing newline.
Use explicit terminal self-loops, never disable deadlock checking.

Preflight is read-only; ready willGenerate lists missing cfg paths. A blocked
preflight lists ordered blockers and willGenerate=[], generates nothing and
starts no TLC. check creates absent cfgs atomically without replacing an
existing destination. If generation fails, completed files remain, the current
partial temp is cleaned when possible, and stderr lists completed/unfinished
paths. Repair and retry absent cfgs; never delete retained files merely to
restart. A concurrent identical destination is retained; differing bytes block.
Abrupt death may leave unique .tmp files; inspect ownership before cleanup.

## Execution, output and recovery

stdout is one JSON object plus LF; diagnostics are stderr; --help is the sole
plain-text exception. preflight exit 0 is ready-for-check, not verified.
check exits 0 verified, 1 counterexample, 2 blocked/error, 3 incomplete.
check-evidence exits 0 for intact/fresh evidence of ANY verification status;
read fresh AND verification. Invalid/stale/missing evidence exits 2. No failure
means waived automatically. Report missing Java/JAR, unsupported configuration,
timeout, unknown protocol or repeated blockage truthfully.

check reserves one runId and takes an exclusive per-model lock before full
preflight; then generates cfgs, captures inputs, publishes a running marker,
copies a byte-exact snapshot, checks its digest, and runs all cases sequentially
against the snapshot. Cases run direct Java with one worker, seed 1, fp 0,
fixed tool flags and isolated state stores. A failing case does not skip later
cases unless cancellation or terminal I/O prevents execution. Recheck inputs
and runner/JAR/toolchain artifacts at the end. New/deleted/unreadable inputs
are changes. Global precedence: cancelled, input-changed, artifact-changed,
then terminal I/O, then all-case aggregation. Counterexample precedes error,
then incomplete; every case must verify for a verified aggregate. Expansion
failures additionally carry context warnings, never relaxed obligations.

Persist raw stdout/stderr separately, with a combined 50 MiB per-case prefix
limit. Timeout/log-limit/cancel use TERM then KILL after 2000 ms and await
child close. The Java version probe is separately bounded at 10000 ms and
1 MiB, with a further bounded close wait; it creates no logs or model artifacts.
Check cancellation latches before asynchronous preparation through final
publication. Before running marker: cancelled with null summary, old evidence
retained. After marker: preserve attempted records; unstarted cases are
not-run. Cancellation after the last child can still override verified cases.
A synchronous, non-yielding evidence/finished-marker publication defines the
handler-observation boundary. After commit, cleanup cancellation does not
change the result. No completed marker means no reusable latest success.

Never relabel a started child not-run or invent logs for lost bytes. Log
write/flush/close/hash loss means null summary and a running marker; recoverable
preparation I/O may publish error/io with truthful complete records. Publication
recovery is bounded, not an endless retry. Failed final marker never commits.

Locks are never auto-deleted after a crash. check refuses every existing lock.
Audit treats present or indeterminate PID ownership (including malformed or
unreadable lock) as run-in-progress; only a well-formed absent PID can be ignored
by audit. PID reuse is possible: presence does not prove checker identity.
Report recorded pid/runId/startedAt and present/absent/indeterminate state.
The operator must confirm ownership/absence before manual removal.

Evidence records the exact plugin package/version, runner and toolchain
digests, actual JAR hash, command argv, process observations and raw-log hashes.
Audit starts no Java, does not require the old JAR path, and streams both logs
through the same pinned stack parser/classifier. It validates replay-derived
codes/statistics/warnings/verdicts/aggregation, while trusting schema-valid
wrapper observations such as exit/signal/timeout/cancellation metadata. This
is consistency auditing, not cryptographic attestation or independent execution.
