# Implementation record: compaction-pin-restore

## Modeling history

### Run 1 — parse/semantic fixes (no evidence value)

- `EXCEPT ![p \in S]` set form unsupported by this TLC: rewritten as a full
  function rebuild (`lastShadow' = [q \in Pins |-> ...]`).
- `Tick` UNCHANGED list omitted `cPhase` (successor not completely
  specified) — fixed.

### Run 2 — TypeOK counterexample (classified: modeling defect)

Trace: 2 pins + 2 noise (surface len 6 after arrivals) + 3 compactions +
drain appended 2 restore nodes → surface length 7 > the `MaxSurface`
envelope. The envelope must admit drain growth: concurrent eligible
schedules carry disjoint pin sets (a pin shadowed twice requires the first
restore to have drained), so one drain appends at most |Pins| = 2 nodes.
Fix: `Len(surface) \in 0..MaxSurface + 2`. Arrivals stay guarded by
`Len(surface) < MaxSurface`.

### Run 3 — deadlock at terminal states (classified: modeling artifact)

TLC's deadlock check requires a named successor action; terminal states
(gateSeq exhausted, surface full) self-loop only via the `[Next]_vars`
stuttering wrapper, which TLC does not count. Fix: added the `Idle ==
UNCHANGED vars` disjunct (precedent: extraction-watermark's `Idle`).
No liveness is claimed by this model.

### Run 4 — state-space timeout (classified: bound tuning)

Convention explored 33.9M distinct states without completing (and the
pre-`Idle` build also carried the deadlock abort). Bounds tightened:
surface 6→5, noise 2→1, compaction ids 3→2, ticks 6→5. Coverage retained:
two compactions suffice for shadow → restore → re-shadow chains; the
probe cases already complete in ~1k states.

## Counterexample classification ledger

| case | finding | class |
|---|---|---|
| convention (run 2) | surface envelope excluded drain growth | modeling defect (fixed) |
| convention (run 3) | terminal-state deadlock | modeling artifact (fixed) |
| strict-blind-rule-b | rule (b) without a checkpoint-commit gate restores never-shadowed pins after the F3 double failure (checkpoint append fails AND end append fails) | **design finding — currently an OPEN GAP in doc 2** |
| strict-no-restore | drain disabled loses promised pins | expected probe |
| strict-belt-off-blind | without the belt AND the gate, the F1 single failure already yields a phantom | expected probe (severity ladder: belt off alone is safe once the gate exists — see x-belt-off-fixed) |

## Notes for implementers

- The model's central discipline for doc 2: **rule (b) must require the
  checkpoint to have actually committed** (`committed` set membership), and
  the end-error belt is defense-in-depth that the checkpoint gate subsumes
  (keep both).
- In-request compaction (overflow/model-switch) and crash-resume windows
  are excluded (design-doc accepted limitations).

### Run 5 (final) — 20261112T080709Z-7d16ac0c-58b9-4652-80ae-ad74fb7726db

Bounds after tuning: 2 pins, 1 noise node, surface ≤ 5 (+2 drain envelope),
2 compaction ids, 5 ticks. Case results:

| case | verdict | distinct states | ms |
|---|---|---|---|
| convention | verified | 207,138 | 3,247 |
| strict-blind-rule-b | counterexample (NoPhantom) | 672 | 741 |
| strict-no-restore | counterexample (NoStalePromise) | 656 | 732 |
| strict-belt-off-blind | counterexample (NoPhantom) | 686 | 771 |
| x-belt-off-fixed | verified | 260,885 | 3,904 |
| x-ring-eviction | verified | 384,676 | 4,905 |

check-evidence: valid (same-run integrity and freshness). Aggregate form:
counterexample = the probe package is the expected shape (each red probe
hits its designed invariant; both green x-cases verified).

The distinct-state collapse vs run 4 (33.9M → 207k) confirms the surface
sequence length and cid alphabet were the drivers; coverage retained
(two compactions still exercise shadow → restore → re-shadow).

## Code implementation record — detect + restore (`@dsh-cc/compaction-pinning`)

- Input digest: `b856bc28e102d52a8be72372fdc7d1048cd0f8b3d9d6f598278b575be768d1f8`
  (Model.tla, cases/*.cfg, checks.json, design.md — `implementation.md` is not
  an input, so this record does not invalidate the digest).
- Model evidence used: run `20261113T011418Z-3f94bcb3-bb1b-44eb-aadb-e7995556b387`
  — convention **verified** (515,568 generated / 207,138 distinct, 0 queued);
  aggregate `counterexample` = the three designed red probes
  (`strict-blind-rule-b`, `strict-no-restore`, `strict-belt-off-blind`) with
  `x-belt-off-fixed` / `x-ring-eviction` verified. This session did NOT re-run
  TLC; the model is unchanged. `scripts/formal-design-status.mjs` reports the
  row as `stale/runner` (evidence records runner 0.9.3-rc.4, the checkout is
  provisioned with a different runner) — freshness is therefore NOT claimed
  here, only the recorded verdict.
- No Lean backend applies (backend list is `["tla"]`), so there is no proof
  input/execution digest for this task.
- No model input was changed to fit code, and no invariant was weakened.

### Pinned semantics as implemented

| model element | code |
|---|---|
| `StartCompaction` (`rs = shadow ∩ ring`, `at = tick`) | `src/detect.ts` `onSummary` → `ScheduleStore.arm` (`restorable = ring.get(seq)` per `shadowedSeqs`, ascending) |
| `BeltEnabled` (end(error) cancels) | `src/detect.ts` `onEnd` → `ScheduleStore.cancel` (delete) |
| `AppendEndOk` (rule (a)) | `src/detect.ts` `onEnd` → `ScheduleStore.succeed` |
| `RequireCheckpoint` (rule (b) gate) | `src/detect.ts` `onCheckpoint`: the replacement `user/message` whose `sourceEventSeqs` cite the summary seq sets `ScheduleStore.commit`; `isEligible` requires it |
| `Tick` (drain) | `src/restore.ts`: `agent/pre-step`, `{prepend:true}`, delegate-first (`await next()` first) |
| `RestoresAll` (ascending, one node per pin) | `src/restore.ts` drain: items sorted by original seq, deduped, one `session.append('user/message', message, {surfaceOp:'append'})` each |
| `Dead` / `ScheduleAccounting` | `ScheduleStore.gcDead` — ineligible schedules are dropped at `turn - createdTurn >= SCHEDULE_GC_TURNS` |
| `NoPhantom` / `AtMostOneLivePerPin` | the commit gate plus the drain's per-seq dedupe |
| `RestoreEnabled=FALSE` | `enabled:false` → detect/drain no-op, pending schedules survive the pause |

Turn clock: `'turn/start'` session events (`{turn}`), raised monotonically and
by the drain's pre-step payload `turn`; `compaction/*.turn` is `null` on the
idle (manual / cost-gate) paths, so it cannot serve as the clock alone.

### Regression tests (actual code, actual results)

`CI=true pnpm --filter @dsh-cc/compaction-pinning test` → **49 passed / 49**
(4 files; 24 new in `tests/detect.spec.ts` + `tests/restore.spec.ts`, 25
pre-existing from the capture half). Load-bearing guards were red-checked by
temporarily disabling each guard and confirming the named spec fails:

| guard removed | failing specs (red) |
|---|---|
| belt (`cancel` on end error) | both `detect — the belt` specs |
| `RequireCheckpoint` gate | `rule (b) NEVER fires without a witnessed checkpoint commit (F3 phantom guard)` |
| delegate-first ordering (drain before `next()`) | `same-step restore: … drains in that very pre-step`, `a rejected step defers the queue instead of spending it` |

Also `CI=true pnpm exec tsc -b packages/compaction/compaction-pinning/tsconfig.json`
→ clean; `CI=true pnpm check:size` → OK (no file over the 500-line budget).

### Deviations from the plan-doc prose (§Detect)

The plan doc's §Detect prose states rule (b) as "≥ 1 turn with no end seen"
without the checkpoint-commit condition. The approved model's `convention` case
is `RequireCheckpoint=TRUE`, and its P1 probe shows the prose shape restores
never-shadowed pins after the F3 double failure. The implementation follows the
model (both conditions), i.e. the strictly narrower rule; this is the design
finding already recorded above as an OPEN GAP in doc 2 and needs a prose fold
in `docs/plans/2026-11-12-compaction-governed-pinning.md` §Detect by whoever
owns that doc.

### Acceptance addendum (integration, final)

`tests/integration.spec.ts` (6 tests, real `JsonlSessionPersistence` + real
harness `BasicCompactionEngine` `auto:true` with scripted LLM, real
`TokenMeter`, real surface validator): pressure same-step restore,
loop-safety second compaction, manual `/compact` idle, cost-gate idle seam,
context-overflow retry (asserts the accepted one-request gap AND the
next-pre-step restore), model-switch retry. Final suite:
`CI=true pnpm --filter @dsh-cc/compaction-pinning test` → **55 passed / 55**
(5 files). The §Detect prose fold demanded above was applied to
`docs/plans/2026-11-12-compaction-governed-pinning.md` in the same change
(rule (b) = ≥1 turn AND witnessed checkpoint commit, matching
`RequireCheckpoint=TRUE`).
