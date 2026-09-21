# Compaction Resilience: overflow classification, prompt-too-long ladder, post-compact read-state note

Date: 2026-09-21. Status: **Proposed**. Origin: ZCode design borrow analysis
(zai-org/ZCode @ 872ad960). Design-review record: first draft **amended** in cold review
— it mis-anchored the GLM empty-completion shape onto `EMPTY_RESPONSE` (it actually
surfaces as `max-tokens`), credited a wasted-retry cost that does not exist, and proposed
a free-standing log collector where a bridged hook point already exists. Corrected below;
anchors re-verified 2026-09-21.

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

- `finish_reason=length` maps unconditionally to `{kind:'max-tokens'}`
  (`packages/llm/llm-pi-ai/src/stream.ts:109`); `EMPTY_RESPONSE` fires only on
  `stop`+zero blocks (stream.ts, ~100-107). The GLM length+empty shape therefore
  arrives as `max-tokens`.
- The compaction summarizer fail-closes it: `case 'max-tokens'` produces error code
  `MAX_TOKENS` (`packages/compaction/compaction-basic/src/summarizer.ts:203-207`).
- **No same-request retry exists for this class**: `MAX_TOKENS` and
  `CONTEXT_WINDOW_EXCEEDED` are both absent from the default retryable codes
  (`packages/llm/llm/src/retry-policy.ts:12-19`). So the actual cost today is not a
  wasted replayed request — it is a hard compact failure marching toward the failure
  cap (PR #81's microcompact/compaction failure-cap exists;
  `compaction-micro/tests/failure-cap.spec.ts`).
- Compaction packages `compaction-basic`, `command-compact`, and the generic compaction
  plugin live harness-side. No prompt-too-long escalation ladder located in any of them.

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

**ZCode reference:** trigger policy, the prompt-too-long ladder (re-select with more
recent rounds preserved → hard-truncation of oldest rounds behind an explicit
`[earlier conversation truncated for compaction retry]` marker → error; max 3 attempts;
`packages/core/src/compact/compact-selection.ts`,
`packages/core/src/runtime/methods/compact-active.ts:288-303`), post-compact
re-injection (≤5 files, ≤5K tokens/file, ≤50K total;
`packages/core/src/runtime/helpers/compact-post-reminders.ts`), and the
`willRetriggerNextTurn` boundary flag.

## 3. Design

Three pieces, ordered by independence.

1. **Overflow classification (harness proposal, small).** In pi-ai's stop-reason
   mapping, zero-content + `length` is reclassified into the context-overflow family
   instead of unconditional `max-tokens` — *provided* pi-ai's own `isContextOverflow`
   does not already catch the GLM shape (that boundary is not visible from either
   checkout; the proposal names the check explicitly). Downstream, the summarizer maps
   overflow to the ladder below instead of fail-closing.
2. **Prompt-too-long ladder (harness proposal).** The compact method gains a bounded
   retry ladder: (a) retry with more recent rounds preserved (fewer rounds summarized);
   (b) hard-truncate the oldest summarized rounds behind an explicit truncation marker;
   (c) surface as compact failure into the existing circuit breaker. Each rung is a
   deterministic transform of the request entries; no model involvement. Attempts and
   rung reached become compaction telemetry fields so the cost gate
   (`compaction-cost-gate`) sees ladder retries instead of identical-looking failures.
3. **Post-compact read-state note (dsh-cc side, no harness change).** Extend the
   `PostCompact` branch in `hooks-claude-code/src/register-events.ts` (a dsh-cc file;
   the harness-untouchable directive is intact) to consume `additionalContext` from the
   hook's merged output and deliver it via `exec.agent.inject`, mirroring the PreToolUse
   branch. The hook itself can be a plain configured script: at `compaction/end` the new
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
  circuit-breaker pause (the cost is failure-cap pressure, not wasted retries — the
  first draft claimed the latter and review corrected it).
- Post-compact edits stop starting blind: measurable as the Read-call rate in the N
  turns following a compaction boundary; the note's size bound (≤2K) is pinned by the
  replay test.

## 5. Risks and open questions

- Ladder rungs shrink *what gets summarized*, trading summary fidelity for success; the
  truncation marker must survive into the summary message so later readers (and
  forensics) know earlier history was dropped, not summarized.
- Whether pi-ai's `isContextOverflow` already catches the GLM shape decides if piece 1
  is a branch or a no-op — named as the proposal's first check.
- v3 log retention of pre-boundary rows is implied by the append+replace-range seam
  (harness `packages/compaction/compaction/src/index.ts:162`); running the collector at
  `compaction/end` (before any pruning question exists) sidesteps the unverified-residue
  risk entirely.

## Acceptance (DoD)

- [ ] Classification + ladder filed as one harness proposal with the
      `mapStopReason`-`length` anchor and the ladder telemetry fields listed.
- [ ] PostCompact branch extended to deliver `additionalContext` via `agent.inject`;
      unit test asserts injection on hook output and output-free no-op; configured hook
      script collects from the log at `compaction/end` and stays inside the 2K budget
      (replay-pinned); capability manifest + `docs:parity` in the same commit.
- [ ] Landing order against the edit doc's Track A recorded here when known.
