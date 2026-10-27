---
name: formal-design
description: Verify protocol, state-machine and high-impact deterministic designs before the existing design review, with bounded TLA+ models and Lean proofs. Use for independent actors changing shared state where event ordering matters; retry, timeout, duplicate or late messages; crash recovery involving ownership, deduplication or persistence order; authorization, leases and resource ownership spanning asynchronous changes; permission, policy, eligibility or configuration composition with a stated invariant; budget, quota, allocation or ranking arithmetic with a stated conservation, bound or ordering requirement; a deterministic transformation needing a general correctness property; or an explicit request for TLA+ or Lean verification.
---

# Formal design

The main dialog owns requirements, modeling, counterexample interpretation and
approval decisions. This skill supplies a workflow and executable checks. It
adds no runtime gate, new reviewer lane, agent type, settings or startup hook.
Read [modeling-guide.md](references/modeling-guide.md) and
[review-contract.md](references/review-contract.md) before modeling or review.
Read [lean-modeling-guide.md](references/lean-modeling-guide.md) and
[lean-conformance.md](references/lean-conformance.md) before a Lean model, and
[combined-models.md](references/combined-models.md) when both backends apply.
Use the [worked example](examples/task-lifecycle/workflow.md) as an illustration,
not as actual evidence or approval.

## First use and screening

1. Read only the effective project rules available in this session. Record
   their source/revision, screening adoption and review-rule availability in
   implementation.md or the existing workflow record before a model exists.
   Do not infer a roster from historical rules. Surface a conflicting skill
   named formal-design instead of guessing which copy is active.
2. State one first-use notice: screening adopted and review rules available;
   screening unconfirmed with the exact snippet path to adopt; or review
   rules missing with the rule source that could not be loaded. Say what may
   proceed and which gate is blocked. Repeat when that observed state changes.
   Availability alone does not enable project-wide screening. Manual adoption
   uses `${CLAUDE_SKILL_DIR}/references/agents-snippet.md`; never auto-edit
   AGENTS.md or CLAUDE.md. Missing review rules permit modeling, not a claim
   of workflow approval or an invented reviewer roster.
3. After forming an initial design, screen before the project's existing
   formal design review. First ask whether protocol/state-machine behavior
   changes. Enable TLA+ when any applies: FD-T1 independent actors and
   shared-state ordering; FD-T2 retries/timeouts/duplicate or late messages
   affecting an outcome/effect; FD-T3 crash recovery affecting ownership,
   deduplication or persistence order; FD-T4 authorization/lease/resource
   ownership across asynchronous changes. Also enable Lean when any applies:
   FD-L1 permission, policy, eligibility or configuration composition with a
   stated invariant whose violation changes authorization or effective
   behavior; FD-L2 budget, quota, allocation, accounting or ranking arithmetic
   with a stated conservation, bound, monotonicity or ordering requirement;
   FD-L3 a deterministic transformation or algorithm with a requested general
   correctness property, or a previously verified Lean contract that changes;
   FD-L4 an explicit request for Lean verification. Existing modeled behavior
   changes also trigger. Mere determinism does not trigger Lean: the record
   must name the business property and the consequence of violating it.
   Formatting, pure layout and behavior-preserving refactors do not trigger by
   default.
4. Select backends: `tla` for event ordering, cancellation, retries, ownership
   and recovery; `lean` for high-impact deterministic rules or algorithms;
   `both` when both kinds of behavior apply; `none` for formatting, layout and
   ordinary low-risk glue. These are engineering selection rules, not language
   expressiveness limits. Passing one backend never substitutes for a missing
   or failing obligation in the other, and a failing or absent tool never
   silently selects the cheaper backend. Lean evidence is the proof statements
   under recorded definitions, assumptions and allowed axioms plus a finite
   implementation conformance corpus; it never proves arbitrary TypeScript
   equivalent to the model.
5. Record the current Formal design section in design.md: mode
   auto|required|off, decision enabled|not-needed|waived, triggerIds,
   `backends` (ordered subset of `["tla","lean"]`), `modelDirs` (exactly the
   selected backend keys), rationale, `modelDir` for TLA-only compatibility
   and verbatim userDirective when present. For `not-needed` or `waived`,
   record selected scope and rationale without claiming successful
   verification. No runner reads Markdown to authorize execution.
   Auto-enablement needs a brief notice, not another permission round-trip.
   Ask business questions only where ambiguity changes the properties.
   Explicit task instructions take priority; report a conflict with mandatory
   project rules and obtain a scoped decision rather than silently choosing.
6. Re-screen requirements, design revisions, reviewer requests and reported
   implementation deviations that change behavior. Confirm scope again before
   formal dispatch and executor handoff. not-needed is not permanent; a waiver
   covers only its recorded scope. New relevant behavior returns to modeling,
   checking and review. Keep superseded history outside digested inputs.

## Model, check, review, implement

1. Main dialog writes specs/tla/<model-id>/{design.md,checks.json,Model.tla}.
   Follow the modeling guide, including the complete planned coverage matrix,
   real atomicity mechanisms, justified assumptions and adverse traces that
   challenge critical abstractions. Exploratory modeling is not executor work.
   A critic may advise read-only; model ownership stays with the main dialog.
2. As a separate manual project edit, add `/.formal-design/` and
   `specs/**/conformance-evidence.json` to .gitignore once. No runner edits
   .gitignore. Runner writes are restricted to generated cfgs/evidence/
   current-run under specs/tla and specs/lean and artifacts under
   .formal-design. Main-dialog/executor edits also maintain design, cfgs and
   implementation.md.
3. Obtain Node (repository requirement ^22.19 or >=24), Java >=17 and the
   bundled TLC JAR pinned by scripts/toolchain.json. No JAR configuration is
   required by default. Selection is --jar > TLA2TOOLS_JAR > the bundled
   toolchain/tla2tools.jar, resolved relative to this skill. A configured path
   or checksum failure blocks; never silently fall back. All sources must
   match the pin. Nothing downloads or scans for a JAR. Without --java use
   PATH java. Preflight is read-only and starts no model check.

```sh
node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs" --project "$PROJECT" --model specs/tla/task-lifecycle
node "${CLAUDE_SKILL_DIR}/scripts/check.mjs" --project "$PROJECT" --model specs/tla/task-lifecycle
node "${CLAUDE_SKILL_DIR}/scripts/check-evidence.mjs" --project "$PROJECT" --model specs/tla/task-lifecycle
```

4. Inspect generated cfg bytes and commit them with checks.json. A differing
   existing cfg blocks; never overwrite reviewed material automatically. To
   change it, inspect and explicitly remove only changed declared cfgs, run
   preflight/check, then review the diff. Completed cfgs survive generation
   failure; repair and retry only absent paths. Skipped cfg generation only
   means every declared cfg already matched — it says nothing about the check
   result, and blocked or cancelled runs also skip generation. See the guide
   for cancellation, locks and I/O recovery.
5. Read the full actual results. Every configured case, core AND expansion,
   must be verified. Audit must report valid/fresh/verification=verified for
   that same run. Exit 0 from check-evidence means integrity and freshness,
   not verification success. Missing tools, timeout, unknown output, errors,
   failed/not-run expansion cases or incomplete evidence block admission.
   After repeated blockage without new information, report options rather
   than looping or auto-waiving after a retry count.
6. Replay counterexamples and classify design defect, modeling defect or
   requirement ambiguity. Revise the corresponding inputs and re-check.
   Never delete properties, assume away a real fault, remove failing actions
   or shrink scope merely to pass. Justify property/assumption/bound changes
   in design.md. Keep run IDs, tool metadata, reviews and observed acceptance
   mappings in implementation.md, outside inputDigest.
7. Check every coverage row and resolve findings. verified is a tool verdict,
   not model sufficiency. Only then dispatch the existing formal review with
   one complete same-run package to all required lanes. Reviewer identity,
   dispatch, pass criteria and approvals come from effective project rules;
   this skill does not duplicate them. Follow the full-log and actual-channel
   preparation/receiver contract in references/review-contract.md.
8. After the existing approval requirements pass, hand off the approved
   inputDigest, design path, fresh complete evidence, implementation plan,
   property/action → code/test mapping and regression commands/assertions.
   Executor implements pinned semantics and runs designated checks. It must
   report Blockers and pause affected work if atomicity, assumptions or
   semantics cannot be preserved; it must not edit the model to fit the code.
   Formal modeling alone does not select marathon; use existing routing.
9. Main-dialog acceptance records real symbols, atomicity mechanisms, test
   names/results, unmodeled scope and deviations in implementation.md keyed
   to the approved digest. Routine observed locations/results do not edit
   design.md. Semantic/atomicity/assumption changes require redesign, re-check
   and new formal review. Preserve existing agent report trailers.

## Lean proof, conformance and acceptance

1. Write specs/lean/<model-id>/{design.md,checks.json,Model.lean,
   Properties.lean,Reference.lean} and conformance/{adapter.mjs,cases.jsonl}
   per the Lean guides. Write each business property in plain English with an
   ID, domain, preconditions, forbidden outcomes, boundary behavior and
   independently chosen examples; then write the Lean statements. Record the
   coverage table and corpus provenance in design.md.
2. Provision Lean outside the package and before checks. An administrator runs
   `node "${CLAUDE_SKILL_DIR}/scripts/lean-provision.mjs" --dest <root>`. The
   helper downloads the pinned archive, verifies its SHA-256 against
   scripts/lean-toolchain.json, extracts it and writes
   `<root>.receipt.json`. Lean is never bundled, installed at startup or
   downloaded by a check command. Preflight resolves the root from
   `--lean-root`, then `FORMAL_DESIGN_LEAN_ROOT`; absence is a blocker. Only
   `leanprover/lean4:v4.35.0` is supported, on Linux x86-64 and macOS arm64.
3. Run the proof checks and the read-only audits. Proof checks do not require
   the implementation or corpus to exist yet; conformance then stays
   `not-run` and implementation acceptance stays pending.

```sh
node "${CLAUDE_SKILL_DIR}/scripts/lean-preflight.mjs" --project "$PROJECT" --model specs/lean/<id> --lean-root "$LEAN_ROOT"
node "${CLAUDE_SKILL_DIR}/scripts/lean-check.mjs" --project "$PROJECT" --model specs/lean/<id> --lean-root "$LEAN_ROOT"
node "${CLAUDE_SKILL_DIR}/scripts/lean-check-evidence.mjs" --project "$PROJECT" --model specs/lean/<id> --stage proof
```

4. Submit the full same-run proof package to the existing review lanes:
   exact inputs, Lean statements, inspector results, both streams for every
   phase, tool identities, corpus, planned source bindings and outstanding
   conformance. Reviewers inspect quantification, branches, assumptions,
   witness quality and whether each property states the requirement.
5. After design approval, implement the pinned semantics and the adapter, then
   run conformance and the project regression tests. The adapter is executed
   in place in the model directory, resolves production imports by ESM
   resolution relative to itself, contains no second algorithm copy and keeps
   stdout protocol-only.

```sh
node "${CLAUDE_SKILL_DIR}/scripts/lean-check-conformance.mjs" --project "$PROJECT" --model specs/lean/<id> --lean-root "$LEAN_ROOT"
node "${CLAUDE_SKILL_DIR}/scripts/lean-check-evidence.mjs" --project "$PROJECT" --model specs/lean/<id> --stage acceptance
```

6. `acceptanceReady` is true only for valid/fresh proof and conformance
   evidence, proof `verified`, conformance `passed` and matching run, digest
   and tool identities. Record actual symbols, results and deviations in
   implementation.md keyed to the approved proof digest. A proof-only result
   never means implementation acceptance passed. Changes to requirements,
   theorem types, assumptions, model semantics, the codec or shared operation
   contracts require new proof and review.
7. When selection is `both`, use [combined-models.md](references/combined-models.md):
   record `specs/formal/<feature-id>/bridge.json` plus `bridge.md`, run both
   producers with `--bridge`, then audit with
   `node "${CLAUDE_SKILL_DIR}/scripts/check-combined-evidence.mjs" --project "$PROJECT" --bridge specs/formal/<id>/bridge.json`.

## Versioning, reuse and reporting

Plugin update plus restarting dsh activates the new materialized skill. The
catalog is a session snapshot; installation alone promises neither screening
nor an automatic gate. Record the actual materialized runnerPackage version
outside inputs. Java and Lean are never dependencies of ordinary dsh startup.

Evidence stales on input/runner/toolchain changes, with no time TTL. Changed
inputs invalidate approvals. After a tool-only upgrade, the main dialog may
reuse historical approvals only for unchanged inputDigest with every case
verified, a fresh valid audit, complete approval references and no unresolved
findings. Record old/new tool/run identities, outcomes, warning/configuration
comparison and relevant release changes. Historical lanes did not review the
new execution; this policy is not a claim of tool equivalence. Keep one fresh
current package and separate historical references, never mixed-run evidence.
See the review contract for unfinished-review redispatch.

Report screening/adoption, backend selection, model coverage/bounds/
assumptions, proof verdict, axiom basis, conformance corpus/result, bridge
result, actual check and audit results, coverage/findings, current
review/handoff state, excluded scope and remaining work on separate lines. An
explicit waiver is reported as waived, not verified, with its unverified
scope. For TLC the only permitted verification conclusion is: “With the
specified model, parameters and assumptions, TLC completed its check and found
no violation of the checked properties.” For Lean the permitted conclusion is:
“Lean checked the listed propositions under the recorded definitions,
assumptions, and allowed axioms. The implementation matched the reference on
the recorded corpus. This does not prove arbitrary TypeScript code equivalent
to the model.” Never collapse both into “the feature is formally proved
correct.”
