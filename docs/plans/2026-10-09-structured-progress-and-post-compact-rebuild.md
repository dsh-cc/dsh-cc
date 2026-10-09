# Structured progress state + post-compact context rebuild (design)

- Date: 2026-10-09
- Status: draft v3 — internal critic GO after 2 rounds; user sign-off pending. NOT yet implemented.
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

- Compaction lifecycle events are emitted by the upstream engine adapter
  (`packages/compaction/compaction-basic-cc/src/index.ts:10` imports
  `@deepseek-ai/dsh-compaction-basic`); `compaction/end` is consumed in-repo via
  the firehose `ctx.on('session/event', (session, event) => …)` —
  `packages/hooks/hooks-claude-code/src/register-events.ts:264`, with the
  `compaction/end` branch at `:280-283`.
- PostCompact's payload is session-only (no agent handle —
  `src/payloads.ts:160-163`); resolution plan: this plugin maintains a
  `session.id → Agent` WeakMap fed by `agent/created` (payload `{agent,
  source}` — `packages/hooks/hooks-claude-code/src/index.ts:307`) and dropped
  on `session/disposed`; on `compaction/end` we look up the agent by
  `session.id` (the Session identity member used in `session.append` flows; if
  the member is named differently, the builder tests will catch it). No
  upstream assumption about `agent.id == session.id` is relied on.
  `register-events.ts:222` is cited as related (agent-id-keyed), not the
  precedent — that site resolves by AGENT id from `subagent/start`, not by
  session. The prior design doc for compaction resilience left
  this injection DoD box unchecked
  (`docs/plans/2026-09-21-compaction-resilience-upgrades.md:71-77,125-147,190`)
  — this design picks exactly that leftover up.
- Injection that lands in the next model request: `agent.inject(createUserMessage({…, source:{kind:'…'}}))`
  (SessionStart precedent: `packages/hooks/hooks-claude-code/src/index.ts:312-313`;
  inbox/next-step assertion: `tests/bridge.spec.ts:336-339`; microcompact's own
  post-action notice does the same at
  `packages/compaction/compaction-micro/src/index.ts:214-221`). Delivering at a
  session-active moment (compaction runs inside a live session) re-opens the next
  turn — the phantom-loop lesson applies and is handled in §4.
- Storage idioms to copy: per-project keying `sha256(cwd)[:16]`, atomic
  tmp+rename writes, disk-based LRU (handoff-store
  `packages/subagent/handoff-store/src/store.ts:34-36,68-76`; journal writer
  `packages/subagent/workflow-journal/src/journal-io.ts:133-136,213-225`).

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
| `goal` | `goal/change` | latest goal text/objective; `null` if none. Payload shape verified by live-transcript dump, 2026-10-09, two sessions; shapes pasted in footnote¹ — we consume the LATEST event's `goal.objective` and `goal.phase` regardless of `operation`. Operation-aware derivation: `goal/change` with operation `'complete'` nulls the shadow goal (`'pause'` marks it inactive; `'resume'`/`'edit'` update fields). Only `operation:'create'` was observed in the live dump, so this rule is **asserted-by-convention** with a unit test pinning the mapping (§5). |
| `todos` | `todo/write` | latest full todo list snapshot verbatim. Payload shape verified by live-transcript dump, 2026-10-09, two sessions; shapes pasted in footnote¹ — confirmed FULL-STATE write (later event's todos array replaces, not patches) |
| `verified` | `completion-gate/receipt` (D1, tolerant-absent — preferred source) + `tool/result` fallback | bash successes with `head` matching the proof-command classes (test/presubmit/build/lint/git-commit), each with its `ts`. Fallback path: `tool/result` events DO carry text via `event.data.message.content` (reader precedent `packages/compaction/compaction-micro/src/index.ts:256-257`; replace-append at :281-292); the command comes from the matching `tool/call` event args, success from the result's `isError` |
| `lastUserTs` | `user/message` (injected sources excluded — denylist precedent `packages/interaction/advisor-watchdog/src/delta.ts:24`, the `INJECTED_SOURCE_DENYLIST` list) | timestamp |

Shadow size is tiny (goal string + todo snapshot + ≤20 receipt summaries);
cap `verified` at the newest 20 entries (ring).

¹ Verified payload shapes (live-transcript dump of real `session.v4.jsonl.zstd`
transcripts, 2026-10-09, two independent sessions each):

- `todo/write` data: `{"todos":[{"content": string, "status": "pending"|"in_progress"|"completed"}]}`
- `goal/change` data: `{"kind":"goal/change","version":1,"operation":"create","goal":{"id":"goal-…","revision":1,"objective":string,"phase":"active","maxGoalRounds":number},"roundsStarted":number,"createdAt":number,"updatedAt":number}` — only `operation:"create"` observed; other operations (edit/pause/resume/complete per platform docs) exist; derivation consumes the LATEST event's `goal.objective`/`goal.phase` regardless of operation.

### 3.3 M2 — rebuild injection

Listener B: on `session/event` where `event.type === 'compaction/end'`:

1. Resolve the agent: look up the agent by `session.id` in the plugin's
   `session.id → Agent` WeakMap (fed by `agent/created`, dropped on
   `session/disposed` — see §1); no assumption that `agent.id == session.id`.
   If resolution fails (agent already disposed), skip silently (debug log).
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
   relevant injected-source denylists — three update sites, with anchors:
   `packages/memory/memory/src/recall.ts:204` (`INJECTED_SOURCE_DENYLIST`),
   the turn-rules matcher (`packages/interaction/turn-rules/src/matcher.ts:10-16`),
   and `packages/interaction/advisor-watchdog/src/delta.ts:24`
   (`INJECTED_SOURCE_DENYLIST` — the list lives at :24; the `isInjected`
   filter mechanics that consume it are at :75-76 with filter use at :111).
   'progress-rebuild' added to the list so the advisor's skip semantics covers
   it per its local mechanism. KNOW-YOUR-INJECTOR rule from advisor-watchdog; all
   three updated in the same commit.
4. Append `session.append('progress-rebuild/injected', { bytes, sections })` for
   dogfood measurement (module augmentation pattern as in sister designs).

### 3.4 Interaction with in-flight machinery

- microcompact runs on `agent/pre-step` and replaces tool results with stubs
  (`compaction-micro/src/index.ts:148-156,281-292`). The rebuild brief explicitly
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
`packages/interaction/advisor-watchdog/src/settings.ts:6`):

- `progress-rebuild.enabled` — default `true`.
- `progress-rebuild.max-lines` — default `120`.
- `progress-rebuild.include-verified` — default `true` (no-op when D1 absent).

### 3.6 Failure discipline

Pure observer + one bounded injection. All errors swallowed after debug log;
injection failure carries no user-facing error. The brief is derived data — a
bug can make it incomplete but never silently *wrong about receipts*, because
every `verified` line is generated from an event, and the section header says so.

## 4. Resume, restart, and edge cases

- Process restart mid-session: shadow state is rebuilt lazily by a one-time
  backfill pass over `session.snapshotEvents()` on the first `session/event`
  seen for an unknown session id (snapshot walk precedent:
  `packages/interaction/prompt-suggest/src/index.ts:102-116` — O(events) once,
  then incremental). Ordering, explicit: (a) snapshot-walk backfill up to but
  EXCLUDING the triggering event, (b) apply the triggering event, (c) continue
  incrementally; a seq-cursor pins the boundary to avoid double-counting the
  triggering event.
- `/resume` of an old session: same backfill path; a compaction immediately
  after resume injects a brief built from the *resumed* transcript, which is
  exactly the intended behavior.
- Sessions without any todo/goal/verified content: brief degenerates to the
  fixed stub-marker sentence plus last-user line; still useful, always bounded.
- Idle-wake discipline: injection is only triggered by `compaction/end`, which
  by construction happens in a live session; there is no listener-only path that
  can wake a settled session (structural, like advisor-watchdog's skip rule).

## 5. Verification plan

1. Unit: derivation from synthetic event streams (goal/todo/tool-result mixes);
   a §3.2-footnote-shape test pins parsing against the two verified fixture
   payloads (`todo/write` and `goal/change`); absence tolerance for each source
   family.
2. Unit: brief budget — 500-todo fixture elides to ≤ max-lines with head/tail
   shape; fixed strings present.
3. Integration (testkit): synthetic session with events → `compaction/end` →
   assert one injected user message with `source.kind='progress-rebuild'`
   landing in `inbox.nextStep` (bridge.spec.ts:336-339 assertion pattern).
4. Regression: injected content never re-triggers listeners that filter
   injected sources (advisor-watchdog/memory-recall/turn-rules skip — assert
   via denylist membership test covering all three §3.3 update sites:
   `recall.ts:204`, turn-rules matcher, advisor-watchdog delta `isInjected`).
5. Backfill: unknown-session first event triggers snapshot walk; steady-state
   incremental cursor equals backfilled state (fixture equality).
6. Gates: capabilities manifest + parity, README trio, file-size, composition
   pin.

Dogfood (config-is-prompt): observe `progress-rebuild/injected` rows after real
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

(filled per review round — verdict, findings, dispositions with in-text anchors)
