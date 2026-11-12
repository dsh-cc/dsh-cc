# Injection Dedupe & Notice Governance

- Date: 2026-11-12
- Status: Design — accepted (four three-seat blind-review rounds converged; final: all seats CONFIRMED, one prescribed clause folded verbatim)

r3 → r4 fold: stale `payload.step` window instruction deleted (gateSeq is the only dedupe clock); provisional-reservation rollback semantics added (trimmed reservations discarded; suppression distances measure committed admissions only; per-batch atomic commits); mixed observe×enforce commit contract defined (actual vs simulated batches, separate state advance); mounting matrix completed to the full 3×3 + off combinations.
- Program: context-engineering input governance (doc 7 of 8)
- Depends on: doc 1 (same package `@dsh-cc/input-budget`; plugs into `govern()` at the stage order **dedupe → caps → budget trim**; the class registry is referenced from doc 1's r2, not restated). Doc 3 (DedupeRow/CapRow live in its single-schema union).
- Literature basis: Silent Failures (2606.14589); Signal-Driven Observation (2606.06708 — observation over-ingestion).

## Formal design

- mode: auto (session-adopted; no formal-design screening clause in the project rules at this revision; adoption snippet at `<skill>/references/agents-snippet.md`).
- decision: enabled (shares the admission-governance model with the budget-governor doc — dedupe/caps are stages of the same `govern()` pipeline)
- triggerIds: FD-T2 (dedupe windows and deferred re-offers are late-message effects on admission), FD-L1 (advisory-kind eligibility composition with stated exclusion invariants), FD-L2 (window/cap arithmetic with monotonic gateSeq).
- backends: `["tla", "lean"]`
- modelDirs: `{"tla": "specs/tla/input-admission-governance", "lean": "specs/lean/input-admission-arithmetic"}`
- rationale: two-phase commit-on-admission, provisional in-batch allocation with rollback, and observe/enforce state separation are ordering-sensitive state properties; the window and cap rules are deterministic arithmetic. One model covers both docs' stages.

## Problem

A few advisory producers re-inject equivalent text repeatedly within a session, each time a durable message (retry-attendant guidance `interaction/retry-attendant/src/wiring.ts:269`, advisor-watchdog severity batches `interaction/advisor-watchdog/src/wiring.ts:314-317`, cc-shell glue notices `bundle/cc-shell/src/index.ts:251,272`). Producer-side latches exist for some (glue notices are process-latched — grok's correction: they are not the main repeating source); there is no systemic floor below them. Note-this-is-not: subagent lifecycle notices (`cc-subagent-children`, `subagent-settled`) are **not** redundant — see scope cuts below.

## Goals / Non-goals

Goals:

1. Cross-producer exact-content dedupe for the enumerated advisory kinds at the final enter batch, with an admission-correct state model.
2. Per-kind session caps for the enumerated repeat offenders only.
3. Observe-first with state semantics that make observe data a faithful would-have.

Non-goals:

- **No dedupe or caps on lifecycle kinds** (`cc-subagent-children`, `subagent-settled`): folds from all three seats — per-child notices carry distinct identity (different subjects), `subagent-settled` wakes the parent (dropping it loses settlement), and `one-shot-notice` latches *before* the gate sees the message (`one-shot-notice.ts:82-89`), so an enforce drop would be a silent one-shot miss. Lifecycle kinds are excluded from both stages in v1. Doc 1's registry was updated accordingly (`subagent-settled` is class task there).
- No dedupe of governance/task/memory classes (repeat-reminders are intentional; memory recall has its own producer-side same-query dedupe).
- No fuzzy/semantic dedupe (exact canonical-text hash only).
- No change to producer-side latches (they stay the first line).

## Current behavior (anchors)

- Gate seam and pipeline order are doc 1's: outermost pre-step listener; `dedupe → caps → budget trim`.
- Step identity: the pre-step payload carries `{ agent, messages, turn, step, signal, modelSelection }` (harness `core/agent/src/runtime-types.ts:350`; r2 note retained: grok's r1 "no step" claim was a consumer-subset reading). **Window arithmetic in this document uses the governor's monotonic `gateSeq` (doc 1), not `payload.step`** — `step` is turn-local and resets per turn (`agent-loop/src/agent.ts:431`; deleted instruction: the text that stood here in earlier revisions pointed the window at `payload.step`, which is superseded — codex/critic/grok all flagged the contradiction).
- Defer queue (`agent.inject`) mechanics and the governor's defer/TTL contract come from doc 1.
- `advisor-watchdog` batches several notes per inject and already has its own producer-side `sessionCap: 24` **notes** (`advisor-watchdog/src/settings.ts:58,77`): units differ from this design's cap (injects), stated explicitly below.
- `mcpReadyNotice`/`one-shot-notice` latch before delivery; caps on lifecycle-adjacent kinds were removed from scope (above).

## Design

All code lives in `packages/context/input-budget` (doc 1's package): `dedupe.ts`, `caps.ts`, driven from `govern.ts`.

### Two-phase admission within one batch (provisional state)

Cross-step self-suppression is fixed by committing only at final admission (r2 fold). The remaining hole (codex delta MAJOR): two same-key messages in **one** batch could both pass a read-only check and both be admitted. Checks therefore evaluate against **committed state ∪ provisionally-admitted-this-batch** in batch order:

1. **Check phase**: for each advisory message in order, compute the key; eligibility tested against committed state plus keys already provisionally admitted in this batch.
2. **Budget trim** (doc 1) computes the final batch.
3. **Commit phase**: only after the final batch is decided, entries that made it into the batch update dedupe/cap state. Deferred entries do not update state (never admitted); when later admitted from the backlog, the key commits then. Ledger rows are emitted **after trim/commit**, carrying the final decision (grok delta: emitting "at check time with the eventual decision" fights the two-phase model).

Provisional-reservation rollback (codex delta MAJOR): provisional admissions exist only inside one `govern()` call — **if a provisionally-admitted message is later trimmed from the final batch, its provisional reservation is discarded** (it never counts as an admission for any downstream computation). Dedupe suppression rows (`suppressedWithin`) measure distance from the last **committed** admission only; provisional reservations never enter that arithmetic. Dedupe state commit is atomic per batch (no partial commits).

Deferred-entry identity is the original message — its key recomputes identically at re-offer time.

Clock: dedupe and TTL arithmetic use the governor's **monotonic per-session `gateSeq`** (doc 1) — the payload's `step` is **turn-local** and resets per turn (codex delta; it exists on the payload at `runtime-types.ts:350`, but a session-wide window cannot be built on it).

### Mixed-mode commit contract (observe × enforce across stages)

Two batches exist conceptually: the **actual batch** (what the final decision admits into the step, always real) and each stage's **simulated batch** (what that stage computes as admitted when in observe mode). State advance rules: an enforce-mode stage advances its real state from the actual batch (commit phase above); an observe-mode stage advances only its simulated state from its own simulated batch (and only simulated-admitted entries advance it — suppression counters live only in rows). The two never mix: observe-stage simulated admissions are invisible to enforce stages and vice versa.

### Dedupe

Key: `${kind}:${sha256(canonicalText).slice(0,12)}` over concatenated text blocks, verbatim (no normalization v1).

State (per session): `Map<key, { lastAdmittedSeq: number }>` where the clock is `gateSeq` (see above) — updated **only at commit**.

Rule: suppress when `lastAdmittedSeq` exists and `gateSeq - lastAdmittedSeq < dedupe-window-steps` (default **8**; strict `<`). Boundary worked examples pinned in tests: last admitted at seq 3, window 8 → re-arrival at seq 10 suppressed (7 < 8); seq 11 admitted (8 ≮ 8).

Applies to kinds: `advisor`, `retry-attendant`, `compaction-micro`, `compaction-cost-gate`, and **`cc-shell-glue` in observe mode only** (see latch analysis below; explicit audit list; lifecycle kinds excluded per scope).

**`cc-shell-glue` latch analysis (grok's delta MAJOR):** `mcpReadyNotice` sets its once-per-session latch **before** returning the appended notice (`mcpReadyNotice.ts:154` then `:157-163`) — so an enforced drop/defer of a glue notice is a silent one-shot miss, exactly the failure class that got lifecycle kinds excluded. v1 therefore excludes `cc-shell-glue` from enforced dropping entirely: its dedupe/caps run in observe mode only (rows emitted; no suppression), until a producer-side "latch after admission" contract exists in a later design.

### Caps (session-level, admission-committed)

Same commit-at-admission state: `Map<kind, runningCount>` incremented only at commit.

| kind | default cap | unit (explicit) |
|---|---|---|
| `advisor` | 4 | injects (not notes; producer batches notes per inject and already enforces its own 24-note session cap — this cap is intentionally tighter, an outer floor) |
| `retry-attendant` | 8 | injects |
| `cc-shell-glue` | 4 | injects — **observe-only in v1** (latch analysis above; the cap is recorded, never enforced, until the producer latch-after-admission contract lands) |

Overflow at check time: ineligible → message goes to governor trim (defer/expiry handled by doc 1), row emitted at commit with the final outcome. Kebab key names are pinned in schemastery (`retry-attendant`, not `retryAttendant`; grok fold).

Lifecycle kinds (`cc-subagent-children`, `subagent-settled`) and `compaction-micro`/`compaction-cost-gate` carry **no caps** (dedupe only for the latter two; lifecycle kinds excluded entirely).

### Mounting and mode combinations (settings contract fixed per delta round)

Dedupe and caps are **one notice-governance stage** (not three independent stages — r2 prose promised per-stage controls the settings table never exposed; codex + grok convergent). The single physical pre-step listener (doc 1's) mounts when **either** the budget feature (`cc-input-budget`) or this stage (`cc-input-notice-governance`) is enabled. Combinations enumerated and tested:

| budget (`cc-input-budget`) | this stage (`cc-input-notice-governance`) | pipeline executed |
|---|---|---|
| disabled | off (`enabled:false`) | no listener mounted |
| disabled | observe | dedupe/caps observe only |
| disabled | enforce | dedupe/caps enforce only |
| observe | off | budget observe only |
| observe | observe | dedupe/caps observe + budget observe |
| observe | enforce | dedupe/caps enforce + budget observe |
| enforce | off | budget enforce only |
| enforce | observe | dedupe/caps observe + budget enforce |
| enforce | enforce | both enforce |

Each stage's mode flip resets only its own runtime state (this stage: dedupe map + cap counters; budget: defer queue) — never the other's. "off" for this stage (via `enabled:false`) leaves its state dormant.

### Observe mode (faithful would-have, codex delta correction)

In observe mode the check/trim/commit pipeline runs identically against the would-be batch, and **simulated state updates only for simulated-admitted entries** — never for simulated-suppressed ones (r2 text said would-be-suppressed entries update simulated state, which would extend their suppression windows forever although enforce would have readmitted them — codex delta MAJOR). Mechanically: simulate the batch through the same three phases; simulated-commit the simulated-admitted set; keep suppression counters (`suppressedWithin`, `suppressedTotal`) in rows, separate from the simulated admission state. The real batch is untouched; dedupe/caps have no backlog, so there is no cross-mode interference (doc 1's defer queue stays enforce-only independently).

### Ledger rows (owned by doc 3's union; referenced)

`DedupeRow { applied, kind, hash12, suppressedWithin }` — `suppressedWithin` = `gateSeq` distance between this message's suppression and its last admission. `CapRow { applied, kind, runningCount, suppressedTotal }` — `runningCount` = committed admissions for this kind in this session so far; `suppressedTotal` = cumulative suppressions for the kind. Observe rows carry `applied: false`.

### Settings — `cc-input-notice-governance` (kebab, user-layer, hot-read)

| key | type | default | bounds |
|---|---|---|---|
| `enabled` | bool | true | — (single stage toggle for dedupe+caps — delta-round fold: no per-stage keys exist) |
| `mode` | `'observe'|'enforce'` | `'observe'` | — (flip resets this stage's state only) |
| `dedupe-window-steps` | int | 8 | 1..64 (measured in `gateSeq` invocations — the unit is stated in the README) |
| `caps` | object | table above | values 0..64; kebab keys enforced; `cc-shell-glue` entry is observe-only in v1 |

Four-surface default discipline + "no settings file → observe runs" wiring test.

## Verification

- Unit: two-phase commit regression for the r1 BLOCKER (suppressed message deferred, re-offered later, admitted once distance ≥ window — never self-suppressing); same-batch duplicate allocation (two same-key messages in one batch — second provisionally ineligible); observe-mode simulation correctness (only simulated-admitted entries advance simulated state); window boundary examples in `gateSeq`; LRU bound 512 entries/session; `session/disposed` cleanup; cap commit-on-admission (dropped messages don't consume cap); the six mounting/mode combinations in the matrix; **cc-shell-glue observe-only behavior** (a latch-before-return producer's notice is recorded but never suppressed in v1 — regression-pins grok's delta MAJOR).
- Integration: synthetic producers repeating one advisory text across 12 gate invocations; enforce admits exactly one in the window; pipeline order dedupe→caps→trim pinned by a composed-order test; rows emitted after commit carry final decisions.
- Live acceptance (observe, two weeks): repetition distributions per kind (gateSeq denominator), then a sample audit before enforce: **all** suppressions if ≤ 100, else a **uniform random sample** of 100 suppressions (uniform so a pooled Wilson bound is valid — codex delta fold: unspecified stratification breaks the confidence calculation), with the acceptance criterion on self-inflicted valuable-loss stated as a one-sided 95% upper bound ≤ 5%.

## Risks

- A legitimately re-asserted notice within the window is suppressed and (as a durable inject) does not re-deliver — stated plainly, this is intentional irreversibility inside the window; observe-first ensures rates are measured before enforcement.
- Hash collisions at 12 hex chars over ≤ 512 entries: negligible; a collision suppresses one advisory message.
- Producer-side + systemic double suppression is a no-op in practice (latched producers never reach the gate); the integration test covers a latching producer explicitly.

## Fold ledger

r1 → r2 (critic GWC + grok GWC + codex NO-GO → folded): two-phase commit-on-admission fixes the self-suppression BLOCKER; dedupe/caps restricted to enumerated advisory kinds, lifecycle kinds excluded (`subagent-settled` established-wake risk; one-shot pre-latch silent-miss risk); window convention `delta < window`, counter = `payload.step` (grok's "no step in payload" claim verified false against `runtime-types.ts:350` — step is present; consumer subset annotations are the stale source); registry referenced from doc 1 r2 instead of restated (stale classes, `progress-brief`, memory class); mounting/stage-flip semantics for all four combos; DedupeRow/CapRow aligned to doc 3's union incl. `applied` and counter semantics; advisor inject-vs-note units and kebab pinning; observe-mode state advance defined as faithful would-have; audit sample size and confidence requirement specified.

r2 → r3 delta (three seats): clock switched from turn-local `payload.step` to the governor's monotonic `gateSeq` (turn-local step resets per turn and cannot carry a session window — codex); provisional in-batch allocation closes the same-batch duplicate hole; rows emitted after trim/commit (not at check time); dedupe+caps collapsed to **one stage** with a six-combination mounting matrix (prose had promised per-stage controls the settings table lacked); observe-mode simulation corrected (only simulated-admitted entries advance state; suppression counters stay separate); `cc-shell-glue` made **observe-only in v1** (mcpReadyNotice latches before return — enforced drops would be silent one-shot misses; grok) with the caps table carrying the caveat; audit sampling made uniform-random for a valid pooled Wilson bound.
