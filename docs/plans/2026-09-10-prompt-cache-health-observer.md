# Prompt-Cache Health Observer

Date: 2026-09-10. Status: proposed — critic cold review passed with
amendments (6 items: hash system+tools ahead of messages, skip
purpose:compaction/session-title calls, proxy no-write test on both call
paths, message-hash⟺wire-prefix assumption pinned by test, front-loaded
suspect heuristics, config trimmed); all baked in. Deployment fact added
post-review: cache counter reliability varies by routed upstream.
Borrowed from headroom's CacheAligner
(https://docs.headroomlabs.ai/docs/cache-optimization) — detector-only,
zero harness changes.

## 1. Problem

DeepSeek/Kimi/GLM providers reuse KV state for byte-identical request
prefixes. But cache metering is NOT uniformly reliable in this deployment
(measured 2026-09, packages/test-support/cache-trajectory evidence):
kimi-k3 healthy (steady 95-99% read share), grok single-slot incremental,
glm-5.2 under llmbox shows large zero-metered areas. So two distinct
questions need answers: (a) *which* part of the outbound request is
volatile and busts prefix reuse (observable from the request itself,
provider-independent); (b) what the provider actually meters
(usage.cacheReadTokens/cacheWriteTokens, provider-dependent). Today
nothing answers either.

Headroom's CacheAligner answers (a) detector-only — it reports, never
rewrites. This feature ports that idea and pairs it with (b) via the
existing session events.

## 2. Feasibility ground truth (verified 2026-09-10, re-verified in review)

- `llm/stream` (`packages/llm/llm/src/index.ts:67`, dispatched
  :1055-1064; both plain and prepared paths) delivers `GenerateOptions`
  (`llm/src/types.ts:393-431`) carrying `provider`, `model`, `messages`,
  AND — critically — `options.system` and `options.tools` as separate
  fields (`types.ts:412-418`). The wire prefix is
  system+tools+messages-in-order; hashing only `messages` would leave
  system-prompt drift (the classic culprit) invisible.
- Deep-freeze guards only loop-built requests (`index.ts:59-64`);
  manually built calls are not frozen — the no-write guarantee is pinned
  by a Proxy test on BOTH paths, not by relying on freeze to throw.
- `purpose` field (`types.ts:429`): `compaction` and `session-title`
  calls route through `llm/stream` but never appear in session events —
  they must be skipped or they corrupt the read-time usage join.
- Wire expansion is deterministic from `Message`
  (`llm-deepseek/src/translate.ts` families; tool-result fan-out +
  `reasoning_content` re-emission) — the design assertion
  "per-message hash list equality ⟺ wire prefix equality" is recorded as
  an ASSUMPTION and pinned by a test anchoring `serializeMessages`.
- Usage: `cacheReadTokens/cacheWriteTokens` optional on usage
  (`types.ts:146-147`), mapped by the deepseek adapter
  (`llm/llm-deepseek/src/translate.ts:69`); folded by model at
  `packages/session/command-cost/src/cost.ts:151-186`. llmbox pass-through
  fidelity of cache fields is **unverified** (residual risk).
- A prior-art analyzer already exists:
  `packages/test-support/cache-trajectory` (`analyzeSessionCache`,
  `compareForkPrefix`, bin `analyze-log`). This feature is the live,
  in-session counterpart; it MUST NOT re-implement offline log parsing —
  cross-link only.

## 3. Design

New package `packages/observability/cache-health` (cordis), two halves.

### 3.1 Passive prefix tracker (`llm/stream` listener, read-only)

Per qualifying model call in the session (skip `purpose: 'compaction' |
'session-title'`):
1. Hash `options.system`, then `options.tools`, then each message in
   order — per-segment sha256, keep the previous call's segment-hash
   list, compute the longest common prefix.
2. Ledger row appended to
   `$DSH_HOME/cache-health/<projectKey>/<sessionId>.jsonl`:
   `{ts, seq, provider, model, stableSegments, stablePrefixTokensEst,
   prefixChanged, driftSegmentIndex, driftExcerpt, callPurpose}`.
   - `seq` = the session event sequence (defined join key against
     session events, not a local counter).
   - `driftExcerpt`: 80-char whitespace-normalized excerpt of the first
     differing segment, redacted for common token/secret patterns.
3. Cost is O(new segments): map old segment hashes, compare lists, hash
   only until first difference.
4. Hard cap 2000 rows per session file (oldest trimmed), no config knob.

### 3.2 `/cache-health` slash command

`ctx.commands.register` + `helpable()` (precedent command-cost). Read-time
join (D1 resolved to read-time): walks
`invocation.agent.session.snapshotEvents()` for
`request/header` + `assistant/message` usage and folds by `seq` onto ledger
rows. Renders:
- stable prefix size/hash now, changed-since-last-call flag;
- drift table (seq, provider/model, segment index, excerpt);
- cache read/write token ratio per turn and totals — clearly labeled
  "provider-metered; zero-metered upstreams (e.g. glm-5.2 via llmbox)
  produce zeros, not evidence of misses";
- front-loaded volatile suspects only: content in the FIRST stable
  segments (system prompt, tool block, cwd, `DSH_SESSION_*`). Tail
  appends (dated reminders, runtime-context snapshots near the newest
  turn) extend the prefix rather than busting it — explicitly out of the
  suspect list.

### 3.3 Configuration

`cc-cache-health.enabled` (default `true` — read-only, no behavior
change). Nothing else.

## 4. Phases

0. Tracker + ledger + `/cache-health` raw facts. Dogfood one week;
   verify against the offline `cache-trajectory` analyzer on the same
   sessions (cross-validation duty, cheap since both exist).
1. Front-loaded suspect heuristics + recommendation text.
2. Follow-ups (own PRs): TTL-lapse detection (last-call age vs provider
   cache TTL → "cold start expected"); llmbox cache-field pass-through
   verification; correlation with the CCR feature's dry-run ledger.

## 5. Verification

- Unit: segment-prefix diff on synthetic sequences (insert/remove/mutate
  FIRST segment; mutate system; mutate tools; identical lists; unicode).
- No-write proof: Proxy-wrapped options with a recording `set` trap, on
  BOTH a loop-built (frozen) and a manually built (unfrozen) request —
  asserts zero writes either way.
- Assumption pin: test anchoring `serializeMessages` (deepseek adapter)
  so a future upstream change to wire expansion trips here.
- Component: real preset composition; stub adapter; two calls with a
  mutated first segment → ledger shows `prefixChanged: true` with the
  right segment index; `purpose: compaction` stub call produces NO row.

## 6. Risks / explicit non-goals

- Zero-metered upstreams make usage ratios misleading — flagged in UI
  text, not "fixed".
- Excerpt leakage: redaction + truncation; ledger is local-only.
- llmbox cache-field fidelity unverified — recorded as residual risk for
  phase 2 verification.
- Detector-only by design (the headroom lesson): no request rewriting,
  no provider-call changes, no harness changes.
