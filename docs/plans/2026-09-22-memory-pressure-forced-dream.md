# Memory index pressure → forced consolidation (dream) trigger

**Status:** **Implemented** — PR #102 (2026-09-22, open). Critic cold review round 1
(2026-09-22: blocking #1/#4 stamp `lastForcedAt` before lock acquisition,
major #2 dead fork-write-back arm point dropped, major #3 queued sentence
gated on arming success, minors #5–#8) incorporated before implementation.
**Date:** 2026-09-22
**Worktree:** `.claude/worktrees/memory-full-debug` (branch `worktree-memory-full-debug`)

## 1. Context

PR #80 (G4) added the write-side index gate: a `memory_save` (or fork write-back)
that would push `MEMORY.md` over 200 lines / 25 000 bytes is rejected with an
actionable error, or fail-open-allowed when the index was *already* over limit.
G5 reworked the consolidation prompt (AutoDream five-phase).

What is still missing is any linkage between the gate and consolidation. Today
the only dream trigger is the turn-stopping gate in
`packages/memory/memory-consolidation/src/index.ts` (`runDream`): ≥24 h since
the last consolidation AND ≥5 new sessions (defaults; the preset mounts the
plugin with no config). Index pressure is not an input.

Verified damage (2026-09-22, this workspace's memory dir):

- `MEMORY.md` sat at 24995 / 25000 bytes; every new-entry `memory_save` was
  rejected. The in-session model answered the error with "索引已满，跳过存档"
  instead of acting on it — the error text is the *only* feedback channel, and
  it depends on the model's goodwill.
- `.consolidation-lock` has never existed for the directory: no dream has ever
  completed there. Whether that is gate arithmetic or silent fire-and-forget
  failure is invisible (G2 observability is a known leftover), so "wait for the
  periodic dream" is not a reliable repair path.

Known leftovers from the G4/G5 design (§6 of
`docs/plans/2026-09-16-memory-g4-g5-write-gate-and-dream-prompt.md`) that this
doc does **not** take on: G1 `/dream` manual command, G2 observability
surface, G3 settings keys, G6 daily logs, global-directory dream coverage.

## 2. Goal

When the write-side gate signals index pressure, durably queue a consolidation
that the next turn-stopping executes **bypassing the time/session gates**, with
a cooldown so failures cannot hot-loop, and marker cleanup on success. Also
append one truthful model-visible sentence to the rejection/warning text so the
in-turn model knows a repair is queued (closing the "just skip the save"
failure mode observed in production).

## 3. Non-goals

- Manual `/dream` (G1), settings exposure of gates (G3), dream coverage for the
  global memory dir, TUI/user-notice surfacing (G2). The appended error-text
  sentence is the minimum viable observability; anything richer belongs to G2.
- Changing the existing time/session gate defaults or the consolidation prompt.
- Deleting individual memories via a tool (still only dream/overwrite).

## 4. Design

### 4.1 Pressure marker

New file inside the memory dir: `.consolidation-needed`, content
`<armedAtMs>\n<lastForcedAtMs>\n` (two lines, mirrors `lock.ts`'s
`<pid>\n<at>\n` convention — the fs seam exposes no `remove`, so "clear" must
be a tombstone write, exactly like `rollbackLock`).

Semantics:

- `armedAt > 0` → pressure pending; value is the epoch of the latest arming.
- `armedAt = 0` → tombstone (cleared by a successful dream); `lastForcedAt`
  survives so the cooldown still applies to a fresh arm.
- Absent or unparseable content → treated as absent (defensive, mirrors
  `lock.ts`'s `parse`).

New module `packages/memory/memory/src/pressure.ts` (`@dsh-cc/memory` owns
everything that writes into a memory dir; `@dsh-cc/memory-consolidation`
already depends on it — `memoryWritePolicy`, `validateMemoryWrites`):

- `PRESSURE_FILE` — the filename constant `.consolidation-needed`.
- `readPressure(fs, dir) → { armedAt, lastForcedAt }` — best-effort read; all
  failures and corrupt content yield zeros.
- `armPressure(fs, dir, now, policy?) → boolean` — (re)writes
  `<now>\n<lastForcedAt>\n`, preserving the previous `lastForcedAt` when
  recoverable, else 0; re-reads immediately before writing so a concurrent
  forced launch's fresh stamp is not clobbered (residual single-iteration race
  accepted and bounded, critic #6). Returns whether the write landed: callers
  that promise "consolidation queued" in model-visible text must gate that
  sentence on this return value (critic #3).
- `markPressureForced(fs, dir, armedAt, now, policy?)` — rewrites
  `<armedAt>\n<now>\n`; called by the consumer *before* lock acquisition (see
  §4.3).
- `clearPressure(fs, dir, now, policy?)` — tombstone `0\n<now>\n` (preserves
  the cooldown timestamp as the new `lastForcedAt`).

All writers are best-effort (failure swallowed): arming must never break a
save, and marker hygiene must never break a dream. Re-export from
`packages/memory/memory/src/index.ts` next to `memoryWritePolicy`.

### 4.2 Arming points (`packages/memory/memory/src/save.ts`)

Two places in `memorySave.execute`, workspace scope only:

1. **Push-over rejection.** Wrap the `validateMemoryWrites(...)` call: on a
   throw whose message contains `would exceed its cap` (the gate's stable
   phrase, writeback.ts), `await armPressure(...)`; **if and only if the arm
   landed**, rethrow with one appended sentence: `A forced consolidation has
   been queued; the next turn-end will run it, bypassing the usual periodic
   gates.` A swallowed arm failure must yield the original message — a false
   promise is exactly the model-trust failure this design exists to close
   (critic #3). Global-scope rejections neither arm nor append (the global dir
   has no dream coverage; the marker would be orphan state and the sentence
   would be a lie).
2. **Legacy fail-open over-limit** (`preExistingOverLimit === true`, workspace
   scope only): `armPressure(...)` after the write succeeds, and — only if the
   arm landed — append the same sentence to the existing WARNING line.

**No fork-path arming** (critic #2): `applyEntrypointFallback` truncates any
over-limit `MEMORY.md` before `validateMemoryWrites` sees it
(memory-consolidation/src/index.ts), so the fork write-back can never throw
the entrypoint-cap error — an arm point there would be dead code, and matching
on any-throw would let a persistently malformed fork arm forced dreams
forever. The reachable fork rejections (bad filename, 64 KiB file,
batch-total) are not pressure; they stay as invisible as they are today.

### 4.3 Consumption (`runDream` in memory-consolidation)

New config knob next to `minHours`/`minSessions`:
`pressureCooldownMinutes: z.number().default(60)`. `apply()` reads it and
passes it through; the real signature stays positional:
`runDream(ctx, agent, home, provider, minHours, minSessions,
pressureCooldownMinutes)`.

```
runDream(...):
  dir ← resolveWorkspaceMemoryDir(...); now ← Date.now()
  pressure ← readPressure(fs, dir)
  if pressure.armedAt > 0:                       // pressure mode
      if now - pressure.lastForcedAt < cooldownMinutes → return   // throttled
      markPressureForced(fs, dir, pressure.armedAt, now, ...)     // BEFORE lock:
          // consumes the cooldown slot even if the lock is held or the spawn
          // never happens — safe failure direction; makes the crash-window
          // spawn storm structurally impossible (critic #1/#4)
  else:                                          // periodic mode (unchanged)
      lastAt ← readLastConsolidatedAt(...); sessionIds ← listNewSessions(...)
      if !gatesPass(...) → return
  priorAt ← tryAcquireLock(...); if null → return                 // unchanged
  job ← startMemoryJob(...)                                       // unchanged
  on job.settled(ok):
      if !ok → rollbackLock(...)                    // unchanged; marker KEEPS
                                                    // its lastForcedAt stamp
      if ok  → clearPressure(fs, dir, now, ...)     // both modes (see notes)
```

Notes on the decisions a reader might trip over:

- **Clear on success only, for both modes.** A successful periodic dream also
  rebuilds the index, so a stale pending marker is obsolete by definition.
- **Failure keeps the marker** (with the pre-lock `lastForcedAt` stamp): the
  next turn-stopping retries once the cooldown elapses. Bounded: at most one
  forced attempt per cooldown window per memory dir; the ordinary 24 h gate
  also keeps firing independently. If dreams fail permanently, the marker
  persists harmlessly (tiny file, inert if the plugin is unmounted) and saves
  either fail-open (already-over-limit index) or keep rejecting with the same
  queued message — no worse than today.
- **Cooldown is measured from `lastForcedAt`, not `armedAt`**: a tight arm
  loop (every save rejecting) cannot spin dreams faster than the knob.
- **Stamp-before-lock consumes a slot without an attempt when the lock is
  held** (live dream, or a stale PID inside `LOCK_STALE_MS`): deliberate —
  without it, every turn-stopping during the lock-hold window retries
  unthrottled (critic #4).
- **Cooldown carry-over after success**: the tombstone preserves
  `lastForcedAt`, so pressure armed within one window of a successful forced
  dream waits out the remainder — deliberate throttle, not a bug (critic #5).
  Backwards clock skew (negative delta) counts as within-cooldown
  (conservative direction).
- **Periodic-mode cost note**: pressure mode skips `listNewSessions` gating
  but not `tryAcquireLock` or the `dreamInFlight` single-flight — concurrency
  posture unchanged.
- First-ever pressure run on a never-consolidated dir (lastAt = 0) reviews all
  live sessions — that is the existing AutoDream first-run case, not new cost
  introduced by this change.

### 4.4 Why not consolidate in-line at rejection time

`memory_save` rejects mid-turn inside `@dsh-cc/memory`, which has neither the
`jobs` nor the `subagents` seam; spawning a fork from there would duplicate
memory-consolidation's job plumbing and single-flight discipline. The marker
keeps `@dsh-cc/memory` free of new service dependencies and reuses the one
existing spawn point (turn-stopping). The worst-case latency added is one
turn — acceptable for a gate that today has no automation at all.

## 5. Tests

`@dsh-cc/memory`:

- `tests/pressure.spec.ts` (new): parse/format round-trip; absent and corrupt
  content → zeros; tombstone semantics; arm preserves `lastForcedAt`;
  `markPressureForced` / `clearPressure` byte-exact outputs.
- `tests/save.spec.ts`: push-over rejection on workspace scope arms the marker
  and appends the queued sentence; a failed arm (fs write throw) leaves the
  message unchanged; global-scope rejection arms nothing and leaves the
  message untouched; fail-open over-limit workspace save arms and extends the
  WARNING only on arm success. (Extend the existing fake-fs harness used by
  writeback.spec.ts.)
- Boundary cases (the repo's known traps): exactly 200 lines / 25 000 bytes
  passes vs 201 lines / 25 001 bytes rejects, with multibyte content — the
  UTF-8-vs-UTF-16 trap already exercised in truncate.spec.ts is the precedent.

`@dsh-cc/memory-consolidation`:

- `tests/turn-stopping.spec.ts`: marker armed → dream spawns even when
  `gatesPass` would fail (fresh lastAt, < minSessions); `lastForcedAt` is
  stamped BEFORE `tryAcquireLock` (assert via fake-fs write ordering) so a
  held lock still consumes the cooldown; within cooldown → no spawn AND no
  lock attempt; job success tombs the marker; job failure keeps it (stamp
  preserved); periodic-mode success also clears a pending marker; marker
  armed while a dream is already in flight must not spawn a second (the
  existing `dreamInFlight` single-flight covers it — assert, don't assume);
  no marker → existing behavior byte-identical (the prompt golden is
  untouched — `buildConsolidationPrompt` is not modified by this change).

## 6. File-by-file execution plan (one pass)

0. `pnpm install --frozen-lockfile` first (worktree; node_modules absent).
1. `packages/memory/memory/src/pressure.ts` (new) + re-export in `src/index.ts`.
2. `packages/memory/memory/src/save.ts`: wrap validation, two arm points,
   conditional message appends (workspace scope only).
3. `packages/memory/memory-consolidation/src/index.ts`: `runDream` pressure
   branch with stamp-before-lock, config schema knob (`pressureCooldownMinutes`,
   default 60), clear-on-success in both modes.
4. Tests per §5.
5. This doc's status → Implemented in the PR commit.

Gates to run before committing: package-scoped vitest for both memory packages
(then the full suite if the scoped runs pass), `tsc -b`,
`pnpm check:spec-deps`, `pnpm check:capabilities`, `pnpm docs:parity`
(expected no-op: the memory subsystem is not a CC-parity manifest surface, but
the checks must confirm rather than be assumed), `check:deep-src-imports`
(CI-only gate — run it locally on purpose). README trio: only if a package
README enumerates exports that this change extends — check, and if touched
re-record the README hash gate (`--write` passthrough per package.json script).

## 7. Risks

- **Cost**: a persistent over-cap index costs one dream spawn per cooldown
  window until a dream succeeds. The consolidation-side truncation fallback
  (G4) guarantees a *successful* dream leaves the index under cap, so the loop
  self-heals once a spawn succeeds.
- **Crash windows**: the `lastForcedAt` stamp lands before `tryAcquireLock`,
  so a kill anywhere after the stamp can only *consume* a cooldown slot — the
  spawn-storm failure mode is structurally impossible. A kill before the stamp
  leaves the marker armed with the old stamp and the next turn-stopping
  retries within the same window — the safe direction. No lost-pressure mode.
- **Scope confusion**: arming is workspace-scope-only on purpose; the code
  comment in save.ts must say so, otherwise a future reader will "fix" the
  global path.
- **Marker durability**: an armed marker survives process restarts, so a
  rejection in one session is honored by later sessions in the same workspace
  — the cross-process repair channel the error text alone never had.
