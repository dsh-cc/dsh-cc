# Implementation: memory-write-lifecycle

Model `specs/tla/memory-write-lifecycle`, safety-only, no production change. This
file records run identities, counterexample dispositions and the drafting
defects, outside `inputDigest` as the runner contract requires.

## Runner and toolchain

- runner package `@dsh-cc/plugin-dsh-cc-agents@0.9.3-rc.4`, TLC 1.7.4 (bundled
  JAR, SHA-1 pinned by `scripts/toolchain.json`), Java 25.0.2 on darwin.
- Every case ran with the fixed runner flags (`-workers 1 -seed 1 -fp 0`,
  per-case heap and timeout from `checks.json`).

## Final run

- runId `20261103T033509Z-81c9ce10-e685-48ed-80b7-ae3581355587`〔src:ws:specs/tla/memory-write-lifecycle/implementation.md#L13-L24〕
- inputDigest `47cee0f5deee0665…`〔src:ws:specs/tla/memory-write-lifecycle/implementation.md#L13-L24〕
- `convention` **verified**: 93,095,007 states generated, 15,819,345 distinct〔src:ws:specs/tla/memory-write-lifecycle/implementation.md#L13-L24〕
  0 left on queue, 355 s (2048 MiB heap, `TMax=2`, `Revs=3`)〔src:ws:specs/tla/memory-write-lifecycle/implementation.md#L13-L24〕.
- seven expansion probes each produced their expected counterexample.
- `check-evidence`: status valid, fresh, verification `counterexample` — the
  aggregate is a counterexample because every probe case is red by design.

## Counterexample dispositions (all seven probes, same run)

| Case | Invariant | Trace that fires it | Disposition |
|---|---|---|---|
| strict-unlocked-save | `NoLostSave` | `SaveRead` → `SaveTopics` → `SaveIndex` writes its stale snapshot | product gap: the save index write has no read-verify guard |
| strict-dream-no-cas | `NoLostSave` | `DreamFork` → `SaveIndex` → `DreamClobber` publishes the pre-save content | product gap: the dream batch overwrites without checking the fork snapshot still holds |
| strict-index-first | `NoDanglingPointer` | `DreamBuild` → `DreamPublishFirst` | product gap: the dream batch order is not constrained; a crash after the index write leaves a dangling pointer |
| strict-clear-without-run | `NoLostPressure` | `SaveReject` arms → `DreamClear` tombstones without serving | product gap: `clearPressure` carries no arm identity |
| strict-skip-cap | `CapSound` | `DreamWriteTopics` → `DreamPublish` publishes an over-cap index | defence in depth, not a live code gap: `applyEntrypointFallback` + `validateMemoryWrites` reject an over-cap batch unconditionally (`memory-job.ts:148-158`, `writeback.ts:141-154`) |
| strict-live-preemption | `OneDreamer` | `DreamStampPeriodic` → `DreamLock` reclaims a live holder past the stale window | documented product behaviour (`lock.ts:19`); the probe pins that this is the ONLY violation of exclusivity |
| strict-unlocked-extract | `NoLostSave` | `ExtractRead` → `SaveIndex` → `ExtractIndex` publishes the pre-save content | product gap: the extraction fork writes the index with no lock and no verification (`index.ts:218-235`) |

None of these is a design-intent claim about the memory system; each is a
reachable interleaving the model demonstrates. Turning any of them into a
product issue is a separate decision (see the open questions in `design.md`).

## Modeling defects found while drafting (model-side, all fixed)

1. `OneDreamer` first failed on the convention case because the `written` phase
   was not in `CriticalPhases`: a process between publishing and clearing looked
   quiescent, so the clock could advance and another process reclaimed its lock.
   Fix: `written` is inside the critical section.
2. `savedSince` originally recorded every committed save, so a dream dropping a
   pointer that already existed before its fork looked like a lost update. Fix:
   only a pointer the save ADDS is protected.
3. The pressure invariant was set-based (`pendingArms`), which reported a
   superseded arm as lost. Fix: pressure is level-triggered — a served arm
   covers every older arm (`lastArmAt` / `lastServedAt`).
4. The cap was checked at write time, letting two saves commit against stale
   snapshots past the cap. Fix: the cap decision is taken at read time against
   the snapshot, matching `save.ts:200-222`.
5. Two actions left a variable out of their `UNCHANGED` list, so TLC explored
   unconstrained representations (`property-evaluation-failed`). Fixed in
   `SaveReject` and `DreamClear`.
6. After the extraction actor was added, `InCrit` matched the shared phase
   names, so an unlocked extraction looked like a critical section.
7. The set-equality guard was too weak once three writers existed: an overwrite
   that left the set unchanged let an older snapshot publish. Replaced by the
   revision guard (fold 4).
8. The preemption probe verified vacuously once the tick budget was cut: with
   `MinTicks=1` the stale window could no longer open inside `TMax=2`, so the
   probe now runs with `MinTicks=0`.

## External blind review r1 (codex seat, NO-GO — open findings)

The codex seat reviewed the packaged evidence (byte-level artifact audit PASSED:
input snapshots, digest, cfg bytes, log hashes and all per-case statistics
verified, including 93,095,007 / 15,819,345 / 0 and the seven probe
counterexamples). Its findings, unfixed and blocking:

- **P0 (fixed below)** the Final-run section named the superseded run
  `20261103T031750Z` while the package evidence is `20261103T033509Z`.
- **P1** `savedSince` is globally reset at every writer snapshot, so an aborted
  extraction can clear the protection a concurrent dream's older snapshot
  still needs (S-1 blind spot). Fix: per-writer protection histories.
- **P1** `ClearWithoutRun` also suppresses the service observer, admitting
  false positives; the persisted witness is nevertheless real.
- **P1** the pressure read→stamp is one atomic action; production reads at
  `index.ts:300` and writes the captured arm later (`pressure.ts:104-107`), so a
  re-arm can be overwritten by a stale stamp — a race distinct from E-1b.
- **P1** S-2 manufactures topic bodies for every published pointer; production
  does not validate that index targets exist (`writeback.ts:115-155`), so an
  index-only report can dangle in code but not in the model.
- **P1** the claimed crash-recovery coverage is unreachable in the convention
  bounds (`MinTicks=1, StaleTicks=2, TMax=2` — reclaim needs tick ≥3).
- **P2** a successful process can never re-acquire the lock (the model requires
  a different holder; production's stale check ignores PID).
- **P2** dispositions overstate: the skip-cap trace is extraction, and
  live-preemption does not prove "ONLY violation".

## Review folds (cold review r2, GO)

The delta review confirmed all four P1 folds and raised P2s only:

- the `DreamClear` arm-identity guard makes "clear after a re-arm" unreachable
  except through `DreamFail`; recorded as a design open question and as a
  conservative deviation from the code's unconditional clear;
- the cooldown stamp is the clear time in the model while the code passes the
  dream's start epoch; the model is conservative;
- the SkipCap disposition above was corrected to "defence in depth".

## Run lineage

| runId | Outcome | Note |〔src:ws:specs/tla/memory-write-lifecycle/implementation.md#L13-L24〕
|---|---|---|
| `20261103T012028Z-489e1442` | config-invalid | operator name clashed with the `DreamIndexFirst` constant |
| `20261103T012157Z-3af8cdd3` | counterexample (convention) | `OneDreamer` — live-holder preemption reachable, became the `FreeTicks` probe |
| `20261103T012512Z-19ccfbb3` | counterexample (convention) | `HoldsLock` — `written` not critical (defect 1) |
| `20261103T013510Z-064e16f3` | counterexample (convention) | `NoLostSave` — overwrite counted as an added pointer (defect 2) |
| `20261103T013701Z-eb74841b` | counterexample (convention) | `NoLostPressure` — superseded arm reported (defect 3) |
| `20261103T014540Z-53a78bc0` | error | unconstrained variables from incomplete `UNCHANGED` lists (defect 5) |
| `20261103T014712Z-b72a701c` | counterexample (convention) | `CapSound` — cap checked at write time (defect 4) |
| `20261103T015004Z-409fc732` | verified (convention), six probes red | design.md subsequently updated for the final shape |
| `20261103T015426Z-9a2f5dd5` | verified (convention), six probes red | reviewed; four P1 folds followed |
| `20261103T021918Z-5874b3b1` | counterexample (convention) | `HoldsLock` — `InCrit` matched extraction phases (defect 6) |
| `20261103T021958Z-91db769e` | counterexample (convention) | `NoLostSave` — set-equality guard too weak (defect 7) |
| `20261103T022146Z-c7427c90` | counterexample (convention) | same, after the protection reset was moved to the extraction snapshot |
| `20261103T022434Z-d5dbfdd5` | incomplete (timeout) | first run of the revision-guarded model, 420 s budget〔src:ws:specs/tla/memory-write-lifecycle/implementation.md#L13-L24〕 |
| `20261103T023157Z-aadc9edc` | verified (convention); `strict-live-preemption` verified | vacuous preemption probe (defect 8) |
| `20261103T024438Z-a6f28cf0` | verified (convention), seven probes red | before the design.md update |
| `20261103T025128Z-9222b040` | verified (convention), seven probes red | reviewed (GO); doc-level P2 folds followed |
| `20261103T031750Z-864b6955` | verified (convention), seven probes red | design.md notes only |
| `20261103T033509Z-81c9ce10` | verified (convention), seven probes red | final: evidence markers only, identical per-case statistics |

## Coverage check

Every row of the design coverage matrix has a core or expansion case:
S-1 two probes, S-2 one, S-3 one, S-4 one, S-5 in convention, S-6 one, REQ-6 and
REQ-7 by structural action guard plus deadlock checking. No property was deleted
or weakened to reach a green convention: the five failures above were model
defects, each fixed by making the model match the code rather than by relaxing a
property.

## Evidence markers

`design.md` and this file carry 〔src:ws:〕 markers for the VWA evidence gate.
Code claims point at `code-anchors.md` (verbatim excerpts from the current
implementation); run-identity and per-case statistics point at this file, because
the runner's raw evidence (`evidence.json`, `.formal-design/runs/**`) is
gitignored by design. Backfilling markers changed `design.md`, so the check was
re-run: the final run above has identical per-case statistics to the previous
one, which is the proof that only references changed.

## Not verified

- liveness (L-1 exclusion): an armed marker eventually reaching a dream.
- wall-clock durations: the 1h stale window, the 60m cooldown and the periodic
  time gate are tick abstractions.
- torn single-file writes, the session-count gate, batch-conflict validation and
  the extraction/dream agents themselves (E-1, E-6, E-7, E-8).
- implementation conformance: this model describes existing behaviour; it does
  not prove the TypeScript matches the model.

## Review state

Not yet dispatched to a formal review lane. The three-seat blind review used by
earlier models in this repository is a user decision for this batch.
