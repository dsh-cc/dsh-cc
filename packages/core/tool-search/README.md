# dsh-tool-search

English | [中文](README.zh.md)

Deferred tool registration plus a model-facing **ToolSearch** tool that loads heavy tools on demand. A tool that is expensive to load or token-heavy in the prompt can be registered **deferred**: it contributes a name, description, and search hint to a searchable registry, but its real definition stays **out of the model-visible schema and prompt** until the model asks for it.

## Why defer tools

Every visible tool schema costs prompt tokens and, for a heavy capability, load time. Most sessions need only a handful of tools from a large catalog. Deferral carries the *capability metadata* cheaply and loads the material definition only when the model actually summons it — generalizing the `shouldDefer`/ToolSearch mechanism (and the MCP `_meta['anthropic/alwaysLoad']` escape hatch) into the harness's effect-based registry model.

## What it does

[`DeferredToolRegistry`](src/index.ts) is the `ctx.toolSearch` service. A plugin registers a capability deferred:

```ts
ctx.toolSearch.registerDeferred({
  name: 'big_fs_tool',
  description: 'Heavy filesystem capability invoked once per session.',
  searchHint: 'read write edit files',
  alwaysLoad: false,
  activate: () => ctx.tools.register(bigFsToolDefinition), // returns the exact disposer
})
```

The **ToolSearch** model tool then ranks the deferred set against a `query` (`max_results`, default 5) using weighted substring/token matching over name, `searchHint`, and description. On a hit it calls the registration's `activate()` callback — a real `ctx.tools.register()` — so the tool becomes visible to the **next** assembly and then callable exactly like any top-of-prompt tool. `alwaysLoad: true` registers immediately at defer time and is never a deferred candidate.

The design rides the repo's effect conventions:

- **Deferred registration is an effect.** The returned disposer reclaims the deferred entry *and* any activated `ctx.tools` registration together, so a plugin unloading mid-session tears down both.
- **Activation is idempotent.** Re-activating an already-loaded tool is a no-op; re-registration (which would throw on a duplicate name) never happens.
- **Restriction stays authoritative.** `registerDeferred` reserves the tool's name in the `dsh-tools` registry (known but not visible), so a scoped `restrict()` can deny it *before* it loads. ToolSearch checks that gate: a deferred tool a scope denies is **not** activated for that scope, and the result says why.
- **Search is scope-visible.** A deferred registration lands in the calling scope's layer, and ToolSearch searches the *calling agent's* scope chain (itself and ancestors) — so a tool an agent deferred is visible to that agent's search and its descendants, but a sibling scope or the global view never sees it. A globally-deferred tool remains globally visible as before.
- **Deferred names never leak into the prompt.** Only activated (`alwaysLoad` or loaded) tools enter the schema; reserved-but-unloaded names are known for restriction/`toolOrder` purposes but never model-visible.
- **ToolSearch itself is lazy, with hysteresis.** While the searchable pool is empty, only the `ToolSearch` *name* is reserved (restrictable, not visible); the first non-`alwaysLoad` deferred registration brings the tool into the model-visible set, and it then stays registered for the rest of the session even if the pool empties again — a mid-session removal would shift the assembled tool order and break the cached prefix. An empty pool also makes the tool's "tools are hidden, search to load them" description actively misleading, which is why it is withheld.

## Semantic tool discovery (S1-05)

Lexical ranking cannot see a query that shares no literal token with a tool's metadata — a Chinese question against English metadata, or a paraphrase of the same request. The optional discovery layer puts an independent relevance judgment in front of the existing activation path: every admitted deferred candidate is scored against the query through the System One decision runtime (the optional `ctx.systemoneDecisions` service that the `decision-usage` plugin provides), and only candidates whose judged relevance **and** direct fit both clear their thresholds become activations. Tool names, schemas, and return messages still come from deterministic code; the model answers only "is this candidate relevant", with one question pair per candidate, so one candidate's metadata cannot contaminate another's judgment.

The layer is **off by default** and never rewrites the lexical path on its own:

| `mode` | Behavior |
| --- | --- |
| `off` | Default. Zero runner calls; `search()` and `execute` behave exactly as before, including result ordering and the default five items. |
| `shadow` | Runs the judgment and records the suggested difference; the original lexical hits still execute. |
| `active` | Activates the judged names in deterministic order (relevance, direct fit, lexical score, name ascending), capped at `min(max_results, max-activations)`. |

Settings live in the `cc-tool-discovery` namespace; raw keys are kebab-case:

| Key | Type, range | Default |
| --- | --- | --- |
| `mode` | `off \| shadow \| active` | `off` |
| `timeout-ms` | integer, 100–5000; time ceiling for the whole discovery transaction | `1200` |
| `max-input-tokens` | integer, 512–16384; per runner request, including questions and headroom | `4096` |
| `max-candidates` | integer, 1–128; cap on the complete eligible pool | `64` |
| `batch-size` | integer, 1–16 | `8` |
| `max-query-chars` | integer, 64–8192 | `2048` |
| `max-metadata-chars` | integer, 128–8192; combined cap per description and search hint | `2048` |
| `min-relevance-index` | finite number, 0–4; experimental threshold | `3` |
| `min-direct-fit` | number, 0–1; experimental threshold | `0.75` |
| `max-activations` | integer, 1–20 | `3` |
| `cache-entries` | integer, 0–1024; zero disables the cache | `128` |
| `cache-ttl-ms` | integer, 0–300000 | `60000` |

These thresholds are first-round evaluation parameters, not measured quality guarantees. Any invalid value disables the judgment entirely: the runner is not called, the lexical path runs, and the failure is reported once through `ctx.logger.warn`. The same whole-path fallback applies when the route, the service, or a complete answer is missing, and when a hard bound is exceeded — an oversized query or metadata field, a pool over `max-candidates`, a batch that cannot be split into whole groups that fit the request window, a timeout, caller cancellation, or a catalog/permission change before activation. A partial judgment is never blended with lexical hits, and a valid judgment that finds nothing relevant activates nothing (it is not backfilled from lexical hits). Admission is checked on both ends: a candidate the scope denies never enters the pool, and `activate()` re-checks the permission gate before loading, so a recommendation can never widen a scope.

The offline evaluator (`scripts/eval-discovery.mjs`) runs against one local, redacted corpus and never touches the network. It has four modes:

| `--mode` | Purpose |
| --- | --- |
| `replay` | **Oracle integrity pin.** The judgment is synthesized from each case's `expectedNames`, so an F1 number here would be tautological by construction. It stays a pure policy-layer pin — pool, questions, batching, scoring and selection against the redacted fixture — and is never gated on F1. |
| `selfcheck` | **Corpus health.** Schema integrity, the legacy subset floors, and the per-class coverage floors. |
| `judge-stub` | **The F1 gate arm CI runs.** A frozen, deliberately imperfect keyword/rule scorer over candidate metadata drives the real policy layer; gold labels are used for scoring only, never for judging, so the F1 line is meaningful and deterministic. |
| `live` | **Evidence, not a gate.** The shipped `createDiscoveryRuntime` driven through a scripted fake lane adapter: multi-batch sequences sharing one deadline, over-cap candidate pools, `unavailable`, cancellation, and the `exact` short-circuit. |

The `judge-stub` thresholds are pre-registered in the design doc (§ Scoring) and gated on the tune split only: aggregate restricted micro-F1 ≥ 0.85, per-class restricted micro-F1 ≥ 0.80 for classes with at least 12 items (and positives), and — because the negative-only class has no positives and its F1 is undefined — that class is gated on false-activation ≤ 0.10 plus exact-set accuracy 1.0 instead.

**Corpus schema v2** (`scripts/lib/eval-corpus.mjs`): `{ schemaVersion: 2, corpusVersion, description?, cases[] }`. `corpusVersion` is an integer bumped whenever the cases change, and every report pins it. Each case carries a `class` — the gating dimension, one of `direct-fit`, `lexical-trap` (lexical overlap / wrong-server traps), `multi-intent`, `negative-only` (`expectedNames: []`), `keyword-stuffing` (metadata keyword-stuffing) — plus optional `alsoClasses` for declared multi-label membership, which is how the corpus reaches ≥ 12 memberships per class without an exclusive split. The legacy `subset: chinese|synonym|none|restricted` filter and its floors are kept. A query may not equal a candidate's `name`: an exact-name query short-circuits the judge before it is ever called, so such a case could not measure judge quality.

**Splits.** `--split tune|held-out|full` (default `tune`). Ordering the cases by the hash of their id cuts the corpus 2/3 tune / 1/3 held-out; only `tune` is ever gated, `held-out` is reserved for the one-time flip evaluation, and `full` is for inspection.

Run either way:

```bash
node packages/core/tool-search/scripts/eval-discovery.mjs --mode <mode>
pnpm --filter @dsh-cc/tool-search run eval:discovery -- --mode <mode>
```

Every mode prints aggregate numbers, class labels and case ids only — never query text, candidate descriptions or notes. `replay` adds Recall@3 per subset beside the lexical control, activation precision, admission leaks and a reproducibility check; `judge-stub` prints the per-class F1 table and the gate verdict; `live` asserts the failure battery and reports micro-F1 plus nominal/tail latency ungated (p95 on a corpus this size is the ~3rd-largest sample). CI runs `selfcheck` and `judge-stub` only; no arm needs the network.

## Model Experience

Turn one, the model sees only `ToolSearch` plus whatever is already loaded (including `alwaysLoad` tools) — or, in a session with no deferred tools at all, no `ToolSearch` either. It searches for a capability by keywords, and the result names the now-available tools. On the next turn those tools are first-class: declare them, call them. Already-loaded tools drop out of the deferred set, so a second search for them is correctly empty.

An empty search result always says *why*, so the model never mistakes "nothing deferred" for "I lack the capability": an empty pool yields "every tool you can use is already in your function list; call it directly", a fully-loaded pool yields "all deferred tools available to you are already loaded", and a simple miss on a non-empty pool returns 'No deferred tools matched "<query>". This directory lists deferred tools only; tools that registered eagerly (including eager MCP tools) never appear here — they are already in your function list, call them directly'.

## Known Limitations and Deferred Work

- **Matching is lexical unless discovery is enabled.** Ranking uses weighted substring/token scoring; there is no embedding/vector search. The optional S1-05 layer adds a model relevance judgment for synonyms and Chinese queries, but it is off by default and falls back to the lexical path on any failure.
- **Global activation.** Loading happens on the host plane (global registration); a per-agent scope sees a loaded tool only if its restriction admits it. There is no per-conversation discovery history — loading is an in-memory effect, so a re-registered composition starts from the deferred pool again.
