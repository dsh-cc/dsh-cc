# Structured progress state + post-compact context rebuild (design)

- Date: 2026-10-09
- Status: draft v8 (final) — 10 review rounds; all seats GO on the shipped text (codex r8, grok r9-full + r10-delta). Implemented — PR #216 (merged 2026-10-09); dogfood started 2026-10-09 (user-layer enabled); default-ON graduation pending.
- Scope: new package `packages/context/progress-rebuild`; capability manifest row; preset registration. Read-only consumption of session events + one injection path. No compaction-engine changes; no upstream harness modifications required — round 3 adds one dependency on EXISTING upstream exports (`@deepseek-ai/dsh-goal`'s pure fold, §3.2), which is a read of already-shipped code, not an upstream ask.
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
  `src/payloads.ts:160-163`); resolution plan per round-3 audit: look the agent
  up in the in-process agents registry by session id —
  `ctx.get('agents')?.get(session.header.id)`. The registry IS sessionId-keyed:
  upstream `core/agent/src/index.ts:262-263` wires the typert lookup resolution
  as `sessionId => this.get(sessionId)`, and the same `ctx.get('agents')?.get(id)`
  shape is already used at `register-events.ts:222`. No plugin-held
  session→agent map at all. Both earlier drafts are hereby dead and recorded:
  (a) `session.id → Agent` WeakMap is not constructible — a string key throws
  `TypeError` on `WeakMap.set`, and that throw would be swallowed by the
  harness's contained observer-error path (silent runtime failure, invisible to
  the plugin's own builder tests); (b) an object-keyed `WeakMap<Session, Agent>`
  fed by `agent/created` is constructible but redundant once the registry
  resolves by session id. No upstream assumption about `agent.id == session.id`
  is relied on — the registry key IS the session id.
  `register-events.ts:222` is cited as related (agent-id-keyed), not the
  precedent — that site resolves by AGENT id from `subagent/start`, not by
  session. The prior design doc for compaction resilience left
  this injection DoD box unchecked
  (`docs/plans/2026-09-21-compaction-resilience-upgrades.md:71-77,125-147,190`)
  — this design picks exactly that leftover up.
- Injection/delivery seams (round-5 redesign after both external lanes NO-GO'd
  the inject-from-observer form): `agent.inject` is a durable next-step enqueue
  with wakeup disabled (never wakes, never "re-opens" a turn), and its call
  path synchronously appends `agent/inbox/spliced` via `inbox.splice`
  (upstream `core/agent-loop/src/inbox.ts:235`) — so calling it INSIDE a
  `session/event` observer callback hits the session reentry guard
  (upstream `core/session/src/index.ts:741-742`) and is silently swallowed by
  observer containment; the in-repo lesson is already written at
  `packages/ui/tui/src/harness/driver-queue.ts:118-126`. Delivery is therefore
  path-split (§3.3): in-turn compaction delivers via an `agent/pre-step`
  splice (the step's inbox claim at `agent.ts:271-282` precedes the pre-step
  waterfall where automatic compaction runs, so an inbox enqueue could never
  make the first post-compaction request); idle compaction (`turn: null`)
  delivers via a DEFERRED durable inject, which survives persist+resume
  (upstream `agent-loop/tests/resume.spec.ts:947-974`) and is claimed by the
  user's next turn. `createUserMessage` + `source.kind` precedent:
  `packages/compaction/compaction-micro/src/index.ts:214-221`.

## 2. Goals and non-goals

Goals:

1. **M1 — progress-state derivation.** Maintain a typed, per-session progress
   summary from already-recorded session events (see §3.2 sources): current goal
   text, todo list snapshot, verified-claims summary when D1 receipt events are
   present, plus last user message reference. Purely derived — the agent is never
   asked to maintain it, so it cannot drift into fiction.
2. **M2 — post-compact rebuild injection.** On a successful `compaction/end`,
   deliver the derived brief into the FIRST model request built after the
   compaction boundary ("you are resuming after a context compaction; here is
   the verified state of the work"): in-turn compaction via an `agent/pre-step`
   decision splice (same step), idle compaction via deferred durable inject
   (the user's next turn). Evidence-class markers the model can trust; every
   `verified` line carries its execution evidence, not an inferred claim.

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
trio in the same commit; composition pin bumped deliberately. **Default OFF
(ship-dark), opt-in via §3.5** — round-3 audit correction: the draft's ON
default contradicted the repo's ship-dark convention for new model-visible
injection features (advisor-watchdog §4.8 precedent: ship dark, graduate to ON
only after the §5 dogfood loop produces evidence). The mechanism only *injects
a small brief at a rare boundary*; the cost profile is bounded and one-sided,
so graduation to default-ON is a fast follow once dogfood confirms value.
**Scope: all sessions, subagent sessions included** (round-3 decision):
`agent/created` fires and compaction happens for children too, and subagents
suffer the same post-compaction amnesia; the brief is bounded, so injecting
there is deliberate. A scoping setting can be added later if dogfood shows
noise. State ownership (round-5): the M1 shadow is a registered **Session
projection** (key `progress-rebuild`) via the `sessionProjections` registry —
precedents upstream `tool-todo/src/index.ts:123-132` ('todos') and
`@deepseek-ai/dsh-goal`'s exported `goalProjectionDefinition`
(`goal/src/index.ts:162-165`); reads via the registry's `stateOf(session,
key)` (the mandatory-seam decision, harness agent note
2026-08-19-session-projection-mandatory-seam). Registering from a dsh-cc
plugin is the same seam the registry already exposes (`ctx.get(
'sessionProjections')` consumers already exist in-repo:
`context-crusher/src/defer/pass.ts:287`,
`command-permissions/src/index.ts:96`). Registration duties (round-6, grok):
declare `inject: ['sessionProjections']` (todo precedent
`tool-todo/src/index.ts:23`), augment `SessionProjectionStateMap` via
`declare module` for the host-only key (omit `SessionProjectionMap`/`wire`),
and keep the state PLAIN JSON — the callId LRU is an array, not a `Map`
(projection state must survive schema-validated persist/restore,
upstream `session-projection/src/index.ts:46`).

### 3.2 M1 — derivation rules

Round-5 redesign: the shadow is a registered Session projection (§3.1) whose
`apply(state, event)` fold consumes **EVERY committed session event** (each
arm self-filters) and is driven by the projections framework — live
incrementally, and restored on resume by the framework (the sanctioned
replacement for synchronous history reads; `Session.snapshotEvents()` /
`eventAt()` / `ownEvents()` are `@deprecated` with NEW production calls
PROHIBITED — upstream `core/session/src/index.ts:643-651` and harness agent
note 2026-09-09-deprecate-synchronous-session-event-reads). There is NO
Listener A and NO hand-rolled backfill; compaction does not delete the log
(it is a surface `replace` over message-family events only —
`compaction-basic/src/region.ts:506-509`, surface types at
`core/session/src/surface.ts:50-55`), so the fold sees the full history
across compaction boundaries:

| shadow field | source events | derivation |
|---|---|---|
| `goal` | all session events (self-filtered) | **Derived through the harness's own canonical fold, never hand-rolled**: `@deepseek-ai/dsh-goal` exports the throw-free `applyGoalProjection(state, event)` (upstream `goal/src/index.ts:146`; unrelated events are no-ops, invalid events land in `state.failure`) plus `foldGoal`/`decodeGoalChange` (`index.ts:57`). The plugin's projection holds a `GoalProjectionState` arm, seeded `{ current: null, seenGoalIds: [], failure: null }`, and feeds **EVERY session event** through it (round-5 correction, both external lanes): the fold self-filters — it consumes `goal/change` AND goal-sourced `user/message` round events, because the round counter is advanced by those round events (`fold.ts:321-330`) and every later change must preserve it (`fold.ts:209-212`); feeding only `goal/change` would fail those checks and freeze the arm in `failure`. `state.failure !== null` renders "goal state unavailable (replay failure)" and stops updating that arm (a malformed goal-round message must not silently render stale state). Note `foldGoal` THROWS — `applyGoalProjection` is the only throw-free entry. Rendering from `state.current`: Round-3 audit replaced the earlier by-convention mapping, which was factually wrong: the durable operation vocabulary is `create \| edit \| pause \| resume \| complete \| block \| clear` (upstream `goal/src/domain.ts:14-21`); `clear` is a TOMBSTONE `{kind, version, operation:'clear', cleared, clearedAt}` carrying NO `goal` member (`domain.ts:35-41`) — so "read `goal.objective` regardless of `operation`" breaks on clear; and `complete` does NOT remove the goal — the fold keeps it with `phase:'complete'` and only then allows a later create (`fold.ts:289-301`). Rendering: `current === null` → "none recorded"; otherwise objective tagged by phase (`active`/`paused`/`blocked`/`complete`). The live dump observed only `operation:'create'` (footnote¹); fixture shapes for the rest are generated from the domain types and the strict fold pins the semantics. Adds a dependency on `@deepseek-ai/dsh-goal` (pure fold exports only — no service). |
| `todos` | `todo/write` | latest full todo list snapshot verbatim. Payload shape verified by live-transcript dump, 2026-10-09, two sessions; shapes pasted in footnote¹ — confirmed FULL-STATE write (later event's todos array replaces, not patches) |
| `verified` | `completion-gate/receipt` (D1, tolerant-absent — forward hook, dead until the sibling design ships) + `tool/result` fallback | bash receipts with execution evidence, each with its `ts`. Round-5 rule (both external lanes refuted the round-3 parse rule — it was INVERTED): the exit marker is rendered ONLY for NON-ZERO exits (upstream `shell/tool-bash/src/render.ts:57-61`), so a clean exit-0 result carries NO marker at all, while every failure/interrupt/promotion shape carries at least one marker line. `parseExitStatus` is therefore NOT usable for verification (its marker-absence default of exit 0 is exactly the false-positive hole — promoted `[still running after …]`, timed-out-but-trapped-exit-0, and stopped results all parse as 0). A receipt requires ALL of: (a) the matched `tool/call` has `name === 'bash'`; (b) the result's `isError` is false (spawn/abort infra failure class — `render.ts:19-21`); (c) the rendered result tail carries NO line from the fixed marker vocabulary (`[exit code: N]`, `[killed by signal: …]`, `[timed out after …ms]`, `[stopped: …]`, `[still running after …]`, the sandbox-denial marker, `[sandbox: the sandbox runner itself failed under …]`) — marker-ABSENCE is the success signal. Command eligibility is conservative: `tool/call`'s `arguments` is a RAW JSON string (upstream `core/session/src/types.ts:357-361`) — parse it, take `command`, and REJECT compound commands (round-9 stance, named conservative: any of `;`, `\|\|`, `&&`, `\|`, a NEWLINE, a mid-command or trailing `&`, or `$(…)`/backtick substitution is rejected; quoted separators false-reject — accepted, conservatism is deliberate), and REJECT `run_in_background: true` (round-6, codex: a background start renders a markerless `started background job …` acknowledgment, upstream `tool-bash/src/index.ts:471-477,499-509` — foreground completion only); head = first 200 chars. Round-9 (grok): the fold MUST NOT THROW — the registry's `drive` has no try/catch (upstream `session-projection/src/index.ts:681-684`), so a throwing `JSON.parse` on the raw arguments string or the grammar scan would stall that projection cell forever; every parse in the fold is caught and contained (unparseable → not a receipt). Receipts render EXECUTION EVIDENCE (command head + exit 0), never inferred completion claims. Keyed by `message.source.callId`, FIRST occurrence kept (microcompact RE-APPENDS replaced results, `compaction-micro/src/index.ts:281-292`); ring of 20. |
| `lastUser` | `user/message` | `{ ts, seq, text }` of the last GENUINE user message — the rule lives in the spec, not only in a test (round-5): genuine = `source` undefined OR `kind === 'user'`, with at least one non-empty text block (precedent `packages/interaction/advisor-watchdog/src/delta.ts:69-71`). By construction this excludes `kind:'compact-checkpoint'` (compaction's replacement user message, upstream `compaction/src/checkpoint.ts:19`, appended before every successful `compaction/end`), this package's own `progress-rebuild` briefs, and every other injected kind — enumeration-free. Stores the first 200 chars of text plus `ts`/`seq` (the §3.3 template renders the text; matching by `ts` alone is racy under same-ms appends — `event.time` is `Date.now()` at append). |

Boundedness (round-5, was under-specified): the RENDERED brief is capped on
two axes — ≤ `max-lines` lines AND ≤ 6 KiB total, with every line truncated at
240 chars (a single 10-KB todo content or command head must not blow the
budget). `verified` is a ring of 20. The callId dedupe index is LRU-capped at
512 (overflow only risks a duplicate receipt, itself ring-bounded). The goal
arm's `seenGoalIds` grows with goals created in the session (a handful in
practice — size-pinned by test, accepted).

¹ Verified payload shapes (live-transcript dump of real `session.v4.jsonl.zstd`
transcripts, 2026-10-09, two independent sessions each):

- `todo/write` data: `{"todos":[{"content": string, "status": "pending"|"in_progress"|"completed"}]}`
- `goal/change` data (snapshot operations): `{"kind":"goal/change","version":1,"operation":"create","goal":{"id":"goal-…","revision":1,"objective":string,"phase":"active","maxGoalRounds":number},"roundsStarted":number,"createdAt":number,"updatedAt":number}` — only `operation:"create"` observed live. Round-3 audit: the by-convention operation handling this footnote used to justify is REPLACED by the harness canonical fold (§3.2 goal row), which covers `edit/pause/resume/complete/block` snapshots and the `clear` tombstone (`domain.ts:14-44`); no asserted-by-convention rule remains.

### 3.3 M2 — rebuild injection

Listener B (trigger): on `session/event` where `event.type === 'compaction/end'` (round-9, grok: Listener B, Listener C, and the measurement append all NO-OP unless `progress-rebuild.enabled` is true — the ship-dark gate is on the delivery machinery, not the projection registration, which stays mounted so resume restore is unaffected):

1. Skip failed compactions FIRST: `event.data.error !== undefined` means the
   compaction did not complete and nothing was amputated (upstream
   `compaction-basic/src/region.ts:245` appends the end event WITH an `error`
   field on failure; payload `{compactionId, sourceCommandId?, turn, error?}` at
   upstream `compaction/src/types.ts:72`). Injecting a "resume after
   compaction" brief after a failed compaction would mislabel intact history.
   Then resolve the agent via the agents registry by session id
   (`ctx.get('agents')?.get(session.header.id)` — see §1). If resolution fails
   (agent already disposed or detached), skip silently (debug log). Finally
   branch on `event.data.turn`:
   - `turn === null` (idle compaction, e.g. manual `/compact`): deliver via a
     DEFERRED durable inject — `queueMicrotask(() => try { agent.inject(
     briefMessage) } catch …)`. The deferral is load-bearing: `agent.inject` →
     `inbox.splice` → `session.append('agent/inbox/spliced')` synchronously,
     which inside the publication window throws reentry
     (`core/session/src/index.ts:741-742`) and the throw is silently swallowed
     by observer containment — the brief would NEVER land (both external lanes
     hit this; in-repo precedent of the hazard:
     `packages/ui/tui/src/harness/driver-queue.ts:118-126`). The inject never
     wakes, and a microtask suffices because no wake is attempted.
   - `turn !== null` (in-turn compaction): set an in-memory `pendingBrief`
     flag for the session — delivery happens in Listener C, below. Do NOT
     inject on this path: the step's inbox claim already happened before the
     pre-step waterfall (`agent.ts:271-282`), so an inbox enqueue would miss
     the first post-compaction request.

Listener C (in-turn delivery): an `agent/pre-step` waterfall listener
(`async ({ agent, signal }, next) => { const decision = await next(); … }`)
— registration order relative to the compaction engine's own pre-step hook is
NOT load-bearing: either way, `await next()` only resolves after the whole
chain (including compaction) ran, so a `pendingBrief` set by an in-flight
compaction is visible. If `pendingBrief` is set for the agent's session and
`decision.kind === 'enter'`, return `{ ...decision, messages:
[...decision.messages, briefMessage] }` and clear the flag; otherwise return
the decision untouched. The spliced message is appended by the loop as a
durable `user/message` (`agent.ts:419-422`) — the brief rides the FIRST model
request built after the compaction boundary. Overflow-recovery compaction
(`agent/request-error`, mid-step) also lands here: the retry rebuilds the
current request without re-claiming, so the brief rides the FOLLOWING step —
one request late in that corner, accepted and stated. A `reject` decision
leaves the flag set (next step delivers). `pendingBrief` is in-memory only;
a process death between an in-turn compaction and the next step loses that
pending brief (narrow window; the next compaction regenerates — accepted).
2. Build the brief (hard budget: ≤ 120 lines of Markdown, LINE-CAP rendering
   with tail-preference on the todo section; the head-2/3-tail-1/3 precedent
   (`packages/interaction/permission-rules/src/probe-systemone.ts:67,72`) is
   cited only as a rendering-order precedent, not budget units):

   ```
   ## Resume after compaction (auto-generated, derived from session events — trust over prose memory)

   - Goal: <objective (phase: active/paused/blocked/complete) or "none recorded">
   - Verified commands (executed, exit 0 — execution evidence, NOT inferred
     completion claims):
     - <ts> `pnpm presubmit`
     - <ts> `git commit -m "…"`
   - Todo snapshot (verbatim):
     - [x] … / [ ] …
   - Note: earlier tool outputs may appear as deterministic placeholder stubs
     (microcompact collapsed them out of the window); their content is
     elided, not lost.
   - Last user instruction at <ts>: <first 200 chars of the user message>
   - Not verified: any completion claim not listed above is NOT backed by a
     receipt — re-verify before claiming.
   ```

3. Brief message CONSTRUCTION and source-kind duties (round-6, grok: the
   controlling delivery spec is the path-split in step 1 — do NOT also call
   `agent.inject` on the in-turn path, that would double-deliver): the brief
   message is `createUserMessage({ content:[{type:'text',text:brief}],
   source:{ kind:'progress-rebuild' }})`. Two registration duties ride with
   this step. (a) The new source kind needs a
   `declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap {…} }`
   augmentation inside this package — `MessageSource` derives from that map,
   so an unregistered kind string fails typecheck (precedents: advisor
   `wiring.ts`, turn-rules `wiring.ts:64-68`). (b) The kind joins the relevant
   injected-source denylists — three update sites, with anchors:
   `packages/memory/memory/src/recall.ts:204` (`INJECTED_SOURCE_DENYLIST`),
   the turn-rules matcher (`packages/interaction/turn-rules/src/matcher.ts:10-16`),
   and `packages/interaction/advisor-watchdog/src/delta.ts:24`
   (`INJECTED_SOURCE_DENYLIST` — the list lives at :24; the `isInjected`
   filter mechanics that consume it are at :75-76 with filter use at :111).
   'progress-rebuild' added to the list so the advisor's skip semantics covers
   it per its local mechanism. KNOW-YOUR-INJECTOR rule from advisor-watchdog; all
   three updated in the same commit. Round-3 wording fix: these are three
   INDEPENDENTLY maintained per-package lists whose memberships already differ
   (recall 4 kinds, turn-rules 5, advisor 6 — NONE of the three contains
   `compact-checkpoint`, which is why §3.2's shadow filter is self-held) —
   "lockstep" was wrong.
4. Dogfood measurement event `progress-rebuild/injected` (`{ bytes, sections,
   path: 'pre-step' | 'inject' }`). Delivery ACKNOWLEDGMENT (round-6, codex;
   round-7 fix for the round-6 fold's own defect): returning the spliced
   decision is NOT proof of delivery — cancellation or request preparation
   can fail before the durable message append (upstream
   `core/agent-loop/src/agent.ts:402-421`). The acknowledgment source is a
   dedicated LIVE `session/event` observer that fires when a
   `progress-rebuild`-sourced `user/message` is COMMITTED — both delivery
   paths end in that append, and a cancelled step between splice and append
   yields no row (fixture-pinned, §5). It must NOT live in the projection's
   `apply`: the fold is a PURE transition and also runs during restore and
   historical materialization (upstream
   `session-projection/src/index.ts:64-71,531,610`), so a fold-side emission
   would duplicate on replay — the live firehose fires only on live appends
   (restore/materialize fold the log directly, no dispatch). The `path` field
   is stashed at delivery time keyed by the brief's `message.id` (at the
   splice or the inject) and looked up by the ACK observer — never inferred
   from the event itself (round-9, grok). The two
   mechanisms the audits pinned stand: (a)
   register the type at load into the upstream `KNOWN_SESSION_EVENT_TYPES` set
   and append through a widened function face — persistence refuses
   unregistered types (precedent `packages/workspace/session-cwd/src/events.ts`
   — registration at :18-24, widened append face at :69-71); module
   augmentation types this package's own view only. (b) DEFER the append out
   of any `session/event` observer callback (`queueMicrotask`):
   `session.append` throws reentry mid-publication (upstream
   `core/session/src/index.ts:741-742`), silently. Documented trade-off
   (session-cwd class): once a session records this event type, resuming that
   session requires a composition that loads this package (the set mutation
   runs at module load) — accepted, and the §5 resume test pins it.

### 3.4 Interaction with in-flight machinery

- microcompact runs on `agent/pre-step` and replaces tool results with stubs
  (`compaction-micro/src/index.ts:148-156,281-292`). The rebuild brief explicitly
  tells the model that stub-marker texts are placeholders (one fixed sentence),
  preventing "the logs say the work vanished" confusion.
- The CCR defer swap rewrites an older in-window message slot; unaffected —
  this design never edits prior messages, only appends.
- Double-compaction (end events back-to-back): at most one brief per
  SUCCESSFUL `compaction/end` (failed ends deliver nothing, §3.3 step 1). On
  the in-turn path the `pendingBrief` flag collapses back-to-back ends into
  one brief; on the idle path no inbox-removal API is verified in-repo, so
  back-to-back idle ends may queue up to 2 briefs in `nextStep` — content is
  derived from the same projection state and idempotent by construction —
  accepted and documented.
- Subagent sessions: the pre-step splice and the deferred inject both work
  for children (the compaction engine hooks `agent/pre-step` globally; the
  registry resolves the child; the child's own next step claims the brief) —
  matching the §3.1 all-sessions scope decision.
- prompt-suggest reads the last `user/message` WITHOUT any source-kind filter
  (`packages/interaction/prompt-suggest/src/index.ts:103-116`, triggered at
  `agent/turn-stopping`): once the brief lands as a user message, it becomes
  the "last user prompt" for TUI prediction until the next genuine user
  message. Accepted and documented (round-3): the brief is honest derived
  state and no loop follows — prompt-suggest consumes but never injects turns
  back; a source filter there is a cheap follow-up if dogfood shows misleading
  predictions.
- The injected brief survives into the transcript and will be input to the next
  compaction summarizer; harmless because it is derived data, and it keeps the
  summary self-consistent.

### 3.5 Configuration

Kebab namespace (`registerNamespaceSafe` precedent
`packages/interaction/advisor-watchdog/src/settings.ts:23,90`):

- `progress-rebuild.enabled` — default `false` (ship-dark, §3.1; flip to `true`
  on the dogfood graduation commit, along with the §5 observable evidence).
- `progress-rebuild.max-lines` — default `120`.
- `progress-rebuild.include-verified` — default `true`; governs the WHOLE
  verified section (the live bash fallback AND the D1 receipts once it ships —
  the earlier "no-op when D1 absent" wording contradicted the fallback being
  the load-bearing source today).

### 3.6 Failure discipline

Pure observer + one bounded delivery. All errors swallowed after debug log;
delivery failure carries no user-facing error. The brief is derived data — a
bug can make it incomplete but never silently *wrong about receipts*, because
every `verified` line is generated from an event with its exit evidence
rendered verbatim, and the section header says so.

## 4. Resume, restart, and edge cases

- State restore (round-5): the projection framework owns it — the §3.1
  registered unit is restored on resume and then maintained incrementally
  (the sanctioned pattern from the deprecation note; this design contains NO
  `snapshotEvents()`/`eventAt()`/`ownEvents()` call — new production uses are
  prohibited, upstream `core/session/src/index.ts:643-651`). Because
  compaction is a surface replace over message families only and the LOG is
  append-only (`region.ts:506-509`, `surface.ts:50-55`), the fold sees
  pre-compaction history across the boundary; the compaction checkpoint user
  message it encounters is excluded by the §3.2 genuine-user rule, not by
  history being gone.
- `/resume` of an old session: same restore path; a compaction after resume
  delivers a brief built from the *resumed* session's projection — exactly
  the intended behavior.
- Sessions without any todo/goal/verified content: brief degenerates to the
  fixed stub-marker sentence plus last-user line; still useful, always bounded.
- Wake discipline: no path wakes a settled session — the idle-path inject
  never wakes (wakeup disabled), the in-turn path only rides turns that are
  already running. Restart semantics, corrected (round-5): a pending IDLE
  inject SURVIVES persist+resume (upstream
  `agent-loop/tests/resume.spec.ts:947-974` pins exactly this); only a
  GRACEFUL dispose discards it. The in-turn `pendingBrief` flag is in-memory
  and lost on process death (narrow window, the next compaction regenerates
  — accepted, not compensated).

## 5. Verification plan

1. Unit: derivation from synthetic event streams. Goal arm: feed ALL events
   through `applyGoalProjection` — `create/edit/pause/resume/complete/block/
   clear` fixtures from the domain types (including the `clear` tombstone
   with no `goal` member and the `complete`-keeps-goal rule), a goal-round
   `user/message` advancing `roundsStarted`, and a malformed round latching
   `failure` (renders "goal state unavailable"). Verified arm fixtures pin
   the round-5 marker rule: clean exit-0 (NO marker → receipt), non-zero exit
   (`[exit code: N]` present → not a receipt), timed-out-but-exit-0 and
   `[stopped: …]` and `[killed by signal: …]` (not receipts), promoted
   `[still running after …]` (not a receipt), `isError` (infra failure, never
   a receipt), a NON-bash tool result (not a receipt — non-bash renders carry
   no markers at all), compound commands rejected (`pnpm test; true`,
   `cd x && pnpm test`, `pnpm test\npnpm lint`, trailing `pnpm test &`), a
   `run_in_background: true` acknowledgment (not a receipt — markerless
   "started background job …"), and a microcompact replacement re-append
   that does not double-count its callId. lastUser fixtures: genuine (source-less and
   `kind:'user'`), `compact-checkpoint` excluded, self-kind
   `progress-rebuild` excluded.
2. Unit: brief budget on BOTH axes — 500-todo fixture elides to ≤ max-lines
   AND ≤ 6 KiB; a 10-KB single-line command/todo truncates at 240 chars per
   line. Self-reference test: the delivered brief, once appended as a
   `user/message`, must not change `lastUser` or any other arm.
3. Integration (testkit), asserting on ACTUAL adapter requests (inbox
   assertions alone cannot prove the delivery guarantee): a VALID
   `compaction/start` → `compaction/summary` → `compaction/end` triple with
   matching `compactionId`/`turn` (the upstream compaction invariant rejects a
   bare end — `compaction/src/invariant.ts:245,254-256`), then: (a) in-turn
   end → the FIRST request after `compaction/end` contains the brief text as
   a `progress-rebuild`-sourced user message (pre-step splice); (b) idle end
   (`turn: null`) → the deferred inject lands in `inbox.nextStep` and is
   claimed by the next turn's first request; (c) a failed end (with `error`)
   delivers nothing and emits no measurement event; (d) the measurement event
   lands only after successful delivery, outside the observer callback;
   (e) a synchronous inject from inside the observer would throw reentry —
   pin the deferral by asserting delivery happened with no contained
   reentry error; (f) cancellation between the splice and the durable
   append yields no measurement row (acknowledgment is the committed
   brief, not the decision); (g) restore/materialization of a session
   containing delivered briefs emits NO measurement rows (the live
   observer never fires on replay).
4. Regression: injected content never re-triggers listeners that filter
   injected sources (advisor-watchdog/memory-recall/turn-rules skip — assert
   via denylist membership test covering all three §3.3 update sites:
   `recall.ts:204`, turn-rules matcher, advisor-watchdog delta `isInjected`).
5. Projection restore + measurement admission: resume a persisted session
   with prior events → `stateOf(session, 'progress-rebuild')` equals the
   live-folded state (fixture equality); a session that recorded
   `progress-rebuild/injected` resumes in a composition that loads this
   package (KNOWN_SESSION_EVENT_TYPES registration runs at module load — the
   session-cwd-class resume coupling, §3.3 step 4).
6. Gates: capabilities manifest + parity, README trio, `check:size`,
   composition pin.

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
- **Hand-rolled `snapshotEvents()` backfill** (round-5): rejected — the API is
  `@deprecated` with new production calls PROHIBITED (upstream
  `core/session/src/index.ts:643-651`, harness agent note
  2026-09-09-deprecate-synchronous-session-event-reads); the sanctioned
  restore path is a registered Session projection, which this design uses.
- **Inject from the `session/event` observer** (round-5): rejected —
  `agent.inject` synchronously appends `agent/inbox/spliced` and throws the
  session reentry guard inside the publication window; the error is silently
  contained, so the brief would never land (both external lanes). Delivery is
  path-split instead (§3.3).
- **Read the live `goal` session projection instead of self-folding** (round-3
  consideration): rejected — it would couple this plugin to the goal service's
  registration and load order; self-folding through the same canonical
  `applyGoalProjection` export is self-contained, replay-exact, and testable
  without booting the goal service.

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
- Round 3 (code-grounded audit: orchestrator line-by-line anchor probe against
  dsh-cc AND the read-only upstream harness repo, plus independent critic
  delta, 2026-11): verdict **GO-WITH-AMENDMENTS**, amendments adopted in this
  revision (draft v4). The round-2 `complete`-nulls mapping (recorded just
  above) was REFUTED by the harness fold and is replaced by the canonical-fold
  derivation. Dispositions:
  (A1) `session.id → Agent` WeakMap is not constructible (string key →
  `TypeError`, and the throw dies in the contained observer-error path) —
  resolution now reuses the agents registry (`ctx.get('agents')?.get(
  session.header.id)`; registry is sessionId-keyed, upstream
  `core/agent/src/index.ts:262-263`); the object-keyed WeakMap variant is
  recorded as constructible-but-redundant.
  (A2) `compaction/end` also fires on FAILED compaction with `data.error`
  (upstream `region.ts:245`) — Listener B skips error-carrying ends first.
  (A3) `goal/change` vocabulary is `create/edit/pause/resume/complete/block/
  clear` with a goal-less `clear` tombstone (upstream `domain.ts:14-44`) — the
  goal arm now derives via the canonical fold (`applyGoalProjection`,
  upstream `goal/src/index.ts:146`) instead of any by-convention mapping.
  (A4) the measurement event needed two mechanisms, not "module augmentation":
  `KNOWN_SESSION_EVENT_TYPES` runtime registration + widened append face
  (persistence admission; precedent `session-cwd/src/events.ts:11-34`), and a
  deferred append — `session.append` throws on reentry mid-publication
  (upstream `core/session/src/index.ts:741-742`) and the error would be
  silently contained.
  (B1) `agent.inject` never wakes and never re-opens a turn — §1/§4 trigger-path
  prose rewritten (auto in-turn claim vs manual idle nextStep wait);
  phantom-loop framing deleted as inapplicable on this axis.
  (B2) verified-receipt success signal corrected: non-zero bash exit is NOT
  `isError` (upstream `shell/tool-bash/src/render.ts:19-21`); success = parsed
  `[exit code: N]` text marker (`parseExitStatus` precedent) with `isError` as
  the infra-failure class. D1 remains a forward hook (absent in-repo, grep-verified).
  (B3) `lastUserTs` exclusion is a self-held list that must also exclude
  `kind:'compact-checkpoint'` (upstream `checkpoint.ts:19`, appended before
  `compaction/end`); the three consumer denylists are independently maintained
  with differing memberships — "lockstep" wording fixed.
  (B4) receipts keyed by `message.source.callId`, first occurrence kept
  (microcompact replacement re-appends, live and backfill alike).
  (B5) `MessageSourceMap` augmentation duty added to §3.3 (MessageSource derives
  from that map). Integration test must append a valid start→summary→end triple
  (compaction invariant) and assert failed ends inject nothing; added unit pins
  for A-before-B order, self-reference (own brief must not pollute shadow), and
  the exit-marker parse.
  (B6) default flips to OFF (ship-dark; advisor-watchdog §4.8 precedent), with
  the §5 dogfood loop as the graduation gate; settings anchor corrected to
  `settings.ts:23,90`. Scope decision: all sessions incl. subagents (bounded
  brief, same amnesia class). prompt-suggest's unfiltered last-user read is a
  documented accepted degradation (§3.4). Restart-loss window of a pending idle
  brief accepted (§4). Open implementation item: `snapshotEvents()` inherited-segment
  behavior for resumed sessions (§4). Vestigial storage-idioms bullet deleted
  (the design holds no disk writes).

(filled per review round — verdict, findings, dispositions with in-text anchors)
- Round 4 (closure delta review, 2026-11): verdict **GO-WITH-AMENDMENTS** —
  all 12 round-3 amendments verified landed and technically correct against
  code (registry keying, failed-end skip, canonical goal fold, exit-marker
  success signal, compact-checkpoint exclusion, measurement-event mechanisms,
  MessageSourceMap duty, ship-dark default, never-wake semantics, §5 fixture
  set, §6 alternative, anchor fixes). 3 findings, all applied: (F1, substantive
  wording) §3.3 step 3's parenthetical claiming the advisor list carried
  compaction-adjacent knowledge was wrong — NONE of the three denylists
  contains `compact-checkpoint` (grep-verified across the three packages);
  rewritten to state exactly that, pointing at §3.2's self-held filter as the
  consequence. (F2, cosmetic) `tests/bridge.spec.ts` cite disambiguated to
  `packages/hooks/hooks-claude-code/tests/bridge.spec.ts:336-339`.
  (F3, cosmetic) clear-tombstone anchor corrected `domain.ts:35-41` → `:38-44`
  (and `:14-41` → `:14-44`). Convergence signature: findings degraded from
  mechanism-level (round 3) to wording/anchor-level — review loop closed. The
  one item the reviewer could not verify (cordis same-event dispatch order)
  is already contained by the §5 A-before-B unit pin. External blind-review
  lanes (codex/grok) not run on this revision — available on request before
  sign-off.
- Round 5 (dual external blind review — codex lane + grok lane, same brief,
  blind to each other, 2026-11): both lanes **NO-GO** on the v4 delivery
  mechanism; findings converged on the same core defects (multi-seat
  same-point hits, top confidence). Dispositions (all adopted, draft v5):
  (R5-1, blocker, both lanes) `agent.inject` from inside a `session/event`
  observer throws the session reentry guard and is silently contained — the
  round-3 claim "the inject itself is safe — it only splices the inbox" was
  WRONG (`inbox.splice` appends `agent/inbox/spliced`, upstream
  `core/agent-loop/src/inbox.ts:235`); in-repo hazard documented at
  `packages/ui/tui/src/harness/driver-queue.ts:118-126`. The idle path now
  defers the inject; the in-turn path does not inject at all (R5-2).
  (R5-2, high, both lanes) the step's inbox claim precedes the `agent/pre-step`
  waterfall (`agent.ts:271-282`), so an inbox enqueue after in-turn
  compaction misses the first post-compaction request — delivery is now
  path-split: in-turn = pre-step decision splice (Listener C), idle
  (`turn: null`) = deferred durable inject; overflow-recovery compaction
  rides the following step (one request late, stated). §5 asserts on actual
  adapter requests, not inbox state.
  (R5-3, high, both lanes) the goal arm must feed EVERY session event through
  `applyGoalProjection` — goal-round `user/message` events advance
  `roundsStarted` (`fold.ts:321-330`) and later changes must preserve it
  (`fold.ts:209-212`); feeding only `goal/change` freezes the arm in
  `failure`, which is now handled explicitly (render "goal state
  unavailable").
  (R5-4, high, both lanes) the round-3 parse-marker success rule was INVERTED:
  the exit marker is rendered only for NON-ZERO exits (`tool-bash/src/
  render.ts:57-61`), so marker-absence defaults to success and certifies
  promoted `[still running after …]`, timed-out-exit-0, and stopped results;
  `parseExitStatus` is unusable for verification. New rule: receipt =
  bash tool + `isError` false + NO marker line from the fixed vocabulary.
  (R5-5, high, both lanes) "proof-command classes" were under-specified and
  overclaimed: receipts now require a simple (non-compound) command parsed
  from the raw `tool/call` `arguments` JSON, and render EXECUTION EVIDENCE
  (command head + exit 0), never inferred completion claims.
  (R5-6, medium) `snapshotEvents()` is `@deprecated` with new production
  calls PROHIBITED — the hand-rolled backfill is replaced by a registered
  Session projection (`sessionProjections` + `stateOf`, mandatory-seam
  decision), which also owns resume restore; Listener A and the seq-cursor
  are deleted.
  (R5-7, medium) restart-loss statement was false as generalized: a pending
  idle inject SURVIVES persist+resume (`agent-loop/tests/resume.spec.ts:
  947-974`); only graceful dispose discards. §4 corrected. Also clarified:
  compaction is surface-replace over message families only — the log is
  append-only, so the fold sees pre-compaction history.
  (R5-8, grok) `lastUser` gains the missing TEXT field (`{ts, seq,
  text≤200}`) and a genuine-user rule IN THE SPEC (source undefined or
  `kind:'user'`, advisor `delta.ts:68-71` precedent) — enumeration-free
  exclusion of `compact-checkpoint`, self briefs, and every other injected
  kind.
  (R5-9, both lanes) `include-verified` now governs the whole verified
  section (was contradicted by the live bash fallback).
  (R5-10, grok) measurement event records delivery path and is emitted only
  on SUCCESSFUL delivery (a row for a brief that never landed is a lying
  dogfood signal); the KNOWN_SESSION_EVENT_TYPES resume coupling is
  documented as a session-cwd-class trade-off with a §5 pin.
  (R5-11, codex) boundedness on bytes as well as lines: ≤ 6 KiB render cap,
  240-char per-line truncation, LRU-capped callId index, goal-state size pin.
  Anchor nits absorbed: session-cwd widened append face at :69-71;
  compaction invariant summary check at :254-256; registry `enter()` enforces
  `agent.id === session.id` (upstream `core/agent/src/index.ts:459-477`).
- Round 6 (external delta confirmation, --last threads, 2026-11): **grok GO**
  ("no remaining NO-GO; the v4 delivery hole is closed against the code"),
  **codex NO-GO** on one remaining receipt false-positive; all findings
  folded (draft v6):
  (R6-1, high, codex) `run_in_background: true` bash starts render a
  markerless `started background job …` acknowledgment
  (`tool-bash/src/index.ts:471-477,499-509`) — the marker-absence rule would
  have certified them. Fold: receipts require foreground completion
  (parsed args must not set `run_in_background`); fixture added.
  (R6-2, medium, codex) the compound-command rejection omitted NEWLINE and
  lone `&` (both are bash control operators). Fold: the rejected grammar is
  now `;`, `||`, `&&`, `|`, newline, trailing `&`; fixtures added.
  (R6-3, medium, codex) a spliced decision is not delivery acknowledgment —
  cancellation or request prep can fail before the durable append
  (`agent.ts:402-421`). Fold: the measurement event is emitted from the
  projection's own fold on observing a committed `progress-rebuild`-sourced
  `user/message`; cancellation fixture added (§5.3f).
  (R6-4, grok) projection seam duties spelled out: `inject:
  ['sessionProjections']`, `SessionProjectionStateMap` module augmentation
  (host-only), plain-JSON state (callId LRU as array).
  (R6-5, grok) §3.3 step 3 rewritten as message-construction duties — the
  in-turn path must NOT also call `agent.inject` (double-delivery).
  (R6-6, grok, nits) stub-marker sentence added to the brief template;
  marker vocabulary extended with `[sandbox: the sandbox runner itself
  failed …]`; keep-on-complete anchor corrected to `fold.ts:289-301`.
  Codex explicitly verified the round-5 redesigns: compactor ordering
  supports the registration-order argument, every-event goal folding,
  projection restore, deferred idle inject, genuine-user filtering, and
  render caps are implementable as amended.
- Round 7 (codex closure delta, 2026-11): **NO-GO on one point** — the
  round-6 measurement fold itself was defective: the projection's `apply` is
  a PURE transition that also runs during restore and historical
  materialization (`session-projection/src/index.ts:64-71,531,610`), so a
  fold-side emission would duplicate on replay. Fold: the acknowledgment
  source is a dedicated LIVE `session/event` observer of committed
  `progress-rebuild`-sourced `user/message` events (the firehose fires only
  on live appends; restore/materialize fold the log directly, no dispatch);
  §5.3g pins restore-emits-no-rows. Codex confirmed the background-receipt,
  command-grammar, and other mechanical amendments close the round-6
  issues. Round-8 confirmation pending.
- Round 8 (codex closure confirmation, 2026-11): verdict **GO** — no
  remaining NO-GO-level finding; corroborated that seeded events never
  publish on `session/event` (upstream `core/session/src/index.ts:475-478`),
  so the live acknowledgment observer cannot fire on replay, and §5.3g pins
  it. **Review loop converged: grok GO (round 6, residuals folded as
  mechanical text) + codex GO (round 8).** Per the review-status discipline,
  internal + external GO ≠ Approved — user sign-off remains the final gate.
- Round 9 (grok FULL re-confirmation on v7, fresh pass over rounds 6-8
  text, 2026-11): verdict **GO** — "no remaining NO-GO; v7 is implementable
  as written; the v4 delivery hole and the round-6 fold-side measurement
  defect are closed against the code". 5 non-blocking findings, all folded:
  (R9-1) the measurement `path` field is stashed at delivery time keyed by
  the brief's `message.id`, looked up by the ACK observer (never inferred
  from the event). (R9-2) the projection fold MUST NOT THROW — the
  registry's `drive` has no try/catch (`session-projection/src/index.ts:
  681-684`), so every parse inside the fold is caught and contained
  (unparseable → not a receipt). (R9-3) the ship-dark `enabled` gate is
  explicitly on Listener B, Listener C, and the measurement append; the
  projection registration stays mounted (resume restore unaffected).
  (R9-4, nit) the control-operator grammar is named CONSERVATIVE (mid-command
  `&` and `$(…)`/backtick substitution also rejected; quoted separators
  false-reject — deliberate conservatism). (R9-5, nits + cross-seat anchor
  adjudication) goal-row source column now "all session events
  (self-filtered)"; advisor genuine-user rule requires a non-empty text
  block (`delta.ts:69-71`); turn-rules wiring anchor corrected to
  `:64-68`. Tombstone anchor: codex r4 said `domain.ts:38-44`, grok r9
  said `:35-41` — adjudicated by direct read (the interface spans :35-41);
  the doc carries `:35-41`, and the :14-44 range cites stand. **All seats
  converged: grok GO (r6, r9-full) + codex GO (r8).**
- Round 10 (grok v8 delta confirmation, 2026-11): verdict **GO** — "round-9
  importants are specified; no NO-GO remains" (path stash, fold-must-not-
  throw, ship-dark gating all verified landed). One residue: a dead text
  fragment the round-9 rewrite left in the verified row — deleted. **v8 is
  the reviewed artifact: codex GO (r8, on v7 whose only deltas to v8 are
  grok's own round-9 folds) + grok GO (r10, on v8). All seats converged on
  the implemented text.**
