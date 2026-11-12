# CCR Graduation Evidence Framework

- Date: 2026-11-12
- Status: Design — r3 (r1 full review + r2 delta review folded by three seats; pending r3 micro-confirmation)
- Program: context-engineering input governance (doc 5 of 8)
- Depends on: doc 3 (ledger — production-side monitoring). Fixture replay is offline.
- Literature basis: Referential Dangling (2608.04569); Later Questions (2610.27301); What Does Context Compression Cost (2608.16370 — completion-only evaluation masks re-acquisition); Paritok-4B (~96% identifier presence for coding agents); AGORA (granularity must match action grammar).

## Problem

Context Crusher (CCR) ships `enabled: true` / `mode: 'dry-run'` (`packages/context/context-crusher/src/config.ts:38-39`) — measures everything, rewrites nothing. No evidence framework exists that could justify flipping `mode: 'on'`: no CCR gold set, and today's only metric (savings rate) says nothing about evidence preservation, downstream-reference survival, or interaction-level exposure. This doc specifies that framework. It changes no defaults.

## Goals / Non-goals

Goals:

1. Deterministic offline evaluation of CCR's **two deterministic paths** (post-execute replacement; defer swap) against real dogfood sessions: evidence retention (M1), downstream-reference survival (M2), exposure (M3).
2. Gate thresholds committed in-repo with explicit sample-size semantics.
3. Auditable reports per run (JSON + markdown), with corpus/version lineage.

Non-goals:

- No runtime change to CCR.
- **The reducer path is out of scope for v1**: it requires an agent context, cordis alias resolution, and a live LLM side query (`context-crusher/src/reducer.ts:143-160`) — no deterministic replay exists. It will be evaluated separately with recorded LLM responses (v2).
- No LLM judges inside the evaluation.
- No reuse of the token-efficiency sanitizer (it redacts assistant bodies, replaces tool-output text with placeholders, drops tool-call arguments, and strips surface metadata — `test-support/token-efficiency/src/redactor.ts:67-76,117-136,160-163` — which would destroy exactly the identifiers and linkage this evaluation measures).

## Current behavior (anchors)

- CCR paths: post-execute accept-content replacement (`context-crusher/src/index.ts:189-261`), pre-step defer swap (`defer/swap.ts:120-142`), reducer routing (`index.ts:216`), dry-run intent rows on all paths (`:224/232/244-246`; deferred dry-run rows additionally write store entries carrying `hash` — the enum shape is pinned in the harness section below).
- Acceptance predicate logic lives *inside* the service method (isError 2×minBytes rule, block-shape check, route, savings, defer branches — `index.ts:189-261`); only `route`/`reduceToolOutput` are exported pure (`:42-55`). r1/codex convergence: replaying predicates by duplication invites sim-vs-production drift — see "Gate extraction" below.
- `context_retrieve` + `ccr://hash` give recovery of crushed spans — bounded by production store constraints: 1-hour TTL, 200-entry capacity (`context-crusher/src/store.ts:23-24,73,88,114`). Recovery reliability is measured as a **separate infrastructure arm** (below), not baked into retention numbers: a store `put` succeeding says nothing about a retrieve surviving the session's crush volume and clock (r2 fold: grok's BLOCKER — sim-side `put` success made every retention number ~1.0).
- **The acceptance budget is measured in tokens, not bytes**: the crusher compares `tokenMeter.estimateMessage(message)` against `minBytes`-named thresholds (`index.ts:206-208,305-309`). Any simulation using `text.length` will diverge from production acceptance. The gate extraction below therefore threads the estimator.
- Default config never exercises two of the three paths: `deferRequests: 0`, `reducerEnabled: false` (`config.ts:43,50`). Fixture/config matrix below pins coverage deliberately.

## Design

### Package

New `packages/evaluation/context-eval` (`@dsh-cc/context-eval`), dev-time only (not preset-mounted; CI runs its unit tests only). Root script `pnpm eval:ccr`.

### Gate extraction (small refactor, listed as a precondition)

In `packages/context/context-crusher`, extract the acceptance predicate chain into an exported pure function:

```ts
decideCrush(
  input: { blocks: readonly ContentBlock[]; isError: boolean; toolName: string },
  cfg: ResolvedCrusherConfig,
  estimate: (content) => number,
): CrushDecision
```

The decision input carries everything the production predicate chain reads — result-level `isError` (including the isError 2×minBytes rule), `toolName` (protected-tools and `context_retrieve` skips), and the content-block array (multi-block join and shape checks), because none of these are recoverable from a bare `ContentBlock` alone (delta-round fold, all three seats — r2's `(content, cfg, estimate)` signature could not express the chain it claimed to extract). Only these checks live inside `decideCrush`: eligibility (enabled/store/protected/retrieve, isError handling, block shape, minBytes via `estimate`), savings ratio, and defer/projectKey routing. Intentionally **outside** the pure function (documented): the caller-side `PostToolDecision` value/content discrimination and ledger writes.

Production passes `tokenMeter.estimateMessage`; the eval passes the same production estimator — never a `text.length` proxy. Both the listener and the eval call `decideCrush`; drift-free by construction. This is the only production-code change this doc requires, shipped with unit tests pinning evaluation-vs-production predicate identity (mutation pin).

### Corpus + structure-preserving sanitization

`fixtures/sessions/*.sanitized.jsonl` — 4-8 sessions (30-300 steps) from dsh-cc dogfood containing heavy tool output. `corpus.json` carries `corpusVersion`, per-fixture provenance.

A new sanitizer is specified (the token-efficiency redactor is explicitly **not** used): preserve — event order, `tool-call` arguments, tool-result text, assistant text, surfaceOp/rewrite metadata, seqs; redact only — credential-shaped strings from **exactly two** classes: `sk-…`-style keys and `Bearer …` tokens. The third cache-health excerpt class (`[A-Za-z0-9+/=_-]{32,}`) is **excluded** — it eats git SHAs and sha256 digests, which would make the `hex_digests` retention metric tautologically pass in both the original and the stub (delta-round BLOCKER from grok). Absolute local paths map to stable `/WORKSPACE/…` forms. Every fixture is committed only after a human reviews the sanitization diff.

### Deterministic replay (two paths), with a config matrix

Fixtures are replayed under **two pinned configs**, because the default config exercises only the post-execute path: (a) production defaults (`mode: 'on'` forced locally); (b) defer-forcing (`deferRequests: 2`) so the defer-swap path fires. The reducer path stays out of scope (no deterministic replay; recorded responses only — below).

For each fixture: parse events; reconstruct tool results per step; for each result satisfying `decideCrush`:

1. **post-execute path**: apply real crusher compress + store (temp `DSH_HOME`), produce the treatment transcript with the stub content.
2. **defer-swap path**: drive `defer/swap.ts`'s recorded flow against a minimal in-memory session-state adapter (append + read of the two events; the adapter's contract is one interface, implemented in the eval and unit-tested against the real session validator).
3. Reducer decisions encountered in fixtures are **recorded** (fixture stores the production dry-run rows) and replayed as data, never re-executed.

### Metrics

**M1 — stub-side evidence retention (the gate).** Identifier classes and their grammars, per usage site (delta-round fold — single-grammar-over-everything was wrong twice over):

- **grep/search rows** (stub-side extraction): capture group 1 of the production `SEARCH_ROW` (`packages/context/context-crusher/src/router.ts:33`, pattern `^(\.{0,2}\/?[\w.@\/-]+?):(\d+):(.*)$` — the `reducer/router.ts` path cited earlier does not exist; that anchor is corrected here).
- **log-kind spans** (stub-side): the standalone path grammar below.
- **Free-text mentions** (M2/M3 downstream reference detection in assistant text and tool arguments): a separate mention grammar — `/[\w\-./]+\.[a-z0-9]{1,6}\b` with the leading-`/` requirement dropped and Windows/relative forms admitted, plus canonicalization to the same path form (strip query/fragment, normalize separators and `./` prefixes). `SEARCH_ROW` itself only matches `path:line:content` rows and would undercount free-text mentions to near zero (codex + grok, convergent).

Additional classes: hex digests ≥7; URLs; backticked tokens ≥8 chars. For each crushed span: retention = |identifiers in stub| ⁄ |identifiers in original|, reported per class; stub vs store in **separate columns**.

**M2 — downstream-reference survival (stub-side gate).** Identifiers in a crushed span referenced by later assistant text or tool arguments within 10 steps: strict stub retention rate (classes (a),(b) only).

**M2r — recovery infrastructure arm (report-only, not gate).** For identifiers not in the stub but referenced downstream: simulated `context_retrieve` resolution under production constraints — span within TTL (1h, event timestamps as clock) and within the 200-entry capacity window given preceding crush activity. Reported as its own metric block; it answers "is the store reliable", separately from "did we keep the evidence" (by grok's fold, the two are not the same question).

**M3 — exposure (renamed from re-acquisition cost).** Both transcripts share the same future tool calls, so a treatment-vs-control delta on *calls* is identically zero and meaningless. Instead: `exposure` = fraction of crushed spans whose **non-stub-retained** identifiers are referenced by later assistant/tool messages within 10 steps. M3 measures "the session's own later behavior would have needed the crushed content." True acquisition-cost deltas belong to the dogfood window (live retrieval-call rate from doc 3's ledger), not to replay.

### Gate (`eval-gate-ccr.yaml`, committed)

```
m1:  { file_paths: 0.99, hex_digests: 0.99, urls: 0.98, backticks: 0.95 }   # stub retention
m2:  { strictStubRetentionMin: 0.98 }                                       # classes (a),(b), downstream-referenced
m2r: { reportOnly: true }                                                   # TTL/LRU recovery arm
m3:  { exposureRateMax: 0.05 }                                              # fixture mean
```

**Statistics semantics (folded, both seats):**

- Thresholds are **empirical pass/fail lines**, not confidence claims — the doc does not claim the corpus proves a 99% true rate; it claims the flip PR must show zero observed failures beyond these lines on the committed corpus.
- **Minimum denominators**: a class threshold is evaluated only if the corpus contains ≥ 30 identifiers of that class; otherwise the cell is `insufficient-data` and the gate **fails closed** for graduation purposes (coverage must be grown, not waived).
- Aggregation: per-fixture mean, then macro-mean across fixtures; per-class breakdowns mandatory.
- Zero-crush fixtures are excluded from gate means but reported (fixture-coverage section).

### Graduation policy (binding for the later flip PR)

1. `pnpm eval:ccr` green on the committed gate, report artifact referenced.
2. Two consecutive weeks of dry-run production measurement (doc 3 ledger): crushed-intent coverage + tool-result byte distribution.
3. ≥ 1 week live dogfood with `mode: 'on'` + ledger-monitored retrieval-call rates.

### Mutation test (corrected, delta round)

One mutation per metric family, each with **only the expected arm affected** (codex delta fold — the earlier form let a recovery-only mutation fail unrelated stub-side gates):

1. **Stub mutation (gate must fail)**: keep the fixture's original span and downstream gold references fixed; delete a threshold-relevant identifier from the *treatment stub* (crossing a registered threshold, e.g. drop one path that pushes class (a) below 0.99) → the gate must flag M1/M2.
2. **Recovery-arm mutation (only M2r moves)**: expire the store entry (TTL/LRU simulation) → M2r degrades; M1/M2/M3 are unchanged.

### Corpus lineage

`corpusVersion` in `corpus.json`, pinned into every report; gate re-run mandatory on fixture changes (initially non-blocking CI, moved to blocking at flip time).

## Verification

- Unit: identifier regexes (synthetic spans, tricky paths, short hashes); TTL/capacity recovery simulation (in/out of window); `decideCrush` identity vs production (mutation pin); exposure metric math on handcrafted fixtures; empty-cell and insufficient-data gate paths.
- Integration: one 30-step committed fixture end-to-end; deterministic (two runs byte-identical report); gate pass/fail as designed; mutation test fails the gate as designed.
- Repo gates: workspace registration only; no preset row, no capability manifest (internal tooling, README notes this).

## Risks

- Exposure (M3) understates true re-acquisition: acknowledged; the live dogfood leg carries that question.
- Fixture representativeness decays: refresh procedure documented; `corpusVersion` pinned.
- The gate-extraction refactor touches production code: smallest possible surface (predicate extraction only), behavior-identical, covered by existing crusher tests plus the added identity pin.

## Fold ledger

r1 → r2 (critic + codex + grok, NO-GO → folded): sanitizer replaced by a structure-preserving spec (token-efficiency redactor destroys eval inputs: `redactor.ts:67-76,117-136,160-163`); gate narrows to **stub-side retention** with recovery as a separate TTL/LRU-modeled report-only arm (grok's sim-blend BLOCKER); M3 renamed to exposure with treatment-only definition (identical-zero delta); `decideCrush(content, cfg, estimate)` extraction threads the production token estimator (acceptance compares tokens, not bytes — `index.ts:206-208,305-309`); fixture config matrix pins defer-swap coverage (`deferRequests` default is 0, `config.ts:50`); path identifiers reuse the production `SEARCH_ROW` grammar (`router.ts:33`; my leading-`/` regex missed relative paths); stub-vs-store columns separated; gate statistics section (min denominators, aggregation, insufficient-data, empirical-not-confidence semantics); mutation test corrected (mutate treatment, not the gold span); reducer path out of scope with recorded-response replay only; corpusVersion lineage.

r2 → r3 delta (three seats): `decideCrush` inputs enlarged to `{blocks, isError, toolName}` (the chain reads result-level metadata a bare block cannot carry — all three seats) with inside/outside splits declared; sanitizer's 32+ catch-all removed (it would eat SHAs and make `hex_digests` vacuous — grok BLOCKER); identifier grammar triangulated (SEARCH_ROW capture-1 for grep-row stubs, standalone path grammar for log-kind spans, free-text mention grammar for M2/M3 — single-grammar was wrong in both directions); mutation test now arms-matched (stub mutation fails the gate; recovery expiry moves only M2r).
