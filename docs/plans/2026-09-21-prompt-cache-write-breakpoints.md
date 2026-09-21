# Prompt-Cache Write-Side Breakpoints: profile spike first, section-level design second

Date: 2026-09-21. Status: **Proposed**. Origin: ZCode design borrow analysis
(zai-org/ZCode @ 872ad960, design notes dsh-cc memory `zcode-analysis-borrowables`).
Design-review record: cold review **confirmed**, with amendments all baked in
(pre-committed numeric Phase-0 gate with "do nothing" as the default hypothesis,
cached-write premium and 4-breakpoint ceiling moved into risks, profile config surface
named). This
document covers the single largest gap that analysis found between the ZCode harness and
dsh-cc: dsh-cc's request pipeline emits **no prompt-cache breakpoints at all**.

## 1. Problem

Prompt caching is the strongest known cost and latency lever for long agent sessions, and
it matters most for the GLM routes (cached input is billed a fraction of fresh input on
zhipu; the same holds for llmbox-proxied anthropic-messages endpoints that honor
`cache_control`). ZCode engineers this explicitly: multi-breakpoint ephemeral placement,
cache-aware compaction, and a full observability loop. dsh-cc today only *measures* cache
behavior — it never *declares* it.

## 2. Current state and gap (verified 2026-09-21 against both checkouts)

**dsh-cc / deepseek-harness (this worktree and the read-only harness checkout):**

- **No breakpoint is ever written.** `cacheControl` appears nowhere in dsh-cc
  `packages/**/src`. In the harness, `cacheControlFormat` exists only as a schema/typing
  slot (`llm-pi-ai/src/config.ts:273`, `llm-pi-ai/src/catalog.ts:142,413`); the profile
  disposition gate lists it as `'offer'` (`catalog.ts:249`) but **no shipped profile
  assigns it**. Same for the neighboring slots `supportsCacheControlOnTools` and
  `supportsLongCacheRetention` (`catalog.ts:421-428`).
- Today's healthy kimi-k3 cache hit rates (steady-state 95–99%, per the
  fork-cache-diagnostics work in PR #59) come entirely from the upstream's server-side
  automatic full-prefix caching, not from anything our requests declare. The
  `glm-5.2` zero-metering observation recorded in the same memory is the same symptom
  viewed from the GLM side: with no explicit breakpoints, hit accounting depends on
  whatever the provider decides to do on its own.
- **Observation exists and is ahead of ZCode's.** `@dsh-cc/cache-health` (PR #39,
  `packages/observability/cache-health`) computes per-section hashes and stable-prefix
  metrics; `cache-trajectory` (PR #59, `packages/test-support/cache-trajectory`) replays
  session logs into per-request cache patterns and compares parent/child prefixes. What
  is missing is anything to observe *about our own breakpoints*: no breakpoint
  diagnostics, no cache-hit/miss attribution at the request level.
- Compaction is breakpoint-blind by construction (there are no breakpoints to misplace).

**ZCode (zai-org/ZCode @ 872ad960), the reference design:**

- Every context section declares `cacheHint: "stable" | "dynamic"`
  (`packages/core/src/context/types.ts:66`). Assembly sorts stable sections first and
  emits **three separate system messages**, each carrying `{ type: "ephemeral" }`
  (`context/builder.ts:242,258,272`): cli_prefix, stable body, dynamic body (the dynamic
  block is prefixed with `\n\n` so its left boundary is byte-fixed).
- Conversation side, a single `cacheControlIndex` write marker sits on the latest
  non-system message; **after compaction the marker is moved forward** onto real context
  so a one-off compact prompt never lands in the cache write set
  (`core/src/runtime/helpers/provider-request-messages.ts:292-315`).
- Cache health is first-class: hit/miss events, stable-prefix estimation on miss,
  per-request `cacheReadTokens/inputTokens` rates, and a debug analyzer that slices
  messages into hit/miss segments.

## 3. Design

Two phases, deliberately ordered cheap-first. Phase 0 is a spike: it may turn out that
pi-ai's built-in placement plus our server-side caching is already near-optimal, in which
case Phase 1 shrinks or evaporates.

### Phase 0 — config-only spike (days, zero harness changes)

1. On a throwaway deployment profile for a GLM route and a kimi route, set
   `cacheControlFormat: 'anthropic'` (and, where the dialect supports it,
   `supportsCacheControlOnTools: true`) in the pi-ai profile. The exact config surface is
   the provider-profile catalog config consumed by `llm-pi-ai` (profile field
   `cacheControlFormat`, per-`OpenAICompletionsCompat`); the spike's first step is
   naming the concrete file/key in the deployment profile and confirming it reaches the
   wire, since profile plumbing end-to-end is itself unverified.
2. Drive a scripted session (fixed prompt sequence, twice: back-to-back and after a 15
   minute TTL lapse) and answer with `cache-trajectory`'s `analyzeSessionCache`:
   where does pi-ai place breakpoints, do `cacheReadTokens`/`cacheWriteTokens` appear on
   GLM routes that previously metered zero, does hit rate move, does llmbox pass the
   fields through on the wire?
3. **Pre-committed numeric gate (decided before running, not after seeing results):**
   Phase 1 proceeds only if Phase 0 shows a concrete placement flaw — e.g. the
   stable-prefix hit rate measured by `cache-health` improves ≥10 points when
   breakpoints are enabled on a GLM route, *or* GLM routes gain cache metering they
   previously lacked while kimi stays flat. Otherwise the default outcome is "do
   nothing": kimi's server-side automatic caching already yields 95–99%, so the null
   hypothesis is that pi-ai's placement (once enabled) is good enough, and this doc's
   Phase 1 evaporates by design.
4. Acceptance for the spike is a *written* verdict in this doc's addendum: (a) pi-ai
   placement map per dialect; (b) per-route metering delta; (c) the placement-flaw
   verdict against the gate above.

### Phase 1 — section-level stability design (only if Phase 0 shows a flaw)

1. **Stability is declared, not inferred.** Add a stability annotation to the dsh-cc
   system-section seam (the `system-prompt/assemble` waterfall where dsh-cc already
   prepends sections, per the tool-append-order precedent). Sections that can change
   during a session (environment info, memory index, todos, date) order *after* sections
   that cannot (identity, harness block, tool-independent contracts).
2. **Breakpoint placement follows the ZCode three-message shape:** prefix block, stable
   body, dynamic body, one `cache_control: ephemeral` each; tail write marker on the
   last non-system message. Whether placement is expressible via pi-ai profile options or
   needs a harness seam is decided from Phase 0 evidence; if a harness seam is needed,
   this doc's placement map becomes an upstream proposal, not a dsh-cc fork.
3. **Compaction must not dirty the cache.** Whatever summary prompt compaction sends must
   not become a cache write breakpoint; the tail marker moves forward onto preserved
   history. This is the one piece with no pi-ai lever and is definitely upstream.
4. **Close the telemetry loop in the existing observer** rather than building ZCode's
   separate debug stack: extend `@dsh-cc/cache-health` to record declared-breakpoint
   positions (from the request) next to observed hits, so "we declared X, the provider
   honored Y" is one ledger join.

### Explicit non-goals

- No server-side cache tuning; no per-provider TTL negotiation in Phase 1.
- No change to compaction content or thresholds here (that program is
  `2026-09-21-compaction-resilience-upgrades.md`).
- The fork persona-delivery idea (seed-child-as-message) stays frozen per the earlier
  ruling; this doc neither needs nor enables it.

## 4. Expected effect

- **Phase 0 alone**, if it lights up metering and placement on GLM routes: first honest
  cache accounting for GLM; the `llmbox zero-metering` open question resolves; if the
  route bills cached reads cheaper, measurable spend drop on long sessions at zero
  behavior risk.
- **Phase 1**: stable-system-prefix hit rate becomes a designed invariant instead of an
  accident; the target to beat is the measured Phase-0 baseline, with the
  `cache-health` `stablePrefixHash` as the regression tripwire in CI-flavored dogfooding.
- Either way, the repo gains a permanent, scripted A/B harness for cache claims — the
  measurement debt the repo already paid twice (PR #59, boot optimization) stops
  recurring.

## 5. Risks and open questions

- pi-ai's internal placement strategy is not visible from either checkout (same boundary
  as the reasoning-fold adapter gate). Phase 0 is precisely the instrument for it; all
  Phase 1 sizing numbers are deferred until it lands.
- A wrong breakpoint is worse than none (a volatile section under a breakpoint can
  *reduce* hits). That is why write-side work is gated on measured Phase-0 behavior.
- **Cached-write premium**: Anthropic-style billing charges more for cache writes
  (~1.25× fresh input). Declaring breakpoints on a route with a poor hit rate raises
  spend instead of lowering it — the Phase 0 measurement must price writes, not just
  count hits.
- **Breakpoint ceiling**: the ZCode shape (three system breakpoints + one tail marker)
  already sits at the Anthropic 4-breakpoint maximum with zero headroom; any future
  breakpoint means dropping one. Noted so Phase 1 designs within the cap instead of
  discovering it late.
- `supportsLongCacheRetention` interacts with provider TTL policy; enabling it without
  knowing the upstream's TTL pricing can raise spend. Left out of Phase 0 unless the
  pricing question is answered first.

## Acceptance (DoD)

- [ ] Phase 0 spike report committed as an addendum here: placement map, metering delta,
      go/no-go for Phase 1, with the driving script under `scripts/` or
      `packages/test-support/`.
- [ ] If Phase 1 proceeds: stability annotations + assembly ordering covered by unit
      tests (a section marked stable never serializes behind a dynamic one); tail-marker
      forward-move on compaction covered by a projection test.
- [ ] `cache-health` ledger gains declared-vs-observed fields; `pnpm docs:parity` and
      capability manifest updated for any new settings keys.
