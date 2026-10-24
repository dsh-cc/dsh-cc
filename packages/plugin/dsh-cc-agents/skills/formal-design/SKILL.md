---
name: formal-design
description: Verify protocol and state-machine designs with bounded TLA+ models before the existing design review. Use for independent actors changing shared state where event ordering matters; retry, timeout, duplicate or late messages; crash recovery involving ownership, deduplication or persistence order; or authorization, leases and resource ownership spanning asynchronous changes. Also use when the user explicitly requests TLA+ verification.
---

# Formal design

The main dialog owns requirements, modeling, counterexample interpretation and
approval decisions. This skill supplies a workflow and executable checks. It
adds no runtime gate, new reviewer lane, agent type, settings or startup hook.
Read [modeling-guide.md](references/modeling-guide.md) and
[review-contract.md](references/review-contract.md) before modeling or review.
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
   changes. Enable when any applies: FD-T1 independent actors and shared-state
   ordering; FD-T2 retries/timeouts/duplicate or late messages affecting an
   outcome/effect; FD-T3 crash recovery affecting ownership, deduplication or
   persistence order; FD-T4 authorization/lease/resource ownership across
   asynchronous changes. Existing modeled behavior changes also trigger.
   Formatting, pure layout, deterministic computation and behavior-preserving
   refactors do not trigger by default.
4. Record the current Formal design section in design.md: mode
   auto|required|off, decision enabled|not-needed|waived, triggerIds,
   rationale, modelDir when enabled, and verbatim userDirective when present.
   Auto-enablement needs a brief notice, not another permission round-trip.
   Ask business questions only where ambiguity changes the properties.
   Explicit task instructions take priority; report a conflict with mandatory
   project rules and obtain a scoped decision rather than silently choosing.
5. Re-screen requirements, design revisions, reviewer requests and reported
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
2. As a separate manual project edit, add `/.formal-design/` to .gitignore
   once. No runner edits .gitignore. Runner writes are restricted to generated
   cfgs/evidence/current-run under specs/tla and artifacts under .formal-design.
   Main-dialog/executor edits also maintain design, cfgs and implementation.md.
3. Obtain Node (repository requirement ^22.19 or >=24), Java >=17 and the
   exact separately supplied TLC JAR pinned by scripts/toolchain.json. Nothing
   downloads or scans for a JAR. Without --jar use TLA2TOOLS_JAR; without
   --java use PATH java. Preflight is read-only and starts no model check.

```sh
node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs" --project "$PROJECT" --model specs/tla/task-lifecycle --jar "$TLA2TOOLS_JAR"
node "${CLAUDE_SKILL_DIR}/scripts/check.mjs" --project "$PROJECT" --model specs/tla/task-lifecycle --jar "$TLA2TOOLS_JAR"
node "${CLAUDE_SKILL_DIR}/scripts/check-evidence.mjs" --project "$PROJECT" --model specs/tla/task-lifecycle
```

4. Inspect generated cfg bytes and commit them with checks.json. A differing
   existing cfg blocks; never overwrite reviewed material automatically. To
   change it, inspect and explicitly remove only changed declared cfgs, run
   preflight/check, then review the diff. Completed cfgs survive generation
   failure; repair and retry only absent paths. No cfg generation means TLC
   passed. See the guide for cancellation, locks and I/O recovery.
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

## Versioning, reuse and reporting

Plugin update plus restarting dsh activates the new materialized skill. The
catalog is a session snapshot; installation alone promises neither screening
nor an automatic gate. Record the actual materialized runnerPackage version
outside inputs. Java is never a dependency of ordinary dsh startup.

Evidence stales on input/runner/toolchain changes, with no time TTL. Changed
inputs invalidate approvals. After a tool-only upgrade, the main dialog may
reuse historical approvals only for unchanged inputDigest with every case
verified, a fresh valid audit, complete approval references and no unresolved
findings. Record old/new tool/run identities, outcomes, warning/configuration
comparison and relevant release changes. Historical lanes did not review the
new execution; this policy is not a claim of tool equivalence. Keep one fresh
current package and separate historical references, never mixed-run evidence.
See the review contract for unfinished-review redispatch.

Report screening/adoption, model bounds/assumptions, actual check and audit
results, coverage/findings, current review/handoff state and remaining work
separately. An explicit waiver is reported as waived, not verified, with its
unverified scope. The only permitted verification conclusion is: “With the
specified model, parameters and assumptions, TLC completed its check and found
no violation of the checked properties.” This does not prove an arbitrary-scale
system, implementation or deployment correct.
