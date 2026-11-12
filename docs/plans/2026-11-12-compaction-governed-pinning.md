# Compaction Governed-Message Pinning

- Date: 2026-11-12
- Status: Design — r2 (three-seat blind review r1 folded; verdict was NO-GO with 4 cross-seat findings on the detection/restore contracts; all folded below)
- Program: context-engineering input governance (doc 2 of 8)
- Depends on: nothing. Independent package and mechanism.
- Literature basis: Governance Decay (arxiv 2606.22528 — pinning restores violation rate 30%→0%); ARCBench (2611.03223 — rules retained ≠ rules honored after compaction); Facts Without Rules (2608.29028).

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

- Compaction pipeline events (harness `compaction/compaction/src/types.ts` in the pinned copy): `compaction/end` payload is `{ compactionId, sourceCommandId?, turn, error? }` **only** (:72) — it does **not** carry `shadowedSeqs`/`summarySeq`/`shadowedTokenCount`. Those live on **`compaction/summary`** (:34-40), which fires only on successful completion of the summary+commit, and on the returned `CompactionResult` object (not an event). The r1 draft's claim that `compaction/end` carries the shadow list was a BLOCKER-level error found by all three seats.
- The checkpoint commit is a `user/message` appended with `surfaceOp: { op:'replace', startSeq, endSeq }` and `sourceEventSeqs` over the shadowed events (`compaction/compaction-basic/src/region.ts:506-509` in the pinned harness copy; r1 path anchor corrected from `compaction/basic/src/region.ts`).
- Compaction sources and their triggers: manual `/compact` (idle only, `interaction/command-compact/src/index.ts:69-70`), harness pressure auto at `agent/pre-step` (`compaction/compaction-basic/src/index.ts:157-175` in the pinned copy), **cost-gate idle on `agent/status` → compactNow (`compaction-cost-gate/src/index.ts:150-152,300`)**, and in-request retry paths (overflow/model-switch) inside the agent loop (`compaction/compaction-basic/src/index.ts:183-256` in the pinned copy + `core/agent-loop/src/agent.ts:444-563` in the pinned copy). The r1 draft's "automatic = pre-step" claim was incomplete; cost-gate and in-request paths are the two missed sources.
- Session/event firehose is an allowed observation channel (`hooks-claude-code/src/register-events.ts:264`). Mutation from within a `session/event` observer throws `reenter` — `publicationEntry()` at `core/session/src/index.ts:880-882` in the pinned harness copy (r1 anchor :740-743 was stale).
- `'user/message'` events carry the `UserMessage` object itself as `data` (`core/session/src/types.ts:315` in the pinned harness copy): read `event.data.source` and `event.data.content` — not `event.data.message.*` (r1 capture shape was a BLOCKER-level error found by codex, confirmed by the other seats).
- Surface validation: a `user/message` append must carry a surface intent; `{ surfaceOp: 'append' }` is the required form (`core/session/src/index.ts:806`, `core/session/src/surface.ts:316` in the pinned harness copy; r1's restore append omitted it — BLOCKER-level).
- `MessageSourceMap` entries are `{kind} & ContextFormed` where `ContextFormed.form` is the closed union `instructions|catalog|snapshot|notice|relay|recall` (harness `llm/lib/types/types.d.ts` in the pinned copy). r1's invented `form: 'pinned-restore'` violated this contract (all three seats) — restorations therefore keep the **original source object verbatim**, including its original legal form.

## Design

New package `packages/compaction/compaction-pinning` (`@dsh-cc/compaction-pinning`). Non-isolate plugin in the cc preset, enabled by default.

### Capture

One `session/event` listener (`{ global: true }`). For every `'user/message'` event: if `event.data.source?.kind ∈ pinnedSourceKinds`, store the **entire message object verbatim** (`{ seq, message, ts }`) into a per-session ring. Ring caps: `maxPinned` entries (default 16), `maxPinnedBytes` (default 16384) FIFO-evict oldest. Verbatim capture (whole `UserMessage`, content blocks + source metadata intact) also answers r1 MAJOR #10: restoration cannot discard structure it never destructured. Ring entries are dropped on `session/disposed` along with the session entry (TTL-honest; §Risks).

### Detect

- On `compaction/summary` at the firehose: if the event carries `shadowedSeqs` (success-only by construction), compute `restorable = shadowedSeqs ∩ ring.keys()`; if empty, no-op; else schedule restores keyed by `compactionId`.
- `compaction/end` is used only defensively: if it reports `error`, drop any pending schedule for that `compactionId` (belt: the summary never fires on failure, so this is a redundant consistency guard, not a load-bearing step — stated explicitly after r1).

### Restore

Actual appends never happen inside the firehose callback (reenter). Schedules drain from an `agent/pre-step` listener (`{ prepend: true }`, delegate-first): for each pending entry FIFO by original seq, `session.append('user/message', message, { surfaceOp: 'append' })` with the **verbatim stored message object**. Restored messages re-enter the capture ring naturally via publication (new seq, same kind) → loop-safe: re-shadowed pins restore again, one batch per compaction.

Restore ordering among themselves: ascending original seq. Each restore is its own append (no batching into one message, so source boundaries survive).

### Restore timing (honest contract, per-source, r1 fold)

| source | commit point | restore lands | exposure |
|---|---|---|---|
| manual `/compact` | idle | next pre-step (first step of the next turn) | none visible to the model before restore (turn does not start until pre-step) |
| harness pressure auto | during open turn at pre-step | next step's pre-step | one step (the step that triggered compaction already entered; its request builds without pins) |
| cost-gate idle | idle | next pre-step | none visible |
| in-request overflow/model-switch | inside `buildRequest` retry | next step's pre-step | the retried request itself can lack pins |

The in-request cases cannot be closed from dsh-cc: session/event callbacks cannot append (reenter), and the retry's message derivation happens inside the same synchronous continuation. Options rejected: queue-microtask racing (nondeterministic), engine override (upstream-only). Accepted exposure: one request can run without restored pins after an in-request compaction; pins return next step. Recorded as an upstream seam proposal (engine-side pin exemptions in span selection) in §Risks. All four paths are covered by tests (§Verification) that assert the documented timing, not an imagined one.

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

- Unit: capture ring (verbatim object identity, FIFO eviction, caps); detection (summary-only, error-belt discards schedules); restore (verbatim object reaches `deriveMessages()`, order by seq, `{surfaceOp:'append'}` form validated by the real session validator in the integration rig); capture read shape `event.data.source` exercised against real published events — the r1 shape bug is pinned by a regression test.
- Integration (real `JsonlSessionPersistence` + harness `BasicCompactionEngine`, temp rig): session with one pinned turn-rules message + noise → auto compaction via pressure; after `compaction/end`, live `deriveMessages()` shows the pinned message **after** the checkpoint, exactly once, verbatim, checkpoint intact; second compaction restores again. Separate cases for manual `/compact` and cost-gate idle compaction, asserting the per-source restore timing table above.
- Acceptance: two-week dogfood with turn-rules + post-edit-verify defaults; grep transcripts for restored pins after compactions; spot-audit post-compaction rule-following vs before.

## Risks

- **In-request compaction one-request gap**: documented in §Restore timing; an engine-side exemption seam is the real fix (upstream proposal).
- **Resume-generation gap**: ring is process memory. A compaction in a resumed session can shadow pins this process never captured. Producers re-fire (turn-rules) over time, but the interim is unprotected. Surfaced in README + settings description per r1 (codex MINOR). A later version can reconstruct immediately-present pins from the session's own projection at mount; deliberately out of scope here.
- No summary input linkage: the summarizer never sees restored content. Accepted (restore post-commit mirrors the literature's validated remedy).

## R1 fold ledger (three seats: internal critic, grok, codex)

Folded: detection moved to `compaction/summary` (+ end-error belt) — the payload-blocker; capture reads `event.data.source/.content` — the shape-blocker; restore appends verbatim message object with `{ surfaceOp: 'append' }` — the validation-blocker; invented `form:'pinned-restore'` removed (restorations keep original legal form); cost-gate idle path added to anchors and timing; per-source restore-timing honesty table incl. accepted in-request gap; reentry/path anchors corrected; resume-generation limitation surfaced.
