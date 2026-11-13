# Compaction Governed-Message Pinning

- Date: 2026-11-12
- Status: Design — accepted (four three-seat blind-review rounds converged; final: all seats CONFIRMED, one prescribed clause folded verbatim) — **Implemented** (package `packages/compaction/compaction-pinning`, model acceptance in `specs/tla/compaction-pin-restore/implementation.md`; implementation fold: rule (b) is commit-gated per the verified model, see §Detect)

r3 → r4 fold: the stale "summary fires only on success" anchor sentence deleted and replaced by the summary-then-commit ordering with the end-error cancellation contract (the exact premise the belt rejects).
- Program: context-engineering input governance (doc 2 of 8)
- Depends on: nothing. Independent package and mechanism.
- Literature basis: Governance Decay (arxiv 2606.22528 — pinning restores violation rate 30%→0%); ARCBench (2611.03223 — rules retained ≠ rules honored after compaction); Facts Without Rules (2608.29028).

## Formal design

- mode: auto (session-adopted; no formal-design screening clause in the project rules at this revision; adoption snippet at `<skill>/references/agents-snippet.md`).
- decision: enabled
- triggerIds: FD-T1 (the compaction engine and the pinning plugin are independent actors co-writing the session surface), FD-T2 (late/duplicate shadow and restore events affect restore outcomes), FD-T3 (the summary-before-commit failure window decides phantom vs lost restores — persistence order is load-bearing).
- backends: `["tla"]`
- modelDirs: `{"tla": "specs/tla/compaction-pin-restore"}`
- model status: `specs/tla/compaction-pin-restore` — convention verified (207,138 distinct states); probes red: blind rule-b, no-restore, belt-off-blind; green: belt-off-fixed (the checkpoint gate subsumes the belt), ring-eviction.
- rationale: restoration correctness hangs on event ordering across a failure window (summary logged before checkpoint commit; end-with-error cancellation; drain-after-next visibility) and on loop-safety of restore re-capture — enumerable only by fault-injected state-machine checking, not by property tests.

## Problem

Behavioral-governance messages — turn-rules reminders, post-edit-verify recovery hints — travel as ordinary `user/message` events. The summarization compactor replaces an entire `[startSeq, endSeq]` region with one checkpoint message; everything in the region becomes shadowed. Governance instructions survive only as whatever the LLM summary kept, with citation-grade evidence the survive/honor rates are poor. dsh-cc ships these governance surfaces on by default; compaction currently erases their durable effect mid-session.

## Goals / Non-goals

Goals:

1. Governance-class user messages shadowed by summarization compaction are restored verbatim immediately after the checkpoint commits.
2. Restoration is bounded, loop-safe, and works for all four compaction sources (manual, harness pressure, cost-gate idle, in-request overflow/model-switch — with the documented timing gap for the in-request pair, §Restore timing).
3. Zero harness changes.

Non-goals:

- No span-selection prevention (needs an upstream engine seam; listed as upstream proposal).
- No pinning of tool results (pruner/micro/CCR never see governance classes; those travel as `user/message` only).
- No pinning of advisory or general user input; pinning is explicit-kind opt-in.
- No cross-process capture guarantee for messages that predate this process's listeners (accepted v1 limitation, §Risks).

## Current behavior (anchors)

- Compaction pipeline events (harness `compaction/compaction/src/types.ts` in the pinned copy): `compaction/end` payload is `{ compactionId, sourceCommandId?, turn, error? }` **only** (:72) — it does **not** carry `shadowedSeqs`/`summarySeq`/`shadowedTokenCount`. Those live on **`compaction/summary`** (:34-40), which is appended **before** the checkpoint commit (`compaction/compaction-basic/src/region.ts:489-509` in the pinned harness copy; the failed-commit path emits `compaction/end` with `error` at `:237-245`), so a summary can exist without any actual shadowing — the Detect section keys schedules on summary and treats end-with-error as a load-bearing cancellation (delta-round fold; the earlier "summary fires only on success" sentence was deleted — its premise is exactly what the belt exists for). The same fields also appear on the returned `CompactionResult` object (not an event).
- The checkpoint commit is a `user/message` appended with `surfaceOp: { op:'replace', startSeq, endSeq }` and `sourceEventSeqs` over the shadowed events (`compaction/compaction-basic/src/region.ts:506-509` in the pinned harness copy; r1 path anchor corrected from `compaction/basic/src/region.ts`).
- Compaction sources and their triggers: manual `/compact` (idle only, `interaction/command-compact/src/index.ts:69-70`), harness pressure auto at `agent/pre-step` (`compaction/compaction-basic/src/index.ts:157-175` in the pinned copy), **cost-gate idle on `agent/status` → compactNow (`compaction-cost-gate/src/index.ts:150-152,300`)**, and in-request retry paths (overflow/model-switch) inside the agent loop (`compaction/compaction-basic/src/index.ts:183-256` in the pinned copy + `core/agent-loop/src/agent.ts:444-563` in the pinned copy). The r1 draft's "automatic = pre-step" claim was incomplete; cost-gate and in-request paths are the two missed sources.
- Session/event firehose is an allowed observation channel (`hooks-claude-code/src/register-events.ts:264`). Mutation from within a `session/event` observer throws `reenter` — `publicationEntry()` at `core/session/src/index.ts:880-882` in the pinned harness copy (r1 anchor :740-743 was stale).
- `'user/message'` events carry the `UserMessage` object itself as `data` (`core/session/src/types.ts:315` in the pinned harness copy): read `event.data.source` and `event.data.content` — not `event.data.message.*` (r1 capture shape was a BLOCKER-level error found by codex, confirmed by the other seats).
- Surface validation: a `user/message` append must carry a surface intent; `{ surfaceOp: 'append' }` is the required form (`core/session/src/index.ts:806`, `core/session/src/surface.ts:316` in the pinned harness copy; r1's restore append omitted it — BLOCKER-level).
- `MessageSourceMap` entries are `{kind} & ContextFormed` where `ContextFormed.form` is the closed union `instructions|catalog|snapshot|notice|relay|recall` (harness `llm/lib/types/message.d.ts:75-93`, mirrored at `llm/src/message.ts:86-101` — r2's `types.d.ts` anchor was the wrong file, and the union includes a `form?: never` branch, i.e. form-less sources are legal). r1's invented `form: 'pinned-restore'` violated this contract (all three seats) — restorations therefore keep the **original source object verbatim**, including its original legal (possibly absent) form.

## Design

New package `packages/compaction/compaction-pinning` (`@dsh-cc/compaction-pinning`). Non-isolate plugin in the cc preset, enabled by default.

### Capture

One `session/event` listener (`{ global: true }`). For every `'user/message'` event: if `event.data.source?.kind ∈ pinnedSourceKinds`, store the **entire message object verbatim** (`{ seq, message, ts }`) into a per-session ring. Ring caps: `maxPinned` entries (default 16), `maxPinnedBytes` (default 16384) FIFO-evict oldest. Verbatim capture (whole `UserMessage`, content blocks + source metadata intact) also answers r1 MAJOR #10: restoration cannot discard structure it never destructured. Ring entries are dropped on `session/disposed` along with the session entry (TTL-honest; §Risks).

### Detect

- On `compaction/summary` at the firehose: if the event carries `shadowedSeqs`, compute `restorable = shadowedSeqs ∩ ring.keys()`; if empty, no-op; else schedule restores keyed by `compactionId`. The summary is **provisional scheduling evidence, not completion evidence**: the engine appends `compaction/summary` *before* the checkpoint commit (`compaction/compaction-basic/src/region.ts:470-510` in the pinned harness copy), so a failed commit append leaves a logged summary with `shadowedSeqs` and no actual shadowing (delta-round fold, all three seats — r2's "summary is success-only, belt redundant" was wrong).
- `compaction/end` is therefore **load-bearing**: an end event carrying `error` (emitted on the failed-commit path at `region.ts:237-245`) **cancels** any pending schedule for that `compactionId`. Schedules become restore-eligible only when either (a) a successful end arrives, or (b) the conservative rule applies (implementation fold, matching the verified model's `RequireCheckpoint` convention): the schedule has existed for ≥ 1 turn with no end seen for that id **and** the checkpoint commit itself was witnessed — a later `user/message` whose `sourceEventSeqs` cites the summary's seq. The commit witness is required by the model's red probe (`strict-blind-rule-b` restores never-shadowed pins under the bare-turn shape); the drain rule in §Restore uses only eligible schedules.

### Restore

Actual appends never happen inside the firehose callback (reenter). Schedules drain from an `agent/pre-step` listener (`{ prepend: true }`, delegate-first): for each pending entry FIFO by original seq, `session.append('user/message', message, { surfaceOp: 'append' })` with the **verbatim stored message object**. Restored messages re-enter the capture ring naturally via publication (new seq, same kind) → loop-safe: re-shadowed pins restore again, one batch per compaction.

Restore ordering among themselves: ascending original seq. Each restore is its own append (no batching into one message, so source boundaries survive).

### Restore timing (honest contract, per-source)

The drain listener is `{ prepend: true }`, delegate-first at `agent/pre-step`: it drains after `await next()` returns — meaning **schedules created by inner listeners during the same pre-step drain in that same pre-step, before the loop derives the request** (delta-round fold: grok and codex independently showed `{prepend:true, delegate-first}` restores within the pressure step, falsifying r2's "one pressure step" exposure row).

| source | commit point | restore lands | model-visible exposure |
|---|---|---|---|
| harness pressure auto | inside `agent/pre-step` (inner to the drain) | **same pre-step**, before request derivation | none |
| manual `/compact` | idle | next pre-step (first step of the next turn) | none |
| cost-gate idle | idle | next pre-step | none |
| in-request overflow/model-switch | inside `buildRequest` retry | next pre-step | the retried request itself can lack pins |

Same-step pressure restoration hinges on ordinary waterfall ordering (no new seams): the drain runs when the pinning listener's `next()` continuation executes; compaction's own pre-step scheduling is an inner producer. The integration test pins this ordering (`suppress-settled`-style interplay included).

The in-request cases cannot be closed from dsh-cc: session/event callbacks cannot append (reenter), and the retry's message derivation happens inside the same synchronous continuation before any later pre-step exists. Options rejected: queue-microtask racing (nondeterministic), engine override (upstream-only). Accepted exposure: one request can run without restored pins after an in-request compaction; pins return next step. Recorded as an upstream seam proposal (engine-side pin exemptions in span selection) in §Risks.

### Kind defaults

`pinnedSourceKinds: ['turn-rules', 'edit-recovery-hint']` — the durable behavioral-constraint producers. `turn-rules` re-fires are fine; exact-duplicate restores over a live copy cannot occur (restores only come from actually shadowed seqs).

### Settings — `cc-compaction-pinning` (kebab, user-layer, hot-read)

| key | type | default | bounds |
|---|---|---|---|
| `enabled` | bool | true | — (disabling stops capture+restore; ring is not retroactively reconstructed) |
| `pinned-source-kinds` | string[] | `['turn-rules','edit-recovery-hint']` | each ≤64 chars |
| `max-pinned` | int | 16 | 1..64 |
| `max-pinned-bytes` | int | 16384 | 1024..262144 |

Four-surface default discipline + "no settings file → capture/restore run" wiring test.

### Failure semantics

Capture/store errors: drop entry, debug log. Drain-time append failure (session disposed mid-queue): drop entry. Handlers never throw across the firehose boundary. `dropped`, `restored`, `evicted` counts kept in-process and exposed via a `getPinningHealth()` export for tests (no user notices).

## Registration / repo checklist additions

Package skeleton + README pair; preset row in `agent.shared.cordis.yml` (compaction realm neighbourhood); composition.spec; capability manifest + parity; `tsconfig.packages.json`; check:size.

## Verification

- Unit: capture ring (verbatim object identity, FIFO eviction, caps); detection (provisional summary schedules; end-error cancellation of schedules — the belt is load-bearing, regression-pinned); restore (verbatim object reaches `deriveMessages()`, order by seq, `{surfaceOp:'append'}` form validated by the real session validator in the integration rig); capture read shape `event.data.source` exercised against real published events — the r1 shape bug is pinned by a regression test.
- Integration (real `JsonlSessionPersistence` + harness `BasicCompactionEngine`, temp rig): session with one pinned turn-rules message + noise → pressure auto-compaction inside a pre-step; assert the pin is present in `deriveMessages()` **when that same pre-step completes** (same-step restore, matching the timing table — the drain runs on the pinning listener's post-`next()` continuation), exactly once, verbatim, checkpoint intact; second compaction restores again. Separate cases for manual `/compact` and for cost-gate idle compaction, plus **overflow and model-switch retry-path cases** asserting (a) the retried request can lack the pin (accepted one-request gap) and (b) the next pre-step restores it (codex delta fold: r2 claimed coverage without these cases).
- Acceptance: two-week dogfood with turn-rules + post-edit-verify defaults; grep transcripts for restored pins after compactions; spot-audit post-compaction rule-following vs before.

## Risks

- **In-request compaction one-request gap**: documented in §Restore timing; an engine-side exemption seam is the real fix (upstream proposal).
- **Resume-generation gap**: ring is process memory. A compaction in a resumed session can shadow pins this process never captured. Producers re-fire (turn-rules) over time, but the interim is unprotected. Surfaced in README + settings description per r1 (codex MINOR). A later version can reconstruct immediately-present pins from the session's own projection at mount; deliberately out of scope here.
- No summary input linkage: the summarizer never sees restored content. Accepted (restore post-commit mirrors the literature's validated remedy).

## R1 fold ledger (three seats: internal critic, grok, codex)

Folded: detection moved to `compaction/summary` (+ end-error belt) — the payload-blocker; capture reads `event.data.source/.content` — the shape-blocker; restore appends verbatim message object with `{ surfaceOp: 'append' }` — the validation-blocker; invented `form:'pinned-restore'` removed (restorations keep original legal form); cost-gate idle path added to anchors and timing; per-source restore-timing honesty table incl. accepted in-request gap; reentry/path anchors corrected; resume-generation limitation surfaced.

## R2 → R3 delta fold ledger (three seats)

Folded: summary re-cast as **provisional** scheduling evidence with the end-error belt promoted to load-bearing (summary precedes commit; failed commit leaves a logged summary — all three seats); pressure-path exposure corrected from "one step" to **same pre-step** (`{prepend, delegate-first}` drains schedules created by inner listeners before request derivation; timing table rewritten); ContextFormed anchor corrected to `llm/lib/types/message.d.ts:75-93` with the `form?: never` optionality noted (grounds verbatim-form legality); verification now asserts the same-step pressure boundary and adds overflow/model-switch retry-path cases (r2 claimed coverage without them).
