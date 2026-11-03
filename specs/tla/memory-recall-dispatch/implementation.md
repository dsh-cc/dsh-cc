# Implementation record: memory-recall-dispatch

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final run

- runId: `20261103T021653Z-5527f53e-8f45-4530-b940-e5c14bc26a70`
- toolchain: TLC 1.7.4 (bundled JAR, SHA-256 pinned), Java 25.0.2, runner
  `@dsh-cc/plugin-dsh-cc-agents` 0.9.3-rc.4, darwin.
- convention (core): **verified** — 9,196 states generated, 2,571 distinct,
  0 left on queue; all 9 invariants hold.
- Probes (expansion, expected counterexample; each hits exactly its intended
  invariant, so each guard is load-bearing):
  - `strict-inject-stale` (`AbortOnArrive=FALSE`, `InjectStale=TRUE`) →
    `NoStaleInject`: a superseded task injects.
  - `strict-shown-before-inject` → `ShownSubsetDelivered`: shown written on a
    throwing inject.
  - `strict-old-clears-new` → `SlotNamesInFlight`: a stale `finally` clears a
    newer task's slot, leaving the in-flight task unowned.
  - `strict-completed-too-early` → `CompletedNeedsDispatch`: a terminal
    written from a scan failure, before any dispatch.
  - `strict-ignore-completed` → `NoLateDispatch`: a completed key paid again.
- `check-evidence`: valid and fresh; aggregate `counterexample` is the
  expected legal form for a probe package.

## Counterexample classification

All development counterexamples were **modeling defects or over-strong
invariants**, never design defects:

1. Cross-type equality (`pend`/`runKey` used a string sentinel against tuple
   keys) aborted the run — TLC raises rather than returning FALSE. Fixed
   with a tuple sentinel of the same shape.
2. `TypeOK` bounded `dispCount` at 2, so a legitimate third dispatch made the
   type invariant red for the wrong reason; the bound was relaxed and the
   dedup property restated (see below).
3. `OneDispatchPerKey` (`dispCount[k] <= 1` for every key) was over-strong:
   a key aborted in flight before any terminal write may legitimately be
   re-paid by a later trigger. Replaced by `NoLateDispatch`, a witness set of
   dispatches issued after the key was already completed.
4. `OldClearsNew` was initially vacuous (the probe's `finally` also cleared
   the in-flight phase, so nothing observable broke). Reworked so the
   `finally` clears the slot only; `SlotNamesInFlight` then catches the
   unowned in-flight task.
5. REQ-2 (a duplicate key that is already running or pending returns without
   a request) was missing from the model; the first convention run found a
   double dispatch for the same key. Added as a guard on `Arrive`.

## Verified scope and mapping

- Model ↔ design: `docs/plans/2026-11-02-systemone-03-memory-recall.md` —
  the dispatch-key paragraph ("add the manifest hash, the hash of the sorted
  recentTools and the route identity, and only then check completed"), the
  generation paragraph ("increment generation, replace pending and abort the
  old running task; the old task's finally may clean up only its own
  generation"), the inject-commit paragraph ("only after `agent.inject()`
  succeeds synchronously are the paths … added to shown"), and the failure
  table's discard row.
- Property → clause: `ShownSubsetDelivered`/`NoReinject` ← inject-commit and
  the delivery mirror; `NoStaleInject`/`SlotNamesInFlight` ← generation and
  freshness re-check; `CompletedNeedsDispatch`/`NoLateDispatch` ← completed
  semantics and one-wire-attempt; `RunningBound`/`GenCurrent` ← supersede.
- Action → planned code: `Arrive` ↔ `recall-coordinator.ts` ticket
  computation; `Start`/`ScanOk`/`ScanFail` ↔ the scan start guard and
  manifest-hash key completion; `ReadOk`/`SkipCompleted` ↔ the completed
  check before dispatch; `InjectOk`/`InjectThrows`/`InjectEmpty`/
  `InjectFail` ↔ the inject commit and terminal writes;
  `OldFinally`/`Dispose` ↔ controller disposal and the per-Agent WeakMap
  cleanup.

## Not verified (explicitly out of scope)

- Judgement quality: Noul/Score thresholds, the grey zone, batching and
  per-question window limits, and the legacy-selector fallback (the failure
  table's "old selector at most once" row).
- The shadow comparison and its synthetic-fixture reporting.
- `recentTools` content/isolation beyond its role in the dispatch key, and
  `scan.ts` content hashing (only the mismatch outcome is modeled).
- Timing: timeoutMs coverage, cancellation latency, and liveness of the
  pending ticket (a ticket may be dropped when superseded — that is the
  specified newest-wins behaviour, not a defect).
- S1-02 metering and hash-only logging.
