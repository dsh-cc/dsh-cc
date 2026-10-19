# Feature D: bounded candidate optimization

- Status: proposed.
- Parent: [Harness experiments](2026-10-19-harness-experiments.md).
- Package: `packages/evaluation/harness-optimizer` (`@dsh-cc/harness-optimizer`, private).
- Depends on: [A](2026-10-19-harness-feature-a-contracts.md), [B](2026-10-19-harness-feature-b-execution.md), [C](2026-10-19-harness-feature-c-evaluation.md).

## 1. Problem and solution

Writing a longer skill after a failure is easy; establishing which change helped is not. Unrestricted optimization can edit the evaluator, keep growing the prompt, or consume an unbounded number of solver runs. Parallel workers can overspend a nominal budget unless reservations are atomic.

Implement a controller-owned Propose–Probe–Compose state machine with a narrow editable surface, immutable candidate records, complete accounting, and baseline-inclusive selection. The first release operates offline and only on explicit invocation. It proposes changes; it never installs them.

## 2. Editable surface

The frozen surface manifest is `{schemaVersion:1, id:'vwa-writing@1', baselineFiles:FileRef[], editablePaths:string[], maxChangedFiles:8, maxAddedBytes:32768, maxTotalBytes:131072, maxAlwaysOnBytes:16384}`. The only initial editable paths are:

- `skills/vwa-writing/SKILL.md`.
- `skills/vwa-writing/scripts/<name>.py`, with name matching `[a-z][a-z0-9_-]{0,63}`.

At most seven helper files may be added. Scripts use the pinned image's Python standard library only; dependency installation is forbidden. The skill must continue to reference the existing evidence registration, claim/argument binding, review, and delivery steps. A deterministic linter checks that mandatory tool names and stages remain present; C's end-to-end evaluator, not that linter, determines whether they were used correctly.

Other snapshot files are read-only. Prompts, memory, agent definitions, and tool guidance are representable by A but are not mutable in this first surface. Guardrails, permissions, VWA policy and code, reviewers, schemas, tools, plugins, model routes, gold labels, validators, output paths, and network controls are never editable. The Harness² bridge rejects unsupported components instead of claiming all eight upstream components are available.

A candidate is a full overlay manifest, not a shell patch:

```ts
interface Candidate {
  schemaVersion: 1; candidateId: string;
  parentSnapshot: Digest; surfaceDigest: Digest;
  scope: 'general' | 'domain' | 'composition';
  files: FileRef[]; deletedPaths: string[];
  hypothesis: string; expectedEffect: string;
  evidenceRefs: string[];
  resultingSnapshot: Digest;
}
```

`files` lists all replacement/addition blobs; `deletedPaths` is empty in v1 (deleting an existing skill or helper is forbidden). Unchanged files are inherited exactly. Validate original-byte hashes, byte limits, paths, duplicate paths, modes, UTF-8 text, and the complete resulting snapshot before any execution. Skills are `0644`; scripts may be `0644` or `0755`. Candidate text and helper code are untrusted and run only under B. Do not execute helpers in the controller for validation.

## 3. Proposer and composer contract

Invoke proposer and composer through the host prepared model service, without tool execution, using one forced structured response tool. Input contains frozen task descriptions, allowed baseline files, complete development artifacts and navigable trajectories, deterministic development findings from C, eligible E experiences if explicitly selected, and the surface manifest. Mark trajectory/output text as data. The model cannot read the store, inspect sealed files, run commands, or make network calls. Construct a complete bounded request before reserving a call. If complete selected evidence exceeds the frozen route context window or input budget, return `LIMIT_EXCEEDED` without dispatch; do not silently truncate it. The operator may plan a smaller task set in a new experiment. Navigation references are for reports and source attribution; the v1 forced-response proposer has no file-reading tools.

Response is `{hypothesis, expectedEffect, evidenceRefs, files:{path,content,mode}[]}`. Explanation fields are nonempty and at most 4000 UTF-16 units; references resolve to provided `run:<id>#event=<seq>`, `artifact:<digest>`, or `lesson:<id>@<revision>` anchors only. Files obey the surface limits. The controller assigns IDs, computes blobs and resulting snapshot, and records the prompt/output/route digests. A proposal need not be novel; an identical resulting snapshot is recorded as `no-change` and never counted as a new candidate or a new independent sample.

Permit one repair response with schema/surface errors only. Both calls consume the same budget. Failed repair marks the stage invalid and retains its parent. The composer receives actual probe evidence and individual hypotheses; it MUST propose a new bounded overlay against the current parent, not concatenate candidate files blindly. The same validation applies. Unsupported rationale or fabricated evidence rejects the response.

## 4. Deterministic scheduling

Frozen optimizer configuration is `{schemaVersion:1, mode:'parallel'|'sequential', k, developmentTaskIds, repetitions, surfaceDigest, experienceRefs, budgetDigest}`. `k` is an integer 1–3. Development tasks are chosen in taskId order from an explicit list before any calls; adaptive task replacement is forbidden. Holdout task IDs, prompts, files and labels are not supplied to the optimizer.

For parallel mode:

1. Run baseline once for each development task/repetition pair.
2. Propose k general and k domain candidates from the same baseline evidence.
3. Probe each distinct valid candidate against every development pair.
4. Propose k independent compositions from all available probe evidence.
5. Probe each distinct composition against every development pair.
6. Rank baseline and all completed valid candidates using C's development metrics: fewer blockers, fewer invalid samples, higher mean quality, lower solver cost, then lexicographically smaller snapshot digest. Optional blinded preference breaks a quality tie only when quality and all safety/cost metrics are identical.

For sequential mode, each of k rounds proposes one general and one domain candidate against the current parent, probes both, composes one candidate using all accumulated development evidence, and probes it. Select the next parent from the current parent and those three variants using the same ranking. Historical candidates remain in the final pool. The baseline is never removed. A round with no valid new result retains its parent.

Worst-case solver executions for either mode are `(1 + 3*k) * taskCount * repetitions`. Validate this number against the solver-run budget before starting. `k=1`, one development task, and three repetitions means at most 12 executions, not one extra call. Parallel proposal/composition phases may run concurrently; solver executions are serial in v1 for bounded cost and predictable resource use. Add concurrency only in a later policy version.

The scheduler receives an explicit evaluator policy ID: `vwa-pilot@1` uses C's annotated development metrics; `local-refinement@1` is available only to F and uses F's validity/findings and blinded preference policy. Never synthesize gold metrics for local tasks. Persist the evaluator policy in the plan; a local experiment cannot be converted into a confirmation experiment.

Select at most one final candidate for C's separate confirmation experiment. If the baseline ranks first, stop with `keep-baseline` and skip holdout expenditure. A development winner is only `proposed`; no validated lesson is created yet.

## 5. Budget ledger semantics (implemented and exported by A)

Budget fields are positive safe integers: `{maxSolverRuns, maxModelCalls, maxInputTokens, maxOutputTokens, maxCostMicroUsd, maxWallMs, perCallMaxOutputTokens, priceTableDigest}`. All limits are required; CLI flags populate them explicitly, with no unlimited sentinel. Count solver, proposer, composer, selector, reviewer, and repair calls, including failed and interrupted calls. The model-call budget is distinct from the solver-run budget.

Before every call, reserve one call, an upper bound on input tokens, maximum output tokens, and maximum cost in the single-writer ledger. Exact provider tokenization may be used; otherwise use the prepared request's serialized UTF-8 byte count plus the frozen adapter's documented framing upper bound. If the adapter cannot provide an input upper bound or a complete price bound (including reasoning, cache and minimum fees), preflight fails for paid calls. The price table maps frozen route/revision to integer micro-USD rates and rounding rules; it cannot change during a run.

Admission requires `settled + reserved + requested <= cap` for every counter. Persist the reservation before dispatch; generate a unique callId and send it to the broker. Settle with provider usage when known; release unused reservation. If no dispatch occurred, release it with evidence from the broker. If usage or dispatch status is unknown, charge the full reservation for budget admission, mark accounting unknown, and stop further paid calls. Conservative reservation is not a claim of measured expenditure; C requires known solver accounting for promotion. Usage above reservation records `BUDGET_EXHAUSTED` detail `BOUND_VIOLATION`, cancels remaining work, and invalidates confirmation.

Use monotonic elapsed time for the live wall cap. On resume, accumulate persisted elapsed duration; downtime does not count, but no prior time is forgotten. Wall cap includes preflight after experiment creation, model and solver calls, output collection, and evaluation in that experiment. When a cap is reached, cancel active work under B, preserve all records, and return `BUDGET_EXHAUSTED`. Never silently increase k, skip planned bad samples, or reduce repetitions to manufacture a complete comparison.

## 6. CLI, stage states, and resume

Expose `harness-optimize plan --config <file>` (validates and prints worst-case executions and reservations without dispatch), `harness-optimize run --config <file>`, and `harness-optimize resume --experiment <id>`. Commands use C's exit-code convention. `run` creates a new immutable experiment; `resume` accepts no configuration override.

A stage has states `planned → reserved → dispatched → completed`, or terminal `invalid`, `failed`, `cancelled`, `interrupted`, `no-change`. Persist each transition through A. On resume verify all snapshot, task, surface, policy, model, image, and code identities. B may reuse exact completed runs. Completed proposal output is reused only if its prompt, prepared route and input digests match; no new call is billed for reading it. Interrupted model calls are never automatically resent. Resume may continue remaining stages only after unknown usage has been reconciled with broker evidence; otherwise return `USAGE_UNKNOWN`.

Partial evidence is reportable but cannot produce `eligible-for-promotion`. Stage diagnostics identify which planned variants were not produced. A failed proposal does not remove baseline observations. Experiment sealing records the complete planned-versus-actual matrix before C evaluates it.

## 7. Acceptance and TDD sequence

| Scenario | Required behavior |
| --- | --- |
| General/domain probes reveal different faults | Composer receives actual contrasts and referenceable evidence |
| Candidate edits policy, evaluator, model, or undeclared helper | Rejected before solver dispatch |
| Script tries network or host writes | B contains it; no controller execution |
| Identical baseline proposal | No-change; no duplicate sample |
| Sequential composition is worse | Current parent or baseline retained |
| Two calls compete for the final reservation | At most one dispatches |
| Repair, reviewer, or failed call | Included in total token/cost counters |
| Unknown usage or bound violation | Stop; no promotion |
| Budget cannot cover frozen solver matrix | Plan fails before any paid call |
| Changed configuration on resume | Identity mismatch, no dispatch |
| All candidates fail | Baseline remains reportable; no automatic patch |

First build the full state machine against fake models and B's fake runner. Then run one development-only smoke experiment with explicit expenditure limits. Do not use holdout tasks to debug the optimizer.
