# Memory structured-report lane: deterministic permission exemption + single bounded dream retry

**Status:** **Implemented** — PR #132 (2026-09-24, open). Review provenance:
critic cold review round 1 (2026-09-24) applied:
retry restricted to `failed` outcomes only (`killed` never respawns), retry
block gets its own try/catch → outcome-failed + rollbackLock so it can never
strand the lock, evaluate.ts passthrough anchor corrected to :150, manifest
deviation rephrased to the established "dsh-cc extension:" idiom, golden
described as hand-edited literal (not snapshot), and an executable pin added
that an explicit `permissions.readOnlyTools` replaces the default wholesale.
**Origin:** production dogfood of PR #128 (auto-dream
dispatch fix) on 2026-09-23 evening → 2026-09-24 morning; the dispatch layer
verified working; two downstream layers fail.
**Date:** 2026-09-24
**Branch:** `worktree-memory-structured-report` (based on `origin/main`
0ec9e226, post auto-mode CC-parity program).

## 1. Problem

With PR #128 deployed, memory lanes (extraction, dream, recall) dispatch and
drive forks correctly. End-to-end success is still not reliable; two distinct
failures were recorded with code-anchored evidence:

### 1.1 The classifier kills memory-lane `structured_output` reports

Extraction child `7b3d1cb5` (2026-09-23 21:36, session log seq 1343–1347):

1. The model did the extraction correctly and called `structured_output` with
   a valid `{writes: [...]}` payload (a faithful rewrite of the very topic file
   being extracted).
2. `permission/classifier` event: verdict `ask`, route
   `orchestrix/llmbox_ant/deepseek-v4.1-flash`, latency 2214 ms. Reason
   (verbatim, seq 1345): "Writes persistent memory files whose content coaches
   future sessions to bypass the sandbox via danger-full-access escalation".
   The payload legitimately documents sandbox-escalation lessons — the
   classifier read prose content as coaching.
3. `approval/asked` → `approval/decided: rejected` — delegated children run
   with `approvalPolicy: 'never'`, so any ask rejects deterministically
   (harness `packages/core/tools/src/index.ts:1706` renders it as
   `Error: the user rejected tool "structured_output"`).
4. Capture never commits → run `stopReason: error` → memory-job reports
   `failed`. (22:04 the next extraction of the same content got `verdict:
   allow` — the decision is nondeterministic, not a deterministic block.)

Mechanism chain in the latest code (all verified 2026-09-24 on origin/main):

- `structured_output` is not in `DEFAULT_READ_ONLY_TOOLS`
  (`packages/interaction/permission-rules/src/settings-schema.ts:101-102`).
- It matches no allow rule → `foldDecision` returns `passthrough`
  (`evaluate.ts:150`); `mapPostWaterfall` passes LOW+passthrough onward
  (`decide.ts:182-189`).
- The auto-stage's eligibility gate (`auto-stage.ts:351-359`) excludes
  read-only calls from the classifier (`if (decided.isReadOnly) return
  undefined`) — so the classifier is consulted precisely because
  `structured_output` lacks read-only classification.
- A classifier `ask` on a headless child is a deterministic hard kill.

### 1.2 The dream child ends its turn in prose, never reporting

Dream child `3c9ce4ee` (21:35:01–21:39:53): did the full consolidation analysis
correctly (read every memory cluster, planned sensible merges — merged
`release-history.md` absorbing 8 release topics, all visible in its reasoning),
then closed with prose ("Now let me finalize the consolidation plan and write
the new file set…") and **ended the turn without a single tool call**. The
in-process driver's structured runtime sees "outputSchema requested but never
reported" and downgrades the run to `stopReason error`; the diagnostic file
correctly records `outcome-failed` at 21:39:53. All that analysis is discarded
because the final report never happened.

### 1.3 Overnight context (design inputs, not separate defects)

- A long-lived **old-code process** (pid 17905, `tui-323070a1`, started
  2026-09-23 15:33 local, predating PR #128) shares the same memory dir and
  has repeatedly consumed pressure windows with old-code dispatch-throws
  (latest: 08:28 today). The lock protects integrity; the marker stamp just
  gets consumed. This self-heals when that session closes; the only lesson
  this doc takes: failure records may interleave across processes and should
  not be read as regression evidence by themselves (sessionId/pid fields are
  the attribution).
- The extraction wake loop did NOT run away overnight (5 new child dirs
  between 22:14 and 08:27): wake turns appear not to advance the
  extraction single-flight gate. Bounded; no fix needed in this PR.
- The index drifted below the cap via extraction edits (25654 → 24826), and
  no merged-topic fingerprints exist — no full consolidation has ever
  succeeded. The dream remains unproven end-to-end.

## 2. Goal

1. **D1** — memory-lane `structured_output` calls can never be routed through
   the auto-mode classifier or produce an ask. Fixed deterministically, in
   code, for every consumer of the outputSchema machinery (memory extraction,
   dream, recall, agent output contracts via cc-plugin-loader).
2. **D2** — a dream whose child ends in prose gets **one** fresh-model retry
   in the same dispatch window; the prompt gains an explicit final contract
   that narrated-but-unreported work is discarded.
3. Keep every change plain-plugin / plain-config-level; harness stays
   untouched; no new settings surfaces.

## 3. Non-goals

- No changes to `tools.restrict()` or the in-process driver's structured
  runtime (harness-owned, read-only). No new upstream proposals — both fixes
  are dsh-cc-side.
- No permission-mode or classifier policy redesign (the auto-mode parity
  program's semantics stand untouched; this adds one tool name to the standard
  read-only set).
- No change to the extraction lane's cadence/single-flight behavior.
- No model-route pinning for memory children (open question §7 instead).

## 4. Design

### 4.1 D1 — read-only classification for `structured_output`

Add `'structured_output'` to `DEFAULT_READ_ONLY_TOOLS`
(`packages/interaction/permission-rules/src/settings-schema.ts:102`).

Why this is the right seam, and sufficient:

- The constant is the "standard read-only tool set, applied when
  `Config.readOnlyTools` is omitted" (`settings-schema.ts:101`) — i.e. the
  built-in default for the permission pipeline.
- With it, `decideCallVerbose` computes `isReadOnly: true` for the call
  (`decide.ts:123`); the waterfall still returns `passthrough`
  (`evaluate.ts:146`), `mapPostWaterfall` keeps that passthrough
  (`decide.ts:188`), and the auto-stage explicitly refuses to escalate
  read-only calls (`auto-stage.ts:359`, `if (decided.isReadOnly) return
  undefined` — the S3/A13 eligibility rule "never read-only"). The
  `pre-execute` listener then falls to `return next()`
  (`pre-execute.ts:283`) — the exact downstream path that lets read-only tools
  run free in headless children today (empirically proven by last night's
  recall forks: `read` calls succeed in children on the same pipeline while
  the non-read-only `structured_output` was rejected).
- Semantic soundness: both registrars of this name are side-effect-free
  report channels — the in-process driver's child-scoped tool validates
  arguments against the declared schema and captures the value (harness
  `subagent-in-process-driver/src/structured.ts:49`), and the preset's global
  variant validates and echoes (dsh-cc
  `packages/core/tool-structured-output` `createStructuredOutputTool`). No
  invocation can mutate state; every consequential use of the reported data
  carries its own validation (`validateMemoryWrites`) and write path.
- Scope check (why global-name-based is acceptable): any tool literally named
  `structured_output` is this report channel. A hypothetical hostile or
  buggy custom tool choosing that exact name would gain the exemption — noted
  as an accepted risk; the name is an internal protocol convention, not a
  user-facing tool slot.
- Config caveat (documented, no code change): deployments that set
  `permissions.readOnlyTools` explicitly replace the default list wholesale
  (`settings-schema.ts:153`); documenting this in the settings-schema comment
  is enough — a deployment that curates that list already owns the semantics.
- Other consumers of outputSchema children (`packages/compat/cc-plugin-loader/
  src/agents.ts` agent output contracts; future lanes) get the same fixed
  behavior for free.

### 4.2 D2 — one bounded retry for a failed dream outcome

Insertion point: `runDream`'s settle branch
(`packages/memory/memory-consolidation/src/index.ts:355-367`).

Behavior:

- On `outcome.status === 'failed'` (**only** failed — a `killed` outcome is an
  intentional abort (session teardown / controller.abort) and must never
  respawn), record the existing `outcome-failed` diagnostic, then run
  **one** immediate retry: `startMemoryJob` again with the same prompt, same
  lock (already held), no re-acquire, no marker restamp. The retry runs in the
  settle callback — outside the outer dispatch try/catch — so the ENTIRE retry
  block (second spawn call, its settle wiring, its diagnostics) gets its own
  try/catch whose failure path records `outcome-failed` (retry-tagged) and
  calls `rollbackLock`, mirroring the dispatch-throw branch: a throw inside
  the retry must never strand the lock.
- The successor outcome is final for this window: success clears pressure and
  returns; failure records a second `outcome-failed` diagnostic (phase
  suffixed or detail-prefixed with `retry`) and rolls back the lock as today.
- No more than one retry per dispatch; the existing pressure cooldown windows
  remain the only outer loop.
- Detail note: the retry's success calls `clearPressure(fs, dir, now)` with the
  first attempt's `now`, stamping `lastForcedAt` a few minutes stale and
  marginally shortening the next cooldown — harmless (minutes vs hour-scale
  windows); leave as is.

Why in the dream lane only: extraction refires for free at the next
turn-stopping, and its failure class tonight was the classifier flake (fixed
by D1) — retries would only double its cost for no observed failure mode.

### 4.3 D2 compiler — prompt final contract (deliberate prompt change)

In `packages/memory/memory-consolidation/src/prompts.ts`, append a closing
contract to **both** `buildConsolidationPrompt` and `buildExtractionPrompt`,
keeping every existing sentence untouched:

> FINAL CONTRACT: your turn is incomplete until you have called
> `structured_output` with the full report. Plans or findings narrated in
> prose without that call are discarded entirely — there is no partial
> credit, and no one will ask you twice.

This is a deliberate prompt-text change: the byte-pin golden
(`packages/memory/memory-consolidation/tests/turn-stopping.spec.ts`) is a
hand-maintained literal array (only the tool-list line interpolates
`MEMORY_AGENT_TOOLS`) — edit the literal expected array in the same commit,
and extend the `prompts.spec.ts` pins likewise (never hand-skipped).

### 4.4 Capability manifest impact (implementation PR, same commit)

`permissions.rules`: add evidence rows for the new spec(s); add a deviation
note phrased in the established house form — "dsh-cc extension: structured_output
report channel classified read-only by default" (cf. the reasoning-fold-probe
/task-tool rows). Dimensions unchanged. Regenerate parity docs (`pnpm docs:parity`) and commit the artifacts.

## 5. Test plan

Package: `packages/interaction/permission-rules` and
`packages/memory/memory-consolidation`. Runner: `pnpm exec vitest run <paths>`.

1. **D1 snapshot pin**: `DEFAULT_READ_ONLY_TOOLS` contains `structured_output`
   (with a comment pointing at this doc's evidence chain).
2. **D1 pipeline spec (auto mode)**: build the real decision stack with a
   fake settings provider (auto + classifier enabled), a classifier spy, and a
   `structured_output` exec whose arguments carry the recorded production
   payload shape (`{writes:[{path, content: "...danger-full-access..."}]}`).
   Assert: `decideCallVerbose` → `isReadOnly: true`, decision `passthrough`;
   the `pre-execute` listener returns `next()`/downstream (never `ask`);
   classifier spy consulted exactly zero times. Pre-fix this spec fails
   (reproduces the 21:36 ask).
3. **D1 child-context regression spec**: same as (2) but exec has an agent
   with no answerable approval (mirroring `approvalPolicy: 'never'` children):
   assert no `approval/asked` emerges at all for `structured_output` while a
   control non-read-only tool still asks — pinning that headless children
   never see this ask again. Also assert priority: a user-authored DENY rule
   for `structured_output` still denies (read-only fixes only the default
   path, not authored policy). Plus one executable pin for the config caveat:
   an explicit `permissions.readOnlyTools` array replaces the default
   wholesale (documenting §4.1's caveat in test form).
4. **D2 retry unit spec**: fake `SubagentService.start` whose first settle
   resolves `stopReason: 'error'` (never-reported shape) and whose second
   resolves `completed` with a valid structured payload; drive `runDream`
   through it and assert: one lock acquire, two spawn calls, marker cleared,
   `outcome-failed` recorded for the first and a retry-tagged success path
   for the second. Second failure → exactly two spawns, rollback, no third.
5. **D2 prompt specs**: `prompts.spec.ts` and the turn-stopping golden
   re-recorded; a new pin asserting the final-contract line is the LAST
   content line of both prompts (so a future editor can't bury it).
6. **Unchanged-behavior guards**: existing permission-rules suite green
   (read-only set extension must not alter plan/acceptEdits/bypass tables);
   existing memory-consolidation suite green.

### Local gates (each run separately, exit codes visible)

`pnpm exec vitest run packages/interaction/permission-rules packages/memory/memory-consolidation`,
`pnpm -w exec tsc -b tsconfig.packages.json` (CI-equivalent, required),
`node scripts/check-capability-evidence.mjs`,
`node scripts/generate-parity-matrix.mjs --check` (regenerate first),
`pnpm check:spec-deps`, `pnpm check:deep-imports`,
`node scripts/check-file-size.mjs` (auto-mode program lesson: the size gate
is easy to forget locally).

### Dogfood verification (post-deploy)

This workspace is a live testbed: the pressure marker is armed and index is
near cap. After the fixed build lands in the profile, force one pressure dream
(any turn end after the cooldown window) and assert: (a) dream child calls
`structured_output` with zero `permission/classifier` events and zero
`approval/asked`; (b) on completion: marker tombstoned, `MEMORY.md` clearly
restructured under 25 000 bytes (merged-topic fingerprints present), lock
rewritten. If the first attempt still prose-stops, the retry's second child
should appear within seconds in the same window.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Read-only default hides a genuinely risky future tool named `structured_output` | Accepted explicitly (§4.1 scope check): the name is an internal protocol constant, and both implementations are validate-and-echo |
| Retry doubles cost on deterministic failures | Bounded: exactly one retry per dispatch; the failure class driving it (model prose-stop, classifier flake pre-D1) are both nondeterministic and retry-amenable |
| Prompt golden drift misrecorded | Deliberate re-record in-commit with prompt spec pins updated; reviewer gate on the diff |
| Settings deployments replacing `readOnlyTools` silently lose the exemption | Documented in the schema comment and §4.1; the same caveat class as `DEFAULT_FILE_EDIT_TOOLS` |

## 7. Open questions

- Should memory children get an explicit model route (e.g. a cheaper or more
  instruction-following lane) instead of inheriting the parent route? Tonight
  the dream child inherited glm-5.3 max-effort and stopped in prose; the
  failing struct is route-agnostic in principle. Left out of this PR to keep
  it reviewable; the retry + final contract are the measured guards. If
  dogfood still shows prose-stops, revisit with route pinning as option A.
- Should extraction also get the bounded retry? Deferred: its cadence refires
  naturally at every session turn-stopping; none of its observed failure modes
  need double-spend in one window.

## 8. DoD

1. §5 specs all green; full-suite vitest for the two touched packages green;
   full-workspace `tsc -b` exit 0.
2. Every local gate in §5 exit 0 with codes listed in the PR body.
3. Diff confined to `packages/interaction/permission-rules/**`,
   `packages/memory/memory-consolidation/**`, `docs/plans/**`, plus manifest
   evidence rows and parity artifacts.
4. PR body carries the dogfood protocol (§5 post-deploy block) with the
   2026-09-23 evidence chain quoted (classifier verdict ask + rejected +
   dream prose-stop transcript anchors).
