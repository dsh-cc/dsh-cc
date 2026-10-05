# Static reasoning-effort defaults for one-shot side queries

Status: reviewed — four rounds, three blind lanes, converged GO in round 4 (ledger in §12). Implementation pending. Date: 2026-10-05.

## 1. Problem

Every one-shot side query in dsh-cc calls `llm.stream` **without** `reasoningEffort`, so the upstream harness materializes the provider's `reasoning.defaultEffort` (on the live deployment: provider-level `reasoning: "high"` — see §8). The cheap lane (haiku alias) therefore pays reasoning cost and latency it does not need on calls whose entire purpose is to be cheap and fast (tool-use summaries, context reduction, prompt suggestions, advisor, web_fetch summaries).

Two concrete gaps:

1. `SideQueryOptions` has no effort field (`packages/llm-tuning/side-query/src/index.ts:31-62`), so no side query can carry effort at all.
2. `toOneShotRoute` drops `ResolvedRoute.reasoningEffort` (`packages/compat/cc-model-aliases/src/agentOptions.ts:73-84`), so even an operator-configured alias-level effort (object form `reasoningEffort`, or `$level` suffix) never reaches a one-shot — an inconsistency with the spawn path, where `toAgentOptions` carries it (`agentOptions.ts:33-42`).

## 2. Verified facts (code anchors)

- **The wire already supports it.** `GenerateOptions.reasoningEffort?: ReasoningEffortId` exists upstream (deepseek-harness `packages/llm/llm/src/types.ts:516`; `LlmModelReasoningInfo.efforts` at `:379-388`). `resolveCallWithInfo` (`llm/src/index.ts:892-927`) throws `LlmError('UNSUPPORTED_REASONING_EFFORT')` when the spelling is not in the model's `reasoning.efforts`, and materializes `reasoning.defaultEffort` when the field is omitted. One-shot `llm.stream` runs through the same validation (`adapterStream`, `llm/src/index.ts:1044-1048`). `resolveModelInfo(provider, model, signal?)` accepts an AbortSignal (`llm/src/index.ts:740-746`). **No upstream change needed.** (Upstream line anchors verified from the sibling checkout, not this repo's node_modules.)
- **The precedent exists in-repo and runs in production.** `packages/interaction/permission-rules/src/classifier-lane.ts:50-104` resolves effort per route: catalog-validate an explicit spelling against `resolveModelInfo(provider, model).reasoning.efforts`; invalid → one warn line + field omitted; absent → `efforts[0]`; memoized per `provider\0model\0effort`; never throws. Ships effort as `reasoningEffort: ReasoningEffortId(effort)` on the `llm.stream` options.
- **Ordering caveat (round-1 finding, adopted)**: the upstream contract for `efforts` is "adapter-preferred **display order**" (`types.ts:381`), NOT a guaranteed cost order. The pi-ai adapter materializes `THINKING_LEVELS` in escalation order (`llm-pi-ai/src/catalog.ts:75-86`, `models.ts:59-66`), so on pi-ai deployments `efforts[0]` IS the cheapest level (probe: `"off"`, §8). Classifier-lane already takes this same bet. This design adopts `efforts[0]` and states the caveat explicitly: on a non-pi-ai adapter with different display order, the default is "first advertised level", which may not be cheapest.
- **`ctx.llm.resolveModelInfo` is available everywhere `ctx.llm` is mounted** (public method on `LlmRuntime`).
- **runSideQuery contract**: never throws; every failure collapses to `{ok:false, reason}` (`side-query/src/index.ts:80-159`). An invalid effort reaching the wire would throw inside stream and collapse to `reason:'error'` — so pre-validation is load-bearing, exactly as in classifier-lane.
- **Consumers today**: TUS (`tool-use-summary/src/index.ts:131`, settings ns `cc-tool-use-summary`, **no `inject` declared — see P3**), context-crusher (`context-crusher/src/reducer.ts:160`, ns `cc-context-compression`, kebab keys, class plugin with `static inject = ['tokenMeter', 'llm']` at `index.ts:92`), prompt-suggest (`prompt-suggest/src/index.ts:129`, ns `cc-prompt-suggest`, `inject = ['llm']` at `:203`), advisor-watchdog (`advisor-watchdog/src/advise.ts:81`, ns `cc-advisor`, `inject = ['llm']` at `index.ts:70`), commit-split (`command-commit-split/src/index.ts:120-127`, no settings ns, hardcoded alias `blueprint`, comment "Splitting is not cost-sensitive" at `:125`, `inject = ['commands']` at `:21`), web_fetch (`tool-web-fetch/src/index.ts:184-210`, direct `ctx.llm.stream`, plugin `Config`, hardcoded `haiku`, `inject = ['tools', 'web', 'systemPrompt', 'llm']` at `:29`).
- **session-title-provider** builds its `GenerateOptions` inside an upstream harness package (`session-title-llm`; its `stampRoute` copies only `provider`/`model`) — out of scope (see §9).
- **schemastery idiom** for optional settings keys: `z.union([z.string().min(1), z.const(undefined)])`.
- **cordis inject trap**: plugins touching `ctx.llm` must declare `inject = ['llm']` (advisor-watchdog production incident). Tests with hand-built contexts mask this — pin with `expect(mod.inject).toContain('llm')`.
- **`'default'` is already reserved** by the TUI `/effort` command (`packages/ui/tui/src/effort-catalog.ts:14-23`): it wins even over a catalog level literally named `default`.
- **Capability manifest**: the PR touches user-visible behavior and settings of six existing manifest entries — `engine.web-fetch` (`docs/claude-code-capabilities.yaml:1016-1038`), commit-split (`:1691-1705`), `engine.tool-use-summary`, context-crusher, `engine.prompt-suggest`, `engine.advisor-watchdog`. All six get authored updates (see §4 Docs), then derived docs are regenerated (see §7).

## 3. Design overview

Three pieces, shipped as **one PR** (see §10):

- **P1 (cc-model-aliases)**: `toOneShotRoute` projects `reasoningEffort` from the resolved route (alias object form / `$level` suffix both land there). Purely additive field on the return value.
- **P2 (side-query)**: new `effort` and `warn` options on `SideQueryOptions`; a new exported module `src/effort.ts` with a memoized, catalog-validating, abort-aware resolver; runSideQuery resolves and stamps effort onto the stream options, with the timeout/abort budget composed BEFORE the catalog lookup.
- **P3 (consumers)**: each side-query call site gains one optional settings/config key threaded into `opts.effort`; web_fetch (direct stream) uses the exported resolver from P2; commit-split pins `'default'` in code in the SAME PR to preserve its current deep-lane behavior.

### 3.1 The reserved spelling `'default'`

`'default'` is reserved (same convention as TUI `/effort`): "omit the field; use the provider's `defaultEffort`". It is honored **inside the resolver** at every precedence position (explicit option, settings key, alias stamp) — callers never special-case it, never call the catalog for it, and a pinned `'default'` at a higher position suppresses lower positions entirely.

### 3.2 Precedence (highest first)

| # | Source | Where it lives |
|---|--------|----------------|
| 1 | `SideQueryOptions.effort` (call-site code or threaded settings/config key) | per call site |
| 2 | alias-target stamp `ResolvedRoute.reasoningEffort` (object form or `$level` suffix), now projected by `toOneShotRoute` | `model-aliases` settings/config |
| 3 | catalog default: `efforts[0]` (first advertised level; cheapest on pi-ai adapters — see §2 caveat) | provider catalog |

Resolution rule (single rule, mirrors classifier-lane):

- Take the first **defined** candidate from [1], [2]. A defined candidate at [1] — including `'default'` — suppresses [2] entirely.
- Candidate === `'default'` → **omit** the field (provider default), stop.
- Candidate present → validate against catalog: valid → use it; invalid → **one warn line + omit the field** (provider default), stop. (No silent fall-through to cheapest: an invalid explicit value is an operator error and must not silently downgrade; omitting matches classifier-lane exactly.)
- Candidate present but the model has NO reasoning metadata (or empty `efforts`) → one warn line + omit (the explicit intent is unfulfillable — that deserves a warn; classifier-lane's silent omission here is NOT copied).
- No candidate → `efforts[0]` if the catalog advertises efforts; if the model has no reasoning metadata → omit **silently** (nothing was asked for, nothing to warn about).
- `resolveModelInfo` missing/failing/timing out (2s internal bound) → one warn line + omit. Never throws.

**Deliberate divergence from the spawn path** (Q1, settled): on spawn, route effort beats agent frontmatter (`resolveSpawnEffort`, agentOptions.ts:52-59). Here the per-call-site key (1) beats the alias stamp (2). Rationale (all three lanes agreed): the settings key is narrower in scope (one feature) than the shared alias; narrow overrides broad. The spawn path's frontmatter belongs to the child definition — a different relationship. This divergence is documented next to `resolveSpawnEffort`'s own comment so the two rules stay visibly distinct.

### 3.3 Behavior when the route is inherited

When the alias is unconfigured and the side query inherits the parent (main) route, there is no alias stamp; rule 3 applies to the **parent model's catalog**. An explicit `opts.effort` still stamps in the inherit case (only the alias stamp is absent). Pinning the first advertised level on the main model for a summary/suggestion call is semantically correct (the call's purpose is still cheap) but is a behavior change for zero-config deployments — disclosed in §6.

## 4. Detailed changes

### P1 — `packages/compat/cc-model-aliases/src/agentOptions.ts` (+ `src/index.ts`)

```ts
export interface OneShotRoute {
  readonly provider: string
  readonly model: string
  /** Alias-target reasoning-effort stamp (object form / $level), when present. */
  readonly reasoningEffort?: string
}

export function toOneShotRoute(
  route: ResolvedRoute | undefined,
  parent?: OneShotParentRoute,
): OneShotRoute | undefined
```

Implementation: existing body, plus `...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort })` on the returned object. Effort does **not** inherit from `parent` (parent is a provider/model pair only). Export the `OneShotRoute` type from `src/index.ts` (its `:17` export line today covers `toAgentOptions` / `toOneShotRoute` / `resolveSpawnEffort` / `OneShotParentRoute`).

Caller discipline (pinned): consumers must **destructure** `{ provider, model }` and handle `reasoningEffort` through the P2 resolver — never spread the whole `OneShotRoute` into stream options (an unvalidated stamp reaching `llm.stream` can throw `UNSUPPORTED_REASONING_EFFORT`; the spread pattern in the aliases package's own `tests/systemone-guard.spec.ts:118-121` — `ctx.llm.stream({ ...route, messages })` — must not be copied to production call sites).

Also in this PR: update the now-false comment at `packages/interaction/permission-rules/src/pre-execute.ts:63-66` ("toOneShotRoute … drops reasoningEffort by design") — P1 deliberately reverses that 2026-09 decision.

Tests (`cc-model-aliases/tests/`): object-form alias effort projected; `$level` suffix effort projected; string-form alias → no effort field; effort never inherited from parent; System One route still throws.

### P2 — `packages/llm-tuning/side-query`

New file `src/effort.ts` (keeps `index.ts` under the 500-line source limit). **One** exact API — the round-1 ambiguity between a warn-capturing factory and a per-call function is resolved in favor of the per-call function:

```ts
/** The llm-service face the effort resolver needs (duck-typed). */
export interface EffortCatalogLlm {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    reasoning?: { efforts?: readonly { id: string }[] }
  }>
}

/**
 * Resolve the effective one-shot effort for a filled route.
 * Returns the spelling to stamp, or undefined to omit the field.
 * Never throws. 'default' is handled here (omit, no catalog call, no warn).
 * Memoized per (llm identity, [provider, model, requested] JSON key) as a
 * shared, never-rejecting promise whose entry races the adapter lookup
 * against its OWN 2s timeout, never a caller's signal; each caller races
 * that entry against its own signal.
 */
export function resolveEffort(
  llm: EffortCatalogLlm,
  route: { provider: string; model: string },
  requested: string | undefined,
  warn: (message: string) => void,
  signal?: AbortSignal,
): Promise<string | undefined>
```

**Pinned constant**: `const CATALOG_LOOKUP_TIMEOUT_MS = 2000` (catalog resolution is adapter-local metadata — 2s is a generous bound; pi-ai builds it from config synchronously).

**Memo / cancellation ownership (round-2 redesign — resolves the abort×memo contradiction two lanes found independently):**

- Memo: module-level `WeakMap<EffortCatalogLlm, Map<string, Promise<string | undefined>>>`, key `JSON.stringify([provider, model, requested ?? null])` (round-3: the `\0`-joined form conflated absent `requested` with an explicit empty spelling — `undefined` selects `efforts[0]`, `''` must warn+omit as invalid; JSON encoding keeps them distinct). The map value is a **shared, never-rejecting** promise created on first miss.
- **The shared lookup never carries a caller's signal.** Its entry races the adapter call against `AbortSignal.timeout(CATALOG_LOOKUP_TIMEOUT_MS)` (see the pinned construction below), so the entry settles even when the adapter ignores cancellation. Rationale: a caller-scoped signal on a shared promise lets one caller's abort poison every concurrent waiter (resolving them all to omit) and makes cancellation ownership undefined; a forwarded-only timeout signal does not bound a hung adapter at all.
- **The entry promise never rejects and is never evicted.** It settles to `string | undefined` exactly once; failure/timeout settles to `undefined` with one warn. Because it never rejects, late settlement is benign (no unhandled rejection, no restore-after-evict hole).
- The warn sink attached to an entry is the sink of the caller that created it; later callers with different sinks are not re-warned (all production sinks are the same `ctx.logger?.warn?.` shape — zero practical impact).
- **Waiter cancellation is per-call and touches no shared state**: if `signal?.aborted` → return `undefined` immediately; otherwise `Promise.race([entry, abortOf(signal)])` where `abortOf` resolves `undefined` on abort and removes its `{ once: true }` listener when the entry wins the race. An aborted waiter gets `undefined` promptly; the shared lookup continues for the other waiters.
- Caller mapping: runSideQuery checks `signal.aborted` after the await → `reason:'timeout'`, no stream dispatch. web_fetch proceeds without the field on `undefined` (abort and omit are indistinguishable and both mean "no effort stamp" — it never blocks the fetch on the catalog beyond the 2s internal bound).

**Exact lookup semantics (inside the shared entry):**

1. `requested === 'default'` short-circuits BEFORE any memo/catalog work: return `undefined`, no entry created, no warn.
2. Entry construction (pinned — the 2s bound is an enforced race, not a forwarded signal; upstream cancellation is cooperative-only, `resolveModelInfoFor` just awaits the adapter at `llm/src/index.ts:748-754`, and both live adapters ignore the signal — `llm-pi-ai/src/adapter.ts:289-297`, `llm-deepseek/src/adapter.ts:37`):
   ```ts
   const timeout = AbortSignal.timeout(CATALOG_LOOKUP_TIMEOUT_MS)
   let settled = false
   const lookup = Promise.resolve().then(() => llm.resolveModelInfo(route.provider, route.model, timeout))
   const entry = Promise.race([
     lookup.then(validate, fail),                                          // normal settle
     abortOf(timeout).then(() => fail(new Error('catalog lookup timeout'))), // enforced bound
   ])
   ```
   - The timeout signal is ALSO passed into `resolveModelInfo` as a courtesy abort (cooperative adapters release resources early); it is NOT the bound — the `Promise.race` is.
   - `validate`/`fail` check the `settled` flag before warning or resolving: late completion/rejection after the timeout won is swallowed (race handlers already attached, so nothing is unhandled) — no second warn, no result change.
   - Method missing, lookup rejection, or timeout → `fail`: one warn + settle `undefined`.
3. `warn` invocation is wrapped in try/catch (a throwing sink cannot escape); error formatting uses a guarded `try { String(error) } catch { 'unknown' }`.
4. No reasoning metadata / empty `efforts` → `requested !== undefined` ? (warn + settle `undefined`) : settle `undefined` silently.
5. `requested` valid → settle `requested`; invalid → warn + settle `undefined`. No fall-through.
6. `requested === undefined` → settle `efforts[0]!.id`.

`abortOf(signal)` is pinned to the exact in-repo shape (`side-query/src/index.ts:132-135`): resolve IMMEDIATELY if `signal.aborted` is already true, else `addEventListener('abort', ..., { once: true })` — a signal that aborts between the outer check and listener attachment must not strand the waiter.

Warn message formats (pinned, tests assert substrings):
- `side-query: effort "<x>" is not supported by <provider>/<model>; omitting reasoningEffort` — reused for BOTH the invalid-spelling case and the no-metadata-with-explicit case (an explicit spelling on a reasoning-less model is unfulfillable = not supported).
- `side-query: route info for <provider>/<model> failed (<error>); omitting reasoningEffort`

`src/index.ts` changes:

```ts
export interface SideQueryOptions {
  // ...existing fields unchanged...
  /**
   * Explicit reasoning-effort spelling for this one-shot (opaque; catalog-
   * validated). Wins over the alias-target stamp. The reserved spelling
   * 'default' omits the field (provider defaultEffort). Absent → the alias
   * stamp, else the catalog's first advertised level.
   */
  effort?: string
  /** Warn sink for effort-validation messages. Default: noop. */
  warn?: (message: string) => void
}
```

Inside `runSideQuery`, reorder so the abort budget is composed BEFORE effort resolution (round-1 finding: today the timeout is created at `:106-110` after route fill; an unbounded catalog lookup must not sit outside it):

```ts
// after provider/model fill (both alias and inherit paths), before options:
if (opts.signal?.aborted) return { ok: false, reason: 'timeout' }
const timeoutSignal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
const signal = opts.signal === undefined
  ? timeoutSignal
  : AbortSignal.any([timeoutSignal, opts.signal])

const requested = opts.effort ?? (inherited ? undefined : filled?.reasoningEffort)
const effort = await resolveEffort(ctx.llm, { provider, model }, requested, opts.warn ?? (() => {}), signal)
if (signal.aborted) return { ok: false, reason: 'timeout' } // no stream dispatch after abort

const options = {
  provider, model,
  maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  ...(opts.system === undefined ? {} : { system: opts.system }),
  messages: [createUserMessage({ content: [{ type: 'text', text: opts.prompt }], source: { kind: 'side-query' } })],
  ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
  signal,
}
```

(The existing duplicate `opts.signal?.aborted` check at `:106` is removed; the timeout/signal block at `:107-110` moves up as shown. `ReasoningEffortId` import added from `@deepseek-ai/dsh-llm`; it brands only, never throws — `brand.ts:74-76`.)

The unrouted short-circuit (`index.ts:97-99`) stays BEFORE any of this — no catalog call on paths that never reach the stream (pinned test). There is NO empty-prompt input check today and this PR adds none — `'empty'` is a post-stream result about assembled output, unchanged.

`resolveEffort` and `EffortCatalogLlm` are exported from the package index for web_fetch reuse (Q5, settled: shared dependency, no third copy — classifier-lane keeps its own adapter because its stream shape differs; that pre-existing duplication is out of scope).

Tests (`side-query/tests/effort.spec.ts` + component spec extensions):
- explicit valid effort stamped on stream options (branded value asserted).
- explicit invalid → warn once + omitted; concurrent duplicate calls → exactly one catalog call and exactly one warn (pending-promise memo); second settled call → no re-warn.
- `'default'` explicit / settings-threaded / alias-stamp `'default'` → omitted, zero catalog calls.
- precedence matrix: explicit beats stamp; invalid explicit does NOT fall through to a valid stamp; explicit `'default'` suppresses a valid stamp; inherit case + explicit effort still stamps; inherit case without explicit uses parent catalog.
- no candidate → `efforts[0]`; no reasoning metadata + no candidate → silent omit; no metadata + explicit → warn + omit.
- `resolveModelInfo` rejects → warn + omit; missing `resolveModelInfo` method (stub llm) → warn + omit.
- abort: waiter signal aborted mid-lookup → that caller returns `undefined` promptly (runSideQuery maps to `reason:'timeout'`, no stream dispatch); the shared entry continues and caches normally; no warn is suppressed on the entry itself (entry failures warn exactly once regardless of waiter aborts).
- throwing warn sink → still never throws; lookup failure + healthy fake stream → `{ok:true}` with effort omitted (NOT `reason:'error'`).
- memo isolation per llm identity: two fake llm services, no cross-talk (fresh fake per test — the module-level WeakMap survives vitest cases).
- never-throws regression: no code path in the effort branch can escape the outer catch.
- existing `component.spec.ts` (`:92-104` boots `LlmRuntime` without a `resolveModelInfo` mock): pinned still-green (unknown model → warn-noop + omit + stream proceeds).
- systemone-guard spec stays green.

### P3 — consumers (all in the same PR)

| Call site | Key (namespace) | Exact changes |
|---|---|---|
| TUS | `effort` (`cc-tool-use-summary`) | `settings.ts`: `TusSettings.effort?: string` + schema `z.union([z.string().min(1), z.const(undefined)])` — NOT added to `DEFAULT_SETTINGS`. `index.ts`: thread into the runSideQuery call at `:131` via the `Deps` record (`maybeSummarize` signature gains the settings snapshot it already reads). **Add `export const inject = ['llm']`** to the plugin entry — TUS declares no inject today yet reaches `ctx.llm` through runSideQuery (the advisor production incident's exact shape; likely-latent defect, fixed here). Pin `expect(mod.inject).toContain('llm')`. |
| context-crusher | `reducer-effort` (`cc-context-compression`, kebab) | `types.ts`: `CrusherConfig['reducer-effort']?: string` and `ResolvedConfig.reducerEffort?: string`. `config.ts`: the schema key lives on `Config` in `config.ts` (there is no schema in `settings.ts`); `resolveConfig` AND `overlaySettings` (:165-197) both map it with the **`deferUrgencyTokens` conditional-spread pattern** (`config.ts:193-195`) — `exactOptionalPropertyTypes: true` rejects a plain `?? base.reducerEffort` line (it would materialize `reducerEffort: undefined` and break the exact-`toEqual` settings spec). `reducer.ts:160`: thread `cfg.reducerEffort` + warn. **Note**: `tests/settings.spec.ts:7-15` is an exact `toEqual` of `resolveConfig()` — it stays green only if the key is omitted-when-absent, never present-and-undefined. |
| prompt-suggest | `effort` (`cc-prompt-suggest`, camelCase) | `settings.ts`: `PromptSuggestSettings.effort` + schema; `index.ts`: the narrowed settings type consumed by `runPrediction` (`:123`) gains `effort`; thread at `:129`. |
| advisor-watchdog | `effort` (`cc-advisor`) | `settings.ts`: `SettingsObject` key, `AdvisorSettings.effort`, `resolveSection` field selection (:114-121) — DEFAULT_ADVISOR_SETTINGS untouched (absence-preserving). `wiring.ts:247`: pass `effort` into the `runAdvisor` options (currently only `agent`, `alias`, `renderedDelta`). `advise.ts:81`: thread. **Correction of the v2 claim (codex round-2)**: advisor's execution path reads settings ONLY via the raw user file (dual-half `readUserSettingsSync`/`readUserSettings` → `resolveSection`); the `registerSettings` cascade registration is deliberately validation/config-UX only (`apply` discards the reader). The `effort` key follows that same existing policy — no live-overlay wiring is added, and no advisor behavior beyond the new key changes. |
| commit-split | none — code pin | `index.ts:120-127`: add `effort: 'default'` to the runSideQuery options, with a comment: "Split quality is deep-lane work; pinned to the provider default. An effort stamped on the `blueprint` alias is deliberately ignored by this consumer." **Add `'llm'` to `inject`** (`:21` → `['commands', 'llm']`) — its handler ctx reaches `ctx.llm` through runSideQuery; explicit is harmless and pins the contract. Pin `expect(mod.inject).toContain('llm')`. **Consequential test fix (grok round-2)**: `tests/commit-split.spec.ts:149-152` mounts the plugin with only `CommandRuntime`; cordis defers `apply` until inject deps exist, so the added `'llm'` would hang that mount to the test timeout — the spec must `ctx.provide('llm', stub)` (or mount `LlmRuntime`) before `ctx.plugin(commandCommitSplit)`. |
| web_fetch | `summaryEffort` (plugin `Config`, camelCase like `maxSummaryTokens`) | See below. |

**web_fetch (`packages/core/tool-web-fetch/src/index.ts`)** — the round-1 blockers, spec'd exactly:

1. Config type fix (`:32-60`): `type ResolvedConfig = Required<Omit<Config, 'summaryEffort'>> & { summaryEffort?: string }`; `summaryEffort?: string` added to `Config`; **not** added to `DEFAULTS` (the existing `Object.entries(config).filter(([, v]) => v !== undefined)` merge stays absence-preserving). Schema: `summaryEffort: z.union([z.string().min(1), z.const(undefined)])`.
2. Route seam widening (`:176-185`): the local duck-type over `ctx.get('ccModelRoutes')` narrows `resolve()`'s return to `{provider?, model?}`; widen it to keep `reasoningEffort?: string`. Existing test fakes of this seam are updated to the widened type.
3. Effort resolution on the summary path only (raw mode does NO effort lookup, no catalog call): `const requested = config.summaryEffort ?? filled.reasoningEffort; const effort = await resolveEffort(ctx.llm, { provider, model }, requested, warn, exec.signal)` where `warn = m => ctx.logger?.warn?.(m)`. If the aborted/undefined result comes back, stream without the field — never block the fetch on effort.
4. Stamp discipline: destructure `{ provider, model }` from the filled route; the ONLY effort on the stream options is the validated one: `...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) })`. Never spread `filled`.
5. New dependency `@dsh-cc/side-query` (workspace) in `package.json` + devDependency declarations as required by `check-spec-deps`.
6. Disclosed failure mode: web_fetch's execute path has no try/catch around the stream; a catalog-drifted cached effort that turns invalid mid-process surfaces as a tool error (same as any stream failure today). Acceptable; listed in §5.

**Warn sink form everywhere**: callers pass `m => ctx.logger?.warn?.(m)` (optional-chained; TUS already uses this shape at `index.ts:160`). The resolver additionally wraps the invocation in try/catch, so a hostile sink cannot break the never-throws contract.

### Docs

- side-query README (EN + zh): `effort`/`warn` options, precedence table, `'default'` reserved spelling, first-advertised-level policy with the pi-ai caveat and the `off` disclosure (§6).
- web_fetch README (EN + zh): `summaryEffort` config key.
- Per-consumer README settings tables where present (EN + zh). **Bilingual gate**: `pnpm check:readme` enforces README.md + README.zh.md + README.i18n.yaml hash lock — update both languages, then `pnpm check:readme --write`.
- **Capability manifest** (round-1 finding, adopted; scope widened in round 2): six existing entries get authored updates — `engine.web-fetch` (summaries run at the catalog's first advertised effort by default; new `summaryEffort` config), commit-split (effort pinned to provider default), `engine.tool-use-summary` / context-crusher / `engine.prompt-suggest` / `engine.advisor-watchdog` (each: default effort now first-advertised-level; new effort settings key). Then regenerate derived docs (`pnpm docs:parity`) and let `pnpm check:capabilities && pnpm check:parity` gate it.

## 5. Failure modes (all fail-soft; runSideQuery never throws)

| Case | Behavior |
|---|---|
| Invalid explicit/settings spelling | one warn, field omitted → provider defaultEffort; no fall-through |
| Invalid alias stamp | same (warn + omit) |
| Explicit candidate + model has no reasoning metadata / empty efforts | one warn + omit (intent unfulfillable is warned) |
| No candidate + no reasoning metadata | silent omit |
| `'default'` at any position | field omitted, no warn, zero catalog calls; suppresses lower positions |
| Catalog level literally named `default` | unreachable as a REQUESTED spelling (reserved keyword wins, TUI rule); on the no-candidate path a catalog id literally named `default` is stamped as-is — it is a valid catalog id and the reservation applies to input spellings only |
| `resolveModelInfo` missing/rejects/times out (2s internal bound) | one warn, field omitted; lookup failure + healthy stream still yields `{ok:true}` |
| Caller abort while a lookup is in flight | that caller returns `undefined` promptly (runSideQuery → `reason:'timeout'`, no stream dispatch; web_fetch → proceeds without effort); the shared lookup is unaffected and still settles/caches for other waiters |
| Concurrent first-miss | one shared lookup (bounded by its own 2s timeout, never a caller's signal), at most one warn (first caller's sink), all healthy waiters get the same settled result; a leader's abort never poisons followers |
| Lookup hangs forever (adapter ignores its signal) | the internal `AbortSignal.timeout(2000)` settles the entry to `undefined` (one warn); waiters with tighter budgets still bail on their own signals first |
| `warn` sink throws | contained by the resolver (try/catch); result unaffected |
| Catalog drift mid-process (cached effort becomes unsupported) | stream throws `UNSUPPORTED_REASONING_EFFORT` → runSideQuery `reason:'error'`; web_fetch direct path → tool error. Lifetime cache accepted deliberately: settings hot-reload changes provider/model → new memo key (old entries harmlessly stale); mid-process adapter mutation is out of scope; restart clears. Bounded-expiry/invalidation rejected as YAGNI. |
| `ctx.llm` absent | unchanged from today (stream call itself fails → `reason:'error'`) |

## 6. Behavior-change disclosure & rollback

- **Default changes**: every runSideQuery consumer except the pinned commit-split (TUS, crusher, prompt-suggest, advisor) plus web_fetch summaries moves from provider `defaultEffort` (on the live deployment: **high**) to the catalog's first advertised level — on pi-ai deployments the **cheapest**, which the probe shows is `"off"` (reasoning fully disabled, §8). Expected: materially lower latency on those five surfaces (probe: ~40% on a reasoning-inducing prompt). session-title-provider is excluded (§9).
- **`"off"` disclosure (Q7, settled — all three lanes)**: on providers advertising `off` first, summaries/suggestions run with reasoning disabled by default. The catalog gives no cost metadata, so skipping `off` would invent a second policy; per-site keys and alias stamps are the quality levers. Dogfood watch item: crusher/advisor JSON malformation rates — raise the site key to `low` if observed.
- Zero-config deployments (unconfigured `haiku` → inherit main route): side queries now pin the **main model's** first advertised level instead of its default — disclosed; per-site keys or alias stamps are the levers.
- commit-split is behavior-neutral by construction (`'default'` pin, same PR); note the pin also suppresses `blueprint` alias stamps for this consumer (documented in the code comment and manifest entry).
- Rollback per site: set the site key to `'default'` (or any explicit level). Global rollback: revert one PR; no migration, no persisted state, no schema breakage (all keys optional, absence-preserving).

## 7. Test plan

Per package, listed in §4. Plus the round-1 acceptance additions:

- Full precedence matrix (§3.2) incl. invalid-explicit-no-fall-through, explicit `'default'` over valid stamp, alias-stamp `'default'`, inherit+explicit.
- Pending-promise memo: concurrent identical calls → one lookup, ≤1 warn, identical settled results.
- Abort/cancellation ownership: leader aborts mid-lookup → follower still gets the resolved effort; follower aborts → prompt `undefined` return while the leader's lookup continues; a lookup promise that NEVER settles despite receiving its signal → waiters with their own timeouts still bail (`reason:'timeout'`), entry settles `undefined` at the 2s internal bound with one warn; already-aborted signal short-circuits before any memo/catalog work; no stream dispatch after abort.
- Throwing warn sink; hostile rejection values (non-Error).
- Crusher `overlaySettings`/`resolveConfig` round-trip for `reducer-effort`; the exact-`toEqual` settings spec updated.
- Advisor `resolveSection` + raw user-file read for `effort`.
- web_fetch: `summaryEffort` valid/invalid/`'default'`; raw mode performs zero catalog calls; seam fake WITH `reasoningEffort` (exercises the widened duck-type); no spread of `filled`.
- commit-split with a `blueprint` alias stamp → still omits effort (pin honored).
- Real-cordis inject pins: `expect(mod.inject).toContain('llm')` for TUS and commit-split (new), web_fetch (existing).
- Typechecking (`tsc -b tsconfig.packages.json`), esp. the web_fetch `ResolvedConfig` optional-property handling.

Gates: `pnpm check:capabilities`, `pnpm check:parity`, `pnpm check:readme` (after `--write`), `pnpm check:file-size`, `node scripts/check-spec-deps.mjs` (web_fetch gains a dependency), `pnpm typecheck`, per-package vitest, and the repo presubmit battery.

## 8. Live probe evidence (2026-10-05, local orchestrix deployment)

Probe harness: two scratch scripts (not committed; reproducible from this description) booting a plain cordis `Context` + `LlmRuntime` + `LlmPiAi` with the deployment's `llm-pi-ai.providers.orchestrix` record and `model-aliases` from `$DSH_HOME/settings.json` (provider-level `reasoning` field stripped for the catalog dump).

- **P1 (catalog shape)** — all four chat alias targets expose `reasoning.efforts`; on this pi-ai-backed provider the order is escalation order, so `efforts[0]` is the lowest:
  - haiku → `orchestrix/llmbox_ant/deepseek-v4.1-flash`: `[off, low, high, max]`
  - sonnet → `orchestrix/llmbox_ant/glm-5.3-flash`: `[off, low, high, max]`
  - opus → `orchestrix/llmbox_ant/glm-5.3`: `[off, low, high, max]`
  - fable → `orchestrix/llmbox_ant/kimi-k3`: `[off, low, medium, high, max]`
  - Note: `efforts[0]` is `"off"` (reasoning fully disabled) on this provider — see §6 disclosure.
  - The gauge alias target (`llmbox_systemone/bjev`) fails `resolveModelInfo` with `UNKNOWN_MODEL` on the chat adapter — confirms catalog lookup MUST be wrapped (warn + omit), which the design does.
- **Deployment context**: the live provider profile sets provider-level `reasoning: "high"`, so today's side queries run at **high** effort — the waste this design removes is concrete, not hypothetical.
- **P2 (acceptance)**: `llm.stream` with `reasoningEffort: 'off'` on the haiku route succeeds (`finish=stop`, no `UNSUPPORTED_REASONING_EFFORT`).
- **P2b (delta, reasoning-inducing prompt, warmup excluded)**: `off` → 855/800ms; `high` → 1423/1153ms (~40% latency reduction at `off`); both answers correct in all four runs. Usage does not break out reasoning tokens on this provider; latency is the observable. (Single-provider evidence; the quality claim for real side-query workloads is a dogfood item, not a probe claim.)

## 9. Out of scope

- **session-title-provider**: its `GenerateOptions` is built inside the upstream harness package `session-title-llm` (no effort field there; `stampRoute` copies only provider/model). Needs an upstream patch; tracked as a follow-up.
- Migrating web_fetch onto `runSideQuery` (its hard-fail contract differs from runSideQuery's never-throws; not needed for this feature).
- Extracting classifier-lane onto the shared resolver (its stream shape differs; pre-existing duplication accepted — two copies, not three).
- Dynamic/gauge-driven effort selection (rejected in the preceding design discussion; static defaults are the deliverable).
- Per-site quality tuning beyond shipping the keys (dogfood phase); a commit-split settings key (the code pin suffices until dogfood says otherwise).

## 10. PR slicing

**One PR** (round-1 change; codex's argument adopted over the draft's two-stacked-PR plan): shipping P1+P2 alone would flip every existing runSideQuery consumer (TUS, crusher, prompt-suggest, advisor) to the cheapest level BEFORE their per-site control keys exist, and would strip commit-split's deep-lane default. The commit-split pin and all consumer keys therefore land in the same commit as the policy. Everything in §7 runs on that PR.

## 11. Settled questions (round-1 verdicts, all three lanes converged unless noted)

1. **Per-site key beats alias stamp** — settled (3/3). Documented divergence from the spawn path (§3.2).
2. **`'default'` reserved spelling** — settled (3/3). Handled inside the resolver at every position (§3.1).
3. **Invalid explicit → warn + omit, no fall-through** — settled (3/3), with the no-metadata refinement: warn for an explicit candidate, silence when no candidate (codex; adopted).
4. **commit-split pinned `'default'` in code, no settings namespace** — settled (3/3), and the pin lands in the same PR as the policy (grok blocker; mooted by Q6's one-PR call).
5. **web_fetch depends on `@dsh-cc/side-query`, shared resolver** — settled (3/3).
6. **One PR** — codex's call, adopted; grok's two-PR variant required the pin in PR-A, which the one-PR form satisfies by construction.
7. **Default is `efforts[0]` even when `"off"`** — settled (3/3), with the §6 disclosure and dogfood watch item.

## 12. Review ledger (three blind lanes, 2026-10-05)

### Round 1

- **critic (dsh-cc-agents:critic, Opus)**: GO-WITH-CHANGES — 2 major (web_fetch cast widening; memo shape self-contradiction), 5 minor (ResolvedConfig/DEFAULTS; classifier-lane third copy; commit-split pin suppresses alias stamps — documented; test gaps; upstream anchors marked external). All folded (classifier-lane extraction explicitly rejected to §9).
- **codex (cc-codex-bridge, gpt-6.1-sol)**: NO-GO — 1 blocker (resolver/cache API ambiguity), 8 major (catalog lookup outside timeout/abort budget; concurrency double-warn race; throwing warn sink; ordering not a contract; catalog drift; consumer plumbing underspecified incl. inject audit wrong on TUS/commit-split; capability manifest required; test gaps), 2 minor (no-metadata warn/silent conflict; web_fetch type fix). All folded: resolver API pinned to one per-call signature with pending-promise memo; abort composed before lookup with eviction semantics; ordering caveat written into §2/§3.2/§6; consumer table rewritten with exact files; manifest work added to §4/§7; tests expanded.
- **grok (cc-grok-bridge)**: GO-WITH-CHANGES — 2 blocker (web_fetch `ResolvedConfig = Required<Config>` cannot absorb an optional key; commit-split pin scheduled after the policy), 6 major (memo contract ambiguity; catalog lookup not on the abort path; consumer plumbing specifics incl. crusher `overlaySettings`/advisor `resolveSection`/exact-`toEqual` spec; display-order caveat; bilingual README gate + stale pre-execute comment; test gaps), 2 minor (OneShotRoute export + memo-key separator + spread discipline; never-throw holes). All folded; Q6 resolved for one PR (its blocker 2 mooted).
- Orchestrator-folded conflicts: none material — the only divergence was PR slicing (codex: one PR; grok: two stacked with pin in A), resolved for one PR because it strictly dominates (no window where consumers change behavior without controls).
- Not independently re-verified by lanes: the §8 live probes (codex noted this explicitly). Probe scripts are reproducible from §8's description.

### Round 2 (fold-verification round)

- **critic**: GO — 3 minor (P1 export parenthetical imprecise; no empty-prompt short-circuit exists; entry-bound warn sink = first racing caller's). All folded (§4 P1, §4 P2 note, memo bullet).
- **codex**: NO-GO — 1 blocker (hanging lookup: upstream cancellation is cooperative-only, `resolveModelInfoFor` just awaits the adapter — the `signal.aborted` check after `await` is unreachable for a hung lookup), 4 major (pending-promise memo × caller-signal ownership contradiction — leader abort poisons followers; advisor live-overlay claim false — `apply` discards the cascade reader by design; manifest scope must cover all six affected entries; empty-prompt short-circuit does not exist), 1 minor ("every side query" overbroad). All folded: the resolver was redesigned so the shared lookup carries its own 2s timeout and never a caller's signal, waiters race per-call (§4 P2 memo/cancellation block); advisor row corrected to the raw-read policy; manifest list covers six entries; empty-prompt claim replaced by the real unrouted short-circuit; §6 wording qualified.
- **grok**: GO-WITH-CHANGES — 3 major (crusher `reducerEffort` line violates `exactOptionalPropertyTypes` — must use the `deferUrgencyTokens` conditional-spread; the same abort×memo contradiction codex found — independent convergence; commit-split `inject: ['llm']` hangs the existing mount spec `commit-split.spec.ts:149-152` unless it provides a stub `llm`), 3 minor (empty-prompt claim; no-metadata+explicit warn reuses the "not supported" string — pinned; catalog id `default` reachable via `efforts[0]` — §5 narrowed to requested spellings). All folded.
- Convergence note: codex finding 2 and grok finding 2 are the same defect found blind by both external lanes — treated as top-confidence and resolved by the shared-lookup-ownership redesign rather than by patching either fold.

### Round 3 (fold-verification round; critic stood on its round-2 GO)

- **codex**: NO-GO — 1 blocker (the "2s bound" was a forwarded signal, not a settlement mechanism: `resolveModelInfoFor` just awaits the adapter, both live adapters ignore the signal, and codex reproduced a never-settling entry in Node — entries then sticky-poison the key forever; required: race the entry against its own timer, swallow late settlement, no double warn), 1 minor (memo key `requested ?? ''` conflates absent with empty-string). Both folded: §4 P2 entry construction now pins the `Promise.race` + `settled`-flag form; memo key is `JSON.stringify([provider, model, requested ?? null])`.
- **grok**: GO-WITH-CHANGES — 1 major (the SAME hung-lookup hole found independently; verified both live adapters discard the signal), 2 minor (`abortOf` must resolve immediately on an already-aborted signal — pinned to the `index.ts:132-135` shape; the spread-to-avoid lives in the aliases package's own systemone-guard spec, path qualified). All folded.
- Convergence note: for the second time both external lanes independently found the same defect (round 2: abort×memo ownership; round 3: signal-forwarding is not a bound). Ledger honestly records that the v3 fold of round-2's "hung lookup" finding was incomplete — claimed settled, was not.

### Round 4 (delta-only confirmation round)

- **critic**: GO — all three folds verified; §4 P2 re-read end-to-end with no internal contradiction (the same ownership model stated identically in §3.2, the memo block, step 2, and §5); noted one cosmetic soft spot (waiter listener cleanup is prose, not in the pinned snippet — non-blocking).
- **codex**: GO — verified fold 1 with a live Node reproduction of the pinned construction: a never-settling lookup settled at 2001ms, caller abort left the shared entry untouched, late rejection produced neither an unhandled rejection nor a second warn, memo keys distinct, already-aborted waiter immediate.
- **grok**: GO — fold 1 confirmed against both live adapters (signal discarded in both); folds 2-3 verified against the in-repo `abortOf` shape.
- **Convergence: 3/3 GO.** The design is final; §12 closes.
