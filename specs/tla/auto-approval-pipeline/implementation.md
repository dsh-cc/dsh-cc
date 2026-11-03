# Implementation: auto-approval-pipeline

Model `specs/tla/auto-approval-pipeline`, safety-only, no production change.

## Runner and toolchain

- runner package `@dsh-cc/plugin-dsh-cc-agents@0.9.3-rc.4`, TLC 1.7.4 (bundled
  JAR, SHA-1 pinned), Java 25 on darwin.
- Fixed runner flags per case (`-workers 1 -seed 1 -fp 0`), limits from
  `checks.json`.

## Final run

- runId `20261103T031608Z-fe774bfe-f2ff-47bd-ab93-dbe1ba847f2c`
- inputDigest `57c4718cad8064a9…` (the previous run `20261103T021409Z-6ef4237d` differed only in design.md text and produced identical per-case statistics)
- `convention` **verified**: 33,259,281 states generated, 342,256 distinct,
  0 left on queue.
- seven expansion probes each produced their expected counterexample.
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
| strict-ignore-grant-ceiling | `GrantCeiling` | `GrantAllow` executes a MEDIUM call by grant | fault demonstration of the grant risk/mode guard |

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

## Review folds (cold review r1, GO-WITH-CHANGES)

Four P1 findings were folded; each is visible in the model and the design doc:

1. the grant eligibility guard (risk = LOW, mode != plan) was missing — added to
   `GrantAllow` as `GrantCeiling` with the `IgnoreGrantCeiling` probe;
2. the plan-mode deny wrap over a leftover ask/passthrough was missing and was
   mislabeled as an exclusion — now part of `EvaluateRules` (`PlanWrapSound`);
3. the package-runner suspension class was missing — added as the `pkgRunner`
   shape;
4. a bypass-immune deny under bypassPermissions left the model without a
   successor instead of denying — now `BypassImmuneDeny`, with E-1 recording
   that the real enforcement is the monotonic guard layer.

P2 folds: the MEDIUM-passthrough session allow (`SessionAllowMedium`), the
classifier being one-shot (a discarded stale verdict no longer re-classifies),
the unarmed stage (`StageUnarmed`), and the `SilentAllowFailure` fault no longer
swallowing a legitimate ask verdict. Left as recorded limitations: the backstop's
20-total rule (E-7) and the `cd`/`ls` exemption (E-8).

## Review folds (cold review r2, GO-WITH-CHANGES)

1. **P1 — the bypass-immune deny was modeled only under `bypassPermissions`.**
   The code's guard is mode-independent (`evaluate.ts` `foldDecision` denies
   regardless of mode, and `decide.ts:150-157` passes an empty set to the
   waterfall), so a bypass-immune call under `default` or `plan` would execute
   in the model but is denied in code. `EvaluateRules` now denies a
   bypass-immune call in every mode and `BypassImmuneDeny` is gone.
2. **P2 — a stale-mode discard left a stranded call.** It now falls through to
   the human prompt, which is what the code does.
3. **P2 — documentation**: the suspension filter is applied in every non-bypass
   mode while the code applies it only in auto (E-8, conservative direction),
   and D13 `secondPass` is declared (E-9).

## Run lineage

| runId | Outcome | Note |
|---|---|---|
| `20261103T015841Z-c07dbc39` | error | unconstrained `grant` (defect 2) |
| `20261103T015900Z-9bd2ab76` | counterexample (convention) | `TypeOK` — missing breaker outcome (defect 3) |
| `20261103T015920Z-bb6584a1` | counterexample (convention) | `BackstopHolds` — manual auto re-entry (defect 4) |
| `20261103T020023Z-516cc2f1` | counterexample (convention) | `TypeOK` — `denyStreak` overflow (defect 5) |
| `20261103T020123Z-04fcf343` | verified (convention); `strict-arbitrate-rule-ask` verified | vacuous probe (defect 6) |
| `20261103T020233Z-4d5a143b` | verified (convention), six probes red | reviewed; four P1 folds followed |
| `20261103T021140Z-3a76d0f5` | error | a whole-record assignment mixed with a field assignment |
| `20261103T021218Z-7c9767df` | counterexample (convention) | `GrantCeiling` compared the live mode instead of the decision mode |
| `20261103T021314Z-b2a9a55b` | counterexample (convention) | `PlanWrapSound` — the wrap missed the pure-passthrough branch |
| `20261103T021409Z-6ef4237d` | verified (convention), seven probes red | after the r1 folds |
| `20261103T021621Z-13749efc` | verified (convention), seven probes red | reviewed; the r2 folds followed |
| `20261103T031443Z-a57b621f` | verified (convention), seven probes red | after the bypass-immune and stale-discard folds |
| `20261103T031608Z-fe774bfe` | verified (convention), seven probes red | final: design.md notes only |

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
