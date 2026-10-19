# Feature F: on-demand task refinement

- Status: proposed; released only after the offline pilot is reviewed.
- Parent: [Harness experiments](2026-10-19-harness-experiments.md).
- Package: `packages/interaction/command-refine` (`@dsh-cc/command-refine`, optional plugin).
- Depends on: [A](2026-10-19-harness-feature-a-contracts.md), [B](2026-10-19-harness-feature-b-execution.md), [C](2026-10-19-harness-feature-c-evaluation.md), [D](2026-10-19-harness-feature-d-optimization.md). [E](2026-10-19-harness-feature-e-experience.md) is optional.

## 1. Problem and solution

A difficult local task may benefit from trying a different working method before committing to a deliverable. Running the offline research loop inside every ordinary conversation would add unpredictable latency and cost. Re-running a live task with external effects is unsafe and may be impossible to compare.

Provide a separately installed, explicitly invoked command that runs a bounded experiment against a frozen local task manifest. It produces candidate artifacts and a comparison report in a staging directory. It does not alter the active agent's configuration or replace a user's working files. Task-level preference is explicitly weaker than cross-task validation.

## 2. Activation and command grammar

The optional plugin is absent from `bundle-shell`, `bundle-tui`, `bundle-permissions`, and all default profiles. Plugin setting `harness-refine.enabled` defaults to false. When false, the command explains how to enable it and performs no preflight or model call. Enabling registers the command only; it never schedules background work.

Supported grammar, parsed as argv with no shell expansion:

```text
/refine plan --task <workspace-relative-json> --config <workspace-relative-json>
/refine run --plan <digest>
/refine status --experiment <id>
/refine cancel --experiment <id>
/refine export --experiment <id> --variant <baseline-or-candidate-id> --out <new-directory>
```

Unknown flags, duplicate flags, invalid IDs, or ambiguous quoted strings fail `SCHEMA_INVALID`. Paths resolve through the existing workspace filesystem abstraction and cannot escape the workspace via symlink or traversal. `run` requires a plan produced by `plan`; it does not read a free-form previous chat message as an implicit task. `status`, `cancel`, and `export` require ownership by the same project; another project's experiment is not accessible through the command.

`plan` creates immutable task/config blobs under A and displays the plan digest, baseline, editable surface, required outputs, enabled tools, isolation profile, maximum executions, all call/token/cost/time caps, and the new export location. No paid call occurs. Explicit `run --plan` is the authorization to spend up to those limits; there is no additional confirmation dialog. If configuration changes after planning, return `IDENTITY_MISMATCH` and require a new plan. Never substitute an updated plan automatically.

## 3. Supported task contract

v1 accepts one `local-vwa-writing@1` task: `{schemaVersion:1, adapterId:'local-vwa-writing@1', taskId, domain, promptPath, sourcePaths:string[], outputPath}`. It must declare local UTF-8 text sources, one Markdown output, and the existing VWA evidence/argument workflow. The adapter creates A's Task with partition development; local refinement has no holdout partition or hidden benchmark label.

Restrict the editable surface to D's `vwa-writing@1` surface. Model routes, independent reviewer policy and all runner controls are fixed by the plan. No publishing, deployment, communication connector, remote MCP, unrestricted network tool, shared writable service, or user home mount is available. If a task needs any of these, `plan` returns `PREFLIGHT_FAILED` detail `UNREPLAYABLE_TASK`. Do not strip the tool and continue as if the task were equivalent.

Optional explicit E lesson IDs are frozen at planning time; absence of E disables recall without failing the command. A requested but unavailable lesson is an error, not a silent omission. Local results cannot promote a lesson to validated state because no independent holdout evidence exists.

## 4. Bounded execution and selection

Use D's sequential scheduler with `k=1`, one task, one repetition, and no recursive invocation of `/refine`. Maximum solver executions are four: baseline, general candidate, domain candidate, composition. `plan` reports all four even if duplicate/invalid candidates later reduce actual execution. Solver, proposer, composer, reviewer and optional selector share D's ledger; all limits are required. No nested refinement, background learning, or context compaction callback may start a second optimizer.

Run B preflight before any model dispatch. A child of the foreground command owns the experiment controller; it is not a child of the solver being tested. Solver children remain inside B's isolation and budget. The plugin uses the repository's existing jobs/status integration for progress and cancellation through public APIs. If the host lacks a cancellation/disposal seam, the plugin fails preflight; it does not detach an unmanaged process.

Local evaluation can establish mechanical validity and independent reviewer findings, but has no adjudicated gold labels. It MUST NOT invoke C's `vwa-pilot@1` promotion decision with invented annotations. Instead use `local-refinement@1`:

1. Reject candidates failing mechanical checks, independent VWA delivery checks, or required outputs.
2. Keep baseline when no candidate passes, baseline has fewer located blocker/major findings, the reviewer is unavailable, usage is unknown, or the selector abstains/fails.
3. Among remaining candidates, require no new located blocker or major finding relative to baseline, known accounting, and no more than 1.25 times baseline solver cost. If baseline cost is zero, use C's zero-denominator rule.
4. A blinded selector may prefer a candidate based on complete artifacts and located findings. Without an explicit nonabstaining preference for a surviving candidate, keep baseline. Ties use fewer minor findings, lower solver cost, then snapshot digest order.

Outputs are `baseline-retained`, `candidate-preferred`, or `inconclusive`. All reports display `validation: task-local; not eligible for cross-task promotion`. A preferred result means that a reviewer preferred one bounded sample; it is not a measured accuracy gain. With only one sample, the report makes no statistical generalization claim.

The local decision is a distinct schema `{schemaVersion:1, policyId:'local-refinement@1', experimentId, baselineRunId, preferredRunId, outcome, evaluationDigests, selectorDigest:Digest|null, reasons:string[], eligibleForPromotion:false}`. It MUST NOT deserialize as C's confirmation decision. E rejects it even if outcome is candidate-preferred.

## 5. Progress, cancellation, and export

Progress events contain experiment ID, current stage, completed/planned executions, known expenditure, reserved expenditure, elapsed time, and stable error codes. They contain no hidden reasoning. Emit on each stage transition and at most once per second while usage changes. `status` reads A's store and broker settlement state; it does not resolve a model route or start work.

`cancel` is idempotent. Stop admissions immediately, propagate cancellation through D and B, await container/child disposal, preserve completed artifacts and all usage, and mark unfinished stages cancelled. Closing the session triggers the same operation. A later `status` can show partial results; there is no automatic resume in F v1. A new `plan` and experiment are required to try again.

`export` requires a completed named variant and a new empty workspace directory, refuses tracked skill/config paths and any existing destination file, and uses an atomic new-directory rename. Write artifact bytes, `comparison.md`, `comparison.json`, exact candidate overlay, baseline file hashes, and reproduction manifest. Include an explicit line that no live file or configuration has been replaced. Partial/cancelled results can be exported only as diagnostics through the offline CLI, not as a selected deliverable. `export` does not send, publish, commit, or apply anything.

The user may subsequently ask the ordinary agent to edit files using an exported result; that is outside this command and follows existing permissions. Refine MUST NOT infer that export grants permission to install a skill or update memory.

## 6. Compatibility and rollout

The optional plugin has only public dependencies on the proposed evaluation packages and existing workspace/jobs/settings services. Library code does not depend on the command plugin. Standard cc behavior, `/learn`, VWA settings, model aliases, presets and resume behavior remain unchanged. An enabled refine plugin cannot bypass a disabled VWA semantic review setting: the plan must explicitly construct an isolated VWA-enabled profile or fail, rather than toggling the user's profile.

Ship after A–D pass their tests and a completed pilot report is reviewed, whether the pilot found gains or not. Document actual runtime/container requirements, single-task limits, expected execution count and budget behavior in matching English/Chinese plugin READMEs. Do not advertise automatic self-improvement. Expand to coding or capacity planning only with a separately versioned task adapter, side-effect model, validators and acceptance suite.

## 7. Acceptance and TDD sequence

| Action | Required result |
| --- | --- |
| Ordinary agent turn, startup, or disabled plugin | No optimizer/model/container work |
| Plan command | Complete cost/run envelope; zero dispatch |
| Frozen plan differs from current route/files | Run rejected; no silent refresh |
| Connector or network-dependent task | Preflight rejects replay |
| Four-execution limit or wall/cost cap reached | No extra attempt; cancelled work accounted |
| Reviewer outage, invalid candidate, unknown usage, selector abstains | Baseline retained or inconclusive; never promotion |
| Candidate preferred once | Task-local status and limitations displayed |
| Attempt to promote local decision through E | Rejected by schema and policy |
| Session closes or user cancels | All owned child processes and reservations settle |
| Export into existing file/config path | Rejected without modifying destination |
| Successful export | Exact artifact bytes and comparison records in a new directory |

Use fake host services and runner for command tests, then B's Linux integration environment for lifecycle tests. A manually invoked model smoke test verifies UX and accounting, not general quality improvement.
