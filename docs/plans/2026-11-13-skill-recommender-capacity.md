# S1-06 capacity: token-packed batches, deadline-partial coverage, and route-aware budgets for skill recommendation

**Status: Implemented — PR #417 (branch worktree-skillrec-capacity; the disclosed deviation: the eval-replay extension of §7 lives in the vitest capacity suite, tests/capacity.spec.ts, because the replay corpus schema has no timing fields).** Three-lane blind review converged 2026-11-13 (r1–r4; verdicts and folds in §11): every blocker and major from codex, grok and critic is folded, and codex's final confirmation round returned GO.
**Source baseline:** `origin/main` @ `e012e266` (includes PR #397 delivery and PR #414 preset mount).
**Parent design:** `docs/plans/2026-11-02-systemone-06-skill-recommendation.md` (S1-06). This document changes §"Settings and tool contract" (defaults, one new key, widened ranges), §"State machine, ordering, and behavior" step 4 (completeness rule → coverage-floored prefix), the batch-planning half of §"Candidate eligibility and complete state", and **revises the parent's active-mode acceptance gate (§"Rollout criteria revision")**. Everything else of the parent design stands unchanged.
**Evidence base:** live verification on the author's machine (2026-11-13): eligible pool 71 skills, decision-usage ledger and pty-driven real TUI session cross-checked; per-skill metadata measured (batch of 8 exceeds `max-input-tokens: 4096` ⇒ ~512+ tokens per skill including state share).

## 1. Problem statement

PR #414 mounted `@dsh-cc/skill-recommender` into the cc/vwa presets. Live verification on a real cc session shows the judgment **never completes** under any in-range settings combination:

- **P1 (pool bounds).** Eligible pool 71 skills; `max-candidates` defaults to 64; `buildEligiblePool` refuses (`pool-bounds`, `pool.ts:120`) — "refuse, don't truncate". Zero model calls, zero ledger rows.
- **P2 (per-batch budget).** With `max-candidates` 128, fixed-size slicing (`pool.ts:316-330`) cuts at exactly `batch-size` then refuses any batch over `max-input-tokens: 4096` (`unavailable('input-tokens')`). Measured metadata makes batch-size 16 and 8 refuse; batch-size 4 fits, yielding 18 batches.
- **P3 (total deadline).** `timeout-ms` budgets ALL batches combined (`recommend.ts:170-178`: one `deadline`, `AbortSignal.any([caller, deadline])`). 18 batches × ~500 ms observed ≈ 9 s > 5 s (schema maximum). The run ends `unavailable('timeout')` or `cancelled` — which of the two depends on where the abort lands (loop guard vs in-flight signal) — discarding 8–10 already-answered batches.
- **P4 (silent diagnosis).** The tool result exposes only "unavailable"; the reason and coverage numbers are invisible without the decision-usage ledger.

The modes interlock into a double bind: batch-size large enough for the deadline busts the token cap; batch-size small enough for the token cap busts the deadline. Additionally, the planner's cost estimate (`requestCost`, chars/3 + 10% headroom, `pool.ts:152-167`) does not agree with the runner's admission arithmetic (`estimateDecisionInputTokens`, codepoint weights + envelope, `decision.ts:239-243`), so even a "fitting" plan can be refused `budget` by the runner.

Non-goals (unchanged): read-only advisory tool; normal skill tool is the only execution entry point; nothing persisted per recommendation; explicit user/higher-level choices take precedence.

## 2. Goals

1. A judgment over a real-world eligible pool (measured 71; target headroom 128+) **completes** under the new defaults on a lane with ~500 ms per-batch latency — coverage 1.0 within `timeout-ms`.
2. Deadline exhaustion degrades **explicitly and boundedly**: a prefix-partial judgment with disclosed counts, never a silent hole; never cached.
3. Client-side planning and runner-side admission use the **same estimator and the same caps**, so a planned batch is admitted by construction.
4. Every refusal carries its machine-readable reason in the tool output.

## 3. Current mechanics (anchors into the shipped code)

| Mechanism | Anchor | Behavior |
| --- | --- | --- |
| Eligible pool + bounds | `pool.ts:104-139` | task/pool/metadata bounds; over `maxCandidates` → `unavailable('pool-bounds')` |
| Batch planning | `pool.ts:316-330` | fixed slices of `size = max(1, floor(batchSize))`; per-slice `requestCost > maxInputTokens` → `unavailable('input-tokens')` for the WHOLE call |
| Cost estimate (client) | `pool.ts:152-167` | `ceil((stateTokens + questionTokens) × REQUEST_HEADROOM)` — chars/3 + 10% |
| Runner admission (gateway) | `decision.ts:238-243` | `estimateDecisionInputTokens` vs `min(maxInputTokens, perRequestTokens)` per request, and per question vs `min(maxInputTokens, perQuestionTokens)`; over → `{reason: 'budget'}` |
| Dispatch loop | `recommend.ts:166-214` | sequential; one total deadline; per-batch remaining slice as `timeoutMs`; `AbortSignal.any([caller, deadline])` into `runner.run` |
| Abort surfacing | `recommend.ts:186, 239-241`; `decision.ts:280-281` | deadline abort in-flight → runner `cancelled`; thrown abort → `error` unless the CALLER signal fired → `cancelled` |
| Completeness rule | `recommend.ts:204-209` + `pool.ts:396-410` | one missing/invalid item → `unavailable('malformed')`, whole result discarded |
| Cache | `cache.ts:220-223`, `cache.ts:134-161` | `defaultCacheable` stores every `kind: 'recommended'`; key enumerates thresholds explicitly; REQ-3 (`specs/tla/decision-gate-coalescing/design.md:34-35`): only complete validated answers are cached |
| Route identity | `types.ts:85-99` | `perRequestTokens` (input budget — ledger records it as `reservedInputTokens`), `perQuestionTokens`, `maxQuestions`; planner never sees them today |
| Runtime collapse | `runtime.ts:62-68, 240, 253-255` | a reason-less `UNAVAILABLE` const erases the reason; shadow returns `recommendations: []` with no numbers |

## 4. Design

Four changes, one PR. C1 rewrites the planner; C2 aligns estimator and caps with the runner; C3 relaxes completeness to a never-cached prefix-partial; C4 moves defaults and widens the output surface.

### C1. Token-packed batches (replaces fixed slicing)

`planBatches(items, task, limits, catalogHash, questionCap?)` — signature unchanged except ONE optional trailing parameter `questionCap: number` (default `limits.maxInputTokens`, which reproduces the runner's per-question bound when no route caps apply; `recommendSkills` passes the folded value — see C2-3). Algorithm — **the emit invariant is the spec, in BOTH dimensions**: `current` is, at every point, a batch whose request estimate fits the request cap AND whose every question estimate fits the question cap; only validated batches are ever emitted.

```
admits(batch) := estimate.requestTokens <= effectiveTokenCap
             AND max over ids of estimate.questionTokens[id] <= questionCap
             AND batch.length <= effectiveBatchCap
batches = [], current = []
for item of items (stable name order — pinned by the pool):
  if admits([...current, item]):
      current = [...current, item]                     // extend — still valid
      continue
  if current.length > 0: emit(current)                // current is valid by invariant
  if admits([item]):
      current = [item]                                // restart singleton — validated
  else:
      return unavailable('input-tokens')                // a single item cannot fit either cap
if current.length > 0: emit(current)                   // last batch — valid by invariant
```

Where `estimate = estimateDecisionInputTokens(stateOf(batch), questionsOf(batch))` (C2) and `emit(batch)` builds `{items, questions, state}` exactly as today (property order, id assignment, question insertion order unchanged — `pool.ts:282-297, 326`). Both dimensions are required because `questionTokens[id]` bills the ENTIRE batch state per question (`decision-hash.ts:113-116`) — a request that fits `effectiveTokenCap` can still carry a question over `questionCap` when `perQuestionTokens < perRequestTokens`. Implementer notes:

- **Invariant coverage**: the `admits` predicate is evaluated on every extension and every restart singleton; the final emit needs no re-check (invariant). Every emitted batch satisfies all three bounds — pinned by tests at the extension cut, the restart, and EOF.
- `effectiveBatchCap = Math.max(1, Math.min(Math.floor(limits.batchSize), Math.floor(routeCaps.maxQuestions / 2)))` — the `Math.max(1, Math.floor())` clamp is byte-identical to today's (`pool.ts:321`). If `routeCaps` is absent, `effectiveBatchCap = Math.max(1, Math.floor(limits.batchSize))`.
- **Equivalence property (qualified, r2)**: when `routeCaps` is absent AND every fixed slice of the old algorithm fits under `admits` with the NEW estimator (codepoint weights — a slice that fit the deleted chars/3 `requestCost` may NOT fit `estimateDecisionInputTokens`, e.g. CJK metadata roughly doubles the count), greedy packing emits the byte-identical batch list (both estimates are monotone in the slice: state and questions only grow). With route caps present, a question cap below the request cap, an estimator-sensitive catalog, or defaults changed (C4), plans legitimately differ. The equivalence test re-implements the old slicing inline as its oracle and validates it with the NEW estimator (the old code and the old estimator are both deleted).
- Determinism: pure function of `(items, effectiveCaps)`; stable name order unchanged.

### C2. Gateway-aligned estimator and caps

The planner and the runner must run the **same arithmetic**:

1. `costOf` is `estimateDecisionInputTokens(state, questions).requestTokens`, imported from `@dsh-cc/systemone` (already a runtime dependency of this package). The local `requestCost` is **deleted** — one estimator, no drift. (The client's old chars/3 estimate disagreed with the codepoint-weighted gateway arithmetic; with Chinese metadata the divergence is systematic.)
2. The runtime folds the route caps into effective limits after `identifyRoute` and passes them down on `RecommendRequest` as `routeCaps?: { perRequestTokens: number; perQuestionTokens: number; maxQuestions: number }` (optional; absent in unit tests and the replay eval):
   - `effectiveTokenCap = min(limits.maxInputTokens, routeCaps.perRequestTokens)`
   - `effectiveBatchCap = clamp(min(floor(limits.batchSize), floor(routeCaps.maxQuestions / 2)))` (two questions per skill)
   - `maxQuestions < 2` → `unavailable('route-cap')` BEFORE `planBatches` (after the pool build; pool bounds are not route-derived).
3. The per-question window is a PACKING CUT, not an assertion. `estimateDecisionInputTokens` bills each question as envelope + **the entire batch state** + the question's own serialization + margin (`decision-hash.ts:113-116`), so `questionTokens[id]` grows with the batch even though the question template is ~30 tokens. The runner admits each question against `min(maxInputTokens, perQuestionTokens)` (`decision.ts:240-243`); the planner therefore validates `max(questionTokens) ≤ questionCap` inside `admits` (C1) — mirroring the recall planner's fold-all-predicates-into-the-add approach (`memory` package `recall-decision-plan.ts:119-135, 160-166`). `questionCap = min(effectiveTokenCap, routeCaps.perQuestionTokens)` — the SAME formula the runner applies once the wire field carries `effectiveTokenCap` (C2-4), so planner and runner agree by construction. (When `perQuestionTokens ≥ perRequestTokens` the request-level check subsumes the question-level one because `requestTokens ≥ questionTokens[id]` always; the question cap binds first only on narrow-question lanes, which is exactly when it must.)
4. **Wire field**: `dispatch` sends `maxInputTokens: effectiveTokenCap` (today it sends the raw setting, `recommend.ts:236`) — the runner's `min()` then agrees with the planner by construction.
5. Residual `reason: 'budget'` has two sources. The **token-window** checks (`decision.ts:238-244`) are unreachable after C2: same estimator, same caps, identity revalidated. The **quota permits** are not: a denied `reserveGlobal`/business reservation vetoes `budget` (`decision.ts:288, 298`) — a deployment condition no planner can avoid. Both propagate as `unavailable('budget')` with full discard, unchanged from today; the design claims unreachability only for the token-window source.
6. Cache key: the full route identity (seven fields + revision) is already key material; two routes with different caps never share entries. No key change from C2.
7. **Honest limit**: on lanes whose real window is small (e.g. `perRequestTokens` 1024 on some models), `effectiveTokenCap` is small and batches are small — the mechanism stops producing *false* refusals; it cannot make a slow or narrow lane fast. On the author's route the ledger records `reservedInputTokens: 16384`, so `min(8192, 16384) = 8192` applies.

### C3. Prefix-partial coverage under deadline exhaustion — never cached

The completeness rule becomes: **a judgment may be published from an answered prefix of the batch list when the only cause of incompleteness is deadline exhaustion and the answered prefix covers at least `min-coverage` of the pool by item count. Partial results are never stored in the cache.**

Exact semantics:

1. `judged = pool items in answered batches`; `eligible = pool items`. Coverage = `judged / eligible` (an empty pool short-circuits earlier with the valid empty recommendation, `recommend.ts:157-159`; it reports `judged: 0, eligible: 0`).
2. **Abort normalization (r1 + r2 blocker fixes — classification must be exact in both directions).** The combined `AbortSignal.any([caller, deadline])` still goes to `runner.run` (the in-flight request must stop), but outcomes are normalized before the partial decision:
   - In the `run.status === 'unavailable'` branch: `reason === 'timeout'` → **deadline exhaustion** unconditionally — `dispatch` passes the remaining deadline slice as the runner's `timeoutMs` (`recommend.ts:182`), so EVERY runner timeout is deadline-derived even when `deadlineController.signal.aborted` is still false at the millisecond the status lands (the race the r2 review caught). `reason === 'cancelled'` → deadline exhaustion only when the deadline signal fired AND the caller did not abort; otherwise lane-side → full discard.
   - In `dispatch`'s catch: caller signal aborted → `cancelled`. Else an **abort-class** throw (AbortError / aborted-fetch DOMException) with the deadline signal fired → **deadline exhaustion**. A NON-abort throw that merely coincides with the deadline is a lane error → `error`, full discard — the same failure must not publish or discard depending on its representation.
   - The loop's between-batch guards: the CALLER check runs FIRST (`request.signal.aborted` → `cancelled`, honoring the precedence below), then `Date.now() >= deadline || deadlineController.signal.aborted` → deadline exhaustion — note this reorders today's guard sequence (`recommend.ts:174-175` checks the deadline first).
3. **Precedence (total order): caller cancellation > stale identity > deadline exhaustion > everything else — enforced by evaluation order at every check site.** If the caller aborted at all — even simultaneously with the deadline — the result is `cancelled`, nothing published (the loop guard therefore tests the caller signal BEFORE the deadline, §C3-2). A `revalidate()` throw (stale identity, `runtime.ts:166`) discards everything even if the deadline also fired; `revalidate` keeps running before each batch and after each await, before any coverage decision. Lane-side `error`/`malformed`/`budget`/`unconfigured` discard everything — partial is a deadline remedy only, and a non-abort lane error coinciding with the deadline is a lane error, not exhaustion.
4. Deadline exhaustion + `judged / eligible >= limits.minCoverage` + `judged > 0` → publish the partial: `{kind: 'recommended', recommendations: selectRecommendations(scored, limits), decisionIds, judged, eligible}`. Below the floor, or `judged === 0` → `unavailable('timeout')` (today's behavior).
5. `min-coverage: finite number, 0..1, default 1` — default 1 is byte-identical to today's completeness rule. Invalid values refuse the whole section (same as every key).
6. **Caching: partials never enter the cache.** `defaultCacheable` gains the condition `coverage is complete` (`judged === eligible`); a partial outcome is returned to the caller but NOT stored, and an existing complete entry is never overwritten by a partial. This preserves REQ-3 verbatim (`specs/tla/decision-gate-coalescing/design.md:34-35` "partial results never enter the cache") — the coalescing model needs no change. Rationale beyond the contract: a partial is timing-dependent; caching it for the TTL would pin one run's latency to every later caller.
7. Batches run in stable name order, so the covered set is always a **prefix of one deterministic order**. For a given number of answered batches the content is deterministic; **the number answered is timing-dependent** and is disclosed as `judged`/`eligible` counts — never claimed as deterministic.
8. Shadow mode computes and returns the same outcome shape (`judged`, `eligible`, `decisionIds`); the shadow cache value is subject to rule 6 identically.

### C4. Defaults, ranges, output surface, versions

**Settings changes — defaults raised, schema ranges widened in the same PR (a default at the schema maximum leaves zero headroom, which is its own defect):**

| Key | Old default / range | New default / range | Rationale |
| --- | --- | --- | --- |
| `max-candidates` | 64 / 1–128 | 128 / 1–256 | measured pool 71; range widened so the default is not at the ceiling |
| `batch-size` | 8 / 1–16 | 16 / 1–32 | now a cap; lets batches fill to the token budget |
| `max-input-tokens` | 4096 / 512–16384 | 8192 / 512–16384 | packing target; real ceiling is `min(settings, route.perRequestTokens)` |
| `timeout-ms` | 1500 / 100–5000 | 5000 / 100–10000 | old default was below its own reference plan (8 batches × ~500 ms = 4 s > 1500 ms); range widened off the default |
| `min-coverage` (new) | — / — | 1 / 0–1 | the completeness knob; 1 = original rule |

**Output surface (additive, threaded through the runtime — the `UNAVAILABLE` const and the bare shadow return are replaced):**

- `recommended` and `shadow` statuses gain `judged: integer` and `eligible: integer` (counts, not just a fraction — the copy needs "judged 60 of 71", and a fraction alone cannot render it).
- `unavailable` gains `reason: string` (the `RecommendationUnavailableReason`; `route-cap` is new from C2).
- `runtime.ts` threads `value.reason` / `value.judged` / `value.eligible` instead of the collapsing constants (`runtime.ts:62-68, 240, 253-255`); `SkillRecommendationResult` (`types.ts:172-177`) gains the fields. The runtime's own refusals — exits with no `value` (`runtime.ts:174-198, 246-266`) — get a CLOSED reason mapping so every unavailable result satisfies the contract: invalid settings section → `settings`; missing runner/actor/watermark/route/catalog (`listCandidates` undefined) → `unconfigured`; stale identity or changed catalog hash → `stale`; the pool/plan refusals **propagate their own reason** (`pool.kind === 'unavailable'` at `runtime.ts:190` carries `pool.reason` — `pool-bounds`, `metadata-bounds`, `input-tokens`, `route-cap` — through instead of collapsing to the const); the generic non-stale catch (`runtime.ts:266`, after `reportFailure`) → `error`; `off`-mode and empty-pool early returns keep their existing statuses.
- **The threading does not stop at the runtime (r2)**: `index.ts`'s `execute` reconstructs the tool output field-by-field (`index.ts:235-244`) and the output schema is `additionalProperties: false` (`index.ts:199`) — BOTH must add `judged`/`eligible` (recommended, shadow) and `reason` (unavailable), and the `execute` mapping must pass them through explicitly. Tool-output tests assert the fields end-to-end.
- Copy templates: recommended → "Advisory skill recommendations for this task (judged J of E visible skills): …"; empty-result partial → "No visible skill met the thresholds (judged J of E visible skills)"; shadow → unchanged generic copy (the counts ride in the structured output); unavailable → today's sentence with `reason` in the structured field.

**Versions:** `SKILL_RECOMMENDATION_POLICY_VERSION` → `skill-recommendation-policy-v2` (the publication policy changed; invalidates cross-version cache hits). `SKILL_RECOMMENDATION_QUESTION_VERSION` unchanged (per-skill rubric untouched).

**Cache key:** `minCoverage` is added at **three sites** — `RecommendationThresholds` (`cache.ts:69-90`), the key-building field array (`cache.ts:134-161`), and `thresholdsOf` (`contract.ts:150-163`). Two floors over the same pool never share an entry; cross-floor reuse gets a dedicated test.

### Rollout criteria revision (parent §206)

The parent's active-mode gate (≥100 shadow requests, complete-judgment rate ≥ 99%, p95 ≤ 1500 ms) is **revised by this document**: p95 ≤ the effective `timeout-ms` (default 5000); "complete-judgment" means coverage 1.0 in ≥ 99% of requests, with the ≤ 1% remainder allowed to be `unavailable('timeout')` refusals (at the default `min-coverage: 1` a partial cannot exist — the floor would have to be lowered deliberately for partials to count); the shadow soak count (≥100) is unchanged. The 1500 ms figure matched the old defaults and is superseded by them. The parent doc gets a one-line pointer to this section.

## 5. Failure table (revised rows only)

| Condition | Old | New |
| --- | --- | --- |
| eligible pool > `max-candidates` | `unavailable('pool-bounds')` | unchanged |
| single item cannot fit `effectiveTokenCap` | `unavailable('input-tokens')` (any batch over) | only the true singleton case; batches otherwise pack to fit |
| route `maxQuestions < 2` | not detected client-side | `unavailable('route-cap')` before dispatch |
| deadline exhausted, coverage < `min-coverage` or judged 0 | `unavailable('timeout')` | unchanged |
| deadline exhausted, coverage ≥ `min-coverage`, judged > 0 | `unavailable('timeout')` (all work discarded) | published partial with `judged`/`eligible` counts; **never cached** |
| caller cancel / stale identity / lane error / malformed / budget | full discard | unchanged — precedence §4-C3-3 |

## 6. Files and implementation slices

| Path | Change |
| --- | --- |
| `packages/skill/skill-recommender/src/pool.ts` | C1 packing (two-dimension emit invariant, `admits`); `requestCost` deleted, `costOf` via `estimateDecisionInputTokens`; the optional `questionCap` parameter |
| `packages/skill/skill-recommender/src/recommend.ts` | C3 normalization + precedence + coverage accounting; `routeCaps` merge into effective limits; wire `maxInputTokens: effectiveTokenCap` |
| `packages/skill/skill-recommender/src/types.ts` | `routeCaps` on `RecommendRequest`; `judged`/`eligible` on the recommended outcome; `reason` on the unavailable result |
| `packages/skill/skill-recommender/src/settings.ts` | C4 defaults + ranges + `min-coverage` row; docstring "twelve keys" → "thirteen" (`settings.ts:7`) |
| `packages/skill/skill-recommender/src/contract.ts` | `thresholdsOf` gains `minCoverage` |
| `packages/skill/skill-recommender/src/cache.ts` | `RecommendationThresholds` + key array gain `minCoverage`; `defaultCacheable` requires complete coverage |
| `packages/skill/skill-recommender/src/runtime.ts` | pass `routeCaps` from the resolved identity; thread `reason`/`judged`/`eligible`; the `UNAVAILABLE` const and bare shadow return replaced (this is a real change, not "no structural change") |
| `packages/skill/skill-recommender/src/index.ts` | output schema (`judged`, `eligible`, `reason` — `additionalProperties: false` updated), the `execute` field mapping (`index.ts:235-244`), copy templates, policy version constant |
| `packages/skill/skill-recommender/tests/` | §7 |
| `packages/skill/skill-recommender/README.md` + `README.zh.md` | settings table (13 rows, new defaults/ranges, `batch-size` rewording), failure table, coverage disclosure |
| `docs/claude-code-capabilities.yaml` | `skills.recommendation`: the "only names and two numbers leave the tool" sentence (yaml ~2996-2997) → "names, two numbers, and judged/eligible counts"; re-point the `README.md#L18-L27` / `#L49-L57` anchors (the settings-table growth moves the lines); `pnpm docs:parity` |
| `packages/preset/cc/README.md` + `README.zh.md` | "twelve settings keys" → "thirteen" (both line 14) |
| `docs/plans/2026-11-02-systemone-06-skill-recommendation.md` | Status note + rollout-criteria pointer (§"Rollout criteria revision") |

**Gate inventory for the PR (what actually turns red and must be run):** `check-readme.mjs --write` (README.i18n hash re-record for BOTH edited packages), `check:capabilities`, `check:parity`, `check:size` (pool.ts is 410 lines — the packing rewrite adds ~30, still under 500; watch it), `check:spec-deps`. `tool-schema-gate` does NOT move (output-schema fields are not AST call counts; the count of 2 is unchanged). The tool-order fixture stays untouched (`recommend_skill` remains in the `<unlisted-tools>` rest bucket). No defaults literal exists in `index.ts` — the four-surface audit here is three surfaces (schema `.default()`, `DEFAULT_RECOMMENDATION_SETTINGS`, reader fail-soft), plus verification that no wiring literal exists.

Single PR, ordered commits: (1) C1+C2 planner/estimator, (2) C3 loop/normalization/cache, (3) C4 settings/output/docs. Each commit green independently.

## 7. Tests and acceptance

Unit (pool): the `admits` invariant in BOTH dimensions (request tokens and per-question tokens, which bill the whole state — include a case where the request fits but a question does not) at the extension cut, the restart, and EOF (including `[small, oversized]` and `batchSize: 1` cases); singleton-over-cap refusal on either dimension; the old-clamp equivalence (`Math.max(1, Math.floor())`); **equivalence oracle: the test re-implements the old fixed slicing inline and validates it with the NEW estimator** — byte-identical batches when the old plan was valid under `admits` and `routeCaps` is absent; `route-cap` when `maxQuestions < 2`; planner/runner estimator agreement (the planner's `costOf` and the runner's `estimateDecisionInputTokens` are the same import — pin the import, not a copy).

Unit (recommend): deadline-exhaustion normalization on all paths — between-batches guard (with the caller check pinned FIRST), in-flight runner `timeout` WITHOUT the deadline signal set (the millisecond race — must classify as exhaustion), in-flight runner `cancelled` with the deadline signal fired, abort-class throw with the deadline signal fired, and the NEGATIVE: a non-abort throw coinciding with the deadline → `error`, full discard; caller-cancel-wins-over-deadline (simultaneous abort → `cancelled`, nothing published); stale-identity-beats-deadline; lane `error`/`malformed`/`budget` (both sources) still full-discard; partial published only at floor; judged-0 always `unavailable('timeout')`; `min-coverage: 1` byte-identical to today.

Unit (cache): partial outcome NOT stored; complete outcome stored; two `min-coverage` floors do not share entries; a later call after a partial re-runs (no suppression).

Unit (settings): `min-coverage` validation (reject −0.1, 1.1, NaN, non-number); new defaults and ranges on all three surfaces; invalid section still refused wholesale.

Eval replay: extend the fake scorer with a per-batch latency/timeout knob and the deadline-signal simulation; add packing-under-budget, deadline-partial floor-satisfied, floor-violated, simultaneous-abort cases.

**Live acceptance (this machine, after implementation):** with the new defaults and `mode: shadow`, one `recommend_skill` call over the 71-skill pool: ≤ 6 decision-usage rows for `skill-recommendation` (estimate: 71 skills ÷ ~15 per batch at 8192 tokens ≈ 5 batches, from the measured per-skill cost — an estimate, not a guarantee), outcome `shadow` with `judged: 71, eligible: 71`, wall clock ≤ 5 s. Then with `timeout-ms: 2000`, `min-coverage: 0.8`: a partial with `judged/eligible ≥ 0.8` and the disclosed counts, and a follow-up call re-running (nothing cached). Both recorded in the PR's Verification section.

## 8. Alternatives rejected

- **Parallel batch dispatch.** S1-02's per-attempt budget order and the `decision-gate-coalescing` TLA model pin one-in-flight sequencing; a burst changes quota dynamics. Re-modeling is out of scope for a capacity fix.
- **Pool truncation to fit `max-candidates`.** Silently judging a subset is strictly worse than an explicit prefix with disclosed counts; violates "refuse, don't truncate".
- **Per-batch timeout instead of a total deadline.** Unbounded total latency; the total cap is the cost contract.
- **Split-retry on runner `budget` refusal.** The token-window source of `budget` is unreachable after C2 (same estimator and caps on both sides); the quota source (`decision.ts:288, 298`) is a deployment condition that retrying cannot fix — retrying a denied reservation is wrong, and retrying a window refusal cannot happen. Retries would be dead code or quota abuse.
- **Caching partials with TTL.** Contradicts REQ-3 verbatim and pins one run's timing to later callers; excluded (§4-C3-6).
- **Catalog-side metadata slimming.** Descriptions are the skill authors' contract; this package consumes, never edits.

## 9. Formal design screening

Not-needed, and the r1 challenge is answered by C3-6: the coalescing/cancellation protocol (`specs/tla/decision-gate-coalescing`) is untouched — partials are excluded from the cache, so REQ-3's `CacheCompleteOnly` invariant holds verbatim; request coalescing, refcounting and identity revalidation stand as pinned. The partial rule itself is a pure function (coverage floor over a deterministic-order prefix) plus loop guards and an abort-normalization switch, all unit-pinnable; no new cross-actor ordering, no crash-recovery surface, no ownership change. The route-cap fold is arithmetic before dispatch.

## 10. Rollout and compatibility

- **Deployments with explicit settings** that previously produced valid plans AND whose slices also fit the NEW estimator (CJK-heavy catalogs may not — §4-C1): identical batch lists (equivalence, §4-C1), identical outcomes. Where the new estimator is stricter, a previously-valid plan may regroup or refuse — that is the gateway-alignment fix working, disclosed here.
- **Deployments without explicit settings** (new defaults): plans legitimately change — pools of 65–128 skills that were refused `pool-bounds` now run; batches regroup to the token budget; the deadline default rises. Every change is the fix working, and each is disclosed here.
- `min-coverage` defaults to 1 → completeness behavior byte-identical for any deployment that does not opt in.
- Policy version bump invalidates the in-process cache once at upgrade; there is no persisted cache.
- All default and range changes are user-visible and disclosed in the PR body and release notes.

## 11. Review ledger

- **r1 (three lanes, blind, 2026-11-13):** codex NO-GO (4 blockers: packing singleton/EOF emission, gateway-admission mismatch, deadline/cancel precedence, partial caching vs REQ-3; 5 majors), grok NO-GO (4 blockers: same four, plus estimator/window depth — `perQuestionTokens`, 1024-window lanes, wire field; 2 majors: defaults-vs-equivalence and gate inventory corrections), critic GO-WITH-CHANGES (2 blockers: trigger-path miss, cache contradiction; 4 majors: three-site cache key, wire field, output threading, schema-max headroom).
- **Fold (into v2):** all blockers and majors — C1 emit invariant, C2 single-estimator + three caps + wire field, C3 normalization + precedence + never-cached, C4 range widening + counts-not-fractions + runtime threading + parent-gate revision, gate inventory corrected, equivalence qualified and oracled, determinism claim corrected to prefix-content vs prefix-length.
- **r2 (three lanes, blind, 2026-11-13):** codex NO-GO (4M+2m), grok GWC (1B+2M+2m), critic GWC (2M+2m+1nit). All three confirmed the v2 folds landed (emit invariant, cache exclusion, ranges, gate inventory).
- **Fold (into v3, r3 delta):** codex r3 confirmed 5/6 resolved with zero new defects; finding 6 closed by adding the last two mapping rows (pool/plan reasons propagate `pool.reason` at `runtime.ts:190`; the generic non-stale catch at `runtime.ts:266` maps to `error`).
- **r4 (codex micro-confirmation, 2026-11-13):** GO — finding 6 closed, zero remaining findings.
- **Fold (into v3):** per-question window becomes a packing cut inside `admits` (three-lane hit — the estimator bills the whole state per question); equivalence re-qualified against the NEW estimator with the oracle validating old slices under it; deadline classification made exact in both directions (runner `timeout` is deadline-derived even in the signal race; non-abort throws coinciding with the deadline stay `error`; loop guard reordered caller-first); `budget` unreachability claim scoped to token windows only (quota is a legitimate source; §8 rationale rewritten); output threading extended through `index.ts`'s `execute` mapping and `additionalProperties: false`; runtime-only refusals get a closed reason mapping; rollout remainder spelled out; `planBatches` signature pinned (optional `questionCap` parameter, `effectiveQuestionCap = min(effectiveTokenCap, perQuestionTokens)` matching the runner); pool.ts line count corrected to 410.
