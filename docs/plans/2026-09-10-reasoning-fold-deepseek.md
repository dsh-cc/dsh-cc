# Reasoning Fold for DeepSeek-Family Models (Stage 0 = probe only)

Date: 2026-09-10. Status: proposed — critic cold review passed with
amendments (7 items: full usage-chunk capture with cost-defined gate,
stream protocol written out, llmbox adapter path flagged unverified,
reconstructability-contract impact documented, Stages 1/2 demoted to
contingent sketches, floorChars validation, display-delay note); all
baked in. **Scope decision post-review: this PR builds the Stage-0 probe
and nothing else.**
Zero harness changes; measurement before any behavior change.

## 1. Problem & honest stakes

DeepSeek/Kimi/GLM reasoning streams as `reasoning-delta` chunks, is
assembled into `reasoning` blocks, persisted, and re-emitted as
`reasoning_content` on every later turn (verified for the deepseek
adapter: harness `packages/llm/llm-deepseek/src/serialize.ts:203-236`).
Whether that costs anything depends on the served provider discarding or
metering it — an external fact a local probe can only measure INDIRECTLY
(via usage deltas, incl. `reasoningTokens?` and cached-token splits,
`llm/src/types.ts:148`). **Server-side quality impact of the provider
dropping reasoning is NOT measurable locally at all.** Hence this feature
is staged, and the fold itself is gated on data.

## 2. Feasibility ground truth (verified 2026-09-10, re-verified in review)

- In-flight request rewriting is NOT exposed: `agent/request` is
  config-only (`core/agent/src/runtime-types.ts:243`), `llm/stream`
  options are frozen for loop-built calls, `deriveMessages()` is not a
  waterfall.
- The ONE writable point is the stream sink: `llm/stream`
  (`llm/src/index.ts:67`, dispatched :1059-1064) is a legal waterfall;
  the docstring (:56-67) explicitly permits a listener to produce its own
  chunk stream, and the agent loop persists whatever the wrapper returns
  (`agent-loop/src/agent.ts:364-370`). Confirmed legal.
- Abort path exists: interrupted blocks at `agent.ts:373-386`; a wrapper
  MUST flush buffers in `finally` and forward `iterator.return()` —
  unflushed buffered chunks are silently lost otherwise.
- Stream shape invariants: deltas must land inside matching open blocks
  (`llm/src/invariant.ts:44-80`); a fold must pair-drop
  block-start/block-end when eliding an entire block.
- Session-log reconstructability contract (`llm/src/index.ts:60-64`) IS
  permanently broken by folding; TUI renders reasoning generically
  (`client/ui-chat/.../assistant.ts:117-121`). Both consequences are
  documented, not discovered later.
- Family scoping via `options.provider`/`options.model` anchors the
  adapter selection (`index.ts:1048`). **UNVERIFIED RESIDUAL**: the
  `llmbox_ant/`-prefixed traffic routes through the `orchestrix` provider
  whose adapter serialization has not been located in either repo — if
  llmbox's adapter does NOT re-send `reasoning_content`, the entire cost
  rationale for the fold evaporates. Locating it is a Stage-0 exit
  condition, not an implementation detail.

## 3. Design

Package `packages/llm-tuning/reasoning-fold` (cordis).

### 3.1 Stage 0 — measurement probe (THIS feature's full code content)

Read-only `llm/stream` listener (no wrapping; same read-only sanction as
the cache-health tracker): counts reasoning_bytes, text_bytes per call
per provider/model, and records the full usage chunk (reasoningTokens,
cached read/write splits) once the usage event arrives. Ledger:
`$DSH_HOME/reasoning-fold/<sessionId>.jsonl`. Enabled by default
(read-only, no behavior change).

Stage-0 exit conditions (the decision gate, defined up front):
1. **Cost gate**: "negligible" is defined in cost terms from the usage
   data (re-sent reasoning share of metered input, cache-read-adjusted),
   not token vibes. If negligible → STOP; the feature remains a probe.
2. **Adapter gate**: the orchestrix/llmbox adapter's serialization of
   reasoning is located and its re-send behavior documented — required
   evidence for (1) to mean anything on the deployment's main route.
3. Both answers land in this doc as an addendum before any Stage-1 work.

### 3.2 Stage 1 — fold policy (CONTINGENT SKETCH, frozen until Stage 0)

If and only if Stage 0 proceeds:
- Family-scoped opt-in (`cc-reasoning-fold.providers`, default `[]`).
- Stream protocol contract (written out pre-review):
  - head ≤ `headChars` (default 4000): pass through in real time;
  - beyond head: buffer only the excess;
  - at reasoning block end: emit one marker chunk
    (`[reasoning folded: N chars elided — head/tail retained]`) then the
    last `tailChars` (default 2000);
  - `finally` flushes any unflushed buffer; abort forwards
    `iterator.return()`; block-start/end/usage/finish chunks are NEVER
    touched except pair-dropping a fully elided block;
  - `floorChars` (default 12000): below it, passthrough; VALIDATION
    `floorChars > headChars + tailChars` enforced at config load.
- The FULL original reasoning is persisted to
  `$DSH_HOME/reasoning-fold/<sessionId>/<turn>.md` on EVERY fold,
  including abort/error paths (finally-flush), and is NOT exported with
  session transcripts.
- UX note: post-head reasoning display is delayed to block end under
  fold. Marker renders inline.
- Honest wager: fold is NOT model-reversible (unlike CCR) — stale
  cross-turn reasoning is bet to be low-value; that bet is why this is
  opt-in AND eval-gated.

### 3.3 Stage 2 — quality eval (CONTINGENT)

Pre-registered golden multi-turn tasks × fold on/off verdicts before any
default-on discussion. Test matrix and TUI specifics are deliberately
deferred per review — sketched, not specified.

### 3.4 Configuration

`cc-reasoning-fold.probe` (default `true`). Stage-1 keys
(`providers`/`head-chars`/`tail-chars`/`floor-chars`) are documented but
inert until Stage 1 exists.

## 4. Phases

0. Probe + ledger + Stage-0 addendum answering both gates. (This PR.)
1. Frozen: fold path, contingent on gates. Separate PR.
2. Frozen: eval; default-on decision. Separate PR.

## 5. Verification (Stage 0)

- Unit: byte counting across chunked reasoning-delta streams; usage join.
- Component: real preset composition with a stub deepseek-family adapter
  replaying recorded streams; assert LEDGER-ONLY behavior — persisted
  session reasoning blocks byte-identical to the uninstrumented baseline
  (the strongest possible "probe is inert" tripwire).
- Proxy no-write check on options on both frozen and manual call shapes.

## 6. Risks / explicit non-goals

- The whole fold may never be built if the probe says "negligible" —
  that is a success outcome, not sunk cost.
- llmbox adapter location remains an open research task after this doc.
- **Upstream-proposal only**: cache-TTL-aware cold-prefix recompaction
  (rewriting the re-send side) requires a message-rewriting seam the
  frozen harness does not expose — paper proposal, no planned code.
