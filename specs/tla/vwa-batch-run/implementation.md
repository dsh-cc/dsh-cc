# Implementation notes — vwa-batch-run (v2)

Feature not implemented yet: this model pins the planned semantics of the
batch-autonomous design §2.4 and §8.

## Run lineage

- R1-R5: v1 runs (see git history) — convention verified 8,231/2,080 with
  three probes; the three-lane model review then folded:
  1. the failure counter was not per-checkpoint (fail/succeed/fail/skip was
     possible — K5);
  2. the torn fault was reachable from a retry-adopted reservation (a fault
     the design does not have — the retry only reads the file);
  3. `graphBound`, the PR checkpoint, the no-PR terminal, the content gate
     and a stale-cache PROTOCOL fault were missing;
  4. `Idle` made CHECK_DEADLOCK vacuous.
- R6 `20261029T044147Z-4f9df7d8`: first v2 run — convention red on
  `NoPrSound` (the no-PR terminal was not terminal; delivery actions could
  still fire). Fixed by gating them on `~ev.nopr`.
- R7 `20261029T044420Z-e3a47aa7`: v2 convention verified 11,963/3,985 with
  FIVE probes red on their intended invariants; no TLC deadlock with the
  self-loop restricted to all-dead drivers (REQ-10 holds).
- R8 `20261029T051108Z-b480cf51`: final (design.md v2 rewrite). Same
  verdicts; check-evidence valid/fresh.

## Design clarifications the v2 model produced (folded into the design doc)

1. The failure counter is per-checkpoint: a checkpoint SUCCESS resets the
   counter of the checkpoint it completes (the design doc's §8.3 wording
   already says this; the v1 model did not enforce it).
2. The torn-reservation fault is confined to the original write window; a
   retry only reads the reservation.
3. The no-PR terminal is terminal: after it, no delivery action may fire.
4. A detected content violation fails the page and forbids the push
   (ContentGateSound covers both the pre-gate and the stop).
5. The stale-cache hazard is a PROTOCOL fault (a driver acting on the ahead
   claim), not only a shape invariant.

## Unverified scope

Liveness (no fairness); `ciTimeouts`; the evaluation read-back; the -z
parsers; the dead-holder reclaim TOCTOU (issue #311) and the lockless init
(issue #312) are known product defects tracked outside this PR.
