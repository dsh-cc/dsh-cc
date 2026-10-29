# Implementation notes — vwa-batch-run

Feature not implemented yet: this model pins the planned semantics of the
batch-autonomous design §2.4 and §8. Planned symbols and tests are the
coverage-matrix entries in design.md; this file records run lineage and the
modeling findings so an implementer sees what the model actually forced.

## Run lineage

- R1 `20261029T015203Z-5a23bde8`: convention failed (38 states) on
  `StateWriteExclusive`. **Modeling defect**, not a design defect: `inLock`
  is in-process state and a crash must lose it while the lock file stays
  behind. Fixed in `Crash`.
- R2 `20261029T015413Z-686497b8`: convention failed on `SkipNeedsFailures`.
  **Modeling defect**: checkpoints remained enabled after the page was
  skipped, so the counter could be reset post-skip. Fixed by gating every
  checkpoint action on `ev.status = "pending"`.
- R3 (inline, same session): `strict-adopt-torn` verified — the torn-adoption
  fault was unreachable because no action re-prepared from an on-disk
  reservation. **Coverage gap**: REQ-1's "crash between reservation and
  creation, then retry adopts the same id" path was not modeled at all. Fixed
  by adding `RetryPrepare`.
- R4 (inline): convention then failed on `InitSound` because a stale
  `prep` pending action let `CrashTornReservation` truncate a reservation
  whose project already existed. Fixed by making `CreateProject` consume
  every pending prepare and by requiring `~ev.proj` for a torn crash.
- R5 `20261029T021229Z-20dfdfc7`: final. convention verified
  (8,231 / 2,080), probes red as designed:
  strict-commit-before-report (`ReportBeforeCommit`),
  strict-cache-first (`ClaimNeverAhead`),
  strict-adopt-torn (`InitSound`). check-evidence: valid/fresh.

## Design clarifications the model produced (fold into the design doc)

1. **The init reservation is consumed at the first successful create.** A
   second driver still holding a prepare action must not be able to truncate
   the file afterwards (§2.4 should say this explicitly; the model needed the
   `CreateProject` consumption rule to be sound).
2. **`RetryPrepare` is a required action of the protocol**, not an
   optimization: after a crash between reservation and creation the only way
   back is re-reading the reservation and adopting its projectId.
3. `FrozenBeforeReport` and `DeliveryOrder` have no runtime re-check — they
   are action-order facts. They stay as regression tripwires only.

## Unverified scope

- Liveness is not modeled (no fairness): "a page eventually completes" is not
  claimed.
- The `ciTimeouts` counter (E-2), the evaluation-file read-back (E-1) and the
  contentScope post-hoc check (design §3.6 residual) are outside the model.
- The design's per-page cost accounting is observability only.
