# Runtime-verified completion: receipts ledger + final-turn evidence gate (design)

- Date: 2026-10-09
- Status: draft v7 — internal critic GO (3 rounds) + external grok GO (3 rounds, 19 findings all folded); **same-day code-verification revision folded (Round 7, §8)**: three formerly-unverifiable facts source-verified at pinned harness 0.2.0-rc.2, H1 fail-open / H2 delegation-lineage / H3 claim-table fixes folded into §3. Delta review on v7: internal critic GO-WITH-AMENDMENTS (5 MINOR/INFO, all folded — §8 Round 7.1) then confirm-round GO with two cosmetic residues also folded; external delta confirm (grok) GO-WITH-AMENDMENTS — BLOCKER (window anchor: judged-message re-anchor) + MAJOR (past-tense phrase) + 6 MINOR/2 clarifications all folded in v7.3 (§8 Round 7.3); review chain CONVERGED: internal critic confirm GO (Rounds 7.1-7.4) + external grok delta GO-WITH-AMENDMENTS (Round 7.3, all folded) → grok micro-confirm GO (Round 7.5, 10/10 folds verified OK). user sign-off pending. NOT yet implemented.
- Scope: new package `packages/interaction/completion-gate`; capability manifest row; preset registration. No harness-upstream dependency. No CC-parity surface change (adds a dsh-cc-only opt-in feature).
- Sources: Goal-Autopilot (durable gated FSM, no-false-success invariant), APEXA (narratives without execution records must not finalize: the same policy as ~700 prompt tokens passed 15 violations while code caught 200/200), Task-State Coupling (transcript→checklist→directive→enforcement ladder), Copperhollow (append-only ledger adjudicates). Calibrated by Malena/12227: this is a *delivery-reliability* feature, not scaffolding intelligence.

## 1. Background and problem

dsh-cc's recurring failure class is **procedural, not cognitive**: a child agent reports
work that never happened (executor fiction report), a spawn fails but leaves partial
workspace mutations, a TUI shows a zombie-busy session. Today the defense is process
discipline written in AGENTS.md ("verification is planned too", "re-check with
git diff --stat") — i.e. the *transcript* tier of the Task-State Coupling ladder.
Every incident postmortem so far has re-learned the APEXA finding: policies held in
natural language leak; the same policy held in code does not.

The synthesis' convergence point: completion must not be accepted from natural
language alone. What is missing in dsh-cc is (a) a machine-readable record of what
was actually executed in this session, and (b) a cheap check at the moment the
agent claims completion.

Probe-verified dsh-cc facts this design stands on (2026-10-09, anchors verified
against this worktree):

- A `tools/post-execute` listener observes every completed tool call with
  `exec.name`, `exec.callId`, `exec.arguments`, `exec.agent?`, and a result union
  `ToolExecutionSuccess | ToolExecutionFailure` carrying `isError`, `content`,
  and `error.info?.code` when the tool threw a `HarnessError`
  (`packages/core/tools/src/tool-types.ts:119-144,269-293`; listener precedent
  `packages/context/context-crusher/src/index.ts:151-168`).
- `agent/turn-stopping` fires with `{agent, turn, signal}` at turn end
  (registrations: `packages/interaction/turn-rules/src/wiring.ts:145`,
  `packages/interaction/advisor-watchdog/src/wiring.ts:99`).
- A blocking Stop hook steers the agent to continue
  (`packages/hooks/hooks-claude-code/src/turn-safety.ts:141-146`), capped by
  `DEFAULT_STOP_BLOCK_CAP = 8` (`:21`) — background only: forced continuation is
  an established, bounded mechanism (the cap counts *consecutive* blocks; the
  counter resets on release/override). This design does NOT deliver via steer.
  Same-turn continuation is **code-verified at the pinned harness**
  (0.2.0-rc.2, `deepseek-harness` `packages/core/agent-loop/src/agent.ts:359-363`):
  `agent/turn-stopping` is dispatched only when the next-step inbox is empty,
  and after `await dispatch.serial(...)` returns the loop re-checks the inbox —
  a message injected *synchronously* inside a turn-stopping listener is seen by
  that re-check, so the SAME turn continues with target `next-step` (no
  `turn/end`, no turn N+1); a detached inject lands too late for the re-check
  and opens a follow-up turn via the `hasPending` path (`agent.ts:390`) instead.
  This design delivers the nudge **synchronously** (§3.4); the inject CALL
  SHAPE follows advisor-watchdog
  `packages/interaction/advisor-watchdog/src/wiring.ts:314-317`, whose smoke
  pin (`tests/smoke.spec.ts:153-158`) covers the detached → new-turn case
  only. This package pins the synchronous → same-turn-continuation case
  itself (§5.6); T2 (`mechanism-pins.spec.ts:103-126`) pins pre-step
  injection only and is not the boundary pin.
- The assistant's final message text is readable in-process by walking
  `agent.session.snapshotEvents()` for the last `assistant/message`
  (precedent: `packages/interaction/prompt-suggest/src/index.ts:102-116`).
- `agent.inject` queues a durable next-step message; at a turn boundary it
  makes the agent continue (pin:
  `packages/subagent/task/tests/mechanism-pins.spec.ts:103-126`; mechanism
  anchor above). The turn-end continuation is exactly why one-shot-notice
  moved to batch-append delivery (its idle-wake phantom loop was caused by
  inject continuing a settled turn —
  `packages/subagent/task/src/one-shot-notice.ts:7-11`). Turn-stopping — and
  therefore this gate's evaluation — does NOT fire when the user queued a
  next-step message during the turn (§3.6). Idle-settled injects are dropped
  by the memory-recall idle guard
  (`packages/memory/memory/src/recall.ts:360-364`).
- All transcript events are observable in-process via
  `ctx.on('session/event', (session, event) => …)`
  (precedent `packages/hooks/hooks-claude-code/src/register-events.ts:264`).
- Plugins can append custom typed session events via `session.append(type, data)`
  with a `SessionEventMap` module augmentation (pattern:
  `packages/hooks/hook-protocol/src/types.ts:8-9`; harness `Session.append` is
  documented at the session class, and `session/created` hands a plugin the live
  `Session` — precedent `packages/interaction/permission-rules/src/index.ts:294`).
  **Custom-event append is legal in any turn state**: the session invariant
  checker constrains core execution events only; plugin types fall through its
  default branch (harness@c1b47e41 `packages/core/session/src/invariant.ts:165-167`),
  so appending at `agent/turn-stopping` time is safe. `append()` throws only on
  non-JSON data, re-entry, or core-rule violations
  (`packages/core/session/src/index.ts:707-773`); this design still wraps every
  append in try/catch + debug-log (§3.2).
- **Resume replay of custom events is verified at the pinned harness.** The
  persistence read path refuses a log containing a type unknown to the build
  and not marked `ignorable`
  (`packages/session/session-persistence/src/storage-contract.ts:75-77`); dsh-cc
  plugin types become "known" via the live-Set `KNOWN_SESSION_EVENT_TYPES`
  registration at plugin load, so this feature's three event types replay
  across `/resume` whenever the plugin is installed. Caveat, stated plainly:
  live `Session.append()` cannot set `ignorable` (the envelope it builds has
  no such field — `packages/core/session/src/index.ts:744-750`; corroborated by
  the harness knowledge note
  `packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md:21`),
  so a session written with these events is unresumable on dsh-cc builds
  WITHOUT the plugin — the same exposure `worktree/entered`, `permission/mode`
  and the gauge events already carry; precedent-consistent, §3.2/§4/§7.6.
- `SessionEvent.time` is `Date.now()` epoch ms at append
  (`packages/core/session/src/index.ts:747`) — **verified**; windows here still
  use snapshot ORDER (§3.3) and `ts` remains forensics-only.
- Nudge attribution across delegation: a subagent session's header carries
  `parentSession` (observed in real transcripts; header fields at
  harness@c1b47e41 `packages/core/session/src/types.ts:94-122`) — this is what
  makes the lineage lift in §3.2 possible without depending on whether
  `session/created` fires for child sessions.

## 2. Goals and non-goals

Goals:

1. **Receipts ledger (R).** Every tool execution in a session appends one
   machine-readable receipt: what tool, args digest, outcome class, content hash.
   Durable, append-only, per session.
2. **Evidence nudge at turn-stopping (N).** If the final assistant message makes a
   verifiable completion claim (tests run, commit created, CI green, …) with no
   matching receipt since the last genuine user message, nudge the agent once with a
   correction ("claim X has no executed record; verify or retract") instead of
   silently accepting. Soft, capped, never blocks delivery.
3. **Transcript anchoring.** Receipts and nudges are also appended as session
   events so `session-forensics`, `/learn`, and dogfood audits can consume them
   without new readers.

Non-goals (explicit):

- **No NL semantic claim extraction beyond a fixed claim-pattern table.**
  Parsing arbitrary prose is LLM work; falsifiability discipline (§6) applies to
  any future learned detector, which is out of scope for this change.
- **No hard gates in interactive sessions.** A hard "cannot stop" FSM
  (Goal-Autopilot style) is reserved for unattended/background completion paths
  and is future work (§7), because the Stop-hook mechanism that would underlie
  it has a hard cap of 8 *consecutive* forced continuations (counter resets on
  release/override) whose budget must not be spent by this feature.
- **No orchestrator-side verification of subagent final reports.** That surface
  is the Task tool result path (different package, different problem: the
  orchestrator, not the child session, is the claimant's audience). Follow-up, §7.
- **No rewrite of hook verdict-fold semantics.** This feature does not touch
  PreToolUse/approval paths.

## 3. Design

### 3.1 Package and registration

New package `packages/interaction/completion-gate` (`@dsh-cc/completion-gate`),
plain cordis plugin (no `Service` subclass — avoids the isolate-realm requirement;
precedent: `packages/subagent/handoff-store` is a plain plugin for the same
reason). Package layout copies advisor-watchdog: `src/index.ts`, `src/settings.ts`,
`src/wiring.ts`, `claims.json`, `tests/`.

Registration checklist — same-commit, all of it:

1. **cc-services row** in `packages/preset/cc/agent.cordis.yml`, placed after the
   `advisor-watchdog` row (plain plugin, no `isolate` key).
2. **Composition pin** in `packages/preset/cc/tests/composition.spec.ts`:
   `configIds` contains the plugin, `topIds` does not (plain plugin), index
   after advisor-watchdog.
3. **`MessageSourceMap` augmentation** for the injected source kind:
   `interface MessageSourceMap { 'completion-gate': { kind: 'completion-gate' } }`
   (precedent: `packages/interaction/advisor-watchdog/src/wiring.ts:40-44`).
4. **`SessionEventMap` augmentation** for all three event types
   `completion-gate/receipt`, `completion-gate/nudge`, `completion-gate/resolved`
   (pattern: `packages/hooks/hook-protocol/src/types.ts:8-9`).
5. **`KNOWN_SESSION_EVENT_TYPES` registration at module load** for the three
   event types — the persistence read path refuses logs whose event types are
   unknown to the build and not marked `ignorable` (harness@c1b47e41
   `packages/session/session-persistence/src/storage-contract.ts:75-77`), and
   dsh-cc's registration idiom is the live-Set add at module load
   (`packages/workspace/session-cwd/src/events.ts:24`; same pattern in
   `packages/interaction/permission-rules/src/mode.ts:29`), which makes the
   process's read path treat them as known. Stated honestly: sessions written
   with these events are unresumable on dsh-cc builds without the plugin
   (live `Session.append()` cannot set `ignorable` — §1); the same exposure
   as `worktree/entered` and `permission/mode` — accepted, precedent-consistent
   (upstream-seam follow-up §7.6).
6. **Injected-source denylists — all THREE copies updated in the same commit**
   (`'completion-gate'` added to each): `packages/memory/memory/src/recall.ts:204`,
   the turn-rules matcher (`packages/interaction/turn-rules/src/matcher.ts`), and
   `packages/interaction/advisor-watchdog/src/delta.ts:24`
   (`INJECTED_SOURCE_DENYLIST`). Pre-existing drift (verified 2026-10-09, all
   three lists DO already include `cc-workflow-completion`): `recall.ts:204`
   additionally lacks `turn-rules` and `plugin`; the turn-rules matcher
   additionally lacks `plugin` (only `delta.ts:24` has all). Record that drift;
   add `'completion-gate'` to all three; do NOT reconcile the pre-existing
   divergence here (out of scope — §7 follow-up). A fourth producer kind exists
   in transcripts and is in NONE of the three lists (pre-existing; recorded,
   not reconciled): `'hooks-claude-code'`, stamped on Stop-hook steer/context
   messages (`turn-safety.ts:18`, used at :146). Impact on this feature: none —
   the skip rule matches only our own kind and window start requires a genuine
   user message (§3.3), so a `'hooks-claude-code'` message neither opens the
   window nor suppresses the gate.
7. Capability manifest row in `docs/claude-code-capabilities.yaml` regenerated
   via `pnpm docs:parity`; package README trio (gate: `pnpm check:capabilities`,
   README hash gate).

### 3.2 Receipts ledger

Listener: `ctx.on('tools/post-execute', handler, { prepend: true })` (same slot as
CCR so receipts see pre-crush content; CCR is `{prepend:true}` only —
`packages/context/context-crusher/src/index.ts:167`; the `{global…}` part of the
registration belongs to the `llm/stream` listener, not this one). The handler
hashes `result.content` **before** calling `next()`, so receipts always capture
pre-crush text and are **registration-order-independent** — CCR's rewrite
happens post-`next()` in the same outer-listener composition. A unit test
asserts the recorded hash survives a downstream rewrite (§5.12); composition
pins assert row placement only (§5.9).

Per execution, compute and append R:

```jsonc
// one JSONL row per tool execution
{
  "v": 1,
  "ts": 1712345678901,              // Date.now()
  "sessionId": "tui-…",             // exec.agent?.session?.id ?? null
  "callId": "call_…",               // exec.callId
  "tool": "bash",                   // exec.name, canonical id (not CC alias)
  "argsDigest": "9ab3…",            // sha256(stableJson(exec.arguments))[:16];
                                    // stableJson = LOCAL sorted-key canonical
                                    // JSON helper (sorted keys, no whitespace) —
                                    // do NOT import across packages
  "outcome": "ok" | "error",        // result.isError
  "errorCode": "FS_AMBIGUOUS_EDIT" | null, // result.isError ? result.error.info?.code ?? null : null
  "contentHash": "f00d…",           // sha256(concat text blocks)[:16]
  "textBytes": 1234,                // sum of text block byte lengths
                                    // (truncation UTF-8-safe: Buffer.byteLength
                                    // + subarray, turn-rules truncateUtf8
                                    // precedent)
  "head": "pnpm test …"             // bash rows ONLY, ≤200 bytes: first 200 bytes
                                    // of exec.arguments.command (the CC-alias
                                    // bash variant maps to the same tool and the
                                    // same field). SESSION EVENT ONLY: `head` is
                                    // OMITTED from the JSONL ledger row entirely
                                    // (JSONL ledger is hash-only; matching
                                    // reads in-session events only).
                                    // Written only when cc-completion-gate.enabled
                                    // is true at execute time (§3.5)
}
```

Rationale for the fields: `argsDigest`/`contentHash` let later steps correlate
claims to executions without persisting content (privacy + size, precedent:
permission classifier digest-only audit at
`packages/interaction/permission-rules/src/classifier-audit.ts:20-25`);
`errorCode` is nullable because only `HarnessError`-derived failures carry it
(`packages/core/tools/src/abort-utils.ts:28-34,102-124`).

Two append targets per execution:

1. **Ledger file** `<dshHome>/completion-gate/receipts/<sessionId>.jsonl`
   (flat per-session layout — no per-project sharding subdirectory: YAGNI,
   single global sweep covers it) — written **detached**: after returning the
   decision, the row is scheduled via `void appendFile(...).catch(debugLog)`
   (fire-and-forget; torn-line risk accepted as ledger is forensics-only).
   When `sessionId` is null the disk write is **skipped entirely** (no
   `_unassigned.jsonl`; it would have no size cap). The listener is
   **observe-only**: it never modifies the decision — errors
   are caught and debug-logged; the decision is returned untouched.
2. **Session event** `session.append('completion-gate/receipt', R)` when
   `exec.agent?.session` is reachable, wrapped in try/catch + debug-log
   (hot-path discipline; append legality in any turn state is verified — §1).
   Type declared via module augmentation:

   ```ts
   declare module '@deepseek-ai/dsh-session/types' {
     interface SessionEventMap { 'completion-gate/receipt': Receipt }
   }
   ```

   (augmentation pattern: `packages/hooks/hook-protocol/src/types.ts:8-9` — the
   typed `Session.append` face then accepts the three types directly. The
   widened-face cast used by session-cwd / permission-rules exists for THEIR
   own pin ("type absent from the typed map") and does not bind this package;
   both idioms compile today.)

**Nudge evaluation reads the in-session `completion-gate/receipt` events
(in-memory, typed) plus the lineage bucket below — NOT the JSONL disk file.**
The JSONL ledger is forensics/dogfood-only (and the sole cross-process record:
child-session receipts live in child logs, and a `/resume` reboots the
lineage map).

**Lineage lift (delegated evidence).** The receipts listener also maintains a
process-live `parents: Map<sessionId, parentSessionId | undefined>`, learned
lazily at record time from `exec.agent.session.header.parentSession`
(memoized per session id; no dependency on `session/created` firing for child
sessions). When the owning session's parent chain (depth ≤ 8, cycle-guarded)
leads to a different top-level root, the lift entry `{ tool, head?,
stampedOrdinal }` is also pushed onto the root's bucket in a process-live map;
`stampedOrdinal` = the count of genuine `user/message` events in the root
session's CURRENT view, produced by ONE counting procedure over
`snapshotEvents()` (same genuine predicate as §3.3) — invoked at lift time for
stamps and at evaluation time for the window start, so stamps and window
ordinals can never drift from two different counting procedures (a firehose
counter seeded by snapshot scans CAN drift: `Session.append` publishes after
the push, and restored seed events never publish — noted in Round 7.3). The
`ctx.on('session/event', (session, event) => …)` listener
(`packages/hooks/hooks-claude-code/src/register-events.ts:264` precedent) only
maintains a session-id → Session registry for the lift lookup
(WeakMap/WeakRef-keyed; entries die with their Session). Only claim-relevant
fields lift (`tool`, scrubbed `head`) — satisfaction needs execution-existence,
not digests. `parentSession` provenance: the in-process spawn/fork delegation
drivers write it (pinned by harness `subagent-spawn-in-process.spec.ts:106-112`
and `subagent-fork-in-process.spec.ts:129`; ralph observes it end-to-end in
`tool-ralph/tests/integration.spec.ts:116`); a delegation route that does not
write it yields unwitnessed children, covered by the horizon fail-open (§3.4).
Satisfaction semantics: §3.3 step 3; degraded-horizon rule: §3.4; blind
corners: §4.

Ledger hygiene: a single global sweep at plugin boot keeps the newest 100
session files across `<dshHome>/completion-gate/receipts/`
(disk-readdir+mtime precedent from handoff-store —
`packages/subagent/handoff-store` design note). No `ledgerRetentionFiles`
config knob: YAGNI, the constant lives in code.

### 3.3 Claim detection

At `agent/turn-stopping` (`{agent, turn, signal}`):

1. Read the final `assistant/message` text by walking
   `agent.session.snapshotEvents()` — walking the `{type, data}` entries like
   prompt-suggest does (`packages/interaction/prompt-suggest/src/index.ts:107-110`);
   Turn guard: the judged message MUST satisfy `data.turn === turn` from the
   turn-stopping payload (`assistant/message` carries the field) — an aborted
   or errored turn that produced no assistant message must NOT recycle an
   earlier turn's final message; skip evaluation entirely (§5.15 pins this).
   the source is read off **`event.data.source`** (a session event's top level
   carries no `source` field). **Skip rule:** nudge detection is skipped ONLY
   when the latest `user/message` preceding the JUDGED assistant message has
   `data.source.kind === 'completion-gate'` — i.e. our own nudge. (A same-turn
   nudge continuation lands that message mid-turn, so both rules anchor to the
   judged message, never to `turn/start` — pinned by §5.15.)
   **Window start is anchored to the JUDGED assistant message** — the final
   `assistant/message` of the stopping turn (the claim carrier) — NOT to the
   turn boundary. The harness appends `turn/start` BEFORE the turn's own
   `user/message` (`deepseek-harness`
   `packages/core/agent-loop/src/agent.ts:305` vs `:419-422`, first attempt of
   step 1), so a turn/start-anchored window would count the PREVIOUS turn's
   receipts as evidence for this turn's claim — the exact steady-state failure
   this gate exists to stop (window rule fixed in Round 7.3). Window start =
   the last **genuine** `user/message` (`data.source` absent or
   `data.source.kind === 'user'`; note this is the session-event analogue, NOT
   the `isGenuineUser` llm/stream `DeltaMessage` helper at
   `packages/interaction/advisor-watchdog/src/delta.ts:69-73`, which reads a
   different shape) whose `seq` precedes the judged message. If none exists
   (session opening, goal-driven openings), the window runs from session
   start. Compaction checkpoints persist a `user/message` with
   `data.source.kind: 'plugin'` (`packages/ui/tui/tests/resumed-v3.spec.ts:94-107`)
   AND a `compaction/end` event in the same fixture — the skip-rule isolation
   test (§5.5) and the `compaction/end` fail-open test (§5.7) are deliberately
   separate for that reason; memory/advisor/turn-rules injects carry their own
   kinds — none of these suppress the gate; they simply do not start the
   window. The same holds for `cc-workflow-completion` injected messages: they
   neither open a fresh window nor suppress the gate, so claims made after one
   are still judged against receipts since the last genuine user message —
   checked and intended (widest evidence horizon). Fixtures: a compaction checkpoint with NO `compaction/end` followed
   by a claim-bearing assistant message still evaluates (§5.5, skip-rule
   isolation); a real compaction (checkpoint + `compaction/end` after window
   start) fails open — no nudge (§5.7).
2. Run the claim table. Each `claims.json` row is a real schema:

   ```jsonc
   {
     "id": "tests-green",
     "phrase": "\\btests?\\s+(?:all\\s+)?(?:pass(?:ed|es)?|are\\s+green|succeeded)\\b|presubmit\\s+green\\b", // RegExp source, case-insensitive
     "tool": "bash",
     "head": "\\b(test|vitest|presubmit|check)\\b",                        // RegExp source (word-boundary; bare
                                                                           // `check` substring would false-match
                                                                           // `git checkout`)
     "headDeny": "…optional…"                                              // RegExp source; a match disqualifies
   }
   ```

   **Head matching runs per command segment.** The stored, scrubbed `head` is
   first split into segments on `&&`, `||`, `;` and `|` (one alternation
   pass — two-char forms precede `|` so `||` is never torn; quoting is NOT
   parsed; see accepted-corners below). A row is
   satisfied iff SOME segment matches its `head` regex AND that same segment
   does not match `headDeny` (when present); row head/headDeny regexes keep
   `^`-anchors evaluated per segment. Segmentation is what admits
   `cd pkg && git commit` and pipeline/chained forms; `git -C <path> …` is
   admitted by one optional `-C` group in the git rows. ALL row regexes
   (phrase, head, headDeny) compile case-INSENSITIVE — one flag per table;
   accepted consequence: the git rows then also admit `git -c key=value
   <verb>` (lowercase -c executes the verb — genuine evidence) and case
   variants like `GIT COMMIT` (harmless).

   Rows (prose form of the table):

   - `tests-green`: phrase `\btests?\s+(?:all\s+)?(?:pass(?:ed|es)?|are\s+green|succeeded)\b|presubmit\s+green\b`; head `\b(test|vitest|presubmit|check)\b`
   - `commit`: phrase `\bcommitted\b|\bcommit\s+created\b|\blanded\b`; head `^\s*git\s+(?:-C\s+\S+\s+)?(commit|merge|cherry-pick)\b`
   - `push/pr`: phrase `\bpushed\b|\bopened\s+PR\b|\bPR\s+#\d+`; head `^\s*(?:git\s+(?:-C\s+\S+\s+)?push|gh\s+pr\s+create)\b`
   - `build`: phrase `\bbuild(?:ing)?\s+succeeded\b|\btsc\s+clean\b|\btypechecks?\s+pass\b`; head `\btsc\b|\bbuild\b(?!:)`; headDeny `^\s*(docker|podman)\s+build|(?:^|\s)--watch(?:\s|$)|(?:^|\s)-w(?:\s|$)`
     (watch-mode excluded two ways: `npm run build:watch` fails the head's
     `\bbuild\b(?!:)` — the lookahead rejects the colon suffix — and
     `--watch`/`-w` flag forms hit `headDeny`; `docker build`/`podman build`
     excluded by `headDeny` per segment; `rebuild` fails the word boundary)
   - `vague-done`: phrase `fixed|resolved|done` alone — no requirement (too weak); never flags

   Accepted corners, stated once (all bounded by the nudge budget, §3.4;
   revisit only with dogfood precision data — quote-awareness is deliberately
   NOT added, §6 applies to any widening):
   - Suppression class (a NEEDED nudge is missed): quoted literals bearing a
     matching token — e.g. `echo "npm run build"` satisfies the build row with
     no build ever run; quoted compound commands splinter into segments whose
     tail can match (`sh -c 'cd pkg && git commit'` satisfies the commit row —
     correct evidence in that instance, accepted collateral of the naive
     splitter); the tests-green head also matches ANY segment bearing a bare
     `test`/`check` token (`echo test`, `pnpm check:capabilities`); and
     `sudo docker build` satisfies the build row (the per-segment `^`-anchored
     `headDeny` misses the `sudo` prefix).
   - False-nudge class (a nudge fires despite executed work): quoted
     SINGLE-verb wrappers with no separator — e.g. `sh -c 'git commit'` —
     never match an anchored row.

    Load rule: rows without a `head` field are skipped at claims-table load
    (never compiled into matchers) — a phrase-only row would flag every
    receipt-less turn.

   Phrase regexes must FAIL on "tests will pass" (future tense ≠ executed
   evidence). All head/headDeny matching runs on the stored, scrubbed `head`
   of in-session `completion-gate/receipt` events (post-scrubber, §4).

   The table is data, not code: `claims.json` in the package, unit-tested
   independently (package-internal data; no `completionGate.claimTable` config
   override — YAGNI). False-positive cost is one bounded nudge; false-negative
   cost is status quo. Table starts minimal (the five rows above) precisely
   because detector precision is unproven.

3. If no claim matched, or every matched claim has a satisfying receipt, do
   nothing. A receipt satisfies a claim iff the receipt's `tool` equals the
   row's `tool` AND its segmented head passes the row's head/headDeny rules,
   and it is either (a) an in-session `completion-gate/receipt` event appearing
   after the window start in the view's order (compare `seq`/index), or (b) a
   lineage-lifted entry (§3.2) whose `stampedOrdinal` is ≥ the window-start
   ordinal (genuine-`user/message` count at window start in the current view).
   JSONL disk files are never consulted. **The window is snapshot ORDER, not
   clocks:** `ts` is forensics-only — no `Date.now()` vs `event.time`
   comparison exists anywhere (`SessionEvent.time` is `Date.now()` epoch ms —
   verified at `deepseek-harness` `packages/core/session/src/index.ts:747` —
   and remains unused; unit tests construct ordered arrays only).

### 3.4 The nudge (soft gate)

When a matched claim lacks a satisfying receipt — from the session's own
window OR from lineage-lifted child evidence (§3.3 step 3) — the nudge fires.
Scope and horizon rules:

- Nudges fire on **top-level agents only** — main session; advisor Gate-2
  precedent `packages/interaction/advisor-watchdog/src/wiring.ts:46-50`
  top-level-only predicate — while receipts still record child sessions.
- **Horizon rule (delegated windows, the H2 fix).** If the window contains ≥1
  delegation receipt (`tool` ∈ the delegation id set pinned by §5.13) AND the
  lineage map witnessed NO child session of this session in-process (e.g.
  right after `/resume` reboots the process-live map), the evidence horizon
  is *degraded*: skip nudging — the claim's proof may live in an unwitnessed
  child. Once ≥1 child is witnessed, evaluation proceeds on own + lifted
  evidence (documented blind corners in §4).

1. Append event `completion-gate/nudge` `{ claim, missingReceipt, assistantTextHash }`
   (try/catch + debug-log; a failed append does NOT block the inject — the
   in-process budget latch in step 3 still prevents a loop).
2. Inject once:
   `agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'completion-gate' } }))`
   (real API shape per advisor-watchdog `wiring.ts:314-317`; `turn-safety.ts:145`
   is `agent.steer` — not the inject mechanism — and is not cited here).
   with text like: `Evidence check: you stated "<claim phrase>" but no
   executed record of <kind> exists since the last user message. Run it now or
   retract the claim. (completion-gate)`. Delivery is **synchronous** — the
   inject happens inside the `agent/turn-stopping` handler before the handler
   returns — and the semantics are code-verified at the pinned harness: the
   loop dispatches `agent/turn-stopping` only when the next-step inbox is
   empty and re-checks the inbox immediately after `await
   dispatch.serial(...)` returns, so a synchronous inject lands in time and
   the SAME turn continues with target `next-step` (no `turn/end`, no new
   turn — `deepseek-harness` `packages/core/agent-loop/src/agent.ts:359-363`;
   the `hasPending` → follow-up-turn path at `agent.ts:390` is the detached
   case). The CALL SHAPE follows advisor-watchdog `wiring.ts:314-317` — but
   NOT advisor's timing: advisor's handler returns immediately after
   scheduling `void onTurnStopping(...)` (`wiring.ts:99-107`), so its inject
   is detached and rides the new-turn path (pinned by advisor
   `tests/smoke.spec.ts:153-158`). This package pins the synchronous →
   same-turn-continuation case itself (§5.6); T2
   (`mechanism-pins.spec.ts:103-126`) pins pre-step injection only and is not
   the boundary pin.
   **Required same-commit edit (KNOW-YOUR-INJECTOR rule):** the new injected
   source kind `'completion-gate'` must be added to the known
   injected-source denylists — THREE copies, all updated in this same commit:
   `packages/memory/memory/src/recall.ts:204`, the turn-rules matcher
   (`packages/interaction/turn-rules/src/matcher.ts`), and
   `packages/interaction/advisor-watchdog/src/delta.ts:24`
   (`INJECTED_SOURCE_DENYLIST` — its own comment demands all three copies move
   in lockstep; for the pre-existing drift among the three copies, see §3.1
   item 6 — recorded, not reconciled here).
3. Caps: the nudge budget is the count of in-session `completion-gate/nudge`
   events (`>= cc-completion-gate.nudges-per-session` ⇒ skip; default 1, so at
   most one nudge per session by default). Nudge events replay across `/resume`
   (§1), so the budget is durable — a resume does not refund a spent nudge. A
   process-local latch (session id → last nudge stamp) mirrors the budget so a
   failed nudge-event append (step 1) cannot re-arm the gate repeatedly within
   one process. A latch-only nudge (its event append threw) does not survive
   resume — one nudge may be refunded per resumed process in that failure
   mode (accepted, §4). The
   feature must never spend the Stop-hook block budget — that budget caps 8
   *consecutive* blocks (counter resets on release/override); this feature
   spends 0 of it (nudges are injected, not steer-forced).
4. `completion-gate/resolved` `{ claim, via }` is appended ONLY when a matching
   receipt lands after a nudge (i.e. the agent ran the proof command). A
   retraction without a matching receipt resolves nothing mechanically — no
   `resolved` event is emitted. This closes the measurement loop (§6 dogfood
   metrics read these events).

### 3.5 Configuration

Settings namespace: **`cc-completion-gate`** with kebab-case keys
`cc-completion-gate.enabled`, `cc-completion-gate.nudges-per-session`,
registered via the `registerNamespaceSafe`
family (namespace + dual-half re-read precedent:
`packages/interaction/advisor-watchdog/src/settings.ts:6,161` — the
`agent/turn-stopping` handler must run synchronously up to capture, hence the
`readUserSettingsSync` idiom at `settings.ts:161`).
No camelCase variant (removed as speculation):

- `cc-completion-gate.enabled` — default `false` (dogfood-first; same
  precedent as advisor-watchdog/prompt-suggest).
- `cc-completion-gate.nudges-per-session` — default `1`.

**Read path:** both settings are re-read via the live user-settings sync-reader
idiom (`readUserSettingsSync`, advisor `settings.ts:161`; prompt-suggest's live
reader is the equivalent) on BOTH listener paths — every `agent/turn-stopping`
AND every `tools/post-execute` (`head` capture at post-execute also depends on
`enabled`) — settings hot-toggle mid-session takes effect on the next turn
without a restart.

Enabled vs always-on (resolved): the `tools/post-execute` and
`agent/turn-stopping` listeners ALWAYS register. Receipts always write the
hashed fields + session events; `head` is written only when `enabled` is true
at execute time. A head-less bash row never satisfies a head-regex claim
(fail-open — same as empty evidence). The nudge listener early-returns when
`enabled` is false.

Privacy decision on `head` capture: `head` is gated on
`cc-completion-gate.enabled`. When disabled, receipts record hashes only (no
command head) — receipts-always-on holds for the hashed fields, which are the
substrate other consumers need; raw command heads are not collected while the
feature is off (privacy: the JSONL ledger is hash-only; session events carry
the scrubbed `head` while `enabled` is true). Known bounded corner:
executions recorded while `enabled` was false have hash-only receipts whose
heads cannot satisfy a claim — flipping `enabled` on mid-session can draw ONE
false nudge about earlier work (bounded by the budget; §4).

Explicit YAGNI decisions (removed from the config surface):

- `completionGate.claimTable` — deleted; `claims.json` stays package-internal
  data, no path override.
- `completionGate.ledgerRetentionFiles` — deleted; the 100-file sweep constant
  lives in code.

### 3.6 What happens on edge cases

- Agent has no session (background child without one): the JSONL disk write is
  skipped when `sessionId` is null (no `_unassigned.jsonl` file — it would
  have no size cap); hashed session events still append if a session is
  reachable; nudges skip.
- Subagent sessions: they have their own session ids; receipts land in their
  own ledger file and their own session-event stream, and are ALSO lifted to
  the top-level session's process-live lineage bucket (§3.2) — so a top-level
  claim about delegated work is judged on its children's actual executions.
  A child's fictional work leaves no receipts *anywhere*: that emptiness is
  exactly what the (future, §7) orchestrator-side check will read, and what the
  horizon rule (§3.4) treats as unverifiable — not missing — whenever no child
  was witnessed in-process.
- Compaction: receipts are outside the transcript; compaction cannot erase the
  evidence base. One **fail-open rule**: if a `compaction/end` event exists
  after the window start (the anchor per §3.3), skip the
  nudge — the evidence view may be incomplete, and nudging on an incomplete
  view is the worse failure. No claim dating; this is the only compaction
  rule.
- `clear`/`/resume`: custom events DO replay across resume while the plugin is
  installed (verified at the pinned harness — §1), so receipts — and therefore
  nudge-budget counts — survive. The v6 blanket empty-view fail-open is
  replaced by a **composite fail-open**: skip nudging iff the in-memory view
  contains ZERO `completion-gate/receipt` events AND at least one `tool/call`
  or `tool/result` event exists (native types, always in the view). Reading:
  tools demonstrably ran but the receipts pipeline saw nothing ⇒ the evidence
  view is broken (pre-feature log, append failures, a plugin-disabled span) ⇒
  do not judge on it. Zero receipts WITH zero tool events = nothing executed
  since session start — precisely the fabricated-completion case this feature
  exists for, and it MUST be able to nudge.
- Steer-queued input: `agent/turn-stopping` fires only when the next-step
  inbox is empty (verified, `agent.ts:359`), so a turn whose end coincides
  with next-step-queued input (steer/inject — `agent.ts:167-172`) is never
  evaluated — its final claims escape the gate. User input typed while the
  agent runs goes through followup/next-turn (`agent.ts:163-164`) and does NOT
  suppress evaluation; `hasPending` (`inbox.ts:92-94`) then starts the next
  turn normally. Bounded, accepted; dogfood watches for abuse patterns
  (§5.14).

## 4. Failure modes and mitigations

- **Receipts never break the tool path.** All listener errors are swallowed
  after one `debug`-level log line (CCR's hot-path discipline).
- **Nudge loops.** Advisor/self-injection wakeup loops are a known trap
  (one-shot-notice phantom loop). The per-session cap of 1 plus the
  injected-source skip filter make a loop structurally impossible; a test pins
  it (§5).
- **Args privacy.** Only hashes + a 200-byte sanitized command head for bash
  rows (session events only — the JSONL row omits `head` entirely), produced
  by a **LOCAL minimal scrubber** (decided now, spec'd inline;
  no "if importable" hedge, no dependency on transcript-secrets internals):
  1. strip leading `KEY=value` env assignments;
  2. redact non-leading `KEY=value` assignments (value part);
  3. redact values of `--token*` / `--password*` / `--auth*` flags;
  4. redact `-H/--header` values carrying `Authorization`/`Bearer`/token
     material;
  5. redact `-u/--user` values;
  6. truncate to 200 bytes (UTF-8-safe: `Buffer.byteLength` + `subarray`,
     turn-rules `truncateUtf8` precedent).
- **False nudges.** One bounded message; the model can retract. Severity matches
  advisor-watchdog's proven-acceptable noise mode.
- **Lineage blind corners (v1, documented).** (a) Learning is receipt-driven:
  a depth-≥2 chain whose intermediate session never executed a tool is never
  learned (the grandchild's receipts do not lift), and a DIRECT child that ran
  zero tools is likewise unwitnessed — its parent window fails open, and the
  real answer for "the child did nothing at all" is §7 follow-up #2
  (orchestrator-side report verification). Delegation routes whose driver does
  not write `parentSession` leave children unwitnessed as well (the horizon
  rule fails open there); the in-process spawn/fork drivers DO write it
  (pinned: harness subagent-spawn-in-process.spec.ts:106-112,
  subagent-fork-in-process.spec.ts:129; ralph observes it end-to-end in
  tool-ralph/tests/integration.spec.ts:116). (b) the lineage map is
  process-live — `/resume` reboots it, and the horizon rule then fails open
  for delegated windows (§3.4); (c) one witnessed child opens the horizon for
  the window's other delegations as well (coarse). All bounded by the nudge
  budget; dogfood quantifies.
- **Turn-suppression corner.** Only input queued into the NEXT-STEP inbox
  (steer/inject — `agent.ts:167-172`) suppresses turn-stopping (`agent.ts:359`
  consults `nextStep` only); user input typed while the agent runs goes
  through followup/next-turn (`agent.ts:163-164`) and does NOT suppress
  evaluation. Suppressed-turn claims escape the gate (§3.6); bounded,
  accepted.
- **Downgrade refusal.** Sessions written with `completion-gate/*` events are
  unresumable on dsh-cc builds without the plugin — the upstream read path
  refuses unknown non-ignorable types and `Session.append()` cannot set
  `ignorable` (§1, §3.2). Precedent-consistent with `worktree/entered`,
  `permission/mode`, the gauge events; the fix is an upstream seam decision —
  follow-up §7.6.
- **Append failure posture.** A throwing event append (non-JSON data, etc.) is
  caught + debug-logged; the tool path is never affected. Bookkeeping loss is
  covered at whole-view granularity only: the composite fail-open (§3.6) fires
  on receipts=0 ∧ tool-events-present; a PARTIAL loss (older receipts exist, a
  later one was dropped) is indistinguishable from missing evidence and is
  judged normally — accepted, the budget bounds the cost to one nudge. A
  latch-only nudge (event append threw) is absent from the restored log after
  `/resume`, so the budget CAN refund one nudge per resumed process in that
  failure mode — accepted (budget default 1; §3.4).

## 5. Verification plan

Unit tests (vitest, package-internal):

1. Receipt writer: bash/edit/write success + failure rows contain all fields;
   `HarnessError`-derived failure exposes `errorCode`; plain `Error` leaves it
   null (mirror of `abort-utils` construction, asserting the real shape).
2. Waterfall safety: ledger disk failure ⇒ post-execute decision passes through
   unchanged, no throw (assert with a forced EACCES on the ledger dir).
3. Claim table: fixture transcripts (constructed `snapshotEvents` arrays, the
   prompt-suggest fixture pattern) — each row fires on its phrase, never on
   near-misses ("tests will pass" AND "tests should pass" must not match the
   tests row; "tests passed" / "TESTS PASSED." MUST match — `pass(?:ed|es)?`;
   "uncommitted" must not trip the commit row; `git -c user.email=a@b commit`
   must satisfy it — rows compile case-insensitive); `head` regexes
   pinned PER SEGMENT: "git checkout" must not satisfy the `check` row;
   "docker build"/"podman build" must not satisfy the build row (`headDeny`);
   "npm run build" must satisfy; "npm run build --watch" and `-w` must not;
   "npm run build:watch" must not (the `(?!:)` lookahead); "rebuild" must not
   (word boundary); segmentation pins: `cd pkg && git commit` and
   `git -C pkg commit` satisfy the commit row; `sh -c 'git commit'` does NOT
   (false-nudge corner, §3.3); `sh -c 'cd pkg && git commit'` DOES via
   splintering (suppression-class corner, §3.3);
   matching runs on the stored scrubbed `head`.
4. Head-less fail-open: a bash receipt with no `head` (captured while
   disabled) does not satisfy a head-regex claim; nudge listener early-returns
   when `enabled` is false.
5. Skip-rule isolation + nudge-once invariant: two consecutive claim-bearing
   final messages ⇒ one nudge; the latest `user/message` preceding the judged
   assistant message having `data.source.kind === 'completion-gate'` suppresses
   detection (follows the judged-message anchor, §3.3). Compaction
   checkpoints and other injected sources do NOT suppress — the isolation
   fixture has the checkpoint `user/message` (`data.source.kind: 'plugin'`)
   present with NO `compaction/end` event, followed by a claim-bearing
   assistant message that still evaluates (real compaction emits BOTH —
   `resumed-v3.spec.ts:94-107` — so this fixture isolates the skip rule from
   the §5.7 fail-open); denylist
   membership assertion covers all three injected-source denylist sites
   (`recall.ts:204`, turn-rules matcher, `delta.ts:24`).
6. Turn-stopping synchronous-inject pin (agent-loop testkit): inject
   SYNCHRONOUSLY inside an `agent/turn-stopping` listener and assert the
   same-turn continuation — an additional step under the same turn number, NO
   `turn/end` between the inject and the continuation, and the nudge text
   present in the continuation step (source anchor `agent.ts:359-363`; advisor
   `smoke.spec.ts:153-158` pins the detached → new-turn case and T2 pins
   pre-step only — neither is this boundary). The same test doubles as the
   "appends are legal at turn-stopping time" pin: the nudge-event append
   inside the handler must not throw (custom types fall through the invariant
   default branch — `invariant.ts:165-167`).
7. Compaction fail-open: a real compaction — checkpoint `user/message` PLUS a
   `compaction/end` event — after window start ⇒ no nudge (this test owns the
   `compaction/end` fail-open; the skip-rule isolation without
   `compaction/end` lives in §5.5).
8. Resume replay pin: write receipts + a nudge, `/resume`, assert the restored
   view replays them — evidence intact, budget durable (source-verified:
   `storage-contract.ts:75-77` + live-Set registration, §1) — and assert both
   halves of the composite fail-open (§3.6): a restored pre-feature log (tool
   events, no receipts) draws no nudge; a zero-tool lifetime keeps the gate
   armed. The plugin-less downgrade refusal is documented policy (§3.2, §7.6),
   not unit-tested here. The replay/refusal assertions must run through the
   REAL JsonlSessionPersistence (zstd) backend — the agent-loop testkit
   wires no persistence, so an in-memory stand-in structurally cannot see
   refusal/admission behavior (fake-vs-real discipline).
9. Preset composition: package registered in the cc-services group of
   `packages/preset/cc/agent.cordis.yml` after advisor-watchdog; composition
   pin updated in
   `packages/preset/cc/tests/composition.spec.ts` (`configIds` contains,
   `topIds` does not, index after advisor-watchdog). No runtime-order pin is
   claimed: receipt hashing runs pre-`next()` (§3.2), so CCR's post-`next()`
   rewrite cannot corrupt it — that independence is pinned by §5.12 instead.
10. Scrubber: `-H/--header` Authorization/Bearer/token values, `-u/--user`,
    and non-leading `KEY=value` assignments are redacted; UTF-8 truncation
    asserts `truncateUtf8`-semantics (never splits a UTF-8 sequence mid-
    code-unit; a final incomplete sequence may be dropped/replaced —
    `truncateUtf8` shape, turn-rules precedent).
11. `pnpm check:capabilities` + README trio gate + `pnpm check:size` green
    (`check:size` per `package.json:26`);
    capability manifest row in `docs/claude-code-capabilities.yaml` regenerated
    via `pnpm docs:parity`.
12. Registration-order independence: a fixture whose downstream post-execute
    listener rewrites `result.content` post-`next()` yields the SAME recorded
    `contentHash` as without it (hash taken pre-`next()`, §3.2).
13. Lineage: a child-session bash receipt lifts to the parent's bucket and
    satisfies a matching claim on the parent's final message; the horizon rule
    fails open when delegation receipts exist but no child was witnessed
    in-process (§3.4); the depth-≥2 receipt-silent-intermediate corner
    reproduces as documented (§4).
    This test also pins the horizon rule's delegation id set, NOW FIXED as
    { 'subagent_fork', 'workflow', 'ralph' } (anchors:
    `packages/subagent/task/src/tool.ts:76`; harness
    `packages/workflow/tool-workflow/src/index.ts:60` default `toolName`;
    harness `packages/workflow/tool-ralph/src/index.ts:411`).
14. Composite fail-open + suppression matrix: (zero receipts ∧ zero tool
    events) ⇒ nudge eligible; (zero receipts ∧ tool events present) ⇒ skip
    (§3.6); a turn suppressed by a queued next-step message is not evaluated
    (§3.6); hot-toggle of `enabled` mid-session behaves per §3.5 (at most one
    bounded false nudge about head-less earlier work).
15. Window-anchor and re-entry pins: a two-turn fixture (turn 1 executes
    `pnpm test`, turn 2 claims "tests pass" with no new execution) MUST nudge —
    the previous turn's receipt must not satisfy the current claim
    (judged-message anchor, §3.3; regression net for the turn/start anchoring
    caught in Round 7.3). Same-turn re-entry: after a nudge, the continuation
    turn carries our `completion-gate` user/message mid-turn; with
    `nudges-per-session` temporarily > 1 the second turn-stopping emits NO
    second nudge (latest preceding user/message = our kind). Ordinal equality:
    a lift stamp equals the count-from-view at lift time, including for a
    restored session whose replayed messages never hit `session/event`.
    Suppression scope: followup/next-turn user input does NOT suppress
    turn-stopping; steered next-step input does. Turn guard: an
    aborted/errored turn with no `assistant/message` (no message with
    `data.turn === turn`) yields NO evaluation (§3.3).


Dogfood plan (config-is-prompt rule): enable `cc-completion-gate.enabled` in the
user layer for dsh-cc repo sessions only, observe `completion-gate/*` events
across N sessions; expected observable: nudge fires only on real misses (manual
spot check of first 20 nudges), zero phantom loops.

## 6. Falsification discipline (applies to future learned extensions)

This feature is deterministic by design. Any later learned claim-detector or
hard-gate extension must meet the repo's borrowed credit discipline (A11/GSME):
held-out transcript split, matched-budget do-nothing baseline (nudges OFF),
reject-if-insignificant. Stated here so the evaluation substrate (receipts
events) is built with attribution fields from day one: that is why receipts are
session events and not only a file.

## 7. Follow-ups (declared, not in this change)

1. **Hard completion gates for unattended paths** (ralph goals, background
   children): completion accepted only with a receipt-backed evidence manifest.
   Needs the Stop-hook steer budget question resolved (shared budget of 8) and a
   child-completion seam design.
2. **Orchestrator-side subagent-report verification**: verify a child's final
   report against *its* ledger file before the parent trusts it. Different
   surface (Task tool result path), separate design.
3. **Claim-table widening** after dogfood precision data exists.
4. **Shared injected-sources constant**: extract the three denylist copies
   (`recall.ts:204`, turn-rules matcher, `delta.ts:24`) into a shared
   `@dsh-cc/injected-sources` constant so lockstep stops being a comment-level
   rule — NOT this change (this change edits all three in the same commit per
   §3.4).
5. ZCode-legacy candidate: post-compact *receipts summary* injection — folds
   into the D4 design (structured progress state), cross-referenced there.
6. **Downgrade-resumability seam (dsh-cc-wide, needs an upstream proposal).**
   Live `Session.append()` cannot stamp `ignorable: true` (§1), so every dsh-cc
   custom event type joins the "unknown ⇒ refuse the log" set for builds
   without its plugin. The tracking fix is a dedicated design: an upstream
   proposal for append-time envelope markers, or a persistence-adapter seam.

## 8. Review ledger

(filled per review round — verdict, findings, dispositions with in-text anchors)

**Round 1 — internal critic (2026-10-09).** Verdict: **GO-WITH-AMENDMENTS**;
11 findings, all adopted. Amended sections: §2 (Stop-cap = consecutive blocks),
§3.2 (observe-only listener, detached ledger write, flat receipts layout,
in-memory receipt reads), §3.3 (word-boundary `head` regexes, injected-source
skip via `data.source`), §3.4 (nudge via `agent.inject` with source kind
`'completion-gate'` + denylist same-commit edit; T2 and advisor-watchdog
precedents), §3.5 (kebab-case settings keys, `head` gated on `enabled`,
YAGNI cuts of claimTable/ledgerRetentionFiles), §3.6 (resume fail-open rule),
§4 (local scrubber spec'd inline), §3.1/§5 (concrete registration paths).
Two facts flagged unverifiable-in-worktree, with adopted dispositions: (a)
resume replay of custom events → fail-open rule adopted (§3.6, pin test §5.6);
(b) `isInjected` semantics for event sources → defined via `data.source` on
the latest preceding `user/message` event (§3.3).

**Round 2 — internal critic delta (2026-10-09).** Verdict: **GO-WITH-AMENDMENTS**;
1 major + 4 minor findings, all adopted. Major: THREE injected-source denylist
copies exist (recall.ts:204, turn-rules matcher, `delta.ts:24`
INJECTED_SOURCE_DENYLIST) — §3.4 same-commit edit list and §5 membership
assertion now cover all three; shared-constant extraction recorded as §7
follow-up (not this change). Minor: §3.3 build-row honesty (explicit
`docker build`/`podman build` prefix denylist; word boundaries alone do not
exclude docker build); §1/§3.4 steer-splice claim marked unverified,
advisor-watchdog wiring.ts:313-321 named load-bearing precedent; §3.6
unassigned receipts corrected to flat `_unassigned.jsonl`; §3.4 inject call
shape corrected to the real `createUserMessage({ content: […], source })` API.

**Round 3 — internal critic delta then external grok lane, round 1
(2026-10-09).** Internal critic delta: **GO** (no new findings). External
grok lane round 1: **GO-WITH-AMENDMENTS**; 13 findings (2 BLOCKER, 8 MAJOR,
3 MINOR), all adopted. BLOCKERs: §3.3 skip rule rewritten — nudge detection
skips only on our own `completion-gate`-sourced turn-opening message; window
start = last genuine `user/message` (compaction checkpoints —
`source.kind: 'plugin'` — and other injects do not suppress the gate); §3.3
receipt window redefined as snapshot ORDER (`seq`/index), `ts` forensics-only,
all `Date.now()`-vs-`event.time` comparison plans killed. MAJORs: §3.1
`KNOWN_SESSION_EVENT_TYPES` module-load registration added for the three
event types; §3.5 resolved enabled-vs-always-on (listeners always register,
hashed receipts always write, `head` only when enabled at execute time,
head-less rows fail open, nudge listener early-returns); §3.1 registration
checklist rewritten concretely (MessageSourceMap + SessionEventMap
augmentations, all three denylist copies with the pre-existing drift recorded
— all three already include `cc-workflow-completion`; `recall.ts:204` lacks
`turn-rules` and `plugin`, the turn-rules matcher lacks `plugin` — not
reconciled; cc-services row after advisor-watchdog, composition pin,
settings namespace renamed to `cc-completion-gate` with kebab keys);
§3.4 cap redefined as count of in-session nudge events, inject made
synchronous in the turn-stopping handler, T2 replaced as load-bearing pin by
advisor `tests/smoke.spec.ts:153-158` with a new package pin for a second
turn from a turn-stopping inject; §3.6 compaction collapsed to one fail-open
rule (skip nudge if `compaction/end` after window start), claim-dating text
deleted; §3.3 `claims.json` made a real schema (`{ id, phrase, tool, head,
headDeny? }` with the build-row headDeny); §3.5/§4 settings re-read per
turn-stopping via `readUserSettingsSync` (`settings.ts:161`). MINORs: §3.2
hash-before-`next()` for pre-crush content (CCR post-execute listener is
prepend-only — `context-crusher/src/index.ts:167`), prepend-tier ordering
pinned in §5.9; §1 one-shot-notice citation corrected (those lines say inject
DOES re-open a turn at turn end — it is the phantom-loop cause; idle-drop is
`recall.ts:360-364`); package layout pinned to the advisor-watchdog shape,
UTF-8-safe truncation, `errorCode` expression, assistant-text anchor
`prompt-suggest/src/index.ts:110`, top-level-only nudge default, local
`stableJson` helper. Two places grok corrected earlier internal-review
positions: the T2-vs-smoke-test pin (T2 pins pre-step injection, not the
turn-stopping re-open boundary), and the one-shot-notice citation (§1 had
inverted its meaning). Unverified-but-hedged items remain: custom-event
replay on `/resume`, live `SessionEvent.time` units, `steer()` same-turn
splice.

**Round 4 — external grok delta round 1 (2026-10-09).** Verdict:
**GO-WITH-AMENDMENTS**; 0 blockers; 10 findings (5 MAJOR, 5 MINOR), all
adopted. The 3 MAJOR fold-introduced slips fixed herein: (a) denylist-divergence
claim corrected — all three lists already include `cc-workflow-completion`;
the actual drift is `recall.ts:204` lacking `turn-rules` and `plugin` and the
turn-rules matcher lacking `plugin` (§3.1 item 6, §3.4, recorded not
reconciled); (b) §3.3 skip/window must read `event.data.source` — walk
`{type, data}` entries like prompt-suggest (`prompt-suggest/src/index.ts:107-110`),
genuine = `data.source` absent or `data.source.kind === 'user'`, skip iff the
latest preceding `user/message` has `data.source.kind === 'completion-gate'`
(no top-level `.source` on session events); (c) §5.5/§5.7 test split — real
compaction emits BOTH the checkpoint `user/message` (`source.kind: 'plugin'`)
AND `compaction/end` (`resumed-v3.spec.ts:94-107`), so §5.5 owns skip-rule
isolation (checkpoint, no `compaction/end` ⇒ checkpoint does not suppress)
and §5.7 owns the `compaction/end` fail-open (§3.3 points to the split).
Remaining MAJORs adopted elsewhere in this fold set: `vague-done` rows without
`head` skipped at load (documented non-detector); `headDeny` watch flags use
`(?:^|\s)` boundaries, not JS `\b`. MINORs adopted: privacy sentence says
JSONL is hash-only ("never at rest" dropped); `enabled` live re-read extended
to `tools/post-execute`; UTF-8 truncation semantics unified on the
turn-rules `truncateUtf8` shape; retract does not emit `completion-gate/resolved`
absent a matching receipt; inject-call citation drops `turn-safety.ts:145`
(agent.steer) — only advisor-watchdog `wiring.ts:314-317` cited.

**Round 5 — external grok final round (2026-10-09).** Verdict:
**GO-WITH-AMENDMENTS**; 6 fold-residue findings (0 blockers), all folded
herein: §3.3 build-row `headDeny` watch-flag regexes were stale JS `\b`
patterns (JS `\b` cannot bound `-`) — replaced with `(?:^|\s)…(?:\s|$)`
boundaries (§3.3, only `\b-` occurrence in the claims table); `vague-done`
ledger-only row given the load rule (rows without `head` skipped at
claims-table load); §3.2/§3.5 privacy overclaims corrected — JSONL ledger is
hash-only, session events carry the scrubbed `head` while enabled; §3.5 read
path stated for BOTH listener paths (`agent/turn-stopping` and
`tools/post-execute`); §5.10 UTF-8 truncation unified on the `truncateUtf8`
shape (§3.4 step 4 reworded — `completion-gate/resolved` emitted only on a
matching receipt after a nudge).

### Round 6 (external grok, sign-off confirm) — **GO**

- All six residue findings verified folded into the spec body (headDeny whitespace-bounded regexes, head-less load rule, at-rest wording, dual-path settings read, truncateUtf8 unify, resolved-on-receipt-only). Verdict: GO, no remaining NO-GO. Cost/turns: $0.068, 3 turns (thread 01a11e7d).
- External lane totals for this doc: 3 rounds, 19 findings (2 BLOCKER → 3 MAJOR fold-slips → 6 residue), all folded; ledger positions corrected where grok overturned earlier internal positions (T2-vs-smoke pin; one-shot-notice citation).

### Round 7 (orchestrator code-verification revision, same-day) — folded into v7

Trigger: post-merge re-review of v6 against the pinned harness 0.2.0-rc.2
(`DSH_HARNESS_REF` = c1b47e41) — per-claim code verification by the
orchestrator plus one fresh internal critic pass. v6 had merged as
documentation (#210) before this pass ran.

- **Three formerly-unverifiable facts are now source-verified at the pinned
  harness.** (a) Custom-event resume replay = YES while the plugin is
  installed (`packages/session/session-persistence/src/storage-contract.ts:75-77`
  + dsh-cc's live-Set registration idiom) — with the honest caveat that logs
  carrying these events REFUSE to open on plugin-less builds, because live
  `Session.append()` cannot set `ignorable` (`core/session/src/index.ts:744-750`;
  harness knowledge note `practices.md:21`). (b) Turn-end mechanism: turn-stopping
  fires only with an empty next-step inbox, a SYNCHRONOUS inject continues the
  SAME turn (`core/agent-loop/src/agent.ts:359-363`), a detached one opens a
  follow-up turn (`:390`) — v6's §5.6 pin ("a second turn opens") was wrong in
  shape and is rewritten. (c) Custom-event append is legal in any turn state
  (`core/session/src/invariant.ts:165-167` default branch); `SessionEvent.time`
  = `Date.now()` epoch ms (`core/session/src/index.ts:747`).
- **H1 — blanket empty-view fail-open muted the gate exactly in the zero-tool
  fabrication case this feature exists for.** Replaced by the composite
  fail-open (§3.6: skip iff zero receipts AND tool events exist; nudge-capable
  iff zero receipts AND zero tool events). §5.8/§5.14 pin both halves.
- **H2 — delegation hole: top-level-only nudging + child-segregated receipts
  implies every delegated claim false-nudged.** Fixed by the lineage lift
  (§3.2), the satisfaction union (§3.3 step 3) and the degraded-horizon
  fail-open (§3.4); v1 blind corners documented in §4, behavior pinned in
  §5.13. Coverage honesty: a delegated child that ran ZERO tools is itself
  unwitnessed, so the pure "child did nothing at all" case fails OPEN
  through the horizon rule — the real answer for it is §7 follow-up #2
  (orchestrator-side report verification); v1 deliberately bounds the
  damage to silence, never to a false nudge, in that corner.
- **H3 — claim-table systemic misses.** Head matching now segments on
  `&&`/`||`/`;`/`|` with per-segment anchored evaluation; git rows admit one
  `-C` group; the build head gains `(?!:)` to reject `build:watch`; phrases
  gain word boundaries; near-miss matrix extended ("tests should pass",
  "uncommitted", `npm run build:watch`). Accepted FP/FN corners are stated at
  the table (§3.3).
- M1: the "copy wiring.ts:314-317" framing misread advisor's DETACHED timing
  as synchronous (wiring.ts:99-107 returns immediately); §3.4 now states the
  synchronous same-turn-continuation semantics explicitly and §5.6 pins them.
- M2: the fourth producer kind `'hooks-claude-code'` (`turn-safety.ts:18,146`)
  is now enumerated in §3.1 item 6 with its zero-impact rationale.
- M4: the CCR prepend-order pin is dropped — hash-before-`next()` makes
  recording order-independent (§3.2, §5.9 revised, new §5.12).
- Window anchoring: window start now anchors to the EVALUATED turn's
  `turn/start` seq (§3.3), so queued user messages (which suppress
  turn-stopping) cannot smear one turn's claims into a later window;
  `cc-workflow-completion` messages open no window and suppress nothing
  (§3.3 — checked and intended).
- Newly documented corners (§4/§3.6): queued-message suppression, mid-session
  enable flip (one bounded false nudge), append-failure posture (fail-open +
  process-local latch), lineage process-life blind corners.
- Recorded, NOT mitigated here: the dsh-cc-wide downgrade-resumability
  exposure (moved to §7.6, upstream-seam proposal).

Statuses after this fold: delta review (internal critic + external lane)
pending on v7; user sign-off pending.

**Round 7.1 — internal critic delta on v7 (same-day).** Verdict:
GO-WITH-AMENDMENTS; 5 findings (4 MINOR + 1 INFO), all folded verbatim into
the body: (1) orphan `(§5.6).` fold residue deleted; (2) §3.3 splitter wording
dropped the unfulfillable "unquoted" qualifier and the accepted-corners list is
re-classified into suppression-class (quoted literals/sh-compounds satisfying
rows; tests-green's bare `test`/`check` token width) vs false-nudge class
(quoted single-verb wrappers); §5.3 pins the splinter case; (3) §4 blind
corner (a) and §8 H2 now state the zero-tool-child coverage limit explicitly
(a child running nothing is unwitnessed ⇒ horizon fails open ⇒ §7 #2 owns
that case); (4) §5.13's delegation id set is NOW FIXED at
`{ 'subagent_fork', 'workflow', 'ralph' }` with code anchors, no longer
deferred to implementation time; (5) the over-broad tests-green head is
recorded as an accepted suppression-class corner. Fold correctness was then
verified: §-references re-checked, no stale wording left standing.

**Round 7.2 — internal critic delta CONFIRM.** Verdict: GO (no NO-GO/MAJOR).
All five Round-7.1 folds re-verified at their final wording; the delegation id
set's three anchors were re-checked against code (one off-by-one on the
tool-workflow citation: the `toolName` default `'workflow'` sits at
`index.ts:59-60` — kept as-is, body anchor unchanged). Two cosmetic residues
found and folded in the same pass: the §5.3 orphan tail `(accepted limitation,
§3.3);` (deleted — the line now carries the false-nudge/splinter pair) and the
§5.13 severed sentence tail (`reproduces as documented (§4).` restored).

**Round 7.3 — external grok delta on v7.2 (canonical lane; session
01a11f27, 32 turns, $0.72).** Verdict: GO-WITH-AMENDMENTS; 1 BLOCKER + 6 MINOR
+ 2 clarifications + accepted INFO. Every accepted finding was re-verified by
the orchestrator against the pinned harness BEFORE folding (anchors:
agent-loop `agent.ts:305` (:419-422 for the user/message order), :155-173
(send/followup/steer/inject targets), :359-363/:390; `inbox.ts:87-95`;
session `index.ts:747,754-765,744-750`; `storage-contract.ts:75-77`;
`invariant.ts:165-167`).

- BLOCKER (folded): the §3.3 window anchored to the evaluated turn's
  `turn/start` was wrong for the pinned loop — `turn/start` is appended BEFORE
  the turn's own `user/message`, so for turn ≥2 the previous turn's receipts
  satisfied the current claim (the exact steady-state failure this gate exists
  to stop). Re-anchored to the judged `assistant/message`; the skip rule
  re-anchored identically (a same-turn nudge continuation lands our message
  mid-turn). §5.15 pins both (two-turn fixture + re-entry snapshot).
- MAJOR (folded): the tests-green trailing `\b` rejected the past tense;
  `pass(?:ed|es)?` admitted (§5.3 pins "tests passed"/"TESTS PASSED.").
- MINORs folded: ordinals are now ONE counting procedure over the current view
  (stamps and windows cannot drift; §3.2); suppression scope narrowed to
  next-step-queued input — followup/next-turn does NOT suppress (§3.6, §4,
  §5.14/§5.15); append-loss posture stated at whole-view granularity with the
  latch-refund acceptance made explicit (§4); `su docker build` joins the
  suppression-class corners (§3.3); the Round-7 H2 ledger sentence that had
  been doubled by that fold is de-duplicated.
- Clarifications folded: the splitter is one alternation pass with two-char
  forms preceding `|`; ALL row regexes compile case-insensitive (so
  `git -c key=value <verb>` is admitted — it executes the verb; §5.3 pinned);
  `parentSession` provenance stated explicitly (spawn/fork drivers pin it,
  ralph e2e observes it; routes that do not write it fail open via §3.4's
  horizon rule — §3.2/§4).
- INFO accepted: the near-duplicated ledger sentence was the only editorial
  finding.

Statuses after this fold: internal delta confirm GO (Rounds 7.1/7.2/7.4, all residues folded); user sign-off
pending.

**Round 7.4 — internal critic delta CONFIRM on v7.3.** Verdict: GO. The
judged-message re-anchor, single counting procedure, suppression rescope, and
the §5.15 pin set were re-verified against the pinned harness (agent.ts
:305/:419-422/:163-172; append publishes after push; replayed restoration
never publishes session/event). One MINOR residue adopted and folded: the
judged message now carries a same-turn guard (`data.turn === turn`; an
aborted/errored turn with no assistant output skips evaluation — §3.3, pinned
in §5.15). No NO-GO/MAJOR positions remain on either review seat.

**Round 7.5 — external grok micro-confirm on v7.4 (canonical lane; session
01a11f54, 15 turns, $0.25).** Per-fold verification 10/10 OK: every fold
re-checked at its final text AND at its harness anchors. VERDICT: GO — no
remaining NO-GO, BLOCKER, or MAJOR. The revision chain (Rounds 7-7.5) is
closed; the remaining gates are user sign-off and implementation.
