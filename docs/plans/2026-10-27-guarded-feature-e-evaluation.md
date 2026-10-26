# Feature E: controlled evaluation and bounded strategy optimization

- Status: proposed; E1 follows A2/B/C, E2 follows D and existing experiment A–D.
- Owner: new private `packages/evaluation/guarded-eval` (`@dsh-cc/guarded-eval`).
- Parent: [implementation order](2026-10-27-guarded-execution.md).

## 1. Objective and relation to existing designs

Measure whether reduced reasoning frequency improves complete-task cost without unacceptable quality regressions on repository work. Test ordinary native execution, equivalent Code Mode, literal chains, verification batching and persistent decisions separately. A lower token count on successful tasks alone is not sufficient. Include failed and timed-out paid runs.

The [2026-10-19 experiment design](2026-10-19-harness-experiments.md) proposes immutable snapshots (A), isolated runs (B), evaluation/adoption (C), bounded optimization (D), validated experience (E), and explicit task refinement (F), initially for VWA. Those are separate feature IDs. This document calls them Experiment A–F to avoid confusion with this set's A–E. Their existence as documentation is not an implemented dependency.

E1 is a standalone private evaluation CLI with the coding manifest and paired report below. If Experiment A–C are already implemented, use their public snapshot/store/runner/evaluator contracts. Otherwise E1 implements a minimal adapter with exactly the same isolation and separation guarantees required below, without claiming to implement the full general experiment platform. E2 MUST use Experiment A–D when available and MUST NOT add a competing general-purpose optimizer. Experiment E/F, memory recall and automatic experience promotion are not dependencies.

## 2. Versioned manifest and task suite

CLI `guarded-eval validate <manifest>`, `run <manifest> --partition dev|holdout --output <dir>`, and `report <run-dir>`. Model-backed run requires an explicit manifest with fixed route and budget; validate/report never call a provider. Output directories must be new empty directories, never overwrite a prior run. All paths resolve relative to the manifest directory; reject traversal outside the declared fixture root.

Manifest v1 fields: `suiteId`, `fixtureRevision`, `seed`, `tasks`, `variants`, `repetitions`, `solverRoute`, `hostRevision`, `dshCcRevision`, `priceTable`, `limits`, `policy`, and `artifactHashes`. Reject unknown keys. Store a canonical manifest hash with every run. `solverRoute` is a configured provider/model pair, never an alias with unresolved inheritance. Pin decoding/reasoning settings and provider revision when available; record unpinnable provider state as a limitation.

Each task has `{id,family,partition,category,fixturePath,baseCommit,promptPath,allowedPaths,validatorId,validatorHash,expectedArtifacts}`. Partition is dev or holdout. Category is one of `local-fix`, `multi-file`, `test-recovery`, `input-change`. Exactly 32 tasks in the first qualification suite: 16 dev and 16 holdout, four per category in each partition. Families/repositories derived from one base problem cannot cross partitions. Curators prepare tasks before experimentation; independent validators define behavior, including known regressions, not just textual diff similarity. At least one reviewer validates the task specification and hidden checks independently of the optimizer.

Use owned/synthetic permissively licensed fixtures; record licenses. Do not silently download or redistribute HumanEval/MBPP or paper artifacts. Fixture files are immutable, dependencies pinned/preinstalled, and execution runs without network. Hidden validator source/gold checks are mounted only in the evaluator after solver completion, never in solver/optimizer mounts. Task prompts include public tests where appropriate, not hidden expected outputs. Input-change tasks use a deterministic host event schedule keyed to a tool/boundary ordinal, not wall-clock sleeps; if a variant never reaches that ordinal, mark scenario non-triggered and fail its scenario endpoint rather than dropping the run.

Each variant runs three independent repetitions per task. Repetition IDs and seeds are fixed before runs. Pair by task/repetition; randomize variant execution order with the fixed suite seed to reduce temporal provider bias. Fresh writable filesystem, session, memory and caches per run; shared provider prompt caching is not claimed controlled and must be reported. Warm caches cannot be selectively provided to one arm. Fixtures never share writable worktrees across variants.

## 3. Variants and attribution

| ID | Configuration | Purpose |
| --- | --- | --- |
| N | Current frozen native dsh-cc | Primary baseline |
| P | Same route/tools, Code Mode with equivalent task instructions | Existing programmatic composition baseline |
| B | N plus literal action-chain tool | Incremental value of typed chains |
| BC | B plus explicit verification batches | Batch benefit without persistent host substitution |
| D-shadow | BC plus shadow controller | Selection overhead/eligibility, zero bypass claim |
| D-on | BC plus active persistent controller | Full candidate |
| D-single | D-on but invalidate graph after first execution | Persistence ablation |
| D-retain | D-on eligibility logging but always call original actor | Callback-retention ablation |

E1 runs N/P/B/BC only. E2 adds remaining variants. D-retain never executes the stored action in addition to the actor; it records the candidate then lets the normal actor act. A later actor action cannot be attributed as a certified stored execution. Distinguish D-retain from D-shadow in configuration only when experimental authoring/context settings differ; if identical, use one physical run set and explicitly report the alias, not duplicated evidence. D-single's conservative Bash invalidation remains the same as D-on. Never loosen validity rules just to produce more bypasses.

Keep instructions, tools other than the declared intervention, permission policy, deadline, solver route, validation and finalization fixed between comparable arms. Ordinary session compression settings are identical; separately altered compression is another named variant, never bundled into an EDG-only claim. C legacy verification remains identical outside explicit batches. If B/C prompts must teach new tool syntax, include those prompt tokens in total cost and report the difference.

## 4. Execution, budgets and isolation

Require an isolated Linux container/VM adapter with a read-only base fixture, fresh writable workspace, no host home/credentials, resource limits, process-tree teardown, and no outbound network except the explicitly proxied model endpoint. Model gateway credentials stay outside the solver mount. Tools run under the same frozen permission policy in every arm. No external send, deploy, push or purchase tools are mounted. A filesystem worktree alone is not an isolation boundary. Runner fails before paid calls if isolation or host physical accounting coverage is unavailable.

Default limits per run: 10 minutes wall time, 100 tool calls, 50 logical model calls and USD 2 authorized cost. Manifest may lower limits; raising requires a new frozen manifest. Gateway checks actual price/usage after each attempt and blocks subsequent requests when exhausted; already in-flight usage may exceed a cap, so report budget as an admission limit rather than a guarantee of exact final spend. Global E1 maximum is 192 dev executions (16 tasks × 3 repeats × 4 variants), USD 384 admission budget. A development smoke uses exactly one preselected task × one repetition × four variants (4 executions, USD 8). Do not silently expand smoke into qualification.

For E2, eight distinct variants on all dev tasks would require 384 executions, USD 768; manifest deduplicates equivalent shadow/retain arms and computes the exact count before admission. Qualification holdout tests only a preselected candidate and its frozen comparator N, with P retained as an additional comparator if a claim against Code Mode is made: 96 executions for two arms or 144 for three. Each stage has a separately explicit budget; unused development budget does not authorize holdout. Current user approval of design documents does not authorize running these future paid experiments.

Stop process trees on deadline and preserve artifacts/attempt events. No automatic retry for a failed or timed-out solver run. Infrastructure failures count in operational results and invalidate that pair for causal cost inference; any rerun repeats the whole pair under a new run ID, retains originals and requires remaining budget. Unknown cost, missing attempts, hanging descendants or accounting gaps cannot be relabeled as cheap failure. Do not exclude high-cost failures from averages.

## 5. Metrics and decision gates

Per run report: independent task/scenario pass, hidden-test result, allowed-path compliance, tool policy violations, complete A2 tokens/attempts/USD, wall time, logical calls, physical retries, peak active work, chain nodes, actual verification executions/reuses, audited bypasses, shadow eligibility, recovery/failure reasons and coverage. A failed artifact is still scored; an LLM saying it succeeded never supplies the label. Validation jobs consume CPU/time and their wall time is reported separately; paid reviewer/optimizer calls are a separate ledger bucket, not hidden.

Summaries show denominators and raw paired outcomes, total spend, mean cost per all runs, median/p95 latency, per-category quality and regressions, not just successful-task cost. Quality uses one task-level pass only if all three repetitions pass; additionally report repetition pass rate. Confidence resampling clusters all repetitions by task, never treats 48 repetitions as 48 independent tasks. Use 10000 paired task-bootstrap draws with the manifest seed; report 95% intervals for candidate-minus-baseline quality and mean cost ratio. Retain raw task counts because a small suite can be inconclusive.

Predeclared adoption gate for a candidate against N:

1. No permission, stale-input execution, cancellation-after-settlement or transcript/audit invariant violations in any run. One violation blocks adoption regardless of averages.
2. No task-level quality regression on development qualification or holdout, and candidate aggregate success at least baseline. This is an observed gate, not a claim of population noninferiority; publish uncertainty and do not say quality is proven unchanged.
3. Mean complete USD cost at least 10% lower, with paired 95% cost-ratio interval upper bound below 1.00. All compared runs need complete physical usage and pricing. If token cost is lower but USD is unknown, outcome is inconclusive for adoption.
4. p95 solver wall time no more than 10% above baseline. Latency gains require their own measurements.
5. B/D capability remains opt-in even after these gates. A default flip needs a larger separately designed study.

If claiming benefit over P, apply the same gates against P as well. Multiple development candidates are exploratory; select exactly one frozen candidate before sealed holdout to avoid repeated selection on holdout. If the sample cannot meet these gates, retain baseline or report inconclusive; do not relax thresholds after seeing results. Report quality regressions from any ablation rather than hiding them behind cost savings.

## 6. E2 bounded optimization

Use Experiment A snapshots, B isolation, C scoring/adoption, D proposal/probe/composition through public APIs. An adapter supplies the coding manifest and Feature A reports. Candidate schema permits only `continuation.max-nodes` (1–8), `decision-controller.max-bypasses-per-task` (1–8 for pilot), graph TTL (1000–60000), batch-enabled boolean, and prompt text under a dedicated experiment-only instructions file (max 4096 UTF-8 bytes). Valid fixed user-declared rules/allowlists remain frozen, not optimizer-editable.

Forbid modifications to permissions, host adapters, accounting, guards, cancellation, hashes, budgets, evaluator, gold data, test expectations, model routes, fixture source or hidden mounts. No arbitrary code patches. The baseline is always a selectable candidate. Maximum four proposals per development experiment, each max one composition of previously evaluated settings; reject invalid proposals before execution and record proposal cost. Offline proposer calls and rejected probes remain development costs. Report break-even deployment task count only when development cost and measured positive per-task savings are both known; otherwise return unavailable.

After dev selection, freeze full candidate hash, route, prompts and dependencies. A separate holdout run compares once. Failed holdout returns keep-baseline/inconclusive and ends that qualification; no tuning on leaked labels. Artifacts may be reviewed locally but do not auto-write user memory, a live session, marketplace plugins or tracked runtime configuration. Publication/adoption is an explicit later action outside the optimizer.

## 7. Implementation and TDD acceptance

Create `src/{manifest,variants,runner,coding-adapter,scorer,metrics,bootstrap,decision,report,bin}.ts`, JSON schemas, synthetic fixtures and fake-HTTP/model adapters. E2 adds an `experiment-adapter.ts` only after Experiment A–D public packages exist. Store immutable manifest, environment hash, launch record, task artifacts, independent scores, A ledger/report hashes, raw paired table and decision JSON under the selected output directory. Reports contain exact revisions, coverage and limitations. No secret values or raw hidden test source enter solver artifacts.

| Acceptance case | Required result |
| --- | --- |
| Deterministic fake model + known attempt ledger | Exact all-run tokens/cost and paired denominators |
| One failed expensive run | Included in totals and operational results |
| Missing usage or hanging child | Cost gate inconclusive, no adoption |
| Same family in dev and holdout | Manifest rejected before execution |
| Solver attempts hidden-test mount access | Access denied; isolation violation blocks adoption |
| N and P differ only in presentation | Frozen common route/policy/limits verified |
| Candidate lowers cost but loses one task | Keep baseline under quality gate |
| Candidate increases p95 beyond threshold | Keep baseline under latency gate |
| Shadow/retain variants equivalent | Run once, explicit alias, no doubled sample size |
| Input arrives at a stored-action boundary | Native host fixture proves invalidation; stale action fails safety gate |
| Optimizer proposes guard/policy/evaluator change | Rejected, proposal cost retained |
| Cost/bootstrap seed repeated | Byte-stable computed metrics excluding timestamps |
| Holdout failure followed by tuning attempt | Refused within the frozen qualification |

Run pure tests without paid calls, container/isolation integration, and fake provider transport tests before any smoke. A documentation merge establishes no experimental result. Each actual pilot commits or links the full manifest and redacted results plus a clear keep-baseline/adopt/inconclusive decision.
