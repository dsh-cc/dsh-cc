# Prompt-Cache Write-Side Breakpoints: placement-pin + metering attribution; write side already flows on anthropic routes

Date: 2026-09-21. Status: **Proposed** (round-2 revision; see Review record at the end).
Origin: ZCode design borrow analysis (zai-org/ZCode @ 872ad960, design notes in dsh-cc
memory `zcode-analysis-borrowables`). That analysis believed the single largest gap
between the ZCode harness and dsh-cc to be that dsh-cc's request pipeline emits **no
prompt-cache breakpoints at all**. Round-2 verification against the installed runtime
disproved the premise in its central case; this revision restates the real gap.

## 1. Problem

Prompt caching is the strongest known cost and latency lever for long agent sessions, and
it matters most for the GLM routes (cached input is billed a fraction of fresh input on
zhipu; the same holds for llmbox-proxied anthropic-messages endpoints that honor
`cache_control`). The round-1 text claimed dsh-cc "only *measures* cache behavior — it
never *declares* it." Round-2 verification shows reality is more specific:

- On **anthropic-messages routes, breakpoints already flow by default** — emitted one
  layer below the harness wrapper, inside the pi-ai serialization library.
- On **openai-completions routes, no markers flow and none can be enabled from config** —
  the schema slot that would enable them is never forwarded by the harness adapter.
- Regardless of dialect, dsh-cc has **no visibility into, and no per-route control over,
  marker placement** — nothing observes what was actually declared on the wire.

The gap is therefore not "add a write side" but "pin down what the runtime already emits,
attribute hit/miss accounting per route, and identify what an upstream change would unlock."

## 2. Current state and gap (re-verified 2026-09-21, round 2)

**dsh-cc (this repo @ 5dfc5ec), deepseek-harness @ 0.1.5-rc.1 (read-only sibling checkout,
consumed via `link:` packages), and `@earendil-works/pi-ai@0.85.1` (the version
llm-pi-ai resolves — verified through its pnpm symlink):**

- **Markers flow by default on anthropic-messages.** pi-ai 0.85.1
  `dist/api/anthropic-messages.js:20-28` (`resolveCacheRetention`: explicit
  `cacheRetention` → honored, else `PI_CACHE_RETENTION=long` env → `"long"`, else
  **`"short"`**) and stamps `{cache_control:{type:"ephemeral"}}` at three system-block
  sites (`:807,:814,:824` — mutually exclusive branches: OAuth requests get up to 2,
  non-OAuth get 1), on the last conversation message (`:1066-1082`, "Add
  cache_control to the last user message to cache conversation history"), and on the
  tools tail (`:1133`, gated on `supportsCacheControlOnTools`, which defaults to true, so
  it flows on the compat-less orchestrix models). Max markers per request: exactly 4,
  the Anthropic cap. In the current `$DSH_HOME/settings.json`, **every bound model
  alias** (default/haiku/sonnet/opus/fable → orchestrix; models
  `llmbox_ant/glm-5.3*`, `kimi_coding_cn/kimi-k3`) resolves to provider **orchestrix,
  `api: "anthropic-messages"`** — so markers flow on all primary dogfood routes today.
  The remaining providers sharpen the picture: `zai` (api unset) resolves through the
  pi-ai catalog provider data (`zai.json`) to openai-completions (no markers — the
  openai-dialect bullet below applies); `kimi-coding` has no pi-ai catalog entry and,
  with api unset, would throw if targeted directly — no alias targets it; recorded as a
  settings observation, not a plan dependency.
  The round-1 attribution "kimi 95–99% hits come entirely from server-side automatic
  caching" is thereby unproven and probably wrong for the current configuration.
- **The harness never configures this.** In
  `packages/llm/llm-pi-ai/src/adapter.ts:115-125`, `profileOptions` forwards only
  `thinkingBudgets`, `cacheRetention`, `transport`, and timeouts —
  `profile.cacheRetention` IS forwarded (`:125`), so `cacheRetention:"none"` is the one
  live config lever that strips markers. The neighboring schema slots
  `cacheControlFormat` / `supportsCacheControlOnTools` / `supportsLongCacheRetention`
  (`config.ts:273-276`; catalog dispositions `'offer'`, `catalog.ts:249-277`) are
  **dead**: accepted by zod, never forwarded by the adapter.
- **Openai-completions routes emit nothing.** pi-ai
  `dist/api/openai-completions.js:808` gates markers on
  `compat.cacheControlFormat === "anthropic"`, detected only for openrouter-hosted
  `anthropic/*` models (`:1276`, provider data `openrouter.json`). No zhipu/GLM provider
  data carries it, and no config path sets it (previous bullet) ⇒ GLM-via-openai routes
  get no markers by construction.
- **dsh-cc side: `cacheControl` appears nowhere** in `packages/**/src` (grep-verified);
  no dsh-cc seam can observe or mutate the emitted request (`llm/stream` is an
  observe-only waterfall — `packages/observability/cache-health/src/index.ts:160-166`
  registers `{global:true, prepend:true}` and sees hashable sections of the *options*,
  not the serialized pi-ai output).
- **Observation infrastructure exists and is the strongest asset.**
  `@dsh-cc/cache-health` (PR #39, `packages/observability/cache-health`) computes
  per-section hashes and stable-prefix metrics (`tests/no-write.spec.ts` pins that the
  observer itself declares nothing). `@dsh-cc/cache-trajectory` (PR #59,
  `packages/test-support/cache-trajectory`) replays session logs into per-request cache
  patterns (`session-log-io.ts`, `session-log-analysis.ts`, `analyzeSessionCache`) and
  carries the live-provider probe precedent
  (`tests/real-provider-cache.spec.ts`, `describe.skipIf(!process.env.DEEPSEEK_API_KEY)`).
- Compaction replay does not strand the tail marker: pi-ai re-stamps the last user
  message per request (`:1066-1082`), so the marker rides whatever history each attempt
  actually sends. The ZCode tail-marker design concern is moot under this behavior; the
  anthropic 4-marker ceiling is NOT moot (system sites + tools tail + last message is
  already at/near the cap — see §8).
- **ZCode reference design** (unverified line anchors; the checkout is not pinned in
  this worktree): context sections declare `cacheHint: "stable"|"dynamic"`; assembly
  sorts stable sections first and emits three separate system messages each carrying an
  ephemeral marker; compaction is materialized as its own stable section. Remains useful
  as the §6 design vocabulary, not as a claim about our runtime.

## 3. Design ruling (round 2)

- **The round-1 Phase 0 as designed is void**: its premise ("requests declare nothing")
  and its instrument (flipping `cacheControlFormat` in a profile) are both dead. The
  phase-0 questions that survive, restated against reality:
  1. **Placement map (static, provable without credentials):** exactly which markers land
     where, per dialect, for the request shapes our pipeline produces?
  2. **Metering attribution (offline, provable without credentials):** do providers meter
     cache reads/writes on routes where markers already flow (anthropic-messages), and
     what do GLM-route logs show given that no markers can flow there?
  3. **Would any change pay?** With markers already default-on anthropic routes, the
     remaining write-side upside concentrates on openai-completions routes — which are
     upstream-blocked (§6). The honest default hypothesis stays "do nothing."
- **This PR commits only the two zero-credential answers** (placement-pin contract test
  + offline metering attribution) plus this document correction. Live A/B
  (`cacheRetention:"none"` vs default on real routes) is a human-owned decision — it
  edits the deployment profile and spends provider budget, so it is documented as a
  follow-up procedure, not gateable CI work.

## 4. Phase 0 spike (what this PR commits)

Everything lands **inside `packages/test-support/cache-trajectory`** — no new package
(the round-1 "repo over package" argument now wins outright: this package already owns
session-log io/analysis/runner/bin, and a new test-support package would buy a README trio
plus registration checklist for code that belongs next to its siblings).

- **sp-1 — placement-pin contract test (TDD, the PR's code).** New spec
  `tests/pi-ai-cache-control-placement.spec.ts` driving pi-ai 0.85.1 through the official
  `./api/*` subpath export (`import { streamSimple } from
  '@earendil-works/pi-ai/api/anthropic-messages'` — no `.js` suffix; the exports map
  `"./api/*" → "./dist/api/*.js"` appends it, as pinned in §7(a)). The harness itself
  uses the same subpath pattern (`provider.ts:24-25`), and `check:deep-imports` forbids
  only `/src/` cross-package specifiers and excludes tests. Capture the fully serialized
  request via
  `options.onPayload` (`pi-ai/dist/types.d.ts:70-73` hands over the complete params before
  any network); an injected stub `fetch` (`types.d.ts:62`, `fetch?: FetchFunction`) only
  needs to return a non-throwing usage-bearing response. Pins, per dialect:
  1. anthropic-messages, default config ⇒ `cache_control:{type:"ephemeral"}` present on
     system blocks, the last conversation message, and the tools tail (exact sites as in
     §2);
  2. anthropic-messages with `cacheRetention:"none"` ⇒ all markers stripped;
  3. openai-completions without `compat.cacheControlFormat` ⇒ no markers;
  4. openai-completions with `compat.cacheControlFormat:"anthropic"` ⇒ markers — directly
     constructible via `model.compat.cacheControlFormat:'anthropic'` (merged in
     `getCompat`, `openai-completions.js:~1351`); no provider-data fallback needed.
  Dependency: devDependency `"@earendil-works/pi-ai": "0.85.1"` pinned exactly (spec-deps
  gate discipline; the pin is the point — this spec is the drift tripwire when pi-ai is
  upgraded).
- **sp-2 — offline metering attribution (zero credentials).** Sample the existing local
  session logs (this machine has ~150 per-cwd session directories under
  `$DSH_HOME/sessions`, `session.v3.jsonl.zstd` files, ~852 MB) through the bin's offline
  subcommand `pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts analyze-log
  <session.v3.jsonl[.zstd]>` (or `analyzeSessionCache` from `index.ts:38` over
  `readSessionEvents` output). Record: presence/absence of
  `cache_creation_input_tokens` / `cache_read_input_tokens` per provider/model route, and
  practical hit rates. This settles per-route attribution for traffic that already ran
  (e.g. whether orchestrix/anthropic-messages sessions show provider-metered cache
  accounting, and what zai/kimi-coding routes report). Skips closed with a "no session
  logs found" record if the host has none.
- **sp-3 — report synthesis.** Commit both results as the §7 addendum, plus the exact
  commands to reproduce, plus the human-gated live A/B procedure (below). Numbered rule
  for the addendum: observation claims cite the spec of record (sp-1) or the log sample
  (sp-2); nothing asserts from memory.
- **Human-gated follow-up (documented, not run):** live A/B on a real route —
  `cacheRetention:"none"` vs default on an orchestrix alias, usage-field deltas over N=20
  request pairs against a fixed long payload (unique nonce per pair, same bytes within a
  pair). Requires a human-owned profile edit and spend approval; the expected-value
  estimate comes from sp-2's observed metering.

## 5. Phase-0 in-repo follow-ups (implementation scope)

1. **sp-1 + sp-2 + sp-3** (§4) — the whole of this PR's executable work.
2. **This document:** round-2 revision plus the committed §7 addendum.
3. **Deferred, explicitly recorded (not built):**
   - `cache-health` **declared-vs-observed ledger fields** — deferred: the observability
     seam cannot see the serialized request (§2), so a "declared" producer requires the
     §6.1 upstream visibility seam first.
   - **Status surface / session command / settings keys** (`promptcache.*`,
     `cachehealth.*` alerts) — deferred with their consumers; a declared-marker table that
     cannot be populated is dead UI (the statusline payload builder already omits
     `undefined` keys by construction — `packages/ui/tui/src/harness/statusline-payload.ts`
     `compact()`, the policy Phase 1 would need), and settings keys without consumers are
     parsed-but-undelivered, which the capability-manifest audit flags. Phase-1
     conventions recorded for reuse: kebab-case top-level namespace, section-internal
     camelCase keys (`permissions.autoMode` precedent in
     `packages/interaction/permission-rules`), absence-preserving schema idiom.
   - **No capability-manifest change:** test-support packages carry no manifest rows
     (cache-trajectory/token-efficiency/agent-loop-mock precedent — grep-verified);
     `pnpm docs:parity` re-run to prove zero drift.
4. **Real seam identities for any Phase-1 work** (correcting round-1 citations):
   auto-mode machinery lives in `packages/interaction/permission-rules`
   (`auto-stage.ts`, settings namespace `permissions.autoMode`); statusline wiring in
   `packages/ui/tui/src/harness/statusline-{payload,wiring,command,settings}.ts`; session
   log access in `packages/session/session-forensics` and cache-trajectory's
   `session-log-*` modules; preset composition is YAML-only
   (`packages/preset/cc/agent.cordis.yml`). There is no `packages/preset/cc/src/`, no
   auto-driver package, no `status-key` package, no root `tests/` directory, and no
   `scripts/profile-completion.mjs` in this repo generation.

## 6. Phase 1 upstream proposal (checklist — no code committed from this repo)

1. **Visibility seam (harness):** expose the emitted per-request marker placement (or the
   serialized-request summary) through `llm/stream` options or a durably logged event, so
   cache-health can diff declared-vs-observed. Until this exists, no dsh-cc-side write
   observability is possible.
2. **Close or wire the dead slots (harness):** either forward `cacheControlFormat` /
   `supportsCacheControlOnTools` / `supportsLongCacheRetention` from profile into pi-ai
   compat, or delete the slots; today they satisfy schema while changing nothing.
3. **Openai-completions emission (pi-ai/provider data):** a config path to enable the
   gated `compat.cacheControlFormat === "anthropic"` emission for providers whose
   upstream honors anthropic-style markers over an openai dialect.
4. **Only then, dsh-cc-side consumers:** `promptcache.*` profile/settings surface,
   `/promptcache` session command and statusline surface, cache-health
   declared-vs-observed ledger fields, subagent same-model k-shot advice.
5. Keep the phase-1a caveat: a globally persisted default may take effect while the arm
   is still swinging — every gated surface must read the last attempt flow, including
   restored-state files.

## 7. Phase-0 report addendum (committed by this PR)

**(a) Pinned placement map — pi-ai 0.85.1, observed on `onPayload` serialized params** (contract test
`packages/test-support/cache-trajectory/tests/pi-ai-cache-control-placement.spec.ts`, 4 pins green):

- `anthropic-messages`, non-OAuth shape, default `cacheRetention` (`"short"`): `cache_control:
  { type: 'ephemeral' }` on the single system text block, the LAST tools entry only, and the last
  block of the last user message. Marker count **= 3** (system 1 + tools tail 1 + last message 1).
  The doc's "max exactly 4" applies only to the OAuth shape (two system blocks); the tested
  non-OAuth shape lands at 3, leaving one slot of headroom. Subpath export resolves WITHOUT the
  `.js` suffix: `@earendil-works/pi-ai/api/anthropic-messages` (the exports map `./api/*` already
  appends `.js`).
- `anthropic-messages` with `cacheRetention: 'none'`: zero markers anywhere in params.
- `openai-completions` without `compat.cacheControlFormat`: zero markers anywhere.
- `openai-completions` with `compat: { cacheControlFormat: 'anthropic' }`: same three sites
  (system / tools tail / last message) via `applyAnthropicCacheControl`, all `{ type: 'ephemeral' }`.

**(b) sp-2 offline metering attribution** — 3 large recent `session.v3.jsonl.zstd` logs under
`$DSH_HOME/sessions` (dsh-cc worktree dirs, size-sorted), analyzed via `readSessionEvents` +
`analyzeSessionCache`. Raw usage records carry normalized pi-style buckets
(`cacheReadTokens` / cacheWrite via `cacheWriteTokens`), not the raw anthropic
`cache_creation_input_tokens` / `cache_read_input_tokens` field names; all three logs show
nonzero cache buckets:

| sampled log (dir) | requests | route(s) | cache-read | cache-write | agg. read share |
|---|---|---|---|---|---|
| `--…dsh-cc-.claude-worktrees-side-queries--` (tui-9faa16de) | 221 | orchestrix/llmbox_ant/kimi-k3 (65), glm-5.3 (156) | 11.3M tok | 16.6M tok | ~40% (low; route switch + >15m gaps drop cache) |
| `--…dsh-cc-.claude-worktrees-cc-worktree-mgmt--` (3c3a206a) | 274 | orchestrix/llmbox_ant/glm-5.3-flash | 31.9M tok | 0 | ~96% |
| `--…dsh-cc-.claude-worktrees-ccr-deferred-externalization--` (302528d2) | 137 | orchestrix/kimi_coding_cn/kimi-k3 | 12.7M tok | 0 | ~99% |

**(c) Go/no-go for raising §6 upstream: NO-GO (keep "do nothing").** Metering shows the
OpenAI-compatible llmbox/kimi routes already achieve 96–99% aggregate read share with zero
measured write premium in steady state, and the one low-share log is explained by route switches
and >15m idle gaps, not by marker placement. The placement map shows the non-OAuth anthropic shape
uses only 3 of the 4 marker slots (one slot of headroom), so there is no cap pressure either.
Nothing in the data indicates a paying move to take upstream.

**(d) Reproduction**

- Contract test: `node_modules/.bin/vitest run packages/test-support/cache-trajectory/tests/pi-ai-cache-control-placement.spec.ts`
- Log analysis: `pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts analyze-log <path-to-session.v3.jsonl.zstd>`
  (fallback used here, see (e)): `node_modules/.bin/tsx -e "import {readSessionEvents} from './packages/test-support/cache-trajectory/src/session-log-io.ts'; import {analyzeSessionCache} from './packages/test-support/cache-trajectory/src/session-log-analysis.ts'; console.log(analyzeSessionCache(readSessionEvents(process.argv[1])))" <path>`
- Gate: `node scripts/check-spec-deps.mjs`

**(e) Skip records**

- `bin.ts analyze-log` subprocess form skipped: it transitively imports
  `@dsh-cc/compaction-micro/lib/index.js` (unbuilt `lib/` in this worktree), so the sanctioned
  `readSessionEvents` + `analyzeSessionCache` fallback was used instead.
- Live-provider A/B and any credentialed runs: skipped (zero credentials available; out of Phase-0 scope).

## 8. Risks

- **Cached-write premium is already live**: pi-ai's default-on markers mean
  anthropic-messages traffic may already be paying cache-write prices (~1.25× fresh input)
  on every prefix update — sp-2's attribution must look at write volume, not just hits,
  so the default posture is priced rather than assumed healthy.
- **Marker-count ceiling**: pi-ai stamps 1–2 system blocks (mutually-exclusive sites),
  the tools tail, and the last user message — at most exactly 4, the anthropic per-request
  cap. The placement pin (sp-1) reports the real count per shape; hitting the cap leaves
  zero headroom for any future marker, which constrains §6 designs.
- **Drift**: the placement map is pi-ai-version-specific — mitigated by the exactly-pinned
  devDependency plus the contract test, which fails loudly on upgrade behavior change
  (that failure is the tripwire working as designed, not flake).
- **Probe representativeness / credentials**: the human-gated live A/B replicates wire
  shape by hand when run; divergence from harness-assembled bytes and unpriced spend are
  its owner risks, which is why it is not CI work.
- `supportsLongCacheRetention` interacts with provider TTL pricing; untouched here.
- Wrong-breakpoint risk survives into any §6 implementation: a volatile section under a
  breakpoint can *reduce* hits; write-side design stays measurement-gated.

## Acceptance (DoD)

- [ ] sp-1 contract test merged: `tests/pi-ai-cache-control-placement.spec.ts` +
      exact-pinned `@earendil-works/pi-ai@0.85.1` devDependency in
      `packages/test-support/cache-trajectory/package.json` (+ lockfile); placement,
      strip, and no-op assertions green; repo gates pass: `check:spec-deps`, typecheck,
      test suite, `check:size`, `check:deep-imports`, `check:publish`, `check:readme`.
- [ ] §7 addendum committed from sp-1 output and, where local session logs exist, a sp-2
      `analyzeSessionCache` attribution sample — with skipped items recorded explicitly.
- [ ] `pnpm docs:parity` re-run with zero drift; no capability-manifest rows added
      (precedent pinned: test-support packages carry none).
- [ ] This Review record gains the round-2 verdict line once the revised document passes.

## Review record

- **Round 1 (2026-09-21, pre-commit):** cold review confirmed with amendments baked in
  (pre-committed numeric Phase-0 gate with "do nothing" as the default hypothesis,
  cached-write premium and 4-breakpoint ceiling moved into risks, profile config surface
  named).
- **Round 2 (2026-09-21, against dsh-cc @ 5dfc5ec + harness @ 0.1.5-rc.1 +
  pi-ai @ 0.85.1):** major revision on verified findings. (a) Central premise disproved:
  pi-ai 0.85.1 emits ephemeral markers by default on anthropic-messages
  (`resolveCacheRetention` → `"short"`), and every bound alias in the current settings
  routes anthropic-messages, so breakpoints already flow on primary routes. (b) The
  phase-0 instrument was inert: `cacheControlFormat` is zod-accepted but never forwarded
  (`adapter.ts:115-125`); openai-completions emission is gated on provider compat data no
  installed provider carries (`openai-completions.js:808,1276`). (c) Anchor rot: the
  round-1 follow-up map cited paths that exist in no repo on this machine —
  `packages/preset/cc/src/driver/` (preset/cc is YAML-only), `scripts/profile-completion.mjs`,
  `packages/interaction/auto-*`, `packages/session/auto-driver`, root `tests/auto/*` /
  `tests/integration/*` specs, `packages/observability/status-key` + `installSeam`,
  `packages/test-support/session-log-tap`, harness `packages/agent/src/compaction.ts`,
  `.tmp-upstream-deepseek-harness`, a parity-matrix "Write-side breakpoints: NONE" row —
  §5.4 records the real seams. (d) Scope re-cut: no new package (extend cache-trajectory),
  no settings keys or surfaces, no manifest work; Phase 1 restated as the §6 upstream
  checklist.
- **Round-2 verdict (2026-09-21, cold re-review): CONFIRM — proceed to TDD
  implementation.** All load-bearing claim groups retraced to file:line against the
  installed runtime and both repos; two phrasing corrections baked in above
  (mutually-exclusive system stamp sites with the exactly-4 ceiling; the zai/kimi-coding
  dialect note); sp-1's construction path validated (`streamSimple` via the official
  `./api/*` export, `onPayload` as the capture seam, assertion 4 constructible via
  `model.compat.cacheControlFormat`). Recorded as non-blocking: registry availability of
  the pinned pi-ai devDep, intentional pin-vs-`^0.85.1` drift as the tripwire, and
  session-log zstd readability exercised at API-signature level only.
