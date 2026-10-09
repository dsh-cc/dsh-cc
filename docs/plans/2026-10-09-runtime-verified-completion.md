# Runtime-verified completion: receipts ledger + final-turn evidence gate (design)

- Date: 2026-10-09
- Status: draft v6 — review complete: internal critic GO (3 rounds) + external grok GO (3 rounds, 19 findings all folded); user sign-off pending. NOT yet implemented.
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
  counter resets on release/override). This design does NOT deliver via steer:
  `steer()` during turn-stopping splices the same-turn next-step inbox without
  producing a new turn — **unverified** (the splice-without-new-turn semantics
   are upstream-inferred; pin at implementation if referenced); the delivered
   mechanism uses `agent.inject`, with
   `packages/interaction/advisor-watchdog/src/wiring.ts:314-317` as the
   load-bearing precedent (the pin that a turn-stopping inject re-opens a
   turn is advisor `tests/smoke.spec.ts:153-158`; T2
   mechanism-pins.spec.ts:103-126 pins pre-step injection only)
   (§3.4).
- The assistant's final message text is readable in-process by walking
  `agent.session.snapshotEvents()` for the last `assistant/message`
  (precedent: `packages/interaction/prompt-suggest/src/index.ts:102-116`).
- `agent.inject` queues a durable next-step message that re-opens the turn when
  delivered at the turn-stopping boundary (pin:
  `packages/subagent/task/tests/mechanism-pins.spec.ts:103-126`); the re-open
  at turn end is exactly why one-shot-notice moved to batch-append delivery
  (its idle-wake phantom loop was caused by inject re-opening a settled turn —
  `packages/subagent/task/src/one-shot-notice.ts:7-11`). Idle-settled injects
  are dropped by the memory-recall idle guard
  (`packages/memory/memory/src/recall.ts:360-364`).
- All transcript events are observable in-process via
  `ctx.on('session/event', (session, event) => …)`
  (precedent `packages/hooks/hooks-claude-code/src/register-events.ts:264`).
- Plugins can append custom typed session events via `session.append(type, data)`
  with a `SessionEventMap` module augmentation (pattern:
  `packages/hooks/hook-protocol/src/types.ts:8-9`; harness `Session.append` is
  documented at the session class, and `session/created` hands a plugin the live
  `Session` — precedent `packages/interaction/permission-rules/src/index.ts:294`).

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
   event types — persistence refuses unknown event types unless the type is
   registered there (`packages/workspace/session-cwd/src/events.ts:3-6`; same
   pattern in `packages/interaction/permission-rules/src/mode.ts:8-11`). Append
   through the widened live-set face those two use so the CI typecheck pin
   holds.
6. **Injected-source denylists — all THREE copies updated in the same commit**
   (`'completion-gate'` added to each): `packages/memory/memory/src/recall.ts:204`,
   the turn-rules matcher (`packages/interaction/turn-rules/src/matcher.ts`), and
   `packages/interaction/advisor-watchdog/src/delta.ts:24`
   (`INJECTED_SOURCE_DENYLIST`). Pre-existing drift (verified 2026-10-09, all
   three lists DO already include `cc-workflow-completion`): `recall.ts:204`
   additionally lacks `turn-rules` and `plugin`; the turn-rules matcher
   additionally lacks `plugin` (only `delta.ts:24` has all). Record that drift;
   add `'completion-gate'` to all three; do NOT reconcile the pre-existing
   divergence here (out of scope — §7 follow-up).
7. Capability manifest row in `docs/claude-code-capabilities.yaml` regenerated
   via `pnpm docs:parity`; package README trio (gate: `pnpm check:capabilities`,
   README hash gate).

### 3.2 Receipts ledger

Listener: `ctx.on('tools/post-execute', handler, { prepend: true })` (same slot as
CCR so receipts see pre-crush content; CCR is `{prepend:true}` only —
`packages/context/context-crusher/src/index.ts:167`; the `{global…}` part of the
registration belongs to the `llm/stream` listener, not this one). The handler
hashes `result.content` **before** calling `next()`, so receipts always see
pre-crush text. Prepend-tier registration order (CCR vs this plugin) is pinned
by a composition test (§5.9).

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
   `exec.agent?.session` is reachable. Type declared via module augmentation:

   ```ts
   declare module '@deepseek-ai/dsh-session/types' {
     interface SessionEventMap { 'completion-gate/receipt': Receipt }
   }
   ```

   (augmentation pattern: `packages/hooks/hook-protocol/src/types.ts:8-9`).

**Nudge evaluation reads the in-session `completion-gate/receipt` events
(in-memory, typed) — NOT the JSONL disk file.** The JSONL ledger is
forensics/dogfood-only.

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
   the source is read off **`event.data.source`** (a session event's top level
   carries no `source` field). **Skip rule:** nudge detection is skipped ONLY
   when the turn-opening (latest preceding) `user/message` has
   `data.source.kind === 'completion-gate'` — i.e. our own nudge.
   Window start = the last **genuine** `user/message` (`data.source` absent or
   `data.source.kind === 'user'`; note this is the session-event analogue, NOT
   the `isGenuineUser` llm/stream `DeltaMessage` helper at
   `packages/interaction/advisor-watchdog/src/delta.ts:69-73`, which reads a
   different shape). Compaction checkpoints persist a `user/message` with
   `data.source.kind: 'plugin'` (`packages/ui/tui/tests/resumed-v3.spec.ts:94-107`)
   AND a `compaction/end` event in the same fixture — the skip-rule isolation
   test (§5.5) and the `compaction/end` fail-open test (§5.7) are deliberately
   separate for that reason; memory/advisor/turn-rules injects carry their own
   kinds — none of these suppress the gate; they simply do not start the
   window. Fixtures: a compaction checkpoint with NO `compaction/end` followed
   by a claim-bearing assistant message still evaluates (§5.5, skip-rule
   isolation); a real compaction (checkpoint + `compaction/end` after window
   start) fails open — no nudge (§5.7).
2. Run the claim table. Each `claims.json` row is a real schema:

   ```jsonc
   {
     "id": "tests-green",
     "phrase": "tests? (all )?(pass|are green|succeeded)|presubmit green", // RegExp source, case-insensitive
     "tool": "bash",
     "head": "\\b(test|vitest|presubmit|check)\\b",                        // RegExp source (word-boundary; bare
                                                                           // `check` substring would false-match
                                                                           // `git checkout`)
     "headDeny": "…optional…"                                              // RegExp source; a match disqualifies
   }
   ```

   Rows (prose form of the table):

   - `tests-green`: phrase `tests? (all )?(pass|are green|succeeded)|presubmit green`; head `\b(test|vitest|presubmit|check)\b`
   - `commit`: phrase `committed|commit created|landed`; head `^\s*git\s+(commit|merge|cherry-pick)`
   - `push/pr`: phrase `pushed|opened PR|PR #\d+`; head `^\s*(git push|gh pr create)`
   - `build`: phrase `build(ing)? succeeded|tsc clean|typecheck(s)? pass`; head `\btsc\b|\bbuild\b`; headDeny `^\s*(docker|podman)\s+build|(?:^|\s)--watch(?:\s|$)|(?:^|\s)-w(?:\s|$)`
     (`\bbuild\b` alone matches the `build` token of `docker build`, hence the denylist; `npm run build` satisfies, `npm run build --watch` does not)
   - `vague-done`: phrase `fixed|resolved|done` alone — no requirement (too weak); never flags

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

3. If no claim matched, or every matched claim has a satisfying receipt (the
   satisfying receipt is found among the **in-session `completion-gate/receipt`
   events** — read from the in-memory typed session view via
   `snapshotEvents()`, NOT the JSONL disk file), do nothing. **The window is
   snapshot ORDER, not clocks:** a receipt satisfies iff its event appears
   after the last genuine `user/message` in `snapshotEvents()` (compare
   `seq`/index). `ts` is forensics-only — no `Date.now()` vs `event.time`
   comparison exists anywhere (live `SessionEvent.time` units are
   unverifiable; unit tests construct ordered arrays only).

### 3.4 The nudge (soft gate)

When a matched claim lacks a receipt (nudges fire on top-level agents only —
main session; advisor Gate-2 precedent `wiring.ts` top-level-only predicate —
while receipts still record child sessions):

1. Append event `completion-gate/nudge` `{ claim, missingReceipt, assistantTextHash }`.
2. Inject once:
   `agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'completion-gate' } }))`
   (real API shape per advisor-watchdog `wiring.ts:314-317`; `turn-safety.ts:145`
   is `agent.steer` — not the inject mechanism — and is not cited here).
   with text like: `Evidence check: you stated "<claim phrase>" but no
   executed record of <kind> exists since the last user message. Run it now or
   retract the claim. (completion-gate)`. Delivery is **synchronous**: the
   inject happens inside the `agent/turn-stopping` handler before it returns
   (copy `packages/interaction/advisor-watchdog/src/wiring.ts:314-317` — NOT
   advisor's detached resolve-time `void runAndDeliver` pattern). The
   load-bearing in-repo pin that a turn-stopping inject re-opens a turn is
   advisor's `tests/smoke.spec.ts:153-158` (`stops.length >= 2` after the
   injected advisory turn); T2 (`mechanism-pins.spec.ts:103-126`) injects at
   `agent/pre-step` and does NOT pin this boundary — it only pins pre-step
   injection. A package pin asserts a second turn from a turn-stopping inject
   (§5.6).
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
   most one nudge per session by default). The
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
the scrubbed `head` while `enabled` is true).

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
- Subagent sessions: they have their own session ids; receipts land in their own
  ledger files. A child's fictional work therefore leaves no receipts *in the
  child's file* — that emptiness is exactly what the (future, §7)
  orchestrator-side check will read.
- Compaction: receipts are outside the transcript; compaction cannot erase the
  evidence base. One **fail-open rule**: if a `compaction/end` event exists
  after the window start (the last genuine `user/message`, §3.3), skip the
  nudge — the evidence view may be incomplete, and nudging on an incomplete
  view is the worse failure. No claim dating; this is the only compaction
  rule.
- `clear`/`/resume`: same reasoning — window starts at last `user/message`,
  which on resume is the resumed tail. **Fail-open rule:** if no
  `completion-gate/receipt` events exist in the in-memory session view since
  session start (e.g. custom events not replayed on `/resume`), skip nudging
  entirely — an empty evidence view must never produce a nudge. Replay behavior
  of custom events on resume is unverifiable in this worktree; a pin test is
  scheduled (§5) and must be re-confirmed at implementation time.

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

## 5. Verification plan

Unit tests (vitest, package-internal):

1. Receipt writer: bash/edit/write success + failure rows contain all fields;
   `HarnessError`-derived failure exposes `errorCode`; plain `Error` leaves it
   null (mirror of `abort-utils` construction, asserting the real shape).
2. Waterfall safety: ledger disk failure ⇒ post-execute decision passes through
   unchanged, no throw (assert with a forced EACCES on the ledger dir).
3. Claim table: fixture transcripts (constructed `snapshotEvents` arrays, the
   prompt-suggest fixture pattern) — each row fires on its phrase, never on
   near-misses ("tests will pass" must not match); `head` regexes pinned
   ("git checkout" must not satisfy the `check` row; "docker build" and
   "podman build" must not satisfy the build row (`headDeny`); "npm run
   build" must satisfy it; "npm run build --watch" and `-w` must not;
   "rebuild" must not via the word boundary); matching runs on the stored
   scrubbed `head`.
4. Head-less fail-open: a bash receipt with no `head` (captured while
   disabled) does not satisfy a head-regex claim; nudge listener early-returns
   when `enabled` is false.
5. Skip-rule isolation + nudge-once invariant: two consecutive claim-bearing
   final messages ⇒ one nudge; a turn-opening `user/message` with
   `data.source.kind === 'completion-gate'` suppresses detection. Compaction
   checkpoints and other injected sources do NOT suppress — the isolation
   fixture has the checkpoint `user/message` (`data.source.kind: 'plugin'`)
   present with NO `compaction/end` event, followed by a claim-bearing
   assistant message that still evaluates (real compaction emits BOTH —
   `resumed-v3.spec.ts:94-107` — so this fixture isolates the skip rule from
   the §5.7 fail-open); denylist
   membership assertion covers all three injected-source denylist sites
   (`recall.ts:204`, turn-rules matcher, `delta.ts:24`).
6. Turn-stopping inject pin: package test injects from `agent/turn-stopping`
   and asserts a second turn opens (the load-bearing boundary; T2 pins
   pre-step only).
7. Compaction fail-open: a real compaction — checkpoint `user/message` PLUS a
   `compaction/end` event — after window start ⇒ no nudge (this test owns the
   `compaction/end` fail-open; the skip-rule isolation without
   `compaction/end` lives in §5.5).
8. Resume fail-open pin: custom events (`completion-gate/receipt`) not replayed
   on `/resume` ⇒ no nudge (fail-open). Re-confirms the upstream replay
   behavior flagged unverifiable in review (§8).
9. Preset composition: package registered in the cc-services group of
   `packages/preset/cc/agent.cordis.yml` after advisor-watchdog; composition
   pin updated in
   `packages/preset/cc/tests/composition.spec.ts` (`configIds` contains,
   `topIds` does not); prepend-tier ordering of the receipts listener vs CCR
   pinned here too.
10. Scrubber: `-H/--header` Authorization/Bearer/token values, `-u/--user`,
    and non-leading `KEY=value` assignments are redacted; UTF-8 truncation
    asserts `truncateUtf8`-semantics (never splits a UTF-8 sequence mid-
    code-unit; a final incomplete sequence may be dropped/replaced —
    `truncateUtf8` shape, turn-rules precedent).
11. `pnpm check:capabilities` + README trio gate + `pnpm check:size` green
    (`check:size` per `package.json:26`);
    capability manifest row in `docs/claude-code-capabilities.yaml` regenerated
    via `pnpm docs:parity`.

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
