# Harness experiments: design set and implementation order

- Date: 2026-10-19
- Status: proposed; none of the features in this set is implemented by this PR.
- Repository baseline: `dsh-cc/dsh-cc@ae9da6c5cbe335aa2f147867a93f6c3d80657997`.
- Reference baseline: `google-research/harness2@1cfe254e8d25b15f37048c3730134686abe60335`.
- Scope: reproducible, isolated experiments that improve agent configuration using execution evidence.

## 1. Problem and intended outcome

The repository can discover recurring corrections, retain memory, attribute sessions to configuration, resume parts of workflows, and check document evidence. These capabilities do not establish whether a proposed change to an agent's working method improves results. A successful correction in a transcript can be correlated with a later success without causing it. A successful run under a changed model is not a controlled comparison. A reviewer preferring a polished output is not evidence that its facts are correct.

This design adds an explicit experiment loop: freeze inputs and configuration, propose a bounded patch, run the baseline and candidate in separate environments, check their outputs, compare results, and retain a qualified lesson only when the evidence meets a fixed policy. The baseline is always a valid outcome. An experiment can conclude `keep-baseline` or `inconclusive` without being considered a system failure.

The first supported use case is offline improvement of the `vwa-writing` skill and its declared helper scripts. Coding and capacity-planning tasks use the same contracts when they have dedicated task adapters and independent validators. They are not claimed as validated domains by the initial release.

## 2. Existing boundaries

These observations refer to the pinned repository baseline. Implementers MUST re-diff relevant files before writing code and record changed assumptions in the implementation PR.

| Existing package | Reuse | Boundary that remains intact |
| --- | --- | --- |
| `packages/session/command-learn` and `session-forensics` | Findings and transcript evidence anchors seed hypotheses | Existing `/learn`, `/learn apply`, defaults, and managed memory blocks do not change |
| `packages/observability/config-snapshot` | Attribution reference for source sessions | A passive session sidecar is not an experiment snapshot or a complete configuration hash |
| `packages/subagent/resume-pins` | Canonical fingerprinting conventions | An agent-definition pin is not a whole-harness fingerprint |
| `packages/subagent/workflow-journal` | Existing workflow behavior remains available outside experiments | Same-session prefix replay is not used as an experiment cache |
| `packages/evaluation/vwa-eval` | Versioned scorers and fixture/annotation conventions | Scores require the declared inputs and annotations; do not infer unavailable gold labels |
| `packages/interaction/vwa-argument` and `vwa-evidence` | Independent checks through public entry points | The optimizer cannot write review records, delivery receipts, or policy state |
| `packages/memory/memory` and `memory-consolidation` | Existing user and project memory remains separate | No automatic experiment-to-memory writeback or background optimization |
| `packages/test-support/token-efficiency` | Existing efficiency checks remain independent | These checks do not become evidence of end-to-end quality by themselves |

## 3. Normative document map

MUST and MUST NOT define required behavior. SHOULD permits deviation only when the implementation records its reason. Every interface in these documents is a new proposed interface unless explicitly described as existing. JSON schemas are the runtime authority; generated TypeScript declarations MUST agree with them. The overview owns scope and dependency order. Feature A owns shared serialization, persistence, identifiers, and errors. Other features own their respective algorithms. A conflict blocks implementation until the documents are corrected; implementers MUST NOT silently choose a behavior.

| Feature | Design | Deliverable | Depends on |
| --- | --- | --- | --- |
| A | [Contracts and snapshots](2026-10-19-harness-feature-a-contracts.md) | `@dsh-cc/harness-contracts`, immutable experiment store | None |
| B | [Isolated execution](2026-10-19-harness-feature-b-execution.md) | `@dsh-cc/harness-runner`, dsh execution seam, Harness² bridge | A |
| C | [Evaluation and adoption](2026-10-19-harness-feature-c-evaluation.md) | `@dsh-cc/harness-eval`, baseline-inclusive decision policy | A, B |
| D | [Candidate optimization](2026-10-19-harness-feature-d-optimization.md) | `@dsh-cc/harness-optimizer`, bounded Propose–Probe–Compose | A, B, C |
| E | [Validated experience](2026-10-19-harness-feature-e-experience.md) | `@dsh-cc/harness-experience`, explicit promotion and recall | A, C, D |
| F | [On-demand task refinement](2026-10-19-harness-feature-f-refinement.md) | `@dsh-cc/command-refine`, explicit task-level experimentation | A, B, C, D; E optional |

All new packages except F are private workspace libraries/CLIs under `packages/evaluation/`. They MUST NOT be boot-mounted into the standard bundles. F lives under `packages/interaction/`, is an optional plugin, and is absent from the default bundles. No new package imports another package's `src/` path. Package manifests, TypeScript project references, test aliases, lockfile entries, and public exports MUST be updated in the corresponding implementation PR. Runtime libraries MUST NOT depend on an installed Python Harness² checkout.

## 4. Implementation and release sequence

1. Merge A with schemas, storage, fingerprints, and deterministic fixtures. No model calls.
2. Merge B with a fake launcher and Linux isolation integration tests. Real execution remains opt-in. Its Harness² bridge is experimental and pinned to the reference revision.
3. Merge C with synthetic examples, offline scoring, and the full negative acceptance suite. This establishes a useful baseline-only evaluation tool.
4. Merge D with fake proposers, then an explicitly invoked model-backed smoke run. A through D are the first usable offline experiment release.
5. Merge E after a development/holdout pilot. Proposed and validated experiences MUST be distinguishable before any recall ships.
6. Merge F only after the offline pilot passes the acceptance criteria in C. F does not wait for broad automatic recall because recall remains explicit.

Each implementation PR MUST update the status in its own design, cite executable tests for its acceptance rows, and list deviations. A documentation merge is not a feature release. README capability claims are added only with the implementation that makes them true, with semantically matching English and Chinese descriptions. New English documentation uses direct technical English; this proposal does not claim certified ASD-STE100 compliance.

## 5. First pilot

Use a new, versioned VWA task suite with 12 development tasks and 12 sealed holdout tasks: four historical analyses, four literary analyses, and four research syntheses in each partition. Each task supplies immutable local source text and a required Markdown output path. A task family MUST remain entirely within one partition. If 24 independently annotated tasks are not available, the pilot stops at development evidence; it MUST NOT relabel development samples as holdout.

Each task needs adjudicated core claims, known major faults in deliberately flawed source/argument material where applicable, and the scoring inputs expected by the chosen VWA scorer. Existing receipt metrics, a small semantic fixture set, and the existing 30-document extraction corpus are not substitutes for end-to-end task annotations. A human curator prepares the suite, a second annotator reviews it, and the adjudicator records disagreements. Holdout labels live outside the executor's mounts.

Freeze the solver route, reviewer route, prompts, policy, validators, dependencies, source snapshots, and repetitions before starting. Use three independent repetitions per task and variant. For the first smoke experiment, choose one development task before execution, use `k=1` and three repetitions, and cap solver executions at 20 (the planned matrix needs 12). Rotate to other development tasks only in new explicitly budgeted experiments. Full-development-suite optimization requires a larger declared budget; it must not silently reuse the 20-execution cap. Development optimization never consumes holdout tasks; confirmation uses a separate, explicitly budgeted holdout experiment for one selected candidate and the baseline (72 executions). Publish quality counts and denominators, total input/output tokens, cost, wall time, unknown usage, and all failures. Do not claim model-independent benefit from one solver route.

## 6. What is deliberately excluded

- Editing model weights, provider implementations, permission policy, evaluator rules, gold labels, or VWA receipts.
- Running optimization at startup, on every turn, or during memory consolidation.
- Automatically applying candidate changes to tracked files, a marketplace installation, user memory, or a live session.
- Replaying email sends, deployments, purchases, or other external effects.
- Treating an LLM's preference, a self-reported success, or a single run as proof of improvement.
- Shipping a general-purpose sandbox implementation. B uses a concrete container contract and fails when it cannot enforce it.

## 7. Reference and attribution

The reference implementation supplies the experimental pattern, not dsh-cc's runtime policy:

- [Harness² overview](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/README.md).
- [Recursion](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/recursion.py): separate invariant/domain candidates and execution-backed composition.
- [Selection](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/selection.py): anonymized output comparison; this design deliberately retains the baseline and permits abstention.
- [Experience library](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/harness2/core/library.py): full adopted harness plus cue, lesson, and evidence.
- [Experiment guide](https://github.com/google-research/harness2/blob/1cfe254e8d25b15f37048c3730134686abe60335/docs/EXPERIMENTS.md): run isolation, cost, and evaluation-leakage considerations.

Reimplement the contracts in TypeScript. Any copied Apache-2.0 source must retain its required license and attribution; benchmark and third-party assets require separate license review before inclusion. No upstream datasets or code are copied by this documentation PR.
