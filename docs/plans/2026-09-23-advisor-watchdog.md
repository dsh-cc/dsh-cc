# Advisor watchdog: an opt-in second model reading every turn

**Status:** **Ready for implementation** — critic cold review round 1
(2026-09-23), round-2 implementation-readiness delta audit (2026-09-24,
after turn-rules #135 and lsp-on-write #136 merged), round-3 re-review
(2026-09-24), and an implementation-verification respin (round 3b,
2026-09-24) incorporated. Round-2: delta capture re-grounded (session-
forensics is a `/learn` tool-records analyzer, not a message reader);
execution seam pinned to `runSideQuery`; delivery at resolve-time inject with
the real T2/idle contracts; composition-spec row pattern corrected;
cross-package denylist obligations added; Appendix A omp ledger added.
Round-3: genuine-user predicate widened for `source.kind: 'user'`;
suppressed-phrase set replaced with the true omp verbatim list; `plugin`
kind added to the filter; immune arithmetic, counters, smoke-stub seam,
dep-split anchors corrected. Round 3b (caught by line-level wiring review):
`agent/pre-step` payload.messages is the **claimed inbox batch**, not the
transcript (harness `agent-loop/src/agent.ts:250` `messages: claimed`), so
the cursor-over-payload mechanic was replaced by passive `llm/stream`
snapshots + a turn-stopping trigger (restoring omp's onTurnEnd shape and
removing the one-turn lag entirely); per-definition subagent frontmatter
dropped (harness `Agent` exposes no definition to listeners) in favor of a
settings-level subagent gate.
**Date:** 2026-09-23, revised 2026-09-24
**Worktree:** `.claude/worktrees/advisor-watchdog` (branch `worktree-advisor-watchdog`)

## 1. Problem

dsh-cc has one mind per turn. When the main model rushes a fix past its own
acceptance criteria, nobody notices until the user does. oh-my-pi's answer is
an **advisor**: a second model, on its own context and its own (cheap) route,
that reads the transcript delta every turn and emits severity-tiered notes the
primary agent consumes at the next step
(`oh-my-pi/packages/coding-agent/src/advisor/runtime.ts:365-399` (`onTurnEnd`),
`advise-tool.ts:20,62-63`, `emission-guard.ts:99-102`; all verified
2026-09-23, re-verified 2026-09-24). Their dogfood numbers: 309 advise calls
distilled into 92 unique notes in one era, i.e. a real noise problem solved
deliberately (dedupe + budget + immune turns), plus a quarantine layer against
injected advice — the advisor itself can be a prompt-injection vector.

The same failure profile exists here: error-streak surfacing and the Stop lock
(PR #81) react to *tool errors*; nothing reviews *reasoning quality* on a
clean run.

## 2. Goal

An opt-in advisor that:

- at each `agent/turn-stopping`, reviews the turn that just ended —
  reconstructed from passive `llm/stream` snapshots (§4.1);
- calls a cheap lane (default alias `haiku`) via `runSideQuery` with a strict
  output contract (JSON notes, `nit | concern | blocker`, empty allowed);
- delivers surviving notes by `agent.inject()` when the side call resolves,
  marked with source kind `advisor` (never mid-tool-batch — pending injects
  are claimed at step/turn boundaries);
- cannot talk itself into a loop: dropped-from-review injected kinds, the
  no-genuine-user-message suppression, emission guard (dedupe, per-run
  budget, immune turns), per-session total cap, quarantine scan of note text;
- records every run in a per-session journal so dogfood can compute
  notes-per-turn and decide whether the feature graduates from default-off.

## 3. Non-goals

- Not a tool-call veto. The advisor steers by injected context; enforcement
  belongs to permission rules and stays there.
- No second full agent transcript in the session tree (omp runs a full Agent;
  we deliberately run a one-shot cheap-lane call — the fork-shaped side-query
  red lines from workspace memory `memory-recall-fork-rogue-execution` apply:
  one-shot `runSideQuery` with `rejectToolCalls: true`, no raw user task
  re-embedded as an executable query, fail-soft).
- **No in-turn (real-time) review and no transcript-file reader.** The delta
  source is the passive `llm/stream` request snapshot (§4.1) — the exact
  provider view — not the session log: session-forensics is a whole-file zstd
  *tool-records* analyzer for `/learn`
  (`packages/session/session-forensics/src/scan.ts:241-259`) and must not be
  cited as a message source, and rolling our own live session-file reader
  (multi-frame zstd, append races) buys nothing the stream snapshot doesn't
  already give. Reviews fire at turn end (`agent/turn-stopping`), one run per
  completed turn at most.
- No advisor for subagents by default (settings-level gate, §4.7;
  per-definition opt-in deferred — harness `Agent` exposes no definition to
  listeners).
- No TUI surface in v0. There is no plugin-driven TUI notice API
  (the notice at `packages/ui/tui/src/harness/driver.ts:81-91` is internal UI
  state). Whether the TUI renders source-kind-injected user messages is a
  dogfood verification item (§5), not a v0 guarantee.

## 4. Design

### 4.1 Snapshot capture, cursor, and delivery (all seams verified in repo)

**Snapshot listener (source of the review window).** A read-only `llm/stream`
waterfall listener registered with `{ global: true, prepend: true }` (the
cache-health precedent, `packages/observability/cache-health/src/index.ts:160-166`;
reasoning-fold, context-crusher and compaction-cost-gate observe the same
seam) keeps, per session id, the newest observed request's message array:

- Keep a request iff `options.sessionId !== undefined` — the loop stamps
  `sessionId` for request routing (harness `packages/llm/llm/src/types.ts:449-452`),
  so loop-built conversation requests qualify and every hand-built one-shot
  (our own `runSideQuery` call included — it never sets `sessionId`) is
  excluded by construction. This is also the advisor's self-observation guard.
- Skip when `options.purpose` is set (`'compaction' | 'session-title'`,
  types.ts:453-458 — auxiliary calls with rewritten projections).
- The listener does **zero** settings/IO work: on a qualifying request it does
  `snapshots.set(sessionId, options.messages)` and returns `next()`
  immediately. Retained cost is one array reference (skeleton) per active
  session id — the message objects are shared with the session's own history.
  The map lives for the mount (preset remount clears), no per-session dispose
  (turn-rules posture); entries are dropped when a session becomes gated-out
  or disabled (see trigger step 1/5).
- Waterfall discipline: observe-and-passthrough only, never mutate `options`,
  never throw (a throw into `llm/stream` would break the user's request).

**Trigger = `agent/turn-stopping`** (payload `{agent, turn, signal}`,
`runtime-types.ts:391`) — omp's `onTurnEnd` shape restored
(`runtime.ts:365-399`). The single synchronous handler, in this order:

1. Gates, each a cheap early-return: settings `.enabled` (raw dual-half read,
   §4.9); `isTopLevel(agent)` (predicate copied from turn-rules
   `wiring.ts:27-30`) unless the `subagents` gate admits this session (§4.7);
   `state.disabled` (cap or unrouted); `state.inFlight` (one run per session
   at a time — a stop during flight captures nothing and leaves the cursor
   alone, so the window is NOT lost: it accumulates into the next stop).
   Gated-out/disabled sessions additionally `snapshots.delete(sessionId)` so
   retention stops with participation.
2. `snapshot = snapshots.get(sessionId)`; absent (enabled mid-session with no
   qualifying request yet, or fully filtered) ⇒ skip (counter unchanged).
3. Cursor protocol over the snapshot (cursor state
   `{ count: number; tail: string }`, `tail` = `JSON.stringify` of the message
   at `count - 1`, the compaction/rewind anchor):
   - **init** (no cursor): cursor := full snapshot, skip — cold or resumed
     history is never review-billed;
   - **reset** (`snapshot.length < cursor.count` or anchor mismatch — history
     rewritten by compaction/rewind): cursor := full snapshot,
     `drops.cursorReset++`, skip;
   - otherwise the window is `snapshot.slice(cursor.count)` filtered to drop
     every message whose `source.kind` is in the injected-source denylist
     (verbatim in the implementation: `memory` —
     `packages/memory/memory/src/recall.ts:204`; `cc-subagent-children`;
     `cc-workflow-completion`; `turn-rules` —
     `packages/interaction/turn-rules/src/matcher.ts:10-15`; `plugin` —
     hand-built side lanes stamp it, `side-query/src/index.ts:112`; and
     `advisor` itself). Mirrors the recall/turn-rules lists rather than
     importing them (no shared export exists); the implementation file carries
     the KNOW-YOUR-INJECTOR comment from `recall.ts:198-203`: any new injected
     kind must be added to all copies.
   - **empty window** after filtering ⇒ advance cursor, skip.
   - **no genuine user message** in the filtered window ⇒ advance cursor,
     skip. Genuine user = `(source === undefined || source.kind === 'user')`
     with ≥1 non-empty text block (the `kind: 'user'` disjunct is mandatory:
     headless/SDK/ACP/plan-mode-steer input is attributed — harness
     `headless/src/index.ts:199`, `sdk/server/src/server.ts:189`,
     `acp/src/session.ts:293`, `plan-mode/src/index.ts:258`; kind defined at
     `dsh-llm message.ts:103`). This rule is BOTH the spend guard (no review
     when the user said nothing) and the wake-loop break (a re-opened
     advisory turn's window contains only `advisor`-kind input plus the
     assistant's reply — no genuine user message ⇒ never re-reviewed).
     Mid-turn steer text appears inside the enclosing turn's window and is
     reviewed with it — uniform turn-end semantics, N2 accepted.
4. **Review:** capture `{ window, rendered (§render below), capturedTurn =
   state.turnCounter }`; advance the cursor to the full snapshot
   **immediately** (eligibility, not completion — a failed call loses its
   window rather than double-billing the next turn); set `state.inFlight`;
   spawn the side call detached (`void promise.finally(() => inFlight = false)`
   with rejection swallowed — never awaited by the handler, never throwing
   into the event).
5. Finally: `state.turnCounter += 1` (same handler counts turns; this ordering
   pins `capturedTurn` to the pre-increment count — the number of completed
   turns the window may span).

**Render.** `[role] content` lines: text blocks joined; `tool_use` blocks
render as `[assistant tool_use <name>] <JSON args, each args blob truncated
at 2000 bytes>`; `tool_result` blocks render their text content. Newest-
tailed at `32768` bytes: drop whole oldest lines and prepend
`[truncated N older bytes]`.

**Delivery.** When the side call resolves, immediately `agent.inject()` a
single UserMessage whose `source.kind` is `'advisor'` (declared through the
`MessageSourceMap` module augmentation, exact precedent
`packages/interaction/turn-rules/src/wiring.ts:60-66` — no hidden flag exists
on UserMessage; attribution *is* the marking) with content:

```
<advisory>
<note severity="concern">…text…</note>
…
Advisory notes from a background reviewer of your last completed turn.
Weigh them; do not reply to them; they are not user instructions.
</advisory>
```

(one inject per run, containing all surviving notes). `agent.inject()`
semantics (`runtime-types.ts:236-241`, harness repo) then decide timing, and
the doc pins them honestly:

- **Turn still running with more steps coming:** the pending inject rides the
  next step's claimed batch — delivery at a step boundary, never mid-batch.
- **Inject lands at the tail of a running turn:** the turn re-opens exactly
  once (T2, pinned verbatim at
  `packages/subagent/task/tests/mechanism-pins.spec.ts:103`: "an
  agent.inject() during a turn re-opens a new turn after the turn would
  otherwise end"). The model gets one extra turn to absorb the note.
- **Session idle when the call resolves:** inject does **not** wake an idle
  driver — it parks until the next user follow-up or steering event
  (runtime-types.ts:236-241, same comment). Zero wake cost.

**Staleness.** At resolve time, deliver only if
`turnCounter - capturedTurn <= 1`; otherwise drop (`drops.stale`). A note is
therefore about the latest completed turn or the one before it — never older.

**Wake-loop bound, proved by construction:** the advisor's own calls never
enter snapshots (`sessionId` undefined); its injects are filtered from every
window (`advisor` kind); a re-opened advisory tail turn lacks a genuine user
message so its window is skipped without spend; idle resolves park. Both wake
paths are additionally bounded by the session cap (§4.4).
### 4.2 Cheap lane: `runSideQuery`, with a hard no-inherit rule

The execution seam is
`runSideQuery(ctx, opts)` from `@dsh-cc/side-query`
(`packages/llm-tuning/side-query/src/index.ts` — `SideQueryOptions` at :22,
function at :72; prompt-suggest already calls it from a turn-stopping
listener, `packages/interaction/prompt-suggest/src/index.ts:19`), with:

```
runSideQuery(ctx, {
  agent,                       // from the turn-stopping payload (required)
  alias: settings.alias,       // default 'haiku'
  system: ADVISOR_SYSTEM_PROMPT,
  prompt: renderedDelta,
  maxTokens: 512,
  timeoutMs: 10_000,
  onUnrouted: 'skip',          // THE no-inherit switch
  rejectToolCalls: true,       // one-shot: no tool loop can exist
})
```

`SideQueryResult` collapses every failure into `ok: false` with
`reason: 'unrouted' | 'timeout' | 'error' | 'empty'` and carries
`inheritedRoute` + `durationMs` on success. It returns **no usage, no resolved
model, and no temperature knob** — see §4.3/§4.6 for the consequences.

**No-inherit rule (§4.2 of round-1, re-mechanized).** `onUnrouted: 'skip'`
makes an unconfigured alias return `{ok:false, reason:'unrouted'}` *without
touching the parent route* — silent main-route inheritance (zero savings,
double cost; the shunt haiku-lane lesson, workspace memory
`dsh-cc-shunt-plugin-pr14` / `side-queries-gap-analysis`) is impossible by
construction. On the first `unrouted` (or `inheritedRoute: true`) result in a
session, the advisor disables itself for that session with one debug line and
one journal entry (`reason: 'unrouted'`). For the journal's model field,
resolve the alias up front with
`resolveAlias(ctx, alias)`
(`packages/compat/cc-model-aliases/src/service.ts:120-134`, returns
`ResolvedRoute | undefined`); `resolveDetailedAlias` (:147+) exists if the
inherited flag needs explaining. Alias accepts any user alias, so
glm/opus-class lanes remain one config line away.

### 4.3 Advisor prompt and output contract

System prompt (`ADVISOR_SYSTEM_PROMPT`, authored and versioned in the
package): role (a read-only reviewer of one completed turn of a coding
session), input format (rendered `[role]` delta lines), severity taxonomy
(`nit` = minor/style; `concern` = likely problem worth one mention;
`blocker` = user-visible harm in progress, e.g. ignoring an explicit
instruction or a destructive command about to run), and the empty case
contract: **answer `{"notes": []}` when nothing is worth saying — empty is
the common case.**

User prompt: the rendered delta of §4.1 (≤ 32 KiB after truncation marker).

Output parsing, deterministic and exact:

1. Strip at most one surrounding ```` ``` ```` fence if present; the remainder
   must be raw JSON.
2. Validate against zod:
   `z.object({ notes: z.array(z.object({ severity: z.enum(['nit','concern','blocker']), text: z.string().min(1).max(500) })).max(16) })`.
3. Any parse/validation failure ⇒ `drops.malformed++`, deliver nothing.

There is no `temperature` knob on the side-query seam (§4.2): determinism
comes from this contract plus drop-on-malformed, not from sampling flags.
`maxTokens: 512`, `timeoutMs: 10_000` (side-query composes its own timeout
signal; the listener passes no caller signal — disposal is preset remount).

### 4.4 Emission guard (ported from omp, deviations stated — see Appendix A)

In-package, per-session state, applied in this fixed order — every drop
increments its named journal counter:

1. **severity filter**: drop notes whose severity is not in
   `settings.severities`.
2. **normalized denylist**: normalize each note's text (lowercase → NFKC →
   fold every non-alphanumeric run to one space → trim — omp's exact shape,
   `emission-guard.ts:33-39` `normalizeAdvisorNote`), then drop on *exact
   membership* in the verbatim omp phrase set
   (`SUPPRESSED_NORMALIZED_PHRASES`, omp `emission-guard.ts:52-89`):
   `stop, stop here, stop now, halt, abort, done, task done, task complete,
   complete, finished, ok, okay, ok done, no issue, no issues,
   no issue continue, no concerns, no concern, nothing to add,
   nothing to flag, nothing to report, no notes, no further input,
   no further input needed, no further input required,
   no further watcher input, no further watcher input needed,
   no further advice, no further advice needed, lgtm, looks good, all good,
   agent is on track, agent on track, on track, continue, carry on`
   (37 entries; copy them into a `Record<string, true>` exactly as omp does).
   Exact-set semantics: `"Stop."` normalizes to `stop` and matches; substring
   matching is **not** the design, and a genuine blocker like
   `"Stop: 'await' missing on writeStream.end()"` must NOT match.
   Counter `drops.denylist`.
3. **quarantine** (§4.5). Counter `drops.quarantined`.
4. **dedupe**: fingerprint = normalized note text; per-session LRU of `4096`
   entries (omp `emission-guard.ts` `DEFAULT_HISTORY_CAPACITY`, whose header
   records the 309→92 rationale). A fingerprint seen before ⇒ drop
   (`drops.duplicate`). Deliberate deviation from omp: dedupe is *flat* —
   "shown at most once regardless of severity" — where omp's is
   severity-escalation aware (`advise-tool.ts:159-163`). Flat is simpler and
   errs toward silence.
5. **immune window**: if `turnCounter < state.immuneUntil`, drop fresh
   `concern` notes (`drops.immune`); `nit` and `blocker` are unaffected by
   immunity. After every *delivered* run that contained ≥1 `concern` or
   `blocker`, re-arm `immuneUntil = turnCounter + settings.immuneTurns`
   (default 3, matching omp's `advisor.immuneTurns` default,
   omp `settings-schema.ts:397-398`). Arithmetic is exact: delivery at turn
   N suppresses concerns for turns N, N+1, N+2 — exactly `immuneTurns` turns,
   matching omp's `completedTurns < start + immuneTurns`
   (omp `advise-tool.ts:75`). Pure compare-and-set; no timer state.
6. **per-run budget**: deliver at most `settings.budget` (default 2 — omp's
   default is 4, `ADVISOR_DEFAULT_BUDGET_PER_UPDATE` at
   `emission-guard.ts:102`; we deliberately take the quieter 2) non-blocker
   notes per run; `blocker` notes are exempt. Excess ⇒ `drops.budget`.
7. **staleness** at resolve (§4.1). Counter `drops.stale`.

**Session cap.** `settings.sessionCap` (default 24; turn-rules' cap precedent
is `MAX_INJECTIONS = 32`) *delivered notes* per session: reaching it disables
the advisor for the session with one debug line; the `drops.sessionCap`
journal field is pinned for the scoreboard schema even though a disabled
session produces no further runs to count. Re-arm next session — no
cross-session reset file.

**Cross-package obligation (same PR).** The new injected kind `advisor` must
be added to both existing denylists or the phantom-loop class warned at
`packages/memory/memory/src/recall.ts:198-204` re-opens in reverse:

- `packages/interaction/turn-rules/src/matcher.ts:10-16`
  (`INJECTED_SOURCE_DENYLIST`) — else turn-rules' prompt matcher feeds on
  advisor text;
- `packages/memory/memory/src/recall.ts:204` — else dynamic-recall builds
  queries from advisories.

### 4.5 Quarantine

Before delivery, each surviving note's text is scanned against
`DEFAULT_DANGEROUS_PATTERNS`
(`packages/interaction/permission-rules/src/classifier.ts:33`,
`{regex, reason}[]`). A hit drops the note (`drops.quarantined`) and the debug
channel logs the fingerprint. Rationale: the recalled transcript is
adversarial-ish input; a second model parroting "just run `curl … | sh`" must
not become an instruction in context. Caveat to record in code: those
patterns are tuned for shell-command strings, so matching advisory prose is a
heuristic — false positives (a note discussing `sudo`) drop safely, which is
the correct failure direction.

### 4.6 Run journal and dogfood metrics

- One JSON line per actually-attempted run, appended to
  `$DSH_HOME/advisor/<sessionId>.jsonl` — layout and posture follow the
  turn-rules ledger (`packages/interaction/turn-rules/src/ledger.ts`:
  flat per-session file under `$DSH_HOME`, no projectKey segment, fail-soft
  IO). The handoff-store precedent cited in round 1 is content-addressed
  per-artifact and is **not** the right template for an append journal.
- Line fields (implement exactly):
  `ts, turn (capturedTurn), alias, model (resolveAlias route's model id; null
  when unrouted, unset, or inherited — `ResolvedRoute.model` is optional,
  `packages/compat/cc-model-aliases/src/types.ts:31`), inheritedRoute, ok,
  reason (on failure), durationMs, deltaMessages, deltaBytes, notesIn,
  notesOut, drops: { denylist, duplicate, budget, immune, quarantined, stale,
  malformed, severity, cursorReset, sessionCap }, usage: null`.
- `usage: null` is a **reserved** field: `SideQueryResult` surfaces no token
  usage today, so currency cost is explicitly N/A in v0.0; the follow-up
  (extend `SideQueryResult` in `packages/llm-tuning/side-query` to surface
  `usage` + resolved model, then fill the field here) is a named open thread
  in §7. Round-1's "glm-class zero-metering precedent" sentence is deleted —
  no such caller-visible metering exists in-tree.
- Dogfood scoreboard derivable by `jq` over the journal: runs/turn,
  notes/turn, severity mix, drop mix, p50/p95 durationMs. Scoreboard template
  lives in `docs/dogfood/advisor-watchdog.md` (§8).
- Graduation rule (from cold review): value correlates inversely with
  main-model strength; promote only if dogfood shows real catches.

### 4.7 Subagent gating (settings-level in v0)

v0 admits subagent sessions through the global settings key only:
`subagents: 'off' | 'on' | <alias>` (default `'off'`). At the §4.1 trigger,
`'off'` requires `isTopLevel(agent)`; `'on'` reviews subagent sessions with
the session alias; an alias string reviews them with that alias. Advisor
state is always keyed by the subagent's own session id (`agent.session.header.id`),
and child notes never climb to the parent transcript — the inject goes to the
subagent's own agent handle.

**Deferred (recorded, not implemented):** the per-definition frontmatter key
`advisor: false | true | <alias>` was designed (round 1–3) and then DROPPED
in round 3b: the harness `Agent` listener handle carries no definition member
(harness `packages/core/agent/src/types.ts:13`), so a preset-level listener
cannot read which agent definition a session was spawned from, and the
harness repo is read-only by user directive. A dsh-cc-side revival would need
a spawn-time preference registry (written at
`packages/compat/cc-plugin-loader/src/agents.ts:159-164` and
`packages/subagent/task/src/tool.ts:306-310` — the `resolveSpawnEffort`
consumption sites from PR #108,
`packages/compat/cc-model-aliases/src/agentOptions.ts` — read back by this
advisor keyed on session id) plus the parser/type sites
(`packages/preset/claude-code-agents/src/parse.ts` `buildAgent` :118-170 and
`types.ts`; frontmatter keys are whitelisted there). Tracked in §7. The
settings-only gate is honest on its own: no parsed-but-undelivered key.
### 4.8 Rollout posture (cold-review condition)

`enabled` default false, user-layer opt-in first, one recorded dogfood week
before any discussion of defaulting. Precedent: prompt-suggest ships
`enabled: false`
(`packages/interaction/prompt-suggest/src/settings.ts:29-34,45-46`) and
post-edit-verify graduates only through the dogfood doc.

### 4.9 Settings

Kebab namespace `cc-advisor`, registered with the **turn-rules dual-half
pattern** (`packages/interaction/turn-rules/src/settings.ts:8-40`):
`registerNamespaceSafe` for the settings surface **plus** a raw user-layer
`<dshHome>/settings.json` re-read at each trigger, so a turn never depends on
cascade timing. Keys (kebab in the section body, zod, user layer scope, all
absence-preserving):

| key | zod type | default |
| --- | --- | --- |
| `enabled` | `z.boolean()` | `false` |
| `alias` | `z.string()` | `'haiku'` |
| `budget` | `z.number().int().min(1).max(8)` | `2` |
| `immune-turns` | `z.number().int().min(0).max(8)` | `3` |
| `session-cap` | `z.number().int().min(1).max(256)` | `24` |
| `severities` | `z.array(z.enum(['nit','concern','blocker']))` | all three |
| `subagents` | `z.union([z.literal('off'), z.literal('on'), z.string()])` | `'off'` |

Guarded `dshHomeOf(ctx)` read copied from turn-rules `wiring.ts:32-39`
(cordis throws on the property access itself; wrap in try/catch).

### 4.10 Capability manifest impact (implementation PR, same commit)

Net-new dsh-cc surface with no CC counterpart — add one entry to
`docs/claude-code-capabilities.yaml` modeled **verbatim** on
`engine.subagent-handoff` (:828-858): keys
`title / category: engine / plane: preset / upstream: { summary: "Not an
upstream CC surface: a dsh-cc extension …", refs: [] } / dimensions:
{ recognized, mounted, behavioral, ux } / evidence: [{type: source|test,
path, anchor?}] / deviation: { kind: divergent, summary }` (observed
deviation kinds in-file and in `scripts/check-capability-evidence` tests are
`none` and `divergent` — this entry is `divergent`). Evidence rows must name
the preset row and the new package's spec files. Then `pnpm docs:parity` and
commit the regenerated matrix + README block; `pnpm check:capabilities` and
`pnpm check:parity` gate it.

### 4.11 Package and preset plumbing checklist

New package `packages/interaction/advisor-watchdog`, `@dsh-cc/advisor-watchdog`
— plain cordis plugin, no Service, so **no new isolate key** (the
`composition.spec.ts:185-188` "twelve cc-services services" assertion stays at
twelve). Executor follows this checklist (every item has a turn-rules twin):

1. `package.json` (name `@dsh-cc/advisor-watchdog`, `type: module`, scripts)
   mirroring turn-rules' **actual dependency split**
   (`packages/interaction/turn-rules/package.json`): harness packages
   (cordis / dsh-agent / dsh-llm / dsh-session / dsh-settings / schemastery as
   the sibling declares them — peers vs devDependencies with `link:`
   overrides exactly as the sibling declares) and workspace deps
   `@dsh-cc/side-query`, `@dsh-cc/permission-rules`, `@dsh-cc/model-aliases`
   in the same sections the sibling puts its own workspace deps. Do not
   improvise the split — copy the sibling's
   peerDependencies/devDependencies layout and extend it.
   `tsconfig.json` copied from `packages/interaction/turn-rules/`.
2. README trio `README.md` + `README.zh.md` + `README.i18n.yaml` (gated;
   sibling has all three).
3. Source layout mirroring turn-rules: `src/index.ts` (apply + listener
   registration), `src/wiring.ts` (the two listeners + state), `src/state.ts`,
   `src/settings.ts` (dual-half), `src/delta.ts` (cursor/filter/render),
   `src/advise.ts` (side-query envelope + zod parse), `src/guard.ts`
   (normalize/denylist/dedupe/budget/immune), `src/quarantine.ts`,
   `src/journal.ts`.4. `packages/preset/cc/agent.cordis.yml`: new row in the `cc-services`
   config group placed **after** the `turn-rules` row (physical placement:
   appended at the group tail, after `prompt-suggest`, to minimize churn)
   with a comment citing this plan and the ordering rationale — turn-rules'
   prompt matcher must see the un-advised prompt.
5. `packages/preset/cc/package.json`: `"@dsh-cc/advisor-watchdog": "workspace:^"`
   dep row.
6. `packages/preset/cc/tests/composition.spec.ts`: extend with assertions
   mirroring the turn-rules block (:223-230):
   `expect(configIds).toContain('advisor-watchdog')`,
   `expect(topIds).not.toContain('advisor-watchdog')`, and the ordering
   tripwire `configIds.indexOf('advisor-watchdog') > configIds.indexOf('turn-rules')`.
   The isolate-map count is unchanged (plain plugin, no Service).
7. Cross-package denylist edits (§4.4) in the same PR.
8. Update this plan's Status line to shipped on merge.
9. `pnpm install` runs **after** every package.json edit and before any
   frozen-lockfile verification (the turn-rules lockfile-timing lesson:
   package.json edits must all precede the final install).

## 5. Verification

- **Unit specs** (new package): guard arithmetic — denylist exact-set hits
  after normalization (`"Stop."` ⇒ drop), dedupe LRU, budget (2 non-blocker,
  blocker exempt), immune window (concerns dropped `< immuneUntil`, re-arm on
  delivery, delivery at turn N suppressing exactly turns N..N+immuneTurns-1),
  session cap; quarantine hits incl. the pipe-to-shell pattern;
  zod malformed/fence-strip paths; window protocol — first-observation skip,
  cursor-advance, injected-kind filtering, no-genuine-user suppression,
  compaction reset-and-skip, 32 KiB oldest-drop truncation; staleness drop
  when `turnCounter - capturedTurn > 1`; `inFlight` accumulate-not-capture;
  `unrouted` ⇒ session-disable; the snapshot listener's sessionId/purpose
  filters (auxiliary lanes excluded by construction).
- **Preset composition**: `composition.spec.ts` extended per §4.11.6 (row
  containment + ordering tripwire; isolate count unchanged).
- **Smoke (spec)**: the cheap lane is stubbed with `ScriptedAdapter`
  registered via `ctx.llm.registerAdapter(['deepseek'], adapter)` — the
  prompt-suggest producer-spec seam
  (`packages/interaction/prompt-suggest/tests/producer.spec.ts:26,80,175`),
  **and** the alias overlay is stubbed too, because the advisor calls
  `runSideQuery` with `onUnrouted:'skip'` (prompt-suggest's spec relies on
  the builtin-alias inherit path + a fake parent route,
  `producer.spec.ts:63`, which `skip` rejects): the test's fake settings
  provider returns for `get('model-aliases')` (namespace constant
  `MODEL_ALIASES_NAMESPACE = 'model-aliases'`,
  `packages/compat/cc-model-aliases/src/service.ts:40`; read seam
  `service.ts:125`) an overlay mapping `haiku → { provider: 'deepseek',
  model: 'scripted' }`, so resolution succeeds onto the scripted adapter.
  Scripted session driven with the agent-loop testkit (already a turn-rules
  devDependency, so the session's main-lane requests flow through the same
  scripted adapter and emit loop-stamped `llm/stream` events): turn 1's
  request is observed as the snapshot; at `agent/turn-stopping` the window is
  captured and the side call fires; the resolved blocker note is delivered
  via `agent.inject()` with source kind `advisor`, and the T2 re-open
  (mechanism-pins.spec.ts:103 contract) is asserted exactly once when the
  follow-up turn runs; the re-opened advisory turn's own turn-stopping must
  NOT spawn a second run (no-genuine-user suppression + `advisor`-kind
  filtering asserted).
- **Dogfood (pre-merge gate for *default-on discussion only*, not for
  merge)**: enable user-layer for one week on this repo. Attach the
  scoreboard (runs/turn, notes/turn, severity mix, drop mix, p50/p95
  durationMs — currency cost N/A until the side-query usage follow-up) plus
  50 hand-labeled notes for precision, **and** the TUI-visibility check:
  whether source-kind-injected user rows render on a re-opened turn (§3 —
  unverifiable from this repo; observe in the dogfood session).

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Advisor noise trains users to ignore it | §4.4 guard (flat dedupe, budget 2, immune window, cap 24) + precision-labeled dogfood before any default-on |
| Advisor as injection vector | §4.5 quarantine + strict JSON contract + `rejectToolCalls: true` one-shot lane + notes marked non-instructions in the injected text |
| Cost ambiguity on shared routes | §4.2 `onUnrouted:'skip'` hard no-inherit + per-run journal with `inheritedRoute`; currency cost deferred to the §7 follow-up and stated as N/A |
| Wake-loop via injects | §4.1 construction proof (advisor calls carry no `sessionId` so they never enter snapshots; `advisor`-kind injects are filtered from windows; a re-opened advisory turn lacks a genuine user message so its stop spawns nothing; idle resolves park) + session cap |
| Latency on turn boundary | the stream listener stores one array reference and returns `next()` immediately; the turn-stopping handler only spawns a detached promise — neither the request path nor the turn ever awaits the advisor |
| Extra main-model turn when an inject lands at a turn tail | bounded by budget/immune/cap; dogfood measures re-open frequency from the journal (`notesOut > 0` runs per turn) |

## 7. Open questions

- Should `blocker` also pause plan-mode approval flows (deliver as an ask)?
  Lean: no for v0 — the injected advisory + T2 re-open is enough signal.
- Multi-advisor rosters (omp's WATCHDOG.yml with per-advisor models/tools)?
  Deferred; one advisor is enough to measure the premise.
- Token metering: extend `SideQueryResult` (`packages/llm-tuning/side-query`)
  to surface `usage` + resolved model, then fill the journal's `usage` field.
  Separate small PR; until then currency cost is N/A (§4.6).
- Per-definition subagent opt-in (the dropped `advisor:` frontmatter key):
  needs the spawn-time preference registry described in §4.7 — defer until
  dogfood shows subagent reviews are worth anything at all.

## 8. DoD

1. `packages/interaction/advisor-watchdog` mounted per §4.11, dark by
   default, §5 specs green.
2. Smoke spec demonstrates `llm/stream` snapshot → turn-stopping capture →
   `runSideQuery(onUnrouted:'skip')` → resolve-time inject with source kind
   `advisor`, the tail re-open path exactly once, and the
   no-genuine-user/skip suppression on the re-opened advisory turn.
3. Journal written per §4.6 with `usage: null`; scoreboard derivable by
   `jq` (template committed).
4. Capability manifest entry added per §4.10; `pnpm check:capabilities` +
   `pnpm docs:parity` + `pnpm check:parity` green.
5. Dogfood plan and scoreboard template committed under
   `docs/dogfood/advisor-watchdog.md`.

## Appendix A — omp porting ledger

Source: `oh-my-pi/packages/coding-agent/src/advisor/` (verified 2026-09-23,
re-verified 2026-09-24). One line per mechanism, so a port reviewer can see
every keep/deviate/drop without re-reading omp.

| omp mechanism (anchor) | Decision | Rationale |
| --- | --- | --- |
| `runtime.ts:365-399` onTurnEnd: turn-end delta render + cursor advance | **Keep** the turn-end shape (`agent/turn-stopping` trigger); **deviate** on the delta source — passive `llm/stream` snapshots instead of omp's in-process transcript (harness pre-step carries only claimed inbox batches, `agent-loop/src/agent.ts:250`; no message-cursor API exists) | turn-end parity without transcript access |
| `advise-tool.ts:20,62-63` + `:161` severity taxonomy `nit/concern/blocker` | **Keep** verbatim, flat dedupe deviation noted (§4.4) | proven taxonomy |
| `emission-guard.ts:34-39` normalize (lowercase+NFKC+non-alnum-fold+trim) | **Keep** verbatim (§4.4) | "Stop." must match "stop" |
| `emission-guard.ts:41-68` `SUPPRESSED_NORMALIZED_PHRASES` exact-set | **Keep** verbatim list + exact-membership semantics (§4.4) | substring matching is not the design |
| `emission-guard.ts` `DEFAULT_HISTORY_CAPACITY = 4096` (309→92 header rationale) | **Keep** | real dogfood numbers |
| `emission-guard.ts:102` per-update budget default 4 (max 32) | **Deviate to 2** | quieter v0; blockers exempt |
| `settings-schema.ts:397-398` `advisor.immuneTurns` default 3 | **Keep** (as drop-concerns window, §4.4; no aside channel exists here to downgrade *to*) | anti-thrash semantics preserved |
| `loop-guard.ts` (repeat-tool-call bound inside the advisor agent loop) | **Drop** | our advisor is a one-shot `runSideQuery` with `rejectToolCalls: true` — no loop exists to guard |
| `delta-split.ts` (multiple user messages so provider cache grows incrementally) | **Drop** | one-shot re-pays the delta as fresh input each run by design; cost bounded by the 32 KiB delta cap, not by transcript size |
| `transcript-recorder.ts` (`__advisor.jsonl` persistence) | **Replace** with §4.6 journal | same purpose, dsh-cc ledger idiom |
| `message-fingerprint.ts` (delivered-prefix replay tracking) | **Drop** | cursor-over-message-tail + staleness arithmetic covers replay (§4.1) |
| `watchdog.ts` / `config.ts` WATCHDOG.yml multi-advisor roster | **Defer** (§7) | one advisor measures the premise |
| quarantine posture (advisor as injection vector) | **Keep**, re-mechanized on `DEFAULT_DANGEROUS_PATTERNS` (§4.5) | in-repo pattern source |
