# Tool Discovery Activation (extend existing eval → flip)

- Date: 2026-11-12
- Status: Design — r2 (critic + grok + codex r1 findings folded; all three GWC-class; major correction: an existing eval runner must be extended, not forked)
- Program: context-engineering input governance (doc 6 of 8)
- Depends on: nothing hard; doc 3's ledger (`toolsCount/toolsBytes` rows) is the post-flip monitoring instrument.
- Literature basis: ToolMenuBench (CMTF 32.1% → 85.7% success); Signals and Queries (cheap classifier pre-filter).

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
- Add 10-20 entries to reach ≥ 12 per class with explicit `class` labels: (a) direct-fit, (b) lexical-overlap/wrong-server traps, (c) multi-intent (respects `maxActivations: 3`), (d) **negative-only** (zero acceptable activations; `expectedNames: []`), (e) metadata keyword-stuffing. Class labels are new schema fields (needed for class-level gates — codex fold).

### Runner (extend `scripts/eval-discovery.mjs`)

- `node scripts/eval-discovery.mjs --mode stub` (existing behavior; frozen-seed stub judge — this is the **CI-safe gate arm**).
- `node scripts/eval-discovery.mjs --mode live` (new): drives the **production discovery runtime** in-process with an instrumented judge adapter over the developer's configured decision lane — not just the `buildQuestions` helpers. The runner must exercise: multi-batch sequences sharing one deadline, incomplete judgments (→ `incomplete`), over-cap candidate pools, `unavailable`, cancellation, and `exact` short-circuit (`discovery-runtime.ts:468-476`). Fallback anchor set corrected: `:448-451` (shadow returns lexical) and `:456-489`; **timeout folds into `incomplete`** (grok fold: there is no `timeout` reason), and reports must map accordingly.
- Package script `eval:discovery` is added to `packages/core/tool-search/package.json` pointing at the node script (r1's `pnpm --filter … eval:discovery` referenced a script that doesn't exist yet — folded).

### Scoring (pre-registered, no post-hoc)

- Gold labels apply at the **(query, candidate)** pair level; judge output is the **production activation set after `selectNames`** — never the raw question answers and never the `exact`-short-circuit path (excluded from judge-quality scoring; grok + codex convergent).
- Primary metric: micro-F1 over (query, candidate) labels. Secondary diagnostics: per-item exact-set accuracy; per-class breakdowns.
- Class (d) has no positives → F1 undefined there (codex): (d) is gated on **false-activation rate** (`|activated| / |catalog candidates| ≤ 0.10`) and exact-set accuracy = 1.0; excluded from F1 denominators by declared zero-denominator semantics.
- Latency: report p50/p90/**max** (p95 on ~50 items is the ~3rd-largest sample — report the small-sample caveat in the gate file; critic fold).
- Cost: report candidates judged, batch calls, cache hits/misses, and measured judge input/output tokens. Shadow cost is bounded by `maxCandidates`/`batchSize`/cache TTL — **not** by `maxActivations` (that only caps the published name list; grok + codex).

### Flip policy (binding)

`off → shadow`: allowed only after (i) the stub-mode gate is green in CI and (ii) the shadow-side prerequisites below are met. Shadow behavior effects are **not** zero and are documented (codex fold): ToolSearch awaits the judge inside its budget (`timeoutMs: 1200`), and a cancelled discovery can return without loading lexical results — the rollout checklist must verify latency, cancellation, and fallback paths in a live TUI before enabling shadow on a real profile.

Pre-shadow prerequisites:

1. Stub-mode gate green: micro-F1 ≥ 0.85 aggregate and ≥ 0.80 per labeled class with ≥ 12 items/class (frozen seed, deterministic — **not** subject to judge variance).
2. Live-mode snapshot green: over the real lane, majority-of-3 runs per item (critic variance fold), same thresholds; reported separately from the stub gate (grok: no "3/3 live lottery" — the stub run is the gate; the live numbers are evidence).
3. **Shadow-audit telemetry exists**: discovery runtime intentionally retains no queries/candidate names/answers (`discovery-runtime.ts:108-109,361-370`). Before the shadow window, a dev-only sampling sidecar flag lands (query hash8, candidate public names, outcome class, latency — no raw query text), so the manual audit has something to label. This is a small additive change in the same PR.

`shadow → active` (the later flip PR):

1. The two offline arms above, plus **held-out confirmation**: the corpus splits 2/3 tune / 1/3 held-out; thresholds are only tuned on the tune split; held-out is evaluated once at flip time (codex fold).
2. Shadow window ≥ 2 weeks on the maintainer profile: all shadow-vs-lexical disagreements (or a stratified sample of ≥ 60) manually labeled; gate = judge-correct rate with **one-sided 95% Wilson lower bound ≥ 0.60** (a bare "70% of 30" has an LCB near 52% — codex's statistics fold).
3. Post-flip monitoring committed in the flip PR: doc 3 ledger `toolsCount/toolsBytes` vs baseline, decision-usage rows, explicit rollback (`mode: 'shadow'`).

### Possible-small-fix list

Eval may surface prompt/batching bugs (recall program precedent). Fixes land as separate PRs referenced from the eval ledger; corpus per generation is frozen (`corpusVersion`).

## Verification

- Unit: metric math over synthetic judge outputs; zero-denominator semantics (class d); held-out split determinism; fallback-reason mapping (timeout → `incomplete`).
- Integration: `--mode stub` in CI as the gate arm; `--mode live` exercised with a scripted fake lane adapter (deterministic, CI-safe).
- Flip-surface audit (four surfaces) only in the later mode-flip PR; this PR changes no production default.

## Risks

- Small corpus: mitigated by class floors, held-out split, and the shadow window as the second independent opinion; thresholds are stated as empirical pass lines, not confidence claims.
- Shadow cost: bounded by `maxCandidates: 64` × `batchSize: 8` × cache TTL 60s; the sampling sidecar is hash-only.
- Judge drift between stub and live is expected; the policy treats stub as gate and live as evidence to keep CI deterministic.

## Fold ledger

r1 → r2 (critic + grok + codex, GWC → folded): replaced "invent a parallel YAML corpus" with **extend the existing `eval-discovery.mjs` + `discovery-corpus.json`** (grok's major correction — the runner exists); scoring pre-registered as micro-F1 over (query, candidate) after `selectNames`, `exact` path excluded; class labels added; negative-only class gated on false-activation rate with declared zero-denominator semantics; variance policy (stub = CI gate, live = majority-of-3 evidence); production-runtime driving incl. multi-batch/deadline/cancel/over-cap; shadow operational effects documented (await latency, cancellation-without-lexical); shadow-audit telemetry prerequisite (runtime retains no queries today); Wilson-LCB flip audit; cost bound corrected to candidates/batches/cache (not `maxActivations`); fallback anchors corrected (`:448-451`, `:456-489`; timeout ↦ `incomplete`); package script registered properly.
