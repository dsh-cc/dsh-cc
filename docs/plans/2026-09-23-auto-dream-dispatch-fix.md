# Auto-dream dispatch-throw fix: never allow-list the child-scoped structured-output tool

**Status:** **Proposed** — critic cold review round 1 (2026-09-23) applied:
prompt vocabulary decoupled from the filter (blocking: the `You may use only:`
line interpolates the const; spec pins handled deliberately), fail-soft now
harvests all quoted unknown names, lock narrative corrected (rollback leaves
the file), diagnostics anchors fixed, spec gaps enumerated (reset hook,
dispatch-throw-phase assertion). Origin: production evidence
2026-09-23, this workspace's memory dir (`.dream-last-error.json`,
phase `dispatch-throw`); root cause traced and pinned below.
**Date:** 2026-09-23
**Branch:** `worktree-auto-dream-dispatch` (based on `origin/main` 65fc3cd, v0.8.0-rc.3)

## 1. Problem

Forced-pressure dream fired correctly at turn-end on 2026-09-23 19:49 (marker
armed, cooldown passed, lock acquired for the hosting session), then died at
dispatch. `.dream-last-error.json` records:

```
phase: "dispatch-throw"
Error: tools.restrict() names unknown global tool "structured_output";
known global tools: EnterWorktree, ..., workflow, write
```

Consequences observed at 2026-09-23 ~20:30 (same workspace): `MEMORY.md` at
25411/25000 bytes, `.consolidation-needed` still armed; the lock file remained
present with the restored pre-attempt value (the dispatch catch rolls the lock
back — `index.ts:372` — rather than deleting it, so file presence after a
failed dispatch is expected, not a live hold).
Every later turn-end window retries and deterministically fails at the same
throw — bounded by the 60-minute pressure cooldown, never self-healing.

### Mechanism (all anchors verified 2026-09-23)

1. The dream fork starts via the jobs seam with a static allow-list:
   `MEMORY_TOOL_FILTER` allows `['read', 'read_image', 'grep', 'glob',
   'structured_output']` (`packages/memory/memory-consolidation/src/tools.ts:19-27`),
   passed to `subagents.start('fork', …)` in
   `packages/memory/memory-consolidation/src/memory-job.ts:125-137` together
   with `outputSchema: MEMORY_WRITES_SCHEMA`.
2. The filter is validated by `tools.restrict()` in the child's creation window
   (harness `packages/subagent/subagent/src/child-agent.ts:217`), and restrict
   throws on any name not in `restrictableNames` (harness
   `packages/core/tools/src/index.ts:1078-1084`).
3. `restrictableNames` is built from **inherited** layers only — global plus
   ancestor scopes; the scope's **own** registrations are deliberately excluded
   and simply stay visible (harness
   `packages/core/tools/src/index.ts:1145-1172`).
4. `structured_output` for schema runs is a **child-scope** registration,
   attached by the in-process driver *after* the composition step that runs
   restrict (harness
   `packages/subagent/subagent-in-process-driver/src/index.ts:122-131`;
   registration in `src/structured.ts:49`). Under neither ordering could it
   pass restrict: it lands on the child's own layer, outside
   `restrictableNames`.
5. A *global* `StructuredOutput` tool exists only when the preset row declares
   a schema (`packages/preset/cc/agent.cordis.yml:585-589`; none configured in
   this deployment — the session's global table lacks the name, matching the
   error's known-tools enumeration).

So a statically allow-listed `structured_output` throws deterministically in
any deployment without a global schema-configured tool, regardless of
in-process-driver injection.

**The recall lane is the in-repo precedent that this exact fix works in
production.** The selector names `toolFilter: { allow: ['read'] }` plus
`outputSchema: RECALL_FILES_SCHEMA`
(`packages/memory/memory/src/recall.ts:33,136-137`): the injected
child-scoped `structured_output` remains callable because own-scope
registrations sit outside the restriction filter (invariant 3 above;
`attachStructuredRuntime` also pins the trailing instruction,
`structured.ts:22-29`). Live production evidence: recall injections rendered by
`recall.ts:360` were observed mid-session on 2026-09-23 in the very deployment
where the dream threw. (Earlier revisions — pre the current memory recall
work — carried `structured_output` in the recall filter; it has since been
dropped. The dream lane never got the same treatment.)

Provider routing note: the `fork` provider mount is deployment-level (profile
bundles), not a cc-preset row; the production throw originating inside child
composition is itself the evidence that the dream fork routes into the
in-process driver whose `setup` runs restrict.

## 2. Goal

1. Dream and extraction forks dispatch successfully in deployments without a
   globally registered `StructuredOutput` tool.
2. No future spawn lane in the memory packages can die the same way: naming a
   not-currently-restrictable tool in a toolFilter degrades to a warn +
   one-shot reduced retry instead of a dispatch-throw.
3. The failure file keeps telling the truth: successful dispatch leaves
   `.dream-last-error.json` untouched; a still-failing dispatch keeps
   recording `dispatch-throw` (diagnostics module already does this,
   `packages/memory/memory-consolidation/src/diagnostics.ts:25`; write call sites `src/index.ts:351,357,371`).

## 3. Non-goals

- Harness-side `tools.restrict()` semantics (read-only repo; the throw is
  doing exactly its job — it caught a materialized-bad filter).
- The R4-era question of whether a turn-stopping spawn *materializes* a child
  session at all: the 19:49 attempt progressed past that point (it reached
  restrict), so nothing in this fix claims R4 territory. If a future dogfood
  lands `outcome-failed` / silent non-materialization again, that is its own
  follow-up.
- Any prompt changes. The dream prompt instructs the child to call
  `structured_output` (`packages/memory/memory-consolidation/src/prompts.ts:64`);
  this stays correct because the tool is injected child-side by the driver.
  The byte-equal prompt golden
  (`packages/memory/memory-consolidation/tests/turn-stopping.spec.ts`,
  workspace memory `memory-g4-g5-shipped`) must remain untouched.
- Retry/backoff policy changes; the existing cooldown + stale-lock dance
  already bounds retries correctly.

## 4. Design

### 4.1 Filter correction (the fix)

`packages/memory/memory-consolidation/src/tools.ts` gains two distinct
exports instead of the current single list shared by both jobs:

- `MEMORY_AGENT_TOOLS` stays **unchanged**
  (`['read', 'read_image', 'grep', 'glob', 'structured_output']`) as the
  prompt-facing tool vocabulary — it feeds the `You may use only: …`
  instruction (`src/prompts.ts:71`), which must keep naming
  `structured_output` or it would contradict the driver's mandatory-call
  trailing instruction (harness `structured.ts:22-29`).
- `MEMORY_TOOL_FILTER` becomes a separate minimal allow-list of host-global
  names only: `{ allow: ['read', 'read_image', 'grep', 'glob'] }`, derived as
  `MEMORY_AGENT_TOOLS` minus the named constant
  `DRIVER_INJECTED_TOOL = 'structured_output'`. The module comment documents
  why, citing the §1 harness anchors (restrict validates inherited names only;
  the schema tool arrives child-scoped via `outputSchema` and is visible
  regardless of the filter; ordering inside the driver's `setup` is not even
  load-bearing) plus the recall-lane precedent — so the next editor does not
  "fix" it back.

### 4.2 Fail-soft resilience for filter drift (both memory spawn lanes)

New helper in `packages/memory/memory/src/restrict-resilience.ts`, exported
from the package (both lanes already share this dependency direction):
`startWithFilterResilience(subagents, provider, request, logger)` —

1. Try `subagents.start(provider, request)` as today.
2. On a rejection matching the host's unknown-tool throw
   (`/restrict\(\) names unknown global tools? /` against the message,
   harvesting **every** quoted name between that prefix and the `;`), collect
   all named tools, `logger.warn` once per process per dropped name (module
   state keyed by name, with an exported `resetRestrictWarnState()` so specs
   stay deterministic), and retry exactly once with
   `request.toolFilter.allow` minus the dropped names. Any other error, or a
   failing retry, propagates unchanged (the dream lane's existing
   dispatch-throw diagnostics keep working; the recall lane keeps its
   silent-skip posture with the warn added).

Wire it into `startMemoryJob`
(`packages/memory/memory-consolidation/src/memory-job.ts:125`) and the recall
selector's start call (`packages/memory/memory/src/recall.ts:131`). No API
shape changes elsewhere; `MEMORY_TOOL_FILTER`'s exported name and type are
unchanged.

### 4.3 What deliberately does not change

- `outputSchema` declarations (`MEMORY_WRITES_SCHEMA`, `RECALL_FILES_SCHEMA`)
  — they are the reason the child gets the tool; driver-owned.
- The jobs-seam outcome mapping, lock/failure diagnostics
  (`memory-job.ts:143-172`, `index.ts:355-377`), cooldown and marker/tombstone
  semantics (PR #102), scan/gate behavior (PR #109).

## 5. Test plan

Package: `packages/memory/memory-consolidation/tests/` and
`packages/memory/memory/tests/` (vitest; house runner:
`pnpm exec vitest run packages/memory`).

1. **Const pins (unit)**: `MEMORY_AGENT_TOOLS` keeps its exact five-name
   sorted snapshot (prompt vocabulary unchanged);
   `MEMORY_TOOL_FILTER.allow` equals `['read', 'read_image', 'grep', 'glob']`
   and does not contain `DRIVER_INJECTED_TOOL`; `RECALL_TOOL_FILTER` stays
   `{ allow: ['read'] }`. The existing identity pin in
   `prompts.spec.ts` (`MEMORY_TOOL_FILTER.allow` toBe `MEMORY_AGENT_TOOLS`,
   `tests/prompts.spec.ts:9`) is deliberately rewritten to assert the
   derivation instead.
2. **Fail-soft units** (`restrict-resilience` spec): (a) clean pass-through
   when start succeeds; (b) unknown-tool throw → warn once + retry once with
   the name removed, success path returns the retry's value; (c) a second
   unknown-name failure propagates (no retry loop); (d) a non-matching error
   propagates untouched without retry; (e) the once-per-name warn gate is
   keyed state with an exported reset hook (§4.2), does not repeat-log across
   two calls, and re-arms after reset.
3. **Dispatch regression (dream lane)**: fake `SubagentService.start` that
   simulates the harness restrict contract — throws the exact production
   message when the filter names the conditional tool — drives
   `startMemoryJob` end-to-end and asserts: no throw escapes, the second
   attempt's filter is the reduced one, and the settle pipeline reaches the
   write-back stage with a stubbed structured payload. If the retry also
   fails, the dream catch must record phase `dispatch-throw` (never
   `outcome-failed`) — asserted via a diagnostics stub. (Pre-fix this spec
   fails with the recorded production error; post-fix it passes.)
4. **Real-stack tripwire (spec, W3 precedent)**: harness testkit session +
   mock LLM adapter, parent seeded so `tools.restrict` semantics are the real
   ones (no global `StructuredOutput` registered), request a memory fork
   through the real in-process driver; assert the child materializes, the
   adapter observes `structured_output` in the child's visible tool list, the
   child's call is captured into `res.structured`, and
   `writeMemoryFiles` lands the topic file under a tmp memory dir. Model the
   harness on `packages/memory/memory/tests/recall-tool-surface.spec.ts`.
5. **Recall lane tripwire update**: ensure the existing
   `recall-tool-surface` spec also asserts the selector's request filter
   content (`['read']`), so the two lanes stay aligned by test, not by memory.
6. **Golden guard**: `prompts.ts` changes are **forbidden** by this plan (its
   `You may use only:` line must keep the full vocabulary). The byte-equal
   turn-stopping golden is currently self-referential
   (`tests/turn-stopping.spec.ts:766` interpolates the const), so it passes
   vacuously only while the prompt text is untouched — acceptable; the
   literal prompt pins in `tests/prompts.spec.ts` (e.g. `:41`, the
   `read, read_image, grep, glob, structured_output` ordering string) must
   stay green unmodified. The only deliberate `prompts.spec.ts` change is the
   filter-derivation line named in item 1.

### Local gates before commit

`pnpm exec vitest run packages/memory` (both packages), `pnpm -w exec tsc -b`
for the touched packages, and the house gates: `node
scripts/check-capability-evidence.mjs`, `node
scripts/generate-parity-matrix.mjs --check`, `pnpm check:spec-deps`, and
`pnpm check:deep-imports` (CI-only gate — run explicitly,
workspace memory `cc-worktree-parity-program-shipped`).

### Dogfood follow-up (post-merge, tracked)

This workspace's memory dir is still over-cap with an armed marker. After the
fixed build ships into the profile: confirm the next pressure window produces
a materialized `memory-consolidation` child (session file on disk), the marker
goes tombstone, `MEMORY.md` drops below the cap, and no new
`.dream-last-error.json` appears. Same check observations extend to the recall
lane (injections continue to arrive).

## 6. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Fail-soft masks a genuinely wrong filter and the fork runs under-restricted | The retry is one-shot, narrow (only names the host itself rejected), warn-logged, and the primary fix keeps the allow-list minimal. The in-process behavior delta (child now sees only read/read_image/grep/glob + the injected schema tool) is exactly the intended surface. |
| Prompt says "call structured_output" but deployment never injects (non-schema spawn path) | The request always declares `outputSchema`; injection is driven by the declaration (driver `index.ts:129`), not by the filter. Tripwire #4 pins this. |
| warn-once hides repeat drift | Counterpart evidence: the dream lane's dispatch diagnostics still fire on unrecoverable failure; drift that matters surfaces there. |
| Spec 4 depends on harness testkit details that drift | Version-pin reality: presubmit pins `DSH_HARNESS_REF`; the spec runs against the pinned harness in CI and locally after `pnpm install`. |

## 7. Capability manifest

No CC-parity surface changes (internal reliability fix). `memory.core`
evidence gains the new specs' paths in the same commit; dimensions unchanged
(`pnpm check:capabilities` + `pnpm docs:parity` stay byte-green).

## 8. DoD

1. §5 specs 1–5 green; prompt golden untouched and passing.
2. Local gates in §5 all exit 0, each run separately with its own exit code
   visible in the PR body.
3. Diff contains no changes outside `packages/memory/**` except the manifest
   evidence rows and this design doc.
4. PR body carries the dogfood plan (§5 post-merge block) with the current
   production error file quoted as the pre-fix evidence.
