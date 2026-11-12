# Implementation record: input-admission-governance

## Modeling history

### Runs 1-4 — parse/semantic fixes (no evidence value)

- `SelectSeq(allAdm, IsAdvisory(_))` placeholder syntax: pass the operator
  name directly.
- Forward reference to `ProvisionalDedupeEligible` from `WalkBacklog`:
  TLA+ requires lexical definition-before-use; moved up.
- Duplicate binder `i` in `badTouch`; renamed the second to `j`.
- **`Append(@, <<m>>)` wrapped sequences as elements** (sequence-of-
  sequences → "apply function with integer domain to 'bytes'"): element
  append is `Append(@, m)`. Five entry sites and three message sites fixed.
- **`touched' = touched \/ badTouch` precedence trap** (`=` binds tighter
  than `\/` → the conjunct disjuncted into an unconstrained action →
  "successor not completely specified: touched"): parenthesized as
  `touched' = (touched \/ badTouch)`. This is the documented priority trap
  from prior modeling rounds; recorded here as a recurrence.
- TypeOK queue-length envelope: TTL=2 with batch ≤ 3 bounds the queue at
  6 (prior gate's keeps + this gate's deferrals); widened from 3, and the
  eid allocator bounds accordingly (1..18 / 1..19).

### Run 5 — state-space tuning

`lastAdmittedBatch` (a sequence over the 6-message universe) was only
consumed by `ObserveClean`; replaced with `lastAdmittedCount`. MaxSeq
6 → 5 (the dedupe window W=3 and TTL=2 both remain exercisable). The x-
observe-clean case also verified pre-shrink (1,807 states).

## Counterexample classification ledger

| case | finding | class |
|---|---|---|
| convention (TypeOK, run 2) | queue-length envelope | modeling defect (fixed) |
| convention (exception, run 3) | Append-element bug; then the `\/` precedence trap | modeling defects (fixed) |
| strict-commit-at-check | check-time state advance lets a trimmed/deferred message poison later same-key admissions (DedupeCommitted, CapCommitted) | **expected probe — the r1 design bug the two-phase commit-on-admission fix exists for** |
| strict-unknown-as-advisory | classifying unknown kinds advisory lets budget trim drop passthrough content (NeverTouched via the touched flag) | **expected probe — the r1 inversion fix** |
| strict-observe-mutates | observe mode writing the real pipeline outcome mutates the real batch (ObserveClean) | expected probe |
| x-observe-clean | verify | — |

## Final run — 20261112T080205Z-a27f706f-ddb1-4d6e-b698-7400a21dea18

| case | verdict | distinct states | ms |
|---|---|---|---|
| convention | verified | 216,524 | 44,492 |
| strict-commit-at-check | counterexample (DedupeCommitted) | 1,189 | 1,012 |
| strict-unknown-as-advisory | counterexample (NeverTouched) | 426 | 941 |
| strict-observe-mutates | counterexample (ObserveClean) | 9 | 660 |
| x-observe-clean | verified | 1,549 | 796 |

check-evidence: valid. Aggregate: counterexample = probe package shape.

## Notes for implementers

- The in-batch provisional allocation is threaded through BOTH walks
  (backlog and fresh) — the doc's "check against committed ∪ provisional"
  applies to re-offered backlog entries too, not only fresh arrivals.
- The enter-budget (EB/hardOver) re-trim pass is NOT modeled (assumption
  A5 in design.md): the class budgets carry the bound property; hardOver is
  recorded as a flag only.
- `cc-shell-glue` and lifecycle kinds are excluded from the universe by
  construction (v1 observe-only / never-trim classes).
