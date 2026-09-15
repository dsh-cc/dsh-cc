# Error-Recovery Parity: Error-Path Stop Semantics, Error-Streak Surfacing, Max-Tokens Continuation, Microcompact Failure Cap, Forensics Calibration

Date: 2026-09-15. Status: implemented (critique-approved plan, TDD executor
batch, orchestrator-verified). Origin: design comparison against Claude
Code's error-recovery model — "errors stay hidden until recovery is
exhausted; recovery loops are capped; API errors never feed back into hooks".

## 1. Verified ground facts (this worktree, 2026-09-15)

Harness facts (vendored `@deepseek-ai/dsh-agent-loop/src/agent.ts`, read-only
per the harness-repo-readonly directive):

- `agent/turn-stopping` is dispatched ONLY on the non-throwing turn path
  (`agent.ts:316`, inside the `try`). The error path
  (`catch` → `throwError` → emit `agent/error` → rethrow, `agent.ts:217-222,
  328-336`) never reaches that dispatch. Consequence: the blocking **Stop hook
  already never runs on API-error-ending turns** — CC's "StopFailure runs
  instead of Stop" semantics (code.claude.com/docs/en/hooks, retrieved
  2026-09-15) hold today. `agent/turn-stopping` fires for `completed` and
  `max-tokens` endings only (not `error`, not `aborted`).
- Reaching the model's output ceiling is NOT an error: the loop records a
  STICKY `turn/end` reason `{kind:'max-tokens'}` (`agent.ts:303-310`) — it
  survives even when the resumed step later completes normally, so the turn
  reason alone cannot tell "hit the ceiling now" from "hit it earlier this
  turn and recovered". No `agent/error` fires for it. The `max_output_tokens`
  branch in `payloads.ts:stopFailureErrorCode` classifies provider-PUSHED API
  errors (e.g. context-length 400s) — a different event that continuation must
  NOT react to. The recovery signal is the LAST assistant attempt's compact
  stream: the attempt ends with a terminal finish frame
  (`{type:'finish', reason:{kind:'max-tokens'}}`, mirrored by
  `@dsh-cc/agent-loop-mock`'s `maxTokensResponse`,
  `agent-loop-mock/src/index.ts:20-27`).
- `turn/end` persists structured reasons in the transcript:
  `{kind:'completed'|'max-tokens'|'aborted'|'error', error?: LlmError.failure
  | {message, code:'UNKNOWN'}}` (`agent.ts:328-343`). This is the forensics
  signal.
- Retry classification (retryable sets, LlmError facts) lives harness-side
  (`dsh-llm/src/error.ts`) — no dsh-cc LLM retry loop exists or may be added.
- On `agent/error` the agent is already idle: `kick()` catches at the driver
  boundary (`agent.ts:225-240`). There is nothing in flight to cancel.
- Continuation seam available dsh-cc-side: `agent.steer(...)` during
  `turn-stopping` splices the next-step inbox (`agent.ts:142`,
  `send(input,'next-step',true)`); the loop re-checks
  `inbox.nextStep.length === 0` AFTER the dispatch returns (`agent.ts:319`), so
  a steered continuation runs as a next step INSIDE THE SAME TURN — no new
  `turn/end`, no new turn number (verified statically; followup/plugin-driven
  turns share the mechanics).

dsh-cc facts: `hooks.stop` is manifest `behavioral: full, ux: full`; StopFailure
is a dsh-side observe-only extension (detached, cannot recurse); microcompact
failure is warn-only "continue the turn" with no cap
(`packages/compaction/compaction-micro/src/index.ts:136`); forensics captures
tool/approval records only, no turn outcomes
(`packages/session/session-forensics/src/scan.ts`).

## 2. Change A — packages/hooks/hooks-claude-code (one executor, TDD)

### A1. Stop-on-error parity lock (test-only; no production change expected)

Lock the verified harness property with regression tests so a future harness
upgrade that starts dispatching `turn-stopping` on error turns fails loudly
here instead of silently re-introducing the death-spiral vector.

New file `tests/error-recovery.spec.ts` (template: `tests/safety-loop.spec.ts`
— real `AgentLoop` + `MockAdapter` + the real bridge, only the model mocked):

1. Turn ending with an LLM error (scripted adapter failure): the Stop hook
   executable is NEVER invoked; the StopFailure hook executable IS invoked
   exactly once with the classified `error_code`.
2. Turn completing normally: Stop fires (today's behavior, guarded).
3. Aborted turn: no Stop.

Contingency (only if test 1 fails, i.e. the static reading is wrong on some
path): implement the guard — per-agent errored-turn numbers recorded in the
`agent/error` listener (`error` carries `{agent, turn, step, error}`), checked
and consumed in the `turn-stopping` listener by comparing `turn`; skip the
Stop runPoint + `onStopDeny` on match; cleared on consume / real user prompt /
`releaseSession`. Do NOT write the guard speculatively (coverage budget:
untestable branches fail v8).

### A2. Agent-error streak surfacing (notice-level breaker)

Rationale for notice-only: at `agent/error` the agent is idle (nothing to
cancel), and request retry is harness-owned. dsh-cc's added value is detecting
the burn pattern and telling the user + forensics, aligned with CC's observed
threshold semantics (3 consecutive / 20 cumulative) without hostile prompt
rejection.

New module `src/error-streak.ts` (register-events.ts is at 302 lines and
turn-safety.ts at 172; both stay under the 500-line source budget — keep state
out of them):

- `createErrorStreak(deps)` returns `{ onError(agent, error),
  onTurnSettled(agent, turn), onUserPrompt(agent), releaseSession(sessionId) }`.
- Per-agent state `{ consecutive, total, trippedConsecutive, trippedTotal }`
  keyed by `agent.id`, plus the F1-style `agent→session` pairing so
  `releaseSession` frees exactly this session's entries.
- `onError`: `consecutive++`, `total++`. When `consecutive` reaches the
  consecutive cap (default 3, env `CLAUDE_CODE_AGENT_ERROR_CONSECUTIVE_CAP`,
  positive-int parse, garbage→default, `resolveStopBlockCap` pattern) and not
  yet tripped: trip once. Same for `total` vs total cap (default 20, env
  `CLAUDE_CODE_AGENT_ERROR_TOTAL_CAP`).
- Trip action: `ctx.logger.warn` + `recordIssue?.({ kind: 'error-streak',
  ... })` — FIRST check whether `HookIssue.kind` in `@dsh-cc/hook-protocol` is
  an open string or a closed union; if closed and the package is versioned,
  DROP the recordIssue call (logger + notice already carry the signal) rather
  than churning the protocol package for a notice-level path — plus a durable
  user notice through the
  existing F3 seam: `turnSafety.surfaceNotices('ErrorStreak',
  { systemMessages: [text] }, agent)`. Text pattern: `"<n> consecutive API
  errors this session (last classified: <code>); request retry is owned by the
  harness — check provider status or switch model"`.
- `consecutive` resets in `onUserPrompt` (called from the existing
  `agent/pre-step` listener at the F1 `resetBlocks` position, only for
  `source.kind === 'user'`) and in `onTurnSettled` — which the `turn-stopping`
  listener calls on EVERY stopping event (per stopping, NOT per turn: under A3
  the listener can fire several times within one turn). A stopping event only
  exists for non-error endings (ground fact §1), so every call resets
  `consecutive`. `total` and both trip latches reset only via
  `releaseSession`.
- Divergence to record in the manifest entry: streaks are per-`agent.id`
  (a failing subagent child accumulates its own count independently of the
  parent); CC's caps are session-wide.
- Wiring: `registerEvents` gains the streak object in `ListenerDeps`; the
  existing `agent/error` listener calls `onError` BEFORE dispatching the
  detached StopFailure.

Tests (same spec file): consecutive trip at 3 with one-shot semantics (4th
error does not re-notice); interleaved successful turn resets consecutive;
cumulative trip at 20 across reset streaks; env override honored;
`releaseSession` frees state (re-trip possible in a later session);
StopFailure dispatch is unaffected.

### A3. Max-tokens continuation (CC-worded meta resume)

CC behavior (documented + user brief): on output-token-limit, CC resumes
mid-thought with a meta continuation message, max 3 continuations;
uninterrupted recovery is invisible to the user.

dsh-cc realization at the `turn-stopping` seam (the only place a continuation
can be injected; F1-proven; continuations run as next steps INSIDE the same
turn — see ground facts):

- Helper `lastAttemptHitCeiling(agent)`: find the LAST assistant attempt in
  `agent.session.snapshotEvents()` (the `assistant/attempt`/`assistant/message`
  compact `stream` records end with a terminal finish frame; the mock
  equivalent is `maxTokensResponse`'s
  `{type:'finish', reason:{kind:'max-tokens'}}`,
  `agent-loop-mock/src/index.ts:20-27`) and report whether its terminal finish
  is `max-tokens`. Executor A: spend a 5-minute shape check on the serialized
  `stream` records BEFORE writing the first test; if the compact-stream shape
  proves unusable, the sanctioned fallback is: record the last
  assistant-attempt seq at steer time and require a NEW max-tokens-bearing
  attempt after it before steering again (never steer twice off the same
  attempt). Do NOT gate on `turn/end`'s reason — it is sticky and stays
  `max-tokens` even after the resumed step completes normally, which would
  burn the whole cap and skip Stop up to 3 times per truncation.
- In the `turn-stopping` listener, BEFORE the Stop runPoint: if
  `lastAttemptHitCeiling(agent)` and the chain count for THIS turn < cap
  (default 3, env `CLAUDE_CODE_OUTPUT_TOKEN_CONTINUATION_CAP`, integer
  `>= 0` wins — `0` DISABLES the feature — garbage/absent → default):
  - `agent.steer(createUserMessage({ content: [{type:'text', text: CONTINUATION_TEXT}], source: PLUGIN_SOURCE }))`
    with EXACT text `Output token limit hit. Resume directly — no apology, no
    recap. Pick up mid-thought.` (CC parity wording; deliberately NOT
    configurable),
  - increment the chain counter,
  - SKIP the Stop runPoint and `onStopDeny` for this stopping event (the turn
    is not logically ending — CC never runs Stop mid-recovery; running it
    would double-steer against the continuation). Divergence to document
    (manifest + Stop-hook README section): user-configured blocking Stop
    hooks lose their veto window during output-ceiling recovery,
  - `ctx.logger.info` the continuation.
- If `lastAttemptHitCeiling` is false (the resumed step completed normally) or
  the cap is reached: fall through to the normal Stop path untouched.
- Chain state: keyed per (agent.id, turn number); reset when a
  `turn-stopping` arrives whose `turn` differs from the recorded chain turn
  (continuation is same-turn, so a new turn number means the chain is over),
  on a real user prompt (same A2 reset position), and on `releaseSession`. The
  pre-review "reset on a non-max-tokens stopping" rule is REMOVED: with the
  sticky turn reason it could never fire.
- No StopFailure interaction: `max-tokens` never emits `agent/error`
  (verified ground fact), so nothing needs withholding at the hook plane.
- Documented divergence (manifest + package README): CC continues the same
  logical response invisibly; dsh-cc's continuation is a next-step user-role
  meta message from plugin source (model-visible; one extra step per
  continuation; the transcript still records one `turn/end` carrying the
  sticky `max-tokens` reason). The message-substring `max_output_tokens`
  class in `stopFailureErrorCode` stays as-is and never triggers continuation
  (provider-pushed context-length errors are not output-ceiling events).

Tests (scripted via `@dsh-cc/agent-loop-mock`'s `maxTokensResponse` /
`textResponse` — the mock already expresses the finish frame, no mock changes
expected; if a knob is missing, extend the mock as part of this change and
satisfy check-spec-deps for any new spec import): a first ceiling-hit
stopping steers the exact continuation text and does NOT invoke Stop; the
resumed step completing normally makes the NEXT stopping run Stop (locks the
recovered-completion path the sticky reason would have broken — the
pre-review test "continuation → completed → Stop then fires" only passes
with the corrected gate); three consecutive ceiling-hit stoppings steer 3
times and the 4th runs Stop; cap `0` disables (the first ceiling stopping
then runs Stop immediately); a new user-prompt turn resets the chain; no
notice side-effects; a subagent child agent gets the same behavior keyed by
its own id.

## 3. Change B — packages/compaction/compaction-micro (one executor, TDD)

Failure cap for the auto pre-step pass (today: infinite warn-only retry,
`index.ts:136`):

- `types.ts` / `config.ts`: `MicrocompactConfig` gains `failureCap?: number`
  (`z.number().step(1).min(1)`); `ResolvedConfig` default `3`. Follow the
  existing `retainResults`/`placeholderChars` resolution pattern.
- `index.ts`: per-session state `Map<string, { count: number; paused: boolean;
  noticed: boolean }>` keyed by session id.
  - Auto pass entry: if `paused` for this session → `return next()` (skip the
    try entirely).
  - On success (`microcompactSession` returns, even with 0 replacements):
    reset the entry (count 0, unpaused, unnoticed).
  - On catch: keep the existing warn; `count++`; at `count >= failureCap` and
    not yet `noticed`: set `paused`, set `noticed`, and inject ONE durable
    user notice via the pre-step `agent.inject(createUserMessage({ content:
    [{type:'text', text}], source: { kind:'plugin', plugin:'compaction-micro' }
    }))`. Text: `microcompact failed <cap> consecutive time(s) (last: <msg>);
    auto-microcompact paused for this session — run /compact manually to
    compress context`. Wrap the inject in try/catch warn-only (defensive
    cheapness — the harness does NOT restrict `inject` by agent level:
    `agent.ts:145-146` maps it to `send(input,'next-step',false)`; the catch
    is only a belt for exotic agent implementations and must not break the
    pause). NOTE: unlike A2's `surfaceNotices`, this notice is a model-visible
    next-step user message from plugin source — intended (the model learning
    that microcompact is paused and /compact is the manual path is useful);
    the package README must say so.
  - `ctx.on('session/disposed', ...)`: delete the session's entry (no leak).
- Package README: document `failureCap` alongside the other knobs.

Tests (package's existing suite style): stub/induced failure — attempts
continue below cap; at cap the pass stops being attempted (spy call count
frozen across further pre-steps); one notice injected with the expected text;
a later success resets (re-arming both attempts and the notice latch);
`session/disposed` frees state; default config value is 3 and an explicit
`failureCap: 1` pauses after the first failure.

## 4. Change C — packages/session/session-forensics (one executor, TDD)

Turn-outcome capture + error-retry analyzer (the calibration tool; thresholds
become measurable instead of asserted):

- `types.ts`: new `TurnOutcome { project, sessionId, turn, kind, errorCode?,
  message? }`; `ParsedStream` gains `turns: TurnOutcome[]`;
  `ForensicsResult` extended per the analyzer's output (follow the
  `permission-denials` precedent end-to-end).
- `scan.ts` `parseStream`: capture `turn/end` entries — `kind` from
  `data.reason.kind`; when `kind === 'error'`, also `errorCode` /
  truncated `message` from `data.reason.error`. Tolerant-parsing rules
  unchanged (never throw; corrupt mid-lines skipped and counted).
- New `src/analyze/error-retry.ts`: from all parsed streams compute, per
  session (then aggregated across sessions): total error turns, maximum
  consecutive error-turn streak, max-tokens turn count, and a histogram over
  sessions bucketed `0 / 1 / 2 / 3 / 4-9 / 10-19 / 20-49 / 50+` by max streak.
  Emit a `Finding` for sessions whose max streak ≥ 3 or total error turns ≥
  20 (the CC-derived thresholds under calibration — the analyzer is how we
  confirm or revise them from real transcripts later). In-code comment must
  note: a turn that hit the ceiling and then recovered STILL records
  `reason.kind:'max-tokens'` in `turn/end` (sticky, §1) — the max-tokens turn
  count therefore reads "touched the ceiling at least once", not "ended
  truncated"; do not misread it during threshold calibration.
- `index.ts`: register the analyzer in the pipeline.
- Tests: `scan.spec.ts` additions for `turn/end` capture (each kind variant,
  missing/malformed reason); analyzer fixtures asserting streak/histogram/
  finding math (mirror `analyzers.spec.ts`).
- Out of scope: running the scan over live `~/.dsh` transcripts (a manual
  follow-up; the shipped capability + tests are the deliverable).

## 5. Manifest + generated docs (orchestrator, after code lands)

`docs/claude-code-capabilities.yaml`:

- `hooks.stop`: add `tests/error-recovery.spec.ts` to evidence; semantics
  unchanged (parity locked, not widened).
- New `engine.error-streak-surfacing` (sorted per I7: after
  `engine.credentials`, before `engine.file-tools`): plane preset,
  mounted:true, anchor evidence `- id: hooks-claude-code` in
  `packages/preset/cc/agent.cordis.yml` (I4) + test evidence; behavioral:
  partial (CC's caps gate its own internal retry loops — those loops are
  harness-owned here; ours is notice-level, and our streaks are per-agent.id
  where CC's caps are session-wide — both divergences are stated in the
  summary) ⇒ ux: partial (I3). Refs:
  cc-docs `/docs/en/hooks` + `/docs/en/errors`, retrieved 2026-09-15.
- New `engine.output-token-continuation` (after `engine.onboarding`, before
  `engine.plan-mode`): plane preset, same anchor; behavioral: partial
  (continuation is a next-step meta message from plugin source rather than
  CC's invisible same-response resume; user-configured blocking Stop hooks
  are suppressed during output-ceiling recovery — both divergences are stated
  in the summary) ⇒ ux: partial. Refs: cc-docs `/docs/en/errors` +
  `/docs/en/sub-agents` (continuation exhaustion language), retrieved
  2026-09-15.
- `engine.context-compression` (or the microcompact entry): evidence += the
  new failure-cap test path.
- The forensics/learn entry: evidence += error-retry analyzer test path.
- Regenerate: `pnpm docs:parity`; verify `pnpm check:capabilities` and
  `pnpm check:parity`; commit the regenerated trio (matrix, README parity
  block, capabilities.json) with the code (same commit per repo rule; may land
  as the final commit in the same PR if the validator demands generated
  freshness).

## 6. Verification plan (orchestrator)

- Per-executor gates (they run these): from the REPO ROOT (memory:
  package-cwd vitest is a false green),
  `node_modules/.bin/vitest run packages/hooks/hooks-claude-code`
  (resp. compaction-micro, session-forensics) must pass incl. new tests.
- Orchestrator after integration: FULL suite from root
  (`node_modules/.bin/vitest run` — hooks bridge is central; never a subset),
  `node_modules/.bin/tsc -b tsconfig.packages.json`,
  `node scripts/check-spec-deps.mjs` (new spec imports must be declared
  devDeps — e.g. `@dsh-cc/agent-loop-mock` is already used by
  safety-loop.spec; no NEW dependencies allowed anywhere; lockfile untouched).
- Observable behavior (for the commit message, per config-is-prompt): a turn
  hitting the model's output ceiling now continues automatically up to 3
  times with CC's resume wording; 3 consecutive (or 20 total) API errors
  surface a durable notice + hook issue; 3 consecutive microcompact failures
  pause auto-microcompact for the session with a single durable notice; Stop
  hooks provably never fire on error-ending turns.

## 7. Execution decomposition

Three disjoint packages → three executors in ONE parallel batch (foreground,
same worktree, TDD: failing test first, then implementation). Hard
constraints for all: no git commit/push (orchestrator owns git), no dependency
or lockfile changes, repo-root vitest only, ≤500-line source budget per file,
English comments/docs matching repo style, public-API additions carry TSDoc.

- Executor A: §2 (hooks-claude-code; new spec `tests/error-recovery.spec.ts`,
  new state module, ListenerDeps wiring; may touch `@dsh-cc/hook-protocol`
  only if `HookIssue.kind` is a closed union).
- Executor B: §3 (compaction-micro).
- Executor C: §4 (session-forensics).

## 8. Review outcomes and residual risks

Resolved by the cold review (GO-WITH-AMENDMENTS, adopted inline):

1. A1 test-only confirmed correct — the turn-stopping dispatch is provably
   unreachable on error/aborted paths; the contingency guard would be
   coverage-failing dead code. Remains unwritten unless A1 test 1 fails.
2. A3's original sticky-`turn/end` gate was a real bug (would burn the cap and
   skip Stop up to 3× per truncation) — replaced by the last-attempt stream
   finish gate with the seq-tracking fallback; chain now keyed per turn
   number.
3. A2 notice-only scope endorsed as the honest scope (nothing in flight to
   cancel at `agent/error`; prompt rejection ruled hostile).
4. Stop-suppression during recovery (A3's skip) is accepted as CC-faithful and
   is documented as a divergence rather than treated as a risk.
5. Per-stopping `snapshotEvents()` scans match the existing `lastTurn`
   per-tool-exec pattern — not a cost concern.
6. B's `inject`-restriction comment corrected (no such restriction exists);
   B's notice is documented as model-visible.

Residual risk handed to Executor A: the serialized shape of the compact
assistant-attempt `stream` records was not fully traced — do the 5-minute
shape check before the first A3 test and use the seq-tracking fallback if the
finish frame is not directly readable.
