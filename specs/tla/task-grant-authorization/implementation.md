# Implementation notes — task-grant-authorization (v2)

Feature not implemented yet: this model pins the planned semantics of the
batch-autonomous design §3.4-§3.6 and §4.3-§4.4.

## Run lineage

- R1-R3: v1 runs (see git history) — convention verified 8,640/1,220 with
  seven probes; the three-lane model review then folded: the approval
  collapsed the out-of-process git probe into one atomic step (K2), the
  branch was frozen at decision time (K4), the eligibility property was
  tautological (K3), the execution identity was unmodeled (K6), the
  contentScope gate was excluded (K7), and several anchors were stale (K8).
- R4 `20261029T045417Z-717d2a05`: first v2 run — convention red on
  `ContentGateSound`: the PRESERVED baseline approval has no content gate
  either, so the grant-path-only scoping was wrong... in fact the fix was to
  scope S-3/S-4/S-8 to grant-path approvals (the baseline is today's
  behavior and has none of the new gates).
- R5 `20261029T045747Z-2115cc00`: convention red on
  `BaselineOnlyWithoutActiveGrant` — a REAL race the v1 model could not
  express: a grant CREATED between the check and the consume must not be
  bypassed by a baseline approval. Fixed: the baseline re-validates
  grant-absence at consume (folded into the design doc §3.5).
- R6 `20261029T045846Z-4fc4f416`: convention red on `ModeWithinCeiling` —
  another REAL race: a registration belongs to the grant that created it;
  a grant that died and was REBORN (revoke → re-grant) must not consume the
  stale entry (the new grant's ceiling differs). Fixed: registrations are
  invalidated on grant death (revoke/expire/reset) — folded as REQ-9.
- R7 `20261029T050447Z-4d53250d`: convention verified 224,789/16,528; all
  ten probes red on their intended invariants (the two faults were rewired
  to consume-side bypasses so the probes stay reachable past the new
  invalidation semantics).
- R8 `20261029T051113Z-477ba85d`: final (design.md v2 rewrite). Same
  verdicts; check-evidence valid/fresh.

## Design clarifications the v2 model produced (folded into the design doc)

1. The approval must RE-VALIDATE after the out-of-process git probe: the
   live grant for gated calls, and grant-ABSENCE for baseline calls (a
   grant created during the window must not be bypassed).
2. Registrations die with their grant: revoke/expiry clears the registry so
   a reborn grant never consumes a stale entry.
3. The branch guard reads the CURRENT head at consume, not a decision-time
   value; the ceiling is checked against the consuming grant's ceiling.
4. The disagreement block is an effective-force state; accept keeps it,
   only a human reject clears it, and a deferred promotion while unresolved
   is impossible (all three are now checkable, non-tautological).
5. The contentScope gate is part of the approval check (grant-path only).

## Unverified scope

Liveness; registry TTL and the missing-callId fallback; the shell-rule
composition (E-1); the `signer` provenance hardening (design note).
