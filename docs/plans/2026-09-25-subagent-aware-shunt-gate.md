# Subagent-aware shunt gate: CC-parity caller identity and the subagent exemption

**Status:** **Design — five review rounds applied (critic; Codex SHIP-WITH-FIXES; reviewer rounds 2/3/4/5, each code-verified before application; 2026-09-25).** Identity transport is CC's own `agent_id` field, keyed on a *live* in-process subagent set (add at start, delete at end); `agent_type` stays a constant parity gap in this PR.

**Date:** 2026-09-25

## 1. Problem

`dsh-cc-shunt` installs two PreToolUse command hooks
(`packages/plugin/dsh-cc-shunt/hooks/check-file-size.mjs`, `check-bash-read.mjs`) blocking
whole-file reads over 350 lines / 100 KB. The hooks are session-scoped
(`packages/hooks/hooks-claude-code/src/register-events.ts:98-104`), so they fire inside
worker subagent sessions too. The defects (precise scope after review):

1. **The dead-end sentence.** The block reason leads with "delegate via the bulk-reader
   skill" — unexecutable for critic/executor/marathon (no Task, and executor has no skill
   surface; critic.md:33-46, executor.md:89-93). The trailing offset/limit escape clause
   already existed; the *prescription* was the defect.
2. **Images are a true deadlock, main thread included.** The bridge maps harness
   `read_image` to the CC name `Read` (packages/core/tools/tests/cc-names.spec.ts:45-46);
   `read_image` has no `offset`/`limit`, and it explicitly accepts extensionless paths by
   content sniffing — so both the "read it in pages" advice and any extension-only
   exemption leave large images blocked.
3. **For any subagent the block is pure churn.** Harness `read` is itself capped
   (READ_LIMIT=2000 plus maxLineLength/maxBytes — harness
   packages/fs/tool-fs/src/read.ts): a whole-file read and an `offset: 1` read of the
   same over-limit file return identical bounded output. The Bash gate is porous by
   pinned upstream quirks (`head -n 5 big` *passes* — `5` is treated as the path,
   hooks.spec.ts:266-271). A blocked worker re-issues and gets the same content one round
   trip later.

## 2. Verified seams and facts

- **Harness repo is read-only** (2026-09-10 directive). Fix surface: bridge, shunt
  plugin, docs/tests — all dsh-cc-side.
- **CC specifies caller identity on hook input.** The agent-sdk hooks reference documents
  `agent_id`/`agent_type` populated when a hook fires inside a subagent (TS base input,
  all events; Python: optional on PreToolUse/PostToolUse/PostToolUseFailure/
  PermissionRequest, required on SubagentStart/Stop). dsh-cc emits neither (probe: seven
  PreToolUse fields today) — emitting them is a parity fix, and http hooks receive them
  like any payload field.
- **The identity seam is a live set keyed on start/end events.** The bridge already owns
  `subagentIds` (declared register-events.ts:52-54, allocated index.ts:200), but it is
  *add-only* by design — "every subagent id seen via start/end", feeding the TeammateIdle
  filter (register-events.ts:217,230,321-323) — so it cannot distinguish "ended, then
  resumed as top-level in the same process" from "still a child". The design therefore
  adds a sibling **live set**: add at `subagent/start`, delete at `subagent/end`.
  Probed ordering for every subagent kind, grandchildren included: start → tool calls →
  idle → end; no tool calls after end; a re-activated child re-emits start *before* its
  next tool call (lifecycle.ts `createActivationObserver.start` emits
  `subagent/start` on every resident epoch — cold resume included).
- **Resume reality (probed; earlier rounds had it wrong).** A `/resume`d child stays in
  `ctx.agents` with parent=root, source=subagent, and its descriptor intact — registry
  presence and persisted header depth both misclassify it. In the same process, the
  session-switcher list hides child sessions, but `/resume <id>` bypasses it
  (driver-run-local.ts:234-238: explicit id goes straight to `switchSession`). With the
  live set, an ended id is already gone, so a resumed-as-top-level session — same process
  or a fresh one — emits no subagent fields: correct.
- **Reviewer-verified load-bearing facts this design leans on:** `exec.agent` at
  `tools/pre-execute` IS the calling subagent, and `exec.agent.id` equals the id
  `subagent/start` reports (grandchildren included); a shunt `{"decision":"allow"}` is a
  decoded no-op, never an auto-approval channel; no existing test pins the payload field
  set, and adding fields breaks no existing hook.
- **dsh-cc session_id semantics differ from CC** — documented, not changed: `base()`
  emits the calling agent's own session id (payloads.ts:35), so for a subagent event it
  is the child session id (CC keeps the main session id everywhere). Consequence:
  in dsh-cc, `agent_id` == `session_id` on subagent payloads; in CC they differ.
  The bridge README's SubagentStart/Stop divergence list (README.md:117) already records
  this shape; the manifest rows contradict it (§4.4).
- **Capability vs depth:** frontmatter-omitting children inherit the full parent tool
  view (packages/subagent/task/README.md:134-136); max delegation depth 3 (tool.ts:83).
  Depth→"cannot delegate" misclassifies both ways — moot under the exemption.
- **Config-is-prompt** unchanged: block reasons are prompt surface; §6.4 stands.

## 3. Options considered

| Option | Shape | Verdict |
| --- | --- | --- |
| **A (final)** | Bridge emits `agent_id` (+ constant `agent_type: 'general-purpose'`, recorded gap) when the caller id is in the new **live** subagent set; shunt hooks allow any invocation carrying `agent_id` and skip image formats by magic bytes; main thread byte-identical. | **Adopt.** |
| A′ (round 1/2) | `DSH_DELEGATION_DEPTH` env var / message-only branching. | Superseded: reinvents a CC-specified field; `DSH_*` is a harness-managed namespace (ambient scrub + `ctx.shellEnv` registry) with silent-failure semantics. |
| A″ (round 2) | Registry/descriptor-label identity. | Superseded: the label is the model-written Task display description (tool.ts:247) landing after SubagentStart; registry presence survives resume (§2). |
| A‴ (round 3) | Reuse the existing `subagentIds` set. | Superseded by round 4: the set is add-only, so a same-process end→resume-as-main keeps the exemption and silently kills the gate. New live set instead. |
| B | Docs-only pagination clause in worker contracts. | Moot — no worker-facing block remains. |
| C | Grant workers a scoped `shunt-reader` spawn. | Rejected: contract-purity violation, no type-scoped whitelist mechanism, executor already cheap-lane. |
| D | Exempt subagent sessions. | **Adopted scoped into A** — read caps make the worker block pure churn (§1.3); the gate's value lives on the main thread. |
| E | Capability-based gating (has subagent_fork ∧ depth<3). | Rejected: no reliable capability lookup at hook granularity; misreads both ways. |
| F | Real `agent_type` now via Task-side id→type table. | Deferred follow-up (§10). |

## 4. Design

### 4.1 Bridge: emit `agent_id` (and constant `agent_type`) for live subagent callers

Add `liveSubagentIds: Set<string>` next to `subagentIds` (index.ts:200 area): `+id` in
the `subagent/start` handler, `−id` in the `subagent/end` handler
(register-events.ts:215-232). `subagentIds` itself is untouched (TeammateIdle's existing
semantics). At every hook site with a calling agent (PreToolUse / PostToolUse /
PostToolUseFailure / PermissionRequest / Stop family), the registration layer passes
`isSubagent = liveSubagentIds.has(exec.agent.id)` to the payload builder; when true the
payload gains:

- `agent_id: exec.agent.id` — probed equal to the SubagentStart id, grandchildren
  included; equality pinned by tests.
- `agent_type: 'general-purpose'` — uniform constant, SubagentStart/Stop included (no
  change there). Kind-specific matchers remain non-firing: recorded as a parity gap in
  the manifest rows; the real type is the §10 follow-up.

**Which events carry the fields** — precise enumeration instead of a family hand-wave:
- *With fields when the caller is a live-set member*: PreToolUse, PostToolUse,
  PostToolUseFailure, PermissionRequest (:104/:138/:134/:243), Stop (:202), StopFailure
  (:295), UserPromptSubmit (:78 — inside a child session this is the child's own event),
  and TeammateIdle (:323 — idle fires strictly before end, so membership still holds).
  SubagentStart/Stop already carry real `agent_id` + constant `agent_type` today —
  unchanged here.
- *Without fields (agent-less by construction — recorded gaps)*: PermissionDenied,
  Notification, PostCompact, SessionEnd, TaskCreated (sessionBase/undefined agents), and
  WorktreeCreate/Remove, whose invoke seam is agent-less by design (index.ts:209-216);
  additionally, a `subagent-finished` worktree removal fires *after* the child's end, so
  the live set would no longer hold the id even if an agent were threaded through.

Known sibling bug, out of scope: an ended child resumed as a top-level session remains
in add-only `subagentIds`, so it also triggers spurious TeammateIdle rows. The live set
would fix that too; deliberately not folded in here (round-4 guidance keeps TeammateIdle
semantics untouched), recorded so it is not rediscovered.

### 4.2 Shunt hooks: subagent exemption + magic-byte image sniff

Both `.mjs` scripts, ahead of the thresholds (kill switch and offset/limit/pipe
early-allows keep order and semantics):

```js
if (typeof payload.agent_id === 'string' && payload.agent_id !== '') allow()
```

- **Read hook image sniff — magic bytes only, no extension path.** A large text file
  named `*.png` must stay gated, which an extension shortcut would break; the 12-byte
  read costs <0.2 ms. Placement in `check-file-size.mjs`: **after** the existing
  `statSync`/`isFile` early-allow, **before** the byte/line thresholds — `isFile()`
  already excludes FIFOs (a head read on one would block until the hook's 5 s timeout),
  and the read sits in try/catch so an `EACCES` or any read error simply falls through
  to the normal thresholds. Signatures: PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`,
  GIF `47 49 46 38`, WEBP `RIFF ?? ?? ?? ?? ?? ?? ?? 57 45 42 50` (bytes 0-3 and 8-11).
  Extensionless images are covered because `read_image` itself sniffs content.
- **Bash hook unchanged except the exemption**: no image sniff there — `cat`ing a binary
  yields capped binary output and the byte gate stays appropriate.
- Main-thread messages stay byte-identical. The pinned upstream quirks stay pinned
  (`head -n 5` passes — hooks.spec.ts:266-271); `tail -n +1 big` *also* passes today and
  has NO pin — this PR **adds the pin** rather than asserting coverage that does not
  exist.

### 4.3 No worker-contract changes

Nothing a worker does is blocked anymore; the three agent files stay untouched. (A fork
child inherits the parent's transcript, stale "please delegate" block texts included —
cosmetic; recorded.)

### 4.4 Docs and manifest

- `docs/claude-code-capabilities.yaml`:
  - `hooks.pre-tool-use` — record the emitted `agent_id` + constant `agent_type` fields
    and the child-scoped `session_id` difference; fold in the stale `additionalContext`
    correction (a non-deny one IS injected, with an ordering divergence,
    register-events.ts:109-113).
  - `hooks.subagent-start` / `hooks.subagent-stop` — today `behavioral: full`,
    `ux: full`, `deviation: none`, contradicting the bridge README's own divergence list
    (README.md:117): correct to `behavioral: partial` / `ux: partial` (validator I3) /
    `deviation: divergent` naming constant `agent_type`, child-scoped `session_id`,
    and (stop) the omitted `agent_transcript_path`. README matrix regenerated to match.
- `packages/hooks/hooks-claude-code/README.md` / zh — two edits: (a) document the new
  identity fields, live-set semantics, and resume behavior; (b) fix the stale
  `transcript_path` claim (README.md:74 promises resolution via
  `ctx.sessionPersistence.locate(...)`, but `payloads.ts` base() sends `''` — the pinned
  persistence seam's `locate` is private; make the README say that).
- `packages/plugin/dsh-cc-shunt/README.md` / zh — document the exemption and the magic-
  byte sniff; re-record the README hash pair (`node scripts/check-readme.mjs --write`).
- Regenerate parity artifacts (`pnpm docs:parity`); run `check:capabilities`,
  `check:parity`, `check:readme` in the same commit.

### 4.5 Supersession

Resolves the PR #14 limitation ("payload 无调用者身份 → worker 不能靠身份豁免"): identity
now exists on the payload in CC's own shape, and the worker side never needed the gate
(§1.3).

## 5. Misclassification table

| Caller state | Live set? | Fields | Gate | Correct? |
| --- | --- | --- | --- | --- |
| Main thread | no | none | active | yes |
| Running named restricted child (critic/executor/marathon) | yes | id + `general-purpose` | exempt | yes — cannot delegate; read caps bound content |
| Running unrestricted depth-1/2 child (inherits Task) | yes | id + `general-purpose` | exempt | accepted — caps argument; the nudge belongs to the spawning orchestrator |
| shunt-reader/shunt-writer | yes | id + `general-purpose` | exempt | yes — they paginate by contract anyway |
| Child **ended, then `/resume`d as top-level in the same process** | removed at end | none | active | yes — this is exactly what the add-only set got wrong (round 4) |
| Child resumed as top-level in a **new** process | never added here | none | active | yes — no in-process start event |
| **Cold-resumed-as-child** continuable child | re-added: start re-emitted at re-activation (lifecycle.ts `createActivationObserver.start`) | id + `general-purpose` | exempt | yes — probed, and pinned in the e2e (§6.3) |
| Grandchild (depth 2) | yes | id + `general-purpose` | exempt | yes — start precedes first PreToolUse at every depth (probed) |
| `read_image` on a large PNG, any caller, extensionless included | per caller | per caller | allow (magic bytes) | yes — no pagination surface exists |
| Large text file named `*.png` | per caller | per caller | gated | yes — no extension shortcut |

## 6. Tests

1. **Bridge unit**: fields present exactly when the caller id is in the live set; the
   set's lifecycle	pinned (add at start, delete at end) — including *id removed → the
   same session resumed as top-level emits no fields*; start-before-first-PreToolUse
   ordering pinned for spawn and cold re-activation; `agent_id` equality with the
   SubagentStart payload; grandchild case; **payload field-set goldens added** (nothing
   pins the field set today).
2. **Plugin (`dsh-cc-shunt/tests/hooks.spec.ts`)**: all four block sites allow with
   `agent_id` present; main goldens byte-identical without it; magic-byte fixtures —
   PNG/JPEG/GIF/WEBP, extensionless PNG, **and a large text file named `.png` which must
   stay blocked**; kill switch / offset-limit / pipe early-allows parameterized;
   `head -n 5` pin stays; **`tail -n +1` pin added**. Precise expectations
   for the sniff guards: a FIFO asserts allow *without* any read — the `isFile`
   early-allow releases it before the sniff, it never reaches the try/catch; an
   unreadable large file (EACCES at the 12-byte read) falls through to the thresholds and
   the test asserts the resulting **size block**. Under root, `chmod 000` is a no-op, so
   that case carries the `process.getuid() === 0` skip guard (precedent
   packages/launcher/tui/tests/store-restore.spec.ts:154-155).
3. **End-to-end (required)** — the full dsh-cc path. Explicit assembly: subagent runtime
   + spawn provider, `@dsh-cc/subagent-task` (the real Task tool), the cc plugin loader
   with **both real plugins mounted** (dsh-cc-agents, dsh-cc-shunt), a model route for
   `critic`, and the fork provider for the fork case. `subagent_fork` with
   `subagent_type: "dsh-cc-agents:critic"`; the child attempts a >350-line Read; assert
   (a) the child's tool result is file content, not a block, (b) the PreToolUse payload
   carried `agent_id`, (c) a root-agent read of the same file still blocks with today's
   golden message. Additional cases, each with a definite expected outcome (no
   either-way characterization): `subagent_type: "fork"` child; grandchild; a **cold-
   resumed child must remain exempt** (start re-emitted on re-activation — asserted);
   an **ended child resumed as top-level must be gated** (live-set removal — asserted).
4. **Post-merge dogfood** (config-is-prompt): fresh session — executor child reads a
   >350-line file → passes; root reads the same file → unchanged delegation message;
   root reads a 150 KB PNG (extensioned and extensionless) → passes. Expectations go in
   the merge commit message.

## 7. Risks and open questions

- None outstanding on identity: the live set's event ordering (start precedes tool
  calls; nothing after end; re-activation re-emits start) is probed for all subagent
  kinds including grandchildren, and the resume edge cases are pinned by tests, not
  hope.
- **`agent_type` constant** — kind-specific matchers stay non-firing; §10 is the
  follow-up. A hook ecosystem assuming CC's real type tokens sees `general-purpose`;
  documented in the manifest rows.
- **Sibling TeammateIdle bug** (resumed-as-main child still fires it) recorded in §4.1;
  separate PR if it bites.
- **Soft contract** — third-party hooks will build on `agent_id`; fine, verbatim CC
  parity.

## 8. Implementation order

1. Bridge: live set + identity fields + field-set goldens (§6.1).
2. Shunt hooks: exemption + magic-byte sniff + spec matrix incl. the `.png` text trap,
   EACCES/FIFO falls-through, `tail -n +1` pin (§6.2).
3. End-to-end full-path test (§6.3).
4. Manifest rows + README fixes (incl. the `transcript_path` correction) + `docs:parity`
   regeneration (§4.4).
5. Commit per config-is-prompt; merge; dogfood (§6.4).

## 9. Review record

- **critic** round 1 (cold, blind): endorsed caller-aware gating; env-var variant —
  superseded.
- **Codex** round 1: SHIP-WITH-FIXES, 8 findings applied at the time (survivors carried:
  four-site test coverage, e2e realism, parity/docs scope, per-point scoping).
- **Reviewer round 2** (code-verified): 6 majors + 4 minors applied — CC parity fields
  over env var; `DSH_*` rejection; option D re-adopted on read-caps evidence; image
  deadlock; e2e realism; earlier overclaims corrected.
- **Reviewer round 3** (code-verified): 4 must-fix + 6 minors applied — descriptor-label
  `agent_type` rejected (display description, tool.ts:247; lands after SubagentStart);
  registry identity rejected (resume permanence); magic bytes introduced;
  e2e assembly named; manifest subagent rows corrected; `head -n 5` direction fixed;
  session_id semantics documented; round-2 overclaim corrected.
- **Reviewer round 4** (code-verified): 2 must-fix + 1 should-fix + 5 minors applied —
  1. the existing `subagentIds` is add-only, so a same-process end→resume-as-main would
     keep the exemption (and silently kill the gate): identity moved to a new live set
     (add at start/delete at end); the sibling spurious-TeammateIdle bug is recorded
     out of scope per the round's own guidance;
  2. the cold-resume open question was inverted — re-activation *does* re-emit start
     (lifecycle.ts `createActivationObserver.start`); §5 row flipped to exempt and the
     e2e asserts it;
  3. image sniff placement pinned (after `isFile`, before thresholds, try/catch →
     thresholds) with the EACCES/FIFO rationale, and the extension fast-path dropped
     (`*.png` text trap);
  4. minors: fork case spelled `subagent_type: "fork"` with the fork provider mounted;
     set allocation cited at index.ts:200 (interface at register-events.ts:52-54);
     `tail -n +1` had no pin — the pin is added rather than claimed; §10 gains id
     pre-allocation and the table lifecycle; the bridge README's `transcript_path`/
     `locate` claim contradicts payloads.ts and is fixed in passing.
- Reviewer rounds 3/4 also confirmed: `exec.agent` is the calling subagent itself;
  shunt's `allow` decodes to a no-op (no auto-approval side channel); payload additions
  break nothing existing; start-before-tool-call ordering holds for every subagent
  kind, grandchildren included.
- **Reviewer round 5** (precision pass, non-blocking): applied — the `:228` citation
  (its own catch; round 4's "spot-check: all verified" self-claim was wrong), corrected
  in §2;
  the §10 sketch's two lifecycle errors (pre-allocation is NOT universal today and the
  type table must NOT follow start/end cycles — corrected below); §6.2 expectations
  pinned exactly (FIFO released by `isFile` before the sniff; unreadable large file falls
  through to a size block; chmod-under-root skip with the store-restore.spec.ts:154-155
  precedent); and the §4.1 family hand-wave replaced by a per-event enumeration, with
  WorktreeRemove `subagent-finished` explicitly field-less because it fires after end.

## 10. Deferred follow-up: real `agent_type`

Separate PR. Two structural changes in the Task dispatch (packages/subagent/task):
(1) **always pre-allocate the child id** — today only resume-pin-captured starts pass a
caller-chosen `childId`, while uncaptured background starts and forks get a
harness-generated id — and (2) record `childId → type` in an in-process table at first
spawn: plugin agents get the scoped id (e.g. `dsh-cc-agents:critic`), file-defined
agents the frontmatter `name`, untyped spawns `general-purpose`, internal forks `''`
(not a CC subagent shape). **The type table is long-lived and keyed by child id** — it
must NOT follow the start/end cycles: a continuable child re-runs a full start/end pair
on every wake while Task only knows the type at first spawn, so an end-deleted record
would vanish after the first epoch. Only the *live* set follows start/end; the type
table and the live set stay two separate structures (or one map with a permanent value
column plus a live flag). The bridge reads the table when building payloads; manifest
rows flip to full with matching evidence and kind-specific matchers start firing.
Do NOT source the type from the descriptor label, the header, or `info.provider` (§2).
