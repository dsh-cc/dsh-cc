# Guarded execution: feature designs and implementation order

- Date: 2026-10-27
- Status: proposed; this documentation set implements no runtime behavior.
- Inspected baseline: `dsh-cc/dsh-cc@1c89f1e3e6e3aa572751517ed591b62778bdf1b3`.
- Harness baseline used by repository CI: `dsh-cc/deepseek-harness@c1b47e41fcd54d20a0f061df28683bfc29ee24e5` (`0.2.0-rc.2`). This set does not claim that the new host interfaces below already exist.
- Reference: [HarnessMM v1](https://arxiv.org/abs/2610.32813v1), especially Sections 3–5, the execution contracts, and the limitations.

## 1. Problem and outcome

The agent often knows the next build, test, or inspection command before the current action finishes. Sending every successful receipt back through another model request can regenerate an already resolved decision and replay a large context. Moving that decision to a cheaper model does not necessarily remove the original request. Meanwhile, session-only cost reports cannot establish complete-task savings when auxiliary requests, child sessions, transport retries, or failed requests are omitted.

This set makes three independently useful improvements before attempting general callback substitution: complete accounting, bounded literal action chains, and explicit batching of configured verification. Persistent decision graphs come later, behind a new host capability. Offline experiments determine whether any configuration is worth adopting.

Success means lower measured task cost with independently checked quality, preserved permissions and cancellation, and traceable execution. A graph guard proves only its declared readiness condition. It is not a proof of program correctness. Callback audit records prove that a registered request boundary was bypassed; they do not measure the tokens a hypothetical request would have used.

## 2. Existing behavior and boundaries

| Inspected component | Existing behavior | Design consequence |
| --- | --- | --- |
| `packages/core/tools/src/tool-types.ts`, `runtime-execute.ts` | Nested calls carry opaque parent tokens and root call IDs; canonical values are execution-local; tools have full policy and cancellation pipelines | Dispatch through the public `tools.execute` API; do not invoke tool bodies or private scheduler stages |
| `packages/core/tools/README.md` | Code Mode already permits programmatic tool composition | Compare the chain tool against equivalent Code Mode, not just native one-call-at-a-time execution |
| `packages/interaction/post-edit-verify/src/wiring.ts`, `runner.ts` | User-only configured commands run after matching edits; each match runs; debounce only labels; ShellExecutor is used directly | Preserve legacy mode and add explicit batching without interpreting arbitrary Bash commands |
| `packages/llm-tuning/side-query/src/index.ts` | Auxiliary streams need not carry session IDs; the helper has no complete accounting service | Add explicit attribution rather than infer parentage from nearest timestamps |
| `packages/session/command-cost/src/index.ts` | `/cost` folds the invocation's session event log | Preserve bare `/cost`; add a separate explicit task view |
| `packages/observability/cache-health/src/index.ts` | Passive logical-request observer deliberately excludes some auxiliary calls | Not a physical provider-attempt accounting seam |
| `docs/plans/2026-10-19-harness-experiments.md` | Proposed A–F experiment design, initially for VWA | Reuse its contracts once implemented; do not describe those packages as available today |

All paths in this table are relative to the pinned baseline. Implementation PRs MUST re-diff their affected surfaces and record drift. Existing `AGENTS.md` was read; it contains a self-reference and no additional substantive implementation rules. Do not follow that reference recursively or edit it for this proposal.

## 3. Normative design map

MUST/MUST NOT are requirements. All interfaces named as proposed are new contracts, not discovered APIs. Runtime JSON schemas own wire validation; TypeScript exports MUST match. Unknown keys, invalid enum values, non-finite numbers, prototype keys, and unsupported schema versions MUST be rejected. IDs are server-generated UUIDs unless a document explicitly defines a derived ID. UTC ISO timestamps are descriptive; monotonic clocks own deadlines. Documents own the following non-overlapping contracts:

| Feature | Document | Owner and deliverable | Required predecessors |
| --- | --- | --- | --- |
| A | [Complete task accounting](2026-10-27-guarded-feature-a-accounting.md) | `@dsh-cc/task-accounting`; host attribution/attempt interface; `/cost task` | None |
| B | [Literal action chains](2026-10-27-guarded-feature-b-chains.md) | `@dsh-cc/continuation-contracts`, `@dsh-cc/tool-continuation`; explicit composite tool | A's attribution API and logical collection |
| C | [Verification batches and receipts](2026-10-27-guarded-feature-c-verification.md) | Extend `post-edit-verify`; batch-owned verification and conservative receipt reuse | A, B |
| D | [Persistent guarded decisions](2026-10-27-guarded-feature-d-controller.md) | `@dsh-cc/decision-controller`; new host boundary protocol | A complete physical accounting, B, C, host capability |
| E | [Controlled evaluation and optimization](2026-10-27-guarded-feature-e-evaluation.md) | Private `@dsh-cc/guarded-eval`; coding adapter for the experiment designs | A; variants enabled as B–D ship; optimization also needs existing experiment A–D |

No changes to model weights, permission policies, source confidentiality rules, tool result semantics, or VWA grading rules are authorized by these designs. No fast-model selector ships in this set. All new execution behavior is opt-in and disabled by default. These are runtime features; a `SKILL.md` alone cannot enforce their contracts.

## 4. Implementation PR sequence

1. **A1: contracts and logical accounting.** Implement attribution, append-only records, folds, failure reporting, and `/cost task`. Missing host attempt capability is visible as `logical-only`. This PR is useful independently and makes no complete-cost claim.
2. **A2: host accounting capability and coverage.** In the harness repository, implement the versioned attempt/attribution contract from A. Merge and release it, then pin and integrate it in dsh-cc with contract tests. Cover every provider path used by the pilot, including subagents, one-shots, and retries. Only this stage can report complete physical coverage.
3. **B: chain execution.** Implement pure schemas/guards first, then the host nested-event capability specified in B (B0), release/pin it, and integrate native dispatch, durable nested receipts, cancellation, and optional installation (B1). Tests initially use fake tools. No persistent scheduling or callback-savings claims.
4. **C: explicit verification batching.** Add batch ownership and result receipts; leave ordinary post-edit execution unchanged outside a batch. Test two sessions sharing a worktree and interactions with compression and recovery hints.
5. **E1: offline runner and first comparison.** Implement the coding suite and paired evaluation with baseline, Code Mode, B, and B+C. This requires A2 for cost conclusions but does not wait for D or the optimizer. Stop if the evidence is insufficient.
6. **D0 then D1: host boundary capability, then controller.** Implement/release the proposed host protocol in a separate harness PR; integrate only after its conformance tests pass. First shadow evaluation, then an explicitly enabled live pilot. A chain tool is not a substitute for this dependency.
7. **E2: persistent-graph comparison and bounded optimization.** Add D and its ablations. Integrate the existing harness-experiments A–D only when those contracts actually ship. Freeze a selected configuration before holdout. Keep the baseline if gates fail.

Order is therefore **A1 → A2 → B → C → E1 → D0 → D1 → E2**. Pure schema work may be prepared earlier, but merge/release gates above remain sequential. No default enablement is part of this set, even if a pilot passes. Each implementation PR updates its own design status, lists API deviations, records the tested harness revision, and links executable acceptance evidence. English/Chinese user documentation is added with implementation, not capability claims in this design PR.

## 5. Packaging and review requirements

New libraries use workspace dependencies and public exports; never deep-import another package's `src/`. Update package manifests, project references, pnpm lockfile, Vitest aliases, publish checks, and settings namespaces with implementation. Accounting registers inside the same services realm as its consumers; use the existing preset isolation conventions rather than exporting a root-global authority. The chain/controller are optional Cordis plugins, not additions to default bundles. E stays private under `packages/evaluation/` and is never boot-mounted. Changes to the external harness require their own reviewed/released PRs and compatibility pins; this design PR changes only `docs/plans/` in dsh-cc.

Review every feature for: objective and non-goals; validated inputs; state transitions; failure and cancellation; persistence and ownership; compatibility; specific file changes; negative acceptance cases. An unavailable host capability is a defined disabled state, never permission to synthesize assistant messages or patch private loop internals.

## 6. Evidence and attribution

HarnessMM motivates literal decisions, observed guards, callback omission audits, and complete-task accounting. Its headline DeepSeek Harness token reduction combines multiple interventions; it is not a projected dsh-cc saving. Its ablations and reported quality regressions justify independent cost and quality gates. Token savings do not establish latency or energy savings. This set independently specifies conservative product contracts and does not copy paper implementation code or benchmark assets. No experiments or performance measurements were run for this documentation proposal.
