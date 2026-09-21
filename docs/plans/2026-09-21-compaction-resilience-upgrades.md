# Compaction Resilience: overflow classification, prompt-too-long ladder, post-compact read-state note

Date: 2026-09-21. Status: **Proposed**. Origin: ZCode design borrow analysis
(zai-org/ZCode @ 872ad960). Design-review record: first draft **amended** in cold review
— it mis-anchored the GLM empty-completion shape onto `EMPTY_RESPONSE` (it actually
surfaces as `max-tokens`), credited a wasted-retry cost that does not exist, and proposed
a free-standing log collector where a bridged hook point already exists. Corrected below. Round 3 (2026-09-21, cold re-review against HEAD f81883d + pinned
pi-ai 0.85.1): the classification premise was wrong in the other direction — pi-ai's
`isContextOverflow` Case 3 already maps the GLM length+empty shape to
`CONTEXT_WINDOW_EXCEEDED` whenever usage and contextWindow are reported, so piece 1
collapsed to a no-op plus a missing-usage residual branch, and piece 2's trigger was
re-anchored accordingly. Remaining load-bearing anchors retraced and hold.

## 1. Problem

Compaction has two silent failure taxes today:

1. **The compact request itself can overflow.** The summarizer sends a large slice of
   history; when the provider answers prompt-too-long — or, the GLM-shaped case, ends
   with `finish_reason=length` and *empty* text — there is no escalation ladder: the
   harness surfaces a hard summarizer error and the PR #81 circuit breaker is the only
   backstop.
2. **Post-compact amnesia about reads.** After compaction, the model's record of what it
   already read is gone, so the next edit either trips `FS_NOT_OBSERVED` or pays a
   redundant full re-read. ZCode re-injects that state; dsh-cc has no re-injection
   (the observation registry itself exists — see §2).

## 2. Current state (anchors re-verified)

**Harness side (read-only checkout):**

- `mapStopReason` (`packages/llm/llm-pi-ai/src/stream.ts:80-114`) runs pi-ai's
  `isContextOverflow(message, contextWindow)` **before** the stop-reason switch, and
  pinned pi-ai 0.85.1 Case 3 (`dist/utils/overflow.js:146-149`) already classifies
  `stopReason === 'length'` + zero output tokens + a ≥99%-filled window as overflow.
  So the GLM length+empty shape arrives as `{kind:'error', code:
  'CONTEXT_WINDOW_EXCEEDED'}`; it falls through to `max-tokens` at the `case
  'length'` line (stream.ts:109) only when usage or contextWindow is absent or the
  window is not ≥99% filled. `EMPTY_RESPONSE` fires only on `stop`+zero blocks
  (stream.ts:99-108).
- The compaction summarizer fail-closes it: `case 'max-tokens'` produces error code
  `MAX_TOKENS` (`packages/compaction/compaction-basic/src/summarizer.ts:203-207`).
- **No same-request retry exists for this class**: `MAX_TOKENS` and
  `CONTEXT_WINDOW_EXCEEDED` are both absent from the default retryable codes
  (`packages/llm/llm/src/retry-policy.ts:18-24`). So the actual cost today is not a
  wasted replayed request — it is a hard compact failure marching toward the failure
  cap (PR #81's microcompact/compaction failure-cap exists;
  `compaction-micro/tests/failure-cap.spec.ts`).
- Compaction packages `compaction-basic`, `command-compact`, and the generic compaction
  plugin live harness-side. A bounded overflow-recovery ladder exists but only on the
  **main** request path: `compaction-basic/src/index.ts:180-220` listens on
  `agent/request-error`, and on `CONTEXT_WINDOW_EXCEEDED` it compacts and retries up to
  `maxOverflowRetries` (counter reset on success; durable surface-progress proof) — it
  in fact *triggers* compaction. The summarizer's own one-shot `ctx.llm.stream()`
  (index.ts:~227) has no input-shrinking ladder: that is the actual gap, and the
  proposed ladder must compose with the existing one, since an overflow-triggered
  compact can itself overflow.

**dsh-cc side (this worktree):**

- Compaction packages: `compaction-basic-cc` (CC-parity prompt), `compaction-micro`
  (model-free stale-tool-result collapse, replay-safe, spill locators),
  `compaction-cost-gate`, `tool-use-summary`. Microcompact already exists — called out
  so the record does not list it as a gap.
- **The event seam for post-compact delivery already exists**: `compaction/end` is
  bridged to a `PostCompact` hook run point in
  `packages/hooks/hooks-claude-code/src/register-events.ts:266-273` — but the bridged
  call is detached and the hook's output is discarded into
  `turnSafety.detachedOutcome` (notices/logs only). The injection precedent exists one
  branch away: PreToolUse `additionalContext` is delivered via `exec.agent.inject`
  (register-events.ts:109-118).
- The read-side registry exists harness-side: `fs-observation-policy`'s
  `ObservedStateGate` (per-session WeakMap of observations; see the companion doc
  `2026-09-21-edit-fuzzy-matching-and-read-state.md`). A re-injection note can describe
  observation state without owning the registry.

**ZCode reference (cited from the borrow analysis; the ZCode checkout is not present in
this review environment, so these anchors are not re-verified here):** trigger policy, the prompt-too-long ladder (re-select with more
recent rounds preserved → hard-truncation of oldest rounds behind an explicit
`[earlier conversation truncated for compaction retry]` marker → error; max 3 attempts;
`packages/core/src/compact/compact-selection.ts`,
`packages/core/src/runtime/methods/compact-active.ts:288-303`), post-compact
re-injection (≤5 files, ≤5K tokens/file, ≤50K total;
`packages/core/src/runtime/helpers/compact-post-reminders.ts`), and the
`willRetriggerNextTurn` boundary flag.

## 3. Design

Three pieces, ordered by independence.

1. **Overflow classification — verified as already handled at the pinned pi-ai
   (residual branch only).** The check the first draft named as undecidable from these
   checkouts is now answered: pinned pi-ai 0.85.1's `isContextOverflow` Case 3
   (`dist/utils/overflow.js:146-149`) already reclassifies `length` + zero-output +
   ≥99%-filled window into `CONTEXT_WINDOW_EXCEEDED`, and the harness honors that
   verdict ahead of the stop-reason switch (stream.ts:81-95). The only residual branch
   is providers that omit usage or contextWindow — for those the shape still falls
   through to `max-tokens` (stream.ts:109), so the summarizer must treat **both** codes
   as ladder triggers instead of fail-closing either; no reclassification proposal is
   needed.
2. **Prompt-too-long ladder (harness proposal).** The summarizer's one-shot
   `ctx.llm.stream()` (compaction-basic `index.ts:~227`) gains a bounded retry ladder,
   triggered on `CONTEXT_WINDOW_EXCEEDED` from that call — plus, for the missing-usage
   residual branch of piece 1, the `length`-with-empty shape: (a) retry with more
   recent rounds preserved (fewer rounds summarized);
   (b) hard-truncate the oldest summarized rounds behind an explicit truncation marker;
   (c) surface as compact failure into the existing circuit breaker. Each rung is a
   deterministic transform of the request entries; no model involvement. This ladder is
   distinct from — and must compose with — the existing main-request overflow-retry
   ladder (`index.ts:180-220`), which reacts to the main request overflowing by
   triggering this very compaction: an overflow-triggered compact can itself overflow,
   which is exactly the gap. Attempts and
   rung reached become compaction telemetry fields so the cost gate
   (`compaction-cost-gate`) sees ladder retries instead of identical-looking failures.
3. **Post-compact read-state note (dsh-cc side, no harness change).** Extend the
   `PostCompact` branch in `hooks-claude-code/src/register-events.ts` (a dsh-cc file;
   the harness-untouchable directive is intact) to consume `additionalContext` from the
   hook's merged output and deliver it via agent injection — more work than mirroring
   the PreToolUse branch suggests, because the PostCompact payload carries only
   `(ctx, session)` (`payloads.ts:149`, `postCompactPayload(_ctx, session)`): there is
   no `exec.agent` in scope, so the agent handle must be resolved from the session
   (precedent: register-events.ts:223, `child.inject(context)` in the SubagentStop
   branch). And because the bridged call is detached (`detached.track`), the hook
   script's collect-and-inject run is async — its landing order relative to the next
   model request's assembly is not guaranteed and must be pinned by the replay test. The hook itself can be a plain configured script: at `compaction/end` the new
   boundary is already appended, so the v3 session log retains the pre-compact read
   events the script collects from (zstd read precedent:
   `packages/session/session-forensics/src/scan.ts:40-44`) — file path + last observed
   byte size + "state at compaction time; verify before editing if unsure", bounded at
   5 files / ~2K tokens, far under the ~13K auto-compact trigger buffer, so **no
   threshold-exclusion mechanism is needed**: the bound is the mitigation, pinned by a
   replay test. When the edit doc's Track A ships full-vs-partial granularity, this note
   upgrades to cite real observation state.
   - Cheapest delivery option: the extended PostCompact branch + a hook script under
     repo scripts — zero new packages.
   - YAGNI valve: if the edit doc's Track A is anywhere near landing, defer this piece
     and fold the re-injection into Track A's writer instead.

Explicitly not in scope: ZCode's threshold formula and 9-part summary prompt — dsh-cc's
formula and CC-parity prompt are deliberate poses, not gaps; `compaction-cost-gate` owns
compaction economics.

## 4. Expected effect

- Compact success on oversized histories stops depending on whether the first
  summarizer request fits: measurable as compact-failure events whose first attempt
  overflowed, per session-week.
- The GLM length+empty shape stops marching the compaction failure cap toward its
  circuit-breaker pause — it arrives as `CONTEXT_WINDOW_EXCEEDED` (pi-ai Case 3) and,
  with the ladder, gets shrinking summarizer retries instead of a hard failure (the
  cost is failure-cap pressure, not wasted retries — the first draft claimed the latter
  and review corrected it).
- Post-compact edits stop starting blind: measurable as the Read-call rate in the N
  turns following a compaction boundary; the note's size bound (≤2K) is pinned by the
  replay test.

## 5. Risks and open questions

- Ladder rungs shrink *what gets summarized*, trading summary fidelity for success; the
  truncation marker must survive into the summary message so later readers (and
  forensics) know earlier history was dropped, not summarized.
- Resolved at round 3: pinned pi-ai's `isContextOverflow` Case 3 *does* catch the GLM
  length+zero-output shape whenever usage and contextWindow are reported, so piece 1 is
  a no-op there. The residual risk is providers that omit usage/contextWindow (or
  report a <99%-filled window) under `length` — Case 3 misses and the shape falls
  through to `max-tokens`. No live GLM request has confirmed which case the deployed
  route hits; that branch stays a named summarizer trigger, not a reclassification
  proposal.
- v3 log retention of pre-boundary rows is implied by the append+replace-range seam
  (harness `packages/compaction/compaction/src/index.ts:162`); running the collector at
  `compaction/end` (before any pruning question exists) sidesteps the unverified-residue
  risk entirely.

## Acceptance (DoD)

- [ ] Ladder filed as a harness proposal triggered on `CONTEXT_WINDOW_EXCEEDED`
      returned by the summarizer's one-shot `ctx.llm.stream()` (pi-ai Case 3 verified;
      the missing-usage residual falling through to `max-tokens` named as the second
      trigger), with the ladder telemetry fields listed.
- [ ] PostCompact branch extended to deliver `additionalContext` via `agent.inject`;
      unit test asserts injection on hook output and output-free no-op; configured hook
      script collects from the log at `compaction/end` and stays inside the 2K budget
      (replay-pinned); capability manifest + `docs:parity` in the same commit.
- [ ] Landing order against the edit doc's Track A recorded here when known.
