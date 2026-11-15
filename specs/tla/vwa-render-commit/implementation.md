# Implementation: vwa-render-commit

Model: `specs/tla/vwa-render-commit` (module `Model`). Design: `design.md` in this directory.
Behavioral source: `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §4.2, §4.3, §4.5,
§7.1, §7.2, §10.1.

## Status

Core case `convention` — **verified** (TLC completed its check; no violation of the checked
properties under the stated bounds and abstractions).

Probe cases live in the sibling directory `specs/tla/vwa-render-commit-probes` and are expected to
produce counterexamples; they are not part of this model's aggregate.

## Run lineage

| Step | What changed | Result |
|---|---|---|
| R1 | first run of the initial draft (three-stage protocol, no render intent) | all cases `config-invalid` — TLA+ comments were nested, SANY aborted |
| R2 | comments de-nested (every comment a single well-formed block) | `convention` verified; 4 of 6 probes counterexample, `strict-overwrite-foreign` and `strict-adopt-without-render` verified (probes unreachable) |
| R3 | added `PresentForeign` (a user file can pre-exist) and made the adopt probe clear its own bookkeeping | 6/6 probes counterexample, `convention` verified |
| R4 | `PresentForeign` was missing `phase` in its `UNCHANGED` list (`phase = null` states) | fixed; `convention` verified, 6/6 probes counterexample |
| R5 | the adopt probe also cleared the intent, so the stale-adoption window is observable | `convention` verified, 6/6 probes counterexample |
| R6 | probe cases split into the sibling model; `design.md` written as a real screening record | `convention` verified (`inputDigest` re-stamped) |

Run identifiers and per-case statistics are in `.formal-design/runs/vwa-render-commit/<runId>/`
(gitignored, not citable) and in the evidence file written by the runner; this table records the
lineage only.

## Modeling defects found and fixed during modeling

1. **Nested TLA comments** (`(*` inside a `(* … *)` block) — TLA+ comments do not nest, so SANY
   reported `EOF reached, possibly open comment`. Fixed by making every comment block single-level.
2. **Unreachable probes**: `strict-overwrite-foreign` could never be violated because nothing in the
   spec could produce a pre-existing file at the deliverable path. Fixed by adding `PresentForeign`.
3. **Vacuous probe**: `strict-adopt-without-render` cleared nothing, so a later `intents ≠ {}` guard
   made `AgreementWhenQuiescent` vacuous. Fixed by modelling the bug faithfully — it believes it
   committed and clears its own bookkeeping.
4. **Undefined variable in an action**: `PresentForeign` omitted `phase` from `UNCHANGED`, producing
   states with `phase = null`. Fixed.

These are modeling defects, not design defects: none of them changed the design's semantics.

## Semantics pinned to code (for the implementation handoff)

| Model element | Code symbol |
|---|---|
| `Stage` (intent then bytes) | `commit` stage 1 (`store.ts:466-473`) preceded by the §7.1 intent write |
| `RevStep` / `OpStep` / `HeadStep(q)` | `commit` stages 2, 3, 4 (`store.ts:474-492`) |
| `Finish` | `commit` stage 5 read-back (`store.ts:493-497`) |
| `Crash` / `Recover` | `recoverOrphans` (`store.ts:365-382`) and the §7.4 "re-run the bind" remedy |
| `UnrelatedTx` | any other artifact's transaction between a crash and the retry |
| `ReadCheck` | the §7.2 three-state classification at `tools.ts:371-376`, `commands.ts:320-322`, `report.ts:235-250` |
| `NoTornOutput` | staged write is temp + fsync + rename (`store.ts:466-473`) |
| `NoLostUserFile` | §4.3 overwrite gate |

## Unmodeled scope (deliberate)

Marker-strip offset arithmetic, path canonicalization and symlink containment, the review pipeline
itself, and the receipt ledger. Each is covered by unit/fixture tests named in the design's test plan
(§13), not by this state machine.
