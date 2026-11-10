# Implementation record: memory-recall-dispatch

Effective project rules at modeling time: the root AGENTS.md carries **no**
formal-design screening clause — screening is session-adopted (user request
2026-11-02; full-program scope confirmed via ask_user_question). Adoption
snippet: `<skill>/references/agents-snippet.md`. No formal review dispatched.

## Final run

- runId: `20261103T040257Z-577158c3-9f8f-4b38-bf4b-9dda3f89251b` (freshness re-run after the evidence annotations; identical statistics per case)
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

## Implementation record — S1-03 slice 3 (active coordinator + wiring)

Keyed to the approved behavioral source
`docs/plans/2026-11-02-systemone-03-memory-recall.md` (§"Query generations and
when shown takes effect", §"Failure table and mode switching", §"Privacy,
caching and logging", §"File and dependency inventory") and to this package's
verified run `20261103T040257Z-577158c3-9f8f-4b38-bf4b-9dda3f89251b`
(`checks.json`: core case + 5 probes, 9 invariants). The package artifacts store
no content digest, so the design path plus that run id are the keys; the TLA
model and `checks.json` are unchanged by this slice.

### Observed mechanisms

| Model element | Implemented symbol |
|---|---|
| `Arrive` / ticket | `recall-coordinator.ts` `RecallCoordinator.run`; origin via `recall-query.ts` `resolveRecallTurn` (the turn's own `turn/start` seq - the 2026-11-10 issue #359 redesign: a user-message seq is persisted only after the pre-step waterfall, so text matching could never resolve; `session.seq` is never used), then `recall-dispatch-key.ts` `recallLocalKey` |
| `pend` (newest wins) | `RecallState.pending`, replaced on every new key |
| `runGen`/`runKey`, `AbortOnArrive` | `RecallState.running` slot + `controller.abort()` in `run` |
| `OldFinally` (own generation only) | `start()`'s `finally` clears the slot by IDENTITY (`state.running === slot`) and starts at most one newest pending ticket |
| `Start`/`ScanOk` | `scanRecallLayers` (`recall-coordinator-support.ts`) with `{ withContentHash: true }`; `scan.ts` hashes the raw bytes it already read (no extra reads, content never sent) |
| dispatch key / `IgnoreCompleted` | `recall-dispatch-key.ts`: local key + manifest hash + sorted-tools hash + route identity + effective-settings hash; `completed` is consulted only once the full key exists |
| `ScanFail`/`ReadFail`/`InjectFail`/`InjectEmpty` | `execute()` terminal writes: read failure / empty read-back / content-hash mismatch / `agent.inject()` throw. A scan failure writes nothing |
| `InjectOk`, `ShownSubsetDelivered` | `shown` + `recordDelivered` written only after a synchronous `agent.inject()` returned |
| `NoReinject` across keys/generations/modes | `MemoryRecall` DeliveredRecallPaths mirror (every mode), `seedShown`, and shown refreshed from the mirror on each read |
| `NoStaleInject` | `isCurrent()`: generation, per-Agent WeakMap identity, scopeKey, task signal, `agent.status !== 'idle'`, re-checked before reading, after reading and before injection |
| `Dispose` | `RecallCoordinator.dispose()` aborts every live controller; `cancel`/`release` per Agent; `agent/disposed` wiring in `index.ts` |

### Checked (actual code tests)

`pnpm vitest run packages/memory/memory/tests` → 19 files passed, 1 skipped
(`DSH_RECALL_EVAL` unset), **305 tests passed**: the 288 pre-existing tests
unchanged plus 17 new in `tests/recall-decision-lifecycle.spec.ts`.
`pnpm typecheck`, `node scripts/check-spec-deps.mjs`,
`node scripts/check-file-size.mjs` and `pnpm check:inject` all pass.

Matrix row → test (all in the new spec):

- query B arrives while A is unfinished, A returns first → "drops a superseded
  query A and sends query B exactly once".
- same text with a new user origin / repeated origin → "executes the same text
  for a new user origin and never for a repeated origin".
- no persisted user event → "sends no request while the turn has no persisted
  user event".
- tool belongs to another Agent → "a tool executed for another agent never
  pollutes this agent set".
- agent idle after reading → "an agent that went idle after reading injects
  nothing and marks no shown".
- selected content empty / read failure / changed hash / inject throws → the
  four "terminal dispatch keys" legs; each asserts the path never enters shown
  and that the key is not paid twice.
- scopeKey change clears state → "clears the completed set when the scope key
  changes"; dispose/Agent dispose abort → "aborts the in-flight task on
  dispose" and "releases one agent state …".
- shadow comparison opposite to the baseline → "runs only the baseline in shadow
  mode and logs no content or query" (the record contains no query, filename or
  body); unavailable comparison is reported, never fabricated.

Guard loading check: with BOTH the generation guard in `isCurrent` and the
supersede `controller.abort()` removed, the superseded-A leg fails; with either
guard alone it passes, i.e. the two are defence in depth as modeled.

### Deviations (implementation, not modeled semantics)

- `originSeq` comes from the session snapshot; a multi-message pre-step batch
  has no single persisted row, so its LAST genuine message text is the
  attribution fallback. The ticket key stays `(memoryDir, sessionId, originSeq,
  queryHash)` of the joined query.
- `recentTools` is per `exec.agent`; a call the host does not attribute keeps a
  host-wide set (pre-existing `tools/post-execute` callers emit no agent), so
  attribution isolates other agents without changing unattributed behaviour.
- The empty-content branch is unreachable in practice (a topic must parse
  frontmatter to be scanned, and both branches inject the whole file text); it
  is kept as a guard and the test drives the observable equivalent (an empty
  read-back, which also mismatches the hash).
- The shadow record is a host-logger `info` line carrying fixed enum values and
  counts only; the synthetic-fixture comparison report remains the explicitly
  offline-evaluation concern named above.
- `recall.ts` was split (per-file size budget): the generative selector now
  lives in `recall-selector.ts` and is re-exported from `recall.ts`, and the
  decision modules import `MAX_RECALL_MEMORIES` from there, removing a module
  cycle through `recall.ts`.

### Blockers

None. Not verified here (unchanged from above): judgement quality, metering,
and the real-route eval arm; the README/lockfile task of the design's task list
is out of this slice.
