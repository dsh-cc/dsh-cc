# Design — ccr-pipeline

Model id: `ccr-pipeline` · Module: `Model.tla` · Created 2026-10-26, 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L124〕
worktree `tla-modeling` (head d5f7e385).

## Scope and screening

First-use screening (this session): `AGENTS.md` in this worktree is a
self-forwarding stub; effective three-seat review rules not loadable.
Screening **unconfirmed/not adopted** — modeling and checks proceed, formal
review dispatch blocked (recorded per first-use contract).

FD triggers: **FD-T1** (the post-execute listener, the reducer side-query
and the defer pre-step pass all mutate resident/store/ledger state),
**FD-T2** (deferred send counting racing the swap), **FD-T3** (crash
between the paired session appends; resume via defer row folding).

Mode: auto → decision: **enabled**. TriggerIds: FD-T1/T2/T3 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L124〕.

## What is modeled

One tool result flowing through the crush pipeline, with an abstract
session log (a sequence of tags: `apply` = a content replace that carries
a marker, `prune` + `replace` = the defer swap's paired appends), an
abstract content-addressed store (boolean), defer residency with send
counting, ledger booleans (`applied`, `hash`), and probe bookkeeping
(`swapPending`, `crashed`).

Not modeled (deterministic or non-ordering-sensitive): the router's
compression algorithm, token estimates and savings ratios, the receipt
schema/verifier internals (folded into `verdictOk`), secrets redaction,
store TTL/LRU sweeps, sidecar file I/O, and parallel interleaving of 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L83-L96〕
multiple tool results on the post-execute path (the code has no
per-callId serialization there; each result's decision returns to its own 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L83-L96〕
waterfall slot and `put` is content-addressed/idempotent — noted as an
exclusion with justification below).

| Model action | Code | Atomicity mechanism |
|---|---|---|
| `Arrive` | `crush()` entry guards 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L78-L92〕 | post-`next()` composition; assumed-passed guards |
| `ApplyDeterministic` | deterministic route replace 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L25〕 | staged commit: `put` → ledger → return decision |
| `DeferRecord` | defer fast path `index.ts:232-243` 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L18-L21〕 | store put (temp+rename) then resident record |
| `ReducePath` | reducer staged commit / fail-soft 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L31-L52〕 | every rejection returns `undefined` (original bytes) |
| `Send` | first-chunk send counting (`defer/counter.ts`) | synchronous per-chunk counter |
| `SurfaceMutate` | any surface body change | the swap's byte-equality staleness trigger 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L63-L71〕 |
| `SwapAttempt` | the pre-step swap 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L40-L71〕 | one synchronous critical section: staleness re-check + 2 appends, no yield |
| `SwapPrune`/`SwapReplace`/`CrashBetween` (probe) | the same two appends split across a crash window 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L54-L61〕 | none — this is the gap |
| `Refire` (probe) | host re-firing `tools/post-execute` 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L78-L92〕 | none (no already-marker check in `crush()`) |

## Requirements and properties

| Req ID | Business outcome | Property | TLA operator | Cases | Fault-or-race trace | Assumptions | Code symbol / atomicity | Regression scenario | Exclusion / justification 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L124〕 |
|---|---|---|---|---|---|---|---|---|---|
| R-1 | A defer swap's prune row is always immediately followed by its replace row | PrunePaired | `PrunePaired` | convention; strict-swap-crash | crash between the two appends | the swap is one synchronous critical section 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L40-L71〕 | no yield between the appends | `defer.spec.ts` "appends prune then replace adjacently, preserves non-content fields, debits the meter" | the crash window is a documented atomicity gap (probe) |
| R-2 | Any marker implies the original was persisted first | StoreBeforeReference | `StoreBeforeReference` | convention, apply-lane | — | `put` precedes ledger/append on every success path 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L52〕 | temp+rename atomic write 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L99-L108〕 | `composition-reducer.spec.ts` "store holds the original; retrieve round-trips" | none |
| R-3 | `applied:true` ledger rows correspond to real session appends carrying markers 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L7-L28〕 | AppliedImpliesMarker | `AppliedImpliesMarker` | convention, apply-lane, dry-run | — | staged commit ordering | `composition.spec.ts` dry-run/apply row assertions | ledger-vs-transcript divergence after a crash between ledger and caller commit is unmodeled (documented in implementation.md) |
| R-4 | Dry-run never appends to the session 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L59-L71〕 | DryRunNoAppend | `DryRunNoAppend` | dry-run | — | dry branches return `d`/`undefined` unchanged | config re-resolution per result | `composition.spec.ts` "deferred dry-run: stores and counts but NEVER appends" | none |
| R-5 | One tool result carries at most one marker (foldCounters truth) | SingleMarkerPerResult | `SingleMarkerPerResult` | convention, apply-lane, dry-run; strict-double-fire probe | host double-fire | host fires `tools/post-execute` exactly once per fresh result (declared assumption) 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L78-L92〕 | none in `crush()` | no test pins re-entry (gap) | the assumption violation is probed, not asserted |
| R-6 | A stale surface (mutated body) drops the resident without appending 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L45-L58〕 | structural (SwapAttempt stale branch) | — | convention | surface mutation racing the swap | byte-equality re-check inside the critical section | synchronous re-check | `composition.spec.ts` "swap:stale — a mutated surface body drops the resident without appending" | structural encoding; not a separate TLC predicate |
| R-7 | Swap only after `deferRequests` sends 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L59-L71〕 | structural (SwapAttempt guard) | — | convention | sends racing the pre-step pass | gate `sentCount >= deferRequests` (`gate.ts:44`, strict `>` on margin) | synchronous counting | `composition.spec.ts` "defer-requests: 2 — full text for two sends, stub at the pre-step before the third" | margin/urgency refinements excluded (deterministic arithmetic) |
| L-1 | A deferred entry eventually swaps or is abandoned 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L59-L71〕 | excluded | — | — | — | — | — | — | needs a real-time model of send arrivals and TTL sweeps; excluded |

## Faults and races explicitly modeled

1. **Swap crash window** (strict-swap-crash): the `compaction/prune` append
   and the `tool/result` replace append are split across a crash, leaving an
   orphan prune in the log. Expect a `PrunePaired` counterexample — the
   structural gap is real — but its CONSEQUENCE is benign 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L120〕, as the real
   `TokenMeter` proves (PR #301): the prune arms a **delta-0** shadow-price
   claim and only the adjacent `replace` consumes it, so an orphan prune
   deducts nothing, the surface stays unswapped, the resident stays swappable,
   and the retry on resume debits exactly once. The earlier revision of this
   document claimed "the token meter was already debited" — that claim was an
   assumption about meter semantics, NOT verified against the meter 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L120〕, and is
   RETRACTED here 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L40-L71〕.
   See `defer-swap-crash.spec.ts` in PR #301 for the real-meter evidence.
2. **Host double-fire** (strict-double-fire): re-firing post-execute for an
   already-crushed result appends a second marker (double-counted by
   `foldCounters`), because `crush()` has no already-has-a-marker check.
   Expect a counterexample — a declared-host-assumption violation, not an
   in-package defect.

## Assumptions

- A-1: single process, single-threaded event loop; each synchronous block
  is atomic. The modeled interleaving points are the awaits inside `crush`
  and between the two swap appends (probe only).
- A-2: the deterministic router's compression, token estimates and savings
  thresholds are abstracted into `routeHit` (a boolean); a sub-threshold
  saving escalates to the reducer (`routeHit = FALSE`).
- A-3: the reducer's one-shot side-query outcome is folded into `verdictOk`
  (lane failure / malformed / verify-fail all mean "passthrough, original
  preserved, nothing stored").
- A-4: the host fires `tools/post-execute` exactly once per fresh result
  (probed by strict-double-fire). `foldCounters` over `tool/result` events
  is the ground truth for applied counts 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L110-L116〕.
- A-5: parallel interleaving of multiple results on the post-execute path
  is excluded: each result's decision returns to its own waterfall slot,
  and the store put is content-addressed and idempotent; the only
  order-sensitive consumer (the swap pass) has its own synchronous
  critical section per entry.
- A-6: the defer fast-path row carrying `applied:false` with a hash is
  known, intended behavior (the session has not changed yet; the
  `applied:true` swap row follows). Not asserted as an invariant.

## Bounds

One tool result; at most 3 sends; log length bounded by the action set
(each result can append at most 2 tags without the probe; the double-fire
probe allows one more cycle); no time.

## Case plan

| Case | Coverage | Constants | Invariants | Expected 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L124〕 |
|---|---|---|---|---|
| convention | core | DeferRequests=1, DRY=FALSE, CrashWindow=FALSE, HostDoubleFire=FALSE 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L59-L71〕 | all | verified |
| apply-lane | expansion | DeferRequests=0 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L7-L44〕 | TypeOK, PrunePaired (vacuous), StoreBeforeReference, AppliedImpliesMarker, SingleMarkerPerResult | verified |
| dry-run | expansion | DRY=TRUE 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L59-L71〕 | TypeOK, PrunePaired, DryRunNoAppend, AppliedImpliesMarker, SingleMarkerPerResult | verified |
| strict-swap-crash | expansion | CrashWindow=TRUE 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L45-L58〕 | TypeOK, PrunePaired | counterexample (documented atomicity gap) |
| strict-double-fire | expansion | HostDoubleFire=TRUE 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L97-L115〕 | TypeOK, SingleMarkerPerResult, PrunePaired | counterexample (host-assumption violation) |

## Screening section (current)

Formal design: mode `auto`, decision `enabled`, triggerIds FD-T1/T2/T3 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L124〕,
modelDir `specs/tla/ccr-pipeline`, review rules **not loadable** 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L124〕
(AGENTS.md stub) — formal review dispatch blocked 〔src:ws:specs/tla/ccr-pipeline/code-anchors.md#L1-L124〕.
