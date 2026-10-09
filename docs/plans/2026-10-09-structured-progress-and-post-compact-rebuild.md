# Structured progress state + post-compact context rebuild (design)

- Date: 2026-10-09
- Status: **implemented — PR #211 (pending merge)**. Rounds 1-2 internal critic GO; round 3 code-truth verification (dual-lane) GO-WITH-AMENDMENTS, adopted in v4; round 4 delta GO-WITH-AMENDMENTS, adopted in v5; round 5 same-seat micro-confirmation **GO**; default-ON user decision 2026-11-12 (§3.5); implementation delivered 2026-11-12 (§8 implementation-round entry). Flip to the standard `Implemented — PR #211 (merged <date>)` form on merge.
- Scope: new package `packages/context/progress-rebuild`; capability manifest row; preset registration. Read-only consumption of session events + one injection path. No compaction-engine changes; no harness-upstream dependency.
- Sources: Effective Harnesses (initializer/progress-log/handoff protocol against one-shotting and premature completion), Harness Design (context reset + structured handoff artifact beats in-place compaction under context anxiety), Remember-Don't-Re-read (typed runtime state instead of prompt replay: 24,465→2,492 tokens on 15-step runs), SLA (restricted role context rebuilt by the harness). Calibrated by Coding Harness Study/Malena: the win here is *continuity at compaction boundaries*, not more scaffolding.

## 1. Problem

Compaction preserves the conversation but amputates the *state of the work*:
which items are done (and proven), which are open, what the next step was. The
agent then either re-derives progress by re-reading (token burn; Remember-Don't-
Re-read quantified this as an order of magnitude) or — worse — hallucinates
completion from the summarised vibe (premature completion). dsh-cc already owns
every ingredient of the fix — durable memory, handoff store, workflow journal,
goal/todo events in the transcript (`todo/write`, `goal/change` observed in real
session inventory) — but nothing **assembles** a typed progress brief and
**re-injects it right after compaction**, which is the exact moment Harness
Design says a structured handoff artifact beats prose history.

Probe-verified seams (2026-10-09, this worktree):

- Compaction lifecycle events are emitted by the upstream engine (harness
  `packages/compaction/compaction-basic/src/region.ts:237`; the failure path at
  :245 appends `compaction/end` with an `error` field — see §3.4); the in-repo
  adapter default-imports it (`packages/compaction/compaction-basic-cc/src/index.ts:10`
  `import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'`).
  `compaction/end` is consumed in-repo via
  the firehose `ctx.on('session/event', (session, event) => …)` —
  `packages/hooks/hooks-claude-code/src/register-events.ts:264`, with the
  `compaction/end` branch at `:280-283`.
- PostCompact's payload is session-only (no agent handle —
  `packages/hooks/hooks-claude-code/src/payloads.ts:161-163`; `sessionBase`
  at `:126` carries only session header fields). Resolution: the upstream
  AgentRegistry's `get` is keyed by SessionId — evidenced by the typert
  lookup registration `resolve: sessionId => this.get(sessionId)` (harness
  `packages/core/agent/src/index.ts:262-263`, whose wire type symbol is
  `@deepseek-ai/dsh-session/types#SessionId`). dsh-cc already resolves agents
  through the registry at `register-events.ts:222,238`. So on `compaction/end`:
  `ctx.get('agents')?.get(session.id)`, skipping silently with a debug log when
  undefined. Round 3 dropped the earlier `session.id → Agent` WeakMap plan:
  a WeakMap cannot be keyed by a string (`SessionId` is a branded string —
  immediate TypeError at runtime), `agent/created`'s payload `{agent, source,
  signal?}` (harness `packages/core/agent/src/index.ts:550-554`) carries no
  session, and the registry makes any side table unnecessary. The earlier
  "no reliance on `agent.id == session.id`" caveat is retired: the registry
  key space IS SessionId. The prior design doc for compaction resilience left
  this injection DoD box unchecked
  (`docs/plans/2026-09-21-compaction-resilience-upgrades.md:190-192`)
  — this design picks exactly that leftover up.
- Injection that lands in a subsequent model request: `agent.inject(createUserMessage({…, source:{kind:'…'}}))`
  (SessionStart injects via `agent.inject(context)` at
  `packages/hooks/hooks-claude-code/src/index.ts:312-313`, with `:312` being
  `turnSafety.contextFrom(merged)`; `createUserMessage` precedent:
  microcompact's own post-action notice at
  `packages/compaction/compaction-micro/src/index.ts:218`;
  inbox/next-step assertion: `tests/bridge.spec.ts:336-339...` — the file is
  `packages/hooks/hooks-claude-code/tests/bridge.spec.ts:336-340`).
  Timing (round-3 precision): `agent.inject` is `send(input, 'next-step', false)`
  (harness `packages/core/agent-loop/src/agent.ts:171-173`) — durable
  next-step enqueue that does NOT wake a settled idle agent. Automatic
  compaction runs inside an open turn (enforced at harness
  `packages/compaction/compaction-basic/src/region.ts:198-199`), so the brief
  enters the same turn's next step, or re-opens a follow-up turn if the
  current one ends first. Manual `/compact` requires an idle session
  (`region.ts:190-192`), so the brief queues and rides the next user turn —
  no phantom wake on either path (§4).
- Storage idioms to copy: per-project keying `sha256(cwd)[:16]`
  (`packages/subagent/handoff-store/src/store.ts:34-36` `projectKeyOf`),
  atomic tmp+rename writes (handoff-store `put()` at `store.ts:68-76`;
  journal writer at
  `packages/subagent/workflow-journal/src/journal-io.ts:216-224`), disk-based
  LRU via utimes-touch + sweep (`store.ts:118-124` and the sweep at `:138`+).

## 2. Goals and non-goals

Goals:

1. **M1 — progress-state derivation.** Maintain a typed, per-session progress
   summary from already-recorded session events (see §3.2 sources): current goal
   text, todo list snapshot, verified-claims summary when D1 receipt events are
   present, plus last user message reference. Purely derived — the agent is never
   asked to maintain it, so it cannot drift into fiction.
2. **M2 — post-compact rebuild injection.** On `compaction/end`, inject the
   derived brief as the next model request's context ("you are resuming after a
   context compaction; here is the verified state of the work"), with markers the
   model can trust: each `done` line carries its evidence class.

Non-goals:

- No new agent-facing tool (no `progress_update` tool). Deliberate: a
  model-maintained artifact can lie; a derived one cannot. (Recorded as a
  rejected alternative with reasoning, §6.)
- No replacement or tuning of compaction itself (thresholds, summarizer
  prompts, microcompact) — orthogonal and already owned elsewhere.
- No cross-session/campaign protocols (Levels-Ticks-Cascades clocked ticks are
  watchlist material for future campaign modes, not this change).
- No multi-window pre-compact summarization.

## 3. Design

### 3.1 Package and registration

New package `packages/context/progress-rebuild` (`@dsh-cc/progress-rebuild`),
plain cordis plugin. Preset service-group row + capability manifest row + README
trio in the same commit; composition pin bumped deliberately. Default ON with a
kill switch (§3.5) — the mechanism only *injects a small brief at a rare
boundary*; the cost profile is bounded and one-sided.

### 3.2 M1 — derivation rules

Listener A: `ctx.on('session/event', …)` keeps a per-session in-memory shadow
state, updated event-by-event (no disk write; reconstruction after process
restart is M2-adjacent, §4):

| shadow field | source events | derivation |
|---|---|---|
| `goal` | `goal/change` | Operation-aware over the full upstream vocabulary `create\|edit\|pause\|resume\|complete\|block\|clear` (harness `packages/goal/goal/src/domain.ts:14-21`): `create`/`edit`/`resume` → latest `goal.objective`/`goal.phase`; `pause` → kept, inactive; `complete` → shadow goal nulls (recorded as completed); `block` → kept, inactive (phase `blocked`); `clear` → shadow goal nulls. **`clear` events are tombstones with NO `goal` member** — payload `{kind, version, operation:'clear', cleared, clearedAt}` (harness `packages/goal/goal/src/domain.ts:33-41`) — so derivation discriminates on `operation` BEFORE touching `.goal`. Only `operation:'create'` was observed in the live dump (footnote¹); the rest are pinned by fixtures generated from these upstream types (§5). |
| `todos` | `todo/write` | latest full todo list snapshot verbatim. Payload shape verified by live-transcript dump, 2026-10-09, two sessions; shapes pasted in footnote¹ — confirmed FULL-STATE write (later event's todos array replaces, not patches) |
| `verified` | `completion-gate/receipt` (D1, tolerant-absent — preferred source; confirmed absent in-repo as of round 3) + `tool/result` fallback | bash successes with command head matching the proof-command classes (test/presubmit/build/lint/git-commit), each with its `ts`. **Success = parsed exit code 0 from the `[exit code: N]` marker in the result text — NOT `isError`**: harness bash explicitly reports non-zero exits as ordinary results ("Non-zero exits are reported, not errored — the model decides how to react; only infrastructure failures (spawn errors, aborts) surface as isError results", harness `packages/shell/tool-bash/src/render.ts:17-26`; marker kept last per `:44`, rendered at `:59-61`; parser precedent `parseExitStatus` from `@deepseek-ai/dsh-shell`, re-exported at `packages/shell/tool-bash/src/render.ts:128`, consumed at `packages/shell/tool-bash/src/index.ts:140`). Marker absent or non-zero → NOT verified (fail-closed); `isError` additionally excludes infrastructure failures. The structured exit code (bash result `value.exitCode`, `tool-bash/src/index.ts:165,371,529`) does NOT reach the transcript — `ToolResultMessage` carries no `value` (harness `packages/llm/llm/src/message.ts:173`) — so text-marker parsing is the only fallback channel; without this rule the fallback would mark failed test runs as "verified", breaking this section's core promise. `tool/result` events carry text via `event.data.message.content` (reader precedent `packages/compaction/compaction-micro/src/index.ts:256-257`; replace-append at :281-292); the command comes from the matching `tool/call` event's `arguments`, an unparsed JSON string (harness `packages/core/session/src/types.ts:361`), paired by `callId` (`tool/result` message source carries it; invariant harness `packages/core/session/src/invariant.ts:141`). |
| `lastUserTs` + `lastUserText` (first 200 chars) | `user/message` | Latest REAL user message — **allowlist, not denylist**: only `source.kind === 'user'` counts (real prompts arrive with `source: {kind:'user'}`, fixture-pinned at `packages/hooks/hooks-claude-code/tests/bridge.spec.ts:341`; §5). A denylist enumeration was rejected in round 4: the in-repo injected kinds are a moving target — at least three (`compaction-micro` at `packages/compaction/compaction-micro/src/index.ts:220`, `compaction-cost-gate` at `packages/compaction/compaction-cost-gate/src/index.ts:351`, `cc-shell-glue` at `packages/bundle/cc-shell/src/index.ts:257,275`) are absent from ALL THREE external denylists today (`recall.ts:204` 4 kinds / `matcher.ts:10-16` 5 / `delta.ts:24` 6), and the compaction boundary additionally emits `compact-checkpoint` user messages (harness `packages/compaction/compaction/src/checkpoint.ts:19`, committed just before `compaction/end` — harness `packages/compaction/compaction-basic/src/region.ts:235-237`) which would otherwise surface as the "last user instruction" after every compaction. The allowlist covers all of these by construction, this feature's own `progress-rebuild` kind included (self-reference: injected briefs land as later `user/message` — harness `packages/core/agent-loop/src/agent.ts:421`, `packages/core/session/src/types.ts:303-309`). Derivation: event timestamp + first 200 chars of the message text. |

Shadow size is tiny (goal string + todo snapshot + ≤20 receipt summaries);
cap `verified` at the newest 20 entries (ring).

¹ Verified payload shapes (live-transcript dump of real `session.v4.jsonl.zstd`
transcripts, 2026-10-09, two independent sessions each):

- `todo/write` data: `{"todos":[{"content": string, "status": "pending"|"in_progress"|"completed"}]}`
- `goal/change` data (snapshot form): `{"kind":"goal/change","version":1,"operation":"create","goal":{"id":"goal-…","revision":1,"objective":string,"phase":"active","maxGoalRounds":number},"roundsStarted":number,"createdAt":number,"updatedAt":number}` — only `operation:"create"` observed live; the remaining snapshot operations (`edit`/`pause`/`resume`/`complete`/`block`) share this shape per the upstream type (`GoalSnapshotChangeMeta`), while `clear` is the tombstone form `{"kind":"goal/change","version":1,"operation":"clear","cleared":GoalRef,"clearedAt":number}` with no `goal` member (`GoalClearChangeMeta`, harness `packages/goal/goal/src/domain.ts:33-41`). Fixtures for both forms are pinned in tests (§5).

### 3.3 M2 — rebuild injection

Listener B: on `session/event` where `event.type === 'compaction/end'`:

1. Skip when `event.data.error` is present — `compaction/end` is also
   appended on the FAILED compaction path (harness
   `packages/compaction/compaction-basic/src/region.ts:245`, with
   `error: errorChain(error)`), and injecting a "you are resuming after a
   compaction" brief after a failed compaction would mislead. Then resolve
   the agent: `ctx.get('agents')?.get(session.id)` — the upstream registry is
   keyed by SessionId, no side table is maintained (see §1). If resolution
   fails (agent disposed or owned by another process), skip silently
   (debug log).
2. Build the brief (hard budget: ≤ 120 lines of Markdown, LINE-CAP rendering
   with tail-preference on the todo section; the head-2/3-tail-1/3 precedent
   (`packages/interaction/permission-rules/src/probe-systemone.ts:67,72`) is
   cited only as a rendering-order precedent, not budget units):

   ```
   ## Resume after compaction (auto-generated, derived from session events — trust over prose memory)

   - Goal: <goal or "none recorded">
   - Verified done (execution receipts):
     - <ts> tests green (vitest) [bash ok]
     - <ts> commit created (git commit) [bash ok]
   - Todo snapshot (verbatim):
     - [x] … / [ ] …
   - Last user instruction at <ts>: <first 200 chars of the user message>
   - Not verified: any completion claim not listed above is NOT backed by a
     receipt — re-verify before claiming.
   ```

3. `agent.inject(createUserMessage({ content:[{type:'text',text:brief}],
   source:{ kind:'progress-rebuild' }}))`. The source kind is registered in the
   three in-repo injected-source denylists. Note (round-3 correction): these
   are three INDEPENDENT lists whose memberships already differ
   (`packages/memory/memory/src/recall.ts:204` — 4 kinds; the turn-rules
   matcher `packages/interaction/turn-rules/src/matcher.ts:10-16` — 5 kinds;
   `packages/interaction/advisor-watchdog/src/delta.ts:24` — 6 kinds, with
   `isInjected` at :75-76 and filter use at :111), so "lockstep" means adding
   'progress-rebuild' to EACH list individually and pinning membership by
   test (§5), not keeping the lists equal. KNOW-YOUR-INJECTOR rule from
   advisor-watchdog; all three updated in the same commit. (Pre-existing
   KNOW-YOUR-INJECTOR gap noted in round 4: the injected kinds
   `compaction-micro`, `compaction-cost-gate` and `cc-shell-glue` are absent
   from all three lists — flagged as a separate follow-up in §7, not folded
   into this change.) Separately, the shadow's own allowlist (§3.2) —
   not any of these denylists — is what protects `lastUserTs`/`lastUserText`
   from self-pollution.
4. Dogfood measurement goes to a **sidecar file**, NOT a session event:
   one JSON line appended to `$DSH_HOME/progress-rebuild/<sessionId>.jsonl`
   (`{ ts, bytes, sections }`; `dshHome` absent → no-op, precedent
   `packages/subagent/handoff-store/src/index.ts:57`; `mkdir recursive`
   before `appendFile`). Rationale (implementation-round finding, 2026-11):
   `Session.append` of a custom event type would poison the log under
   harness 0.2.0-rc.x persistence — the JSONL backend hard-rejects event
   types outside the upstream catalog that are not marked `ignorable`
   (harness `packages/session/session-persistence/src/storage-contract.ts:69-80`),
   `Session.append` has no production-side `ignorable` channel (harness
   `packages/core/session/src/index.ts:722-773`), and with this feature
   default-ON every compacted session would become un-resumable. Sidecar is
   the established pivot for exactly this landmine (session-config-snapshot
   precedent). This also retires the earlier deferred-append note — no
   `session.append` happens on this path at all.

### 3.4 Interaction with in-flight machinery

- Compaction timing paths (round 3): automatic compaction is triggered on
  `agent/pre-step` (harness `packages/compaction/compaction-basic/src/index.ts:158`)
  and is required to run inside an open turn (`region.ts:198-199`), so the
  injection enters the same turn's next step, or re-opens a follow-up turn
  when the current one ends first. Manual `/compact` requires an idle session
  (`region.ts:190-192`), so the injection is a durable next-step enqueue that
  waits for the next user turn — no phantom wake, since `agent.inject` does
  not wake a settled idle agent (harness
  `packages/core/agent-loop/src/agent.ts:171-173`). A FAILED compaction also
  appends `compaction/end` carrying an `error` field (`region.ts:245`) —
  those events produce no injection (§3.3 step 1).
- microcompact runs on `agent/pre-step` (registration at
  `compaction-micro/src/index.ts:150`) and replaces tool results with stubs
  (`:274-277`, replace-append at `:281-291`). The rebuild brief explicitly
  tells the model that stub-marker texts are placeholders (one fixed sentence),
  preventing "the logs say the work vanished" confusion.
- The CCR defer swap rewrites an older in-window message slot; unaffected —
  this design never edits prior messages, only appends.
- Double-compaction (end events back-to-back): at most one injection per
  `compaction/end`; no inbox-removal API is verified in-repo, so back-to-back
  `compaction/end` events may yield up to 2 briefs in `inbox.nextStep`; content
  is idempotent by construction (derived from the same shadow state) — accepted
  and documented.
- The injected brief survives into the transcript and will be input to the next
  compaction summarizer; harmless because it is derived data, and it keeps the
  summary self-consistent.

### 3.5 Configuration

Kebab namespace (`registerNamespaceSafe` precedent
`packages/interaction/advisor-watchdog/src/settings.ts:90`):

- `progress-rebuild.enabled` — default `true`. Deviation from the ship-dark
  convention (nearest precedent advisor-watchdog ships default OFF:
  `packages/interaction/advisor-watchdog/src/settings.ts:52`, `:71` "Ship-dark
  defaults (§4.8)") is deliberate and user-decided (2026-11-12): the feature
  is a pure observer whose only action is injecting a small derived brief at a
  rare boundary, and after the round-3 amendments its failure modes are
  fail-closed (a missing or incomplete brief) rather than misleading — the
  cost profile is bounded and one-sided. The kill switch remains the rollback
  path.
- `progress-rebuild.max-lines` — default `120`.
- `progress-rebuild.include-verified` — default `true` (no-op when D1 absent).

### 3.6 Failure discipline

Pure observer + one bounded injection. All errors swallowed after debug log;
injection failure carries no user-facing error. The brief is derived data — a
bug can make it incomplete but never silently *wrong about receipts*, because
every `verified` line is generated from an event, and the section header says so.

## 4. Resume, restart, and edge cases

- Process restart mid-session: NO historical backfill. The snapshot-walk
  precedent (`packages/interaction/prompt-suggest/src/index.ts:102-116`) reads
  `session.snapshotEvents()`, which is `@deprecated` upstream — "new calls are
  prohibited", and copying the line-scoped no-deprecated waiver to a new
  production call violates that policy (harness agent note
  `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`;
  the storage direction stops retaining the complete sequence in memory, in
  favor of per-domain projections restored at resume). The shadow therefore
  accumulates only from events observed in this process's lifetime; after a
  restart or `/resume` it starts empty and any compaction brief degenerates
  (below) until fresh events arrive. Accepted trade-off. If dogfood shows
  resume-time compactions matter in practice, the upgrade path is an explicit
  full-history storage read with a documented justification (per the same
  note) or a dsh-cc projection seam — not the deprecated synchronous reader.
  (Considered in round 4 and rejected on code semantics: the upstream
  `todos` projection — `ctx.sessionProjections.register`, harness
  `packages/todo/tool-todo/src/index.ts:123-128` — folds to `null` at every
  `turn/start`, and automatic compaction fires at `agent/pre-step` inside an
  already-open turn, so the projection would always read `null` exactly when
  this design needs it. No equivalent ctx-level goal projection was found.)
- `/resume` of an old session: no backfill; a compaction immediately after
  resume emits the degenerate brief. (Downgraded from the v3 claim that this
  is "exactly the intended behavior" — with no history access the resumed
  transcript is not available, and that is the deliberate round-3 choice.)
- Sessions without any observed todo/goal/verified content (including the
  post-restart window): the brief degenerates to the fixed stub-marker sentence
  plus the last-user line when one was observed this process; still useful,
  always bounded.
- Idle-wake discipline: injection is only triggered by `compaction/end`, and
  `agent.inject` does not wake a settled idle agent (harness
  `packages/core/agent-loop/src/agent.ts:171-173`), so no listener-only path
  can wake a settled session. (Round-3 wording fix: the earlier "compaction by
  construction happens in a live session, re-opening the next turn" was
  imprecise for both timing paths — see §3.4.)

## 5. Verification plan

1. Unit: derivation from synthetic event streams (goal/todo/tool-result mixes);
   the §3.2-footnote-shape tests pin parsing against the live-verified
   `todo/write` and `goal/change`-create fixtures; all seven goal operations
   are covered by fixtures generated from the upstream types (harness
   `packages/goal/goal/src/domain.ts:14-42`), including the `clear` tombstone
   form with no `goal` member; absence tolerance for each source family.
2. Unit: brief budget — 500-todo fixture elides to ≤ max-lines with head/tail
   shape; fixed strings present.
3. Unit (round-3 correction pinned): verified derivation treats
   `[exit code: 0]` bash results as receipts, non-zero-exit and marker-absent
   results as NOT verified (fail-closed), and `isError: true` results as
   excluded infrastructure failures.
4. Integration (testkit): synthetic session with events → `compaction/end` →
   assert one injected user message with `source.kind='progress-rebuild'`
   landing in `inbox.nextStep`
   (`packages/hooks/hooks-claude-code/tests/bridge.spec.ts:336-340` assertion
   pattern); a `compaction/end` carrying an `error` field produces NO
   injection; each injection appends exactly one line to the sidecar file
   (§3.3 step 4).
5. Regression: injected content never re-triggers listeners that filter
   injected sources — membership of `'progress-rebuild'` asserted at each of
   the three §3.3 denylist sites individually (`recall.ts:204`, turn-rules
   matcher, advisor-watchdog delta `isInjected`), accepting that the lists
   differ in membership. Self-pollution test: after the brief's own
   `user/message` event, shadow `lastUserTs`/`lastUserText` still name the
   last REAL user message; `compact-checkpoint`, `compaction-micro`,
   `compaction-cost-gate`, `cc-shell-glue` and any other injected-kind
   messages never update them — and an allowlist fixture pins that real user
   prompts arrive with `source.kind === 'user'` (bridge.spec.ts:341).
6. Restart/resume: `compaction/end` observed with an empty shadow produces
   exactly the degenerate brief; no history access — lint-level guard that
   this package's production code never calls the deprecated session readers
   (`snapshotEvents`/`eventAt`/`ownEvents`).
7. Gates: capabilities manifest + parity, README trio, check:size,
   composition pin, check-spec-deps.

Dogfood (config-is-prompt): observe the sidecar rows — one JSON line per
injection in `$DSH_HOME/progress-rebuild/<sessionId>.jsonl` — after real
compactions; expected observable = the first model step after compaction does
not re-run reads that the brief already answered (spot-check by transcript).

## 6. Rejected alternatives (recorded to prevent relitigation)

- **Model-maintained progress doc (initializer/progress-log à la Effective
  Harnesses)**: coupling completion state to model self-report reintroduces the
  exact fabrication class D1 exists to gate; derivation keeps this design
  deterministic. A *supplementary* model-maintained doc can be layered later.
- **Replace compaction with reset+handoff**: the upstream engine is not ours to
  replace (harness read-only), and Coding Harness Study's evidence says the
  marginal continuity delta is at the rebuild boundary, which M2 addresses.
- **Per-turn progress injection**: rejected — cost and noise at every turn; the
  boundary that needs the artifact is the compaction boundary.

## 7. Follow-ups

0. KNOW-YOUR-INJECTOR gap (found in round 4): the injected source kinds
   `compaction-micro` (`packages/compaction/compaction-micro/src/index.ts:220`),
   `compaction-cost-gate`
   (`packages/compaction/compaction-cost-gate/src/index.ts:351`) and
   `cc-shell-glue` (`packages/bundle/cc-shell/src/index.ts:257,275`,
   `mcpReadyNotice.ts:161`) are absent from all three injected-source
   denylists; those lists therefore already leak. Separate small PR adding
   them (each list individually, members differ), independent of this design.

1. ZCode-legacy merge candidate: enrich the brief with a receipts *digest* once
   D1 ships (the two designs cross-reference; neither blocks the other — absence
   tolerance is specified in both).
2. Campaign-grade artifacts (structured cross-session handoff, clocked driver
   ticks) — watchlist; requires the goal/schedule surfaces, not this package.
3. If dogfood shows briefs answering well, graduate `openQuestions` to a real
   channel fed by a future model-maintained section with receipts-gating.

## 8. Review ledger

- Round 1 (internal critic, 2026-10-09): verdict **GO-WITH-AMENDMENTS**, 9
  findings (F1–F9), all adopted. F1 (payload shapes) closed by live-transcript
  dump — real `session.v4.jsonl.zstd` transcripts, two independent sessions
  each, collected 2026-10-09 (not a testkit probe); shapes pasted in the §3.2
  footnote. F2–F9: resolution via session→agent WeakMap, `tool/result` text
  fallback corrected, double-compaction idempotency stated, three denylist
  sites enumerated, line-cap budget, brief-re-enters-compaction note,
  `openQuestions` dropped, backfill ordering pinned (§4).
- Round 2 (internal critic delta, 2026-10-09): verdict **GO**; 2 findings,
  both adopted. Anchor nit: advisor's own `INJECTED_SOURCE_DENYLIST` lives at
  `packages/interaction/advisor-watchdog/src/delta.ts:24` (`isInjected` at
  :75-76, filter use at :111) — §3.2's cite updated to :24 where the list is
  referenced (filter-mechanics cites keep :100-111). Derivation note adopted:
  §3.2 goal row now specifies operation-aware derivation (`complete` nulls,
  `pause` inactive, `resume`/`edit` update), asserted-by-convention with a
  unit test pinning the mapping (only `operation:'create'` observed live).
- Round 3 (code-truth verification, 2026-11-12; dual-lane — orchestrator
  source review against current dsh-cc + harness 0.2.0-rc.2 code, plus an
  independent critic cold review; the lanes converged): verdict
  **GO-WITH-AMENDMENTS**, 6 findings, all adopted in this revision:
  F1 the verified-fallback `isError` assumption is false — harness bash
  reports non-zero exits as ordinary results, never as `isError`
  (`packages/shell/tool-bash/src/render.ts:17-26`) — so §3.2's success rule
  is rewritten as `[exit code: N]` marker parsing, fail-closed (a failed test
  run can no longer read as "verified"); F2 shadow `lastUserTs` would be
  polluted by `compact-checkpoint` replacement messages
  (`packages/compaction/compaction/src/checkpoint.ts:19`) and the three
  injected-source denylists differ in membership — §3.2 keeps its own
  exclusion list, §3.3 wording corrected; F3 the goal vocabulary missed
  `block`/`clear` and `clear` is a tombstone without a `goal` member
  (`packages/goal/goal/src/domain.ts:14-42`) — §3.2 covers all seven
  operations, fixtures pinned; F4 the `session.id → Agent` WeakMap is not
  expressible in JS (string key) and is unnecessary — §1/§3.3 resolve via the
  upstream registry keyed by SessionId
  (`packages/core/agent/src/index.ts:262-263`); F5 `compaction/end` also
  fires on the failed path with an `error` field
  (`packages/compaction/compaction-basic/src/region.ts:245`) and the timing
  wording was imprecise — §3.3 step 1 skips error events, §1/§3.4/§4 state
  both timing paths precisely; F6 default ON contradicts the ship-dark
  precedent — resolved by explicit user decision (2026-11-12): default stays
  ON, rationale recorded in §3.5. Folded in additionally: `snapshotEvents()`
  is deprecated upstream with new production calls prohibited — §4 drops
  history backfill (resume-time compactions emit the degenerate brief);
  anchor drift re-recorded throughout (storage idiom line references,
  SessionStart inject shape at :312-313, prior-doc DoD box at :190-192).
- Round 4 (critic delta-confirmation, same-seat continuation, 2026-11-12):
  verdict **GO-WITH-AMENDMENTS**; all six round-3 dispositions verified
  line-by-line against code. Three residuals: R1 the shadow's denylist
  enumeration was still incomplete (three in-repo injected kinds absent from
  ALL three lists — `compaction-micro`, `compaction-cost-gate`,
  `cc-shell-glue`) → adopted: §3.2 switched from denylist to ALLOWLIST
  (`source.kind === 'user'` only), §5 pins the fixture, and the pre-existing
  KNOW-YOUR-INJECTOR gap is recorded as §7 follow-up 0 (kept out of this
  change's scope); R2 suggested enriching resume via the upstream `todos`
  projection — refuted on code semantics in round 5 (see there); R3 anchor
  micro-drifts (`domain.ts:33-41`, `render.ts:17-26`) → adopted.
- Round 5 (critic same-seat micro-confirmation, 2026-11-12): verdict **GO**.
  Two adjudicated points were closed by counter-evidence, and the critic
  withdrew its own round-4 suggestions — recorded here per honest-attribution
  rule: (a) round-4 R1's "a missing `source` also counts" branch was
  withdrawn as unsupported — `MessageBase.source` is a required field
  (harness `packages/llm/llm/src/message.ts:143-146`) and
  `user: {kind:'user'}` is the canonical real-user entry (`message.ts:110-111`;
  production usage harness `packages/plan/plan-mode/src/index.ts:265`), so
  the allowlist pins exactly `kind === 'user'`; (b) round-4 R2 (todos
  projection) was withdrawn after refutation — the projection folds to `null`
  at every `turn/start` (harness
  `packages/todo/tool-todo/src/index.ts:123-128`) while automatic compaction
  fires at `agent/pre-step` after `turn/start`
  (harness `packages/core/agent-loop/src/agent.ts:305,316`), so the
  projection is always `null` exactly when this design would need it; the
  deterministic failure of that path is recorded in §4. No NO-GO or MAJOR
  findings remain; the fold chain F1→marker-parsing, F2→registry, F3→seven
  operations + tombstone, F4→registry resolution, F5→error-skip, allowlist
  lastUserTs, deprecated-reader exclusion all re-checked against current
  code with no new contradictions.
- Implementation round (2026-11-12, during slice-1 development): the dogfood
  `session.append('progress-rebuild/injected', …)` in §3.3 step 4 was found
  to poison the session log under harness 0.2.0-rc.x persistence — the JSONL
  backend hard-rejects custom event types not marked `ignorable` on
  open(read|write) (`packages/session/session-persistence/src/storage-contract.ts:69-80`),
  and `Session.append` has no production-side `ignorable` channel — with this
  feature default-ON, every compacted session would become un-resumable
  (same landmine as the gauge `permission/classifier` rows; the
  session-config-snapshot design already pivoted to a sidecar for exactly
  this). Amendment: dogfood measurement pivoted to a sidecar file
  (`$DSH_HOME/progress-rebuild/<sessionId>.jsonl`, §3.3 step 4), the
  SessionEventMap augmentation dropped (MessageSourceMap kind retained).
  This finding survived review rounds 1-5 uncaught and was surfaced by the
  implementation pass — recorded per honest-attribution rule. A second
  implementation-pin: `agent.inject` itself records an inbox-splice session
  append, so the whole injection path runs in a `queueMicrotask` to leave the
  publishing append's reentry window (live-verified during slice 2).
  Delivered 2026-11-12 as PR #211 (slices: derivation core / wiring +
  denylists + sidecar / registration battery); local gates green,
  presubmit in flight.

(filled per review round — verdict, findings, dispositions with in-text anchors)
