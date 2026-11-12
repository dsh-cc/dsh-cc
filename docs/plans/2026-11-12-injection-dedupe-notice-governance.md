# Injection Dedupe & Notice Governance

- Date: 2026-11-12
- Status: Design — r2 (critic + grok + codex r1 findings folded; codex was NO-GO on the admission-ordering bug, now fixed by a two-phase commit design)
- Program: context-engineering input governance (doc 7 of 8)
- Depends on: doc 1 (same package `@dsh-cc/input-budget`; plugs into `govern()` at the stage order **dedupe → caps → budget trim**; the class registry is referenced from doc 1's r2, not restated). Doc 3 (DedupeRow/CapRow live in its single-schema union).
- Literature basis: Silent Failures (2606.14589); Signal-Driven Observation (2606.06708 — observation over-ingestion).

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
- Step identity: the pre-step payload carries `{ agent, messages, turn, step, signal, modelSelection }` (harness `core/agent/src/runtime-types.ts:350`). r2 verification note: grok's r1 claim that the payload has no `step` was checked against the runtime type — `step` is present; grok read a consumer's destructuring subset (`hooks-claude-code/src/register-events.ts:70`), which only picks fields. Dedupe window arithmetic uses **`payload.step`**.
- Defer queue (`agent.inject`) mechanics and the governor's defer/TTL contract come from doc 1.
- `advisor-watchdog` batches several notes per inject and already has its own producer-side `sessionCap: 24` **notes** (`advisor-watchdog/src/settings.ts:58,77`): units differ from this design's cap (injects), stated explicitly below.
- `mcpReadyNotice`/`one-shot-notice` latch before delivery; caps on lifecycle-adjacent kinds were removed from scope (above).

## Design

All code lives in `packages/context/input-budget` (doc 1's package): `dedupe.ts`, `caps.ts`, driven from `govern.ts`.

### Two-phase admission (fixes the r1 BLOCKER)

Naively recording "seen" at check time lets a suppressed message poison its own later admission (codex's BLOCKER): a dropped dedupe entry updates `lastStepSeen`; when the same message is re-offered from the governor's defer backlog, it suppresses *itself* although it never reached the model. The design is therefore two-phase inside `govern()`:

1. **Check phase (read-only)**: for each advisory message compute its key and test dedupe/cap eligibility against *committed* state (previous admissions).
2. **Budget trim** (doc 1) computes the final admitted set.
3. **Commit phase**: only after the final batch is decided, admitted entries update dedupe/cap state. Deferred entries **do not** update state (they were not admitted); when they later get admitted from the backlog, their key then commits normally. Deferred-entry identity is the original message — its key recomputes identically at re-offer time.

Observability: rows are emitted at check time with the eventual decision, marked by `applied`.

### Dedupe

Key: `${kind}:${sha256(canonicalText).slice(0,12)}` over concatenated text blocks, verbatim (no normalization v1).

State (per session): `Map<key, { lastAdmittedStep: number }>` — updated **only at commit**.

Rule: suppress when `lastAdmittedStep` exists and `step - lastAdmittedStep < dedupe-window-steps` (default **8**; strict `<`). Boundary worked examples pinned in tests: last admitted at step 3, window 8 → re-arrival at step 10 suppressed (7 < 8); step 11 admitted (8 ≮ 8). (r1 had `<=` which contradicted its own unit test — codex fold; the convention above is the one the tests pin.)

Applies to kinds: `advisor`, `retry-attendant`, `cc-shell-glue`, `compaction-micro`, `compaction-cost-gate` (explicit audit list; lifecycle kinds excluded per scope).

### Caps (session-level, admission-committed)

Same commit-at-admission state: `Map<kind, runningCount>` incremented only at commit.

| kind | default cap | unit (explicit) |
|---|---|---|
| `advisor` | 4 | injects (not notes; producer batches notes per inject and already enforces its own 24-note session cap — this cap is intentionally tighter, an outer floor) |
| `retry-attendant` | 8 | injects |
| `cc-shell-glue` | 4 | injects |

Overflow at check time: ineligible → message goes to governor trim (defer/expiry handled by doc 1), row emitted at commit with the final outcome. Kebab key names are pinned in schemastery (`retry-attendant`, not `retryAttendant`; grok fold).

Lifecycle kinds (`cc-subagent-children`, `subagent-settled`) and `compaction-micro`/`compaction-cost-gate` carry **no caps** (dedupe only for the latter two; lifecycle kinds excluded entirely).

### Mounting and independent flips (codex's four-combo requirement)

One physical pre-step listener (doc 1's) hosts three stages (dedupe, caps, budget). It mounts when **any** owning feature is enabled. Each stage has its own `enabled`/`mode`; stage states are independent; flipping a stage's mode resets only that stage's runtime state (dedupe map for dedupe, cap counters for caps, defer queue for budget — never the others'). Tests enumerate all enabled/disabled × observe/enforce combinations per stage.

### Observe mode (faithful would-have)

In observe mode the check/trim/commit pipeline runs identically, and **state advances as if the drops had happened** (simulated commits): a would-be-suppressed message updates the simulated state, so subsequent steps see the would-have world. The real batch is untouched. This is consistent with commit-on-admission because observe's simulated final batch *is* the "admission" being simulated (r2 resolution of grok-vs-codex's two directions; enforce defers have no observe analogue — dedupe/caps have no backlog, so no interference).

### Ledger rows (owned by doc 3's union; referenced)

`DedupeRow { applied, kind, hash12, suppressedWithin }` — `suppressedWithin` = steps between this message's suppression and its last admission (`step - lastAdmittedStep`). `CapRow { applied, kind, runningCount, suppressedTotal }` — `runningCount` = admissions for this kind in this session so far; `suppressedTotal` = cumulative suppressions for the kind. Observe rows carry `applied: false`.

### Settings — `cc-input-notice-governance` (kebab, user-layer, hot-read)

| key | type | default | bounds |
|---|---|---|---|
| `enabled` | bool | true | — |
| `mode` | `'observe'|'enforce'` | `'observe'` | — (flip resets this stage's state only) |
| `dedupe-window-steps` | int | 8 | 1..64 |
| `caps` | object | table above | values 0..64; kebab keys enforced |

Four-surface default discipline + "no settings file → observe runs" wiring test.

## Verification

- Unit: two-phase commit regression for the r1 BLOCKER (suppressed message deferred, re-offered later, admitted once distance ≥ window — never self-suppressing); window boundary examples above; LRU bound 512 entries/session; `session/disposed` cleanup; cap commit-on-admission (dropped messages don't consume cap); observe-state advances identically to enforce; four stage-combo mounting tests; boundary `step` provenance from `payload.step`.
- Integration: synthetic producers repeating one advisory text across 12 steps; enforce admits exactly one in the window; pipeline order dedupe→caps→trim pinned by a composed-order test.
- Live acceptance (observe, two weeks): repetition distributions per kind (steps denominator), then a sample audit before enforce: **all** suppressions if ≤ 100, else stratified sample of 100, with the acceptance criterion on self-inflicted valuable-loss stated as a one-sided 95% upper bound ≤ 5% (r1's "20 samples supports 1%" was statistically empty — codex fold: 0 losses in 20 samples only bounds ≤ ~14%).

## Risks

- A legitimately re-asserted notice within the window is suppressed and (as a durable inject) does not re-deliver — stated plainly, this is intentional irreversibility inside the window; observe-first ensures rates are measured before enforcement.
- Hash collisions at 12 hex chars over ≤ 512 entries: negligible; a collision suppresses one advisory message.
- Producer-side + systemic double suppression is a no-op in practice (latched producers never reach the gate); the integration test covers a latching producer explicitly.

## Fold ledger

r1 → r2 (critic GWC + grok GWC + codex NO-GO → folded): two-phase commit-on-admission fixes the self-suppression BLOCKER; dedupe/caps restricted to enumerated advisory kinds, lifecycle kinds excluded (`subagent-settled` established-wake risk; one-shot pre-latch silent-miss risk); window convention `delta < window`, counter = `payload.step` (grok's "no step in payload" claim verified false against `runtime-types.ts:350` — step is present; consumer subset annotations are the stale source); registry referenced from doc 1 r2 instead of restated (stale classes, `progress-brief`, memory class); mounting/stage-flip semantics for all four combos; DedupeRow/CapRow aligned to doc 3's union incl. `applied` and counter semantics; advisor inject-vs-note units and kebab pinning; observe-mode state advance defined as faithful would-have; audit sample size and confidence requirement specified.
