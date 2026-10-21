# VWA Post-lane-2 Fix Batch — Fix 2: Default Budget Rebalance and Honest Refusal Messaging

## Status: Designed — three-lane blind review converged (r1 full review: GO-WITH-CHANGES on all seats; r2 delta confirmation; r3 micro-confirmation — final round GO on all seats). Implementation pending; user sign-off pending.

All anchors cite tree `b64af0e8`, verified 2026-10-21. Stacks on Fix 1 (the
gate's arithmetic is Fix 1's contract).

## 1. Problem

### 1.1 Default budget makes a complete `stage:"all"` review unreachable (Issue 2, defaults half)

Current defaults (settings.ts:52-62, 76-92):

| setting | default |
| --- | --- |
| `review-max-calls-per-run` | 40 |
| `review-max-output-tokens-per-run` | 24 000 |
| `review-max-output-tokens-per-call` | 3 000 |
| `review-max-wall-ms` | 180 000 |
| `review-call-timeout-ms` | 45 000 |
| `review-concurrency` | 2 |
| `review-claims-batch-size` | 1 |

A minimal complete review (`ALL_ORDER`, tools.ts:102) is 1 sources + 1
support + ≥1 claims + 1 arguments + audit (with Fix 1's real batching: ≥1
extract batch + 1 align) ≥ 6 first-attempt calls. Under the Fix 1 gate
(1.5 retry allowance): 6 × 1.5 = 9 attempts × 3 000 = 27 000 < 96 000 — fits.
A representative 10-claim graph at the default batch size 1 (5 sources + 5
support groups + 10 claims + 3 arguments + 2 audit calls = 25 first attempts
→ ceil(25 × 1.5) = 38 attempts × 3 000 = 114 000) exceeds the 96 000
default and is refused with guidance to enable claims batching — with
batch 2 (the suggested guidance) the same graph is 20 first attempts →
ceil(20 × 1.5) × 3 000 = 90 000 and fits. The 96 000 default therefore
covers graphs up to 21 first-attempt calls; larger graphs get a refusal
whose option (b) (batching) or Fix 3's revision path is the designed
escape. Verification observed stage-single reviews pass while
`stage:"all"` never does.

The wall default compounds it at runtime: observed calls take 20-40s
(verification history, 18 runs); 180s at concurrency 2 fits roughly 6-9
calls with zero retry margin. `review-max-wall-ms` is a runtime liveness
deadline (`BudgetTracker.deadline`, review-tasks.ts:122-128), so a plan
that passes the token gate can still die `incomplete` on the wall.

### 1.2 `review-claims-batch-size` default never followed Feature C's guidance (Issue 5, P2)

The setting defaults to 1 (settings.ts:62, 89) while `suggestedClaimsBatchSize`
(= `clamp(floor(maxOutputTokensPerCall / 1500), 1, 4)` = 2 at the default
per-call budget) prints in the `/vwa init` capacity message
(commands.ts:258-261). Every project created without an explicit settings
change inherits batch size 1.

### 1.3 The refusal message's options are misleading (Issue 5, P2; Issue 4's undisclosed cost)

The `BUDGET_INSUFFICIENT` refusal (feasibility.ts:88-89) offers:

> (a) reduce target scope, (b) enable claims batching on a new project,
> (c) create a new project with a larger budget.

- (b) executed alone is a no-op: creating a new project without first
  changing settings inherits the same defaults and gets the same refusal.
  The dependency is not stated.
- (c) does not disclose its cost: all registered sources, evidence, claims,
  and completed review records are lost.

## 2. Design

### F2.1 Default changes (three-surface audit per repo convention)

| setting | old | new | rationale |
| --- | --- | --- | --- |
| `review-max-output-tokens-per-run` | 24 000 | 96 000 | the minimal review (9 attempts = 27 000) and graphs up to 21 first-attempt calls fit; a 10-claim batch-1 graph (25 calls = 114 000) is refused with the batching/revision escape; attempt capacity 32 |
| `review-max-wall-ms` | 180 000 | 900 000 | operational choice sized on observed 20-40s calls with staged-serial timing (see honesty note below); wall stays a liveness limit, not spend |

Unchanged — including `review-claims-batch-size` (stays 1; see F2.2):
`review-max-calls-per-run` 40, `review-max-output-tokens-per-call` 3 000,
`review-call-timeout-ms` 45 000, `review-concurrency` 2,
`review-max-input-tokens-per-run`, `review-max-artifact-chars`,
`review-max-context-chars-per-task`, `review-claims-batch-size`.

The 96 000 figure supersedes an earlier 48 000 recommendation by the
orchestrator; r1 review (all three seats) established that 48 000 only
covers the empty-ish minimum; 96 000 covers graphs up to 21 first-attempt
calls, with batching guidance and Fix 3's revision as the escape for larger
graphs.

Three-surface audit (the repo's default-flip checklist):
1. Schema `.default()` — settings.ts:54, 56.
2. `DEFAULT_VWA_ARGUMENT_SETTINGS` constant — settings.ts:82, 84.
3. Raw-reader fail-soft — `resolveSection` (settings.ts:114-140) falls back
   to the DEFAULT constant per key; absent/malformed/missing-key sections
   all flow there; no independent hardcoded branches exist for these
   numeric keys. Present-but-empty sections take defaults via `num()`.

### F2.2 Claims batch size: default stays 1

The r1 review (two seats, MAJOR) established that batch 2 sits exactly at
the truncation cliff: 2 claims × the 1 500-token typical-output constant =
3 000 = `maxOutputTokensPerCall`, with zero margin for response overhead,
and the truncation retry class has NO retry (review-call.ts:161, 165).
Feature C shipped `suggestedClaimsBatchSize` as guidance, not a validated
default. The flip is dropped; the guidance remains in the init message and
refusal option (b). Raising the per-call cap instead would re-open run
budget recalibration and is out of scope.

### F2.3 Refusal message rewrite

The `BUDGET_INSUFFICIENT` message (feasibility.ts:88-89) becomes factual,
dimension-aware, and self-contained:

> Planned N calls (M with retry headroom) exceeds the frozen budget on
> [output tokens: X > Y | call count: M > Z]. Options: (a) reduce the review
> scope (targetClaimIds / stage); (b) raise review-max-output-tokens-per-run
> (or review-claims-batch-size) in settings BEFORE creating a project —
> existing projects keep their frozen budget; (c) create a new project with
> a larger budget (registered sources, evidence, claims and completed review
> records are NOT carried over).

- The failed dimension is named (Fix 1's gate refuses on tokens AND calls;
  a token-only message would lie on a calls-bound refusal). Both numbers
  stay in `details`.
- Option (b) states the freeze dependency explicitly.
- Option (c) discloses the loss.
- No revision-tool reference in this PR — Fix 3 adds option (d) and rewrites
  the init copy. Stack order Fix 1 → Fix 2 → Fix 3 keeps every intermediate
  message true.

### F2.4 Downstream surfaces that mirror the defaults

- `/vwa init` capacity message (commands.ts:244-261) derives from the frozen
  budget — recompute: `floor(96 000 / 3 000) = 32` attempt capacity, ÷1.5 ≈
  21 review calls per run. `commands.spec.ts:116-118` pins the derived
  numbers (8 and 5 today) and must flip (32 and 21).
- Package README (en + zh) settings tables list the defaults — update both
  languages (the README trio gate checks en/zh hash parity).
- `docs/plans/2026-10-19-vwa-lane2-feature-c-budget-feasibility.md` §C.2.2
  default-table mention: add a one-line deviation note in this PR's ledger
  (no rewrite of the historical design).

### F2.5 Wall honesty note

The 900 000 default is an operational choice sized on observed per-call
durations (20-40s) and the staged/serial execution structure (arguments
run at batch 1; audit extract/align dispatch sequentially). It is NOT a
worst-case bound: per-attempt timeouts scale up to 4× `callTimeoutMs` with
input size (review-call.ts:124-136), so a pathological run can exceed the
wall and finish `incomplete` — that is the wall's job as a liveness limit.
Fix 1 keeps the static gate off the wall dimension.

## 3. Tests

- Default pins (the repo's default-flip test pattern): schema-empty-section
  parse resolves to new defaults; absent settings file resolves to the
  constant; explicit values still win.
- Every vwa-argument test asserting 24 000 / 180 000 semantics (refusal
  thresholds, init capacity text, `commands.spec.ts:116-118`) is updated to
  the new arithmetic — flipped, not deleted.
- `packages/preset/cc/tests/vwa-lane2.real-boot.spec.ts`: its fixture passes
  an explicit `FrozenReviewSettings` (maxOutputTokensPerRun: 200 000), so it
  is structurally unaffected — run it anyway (the #270 lesson).
- A new default-path e2e assertion pair (the regression pin for Issue 2): a
  minimal complete review under pure defaults passes the Fix 1 gate; a
  10-claim batch-1 graph (25 calls) is refused with the batching guidance,
  and the same graph with `review-claims-batch-size: 2` (20 calls, 90 000)
  passes.

## 4. Alternatives considered

- **48k output tokens/run** (the orchestrator's original recommendation):
  rejected in r1 — only fits the minimal review; even a 10-claim graph at
  114k stays refused.
- **Flip batch default to 2**: rejected in r1 — zero margin at the per-call
  cap against the truncation class's no-retry policy; unvalidated capacity
  risk.
- **Gate on wall**: rejected in Fix 1 — the wall is a runtime liveness
  limit; a static wall gate would have to model the 4× input-scaled timeout
  ceiling and refuse healthy plans.

## Review ledger (full cycle, honest scope notes)

- **r1 full review**: critic GO-WITH-CHANGES; grok GO-WITH-CHANGES
  ($1.01 / 14 turns); codex GO-WITH-CHANGES (94.4k tokens, scope-constrained
  retry after an interrupted first run). All findings folded (full ledger:
  .scratch/vwa-fix-adjudication-r1.md): 48k → 96k (2.1); batch flip dropped
  (2.2); dimension-aware refusal copy (2.3); wall rationale rewritten
  (2.4); anchors corrected (2.5); init-copy truthfulness assigned to Fix 3
  (2.6); derived-number test pins listed (2.7).
- **r2 delta confirmation**: critic all OK / GO; grok all OK / GO; codex
  fold 9 PROBLEM (the v2 representative-graph arithmetic summed to 25 calls
  = 114k > 96k) — corrected in r3 surgery (batch-1 graph refused with the
  batching escape; batch-2 fits; 96k covers ≤ 21 first attempts).
- **r3 micro-confirmation** (scope-constrained): critic, grok ($0.53/13
  turns), codex (23.1k tokens) — fix A OK, verdict GO.
- Scope honesty: r2/r3 verified folds/surgical fixes only, not a full
  re-review. User sign-off pending.
