# Feature C: independent evaluation and baseline-inclusive adoption

- Status: proposed.
- Parent: [Harness experiments](2026-10-19-harness-experiments.md).
- Package: `packages/evaluation/harness-eval` (`@dsh-cc/harness-eval`, private).
- Depends on: [A](2026-10-19-harness-feature-a-contracts.md), [B](2026-10-19-harness-feature-b-execution.md).

## 1. Problem and solution

An optimizer can overfit visible examples, select an attractive but incorrect answer, or select a worse candidate when the baseline is absent. Missing outputs and failed evaluations can disappear from an average. Changing evaluator rules during optimization makes comparisons meaningless.

Separate execution, development feedback, sealed evaluation, and adoption. Always retain the baseline. Use independent deterministic validators first, bounded blinded semantic assessment second, and a fixed policy to decide whether a patch can be proposed for promotion. Selection never applies a patch.

## 2. Task suite and evaluator contract

A suite manifest contains `{schemaVersion:1, suiteId, version, tasks:Task[], families: {familyId,partition}[], evaluatorId, evaluatorDigest, annotationManifestDigest}`. All references are immutable A digests. Every family belongs to exactly one partition, and taskId is unique. Before freezing the manifest, a curator MUST check paraphrases, source-derived variants, and shared answer templates for family overlap. Record the curator's signed-off text and its digest in the annotation manifest; the runner cannot prove semantic separation by hash alone.

An evaluator is a controller-only library with public `evaluate(result, task, sealedInputs, signal): Promise<Evaluation>` and `describe(): {id, codeDigest, schemaDigest}`. It cannot edit the result, invoke the solver, or write VWA receipts. Output:

```ts
interface Evaluation {
  schemaVersion: 1; runId: string; resultDigest: Digest;
  evaluatorDigest: Digest; scoringManifestDigest: Digest;
  status: 'scored' | 'unscored';
  valid: boolean; blockers: { code: string; target: string }[];
  qualityUnits: number | null; // integer 0..1_000_000
  metrics: { name: string; numerator: number; denominator: number; units: number | null }[];
  findings: { code: string; target: string; evidenceRefs: string[]; summary: string }[];
  error?: { code: string; message: string };
}
```

`unscored` has `valid:false`, null quality, and a required error; it is not a measured zero. A failed execution is evaluated as `scored`, `valid:false`, quality 0, and blocker `EXECUTION_FAILED`. Missing or invalid required output similarly scores 0 with an explicit blocker. This distinction keeps task failure in the denominator without pretending an evaluator outage is a quality measurement. Any unscored planned sample makes adoption inconclusive. Metrics with denominator zero have null units and cannot satisfy a threshold.

The scoring manifest fixes evaluator code, prompts, model routes/options, source/annotation digests, metric definitions, and policy before the first run. Only the controller mounts it. Development feedback exposes located faults and metrics for development tasks. It never exposes holdout labels, feedback, trajectories, or artifacts to D. The optimizer receives the holdout aggregate decision only after its candidate is sealed, and that candidate cannot be revised in the same experiment.

## 3. VWA pilot evaluator

Implement `adapters/vwa-writing` using the existing public `@dsh-cc/vwa-eval` scorer exports plus a new controller-only output-to-annotation adapter. The adapter has fixed extraction and review prompts and independent reviewer routes. Validate their outputs against strict schemas before converting them into the scorer's input types. A scorer function cannot recover missing gold labels: a task missing adjudicated expected data is `unscored` with `ANNOTATION_MISSING`.

Read the emitted body and argument graph from the frozen execution result. Run mechanical path/hash/span checks and the existing VWA semantic review through their public services in a separate evaluator context. Do not accept solver-authored review records, status flags, argument grades, receipts, or assertion strings as measurements. Model reviewers have no tools except one forced structured response tool, and receive only the frozen task material, body, graph, and evaluator-assigned target IDs. Their output is untrusted data; instructions embedded in artifacts have no authority.

For each task, compute metrics from adjudicated annotations: core-claim recall, major-fault recall, clean-sample false-positive rate when the task is annotated clean, and support-relation macro-F1. Retain counts and denominators. The pilot's `qualityUnits` is the equal-weight mean of core-claim recall and support-relation macro-F1, rounded to the nearest integer with ties upward after multiplying by 1,000,000. Both denominators must be nonzero. Major-fault and clean false-positive measures are hard gates rather than compensating terms. An annotation-free prose preference is not a substitute for these metrics.

The sample is `valid:true` only if mechanical checks pass, no blocker remains, core recall is at least 950,000 units, major-fault recall is at least 900,000 when its denominator is positive, support macro-F1 is at least 850,000, and the task's VWA delivery check passes independently. Clean false positives are aggregated over annotated clean tasks at decision time. If the suite has no clean tasks or no annotated major faults, confirmation is `inconclusive` with `ANNOTATION_COVERAGE_MISSING`. This gate intentionally prevents a small easy corpus from claiming robust review quality.

Semantic evaluation uses a maximum of two attempts: initial response and one schema-repair response with validation errors only. Provider transport failures are unscored; they do not trigger an unbudgeted retry. Exhausted repairs are `EVALUATION_FAILED`. Record reviewer route, prompt, input and output digests, and usage. Every reviewer/repair dispatch reserves and settles through A's shared budget ledger and B's broker; C never imports D. Missing budget or an unsupported accounting bound fails before dispatch. Existing VWA failure and budget semantics remain authoritative inside each review.

## 4. Development comparison and optional blinded preference

For development only, expose candidate versus baseline summaries with exact counts. An optional selector can inspect complete anonymized outputs and deterministic findings to rank candidates. Assign anonymous IDs by sorting variantId and applying the frozen run-order shuffle; retain the map in the controller. Selector input excludes variant names, baseline labels, proposer rationale, quality labels from holdout, and prior preferences. Preserve full artifact blobs; navigation limits may affect one read, never silently truncate the source artifact.

The selector returns `{ranking: string[], abstain:boolean, reasons:{id, evidenceRefs, summary}[]}`. IDs must be exactly the allowed set; every claimed evidence reference must resolve. One schema repair is allowed within D's budget. Failure or abstention preserves the baseline preference. A selector ranking is advisory only and cannot override hard gates or provide adoption evidence. Baseline-only and invalid-candidate cases do not need a selector call.

## 5. Confirmation policy

Freeze `AdoptionPolicy` as `{schemaVersion:1, id:'vwa-pilot@1', minTasks:12, repetitions:3, minMeanGainUnits:20000, maxCostRatioMilli:1250, maxWallRatioMilli:1500}`. No policy field is configurable within an existing experiment. New values require a new versioned policy and experiment.

Evaluate exactly one candidate selected using development evidence against the baseline on the untouched holdout suite. The controller maintains an append-only holdout-consumption registry keyed by suite digest and optimization lineage (the initial baseline plus all descendant candidate/experiment IDs). Atomically mark the suite consumed for that lineage before the first holdout dispatch. Resume of the same frozen confirmation is allowed; selecting another descendant, changing the patch after seeing feedback, or restarting a failed confirmation against the same suite is forbidden. A further optimization round needs newly sealed holdout families. Publicly released holdout annotations cannot be used for a new confirmation claim. Pair results by `(taskId,repetition)` with three repetitions. A comparison missing a planned pair is inconclusive. All 12 tasks must be independently annotated, and satisfy the annotation-coverage requirements above. Confirmation cost is reserved separately before starting; the development cap is not reused.

Compute integer/rational aggregates without premature rounding:

1. Candidate has no more invalid samples than baseline and no new blocker code/target pair in any corresponding sample. Evaluator targets are stable annotation IDs or a hash of taskId, source/body path, normalized claim text, and rule code; solver-generated UUIDs MUST NOT be used for cross-variant finding matching. New invalid-output failures use the declared output path as their target. Failed executions participate as invalid zero-quality samples.
2. Candidate's pooled core recall is at least .95; pooled major-fault recall is at least .90; pooled support macro-F1, computed by pooling per-class counts before macro averaging, is at least .85; clean-sample major/blocker false-positive rate is at most .10. Baseline statistics are reported as well.
3. Average quality across all planned candidate samples exceeds baseline by at least 20,000 units. For each task, average its paired differences; every task average must be nonnegative. This conservative first policy does not permit cross-task regression to be offset by another task.
4. Total known candidate solver cost divided by total baseline solver cost is at most 1.25, and mean solver wall time ratio is at most 1.5. Report optimization and evaluation overhead separately; they are never hidden in solver cost. If baseline cost or time is zero, ratio is 1 only if both totals are zero; otherwise it is infinite. Unknown solver cost or incomplete usage makes confirmation inconclusive.
5. Compute an exact two-sided sign test over nonzero task-average differences. For `n` nonzero tasks and `w` positive differences, use `p = min(1, 2 * sum(C(n,i), i=0..min(w,n-w)) / 2^n)`. Require `p <= .05`. Tied tasks are excluded from n. No nonzero tasks means inconclusive. Display sample size and p; do not call this proof of universal benefit.

All five requirements must pass. A hard regression or failed threshold yields `keep-baseline`. Missing evidence, evaluator failures, unsupported isolation, incomplete samples, or unknown cost yields `inconclusive`. Passing yields `eligible-for-promotion`, not automatic installation.

The decision record contains `{schemaVersion:1, decisionId, experimentId, candidateDigest, baselineDigest, policyDigest, evaluationDigests, outcome, checks, aggregateMetrics, createdAt}`. `checks` is a sorted array of `{id, result:'pass'|'fail'|'unknown', observed:JsonObject}` with one entry for every numbered requirement and every precondition. Persist and hash it before returning. A deterministic renderer produces matching JSON and Markdown reports.

## 6. Commands and reporting

Expose private package scripts, each receiving argv directly:

- `harness-eval evaluate --experiment <id> --store <path>`: evaluate all sealed results; resume only exact evaluation identities.
- `harness-eval decide --experiment <id>`: validate completeness and create one immutable decision.
- `harness-eval report --experiment <id> --format json|markdown`: read-only deterministic render.

Exit codes: 0 completed command (including keep-baseline), 2 inconclusive, 3 invalid input/preflight/store, 4 execution/evaluation infrastructure error, 130 cancelled. JSON output includes the outcome; callers MUST NOT interpret exit 0 as promotion approval. Missing default store argument resolves through A.

Reports include task/family partitions, all failures, scored/unscored counts, excluded metrics, per-task paired differences, confidence limitations, precise provider revisions or null, cache/resume flags, isolation assurance, solver cost, total experiment cost, and unknown accounting. They MUST distinguish artifact validity, reviewer assessment, measured benchmark performance, and generalization claims.

## 7. Acceptance and TDD sequence

| Fixture | Required outcome |
| --- | --- |
| All candidates worse; baseline best | Keep baseline |
| Beautiful but unsupported document | Independent checks fail; preference cannot rescue it |
| One invalid output or solver failure | Zero-quality scored sample stays in denominator |
| One reviewer outage or missing gold input | Unscored; decision inconclusive |
| Quality improves but new blocker or one task regresses | Keep baseline |
| Quality improves but cost cap exceeded | Keep baseline |
| Positive but insufficient sign-test evidence | Keep baseline under the fixed policy; report limited evidence |
| Unknown cost, missing pair, unverified isolation | Inconclusive |
| Holdout output requested by proposer | Access denied; no optimizer feedback |
| Changed scoring prompt or annotation | Evaluation cache misses; old decision remains immutable |
| Candidate passes all requirements | Eligible for promotion; workspace remains unchanged |
| Hand-calculated sign tests and pooled macro-F1 examples | Exact expected numerator/denominator and outcome |

Use deterministic mocked reviewer responses and hand-calculated fixtures first. Model-backed tests do not replace the scorer/decision unit suite. A pilot report must be reviewed before F is enabled for distribution; this does not require the pilot to find a winning candidate.
