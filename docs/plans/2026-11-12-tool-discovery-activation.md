# Tool Discovery Activation (extend existing eval → flip)

- Date: 2026-11-12
- Status: Design — accepted (four three-seat blind-review rounds converged; final: all seats CONFIRMED, one prescribed clause folded verbatim). Eval harness (corpus v2 classes, judge-stub gate arm, live runtime arm) implemented in this PR; the sampling sidecar, real-lane adapter, shadow window, and mode flips remain later PRs per § Flip policy.

r3 → r4 fold: admitted-restriction rationale corrected (judge never sees denied candidates — scope-of-judgment, not TN-padding; micro-F1 excludes true negatives arithmetically).
- Program: context-engineering input governance (doc 6 of 8)
- Depends on: nothing hard; doc 3's ledger (`toolsCount/toolsBytes` rows) is the post-flip monitoring instrument.
- Literature basis: ToolMenuBench (CMTF 32.1% → 85.7% success); Signals and Queries (cheap classifier pre-filter).

## Formal design

- mode: auto (session-adopted; no formal-design screening clause in the project rules at this revision; adoption snippet at `<skill>/references/agents-snippet.md`).
- decision: not-needed (covered by an existing model)
- triggerIds: FD-T1/T2 would apply to the discovery runtime's cache-then-coalesce protocol, but that protocol is **already modeled** by `specs/tla/decision-gate-coalescing` (its design.md lists tool-discovery among the shared-protocol features); this document changes no discovery-runtime behavior — it adds eval arms and a pre-registered flip policy.
- backends: `none`
- rationale (selected scope): the later `shadow → active` flip PR touches runtime behavior and must re-screen against the existing model (extending it if the sampling sidecar adds new state); this docs-only PR needs no model of its own.

## Problem

The SystemOne tool-discovery decision layer is built and dormant: `cc-tool-discovery.mode` defaults to `'off'` (`packages/core/tool-search/src/discovery-settings.ts:43,55`; modes `off|shadow|active`). In active mode a cheap-lane judge scores deferred tool candidates so only causally relevant tools activate per query. It is off because there is no live-lane evidence for judge quality, latency, or cost.

Correction to the r1 framing (grok fold): the repo **already has** an offline discovery eval — `packages/core/tool-search/scripts/eval-discovery.mjs` driving production `buildEligiblePool`/`buildQuestions`/`selectNames` over `tests/fixtures/discovery-corpus.json` (schema `expectedNames`, subsets `chinese|synonym|none|restricted`, Recall@3, no network). "No offline corpus or eval anywhere in the repo" was false. This doc extends that harness rather than inventing a parallel YAML corpus.

## Goals / Non-goals

Goals:

1. Extend the existing eval runner with a live-lane path, versioning, and production-runtime coverage.
2. Pre-registered scoring, thresholds, and a flip policy with uncertainty-aware semantics.
3. Operational effects of shadow documented and verified before any rollout.

Non-goals:

- No lexical/ToolSearch UX changes; no multi-tool planning; no new corpus format family.
- Not flipping `active` in this program (later PR, gated by this pipeline + a shadow window).

## Design

### Corpus (extend, don't fork)

- Keep `tests/fixtures/discovery-corpus.json`. Add top-level `corpusVersion` (integer; every report pins it; gate re-runs required on bump).
- Grow from 20 cases to **≥ 60 total** across five labeled classes — (a) direct-fit, (b) lexical-overlap/wrong-server traps, (c) multi-intent, (d) negative-only (`expectedNames: []`), (e) metadata keyword-stuffing — targeting ≥ 12 per class, or declaring intentional multi-label membership where a case carries more than one class (delta-round fold: `5 × 12` cannot fit an exclusive split of 20+10-20 entries).
- One table extends the schema and resolves the dual taxonomy (existing `subset: chinese|synonym|none|restricted` vs new `class` labels): `class` is the gating dimension; `subset` stays as a legacy filter; the existing `selfcheck` floors keep working (class-(d) rows must also be `subset: none` or a dedicated `class-d` subset — grok fold that existing selfcheck would otherwise reject them). Codex's corollary: class (d) is excluded from per-class F1 requirements and gets its own gates (scoring section).

### Runner (extend `scripts/eval-discovery.mjs`)

The existing runner has two modes — `replay` and `selfcheck` (`eval-discovery.mjs:97-100`) — and `replay` is an **oracle**: its `answersFor` returns max relevance iff the name ∈ `expectedNames` (`:260-273`), so an F1 gate over `replay` is tautological (~1.0 by construction — grok's delta BLOCKER). The arm layout is therefore:

- `--mode replay` / `--mode selfcheck` (existing, unchanged): schema/oracle integrity pins, kept forever; never gated on F1.
- `--mode judge-stub` (new): a **deterministic, non-oracle stub judge** (frozen keyword/rule scorer over candidate metadata; deliberately imperfect so the F1 line is meaningful). This is the **CI-safe F1 gate arm**.
- `--mode live` (new): drives the **production discovery runtime** in-process with an instrumented judge adapter over the developer's configured decision lane — exercising multi-batch sequences sharing one deadline, over-cap candidate pools, `unavailable`, cancellation, and `exact` short-circuit (`discovery-runtime.ts:468-476`). Fallback mapping corrected (codex + grok delta): **runner timeout → `unavailable`**; only shared-deadline exhaustion or unusable answers map to `incomplete` (`discovery-runtime.ts:318-346`; existing test contract `tests/discovery-runtime.spec.ts:124-130`). Reports map accordingly.
- Package script `eval:discovery` is added to `packages/core/tool-search/package.json` pointing at the node script (r1 referenced a script that didn't exist yet — folded).

### Scoring (pre-registered, no post-hoc)

- Gold labels apply at the **(query, candidate)** pair level; judge output is the **production activation set after `selectNames`** — never the raw question answers and never the `exact`-short-circuit path (excluded from judge-quality scoring; grok + codex convergent).
- Primary metric: micro-F1 over (query, candidate) labels **restricted to admitted candidates** (the judge never sees a denied candidate, so those pairs measure permission gating, not judge quality — codex delta correction: micro-F1 computation itself excludes true negatives; the rationale is scope-of-judgment, not TN-padding as earlier text incorrectly said). Report both restricted and unrestricted numbers; only the restricted line is gated.
- Secondary diagnostics: per-item exact-set accuracy; per-class breakdowns.
- Class (d) has no positives → F1 undefined there (codex): (d) is gated on **false-activation rate** (`|activated| / |catalog candidates| ≤ 0.10`) and exact-set accuracy = 1.0, and is explicitly **exempt** from the universal per-class F1 floor (zero-denominator semantics; the :55 per-class floor applies to classes with positives only — codex delta fold).
- Latency: report p50/p90/**max** (p95 on ~50 items is the ~3rd-largest sample — report the small-sample caveat in the gate file; critic fold).
- Cost: report candidates judged, batch calls, cache hits/misses, and measured judge input/output tokens. Shadow cost is bounded by `maxCandidates`/`batchSize`/cache TTL — **not** by `maxActivations` (that only caps the published name list; grok + codex).

### Flip policy (binding)

`off → shadow`: allowed only after (i) the stub-mode gate is green in CI and (ii) the shadow-side prerequisites below are met. Shadow behavior effects are **not** zero and are documented (codex fold): ToolSearch awaits the judge inside its budget (`timeoutMs: 1200`), and a cancelled discovery can return without loading lexical results — the rollout checklist must verify latency, cancellation, and fallback paths in a live TUI before enabling shadow on a real profile.

Pre-shadow prerequisites:

1. Stub-mode gate green: micro-F1 ≥ 0.85 aggregate and ≥ 0.80 per labeled class with ≥ 12 items/class (frozen seed, deterministic — **not** subject to judge variance).
2. Live-mode snapshot green: over the real lane, majority-of-3 runs per item (critic variance fold), same thresholds; reported separately from the stub gate (grok: no "3/3 live lottery" — the stub run is the gate; the live numbers are evidence).
3. **Shadow-audit telemetry exists**: discovery runtime intentionally retains no queries/candidate names/answers (`discovery-runtime.ts:108-109,361-370`). Before the shadow window, a dev-only sampling sidecar flag lands, recording per decision: `queryHash8`, the **suggested set** (names the judge would activate) and the **lexical set** (names plain ToolSearch would surface), outcome class, latency, and a **session/event locator** (sessionId + request seq) so the auditor can locally recover the query text and catalog context from the session log (codex delta fold: hash-only fields make disagreements unlabelable). No raw query text in the sidecar itself. Small additive change in the same PR.

`shadow → active` (the later flip PR):

1. The two offline arms above, plus **held-out confirmation**: the corpus splits 2/3 tune / 1/3 held-out; thresholds are only tuned on the tune split; held-out is evaluated once at flip time (codex fold).
2. Shadow window ≥ 2 weeks on the maintainer profile: all shadow-vs-lexical disagreements (or a stratified sample of ≥ 60) manually labeled; gate = judge-correct rate with **one-sided 95% Wilson lower bound ≥ 0.60** (a bare "70% of 30" has an LCB near 52% — codex's statistics fold).
3. Post-flip monitoring committed in the flip PR: doc 3 ledger `toolsCount/toolsBytes` vs baseline, decision-usage rows, explicit rollback (`mode: 'shadow'`).

### Possible-small-fix list

Eval may surface prompt/batching bugs (recall program precedent). Fixes land as separate PRs referenced from the eval ledger; corpus per generation is frozen (`corpusVersion`).

## Verification

- Unit: metric math over synthetic judge outputs (restricted vs unrestricted micro-F1); zero-denominator semantics (class d exempt from per-class F1 but gated on its own lines); held-out split determinism; fallback-reason mapping (runner timeout → `unavailable`; shared-deadline exhaustion → `incomplete`).
- Integration: `--mode replay`/`selfcheck` kept as pins; `--mode judge-stub` in CI as the F1 gate arm (deterministic, non-oracle); `--mode live` exercised with a scripted fake lane adapter (deterministic, CI-safe).
- Flip-surface audit (four surfaces) only in the later mode-flip PR; this PR changes no production default.

## Risks

- Small corpus: mitigated by class floors, held-out split, and the shadow window as the second independent opinion; thresholds are stated as empirical pass lines, not confidence claims.
- Shadow cost: bounded by `maxCandidates: 64` × `batchSize: 8` × cache TTL 60s; the sampling sidecar is hash-only.
- Judge drift between stub and live is expected; the policy treats stub as gate and live as evidence to keep CI deterministic.

## Fold ledger

r1 → r2 (critic + grok + codex, GWC → folded): replaced "invent a parallel YAML corpus" with **extend the existing `eval-discovery.mjs` + `discovery-corpus.json`** (grok's major correction — the runner exists); scoring pre-registered as micro-F1 over (query, candidate) after `selectNames`, `exact` path excluded; class labels added; negative-only class gated on false-activation rate with declared zero-denominator semantics; variance policy (stub = CI gate, live = majority-of-3 evidence); production-runtime driving incl. multi-batch/deadline/cancel/over-cap; shadow operational effects documented (await latency, cancellation-without-lexical); shadow-audit telemetry prerequisite (runtime retains no queries today); Wilson-LCB flip audit; cost bound corrected to candidates/batches/cache (not `maxActivations`); fallback anchors corrected (`:448-451`, `:456-489`; timeout ↦ `incomplete`); package script registered properly.

r2 → r3 delta (three seats): runner arm layout re-anchored to the real modes — existing `replay` is an oracle (F1 gate there would be tautological; grok BLOCKER), kept as schema pins, with a new deterministic non-oracle `judge-stub` arm as the CI gate and `live` as evidence; class-(d) F1 contradiction resolved (exempt from the universal per-class floor, gated on its own false-activation/exact-set lines); micro-F1 restricted to admitted candidates (auto-TN padding); shadow-audit telemetry enriched to suggested+lexical sets + session/event locator (hash-only fields are unlabelable); fallback mapping corrected to production (runner timeout → `unavailable`, shared-deadline exhaustion → `incomplete`); corpus target ≥ 60 with subset↔class coexistence table.
