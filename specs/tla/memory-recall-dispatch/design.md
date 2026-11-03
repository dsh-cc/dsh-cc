# Design: memory-recall-dispatch (SystemOne S1-03 coordinator)

Model directory: `specs/tla/memory-recall-dispatch`. Module `Model`,
spec `Spec`, safety-only.

## Formal design screening

- mode: **auto** (session-scoped; the project rules carry no formal-design
  screening clause at this revision — user request 2026-11-02, full-program
  scope confirmed via ask_user_question; adoption snippet at
  `<skill>/references/agents-snippet.md`).
- decision: **enabled**
- triggerIds: FD-T1 (the coordinator mutates per-Agent state — pending
  ticket, running slot, shown/completed — that several pre-step triggers and
  one in-flight task share), FD-T2 (a superseded generation's task settles
  late and its `finally` races the newer task; a late result must not inject
  after the generation moved).
- backends: `["tla"]`, modelDirs: `{"tla": "specs/tla/memory-recall-dispatch"}`.
- behavioral source: `docs/plans/2026-11-02-systemone-03-memory-recall.md`
  §dispatch key / generation / inject-commit paragraphs and §failure table.
  Not implemented; existing code that constrains it:
  `packages/memory/memory/src/recall.ts` (`MemoryRecall`, `shown`,
  `recentTools`, the existing `lastQuery`-before-`inFlight` hazard the design
  explicitly forbids inheriting).

## Requirements

- **REQ-1** A ticket is keyed by (memoryDir, sessionId, originSeq,
  queryHash); a new key increments the generation, replaces the single
  pending slot (newest wins) and aborts the running task.
- **REQ-2** Scanning starts only after the ticket is obtained
  synchronously; a duplicate key that is already running or pending returns
  without a new request.
- **REQ-3** The dispatch key is complete only after the scan adds the
  manifest hash, the sorted recentTools hash and the route identity; only
  then is `completed` consulted, and a completed key issues no request.
- **REQ-4** `shown` is written only after `agent.inject()` succeeds
  synchronously, and only for paths of actually non-empty content; the
  delivered mirror is updated at the same moment and is the only source for
  cross-mode seed.
- **REQ-5** Freshness (generation is still the latest, scopeKey and
  originSeq unchanged, not cancelled, not idle) is re-checked before the
  final injection; a superseded generation never injects.
- **REQ-6** An old task's `finally` cleans up only its own generation and
  never a later task's running slot.
- **REQ-7** Every terminal path writes `completed` for that dispatch key
  (empty selection, read failure, hash mismatch, thrown injection), and no
  undelivered path is ever recorded as shown.
- **REQ-8** The same dispatch key is paid for at most once (one wire
  attempt per batch; the feature adds no retries).
- **REQ-9** A path is injected at most once across keys, generations and
  mode switches.

## State variables

| Variable | Meaning | Durability |
|---|---|---|
| `gen` | generation counter, incremented per new ticket | memory |
| `pend` | the single pending ticket (newest wins) | memory |
| `runGen`, `runKey` | the running task's generation and key (`none` when idle) | memory |
| `phase` | `none` / `scanning` / `reading` / `injecting` | memory |
| `completed` | dispatch keys that reached a terminal state | per-session LRU (cap 16) |
| `dispCount` | per-key wire attempt counter (history projection) | derived |
| `shown` | paths marked as delivered in this session | durable per Agent |
| `delivered`, `injected` | monotone history projections of successful delivery | derived |
| `alive` | the plugin/Agent is not disposed | memory |

## Coverage matrix

| Invariant | Requirement | Adverse trace challenged |
|---|---|---|
| `ShownSubsetDelivered` | REQ-4/7 | `ShownBeforeInject` probe: shown written on a throwing inject |
| `NoReinject` | REQ-9 | a second key selecting an already-delivered path |
| `NoStaleInject` | REQ-5 | `InjectStale` and `OldClearsNew` probes: inject after supersession |
| `CompletedNeedsDispatch` | REQ-7 | `CompletedTooEarly` probe: terminal written from a scan failure |
| `RunningBound`, `GenCurrent` | REQ-1 | `AbortOnArrive=FALSE` probe: a superseded task still owning the slot |
| `SlotNamesInFlight` | REQ-6 | `OldClearsNew` probe: a stale `finally` clearing the newer slot |
| `NoLateDispatch` | REQ-3/8 | `IgnoreCompleted` probe: a completed key dispatched again |
| `TypeOK` | — | — |

## Bounds and assumptions

- Two origins, two manifests (so four possible dispatch keys), two candidate
  paths, generation counter bounded at 3.
- An `Arrive` models both "a new user turn" and "a manifest change produces a
  new key for the same origin"; both raise the generation and abort the
  running task, per REQ-1. Older pending tickets are dropped (newest wins).
- Cancellation, idle and dispose are modeled as the running slot being
  cleared (`Arrive`, `Dispose`); a task that later settles is `OldFinally`.
- The model abstracts the scan/read content work: `ScanOk`/`ScanFail` and
  `ReadOk`/`ReadFail`/`SkipCompleted` stand for the whole scanning and
  content-reading pipeline, including the content-hash mismatch case
  (`InjectFail`).
- Out of scope: the judgement quality (Noul/Score thresholds, grey zone),
  batching and window limits, the legacy selector fallback, the shadow
  comparison, `recentTools` contents, and S1-02 metering.

## Invariant refinements made during checking (modeling, not design)

- The dedup contract is expressed as `NoLateDispatch` — a witness set that
  records a dispatch issued while the key was already in `completed` — not
  as `dispCount[k] <= 1`. A key aborted in flight (superseded generation)
  never reached a terminal write, so a later trigger legitimately re-pays
  for it; the design says exactly this ("a later new origin or a manifest
  change yields a new key and may retry").
- `SlotNamesInFlight` (`phase /= "none" => runGen = gen`) replaces a weaker
  "slot names some generation" invariant: the first counterexample showed
  that a stale `finally` which also clears the in-flight task's phase hides
  the hazard. In the model the `finally` clears the slot only; a newer task
  keeps running, so an unowned in-flight task becomes observable.
