# Design: input-admission-governance-probes (negative controls)

- Program: context-engineering input governance (docs 1+7)
- Parent model: `specs/tla/input-admission-governance` (shared `Model.tla`)
- Status: deliberately red by design

## Purpose

This directory carries the **fault-injection negative controls** that were
part of the parent model's manifest until the bridge split. The runner's
aggregate rule is "every case verified, core and expansion alike", and the
combined-evidence contract for the bridge (`specs/formal/input-admission-governance`)
requires the bridged model's aggregate to be `verified`. A model whose
manifest contains deliberately-red probes can therefore never carry a
combined-evidence package — so the probes live here, next to the parent,
and the parent keeps the green cases.

**The aggregate of this model is expected to be `counterexample`** — each
strict case exits 12 by fault injection. That is the evidence, not a failure.

## Probe cases

| case | fault switch | invariant it falsifies | r1 defect it demonstrates |
|---|---|---|---|
| strict-commit-at-check | `CommitAtCheck` | `DedupeCommitted` | check-time state advance poisons later same-key admissions |
| strict-unknown-as-advisory | `UnknownAsAdvisory` | `NeverTouched` | classifying unknown kinds advisory lets budget trim drop passthrough content |
| strict-observe-mutates | `ObserveMutates` | `ObserveClean` | observe mode writing the real pipeline outcome mutates the real batch |
| strict-sentinel-commit | `CommitAtCheck` | `AdmittedEverCommitted` | the never-admitted sentinel committed at check time |

The `convention` case is included because the manifest schema requires at
least one core case; it re-verifies green here and keeps this directory
independently re-runnable.

## Files

- `Model.tla` — byte-identical copy of the parent's module (the fault
  switches are CONSTANTS, so one module serves both manifests).
- `checks.json` — convention + the four strict cases.
- `cases/*.cfg` — generated.

The full modeling history, invariants, bounds and assumptions live in the
parent's `design.md` / `implementation.md`.
