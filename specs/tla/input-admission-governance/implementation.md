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
| strict-commit-at-check | check-time state advance lets a checked-but-not-admitted message poison later same-key admissions; the run's stdout shows `DedupeCommitted` (and, after the sentinel was wired to the same fault switch, `AdmittedEverCommitted`) | **expected probe — the r1 design bug the two-phase commit-on-admission fix exists for** |
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

## Review round 1 (two seats) — folded defects

Both seats returned on the run-5 build; the finding sets overlapped almost
exactly. Every item below was a real modeling defect, not a design finding:

1. **[BLOCKER] Fresh walk ignored the backlog's admitted bytes.** `FreshAcc`
   seeded only dedupe/cap counters, so a backlog `mM` (3 B) plus a fresh `mM`
   (3 B) admitted 6 B against `MB=3`. Fixed: `FreshAcc(back)` seeds `adv`/`mem`
   from `back.adv`/`back.mem`. **Also added the missing `MemoryBudgetHeld`
   invariant** — the advisory class had a bound but the memory class had none,
   which is why the violation was reachable but invisible.
2. **[MAJOR] `dedupeState = 0` modeled a nonexistent admission.** At gates 1-2
   the window test `gateSeq+1-0 < W` suppressed a first-ever notice. Fixed with
   the explicit `admittedEver` flag (admit unconditionally until the first real
   admission) plus the `AdmittedEverCommitted` oracle invariant.
3. **[MAJOR] Advisory defer was dead code in convention.** The only deferrable
   advisory was `mA` (2 B vs `AB=4`, same key, one admission per batch), so
   `AdvisoryBudgetHeld` was green over states where it could not fail. Fixed:
   `AB` 4→3 and a second-keyed `mC` (retry-attendant, key k2) so two advisories
   cannot both fit.
4. **[MAJOR] Trim direction was inverted.** `WalkFresh` walked in arrival order
   and deferred the newest; doc 1 requires FIFO-oldest trim. Fixed by walking
   `Rev(batch)` and re-emitting admissions in arrival order.
5. **[MAJOR] Cap overflow was modeled as a drop.** Doc 7 routes cap overflow to
   the governor's trim (defer); only dedupe suppression drops. Fixed by
   splitting the two arms.
6. **[MAJOR] `DeferredExactlyOnce` could not detect double admission** (it only
   asserted queue membership). Replaced with `DispositionPartition` +
   `AdmittedAtMostOnce` over an `admCount` map.
7. **[MINOR] Dangling assumption reference** ("A5 in design.md" did not exist)
   and the observe-mode claim of simulated state. Fixed: design.md now declares
   A5 (enter budget flag-only), A6 (trim order), A7 (observe simulated state
   out of scope), A8 (drop-vs-defer), A9 (first-admission sentinel).

## Model-level bugs found while folding (all fixed)

- `Append(@, <<e>>)` wrapped sequences as elements (three sites).
- `BumpCounts` was fed a **set** where it indexed as a **sequence**.
- Provisional records had two incompatible shapes (`k1`/`ever`/`advCount` vs
  `adv`/`mem`); split into `BacklogProv` / `FreshProv`, and `back.k1` replaced
  by the derived `BacklogHasK1(back)`.
- **The `=`-vs-`\/` precedence trap fired three more times**
  (`touched'`, `truthAdmittedEver'`, `admittedEver'`): each made the assignment
  a bare equality conjunct and pushed the disjunct to action level, so the
  variable was silently under-assigned. Systematic scan
  (`grep "' = .*\\/"` minus parenthesized hits) is the reliable detector, not
  spot checks.

## Notes for implementers

- The in-batch provisional allocation is threaded through BOTH walks
  (backlog and fresh) — the doc's "check against committed ∪ provisional"
  applies to re-offered backlog entries too, not only fresh arrivals.
- The enter-budget re-trim pass is NOT modeled (A5): class budgets carry the
  bound property; `hardOver` is a recorded flag only. This is an explicit
  cross-backend gap, recorded in the Lean coverage table as well.
- `cc-shell-glue` and lifecycle kinds are excluded from the universe by
  construction (v1 observe-only / never-trim classes).

## CI round 1 (bridge flow) — folded findings

The `formal-design-lean` job failed twice on the first pushes; both causes
were mine, not the tooling:

1. **A proof-only Lean manifest is not a shippable state in this repo** —
   the job runs `lean-check-conformance` for every `specs/lean/*` model and
   rejects one with no conformance contract. Fixed by binding the
   model-local fixture (see the Lean model's implementation.md).
2. **The bridge flow requires the bridged model's aggregate to be
   `verified`**, and my first bridge package did not conform to the strict
   schema at all (free-form cases.json, operations not bound to corpus
   case ids, no `Bridge_<id>` invariants). Two structural fixes:
   - the manifest split: the four deliberately-red fault-injection probes
     moved to `specs/tla/input-admission-governance-probes` (same
     Model.tla; aggregate expected `counterexample`), so the bridge-bound
     model aggregates `verified`;
   - the bridge package rewritten to the contract: operations are corpus
     case ids with `propertyIds == covers`, `cases.json` is a bare array
     of `{id, input, expected, tlaExpression}` rows canonically equal to
     the corpus, and the eight `Bridge_<id>` invariants are declared in
     Model.tla from `BridgeFits` / `BridgeOversize` /
     `BridgeWithinWindow` and checked by the convention case.

Final local bridge flow: TLA aggregate verified; Lean proof verified;
conformance 55/55 passed; `check-combined-evidence` valid,
acceptanceReady=true. The probes model's evidence is separately valid.
