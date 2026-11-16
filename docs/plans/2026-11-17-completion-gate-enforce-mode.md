# Completion gate enforce mode: unverified completion can only stall

Status: design v4 — r1 (three-lane) + r2 delta (three-lane, all
GO-WITH-CHANGES) folded; gate ledger (§6.1) and formal-design screening
record (§9) added. Ledger in §8.
Plan doc: this file. Implementation lands in the same PR (repo convention).
Baseline plan: docs/plans/2026-10-09-runtime-verified-completion.md (nudge
mode, shipped default-ON 2026-11-11).

## 1. Motivation and literature anchors

The shipped completion gate is **feedback-only**: at `agent/turn-stopping` it
injects at most `nudges-per-session` (default 1) evidence nudges, then the turn
ends with the unverified claim standing. Three independent results in the
wiki synthesis (agent-runtime-harness-systems) converge on the same finding:

- **WebFovea** (harness-only fixes, hidden-set 31.0→57.0): the interventions
  that worked were defensive executor primitives and executor-side budgets;
  feedback-only experiments failed to stop loops.
- **Goal-Autopilot**: `DONE` externalized into a durable gated FSM — a turn
  whose completion claim has not passed the gate can only emit `STALL`; "no
  false completion" becomes a runtime invariant instead of an advisory note.
- **Finding the Right Fit** (openJiuwen vs PI): bounded execution surfaces
  that convert failure into a usable signal beat unbounded advisory surfaces.

P0-1 upgrade: add an **enforce mode** to the completion gate. In enforce mode
a turn whose final assistant message still carries unmatched completion
claims cannot pass the gate silently: the gate keeps re-opening the turn
(same-turn inject) until either the claims are satisfied by receipts, the
model retracts the claims from its final message, or a per-window cycle
budget is exhausted — in which case the gate records a durable exhaustion
observation and, at actual turn end, a terminal unverified marker.

**Precise guarantee (narrowed per r1)**: enforce mode provides *bounded
enforcement of the existing execution-record heuristic* — subject to the same
evaluation fail-opens as nudge mode (§3.6), the same receipt-satisfaction
rule upgraded to require a successful execution (§3.4), and the shared
turn-ending seam where other listeners may also continue the turn (§3.7).
It is not a proof of correctness; it converts "silent fabricated completion"
into "recorded, bounded enforcement episode".

## 2. Verified seam mechanics (source-anchored, 2026-11-17)

- Harness agent loop `turn()` (harness agent.ts:327-430; the
  turn-stopping dispatch is at :395-399): while a turn is ending and the
  inbox is empty it dispatches `agent/turn-stopping` serially to ALL
  listeners; afterwards the loop rechecks `inbox.nextStep` — if ANY listener
  queued a next-step message the loop continues the SAME turn
  (`target = 'next-step'`); otherwise it breaks and the turn ends. There is
  no listener veto return value — **injection/steering IS the continuation
  primitive**, and the gate not injecting is necessary but NOT sufficient
  for the turn to end (§3.7 lists the co-owners).
- `agent.inject(input)` (harness agent.ts:187-189) = `send(input,
  'next-step', false)`. The shipped smoke spec pins same-turn continuation
  ("synchronous inject at turn-stopping continues the SAME turn",
  tests/smoke.spec.ts:81-115, including turn-number identity and one
  `turn/end`).
- `turn/end` is appended in the `finally` of `turn()` for EVERY exit path
  (harness agent.ts:419-425) — completed, error, aborted alike. This makes
  the session-event firehose a reliable terminal reconciliation point.
- Turn-stopping listener inventory (registration order in the cc preset —
  hooks-claude-code is mounted before completion-gate):
  - **hooks-claude-code A3 max-tokens continuation** uses `agent.steer`
    (`send(..., 'next-step', true)`, continuation.ts) — NOT inject — and
    skips Stop for that stopping event.
  - **hooks-claude-code Stop point** (register-events.ts:200-218): a denying
    Stop hook STEERS continuation (F1 cap 8, then `agent.cancel()` — an
    abort, not a clean end); notices are injected.
  - **vwa-evidence** (VWA preset only) synchronously injects its own nudge.
  - Read-only/detached: prompt-suggest (default off), memory-consolidation,
    advisor-watchdog, turn-rules (turn counter only), moa judge (capture
    only).
- Current nudge pipeline: packages/interaction/completion-gate/src/evaluate.ts
  `evaluateInner` — top-level-only, enabled, session, turn guard,
  `suppressedByOwnNudge`, window anchor (last GENUINE user message; gate
  nudges are `source.kind: 'completion-gate'` so they never anchor a
  window), compaction fail-open, composite fail-open, horizon rule, claim
  satisfiability union (window receipts + lineage lifts), nudge budget,
  per-claim NUDGE events, one joined synchronous inject.
- `receiptSatisfies` (claims.ts) matches tool id + scrubbed head and does
  NOT inspect `receipt.outcome` (r1 finding: a FAILED execution currently
  satisfies a claim).
- Settings raw path (settings.ts): `resolveSection` runs the whole section
  through the schemastery `SettingsObject` first and `parseSettings` catches
  any throw by returning ALL of `DEFAULT_GATE_SETTINGS` — a whole-section
  fallback (pinned by the `'bogus'` case in tests/ledger.spec.ts). Schemastery
  has no `z.enum`; const unions are the idiom.

## 3. Design

### 3.1 Settings (src/settings.ts)

Two new keys in the `cc-completion-gate` namespace:

- `/config` schema face (validation UX only):
  `mode: z.union([z.const('nudge'), z.const('enforce')]).default('nudge')`,
  `'enforce-max-cycles': z.number().min(1).max(10).default(3)`.
- **Raw read path — per-key resolution, no section-level fallback for the
  new keys** (r1 P0: whole-section fallback would let
  `{ enabled: false, mode: 'typo' }` re-enable the gate):
  - `mode`: `=== 'enforce' ? 'enforce' : 'nudge'` (anything else → nudge,
    never touching `enabled` or `nudges-per-session`).
  - `enforce-max-cycles`: finite number → `Math.trunc` then clamp to
    [1, 10]; anything else → 3.
  - `enabled` and `nudges-per-session` keep exactly today's resolution
    (`asInt` truncate, section-throw fallback unchanged for them).
- Implementation shape (r2: the raw path must NOT run the new keys through
  the throwing `SettingsObject`, or an invalid `mode` re-opens the r1
  section-clobber): the RAW read path validates ONLY the legacy keys
  (`{ enabled, 'nudges-per-session' }` — a picked legacy-only schema or
  the existing pass over a schema that does NOT contain the new keys),
  catching its throw locally to the legacy defaults; the two new keys are
  ALWAYS coerced per-key from the RAW section object, including on the
  legacy-throw path. The `/config` schema face (with the const union and
  min/max) is a separate object used ONLY for namespace registration.
  `DEFAULT_GATE_SETTINGS` gains `mode: 'nudge'` and
  `'enforce-max-cycles': 3`; the `tests/ledger.spec.ts` DEFAULT snapshot
  assertion is updated accordingly.
- **Default stays `nudge`** — byte-for-byte today's behavior; enforce is
  opt-in. Flipping the default is a deliberate follow-up after dogfood
  (ship-dark-then-flip precedent), NOT part of this change.
- Hot-toggle unchanged: raw file re-read per event; `mode` participates.

### 3.2 New session events (src/events.ts)

Two new event types, both registered into `KNOWN_SESSION_EVENT_TYPES` +
`SessionEventMap` (same live-Set idiom as the existing three;
sessions-written-with-these-events caveat is precedent-consistent):

```
export const EXHAUSTED_EVENT = 'completion-gate/enforce-exhausted'
// payload: { turn: number; claims: string[]; assistantTextHash: string }
export const UNVERIFIED_EVENT = 'completion-gate/unverified'
// payload: { turn: number; claims: string[]; assistantTextHash: string }
```

- **`enforce-exhausted` is an OBSERVATION**: "the gate exhausted its cycle
  budget for this turn" — appended at turn-stopping time (idempotent per
  turn: skip the append if an exhausted event with `data.turn === turn`
  already exists). It says NOTHING about whether the turn ended — other
  listeners may still continue the turn (§3.7).
- **`unverified` is the TERMINAL record**: "this turn ended with the gate
  exhausted AND the final assistant message still carrying unmatched
  claims". Appended ONLY by the turn/end reconciliation (§3.5), never at
  turn-stopping time. This resolves the r1 P0 "STALL recorded before the
  turn actually ends": if another listener (A3 steer, Stop deny, vwa nudge)
  continues the turn and the model then runs the evidence or retracts, the
  reconciliation finds no unmatched claims and NO terminal marker is
  written.
- NUDGE_EVENT payload gains optional `cycle?: number` (1-based enforce
  cycle). Optional — old persisted sessions stay valid.

### 3.3 Evaluate pipeline (src/evaluate.ts)

`evaluateInner` keeps the existing prefix (top-level, enabled, session,
turn guard, window anchor, fail-opens, horizon, unmatched computation)
shared by both modes, with these mode differences:

- `suppressedByOwnNudge` applies **only in nudge mode** (r1: in enforce
  mode the preceding gate nudge IS the loop; the cycle budget is the guard).
- **Enforce-mode satisfaction requires a successful execution** (r1
  finding: a failed run must not satisfy "tests passed"): before matching,
  drop receipts with `outcome !== 'ok'` from both the window receipts and
  the lineage lifts. **Lifts must carry the outcome** (r2 finding: today's
  `LiftEntry`/`ReceiptLiftInput` discard it, so the filter would silently
  reject ALL delegated evidence): add `outcome: 'ok' | 'error'` to both
  shapes, thread it from the receipt in `LineageRegistry.record`, and
  filter lifts by it in enforce matching. The horizon check keeps using the
  UNfiltered receipts (r2: it must not change). Nudge-mode matching is
  unchanged in this PR.

After `unmatched` is computed:

**nudge mode** — today's tail with one accounting change: the nudge budget
counts ONLY advisory nudges — NUDGE events WITHOUT a `cycle` field (r1
finding: enforce events must not consume the advisory budget). Everything
else (latch writes, inject text) unchanged.

**enforce mode** — the cycle state machine (replaces the nudge budget):

1. **Durable, window-scoped cycle count** (r1 P0: a per-turn key re-arms
   against the same window on plugin-origin turns; process-local maps are
   also resume-fragile). `spent = max(durableCycles, mirror)` where:
   - `durableCycles` = max numeric `cycle` over NUDGE events positioned
     AFTER the window start index (nudge-mode events without `cycle` do
     not count; 0 when none);
   - `mirror = deps.enforceMirror` — a process-local
     `Map<sessionId, { windowOrdinal: number; spent: number }>`: when
     `windowOrdinal === startOrdinal`, `mirror.spent` participates as the
     append-failure backstop (same role as the nudge latch); when the
     ordinal differs, the mirror resets to the durable count. One entry per
     session, allocated in `registerListeners` beside `latches`, never
     inside the handler. No turn-scoped keys, no colon parsing, no pruning
     protocol (r1 findings on key fragility/bounded memory all dissolve).
2. If `spent >= settings['enforce-max-cycles']`: BEFORE the append, record
   the exhaustion in a process-local set `deps.exhaustedTurns`
   (`Set<string>` of `${sessionId}:${turn}` — written unconditionally, it
   is the append-failure backstop the reconciliation reads, r2 finding) and
   set `lastInjectFailed: true` on the payload when the LAST inject of this
   window threw (r2: the record should not accuse a model that never saw
   the last-chance footer). Then try/catch-append ONE
   `completion-gate/enforce-exhausted` event `{ turn, claims: unmatched
   ids, assistantTextHash: digest16(judgedText), lastInjectFailed? }`
   (idempotence guard per §3.2; append failure → debug + warn log, still
   return stall — `exhaustedTurns` makes the reconciliation independent of
   the append, §3.5), do NOT inject, do NOT write the mirror, return
   `{ action: 'stall', claims }`.
3. Otherwise: `spent + 1` is this cycle. Write the mirror FIRST
   (`{ windowOrdinal: startOrdinal, spent: spent + 1 }`), then append
   per-claim NUDGE events each carrying `cycle: spent + 1` (append failure
   → debug; the mirror already advanced so a failing append cannot re-arm
   the loop), then inject ONE joined message. **Inject failure consumes the
   cycle** (r1 finding: a throwing inject must not create an unbounded
   loop) — try/catch-debug, outcome stays `nudge`.

The enforce inject text (single joined message, one line per claim):

```
Completion gate (enforced): you stated "<phrase>" but no successful executed
record of <claim.tool> exists since the last user message. Run it now, or
make your next final message NOT contain the phrase "<phrase>" (that is the
retraction). <footer> (completion-gate)
```

`footer`: `Gate cycles remaining: N.` normally; on the LAST inject
(`spent + 1 === max`, r2 wording — do not overstate the exit, other
listeners may still continue the turn): `Last chance: if the next judged
message still contains the claim, the gate will not inject again; the turn
records unverified when it actually ends.` The retraction contract
is deliberately LEXICAL (r1 finding: an apology that still contains the
phrase is NOT a retraction — the message says so explicitly; semantic
retraction detection is out of scope and documented in §3.6).

The two exits stay as designed: the next turn-stopping re-evaluates the NEW
final assistant message (`findJudgedMessage` takes the last for the turn);
phrase gone → `no-claim` skip; receipts in window → `satisfied` skip; in
both cases nobody injects and the turn ends (unless another listener
continues it, §3.7).

**EvalOutcome** becomes `{ action: 'nudge'; claims } | { action: 'skip';
reason } | { action: 'stall'; claims }` (claims = ids). **EvaluateDeps**
gains `enforceMirror: Map<string, { windowOrdinal: number; spent: number }>`
and `exhaustedTurns: Set<string>` (both allocated in `registerListeners`
beside `latches`, never inside a handler; `exhaustedTurns` entries are
deleted by the reconciliation once the turn is finalized — bounded).
Enforce mode NEVER writes `deps.latches` (hot-toggle nudge→enforce→nudge
must not be latch-starved — pinned by test).

### 3.4 Nudge/satisfaction semantics (enforce)

- Enforce-mode satisfaction requires `outcome === 'ok'` receipts (§3.3).
- Resolution telemetry (`maybeResolveOnReceipt`) keeps its existing
  session-wide "ever resolved" semantics (r1 finding noted the episode
  ambiguity; changing it is out of scope — enforce episodes correlate
  through the `cycle`-bearing NUDGE events, and this limitation is
  documented here).

### 3.5 Terminal reconciliation at `turn/end` (new listener in wiring.ts)

The existing `session/event` firehose listener (wiring.ts, currently
`lineage.witness`) is extended. On a `turn/end` event for a top-level
session, the handler (synchronous compute, deferred append):

0. **Abort check first** (r2: the turn-stopping payload's signal is ALSO
   threaded into the turn-stopping handler — skip everything, no inject,
   no exhausted append, when `signal.aborted`; memory-consolidation
   precedent index.ts:236. Cancellation precedence: user/hook cancel always
   wins).
1. **Exhaustion condition (append-failure independent, r2)**: the turn is
   exhausted iff an `enforce-exhausted` event with `data.turn === turn`
   exists OR `${sessionId}:${turn}` ∈ `deps.exhaustedTurns` OR
   (mode === 'enforce' at turn/end AND `spent >= enforce-max-cycles` per
   the same `max(durableCycles, mirror)` computation). This covers the
   exhausted-append failure (process-local set), the hot-toggle-off-after-
   exhaustion case (the durable event exists), and the mid-turn
   nudge→enforce toggle (no event, spent < max → not exhausted).
2. **Shared computation** (r2: no duplicated drift): extract a
   `computeUnmatched(session, turn, deps)` helper used by BOTH the live
   pipeline and this reconciliation — same window anchor, fail-opens
   (compaction/composite/horizon ⇒ no terminal marker), ok-outcome
   receipt/lift filter. Skip when `findJudgedMessage(...) < 0` (an
   error/abort turn that produced no assistant message gets no marker).
3. Exhausted AND unmatched non-empty AND no `unverified` event with
   `data.turn === turn` exists → append ONE
   `completion-gate/unverified { turn, claims, assistantTextHash,
   lastInjectFailed? }` — **deferred via `queueMicrotask`** (r2 P0: a
   synchronous `session.append` from inside a `session/event` observer
   throws the reentry guard during the publication window — the
   progress-rebuild ACK precedent defers exactly this way,
   packages/context/progress-rebuild/src/delivery.ts:171-195). The
   idempotence re-check (no existing `unverified` for this turn) re-runs
   INSIDE the microtask; the append failure there is the documented audit
   gap (§3.6).

This reconciliation covers the r1/r2 holes: premature marker (other
listeners continuing the turn), error/abort endings (turn/end fires on
every exit path), append failure at exhaustion (the process-local set +
recomputed spent), and cancellation (step 0). The firehose listener never
throws into the host (whole body try/catch-debug, same as
`lineage.witness`).

### 3.6 Fail-opens, limitations, honest invariant

- **Fail-opens (compaction, composite, horizon, not-top-level, turn-guard)
  keep their skip semantics in BOTH modes**: no injection, no loop, and no
  terminal marker. Rationale (adjudicated over r1's record-anyway
  alternative): a marker computed over a broken evidence view is worse than
  no marker — it would accuse on lost receipts. The §1 invariant is
  therefore stated narrowly: "cannot pass silently UNLESS a documented
  evaluation fail-open fires". Enforce-mode tests PIN the fail-open cases
  (compaction-in-window → no marker; horizon → no marker).
- **Lexical retraction only**: an apology restating the phrase is not a
  retraction; the inject text tells the model the exact lexical exit.
- **Resolution semantics**: session-wide "ever resolved" (unchanged).
- **Failed-execution receipts** do not satisfy claims in enforce mode.
- **Persisted-marker audit gap**: the terminal marker is lost only when the
  exhausted append fails AND the deferred unverified append fails (two
  failures) — or on the restart corner below.
- **Restart corner (r2)**: if per-cycle NUDGE appends failed AND the
  process restarts (mirror + exhaustedTurns lost), the durable cycle count
  is below max and the budget re-arms (bounded by the schema cap ≤10).
  Acknowledged, not mitigated.
- **Signal handling**: the turn-stopping handler threads and checks the
  dispatch `signal` — an aborted turn never receives a gate inject or an
  exhausted append (cancellation precedence over the gate, §3.7).
- **TUI rendering** of the markers is out of scope (session-stream only
  this PR; README states this).

### 3.7 Turn-ending co-owners (composition, r1 P0)

The gate not injecting is necessary, not sufficient, for the turn to end.
Co-owners that may continue the turn in the SAME serial dispatch:
A3 continuation (`steer`, capped), a denying Stop hook (`steer`, F1 cap 8,
then `cancel()` → aborted end; the reconciliation still fires on
`turn/end`), vwa-evidence inject (VWA preset), turn-rules reminders
(next-turn). Consequences, all accepted and bounded:
- After gate exhaustion, A3 may still steer a truncated claim-bearing
  message; the reconciliation judges whatever the turn finally ended on.
- A max-tokens stop may burn a gate cycle on a message the model never
  intended as final (truncation can split a claim phrase mid-sentence;
  `matchPhrases` may still match). Bounded by the cycle budget.
- Dual continuation (A3 steer + gate inject) in one pass is legal — the
  model sees both messages; ordering follows preset registration
  (hooks-claude-code before completion-gate).
- `agent.cancel()` from the stop-cap clears the inbox and aborts; the
  aborted turn still gets `turn/end` and the reconciliation still runs.

Cancellation precedence: user/hook cancel always wins over the gate. The
stop-cap `cancel()` runs INSIDE the serial dispatch (hooks-claude-code is
registered before completion-gate), so remaining listeners still execute —
the gate therefore checks `signal.aborted` first and skips (no inject, no
exhausted append; r2 finding: the current wiring drops the signal
entirely). The aborted turn still gets `turn/end` and the read-only
reconciliation still runs.

### 3.8 Loop-safety summary

- Same-turn enforcement is bounded by `enforce-max-cycles` (durable count +
  mirror; append-failure cannot re-arm while the process lives;
  inject-failure consumes the cycle; the restart corner is §3.6).
- Cross-turn: the budget is WINDOW-scoped (anchored to the last genuine
  user message), so plugin-origin turns (advisor inject, followup, stop
  notices) cannot re-arm a fresh budget against the same window — the
  durable count survives until a genuine user message advances the window
  (r1 P0 fix).
- Raising `enforce-max-cycles` mid-window simply allows more cycles against
  the same durable count — well-defined, no absorbing-state inconsistency
  (the exhausted event is an observation, not a latch).

## 4. File-by-file changes

| File | Change |
| --- | --- |
| `packages/interaction/completion-gate/src/settings.ts` | `mode` + `enforce-max-cycles`: schema face (const union + min/max), per-key raw resolution, DEFAULT_GATE_SETTINGS fields. |
| `packages/interaction/completion-gate/src/events.ts` | EXHAUSTED_EVENT + UNVERIFIED_EVENT (+ SessionEventMap, KNOWN_SESSION_EVENT_TYPES), `cycle?: number` on NUDGE payload. |
| `packages/interaction/completion-gate/src/evaluate.ts` | Mode branch: suppression bypass, ok-outcome receipt filter, window-scoped cycle machine, mirror-first ordering, enforce inject text, stall outcome, shared `computeUnmatched` helper, EvaluateDeps.enforceMirror + exhaustedTurns; nudge budget counts only non-cycle nudges. |
| `packages/interaction/completion-gate/src/lineage.ts` | Carry `outcome` through `ReceiptLiftInput`/`LiftEntry` (record + fixtures). |
| `packages/interaction/completion-gate/src/wiring.ts` | Allocate `enforceMirror` + `exhaustedTurns` beside `latches`; thread `signal` into the turn-stopping handler; extend the `session/event` firehose listener with the turn/end reconciliation (deferred `queueMicrotask` append). |
| `packages/interaction/completion-gate/src/index.ts` | Export the two new event constants; doc-comment update. |
| `packages/interaction/completion-gate/package.json` | Description mentions enforce mode. |
| `packages/interaction/completion-gate/README.md` + `README.zh.md` | Document mode, enforce-max-cycles, both markers (stream-only), the lexical retraction contract, and the fail-open list (bilingual pair; `pnpm check:readme --write`). |
| `packages/interaction/completion-gate/tests/evaluate.spec.ts` | Enforce-mode unit cases (§5). |
| `packages/interaction/completion-gate/tests/ledger.spec.ts` | DEFAULT snapshot update + settings per-key matrix. |
| `packages/interaction/completion-gate/tests/persistence.spec.ts` | Both new events round-trip; turn/end reconciliation cases. |
| `packages/interaction/completion-gate/tests/smoke.spec.ts` | Real-loop enforce liveness + same-turn inject. |
| `docs/claude-code-capabilities.yaml` | `engine.completion-gate` upstream summary / deviation text: opt-in enforce mode + the two markers. |
| generated parity artifacts (`docs/cc-parity-matrix.md`, README parity block, `docs/claude-code-capabilities.json` if regenerated) | Via `pnpm docs:parity` — generated, never hand-edited. |
| `docs/plans/2026-11-17-completion-gate-enforce-mode.md` | This doc; Status true-up at merge. |

Fixture updates: every `EvaluateDeps` construction in specs grows
`enforceMirror` (shared instance across re-dispatches within a test — a
fresh `deps()` per dispatch can never stall). No preset row changes, no
harness changes, no new dependencies.

## 5. Test plan (behavior → driving → pass criteria)

Unit (evaluate.spec, ledger.spec, persistence.spec) and real-loop (smoke.spec):

1. **Enforce first nudge**: unmatched claim, mode=enforce → outcome `nudge`,
   NUDGE events carry `cycle: 1`, one inject, mirror advanced.
2. **Re-open loop, shared mirror**: re-dispatch same turn after the model
   restated the claim → `nudge` with `cycle: 2` (mirror shared across
   dispatches).
3. **Exhaustion**: `enforce-max-cycles: 2`, third evaluation → outcome
   `stall`, NO inject, exactly ONE `enforce-exhausted` event; a fourth
   dispatch is idempotent (no second event, no inject, no mirror write).
4. **Retraction exit**: new final message drops the phrase → `skip`
   `no-claim`, no inject. **Apology-with-phrase**: new final message says
   "you're right, tests pass was unverified" (contains phrase) → `nudge`
   again (lexical contract).
5. **Evidence exit**: receipt `outcome: 'ok'` for the claim tool in-window
   → `skip` `satisfied`. **Failed execution**: same receipt with
   `outcome: 'error'` → still unmatched → `nudge`.
6. **Suppression matrix**: nudge mode skips on `suppressedByOwnNudge`;
   enforce mode does not (same fixture, only `mode` differs).
7. **Settings per-key matrix**: defaults (`nudge`, 3); `enforce-max-cycles`
   0→1, 99→10, 2.5→2, `'x'`→3; `mode: 'nope'`→`nudge`; **`{ enabled: false,
   mode: 'typo' }` → `enabled: false` preserved** (no section-level
   clobber); a section that throws in `SettingsObject` but carries raw
   `mode: 'enforce'` → mode honored per-key.
8. **Budget independence**: enforce nudges do not consume
   `nudges-per-session` (nudge-mode budget counts only non-cycle NUDGE
   events); `nudges-per-session: 0` + enforce still nudges; enforce writes
   no `latches`.
9. **Window-scoped cross-turn re-arm**: unmatched claim, turn 1 exhausts the
   budget, a PLUGIN-origin user message opens turn 2 (no genuine user
   message) → evaluation still sees the durable cycle count from the same
   window → stall immediately (no fresh budget). After a GENUINE user
   message (new window) → fresh budget.
10. **Mirror hygiene**: append-failure at nudge (mirror pre-advanced) →
    next dispatch does not re-inject for the same cycle; inject-failure
    (throwing `inject`) → cycle consumed, next dispatch advances.
11. **Reconciliation (turn/end)**: (a) exhausted + final message still
    unmatched → exactly ONE `unverified` event, appended via the DEFERRED
    microtask; (b) exhausted + another listener's continuation satisfied the
    claim → NO unverified event; (c) exhausted + retraction → NO unverified
    event; (d) not exhausted (spent < max, no event, no set entry) → no
    unverified even if unmatched; (e) compaction-in-window → no unverified
    (fail-open pinned); (f) reconciliation idempotent on duplicate turn/end
    replay; (g) **exhausted append THREW** (set entry present, mirror at
    max) → still exactly one `unverified` (second chance independent of
    the first append); (h) turn with no assistant message
    (`findJudgedMessage < 0`) → no marker.
12. **Co-owner composition (unit)**: cycles exhausted + a second listener
    injecting in the same dispatch → gate does not inject, outcome `stall`,
    no second exhausted event.
13. **Reentry (real-loop smoke)**: with the REAL session (not a fake), the
    `unverified` append fired from the turn/end reconciliation actually
    LANDS in the session event stream / JSONL (no reentry throw).
14. **Aborted signal**: turn-stopping dispatch with `signal.aborted` → no
    inject, no exhausted append, outcome skip.
15. **Failed lift**: child receipt with `outcome: 'error'` lifted into the
    root → claim still unmatched in enforce; `outcome: 'ok'` → satisfied.
16. **Real-loop liveness (smoke)**: mock model scripted to restate the
    claim on EVERY response, `enforce-max-cycles: 2` → the loop terminates:
    `agent.whenIdle()` resolves, exactly one `turn/end`, exactly one
    exhausted event and one unverified event, session reaches idle.
17. **Real-loop same-turn continuation**: enforce inject lands in the same
    turn-stopping dispatch (existing rig).
18. **Settings legacy-validator matrix**: the §3.1 cases plus
    `{ enabled: false, 'enforce-max-cycles': 0 }` → `enabled: false`
    preserved, cycles clamped to 1.

Nudge-mode behavior assertions stay stable; the DEFAULT snapshot assertion
in ledger.spec changes (new fields); all `deps()` fixtures grow a shared
`enforceMirror`.

## 6. Verification (PR body fields)

- **How driven**: unit tests (vitest, fake-ctx rig) + real-loop smoke
  (mock adapter) + settings raw-read tests.
- **Pass criteria**: all §5 cases green; existing suite green modulo the
  DEFAULT snapshot + fixture updates; `pnpm --filter @dsh-cc/completion-gate
  test` exit 0; full local battery (`tsc -b --force`, check:spec-deps,
  check:capabilities, check:parity, check:readme, check:size) green.
- **Follow-up (not this PR)**: dogfood `mode: 'enforce'` in the user-layer
  settings in a real session; then the default-flip decision.

### 6.1 Gate ledger (auditable dispositions)

**Required CI suite on PR #428 (run 43798139592 / 43798139598) — all pass.**
These five are the merge gate; each verdict below is the job's own:

| Check | Job | Verdict |
| --- | --- | --- |
| static-gates | 133071683732 | pass |
| quality-gates (contains `check:capabilities` + `check:parity`) | 133071683564 | pass |
| unit-tests | 133071683340 | pass |
| formal-design-tla+ | 133071685907 | pass (no model in scope — see §9) |
| formal-design-lean | 133071686131 | pass |

Local package battery: `pnpm --filter @dsh-cc/completion-gate test` → 11
files / 106 tests; `npx tsc -b tsconfig.packages.json --force` → exit 0;
`check:size`, `check:spec-deps`, `check:readme`, `check:capabilities`,
`docs:parity` green. `check:exports` was NOT run cleanly here: this worktree
has ~252 unrelated packages unbuilt, so the repo-wide scan is noisy —
completion-gate itself has no missing export target, and the CI
quality-gates job is the authoritative run for it.

**Advisory gate: VWA evidence (background reviewer; NOT part of the required
suite, does not gate merge).** Verdict for this PR: **not-applicable on
both files, with the reasons below** — reported as such, not folded into
the all-green table above.

| File | Coverage | Threshold | Disposition |
| --- | --- | --- | --- |
| `.scratch/pr-body-completion-gate-enforce.md` | 0.00 | 0.9 | **Resolved by removal.** A one-shot PR-body draft, never tracked by git; the shipped PR body is on GitHub and this doc is the argumentative artifact. Deleted during self-repair. |
| `docs/claude-code-capabilities.yaml` | 0.09 | 0.9 | **Not applicable — format mismatch.** This file's evidence system is its own structured form: `evidence: [{type: source\|test, path, anchor}]` per capability, validated by `check-capability-evidence.mjs` (I1–I11 + anchor resolution) and consumed by `generate-parity-matrix.mjs`. 〔src:ws:…〕 prose markers are not part of that format and would either be ignored or break the generator. The owning gate passed: `check:capabilities` in quality-gates job 133071683564, local run "capability manifest OK: docs/claude-code-capabilities.yaml". Note the gate reported `overall: pass` at both coverage values — coverage is a marker-density heuristic, so a non-paragraph file scores near zero by construction. |

Why this matters for later re-checks: a future audit that sees 0.00/0.09 on
these paths should read this table first; the low value is expected for a
data/format file and for a deleted scratch draft, not an unresolved defect.

## 7. Out of scope

TUI rendering of the markers; default flip to enforce; claim-table
expansion; semantic (non-lexical) retraction detection; episode-scoped
resolution semantics; tightening nudge-mode receipt satisfaction to ok-only;
hooks-claude-code Stop/A3 composition tests (they belong to that package's
suite — this PR only documents the composition contract).

## 8. Review ledger (three-lane blind, 2026-11-17)

- **r1 lanes**: `dsh-cc-agents:critic` GO-WITH-CHANGES (6×P1, 6×P2);
  cc-grok-bridge GO-WITH-CHANGES (3×P0, 8×P1, 3×P2, $1.19);
  cc-codex-bridge NO-GO (4×P0, 8×P1, 47.2k tokens).
- **Folded into v2** (cross-lane convergent): premature STALL marker →
  observation + turn/end terminal reconciliation (§3.2/§3.5, all three
  lanes); per-turn budget re-arms across plugin-origin turns → window-
  scoped durable count + mirror (§3.3.1, codex P0-2 + grok P0-1);
  inject/append failure paths → mirror-first ordering, inject-failure
  consumes cycle, reconciliation as second chance (§3.3, codex P0-3 +
  critic 1/8 + grok 7); settings whole-section fallback → per-key raw
  resolution + const union (§3.1, all three lanes); failed-execution
  receipts satisfy claims → ok-outcome filter in enforce (§3.3, critic 3);
  advisory-budget contamination → non-cycle-only counting + no latch writes
  (§3.3, codex 7 + grok 10); listener inventory wrong (A3 is steer not
  inject) → corrected inventory + co-owner section (§2/§3.7, grok 5/6 +
  critic 5); lexical-retraction brittleness → explicit lexical contract +
  apology test (§3.3, grok 8 + codex 10); file-table/test-plan gaps →
  expanded table + §5 matrix (codex 12 + grok 9 + critic 11); cycle-map
  fragility → dissolved by removing the map (grok 4 + codex 8 + critic 7);
  invariant overstated → narrowed §1 + pinned fail-open tests (codex 9 +
  critic 6).
- **Adjudicated over disagreement**: fail-open ⇒ no terminal marker (grok 5
  wanted record-anyway; codex/critic leaned document-only) — decided for
  no-marker on a broken evidence view, with the fail-opens pinned by tests
  (§3.6). Exhaustion is not an absorbing latch — budget compares against
  the live max over the durable count (§3.8) rather than codex 6's
  permanent-close alternative. Resolution telemetry stays session-wide
  (codex 11) — documented, unchanged.
- **Honest rejections**: v1's "existing suite unmodified" claim and
  "clamps via schema" claim were both wrong (grok 9, codex 4) and are
  withdrawn in v2.

### r2 (delta, all three lanes GO-WITH-CHANGES)

- **critic** GWC (2×P1, 3×P2); **grok** GWC (2×P0, 3×P1, 2×P2, $1.69);
  **codex** GWC (3×P1, 63.4k tokens).
- **Folded into v3**: session-append reentry guard inside the `session/event`
  publication window → deferred `queueMicrotask` append + re-check inside
  the microtask + real-loop reentry smoke (grok P0-1 + critic P1-1,
  progress-rebuild precedent); reconciliation gated on the exhausted event
  whose failure it must recover from → process-local `exhaustedTurns` set +
  recomputed `spent >= max` OR-condition (grok P0-2 + codex P1-1 + critic
  P2-3); `LiftEntry` lacks `outcome` → thread it through lineage.ts
  (all three lanes); legacy-only raw validator separated from the /config
  schema (grok P1-3 + codex P1-3); signal dropped by the current wiring →
  thread + abort check (grok P1-5); last-chance footer wording (grok P2-6);
  shared `computeUnmatched` + `judgedIdx < 0` skip (grok P2-7);
  `lastInjectFailed` payload flag (critic P2-4); restart+append-failure
  corner documented (critic P2-5).
- **Verified before folding** (orchestrator, source-level): progress-rebuild
  delivery.ts queueMicrotask precedent for the same seam; lineage.ts
  LiftEntry/ReceiptLiftInput shapes; wiring.ts:202 drops the signal;
  grok's Session.commit reentry-guard line anchors were read in the harness
  clone (session/src/index.ts publication window).

## 9. Formal design (screening record, 2026-11-17)

**Adoption status — read this first.** AGENTS.md and CLAUDE.md carry no
formal-design screening clause (grep: 0 hits), so this screening is
**session-level adoption**, not a project rule; the adoption snippet lives
at `<formal-design skill>/references/agents-snippet.md`. No repo review
roster is implied by this record.

```yaml
mode: auto
decision: not-needed
triggerIds: []          # no full trigger; see the weak-hit analysis below
backends: []
modelDirs: []
userDirective: >-
  Asked whether this feature's design needs formal-design modeling; answered
  and recorded here rather than modeling.
```

**Scope screened**: the enforce-mode state machine as specified in §3 —
window-scoped cycle budget, the two markers, the `turn/end` reconciliation,
the mirror/durable accounting, and the settings resolution.

| Trigger | Hit | Analysis |
| --- | --- | --- |
| FD-T1 independent actors + shared-state ordering | **no** | Every participant (agent loop, the serial `agent/turn-stopping` dispatch, A3/Stop/vwa co-owners, reconciliation, the deferred microtask append) runs in one single-threaded process. Ordering is fixed by serial dispatch + FIFO microtasks. There is exactly one writer to the cycle accounting. Contrast the compaction-pin-restore model, which exists because the engine and a plugin are two writers over one surface. |
| FD-T2 retries / duplicates / late messages | **weak** | Real instances exist — duplicate `turn/end` replay, failed-append re-dispatch, mid-turn hot-toggle, mirror vs durable divergence. All are closed by two constructive devices (idempotence guards, `max(durable, mirror)`), and are pinned by the §5 reconciliation a–i matrix, mirror hygiene, and the real-JSONL reentry smoke. No unenumerated interleaving space is left for TLC to find. |
| FD-T3 crash recovery (ownership/dedup/persistence order) | **weak, bounded** | The one crash window is documented in §3.6: a restart loses the mirror, so a prior failed NUDGE append can re-arm the budget (bounded by the schema cap ≤ 10) and the terminal marker can be missing. The failure direction is fail-open, and the consequence is one missing audit row — not a correctness inversion like pin-restore's phantom restore. |
| FD-T4 authorization / lease / ownership | **no** | — |
| FD-L1 policy/eligibility composition with a stated invariant | **no** | Per-key setting resolution is validation, not authorization composition; a bad value falls to a default (fail-soft) and cannot change what is permitted. |
| FD-L2 budget/accounting arithmetic with a stated bound | **weak** | `enforce-max-cycles` is literally a bounded budget, but the arithmetic is three constructive invariants (`spent = max(durable, mirror)`; compare-then-inject; mirror-before-inject) whose complete decision procedure is an exhaustive unit matrix — the same shape that justified `not-needed` for selective-system-prompt-sections (a stateless total function), not the cross-step queue state that made the input-admission model necessary. |

**Decision: `not-needed` for this PR** (enforce is opt-in; the default
`mode: 'nudge'` behavior is unchanged). Grounds:

1. **No modelable concurrency surface** — single-threaded serial dispatch
   removes FD-T1, the heaviest trigger.
2. **The load-bearing property (termination) already has two empirical
   layers**: the real-loop liveness smoke (a mock model restating the claim
   forever terminates with exactly one marker pair) and the 18-case §5
   matrix. A model would not add evidence beyond them at this shape.
3. **Proportionality** — compare the SystemOne program: a pure threshold
   policy (S1-09) was `not-needed` while four gates sharing one cache+
   coalesce protocol were merged into a single model. This machine sits
   closer to S1-09 in complexity.

**Re-screening triggers (this decision is scoped, not permanent)**:

- **Flipping the default to `enforce`.** The machine then runs in every
  session instead of only opted-in ones, converting the weak T2/T3 hits
  from "observable during dogfood" to "production-constant". At that point
  model the three properties that matter for the flip — bounded injection
  per window, at-most-once marker pair per turn, no phantom terminal marker
  without exhaustion — before shipping the flip.
- Any change introducing a **second writer** to the cycle accounting or the
  markers (another plugin appending `cycle`-bearing nudges, a cross-process
  or cross-session budget), which would activate FD-T1.
- Any change to the **persistence order** (e.g. moving the terminal marker
  out of the reconciliation, or making the exhausted event authoritative
  again), which would activate FD-T3.

No model was created, and this record claims no verification.
