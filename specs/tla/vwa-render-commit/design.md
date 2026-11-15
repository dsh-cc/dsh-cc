# Design: vwa-render-commit

Model of the VWA draft-render commit protocol (design doc §4.2, §4.3, §4.5, §7.1, §7.2, §10.1).

Behavioral source: `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md`.

## Formal design screening

- mode: auto
- decision: enabled
- triggerIds: FD-T3 (crash recovery determines the persistence order of the deliverable, the
  render intent and HEAD, and therefore whether the graph and the published bytes agree),
  FD-T2 (a retried or replayed bind request, and an unrelated transaction landing between a crash
  and its retry, change the observable outcome), FD-T1 (the author's draft edit and the runtime's
  bind act on the same artifact state).
- backends: `["tla"]`
- modelDirs: `["specs/tla/vwa-render-commit"]`
- modelDir (TLA-only compatibility): `specs/tla/vwa-render-commit`
- rationale for excluding Lean: no authorization/eligibility composition whose violation changes
  effective behaviour (the §3.2 path predicate is a pure string function covered exhaustively by a
  fixture corpus), and no arithmetic conservation or bound requirement. Nothing was downgraded to a
  cheaper backend: a Lean obligation simply does not exist here.
- userDirective: the session request "如果有必要，使用formal-design建模或修改存量模型，从而确保设计没有缺陷".

Screen again when: the bind mutation shape, the overwrite gate, the render-intent record, the read
classification, or the commit stage order changes.

## Requirement ↔ property ↔ model ↔ code mapping

| Req | Business outcome | Property | TLA operator | Case | Fault-or-race trace | Assumption | Code symbol and atomicity mechanism | Exclusion |
|---|---|---|---|---|---|---|---|---|
| R-1 | the published file is never a partial write | I1 `NoTornOutput` | `NoTornOutput` | convention; probe `strict-non-atomic` | crash between the temp write and the rename | A-1 | staged file via `writeTemp` + `rename` + `fsyncDir` (`store.ts:466-473`) | the underlying filesystem's rename atomicity is assumed |
| R-2 | no citation marker ever reaches a reader of the deliverable | I2 `MarkerFreeByConstruction` | `MarkerFreeByConstruction` | convention | any bind | A-2 | `stripMarkers` is total and deterministic (`render.ts`, design §4.5); only `RenderId(draft)` is ever staged | modeled structurally, not as a string search |
| R-3 | a quiescent project's deliverable matches its recorded hash | I3(i) `AgreementWhenQuiescent` | `AgreementWhenQuiescent` | convention; probe `strict-adopt-without-render` | HEAD adopts a stale hash and clears its own bookkeeping | A-3 | `HeadStep` sets `graph' = RenderId(draft)`; read-back verifies HEAD (`store.ts:493-497`) | only graph/deliverable disagreement is observed, not every graph field |
| R-4 | a provisional render is never misreported as user drift | I3(ii) `ProvisionalIsStale` | `ProvisionalIsStale` | convention; probes `strict-misclassify-stale`, `strict-skip-intent` | crash after stage 1, then any read | A-4 | three-state classification over `contentHash`, `stripMarkers(draft)` and the `renders/<requestId>.json` intent (design §7.2) | legacy inline artifacts are two-state and out of scope for this property |
| R-5 | every persisted span still matches its text | I4 `SpanSafety` | `SpanSafety` | convention; probe `strict-span-overlap` | an occurrence overlaps a stripped marker | A-5 | design §4.2 step 5 rejects overlap before the transaction commits | offset arithmetic itself is not modeled; it is covered by unit tests (§4.5) |
| R-6 | a replay cannot adopt two divergent states | I5 `ReplayContentStable` | `ReplayContentStable` | convention (`UnrelatedTx`) | crash, unrelated transaction, retried bind | A-6 | `withTransaction` idempotency pre-check on `(requestId, payloadHash)` (`store.ts:407-424`) | replay safety is content-level, not revision-level (design §7.4) |
| R-7 | the pipeline never destroys a file it does not own | I6 `NoLostUserFile` | `NoLostUserFile` | convention; probe `strict-overwrite-foreign` | a first bind targets an existing user file | A-7 | the §4.3 overwrite gate (`overwrite: true` required) | a takeover that the user explicitly authorized is out of scope |

## Assumptions

- **A-1** The filesystem rename is atomic within one directory (temp file created as a sibling).
- **A-2** `stripMarkers` is a total function: every marker-shaped sequence is removed, and the
  result never contains one. Justified by the uniform regex and pinned by unit tests.
- **A-3** The read-back verification in `commit` stage 5 observes the HEAD it just wrote, or the
  transaction reports `STORE_CORRUPT`.
- **A-4** The current draft is readable at classification time; if it is not, the intent record is
  the fallback evidence (series b of §7.2).
- **A-5** An occurrence that overlaps a removed range cannot be persisted, because the bind
  rejects it.
- **A-6** A retried request carries the same payload hash; a different payload under the same
  request id is `IDEMPOTENCY_CONFLICT` (`store.ts:416-418`) and is refused.
- **A-7** A deliverable the graph has never adopted is not owned by the pipeline, regardless of
  who created it.

## Bounds and abstractions

Constants: `MaxRev = 3`, two requests, two draft versions, two render identities. Recorded
abstractions for review:

- Deliverable values are a closed set (`none`, `foreign`, `r1`, `r2`, `torn`) instead of byte
  strings; `torn` exists only to make the non-atomic probe observable.
- Marker stripping is by construction (I2), so the model never stores marker-bearing text.
- `ahead` is the sole observation of "deliverable is newer than the adopted graph".
- The render-intent record is one set of render identities, not a file with fields; the fields that
  matter for the property are `target` (implicit: one artifact in the model) and `renderedHash`.

## Coverage

Core case `convention` (correct design, `MaxRev = 3`) must be `verified`. Six probe cases live in
the sibling directory `specs/tla/vwa-render-commit-probes` and are expected to produce
counterexamples; see that model's design.md for the probe ↔ wrong-design mapping.

## Exclusions

- The offset arithmetic of marker stripping (surrogate pairs, endpoint affinity) — unit-tested per
  design §4.5, not state-machine behavior.
- Path canonicalization and symlink escapes — pure path predicates, covered by the fixture corpus
  of design §3.2 and the permission tests.
- The review pipeline itself — modeled separately (design §10.2).
