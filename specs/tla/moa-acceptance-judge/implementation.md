# Implementation record: moa-acceptance-judge

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final run

- runId: `20261103T053819Z-4d003adc-ed07-4d14-afd3-b5d3181bfd29` (r3 fold rerun) (review-fold rerun)
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4, darwin.
- convention (core): **verified** — 5,258 states generated, 717 distinct, 0 left on queue; all 8 invariants hold (`TypeOK`, `NoFaults`, `OneRequestPerStop`,
  `CompletedStaysSettled`, `ToolTurnNeverActed`, `NoRacedPlaceholder`,
  `NoStaleFinallyDelete`, `ShadowSuppressesLegacy`).
- Probes (expansion, expected counterexample; each hit exactly its intended
  invariant):
  - `strict-wrong-token-finally` → `NoStaleFinallyDelete`: an old
    `finally` deletes a newer placeholder.
  - `strict-redispatch-completed` → `OneRequestPerStop`: a completed stop
    judged again.
  - `strict-mode-switch-race` → `NoRacedPlaceholder`: a new placeholder
    starts while the cancelled old one is still in flight.
  - `strict-tool-turn-escalates` → `ToolTurnNeverActed`: a tool-using turn
    escalates.
  - `strict-legacy-under-shadow` → `ShadowSuppressesLegacy`: the legacy judge
    dispatches in the same round while dimensions shadow is on.
- `check-evidence`: valid and fresh; aggregate `counterexample` is the
  expected legal form for a probe package.

## Counterexample classification

All development failures were **modeling defects**, never design defects:

1. The first `OneRequestPerStop` counterexample revealed that
   `JudgeDispatch` lacked the design's own rule "a new generation may start
   only after the old placeholder settles" (`pTok = 0`) and the completed
   check. The design text already states both; the model had to catch up.
2. The mode-switch cancel was initially modeled as synchronous (clearing
   the placeholder immediately), which made the race probe unreachable and
   the settle-after-cancel path unmodeled. Reworked: the cancel leaves the
   placeholder in flight; the late settlement is `JudgeSettle` (which keeps
   `cancelled` set; only a new stop with no in-flight placeholder clears it), and the race probe dispatches while the cancelled
   old placeholder is still in flight.
3. A state-space explosion (34M distinct states, timeout) traced to
   `Escalate` being re-fireable on the same completed stop. The design
   bounds escalation to once per stop; adding that guard shrank the space
   to 133 distinct states.

## Verified scope and mapping

- Model ↔ design: `docs/plans/2026-11-02-systemone-10-moa-acceptance.md` —
  the lifecycle paragraph (WeakMap placeholder with token guard, completed
  LRU, repeated stops issue zero requests, mode-switch cancellation, the
  finally guard) and the modes table (tool-using turns are observe-only in
  every mode). The dimensions-shadow precedence is covered by
  `moa-cascade-routing`'s `ShadowInert`; the escalation ladder stays in
  that model's domain (see the deviation note in design.md).
- Property → clause: `OneRequestPerStop` ← "a repeated stop hitting
  inFlight/completed issues zero requests"; `CompletedStaysSettled` ←
  "mark completed whether answered or unavailable, so the same stop does
  not self-retry"; `NoStaleFinallyDelete` ← "the `finally` block deletes
  the placeholder only when the map's token equals its own token";
  `NoRacedPlaceholder` ← "a new generation may start only after the old
  placeholder settles"; `ToolTurnNeverActed` ← the observe-only row.
- Action → planned code: `StopArrive`/`StopArriveCompleted` ↔ the judge
  listener's stop handling; `JudgeDispatch`/`JudgeSettle` ↔ the detached
  dispatch and placeholder bookkeeping in `acceptance-dimensions.ts`;
  `ModeSwitchCancel`/`StaleFinally` ↔ the controller cancellation and the
  `finally` token comparison; `Escalate` ↔ the gated `agent.followup` call.

## Not verified (explicitly out of scope)

- The three noul dimensions' thresholds, reasons order and equality-boundary
  behaviour (pure policy, pinned by unit tests per the design's test matrix).
- The escalation ladder, floor/count recovery and `isStale`/`isEscalatable`
  re-checks (`moa-cascade-routing` owns that domain).
- The completed LRU's 16-entry cap and the full key formula (modeled as the
  stop key presence bit).
- Receipt-view construction (the `acceptance-receipts.ts` adapter) and
  its 20-call/200-byte bounds.
- Liveness: a cancelled placeholder whose settlement never arrives is a
  legal state (the real system has network timeouts out of model scope).

## Review fold (three-seat impl-readiness review)

- The late settlement keeps `cancelled` (only a new stop clears it), and
  `resultOk` marks answers that were genuine verdicts of non-cancelled
  requests: an unavailable or cancelled settlement completes the key (no
  self-retry) but never becomes actionable — `Escalate` requires
  `stop \in resultOk`.
- The dimensions-shadow precedence is pinned here (critic finding: the
  cross-model coverage claim was false): `DimsShadowOn`/`LegacyJudgeDispatch`
  carry `dimsShadow => ~legacyDispatched` (`ShadowSuppressesLegacy`), with
  the `strict-legacy-under-shadow` probe. Shadow engages only at a round
  boundary (before any legacy dispatch), matching the design's per-round
  precedence.
- `ToolTurnNeverActed` is now per-round (`actedThisTurn` ghost reset on
  every stop arrival) instead of conflating a key's escalation history
  across rounds.

## r3 fold (r2 delta review)

- `StopArrive` no longer clears `cancelled` while a placeholder is in
  flight (`pTok # 0`): the cancellation belongs to that generation and a
  repeated stop cannot resurrect it. The `strict-cancel-resurrect` probe
  injects exactly that bug and hits `NoCancelResurrect`.

