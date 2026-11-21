---
name: math-research
description: Formalize, verify and search mathematical arguments with Lean 4 — natural-language propositions become kernel-checked Lean statements with a graded fidelity record, proofs are searched under a fixed budget against Mathlib premise retrieval, and discovery loops gate candidate results behind an independent evaluator. Use for a Lean formalization of a stated theorem, a proof attempt that must be machine-checked rather than asserted, a Mathlib premise search, a computational check that has to be separated from a formal proof, or an experiment–conjecture–counterexample loop with recorded claim status. Do not use for prose-only mathematical exposition, for claims that no checker will verify, or as a substitute for the formal-design skill's TLA+/Lean modeling of protocol behaviour.
---

# Mathematical research

The main dialog owns the goal, the budget decision, fidelity escalations and
every claim-status judgement. This skill supplies a workflow and executable
checks. It adds no runtime gate, no MCP server, no settings surface, no new
model alias and no agent type: "tiers" below are delegation choices among the
existing pinned lanes. Read [formalize.md](references/formalize.md) before
writing a statement, [prove.md](references/prove.md) before a proof search,
[discover.md](references/discover.md) before a discovery loop,
[evidence.md](references/evidence.md) before reporting, and
[budget.md](references/budget.md) before the first reservation.

Three correctness kinds are kept apart and never merged into one verdict:
`computation_verified` (`pass` | `fail` | `not-applicable`),
`formal_proof_valid` (the Lean kernel's answer, and the only source of proof
correctness) and `statement_faithful` (graded: `anchored` | `human-confirmed` |
`model-assessed` | `disputed`). The design record is
[docs/plans/2026-11-21-mathematical-research-harness.md](../../../../../docs/plans/2026-11-21-mathematical-research-harness.md).

## Milestone gates (feature gate = file presence)

M0 is the shared foundation and every later milestone needs it. M1, M2 and M3
are stacked increments, not alternative modes: each section below activates
only when **all** of the scripts it names exist under
`${CLAUDE_SKILL_DIR}/scripts/`. Check with `ls` before promising a capability.

| Milestone | Required scripts | Provides |
| --- | --- | --- |
| M0 | `mathlib-env.mjs`, `mathlib-index.mjs`, `mathlib-search.mjs`, `lean-run.mjs`, `claim-ledger.mjs`, `budget-ledger.mjs` | environment, index, retrieval, L2 checker with proof binding, core claim states, budget ledger |
| M1 | M0 + `math-verify.mjs`, `sympy-run.mjs` | three-layer verification, fidelity gate, `anchored` grade |
| M2 | M1 + the search state contract (`search.json`, `attempts/`) | budgeted proof search, repair rounds, scaffolding |
| M3 | M2 + `experience.mjs` | discovery loop, evaluator gate, extended claim table |

A missing script is a missing capability: report it and stop that step. Never
imitate a check in prose, never widen a claim to cover a step that did not run,
and never silently select a weaker path — the wallet and the ledger both record
what actually executed. There is no settings flag and no environment variable
that turns a milestone on.

## Run directory and manifest

Everything lives under the workspace by default — `.math/` in the project cwd,
git-ignored, relocatable with `MATH_HOME`. Feature-detect writability at start
and fail closed; do not retry into `$HOME`.

`.math/runs/<run-id>/` holds `run-manifest.json` (strict schema; unknown fields
rejected), `problems/<problem-id>/`, `population/`, `claims.jsonl`,
`budget.json`, `evidence/` and `report.md`. Written defaults:
`budget.attempts=8`, `budget.tokens=200000`, `budget.wallClockMs=1800000`,
`allowHumanFidelity=false`, `tierPolicy="main"`, `discovery=null`. The manifest
carries all configuration: this skill reads no ambient setting, and a run whose
manifest is missing or holds an unknown field does not start.

Per problem: `statement.md` (user-supplied, read-only), `statement.lean`
(`theorem <id>_stmt : <prop> := sorry`, checked in statement-check mode only),
`proof.lean` (self-contained, redeclares the theorem, imports Mathlib modules
only), `meta.json`, `fidelity.json`, `binding.json`, `search.json`,
`attempts/`.

## M0 core

1. Provision, once per pinned environment:
   `node "${CLAUDE_SKILL_DIR}/scripts/mathlib-env.mjs" --pin <mathlib-pin.json>`.
   A valid receipt is reused as-is; an invalid one is a hard error, never a
   silent rebuild. The pinned Mathlib revision selects the Lean version through
   its own `lean-toolchain`; a mismatch is `config-invalid`. Nothing downloads
   after provisioning starts unless a receipt is absent.
2. Build the index for that environment:
   `node "${CLAUDE_SKILL_DIR}/scripts/mathlib-index.mjs" --env <env-id>`.
   Idempotent per receipt; it emits declarations and per-module import edges.
3. Formalize into the problem directory. Write the natural statement first,
   then the Lean statement with `:= sorry`, then `binding.json` naming
   `statementDeclName`, `proofDeclName`, `mathlibRev` and `toolchainDigest`.
   Naming convention: `<problemId>_stmt` and `<problemId>_proof`.
4. Retrieve premises:
   `node "${CLAUDE_SKILL_DIR}/scripts/mathlib-search.mjs" --query "<shape or type fragment>" --imports problems/<id>/proof.lean --top 20 --json`.
   Empty results are a legitimate empty array (exit 0); an FTS5 syntax error
   exits 2 with the raw error. `--imports` restricts to the transitive import
   closure of that file — the import set is extensible, so add imports and
   re-retrieve rather than guessing a premise is absent.
5. Check the statement artifact:
   `node "${CLAUDE_SKILL_DIR}/scripts/lean-run.mjs" --problem <dir> --mode statement-check`.
   This mode tolerates the `sorry` warning and records the elaborated type; the
   proof-checking mode never imports the sorry-ed declaration.
6. Prove and check (M2 loop) and record the outcome. A goal closes only when a
   proof artifact passes the full L2 check bound to that goal's statement.
7. Write claims through `claim-ledger.mjs` and charges through
   `budget-ledger.mjs`. Only the main conversation writes shared state; a
   delegated child writes only its own attempt directory and returns files.

All result paths print one line of JSON on stdout and exit 0; `--help` prints
text. Parse the JSON; never scrape the log.

## M1 formalization and fidelity gate

Activates when `math-verify.mjs` and `sympy-run.mjs` exist. Verification is
three independent layers — L2 formal proof, L1 computation, L3 semantic
fidelity — with one verdict each. The kernel pair-equivalence proves only that
two formalizations agree with each other; it never upgrades fidelity and is
recorded as advisory `pairEquivalence`. The gate, its nine-row decision table,
the `disputeReason` values and the single pre-commitment retry window are in
[formalize.md](references/formalize.md). Fidelity escalation happens only in the
main conversation through `ask_user_question`; a delegated child has no ask
channel. With `allowHumanFidelity: false` a committed dispute is terminal
`fidelity-failed`.

L1 isolation tiers are recorded per run: `full` (network-isolated, authoritative
— a failure may serve as counterexample evidence) and `partial` (in-session,
advisory — feeds repair prompts only). A partial run that claims `fail` is a
ledger error. Absent Python ≥3.10 with sympy, `computation_verified` is
`not-applicable`, never `pass`.

## M2 proof search

Activates when the search state contract is present. At most 2 repair rounds per
attempt, each consuming that attempt's envelope rather than a new attempt id.
First 2 attempts serial, then parallel branches. A subgoal scaffold carries a
required connecting implication and a depth cap of 3 that terminates the branch,
not the problem. Reservations are made only by the main conversation, strictly
before dispatching a child, and a reservation exceeding `maxAttempts` is
refused. Resume order is fixed: reconcile `running` attempts by result hash
first, then roll back unsettled intents — and rollback never refunds. Details in
[prove.md](references/prove.md) and [budget.md](references/budget.md).

## M3 discovery

Activates when `experience.mjs` exists. The loop selects parents with a seeded
RNG, mutates programs, gates every individual behind the evaluator, and inserts
scored results as new snapshots. The evaluator must pass user-supplied trusted
examples before the loop starts, and every claimed invariant gets an independent
second implementation — two model-generated implementations agreeing is weak
evidence, not proof. Only then does a candidate generate a claim. The extended
claim table (`experiment-supported`, `revalidation-pending`) and its transitions
arrive with this milestone; the ledger rejects unknown states by explicit
enumeration. See [discover.md](references/discover.md).

## Claims, receipts and reporting

Chain-hashed `claims.jsonl` is the record; any field edit breaks `--verify`.
Transitions require typed verification records produced by the verifier scripts,
never by assertion. `evidence/<claimId>/<kind>/` plus `RECEIPT.json` (file
sha256s, generating command, timestamp) back every reported claim;
`report.md` shows the receipt verification result. Novelty is advisory, never a
gate, and carries the qualifier that it is not a mathematical novelty claim.

At close-out, durable conclusions go to `memory_save` per
[evidence.md](references/evidence.md): one fact per topic file, name slug fixed,
type mapped from the claim kind.

## Limits

- The kernel decides proof correctness. Nothing else does, and no model
  judgement certifies a proof.
- Fidelity checks 1 and 3 are model judgements; a false accept is possible and
  is measured, not assumed away. `anchored` is the only grade that removes the
  model from the loop, and only when a trusted reference exists.
- Token consumption after dispatch is cooperatively bounded (envelopes are
  prompt-level instructions, not mechanical ceilings); the admission rule is
  exact and tested.
- Proof search is attempt-level. There is no tactic-level interactive state, no
  Lean IDE and no MCP server in v1.
- Re-running a proof search is not bit-reproducible: seeded selection is
  reproducible, model-generated programs are not.
