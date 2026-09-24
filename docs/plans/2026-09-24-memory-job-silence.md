# Silence internal memory jobs: stop registering them on the jobs seam

**Status:** **Proposed** — critic cold review round 1 (2026-09-24) returned
NO-GO on the original ownerless-registration mechanism (blocking:
`LocalJobRegistry.start` preflights `servesOwner(undefined)` against the
global controller layer only; tool-jobs' controller is scoped inside the CC
standing mount, so an ownerless start throws in production). This revision
switches to de-registration — memory lanes stop using the jobs seam
entirely — and adopts the round-1 per-agent disposal shape (finding 4).
Round 2 (focused, on the amended design): GO-WITH-AMENDMENTS applied —
disposal teardown awaits the job settle (restoring cancel-and-await
exactly), turn-stopping's observation capture-seam rework acknowledged,
consumer/manifest audits verified clean (one-shot ledger is event-driven,
no registry readers lost, no stale manifest anchors).
**Date:** 2026-09-24
**Branch:** `worktree-memory-job-silence` (based on `origin/main` 10dc444).

## 1. Problem

The user reports (and session logs confirm): the TUI conversation is
regularly interrupted by internal housekeeping results. On 2026-09-24
09:32–09:55 alone, six such notices arrived (3 extraction completions, 2
extraction failures, 1 dream completion), each opening or feeding a turn.

Mechanism (anchors verified 2026-09-24 on this branch):

1. The memory lanes register their forks as jobs via the harness jobs seam:
   `jobs.start({ kind: 'subagent', label, owner: agent, run })`
   (`packages/memory/memory-consolidation/src/memory-job.ts:171-180`; the
   structural interface at `:23-31` requires `owner`).
2. The harness `tool-jobs` plugin delivers **unreported completions** to the
   owning agent: `owner.followup(message)` on an idle owner (a new turn) or
   `owner.inject` on a busy one (harness
   `packages/jobs/tool-jobs/src/index.ts:278-299`, default `wakeup`
   delivery; the `maxConsecutiveWakes` budget resets on every human input).
3. Memory jobs are never "reported" (their consumers are the plugin's own
   settle handlers), so **every memory job completion produces a
   model-facing notice and usually a wake**.

The notices are pure noise: the lanes have their own diagnostics
(`.dream-last-error.json`, outcome log records) and their own repair loops;
the model has nothing to act on; and every notice spends the wake budget
that user-initiated background tasks genuinely need.

### Why de-registration (round-1 review finding)

The originally drafted fix — register the job ownerless so tool-jobs'
`if (snapshot.reported || owner === undefined) return` suppresses the
notice — **throws at runtime**: `LocalJobRegistry.start` preflights
`servesOwner(spec.owner)`, and for an unowned producer only the global
(unscoped) controller layer serves it; the only `attachController` caller
(tool-jobs) is mounted inside the CC preset's scoped standing mount, so the
global layer is empty (harness `jobs-local/src/index.ts:315-317`,
`scope/src/store.ts:192`; pinned by harness
`jobs-local/tests/jobs.spec.ts:142-146`). Making ownerless starts work would
require a new host-plane (unscoped) controller plugin and a process-wide
contract change — significant machinery for a silencing fix.

De-registration asks what the jobs-seam registration actually provides the
memory lanes, and removes it:

- **Completion notices** — the problem being fixed.
- **`job_list` rows** — the model's `/tasks` surface lists internal
  housekeeping (`subagent-N extract-memories`). Claude Code has no internal
  jobs; these rows are a dsh-cc artifact, not parity surface.
- **TaskCreated hook events** — the registry-diff bridge
  (`packages/hooks/hooks-claude-code/src/register-events.ts:303-317`) fires
  the user's TaskCreated hooks for every internal memory job. CC's
  TaskCreated fires for user-initiated background tasks; firing it for
  housekeeping is the same noise class in another channel.
- **Owner disposal cancel** — replaced by an explicit per-agent abort
  (§4.2, round-1 finding 4's shape).

The subagent children themselves remain fully observable through the
one-shot ledger's `[observe] +N internal` collapsed row (PR #31 mechanism —
event-driven, independent of the jobs seam) and the session-log forensics
this workspace already relies on.

## 2. Goal

Internal memory jobs (extraction, dream) produce **zero model-facing
completion notices and zero registry presence**, while keeping: their own
diagnostics, their repair loops, subagent-child observability, and a
deterministic per-agent disposal guarantee.

## 3. Non-goals

- No harness changes (read-only directive; verified none needed).
- No change to user-initiated background task notification (the task tool's
  jobs keep owner + notices — PR #115's deliberate design).
- No new mounts, no settings surface, no manifest dimension changes.

## 4. Design

### 4.1 De-register (the fix)

`packages/memory/memory-consolidation/src/memory-job.ts`:

- Delete the `jobs.start({ kind, label, owner, run })` registration block
  and the `JobService` structural interface (the whole seam usage).
- The `jobs` seam lookup in `startMemoryJob` goes with it: the function now
  requires only the `subagents` seam (the existing
  "jobs/subagents seam unavailable" failure branch shrinks to a
  subagents-only check — the R4-era "jobs seam unavailable" failure mode
  loses its jobs half for free).
- `runExtraction`/`runDream` and the PR #132 retry are untouched — they
  consume `startMemoryJob`'s returned `{abort, settled, done}` handles,
  none of which depend on the registry.
- `index.ts` drops `'jobs'` from the plugin's `inject` list
  (`:63`) — the listener path no longer touches the seam.

Net effect: nothing in the process knows about memory work except the
plugin itself (settle handlers, diagnostics) and the subagent ledger
(events) — which is exactly the CC-shaped boundary: internal machinery is
invisible to the model surface.

### 4.2 Per-agent disposal guarantee (round-1 finding 4 shape)

The owner link previously made agent disposal cancel in-flight work
(harness "agent disposal cancels and awaits the job"). Replacement, inside
`startMemoryJob`:

```ts
const dispose = agent.ctx.effect(() => () => { controller.abort('agent disposed') })
```

The returned disposer is invoked on settle (in the job-done `finally`),
so completed jobs leave no accumulated no-op disposers. This is
per-agent-fiber — no module-level shared state, no cross-session leak
(round-1 finding 4), and it restores the old guarantee at the right
granularity. Round-2 finding: the old owner semantics were cancel-**and-await**
(`disposeOwned` awaits `job.settled`), so the teardown callback awaits the
job's own settle after aborting (`await done.catch(() => {})` — cordis
supports async disposers) — one line that restores the exact contract.
The effect registration itself sits inside the existing dispatch-resilience
wrapper (a disposing scope rejects new effects — same throw shape as the old
path, no regression, but wrapped for cleanliness).

### 4.3 Observable behavior deltas (both toward CC semantics)

1. `job_list`/`/tasks` no longer list `subagent-N extract-memories` rows.
2. TaskCreated hooks no longer fire for memory jobs.
3. Completion notices disappear (the goal).
4. Everything else — spawn, retry, diagnostics, lock/marker mechanics,
   `[observe] +N internal`, session-log forensics — is unchanged.

## 5. Test plan

Package: `packages/memory/memory-consolidation` (runner:
`pnpm exec vitest run packages/memory`):

1. **No-registration pin (unit)**: `startMemoryJob` never calls a jobs-seam
   start (provide a jobs service whose `start` throws if invoked — if the
   seam is even provided, it must go unused; the plugin also mounts without
   a jobs seam at all).
2. **Per-agent disposal (unit)**: fake agent context with effect disposal —
   start a job, dispose the agent fiber, assert `controller.abort` ran with
   the disposal reason; assert a settled job called its disposer (dispose
   after settle does not abort).
3. **Seam-requirement change**: the subagents-missing branch still fails
   cleanly (existing spec updated: jobs no longer required — the failure
   detail text changes accordingly).
4. **Existing suites updated (round-2 finding)**: `dispatch-resilience.spec.ts`
   and `turn-stopping.spec.ts` currently **capture the done/cancel controls
   through the jobs.start mock** — with the seam gone, that observation
   harness must be rewired to capture through the subagents mock or
   `startMemoryJob`'s returned handles (a capture-seam swap, not just
   dropping fixtures). Dream retry spec behavior is otherwise unchanged.
5. **Real-stack tripwire**: `dream-fork-surface.spec.ts` already runs
   without the jobs seam (unscoped harness testkit, no registry mount) —
   after this change it exercises the production shape exactly (fork
   materializes and reports without any jobs registration), no new
   scaffolding needed.

### Local gates (each separately, exit codes visible)

`pnpm exec vitest run packages/memory`,
`pnpm -w exec tsc -b tsconfig.packages.json`,
`node scripts/check-capability-evidence.mjs`,
`node scripts/generate-parity-matrix.mjs --check`,
`pnpm check:spec-deps`, `pnpm check:deep-imports`,
`node scripts/check-file-size.mjs`.

### Dogfood verification (post-deploy)

After merge + profile sync + restart: a working period shows **zero**
`background job … finished` messages; extraction/dream keep running
(verify via child session materialization + `.dream-last-error.json`);
`/tasks` no longer lists internal rows; user-initiated background tasks
still notify.

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| Someone relied on memory jobs in `job_list` for debugging | Session logs + `[observe]` row + diagnostics file remain the forensics path (this workspace's own practice); documented here |
| TaskCreated parity surface shrinks (no events for internal jobs) | Toward CC semantics (CC has no internal jobs); recorded as a deliberate delta in the manifest note |
| Disposal semantics change | Restored exactly: the per-agent effect teardown aborts then awaits the job's settle (round-2 amendment); the fork's own lifecycle was already parent-context-bound |
| Spec fixtures drift | Test 1 pins non-use structurally (a throwing jobs service) |

## 7. Open questions

- Should `/tasks` grow an explicit internal-jobs debug view (G2
  observability follow-up territory) instead of losing rows silently? Deferred
  to the G2 tracking item.
- The dream-failure visibility now rests entirely on the diagnostics file +
  logger (G2 gap unchanged by this fix).

## 8. DoD

1. §5 specs green; full memory suites green; all listed gates exit 0.
2. Diff confined to `packages/memory/memory-consolidation/**` plus this doc
   and a manifest evidence-row update (no dimension changes).
3. PR body carries the production evidence (six notices in ~25 minutes),
   the round-1 NO-GO finding, and the dogfood protocol.
