# Formalize — statement artifacts and the fidelity gate

Operational contract for statement-check mode (`lean-run.mjs --statement-check`),
`anchor-check.mjs`, `fidelity-gate.mjs` and the measurement protocol
(`fidelity-measure.mjs`) — design §4.1 and §4.3. Read this before writing a
statement; the gate's grade is what a claim is allowed to rest on.

## Statement artifacts (§4.1)

```
statement.md     # the original NL proposition: user-supplied, read-only
statement.lean   # theorem <problemId>_stmt : <prop> := sorry   (sorry REQUIRED here)
proof.lean       # SELF-CONTAINED: redeclares the full theorem <problemId>_proof
binding.json     # { statementDeclName, proofDeclName, mathlibRev, toolchainDigest }
fidelity-input.json   # the model judgments + the anchor outcome (below)
fidelity.json         # the gate's decision (written by fidelity-gate.mjs)
```

```
node "${CLAUDE_SKILL_DIR}/scripts/lean-run.mjs" --problem <dir> --env <env> --statement-check
```

Statement-check is the ONLY mode that tolerates the `sorry` warning; it records
the elaborated type of `statementDeclName` into `binding.json`
(`statementTypeText`). Proof checking never imports the sorry-ed declaration.
Two propositions are ALWAYS compared by the kernel's definitional equality —
never by string comparison, and never by model judgement.

## The three checks (§4.3)

1. **Back-translation** (model judgement): `statement.lean` → NL, compared with
   `statement.md`. Record `{ equivalent: true | false | "uncertain", differences }`.
2. **Dual formalization** (machine, pair-level only): the kernel-checked
   equivalence of `statement.lean` and a differently-prompted `statement-b.lean`,
   recorded as advisory `pairEquivalence: equivalent | unknown | skipped`. It
   proves only that two formalizations agree WITH EACH OTHER — both can share a
   mistranslation — so it never upgrades fidelity and is not a grade input.
3. **Premise audit** (model judgement): explicit and implicit premises of
   `statement.md` diffed against the hypotheses in `statement.lean`. Record
   `{ missing: [...], extra: [...] }`; empty on both sides is "clean".

The **anchor check** is the machine half of check 3's resolution: a trusted
reference formalization from the benchmark fixtures, compared to the recorded
statement type by the Inspector definitional-equality path (a reference may be
`sorry`-ed; type equality needs no proof, and the reference is not a claim of
this run, so no axiom audit runs).

## fidelity-input.json (strict; unknown fields are `config-invalid`)

```json
{
  "schemaVersion": 1,
  "pairId": "proofnet-42",
  "corrupted": false,
  "backTranslation": { "equivalent": true, "differences": [] },
  "premiseAudit": { "missing": [], "extra": [] },
  "pairEquivalence": "equivalent",
  "anchorCheck": { "status": "passes", "evidenceRef": "anchor-check.json" },
  "retryCount": 0
}
```

- `backTranslation.equivalent` is `true`, `false`, or the string `"uncertain"`.
- **Omit or `null` a model check** to record that it FAILED TO RUN (row 9).
  **Omit `anchorCheck`** (or `status: "not-run"`) to record that no reference
  exists (row 1); `status: "cannot-run"` means a reference exists but produced
  no kernel verdict (row 4). The two are different rows and different reasons.
- `pairEquivalence`, `pairId`, `corrupted` are recorded as advisory/measurement
  data and passed through into `fidelity.json`. `retryCount` is the gate's
  pre-commitment retry bookkeeping (below).

## The nine-row decision table

| # | back-translation | premise audit | anchor check | grade | disputeReason |
|---|---|---|---|---|---|
| 1 | equivalent | clean | not run (no reference) | `model-assessed` | — |
| 2 | equivalent | clean | kernel check passes | `anchored` | — |
| 3 | equivalent | clean | kernel check FAILS | `disputed` | `anchor-failed` |
| 4 | equivalent | clean | cannot run | `disputed` | `infra-failure` |
| 5 | equivalent | differences | — | `disputed` | `model-judgment` |
| 6 | uncertain | clean | — | `disputed` | `model-judgment` |
| 7 | uncertain | differences | — | `disputed` | `model-judgment` |
| 8 | false | any | — | `disputed` | `model-judgment` |
| 9 | any check failed to run (either check) | | | `disputed` | `infra-failure` |

## Grade semantics

- `anchored` — row 2 only: a trusted reference exists and the kernel-checked
  equivalence passes. The reference is the semantic anchor. Supports `proven`.
- `human-confirmed` — a human confirmed equivalence through the §3.3 escalation
  channel (the confirmation record is required). Supports `proven`.
- `model-assessed` — row 1 exactly: check 1 = `equivalent`, check 3 = clean, AND
  no reference exists. Supports only `proven-of-formal-statement`.
- `disputed` — everything else. `uncertain` is never a pass: check 1 must be
  `equivalent` for any non-disputed grade.

`disputeReason` distinguishes evidence from tooling failure in every report:
`anchor-failed` = kernel evidence of infidelity; `model-judgment` = rows 5–8;
`infra-failure` = rows 4/9, where the tooling produced no evidence at all.

## Escalation and the retry window

- An `infra-failure` outcome is retried INSIDE the gate, BEFORE any dispute is
  committed. The first infra outcome writes nothing and exits `3`, naming the
  checks to re-run; re-perform them and re-run the gate with `retryCount: 1`.
  Only a second infra outcome commits `disputeReason=infra-failure`, and a
  COMMITTED dispute is never retried — the window is strictly pre-commitment.
- `allowHumanFidelity=false` → a committed dispute is terminal `fidelity-failed`.
  `allowHumanFidelity=true` → `escalation: "human-escalation"`: ask the user,
  then record the outcome as a `human-ruling` record in the claim ledger.
- Fidelity escalation happens ONLY in the main conversation (`ask_user_question`,
  §3.3). A delegated child has no ask channel: it records its judgment and
  returns files.
- **L1/L2 conflict** (§4.4, §6.3): an authoritative full-isolation L1 failure
  while L2 passes sets `statement_faithful=disputed` and emits a
  `counterexample` (full isolation) plus `dispute` record; `math-verify.mjs`
  exits `4`. Escalate or terminate — the conflict is never silently resolved,
  and the counterexample record blocks promotion to `proven`.

## Commands

All result paths print one line of JSON on stdout; `--help` prints text.

```
node "${CLAUDE_SKILL_DIR}/scripts/lean-run.mjs" --problem <dir> --env <env> --statement-check
node "${CLAUDE_SKILL_DIR}/scripts/anchor-check.mjs" --problem <dir> --env <env> \
     --reference <reference.lean> --reference-decl <referenceDeclName> \
     [--patch <dir>/fidelity-input.json]        # status: passes | fails | cannot-run
node "${CLAUDE_SKILL_DIR}/scripts/fidelity-gate.mjs" --problem <dir> [--allow-human-fidelity]
node "${CLAUDE_SKILL_DIR}/scripts/math-verify.mjs" --problem <dir> --env <env> \
     [--computation <checker.py>] [--records <records.json>]
node "${CLAUDE_SKILL_DIR}/scripts/fidelity-measure.mjs" --gate-dir .math/runs/<run-id>/problems \
     [--annotations <labels.jsonl>] [--out measurement.json]
```

Exit codes: `fidelity-gate` `0` decided · `3` retry pending (nothing written) ·
`2` blocked. `anchor-check` `0` outcome recorded (passes/fails/cannot-run) ·
`2` blocked. `math-verify` `0` verified · `4` L1/L2 conflict (escalate) · `3`
fidelity retry pending · `2` blocked (`fidelity-missing`,
`isolation-violation`, `config-invalid`, `io`).

## Measurement protocol (§4.3)

Unit is the immutable `(NL statement, formal statement)` pair. "Accepted" = the
gate's grade is `model-assessed` or better, measured BEFORE any human escalation.
Sample: every gate output of the ProofNet subset plus ≥10 blind seeded
corruptions (dropped hypothesis / weakened conclusion / swapped quantifier),
tracked by the `corrupted: true` flag passed through from `fidelity-input.json`.
Double annotation (two humans; rubric `faithful` / `meaning-changed` /
`unjudgeable`), disagreements adjudicated by a third human pass recorded with
`adjudicated: true` — unadjudicated disagreement is rejected, never resolved by
the script. `unjudgeable` pairs leave BOTH conditional denominators and are
reported as their own rate. Denominators are reported separately for natural
outputs and corruptions, with both conditional rates: `P(accepted | corrupted)`
(the false-accept surface) and `P(corrupted | accepted)`, plus the rubric
confusion counts. The report is a measurement of the gate, not a guarantee: a
false accept is possible and is measured, not assumed away.
