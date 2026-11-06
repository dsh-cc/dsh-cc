# Design: memory-write-lifecycle (concurrent save, consolidation and the pressure marker)

Model directory: `specs/tla/memory-write-lifecycle`. Module `Model`, spec `Spec`,
safety-only. This is the first model of the memory write path. It changes no
production code: it pins the intended protocol and exposes six windows the
current code leaves open, one per fault switch.

**Issue #336 revision** (second revision; the first was issue #335): a
successful dream now RELEASES the lock — the holder is cleared, the
acquisition epoch (which doubles as lastConsolidatedAt) is kept — so the next
dream, pressure or periodic, is gated only by its own cooldown or time gate
and never by the stale window of a successful predecessor. New fault switch
`KeepStampOnClear` models the pre-fix retained stamp, new invariant S-7
`HolderLegal` pins that a recorded holder is a dream in flight or a crashed
process, and the new `success-release` case (StaleTicks=3 > TMax: the stale
reclaim is structurally unreachable) proves a second dream acquires through
the release alone. The success path AWAITS the release before the marker
clear (an ordering guarantee — fire-and-forget chains interleave), and
`rollbackLock` gains the same guarded read-verify (a review finding: an
unguarded rollback would free a live reclaimer's lock under the post-fix
acquire).

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — session request "model the memory write
  path" 2026-11-03〔src:ws:specs/tla/memory-write-lifecycle/implementation.md#L13-L24〕, manual adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L103-L178〕
- triggerIds: FD-T1 (two host processes share one memory directory and mutate 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L254-L377〕
  the same index, topic files and lock), FD-T3 (a crash mid-batch decides
  whether the index and the topic files agree; the consolidation lock survives
  a crash and is reclaimable only through the stale window).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/memory-write-lifecycle"}`〔src:ws:specs/tla/memory-write-lifecycle/design.md#L19-L30〕.
- behavioural source: current code, not a plan document —
  `packages/memory/memory/src/save.ts:199-240`,
  `packages/memory/memory/src/writeback.ts:141-178`,
  `packages/memory/memory-consolidation/src/lock.ts:71-160`,
  `packages/memory/memory/src/pressure.ts:47-95`,
  `packages/memory/memory-consolidation/src/gates.ts:29-32`,
  `packages/memory/memory-consolidation/src/index.ts:300-397`,
  `packages/memory/memory-consolidation/src/memory-job.ts:76-89`.

## Requirements

- **REQ-1 (no lost pointer)** A pointer a save committed after a writer's
  snapshot is still in the index when that writer publishes. The save/save lost
  update, a consolidation erasing a newer save and an extraction erasing one
  all violate this. The intended mechanism is read-verify-write against the
  index REVISION the writer read — the read-back idiom `lock.ts:100-106`
  already applies to the lock file. A revision, not just a pointer set, is
  required: a save that rewrites an existing pointer's content leaves the set
  unchanged but still invalidates an older writer's snapshot.
- **REQ-9 (three writers)** The extraction fork is a third writer on the same
  index and takes no lock (`index.ts:218-235` → `memory-job.ts:150-151`), so
  REQ-1 applies to it exactly as to the save and the dream.
- **REQ-2 (no dangling pointer)** The index never points at a topic file that
  was not written first. The save path gets this from writing the topic file
  before the pointer; the dream batch has no such ordering rule in code.
- **REQ-3 (index cap)** The publication of the index stays within its cap. For
  the save path the decision is taken at read time against the snapshot the
  save read (`save.ts:200-222` validates topic + upserted pointer as one
  batch); for the dream the truncate fallback (`memory-job.ts:76-89`) is the
  in-cap way to serve an over-limit report.
- **REQ-4 (pressure promise)** An arm of the forced-dream marker is never
  tombstoned without a dream that served it. This is the safety half of the
  "consolidation queued" sentence the save appends to its rejection message
  (`save.ts:232-238`).
- **REQ-5 (one dreamer)** At most one process is inside the dream critical
  section at a time, and it is the recorded lock holder.
- **REQ-6 (epoch integrity)** A failed or killed dream rolls the consolidation
  epoch back to the value captured before acquisition (`lock.ts:120-124`); a
  completed one advances it. Structural action guard — see E-4.
- **REQ-7 (crash recovery)** A crashed lock holder is reclaimable only through
  the stale window, and no live state is stuck: the reclaim guard plus
  `CHECK_DEADLOCK TRUE` with `Idle` enabled only when every process is dead.
- **REQ-8 (declared preemption only)** Mutual exclusion may be broken only by
  the stale-window reclaim of a holder that outlived the window — the
  behaviour `lock.ts:19` documents ("stale past this even if it is still
  alive"). A dream starting under `FreeTicks` must reproduce exactly that and
  nothing broader.
- **REQ-10 (release on success, issue #336)** A completed dream leaves the
  lock free — holder cleared, epoch kept — so the next dream is refused only
  by a concurrent live holder, its own cooldown or the periodic time gate,
  never by the stale window of a successful predecessor. A recorded holder is
  legal only while its dream is in flight or its process has crashed.

## State variables

| Variable | Meaning | Durability |
|---|---|---|
| `idx` | pointer set of `MEMORY.md` (a line set; order carries no requirement) | survives crashes |
| `topic` | per-name topic-file body presence | survives crashes |
| `lock` | consolidation lock file: holder + stored epoch | survives crashes |
| `stamp` | pressure marker: `armedAt`, `lastForcedAt` | survives crashes |
| `lastArmAt` | newest arm timestamp (pressure is level-triggered) | survives crashes |
| `lastServedAt` | newest arm a completed pressure dream served | survives crashes |
| `rev` | index revision: every index write bumps it | survives crashes |
| `savedSince` | names whose pointer a save ADDED after the current writer's snapshot | survives crashes |
| `pend`, `alive`, `now` | in-flight action record per process, liveness, logical clock | lost on crash |

Atomicity mapping: `SaveIndex` is one read-verify-write commit (the intended
transaction); `DreamPublish` the same over the fork snapshot; `DreamWriteTopics`
and `DreamPublishFirst` are the two halves of the dream batch, which is why a
crash between them is reachable; `DreamLock` is `tryAcquireLock` including its
read-back verify; `DreamPressureAtomic` is the convention's atomic pressure
entry (the fixed protocol up to the atomic abstraction — a state-space budget
device); `DreamReadPressure` + `DreamStampPressure` are the real code's two
steps (the split is enabled by the `SplitStamp` fault or by the dedicated
`split-stamp-fixed` case, whose stamp write carries the fixed
no-resurrect/max semantics); `DreamClear` is the conditional clear with
truthful service accounting in both shapes, plus (issue #336 fix) the guarded
lock release — holder cleared, epoch kept, skipped when a reclaimer took the
file (`lock.holder = p`). The release and the clear are one atomic step in
the model; their two-write crash window in the code is E-1g.

## Coverage matrix

| Requirement ID | Business outcome | Property ID | TLA operator | Case IDs and bounds | Fault-or-race trace | Assumption IDs | Planned code symbol and atomicity mechanism | Regression scenario | Exclusion and justification |
|---|---|---|---|---|---|---|---|---|---|
| REQ-1 | a pointer committed after a snapshot is never silently lost; the three writers cannot overwrite each other from stale snapshots | S-1 `NoLostSave` | `NoLostSave` | convention; strict-unlocked-save, strict-dream-no-cas, strict-unlocked-extract (expected red) | `SaveRead(p1)` → `SaveRead(p2)` → both `SaveIndex` → the second writes its stale snapshot and drops the first pointer; `DreamFork` → `SaveIndex` → `DreamClobber` writes the pre-save content | A-1, A-2, A-3 | `save.ts:200-219` read/upsert + `writeMemoryFiles`; the intended guard is read-verify-write (as `lock.ts:100-106`), absent in both writers today | two processes saving concurrently; save during an in-flight dream | — |
| REQ-2 | the index never references a missing topic file | S-2 `NoDanglingPointer` | `NoDanglingPointer` | convention; strict-index-first (expected red) | `DreamPublishFirst` publishes the pointer, `Crash(p)` before `DreamTopicsAfter` | A-4 | `writeback.ts:174-178` sequential writes: the save batch is topic-first by construction, the dream batch order is fork-decided | crash between the index write and the topic write | — |
| REQ-9 | the extraction fork obeys the same index discipline | S-1 via `ExtractIndex` | `NoLostSave` | strict-unlocked-extract (expected red) | an extraction write built on a pre-save snapshot publishes | A-11 | `index.ts:218-235` → `memory-job.ts:150-151` writes through `writeMemoryFiles` with no lock | a turn-end extraction racing a save | — |
| REQ-3 | a published index respects the cap | S-3 `CapSound` | `CapSound` | convention; strict-skip-cap (expected red) | a batch whose content exceeds `MaxLines` publishes it | A-5 | `writeback.ts:141-154` gate + `memory-job.ts:76-89` truncate fallback | dream reporting an over-limit index | fail-open save into an already over-limit index is E-3 |
| REQ-4 | an armed marker reaches a dream; the model-visible "queued" sentence is not a lie 〔src:ws:specs/tla/memory-write-lifecycle/code-anchors.md#L180-L252〕 | S-4 `NoLostPressure` | `NoLostPressure` | convention; split-stamp-fixed (the fixed split stamp, green); strict-split-stamp, strict-clear-without-run (expected red) | `SaveReject` arms at `t` during a running dream → the PRE-FIX `DreamClear` tombstones it without serving; the PRE-FIX stamp clobbers a between-read-and-stamp re-arm | A-6, A-7 | `pressure.ts` (issue #335 fix): `armPressure` monotone, `markPressureForced` re-reads and preserves the newer arm without resurrecting, `clearPressure` conditional on `servedArmedAt`; `index.ts` clears with the arm captured at the dream's initial read | concurrent cap rejection during a running dream; re-arm between the dream's read and its stamp | wall-clock "eventually" is L-1, excluded; the re-read-to-write residual windows are E-1b |
| REQ-5 | one consolidation per memory directory | S-5 `OneDreamer`, `HoldsLock` | same | convention | two dreams race the lock; one reclaims a stale-stamped lock | A-8 | `lock.ts:71-108` acquire = write + read-back verify | two sessions dreaming at once | the accepted sub-millisecond symmetric collision is E-2 |
| REQ-6 | the consolidation epoch never silently regresses or advances without a run | structural (`DreamFail`) | `DreamFail` | convention | dream fails after acquiring: lock rewritten with `priorAt` | A-8 | `lock.ts:120-124` `rollbackLock` | a failed dream must not consume the cooldown epoch | E-4 |
| REQ-7 | a crashed holder blocks, then is reclaimable; no stuck live state | structural (deadlock check + reclaim guard) | `DreamLock`, `Idle` | crash-reclaim (`StaleTicks=1`; under quiescent ticks the stale arm is unreachable in `convention` — see the bounds note) | `Crash(p1)` while holding the lock, `Tick` past `StaleTicks`, `p2` reclaims | A-8, A-9 | `lock.ts:84` stale window (1h, independent of liveness) | kill a dreaming process | — |
| REQ-8 | only the declared stale-window preemption breaks exclusivity | S-6 `OneDreamer` under `FreeTicks` | `OneDreamer` | convention (ticks quiescent); strict-live-preemption (expected red) | `DreamStampPeriodic` → `DreamLock` reclaims a live holder whose stamp passed the window | A-10 | `lock.ts:19` stale window is time-based, not PID-based | a dream longer than the window | a dream of minutes against 1h is why ticks are quiescent by default (A-12) |
| REQ-10 | a completed dream leaves the lock free; the next dream is gated only by its own cooldown/time gate, never by a successful predecessor's stale window | S-7 `HolderLegal` | `HolderLegal` | convention; success-release (StaleTicks=3 > TMax, so acquisition can only go through the release); strict-keep-stamp (expected red) | `DreamClear` with `KeepStampOnClear` leaves the holder stamped after completion → the next pressure dream, past its own cooldown, is `DreamBlocked` until the stale window passes | A-8, A-13 | `lock.ts` `releaseLock` (guarded read-verify rewrite, holder→0, epoch kept) called before `clearPressure` in both success branches (`index.ts`); `tryAcquireLock` treats holder 0 as free | a successful dream followed by a pressure dream past its cooldown inside the stale window | the release/clear two-write window is E-1g; a failed release write is E-1h (best-effort cleanup) |

## Assumptions

- **A-1** A single `fs.writeText` per file either lands whole or leaves the
  previous content; torn files are excluded (E-1).
- **A-2** The index content is a pointer set for the purposes of the
  requirement: line order and prose are carried, not semantically required.
- **A-3** The read-back verification of an index write is truthful and atomic
  in the abstract model.
- **A-4** Topic-file and index writes are separately atomic and separately
  ordered; there is no cross-file transaction (`writeback.ts:161-163` states the
  deterministic-prefix behaviour).
- **A-5** The cap gate and the truncate fallback are truthful summaries of the
  batch content.
- **A-6** The pressure marker is a two-field file; a failed read yields zeros
  (fail-open, `pressure.ts:56-60`), which the model reflects as "no pressure".
- **A-7** (issue #335 fix revision) The fixed writers re-read the marker
  immediately before both the stamp and the clear: the stamp keeps the NEWER
  of the captured and current arms without resurrecting a tombstone, and the
  clear tombstones only arms the dream accounted for (`servedArmedAt`). Arms
  are strictly increasing (the monotone arm, `armPressure`'s
  `max(now, previous + 1)`), so same-timestamp collisions cannot alias two
  arms; the residual re-read-to-write windows are excluded as E-1b.
- **A-8** The lock file's stored epoch is the sole staleness signal for a
  RECORDED holder; PID liveness is not consulted (`lock.ts:19`). A released
  lock (holder 0) is free regardless of its epoch — the epoch doubles as
  lastConsolidatedAt, which the periodic time gate reads. Corollary: a FAILED
  dream no longer fences the next dream on a fresh `priorAt` (the rollback's
  released form is free; only a foreign recorded holder blocks).
- **A-13** (issue #336 fix revision) The success-path release is a guarded
  read-verify-write: it rewrites the file to the released form (holder 0,
  epoch kept) only when the content still carries exactly this holder+epoch;
  a stale-window reclaimer that took the file mid-dream owns it and the
  release is skipped. In the model this is the `lock.holder = p` arm of
  `DreamClear`; the residual re-read window is the same accepted class as
  E-1b. The rollback (`DreamFail`) carries the same guard. The content
  equality can alias a PID-reusing process that acquired at the identical
  epoch millisecond — the same accepted class as E-2. Abstraction
  boundary: the model's `lock.holder = p` check stands for the code's full
  content equality (holder AND epoch) and assumes one outstanding acquisition
  per process; in the code the dispatch flag can reset while an earlier
  `job.done` callback is still pending, so the same PID may re-acquire at a
  NEW epoch while the old callback is outstanding — the epoch comparison
  makes the old callback's release/rollback skip (the new acquisition is not
  ours to free), which the one-acquisition model cannot represent. Pinned by
  a same-PID-reacquire regression test.
- **A-9** Logical ticks stand for the 1h stale window / 60m cooldown / periodic
  time gate; the model does not claim real durations.
- **A-10** The index revision is a faithful stand-in for byte equality: any
  index write changes the revision, so a writer's read-verify compares the same
  fact a durable-byte comparison would.
- **A-11** The extraction fork writes through the same `writeMemoryFiles` gate
  as the dream's batch (`memory-job.ts:150-151`).
- **A-12** A tick is a quiescent boundary: clock advance during a critical
  section is not part of the default run, because a dream of seconds against a
  one-hour window does not cross it. `FreeTicks` removes the restriction so the
  preemption stays reachable as a probe.

## Faults modeled (one switch per probe)

| Switch | Models | Probe |
|---|---|---|
| `UnlockedSave` | a save index write from its own stale snapshot, no verification | strict-unlocked-save |
| `DreamNoCas` | a dream batch publishing over the index without checking it still matched | strict-dream-no-cas |
| `DreamIndexFirst` | publishing the index before the topic files it points at | strict-index-first |
| `ClearWithoutRun` | the PRE-FIX unconditional tombstone (the service accounting stays truthful, so the probe isolates the tombstone decision) | strict-clear-without-run |
| `SkipCap` | dropping the batch cap guard | strict-skip-cap (defence in depth: the write-back gate and the truncate fallback also enforce the cap, so this is not a live code gap) |
| `UnlockedExtract` | an extraction index write from its own stale snapshot | strict-unlocked-extract |
| `MissingTopic` | a batch that omits a topic file the index still points at | strict-missing-topic |
| `SplitStamp` | the PRE-FIX stamp write: the split read-then-stamp whose write carries the CAPTURED arm (clobbering a concurrent re-arm and resurrecting tombstones) | strict-split-stamp |
| `AtomicPressureEntry` | scheduling only: `TRUE` keeps the convention's atomic pressure entry (state-space budget); the dedicated `split-stamp-fixed` case sets it `FALSE` so the FIXED split stamp semantics are checked across the real read-to-stamp gap | split-stamp-fixed |
| `FreeTicks` | the clock advancing inside a critical section (live-holder preemption) | strict-live-preemption |
| `KeepStampOnClear` | the PRE-FIX completion path: the dream keeps the holder and epoch stamped in the lock file, so the epoch-only stale check blocks the next dream until the window passes (issue #336). Fidelity limit: `DreamBlocked` excludes the same holder, so
the probe pins the safety violation at `DreamClear` itself, not the
blocked-retry shape production also shows | strict-keep-stamp |

## Bounds

Two processes, three candidate names, `MaxLines=2`, `StaleTicks=2`,
`CooldownTicks=1`, `MinTicks=1`, `TMax=2`, `Revs=3`, 2048 MiB — and a shortened stale window in the two lock-focused cases, so the reclaim is reachable inside the tick budget〔src:ws:specs/tla/memory-write-lifecycle/implementation.md#L13-L24〕. Two processes are the
minimum that exposes a cross-process write race; three names let a dream exceed
the cap of two, and let a compaction free room for a save during a dream.

Bounds note (review finding): under quiescent ticks the stale reclaim is
dead in `convention` itself — every acquisition stamps `at = now >= 1` (the
entry gates force at least one tick), so `now >= at + StaleTicks` with
`StaleTicks=2` needs `now >= 3 > TMax`. `crash-reclaim` (`StaleTicks=1`) is
therefore the ONLY case exercising the stale window, and `success-release`
is a CONDITIONAL structural certificate (its DISTINCT-state count matches
the convention's exactly — 10,926,712; the generated count differs by 65,634
of ~63M, a fringe-ordering artifact of the different case orderings): it
establishes safety under the stale arm disabled, not the reachability of a
second acquisition — that reachability witness is the code regression (a
completed dream, then a pressure dream past its cooldown acquiring within
the stale window), not a TLC property.

Issue #336 revision adjustments: `DreamClear` now also updates `lock` (the
guarded release), which adds states only where `DreamClear` fires — the
released form (holder `"none"`, fresh epoch) already existed via `DreamFail`.
The new `strict-keep-stamp` probe runs at `Revs=3` (probe budget, like the
other strict cases) and checks only `TypeOK` + `HolderLegal`. The new
`success-release` case runs the convention shape at `StaleTicks=3` — above
`TMax=2`, so `now >= lock.at + StaleTicks` is unsatisfiable and any second
acquisition provably went through the release, not the stale reclaim.

Issue #335 revision adjustments: the monotone-arm domain widening (E-1f) costs
roughly 30% more convention states, so the convention's revision budget drops
`Revs` 3→2 to stay inside the 600 s per-case budget — the revision-depth
dimension is untouched by this fix, and its fault coverage lives in the strict
probes, which keep `Revs=3`. The dedicated `split-stamp-fixed` case runs the
FIXED split stamp shape at `AtomicPressureEntry=FALSE`, `Revs=2` (its role is
the pressure semantics across the real read-to-stamp gap, not the
revision-heavy lost-save traces the probes already cover).

## Exclusions

- **E-1a** content regression of an existing memory: `topic` records presence,
  not bodies, so an overwrite that leaves the pointer set unchanged is
  invisible to the invariants. The revision guard rejects such a write
  structurally in the intended protocol; the model cannot observe the body.
- **E-1b** the accepted re-read races over the two-field marker file
  (issue #335 fix revision): `armPressure`'s own re-read-to-write window, the
  stamp's equivalent window (an arm landing there can still be clobbered), and
  the clear's window (an arm landing there can still be tombstoned) — all
  single-iteration, sub-millisecond windows, the same accepted class the
  pre-fix `armPressure` documented (`pressure.ts` header). The fix narrows
  Face A's unbounded read-to-stamp gap to these windows and makes every
  interleaving outside them conservative; it does not eliminate the class
  (the fs seam offers no CAS, the stamp deliberately precedes lock
  acquisition, and arming must never block on the dream lock).
- **E-1f** (issue #335 fix revision) the monotone arm is bounded: the code's
  `max(now, previous + 1)` grows without bound across same-tick arms; the
  model caps it with `ArmMax == TMax + 1` and a `stamp.armedAt < ArmMax`
  guard on `SaveReject` — a declared exclusion. Values up to `TMax` come
  from arms at distinct ticks; one same-tick re-arm (the only case where the
  `+1` is needed, because the clock cannot advance during a dream's critical
  section) reaches `TMax + 1`. A second same-tick re-arm repeats the same
  aliasing structure and is excluded; excluding arms only shrinks the state
  space, and arms are the only actions that could break `NoLostPressure`.
- **E-1d** the lost-update log is a single set, not attributable per writer: a
  snapshot-then-abort interleaving can blind it for older in-flight writers.
  Under the convention the revision guard is the actual protection, and each
  fault probe still produces its counterexample on the shorter trace.
- **E-1e** `gates.ts:29-32` opens the periodic gate immediately on a zero
  epoch; the model delays the first periodic dream by one tick. The same-holder
  stale reclaim IS modeled (`lock.ts:84-87` reads only the epoch).
- **E-1c** the pressure-mode zero-scan return between the stamp and the lock
  (`index.ts:320-323`) and the failed-outcome bounded retry reusing the held
  lock (`index.ts:376-396`): reachable behaviours that change no property.
- **E-1g** (issue #336 fix revision) the release and the clear are two
  writes with a crash window between them. The release runs FIRST and is
  AWAITED (a `void` fire-and-forget pair interleaves, so only an awaited
  release enforces the order), so a crash
  between them leaves an armed marker with a free lock — the next cooldown
  window retries the dream, which is conservative (an extra dream, never a
  lost arm). A crash before the release leaves the holder stamped, which the
  stale window reclaims as before. Ordinary interleavings (no crash) are
  excluded the same way — the model folds the release and the clear into one
  atomic step. The real residual is the crash window above (armed marker,
  free lock). Two further notes for honesty: a second dream entering between
  the awaited release and the clear requires a cooldown/time gate that is
  already open at that instant (with the default 60m/24h gates this window
  is effectively empty), and the release's own read-then-write gap can still
  write `format(0, at)` over a reclaimer that landed inside it — the same
  accepted class as A-13/E-2.
- **E-1h** (issue #336 fix revision) the release (and the guarded rollback)
  are best-effort cleanup I/O: REQ-10 is scoped to a SUCCESSFUL release
  write. A release write that fails (or whose read-verify throws) leaves the
  holder stamped with the marker already cleared — the #336 delay shape,
  bounded by the stale window and self-healing exactly like a crashed holder.
  Pinned by a failure-injection test (a write-throwing fs seam leaves the
  lock untouched; the dream still counts as completed).
- **E-1** torn `fs.writeText` output: the fs seam exposes no rename and no
  partial-write visibility, so a torn file is not modelable at this layer
  (A-1).
- **E-2** the acknowledged sub-millisecond symmetric collision inside
  `tryAcquireLock` (`lock.ts:94-99`): the acquire is modeled atomic, which is
  the intended semantics; the residual is an accepted product risk, not a
  modeled fault.
- **E-3** fail-open save into an index that was already over its cap
  (`save.ts:203-222`): unreachable while every writer respects the cap, which
  the convention case pins; the behaviour itself is covered by
  `save.spec.ts:203`.
- **E-4** the consolidation-epoch rollback is a single guarded write with
  no interleaving of its own beyond the shared read-verify window (A-13);
  modeled as `DreamFail`. The pre-#336 pin at `dream-diagnostics.spec.ts:198`
  asserted the PRE-FIX fence (a rolled-back lock with a fresh epoch blocking
  the next acquire) — the fix reverses that behaviour, so the pin is REPLACED
  by: seed the acquirer's exact `format(pid, at)`, roll back, assert the file
  became `format(0, priorAt)` and an in-window acquire returns `priorAt`;
  plus a mismatch case that leaves a foreign holder's file untouched.
- **E-5** truncation arithmetic (which lines the fallback keeps) is
  deterministic, covered by `truncate.spec.ts:94`.
- **E-6** batch confinement (flat `.md` names, no path segments) is pure string
  validation, covered by `writeback.spec.ts:110-139`.
- **E-7** the session-count gate (`gates.ts:37-45`) is arithmetic over a scan
  result the model abstracts away as "the periodic gate passes"; it gates only
  whether a periodic dream starts, which is not a property under test here.
- **E-8** the extraction fork and the dream fork themselves are external
  agents; only their read snapshot and their reported batch are modeled.
- **L-1** liveness ("an armed marker eventually reaches a dream") is excluded:
  it depends on wall-clock cooldown and on a turn ending, neither of which the
  bounded logical clock represents. S-4 captures the only violation the
  interleavings can produce — an arm tombstoned without service.

## Code and test mapping

| Property | Code mechanism | Test pinning it |
|---|---|---|
| S-1 | read-verify-write (intended), `lock.ts:100-106` idiom; absent in `save.ts:219` and `writeback.ts:161-163` | `writeback.spec.ts:174`; no cross-process test today |
| S-2 | `writeMemoryFiles` sequential order, `save.ts:239` | `writeback.spec.ts:174` (deterministic prefix) |
| S-3 | `validateMemoryWrites` gate + `applyEntrypointFallback` | `save.spec.ts:180`, `truncate.spec.ts:94` |
| S-4 | `armPressure` re-read, `pressure.ts:79-86`; clear carries no arm identity | `save.spec.ts:276-327` |
| S-5 | `tryAcquireLock` + read-back verify | `lock.spec.ts:105-148` |
| S-6 | stale window, `lock.ts:19` | `lock.spec.ts:148` |
| S-7 | `releaseLock` guarded rewrite + `tryAcquireLock` holder-0 free path, both success branches of `index.ts` | `lock.spec.ts` (released-lock acquisition within the stale window; released content is EXACTLY `format(0, at)` — the epoch is kept, pinning the periodic gate's `lastConsolidatedAt`; guarded release skips on content change; guarded rollback), dream outcome spec (successful dream leaves the lock released) |
| REQ-6 | `rollbackLock` | `dream-diagnostics.spec.ts:126-231` |

## Open questions (not decided by this model)

1. Is a lost update between two concurrent saves acceptable (last-writer-wins),
   or must the index write be a merge/verify? S-1 takes the strict reading.
2. May a dream erase a pointer that a save committed after the fork read the
   index? S-1 says no; the current code allows it.
3. Is "topic file present without an index entry" a legal intermediate state?
   The model treats it as legal and harmless.
4. Does the residual `tryAcquireLock` collision (E-2) stay accepted once the
   dream may rewrite a large batch?
5. Should the stale window be PID-aware so a live but slow dream is not
   preempted (REQ-8 / `strict-live-preemption`)?
6. ~~`DreamClear` carries an arm-identity guard…~~ — resolved by the issue
   #335 fix: the code now clears conditionally on the captured arm, so the
   model and the code agree. Historical.
7. ~~The code passes the dream's start epoch to `clearPressure`…~~ —
   resolved by the issue #335 fix: the code now passes the completion time.
   The model's direction remains conservative. Historical.
8. ~~`rollbackLock` rewrites the lock unconditionally~~ — resolved in this
   revision (review finding): under the post-fix acquire, a `format(0, priorAt)`
   clobber of a stale reclaimer's file would FREE a lock under a live dreamer
   (holder 0 is free by definition), a mutual-exclusion break the pre-fix
   epoch-only acquire accidentally did not have. `rollbackLock` now carries
   the same guarded read-verify as `releaseLock` (it rewrites only while the
   file still holds exactly the acquirer's pid+epoch), and the model's
   `DreamFail` carries the matching `lock.holder = p` guard.

Counterexample dispositions are recorded in `implementation.md`.
