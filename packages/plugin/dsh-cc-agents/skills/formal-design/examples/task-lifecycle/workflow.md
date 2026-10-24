# Illustrative workflow: cancellation, retry and late completion

This walkthrough is illustrative, not an approval or serialized Evidence.
D, D2, A, B, R1 and R2 below are explanatory labels, never valid hashes, run
IDs or approval references. Actual test results live in the implementation
record; they do not establish project workflow acceptance.

1. **Request and adoption.** The user asks to support cancellation and retry
   while old callbacks may arrive late. Inspect effective project rules and
   record their source/revision, screening adoption and review availability
   before making a model package. Availability alone does not install project
   screening. If rules cannot be loaded, model/check work can proceed but
   the existing review gate remains blocked. Never invent reviewers.
2. **Screen and define semantics.** Record FD-T1/FD-T2 enabled in design.md.
   Cancellation wins only if accepted before completion. No external-effect
   rollback is promised. Only the running attempt's matching callback may
   complete it. TypeOK, CancelledStable and StaleCannotComplete map to core
   case small with MaxAttempts=2. The bound exposes one old/new-attempt race;
   it makes no arbitrary-scale claim.
3. **Map atomicity.** Plan applyCompletion(taskId, attempt) and
   cancelTask(taskId), with one guarded transaction or CAS. The guard and
   write cannot be separate without a justified equivalent mechanism. Keep
   the example in-memory. The planned coverage matrix stays in design.md.
4. **Challenge an abstraction.** Reject a draft in which cancellation undoes
   an already-sent payment: worker starts effect → cancellation accepted →
   effect commits. The logical property cannot observe that effect. Restate
   the actual task contract. If it demands no post-cancel effects or
   at-most-once charging, revise the protocol/model or obtain the existing
   project's required explicit exclusion; a full table cannot hide it.
5. **Reproduce a counterexample.** Run the separate buggy-callback package:
   attempt 1 starts → timeout → retry attempt 2 → callback 1 is accepted.
   Retain its complete logs/evidence and disposition. Restore the missing
   tag guard; do not weaken the property or put this buggy fixture into the
   correct package's must-pass cases. The explicit late-event companions
   additionally retain pending tags across cancellation and deliver them
   nondeterministically with atomic removal and conditional update. They
   exclude duplicate deliveries, effects and persistence explicitly.
6. **Check and inspect coverage.** Copy this package into
   specs/tla/task-lifecycle. Run preflight, inspect willGenerate, then check
   using the installed skill's scripts. Inspect generated cfg and its diff.
   Audit the same run with check-evidence. Every configured case, including
   expansions, must verify; valid audit alone may describe a counterexample.
   Incomplete atomicity/abstraction coverage blocks review-ready even with
   verified results. Store actual run identity and observations outside inputs.
7. **Deliver and review.** Before workflow integration, establish effective
   review rules and per-remote-lane full-file transport feasibility. Deliver
   one complete package at D/run A through existing authorized channels:
   every input and cfg, markers/evidence, full stdout/stderr for every case,
   producer audit output, coverage and dispositions. For each lane record
   actual rule-provided identity, digest/run/tool identities, accessible
   artifact locations, receiver enumeration/hash/replay results, findings,
   resolution and disposition. Summary-only or missing-log delivery blocks
   that lane. No symbolic approval here counts as a real approval.
8. **Revise coherently.** A semantics/assumption change produces D2: re-check
   and re-review all required lanes. A missing log needs the complete same-run
   package or one complete new run redispatched to all unfinished lanes.
   Never combine logs/results from A and B.
9. **Hand off only after approval.** Supply approved digest D, fresh verified
   evidence, actual approval references, planned guarded-update symbols,
   implementation plan and regression assertions. If the atomic update is
   unimplementable, executor reports Blockers and pauses affected work.
10. **Accept implementation.** Record observed action/property → real symbol
    and test mappings in implementation.md keyed to D. Assert both
    cancellation/completion orders, timeout/retry/stale completion and
    cancel/pending delivery. Do not edit design.md just to add code locations.
    A name extraction preserving guard/atomicity needs affected code tests;
    omission of the approved guard needs a restoring fix and regression;
    changing transaction/assumptions requires redesign/check/review. Uncertain
    equivalence remains a blocker. If duplicate callbacks were relevant but
    missing, extend the model and repeat the gate.
11. **Tool upgrade and historical approvals.** After update and restart, old
    evidence reports stale/runner. For unchanged D, re-check every case as B
    under actual R2 and audit successfully. Main dialog compares old/new
    case outcomes, warnings/configuration and relevant release changes;
    records old A/R1 identities, original approval references, new B/R2
    identities, unchanged D, fresh audit, findings/dispositions and the
    historical reviewers' non-review of the new execution. Only then reuse
    approvals under the stated policy. B is the complete current package;
    A remains a historical reference. D2 never reuses D's approvals.

Use the installed scripts via ${CLAUDE_SKILL_DIR}/scripts/{preflight,check,
check-evidence}.mjs with --project and --model. preflight/check need an
explicit --jar or TLA2TOOLS_JAR. No command downloads Java or the JAR.
Commands write only the declared model artifacts and .formal-design outputs;
adding /.formal-design/ to the project's .gitignore is a separate manual edit.
