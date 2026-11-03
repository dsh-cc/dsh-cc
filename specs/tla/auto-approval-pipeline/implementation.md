# Implementation: auto-approval-pipeline

Model `specs/tla/auto-approval-pipeline`, safety-only, no production change.

## Runner and toolchain

- runner package `@dsh-cc/plugin-dsh-cc-agents@0.9.3-rc.4`, TLC 1.7.4 (bundled
  JAR, SHA-1 pinned), Java 25 on darwin.
- Fixed runner flags per case (`-workers 1 -seed 1 -fp 0`), limits from
  `checks.json`.

## Final run

- runId `20261103T020233Z-4d5a143b-31c7-4db6-b26c-958acf452f53`
- `convention` **verified**: 16,019,337 states generated, 221,504 distinct,
  0 left on queue, 22.6 s.
- six expansion probes each produced their expected counterexample.
- `check-evidence`: valid, fresh, verification `counterexample` (every probe is
  red by design).

## Counterexample dispositions (all six probes)

| Case | Invariant | Firing step | Disposition |
|---|---|---|---|
| strict-honor-suspended | `SuspendedInert` | `EvaluateRules` authorizes a suspended shape | fault demonstration: today's filter drops the rule, so the probe shows what honoring it would cost |
| strict-arbitrate-rule-ask | `RuleAskNeedsHuman` | `SettleApply` executes a rule ask on an LLM allow | fault demonstration of the eligibility guard |
| strict-apply-stale-mode | `StaleVerdictOnly` | `SettleApply` applies a verdict across a mode change | fault demonstration of the stale-mode re-fold |
| strict-silent-allow-failure | `FailToPrompt` | `SettleApply` turns a timeout into an allow | fault demonstration of fail-to-prompt |
| strict-grant-first | `NoExecAfterDeny` | `GrantFirstAllow` executes under a matching deny rule | fault demonstration of deny dominance |
| strict-no-backstop-trip | `BackstopHolds` | `SettleApply` records the trip but leaves auto | fault demonstration of the backstop downgrade |

All six are deliberate fault switches: unlike the memory model, these are not
claims that the current code does the wrong thing. The code has all six guards;
the probes pin that each guard is load-bearing.

## Modeling defects found while drafting (all fixed)

1. `SettleClassify` was written as one action with a nested `UNCHANGED`, which
   left the applied-mode assignment ambiguous; split into `SettleStale` and
   `SettleApply`.
2. `GrantFirstAllow` and `GrantAllow` omitted `grant` from their `UNCHANGED`
   lists, so TLC explored unconstrained states (`property-evaluation-failed`).
3. `"breaker"` was missing from `ClsOutcomes` although `StageUnavailable`
   assigns it (`TypeOK` violation).
4. `BackstopHolds` ignored that a user may deliberately re-enter auto mode;
   `ModeChange` now clears `tripped` when it selects auto, which is the
   intended semantic ("the backstop is a session downgrade, not a ban").
5. `denyStreak` could exceed `MaxDenies`, leaving its declared type.
6. With `ArbitrateRuleAsk`, a rule ask still routed to the `asked` phase, so the
   fault was unreachable and the probe verified vacuously; the ask now routes
   to `eligible` under the fault.

## Run lineage

| runId | Outcome | Note |
|---|---|---|
| `20261103T015841Z-c07dbc39` | error | unconstrained `grant` (defect 2) |
| `20261103T015900Z-9bd2ab76` | counterexample (convention) | `TypeOK` — missing breaker outcome (defect 3) |
| `20261103T015920Z-bb6584a1` | counterexample (convention) | `BackstopHolds` — manual auto re-entry (defect 4) |
| `20261103T020023Z-516cc2f1` | counterexample (convention) | `TypeOK` — `denyStreak` overflow (defect 5) |
| `20261103T020123Z-04fcf343` | verified (convention); `strict-arbitrate-rule-ask` verified | vacuous probe (defect 6) |
| `20261103T020233Z-4d5a143b` | verified (convention), six probes red | final |

## Coverage check

Every matrix row has a case: S-1 via `strict-grant-first`, S-2 via
`strict-silent-allow-failure`, S-3 via `strict-arbitrate-rule-ask`, S-4 via
`strict-apply-stale-mode`, S-5 via `strict-honor-suspended`, S-6 via
`strict-no-backstop-trip`, REQ-7 structurally in the convention case. No
property was weakened to reach green: five convention failures were model
defects, and the sixth (a vacuously verified probe) was fixed by making the
fault reachable rather than by dropping the property.

## Not verified

- liveness (L-1 exclusion).
- the classifier LRU, the breaker half-open probe lifecycle, the gauge lane,
  parser/shell-splitting internals, and the sandbox-escalation approval listener
  (E-1..E-6).
- the rule set is not re-read after the classifier await; that window is
  documented in `design.md` as an open question, not modeled as a fault.
- implementation conformance: the model does not prove the TypeScript matches.

## Review state

Not yet dispatched to a formal review lane.
