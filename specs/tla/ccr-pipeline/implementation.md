# Implementation record — ccr-pipeline

Keyed to the final run of 2026-10-27. Not part of inputDigest.

## Run lineage

- **Final run (2026-10-27, after the F-4 correction in design.md):**
  runId `20261027T043657Z-591e55da-e06e-418f-bfb9-e120b9c54d54`,
  inputDigest `b9c09eccae75687c4c01b80b9e624b44e62083935ba5d59d254ec1f6cbcd1e9c`.
  Case outcomes and statistics are identical to the prior run
  (the only input change is documentation: the F-4 meter claim was retracted).
- Prior run (evidence-marker backfill):
  runId `20261026T074049Z-3324ea75-ca32-475e-b553-1d376446fdab`,
  inputDigest `e8f9c5248d8e51aad03ca119c72807c748c8f395f84e28ac2fe44ff1a68f41fb`.
  Per-case outcomes and statistics are byte-identical to the prior run
  `20261026T073137Z-7f4dee75-0b91-4572-b845-101c18188d82`
  (same criteria; the only input change was 〔src:ws:〕 citation markers in
  design.md, which do not affect the model, cfgs or properties).
- runnerPackage: `@dsh-cc/plugin-dsh-cc-agents` 0.9.2, TLC 1.7.4
  (jarSha256 936a2620…), Java 25.0.2, darwin
- check-evidence: `valid` / fresh / verification `counterexample`
  (aggregate — the two expansion probes are expected counterexamples)

## Case results

| Case | Status | Statistics |
|---|---|---|
| convention | **verified** | 90/41/0 |
| apply-lane | **verified** | 38/15/0 |
| dry-run | **verified** | 86/36/0 |
| strict-swap-crash | counterexample — PrunePaired | 45/22/5 |
| strict-double-fire | counterexample — SingleMarkerPerResult | 49/25/7 |## Counterexample dispositions

### strict-swap-crash — F-4 RETRACTED (refuted by real-meter evidence, PR #301)

Trace: `Arrive → DeferRecord → Send → SwapPrune` (+ crash before
`SwapReplace`). An orphan `compaction/prune` row can indeed survive a torn
tail frame — so the `PrunePaired` counterexample stands as a STRUCTURAL fact.

But the consequence this record originally asserted — "the token meter has
been debited for a node still present on the surface" — was **wrong**: it was
an assumption about meter semantics, never verified against the meter. PR
#301 pinned the real behavior with the real `TokenMeter` and a real
`Session` (`context-crusher/tests/defer-swap-crash.spec.ts`): the prune arms a
delta-0 shadow-price claim that only the adjacent `replace` consumes, so an
orphan prune **deducts nothing**, the surface stays unswapped, the resident
stays swappable, and the retry on resume debits exactly once. The harness
also buffers both appends into one persistence batch, so the residual window
is only a torn final frame.

Disposition: **no production fix required** (PR #301 ruling, accepted). The
probe stays as a boundary pin for the structural gap; the model's invariants
(`PrunePaired`, `StoreBeforeReference`, `AppliedImpliesMarker`) are unchanged
because none of them asserted the meter consequence.

Process lesson: never claim a side-effect ("event X already debited the
meter") from `session.append` counts — check the consuming component's fold
semantics first.

### strict-double-fire — host-assumption violation (expected)

Trace: `Arrive → ReducePath → Refire → ReducePath`. If the host re-fires
`tools/post-execute` for an already-crushed result, `crush()` has no
already-has-a-marker check, so the reprocessed text gets a second marker
and `foldCounters` double-counts. The code relies on the host firing
exactly once per fresh result (a declared assumption, not enforced
anywhere in the package).

Classification: **assumption-bound risk** — within the assumption the
behavior is safe; the probe pins what breaks if the assumption is ever
violated (e.g. by a future event replay). No code change.

## Known deviations kept out of the invariants (documented, not asserted)

- The defer fast-path ledger row carries `applied:false` **with** a hash
  (`index.ts:241`) — intended (nothing entered the session yet; the
  `applied:true` swap row follows), but it breaks any naive
  "hash ⇒ applied" reading of `savings.jsonl`.
- `mode:'on'` + missing `projectKey` rejections write **no ledger row at
  all** (`index.ts:225-231`, `reducer.ts:216`) — an unledgered rejection
  class.
- A crash between the ledger row (`applied:true`) and the caller's
  transcript commit leaves a row claiming compression the session does
  not have — the ground truth is `foldCounters` over `tool/result`
  events, not the ledger.

## Unmodeled scope

- Router compression algorithm, token estimation, savings ratios,
  receipt schema and verifier internals (folded into `routeHit` /
  `verdictOk` booleans).
- Store TTL/LRU sweeps, secrets redaction, sidecar file I/O details.
- Parallel interleaving of multiple tool results on the post-execute path
  (exclusion justified in design.md A-5).
- Defer gate margin/urgency arithmetic; `defer-max-age` sweep abandonment.
- Resume/fold convergence (send counts reset to 0 — conservative).

## Suggested regression tests (repo changes, not made here)

1. Swap crash window: inject a failure between the two `session.append`
   calls; assert either both rows land or neither (pins F-4).
2. Double-fire: fire `tools/post-execute` twice for the same result;
   assert `foldCounters` does not double-count (pins the host assumption
   inside the package).
3. (No meter-regression test is needed for the swap window: PR #301's
   `defer-swap-crash.spec.ts` already pins the inert-orphan behavior with the
   real meter.)
