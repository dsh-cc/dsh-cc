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
