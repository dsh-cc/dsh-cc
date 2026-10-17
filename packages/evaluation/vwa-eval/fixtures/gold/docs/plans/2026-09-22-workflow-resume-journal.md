# Workflow resume journal: a wrapping subagent provider with frozen-until-first-miss replay

Date: 2026-09-22. Status: **Implemented** — ships via PR #117 (2026-09-23). Origin: dynamic-workflow three-way
investigation. Depends on: `2026-09-22-workflow-cc-parity-core.md` (run registry,
single-active-run constraint, prompt section). Sibling:
`2026-09-22-workflow-saved-commands-and-progress.md`. Design-review record:
cold review (three-way parallel, 2026-09-22) — **GO-WITH-AMENDMENTS applied**:
fabricated runs mint fresh SessionIds (never reuse the journaled childId);
pending-claim expiry is now specified (deposit overwrites an unclaimed slot,
settle clears it); the arrival-order argument names the `acquireSlot` microtask
hop as the only reorder vector and adds the self-consistency note; journal
retention and truncated-tail tolerance are specified; the DoD gained five items
(id uniqueness, claim expiry, truncated tail, cleanup, failed-status freezing).
The review also traced both fabricated-handle consumers (`observeRun`, host
`startChild`) and found no `localAgent` dereference in the workflow path —
fabrication risk is lower than this document originally assumed.
Post-merge verification round (2026-09-23, against the harness 0.1.5-rc.1 pin
`1ef9c1fa9a` and the shipped core slice #116): every §2 anchor re-verified
(line drifts corrected in place), and six binding amendments recorded —
A1: the pending-claim slot and settled-run retention DO NOT exist in #116's
registry (it drops entries at settle); building them is part of THIS slice's
registry extension, specified in §3.2. A2: cache-hit lines are copied forward
into the new run's journal so resume chains stay sound (§3.3). A3: replay
provenance is an additive `cached: true` field on the dsh-cc-owned
`tool-workflow/agent-start`/`agent-end` records — `WorkflowAgentOutcome` is a
closed harness union ('completed'|'failed'|'cancelled'), so
`outcome: 'cached'` was never implementable (§3.4). A4: the journal directory
is namespaced per parent session and the boot sweep is TTL-based, because a
session-scoped registry makes "stale" undetectable across live sibling
sessions (§3.3). A5: capability/route mirroring happens through lazy GETTERS —
the service reads `capabilities` before calling `provider.start`, so
mirror-at-first-start would always be too late (§3.1). A6: CC's current docs
add one nuance this design already satisfies: an agent still running when the
run is stopped "starts over" — our missing-line miss covers it verbatim; CC's
cross-session storage lives under the session directory, while ours sits under
dshHome by choice (§3.3).
Confirmation review (2026-09-23, cold Staff-Engineer re-read of the amended
doc): verdict AMEND with six findings, all applied — DoD cleanup timing
(context-disposal, not settle-time), the terminal-gap drain rule (settle
flushes only the contiguous settled prefix and cannot deadlock), provenance
domain confinement (arrival-index == seq is display-only; replay correctness
never depends on it), the exact `{output, structured?, stopReason}` journal
projection (worker-boundary round-trip), restart-voids-state framing for the
TTL sweep, and validateResume TOCTOU absorption into one structured refusal.
Re-review of the fixed doc: **CONFIRM — implementable as written**.

## 1. Problem

Claude Code documents `resumeFromRunId` as a same-session replay with a
per-agent result cache, quoting the policy verbatim (code.claude.com
/docs/en/workflows):

> Claude Code replays the run in the order agents started, and each agent either
> returns its saved result or runs again: **Completed**: returns its saved
> result. The first agent whose prompt differs from the previous run … runs
> again, and so does every agent after it. … **Failed**: runs again, and so does
> every agent that started after it.

The harness workflow engine has no replay machinery at all: no `resumeFromRunId`
param, no result journal (whole-tree grep for `resumeFromRunId`, `scriptPath`,
and `.claude/workflows` returns zero hits), and the shipped tool records only
four top-line session events. Without intervention, the core slice ships a
documented-omission deviation: resume = re-run everything from scratch.

## 2. Current state (harness anchors verified 2026-09-22; line numbers re-verified 2026-09-23 against the 0.1.5-rc.1 pin `1ef9c1fa9a`)

- **A provider wrapper is a supported move.** `ctx.subagents.registerProvider`
  accepts external providers and only rejects duplicate names
  (`packages/subagent/subagent/src/index.ts:509-525`, re-verified 2026-09-23
  against the 0.1.5-rc.1 pin); `getProvider(name)` is
  public (`:532`). The built-in `spawn` provider is registered by
  `subagent-spawn-in-process` (`src/index.ts:68-69`); its class is not exported
  (`:41`), but `getProvider('spawn')` yields the instance and a wrapper may
  delegate `start` calls to it. Lazy lookup (or the `subagent/provider-added`
  event) covers registration-order races.
- **The provider contract** (`packages/subagent/subagent/src/types.ts:344`):
  `name`, `capabilities` (booleans: agentOptions / outputSchema / depthLimit /
  toolFilter / persona), `inheritsParentContext`, optional
  `agentRouteDefaults`, `start(request: ResolvedSubagentStartRequest)`;
  `SubagentStartRequest` fields are `label?`, `prompt: ContentBlock[]`,
  `parent`, `signal`, `agentOptions?`, `outputSchema?`, `maxDepth?`,
  `toolFilter?`, `persona?` (`types.ts:145`); the service pre-validates every
  capability-bearing field before delegating (`subagent/src/index.ts:641-657`,
  called from `start` at :556-586, which also resolves the durable descriptor
  onto the request at :561-566). The engine itself validates that the
  configured provider NAME exists at `engine.start()` time
  (`workflow-worker-thread/src/index.ts:76-88`; config default `spawn` at
  :116), so the journal provider must only be mounted before the first run.
  The returned `SubagentRun` (`types.ts:308-334`) is `{id: SessionId,
  localAgent: Agent|undefined, result: Promise<SubagentResult>,
  dispose(): Promise<void>}`; child failure
  resolves (never rejects) with `stopReason: 'error'`; infrastructure failure
  rejects.
- **What the workflow engine passes to the provider** — exactly
  `{prompt: ContentBlock[], parent, signal, outputSchema?, agentOptions?
  {provider, model}}` (`packages/workflow/workflow-worker-thread/src/host.ts:352-368`).
  The `signal` is a **per-run derived controller** (`host.ts:129`; the caller's
  signal only fans into it via `host.ts:160-170`). Worker-side `seq` is a
  monotonically increasing counter assigned at `agent()` invocation
  (`runtime.ts:263-264`) but reaches only the
  emitted `WorkflowAgentInfo` events (`runtime.ts:299`) — **not** the provider.
  `label`/`phase` likewise stay worker-side.
- **Failure mapping at the engine**: provider `start` rejection → fatal
  `WorkflowError('AGENT_START')` that kills the whole script
  (`runtime.ts:284-290`); a published child settling non-completed → `agent()`
  resolves `null` (`runtime.ts:332-339`).
- **Message-order chain**: worker-side `agent()` → `acquireSlot()` (a microtask
  hop — the only reorder vector in the chain) → MessagePort post → host
  `onMessage` → `startChild`. MessagePort delivery is FIFO, so provider arrival
  order equals slot-acquisition order; under free slots the microtask queue is
  FIFO in practice and under contention the waiter queue preserves order. This
  makes arrival order CC's "order agents started" in the only sense that
  matters here, and — the load-bearing property — the original and resumed runs
  traverse the *same* scheduling, so arrival-index comparison is
  self-consistent even if it ever diverges from a hypothetical absolute
  ordering. Asserted empirically in the spike (§DoD). Strong form: arrival
  index == seq always — seq is assigned at invocation, `acquireSlot` resolutions
  observe invocation order (immediate microtask under free slots, FIFO waiter
  queue under contention), and the host posts `ChildStarted` in provider
  acceptance order, so the durable seq and the provider's arrival index agree.
- **Fabricated-run consumer evidence** (0.1.5-rc.1): `observeRun`
  (`subagent/src/lifecycle.ts:134-163`) reads only `run.id`,
  `run.localAgent !== undefined`, and `run.result`; the catalog publish is
  skipped entirely when `localAgent` is undefined
  (`subagent/src/index.ts:568-584`), so a synthetic handle leaves no catalog
  row. Host-side, `startChild` reads `run.id`/`run.result` and later
  `record.run.dispose()` (`host.ts:388-449`). Nothing else dereferences the
  handle.
- **Closed outcome union.** `WorkflowAgentOutcome` is
  `'completed' | 'failed' | 'cancelled'` (harness-owned,
  `packages/workflow/workflow/src/types.ts:110`) and is computed worker-side
  from the result — a fabricated completed hit reads as `completed` upstream.
  Replay provenance therefore cannot ride `outcome` and must be an additive
  dsh-cc field (§3.4).
- The engine row's `config.provider` in
  `packages/preset/cc/agent.cordis.yml` is ours to repoint from `spawn` to the
  journal provider, with zero harness edits.
- dsh-cc precedent for pinning per-child metadata around spawn: resume-pins
  (`packages/subagent/resume-pins`) established write-pin-before-spawn,
  tombstoning, and fail-closed gates; the same disciplines apply to journal
  writes.

## 3. Design

### 3.1 Package

`packages/subagent/workflow-journal` (`@dsh-cc/workflow-journal`), registering
provider name **`cc-workflow-journal`**:
`inject = ['subagents', 'ccWorkflowRunRegistry']` (the registry service is
published by the core slice; §3.5 there). Preset: the existing engine row's
(`workflow-worker-thread`) `config.provider` switches from `spawn` to
`cc-workflow-journal` in this slice, and the new row joins the same
`delegation` isolate group — whose isolate map ALREADY carries
`ccWorkflowRunRegistry: true` since the core slice (#116), so only
`smoke:profile-boot` and the composition test's row-set assertion gain the new
row (the two gates that catch realm/set-list drift). Observable rename: the
service snapshots the durable descriptor with the DISPATCH provider name
before delegating, so real workflow children record provider
`cc-workflow-journal` (not `spawn`) in descriptors and `subagent/start`
lifecycle identity — recorded in the manifest's residual footnotes.

The wrapper mirrors the delegate provider's `capabilities`,
`inheritsParentContext`, and `agentRouteDefaults` through lazy property
GETTERS that resolve `getProvider('spawn')` on first READ and cache
thereafter. Read-time resolution is forced: the service consults
`capabilities` in `assertCapabilities` BEFORE it ever calls `provider.start`,
so mirror-at-first-start would always be too late. On the live path the
wrapper adds no handle wrapping at all — it returns the delegate's
`SubagentRun` unchanged and merely taps `run.result` to journal the
settlement; handle fabrication exists only on replay hits (§3.4).

### 3.2 Run attribution via signal identity

Each run has exactly one derived `AbortSignal` (`host.ts:129`), and every child
of that run carries it. The provider keys a `WeakMap<AbortSignal, JournalRun>`
on the signal: first `start` with an unseen signal claims the registry's
**pending-claim** slot; the claim stores `signal` reference equality as the
handshake's correctness anchor (the provider records the claimed signal and
matches later starts of the same run by identity).

**Registry extension this slice ships (delta on #116, all dsh-cc-owned).** The
shipped `CcWorkflowRunRegistry` has no claim concept and DELETES its entry at
settle (`registry.ts:210`), so nothing about a settled run survives — the
resume surface below is impossible without these additions:

- `CcWorkflowRunEntry` gains `journalPath` (computed by the registry as
  `<dshHome>/workflows/runs/<parentSessionId>/<runId>.jsonl` from
  `entry.session`) and an optional `resumeOf: WorkflowRunId`.
- `register()` additionally **deposits the pending claim** `{runId,
  journalPath, resumeOf}` — deposit happens inside the synchronous prefix
  (`startWorkflowRun` calls `register` before returning the receipt, and the
  engine's first provider `start` can only arrive after the worker boots), so
  deposit-before-first-child is guaranteed. The provider claims it via
  `registry.takePendingClaim()` (one-shot read-and-clear).
- Settle moves a bounded projection `{journalPath, stopReason, resumeOf}` into
  a FIFO-capped **settled map** (cap 128; eviction also deletes the journal
  file — isolated, owner-controlled data) and clears the pending claim when
  still unclaimed. This map is what powers the resume validation below.
- `registry.validateResume(runId)` returns the settled projection or raises a
  structured refusal: unknown id (lists in-flight and settled ids), in-flight
  run (§3.5), or evicted/swept journal. TOCTOU is absorbed: the launch prefix
  reads the journal file synchronously in the SAME tick as validation
  (eviction and sweep cannot interleave synchronous code), carrying the
  journal text into the pending-claim deposit; a vanished file surfaces as the
  same structured refusal, never an fs error to the model. The provider parses
  (never reads) the deposited text at claim.

Because the core slice enforces a single active run per session, claim
ambiguity cannot arise in v1; the provider refuses a `start` carrying an
unknown signal while no pending claim exists (loud `AGENT_START` — an
impossible-by-construction state, so loudness is correct).

Claim lifecycle is explicit: a new run's deposit **overwrites** any unclaimed
slot (a zero-agent script or an immediate fatal never spawns a child, so its
deposit would otherwise linger), and the registry **clears** the pending claim
when its run settles; an already-aborted start (`host.ts:161-163` cancels in
the host constructor before any child start) likewise leaves a deposit that the
next deposit replaces. Claim-stealing therefore cannot misattribute run B's
children to run A.

This design deliberately does not try to infer runId from `parent` or prompt
content: signal identity is load-bearing and documented because it is the only
per-run value the engine guarantees to share with its children.

### 3.3 Journal

Path: `<dshHome>/workflows/runs/<parentSessionId>/<runId>.jsonl` (dsh-home per
the dual-home convention; chosen outside the harness session directory — unlike
CC, which stores saved results under `~/.claude/projects/<session>/` — so a
later cross-session slice can adopt it without migration, while this slice only
resumes same-session runIds present in the registry). The per-session
namespace is load-bearing for retention (below): it makes "this session's
journals" a well-defined set without consulting any other process's state.

One JSON line per settled child, written at settle time, sequence-complete (a
line is appended only when the result at that index exists — the provider
assigns the arrival index at `start` and buffers out-of-order settlements,
flushing in order; a gap blocks later lines only until it fills):

```json
{"seq":3,"hash":"…","status":"completed","result":{…}}
```

- `hash = fnv1a32hex(canonicalJson({prompt, outputSchema ?? null, agentOptions
  ?? null}))`. CC keys its cache on prompt equality; we key on the full request
  triple because an identical prompt with a different `outputSchema` or model
  route is observably not the same agent call, and a false hit is far worse than
  a false miss. `canonicalJson` semantics: object keys sorted by code point,
  `undefined` dropped, arrays order-preserving (the zcode hash primitive, policy
  adopted not code-shared).
- `status` mirrors the settled outcome class: `completed` (replayable),
  `failed | aborted | error | max-tokens | refusal` (per CC policy, all treated
  as failed-for-replay), never written for in-flight children.
- `result` is exactly the projection the host will re-snapshot for the
  fabricated run: `{output, structured?, stopReason}`, persisted verbatim from
  the settled `SubagentResult` (`structured` present only when a schema was in
  force). Replay reconstructs precisely that shape, so the value round-trips
  the worker boundary (`snapshotJsonValue`, host.ts) and the worker-side
  `stopReason === 'completed'` + `structured !== undefined` checks exactly as
  the original did — it crossed that boundary once already.
- Writes are atomic (tmp+rename per append batch) under the established
  pin-store discipline; corruption of any line fails the whole journal's
  replayability for that run (fail-open to live execution, §3.4). One tolerance:
  a trailing unparseable *last* line (crash mid-append, made near-impossible by
  tmp+rename) is dropped at load rather than poisoning the journal.
- Size guard: a run journal exceeding a configurable byte cap (default 8 MiB)
  stops recording further cacheable lines (later seqs simply re-run on resume);
  the run itself is unaffected. Artifact pressure is bounded by the engine's own
  `maxTotalAgents` cap and per-result text sizes.
- Copy-forward: a replay hit re-appends the consumed line (same content, at the
  same index) into the NEW run's journal, so resume chains (A → resume → B →
  resume → C) replay B's copied prefix correctly instead of silently degrading
  to a full re-run. A copy-forward failure fails open to spawning that child
  live — never to dropping the run.
- Drain discipline: appends queue on a per-run promise chain (`drain`); run
  settle awaits `drain` before the settled-map projection is published, so
  settled-map membership ITSELF certifies a fully-drained journal — the launch
  prefix can read the source journal synchronously with no separate await
  (§3.2). No half-written file is consultable at any validation point, and
  context disposal awaits every open run's `drain` before deleting.
  Terminal-gap rule: at run settle, children in flight at cancel time never
  settle, so the settlement buffer can hold a PERMANENT gap — settle flushes
  only the contiguous settled prefix and DISCARDS buffered lines beyond the
  first permanent gap (a gap is a resume miss anyway, so suffix lines are
  useless; any earlier line after the gap would resurface stale results under
  the fresh prefix pairing). `drain` awaits only issued appends, never
  unsettled children — settle therefore cannot deadlock.
- Retention: cross-session replay is out of scope and the registry is
  session-scoped (empty at boot), so a journal ceases to be resumable the
  moment its session ends. Context disposal deletes the session's OWN
  directory; the package's startup sweep deletes session directories whose
  mtime is older than a TTL (default 24h, configurable) — the registry cannot
  know which sibling dsh sessions sharing `dshHome` are live, so TTL is the
  bounded proxy. The documented false-deletion ceiling: a single sibling
  session alive longer than the TTL loses its resumability (a structured
  "journal garbage-collected" refusal at resume time, never a crash). Both
  paths obey the dual-home ownership rule: write-owned directory, never user
  data.

### 3.4 Replay: frozen-until-first-miss

On `resumeFromRunId` the launch path validates the id in the registry (§3.2),
awaits the source run's journal `drain`, then re-enters `engine.start` with the
*current* script text (the caller may have edited it); `register()` deposits
the pending claim with `resumeOf` set. The provider then resolves each incoming
child in arrival order:

- **While unfrozen** (no miss yet): compare the child's request hash with the
  old journal line at the same arrival index. Match → **do not spawn**; return a
  fabricated `SubagentRun` whose `result` resolves to the stored result and
  whose `dispose()` resolves immediately (provenance rides the additive
  `cached: true` extension below). Mismatch on
  hash, a non-completed stored status, a missing line, or journal corruption →
  flip frozen permanently for this run, spawn live, and every subsequent seq
  spawns live regardless of matches (this *is* CC's "and so does every agent
  after it").
- Fabricated-run compatibility is the slice's load-bearing spike: `SubagentRun`
  exposes `id: SessionId` and `localAgent`; consumers (the engine's host-side
  handshake, invariant listeners keyed by session id) may assume a real session.
  The fabricated run's `id` is a **fresh `SessionId` (uuid)** — never the
  journaled childId, which the previous run already published under the same
  parent (the service's `observeRun` emits `subagent/start` keyed on that id;
  id reuse would collide with the prior run's published children in catalog,
  session-log, and invariant consumers). The spike constructs a synthetic run
  handle and dogfoods an all-hit replay end-to-end. Review traced both
  consumers (`observeRun` reads only `id`/`localAgent`/`result`; the host
  handshake reads `id`/`result`/`dispose`) — none dereference `localAgent` in
  the workflow path, so fabrication is expected to pass trivially. If a future
  consumer hard-depends on `localAgent`, the fallback is to
  make the replays *status-only* (children spawn with a short-circuit prompt
  wrapper) — documented as design recourse, not silently folded in.
- **Precedence with engine events**: fabricated hits still emit the engine's
  ordinary `agent-start`/`agent-end` (the seq counter advances worker-side as
  usual because `agent()` is invoked normally; only the provider short-circuits
  the spawn). Timeline consumers observe an instant hit pair.
- **Replay provenance**: `outcome` cannot carry it (`WorkflowAgentOutcome` is a
  closed harness union — §2), so the dsh-cc-owned durable records gain an
  additive `cached: true` field on `tool-workflow/agent-start` and
  `tool-workflow/agent-end` (same move as `run-start`'s existing `source`
  extension; additive fields do not break the harness renderer). The provider
  reports each hit as `registry.markCached(runId, arrivalIndex)`; the
  registry's start/end listeners enrich the record when `agent.seq` is in the
  cached set — exact because arrival index == seq (§2 strong form). Correlation
  caveat: replay CORRECTNESS does not depend on this equality (both the journal
  and the frozen-until-first-miss rule speak provider arrival index only); if
  the strong form ever breaks, the sole damage is a mis-flagged `cached` row —
  the equality is asserted in composition and dogfood (§DoD), not just in the
  spike. Fabricated rows also record the synthetic `childId` (the harness-owned
  `WorkflowAgentInfo.childId` field carries the fabricated uuid through
  unchanged), which is NOT a live session id:
  consumers must consult `cached` before treating `childId` as resolvable.

The resume API flips five shipped surfaces in one move: the two refusal sites
(specific throw in `index.ts` `execute`, key-scan + `ALLOWED_KEYS` +
`RESUME_REFUSAL` in `launch.ts`), the tool's `parameters` schema (gains
`resumeFromRunId: string`), and the two "not available in this release" texts
(tool DESCRIPTION, prompt section) reworded to the real contract.
`resumeFromRunId` requires a runId with a settled-map entry in the same-session
registry (else structured refusal listing known runIds, including in-flight and
swept/evicted explanations); the new run's `taskId`/`runId` is fresh, and its
event stream records `resumeOf` on `run-start`.

### 3.5 Interplay with the core slice's constraints

- Single active run per session keeps §3.2 sound and also means the old run
  being resumed is settled by construction (`validateResume` only returns
  settled-map entries; in-flight ids get their own refusal).
- Resume of a still-in-flight run is a structured refusal (CC's pause-then-`p`
  TUI flow has no dsh-cc surface yet; the observability slice owns it).
- Resume across sessions and `claude --resume`-class replay remain out of scope;
  the journal path layout leaves the door open without committing to it.

## 4. Expected effect

- Edit-one-line-then-resume costs one new agent plus the suffix, instead of the
  whole fan-out; a mid-fan-out failure reruns exactly CC's documented suffix.
- The manifest can state `resumeFromRunId` as implemented same-session replay
  rather than omitted, with a single residual deviation (cross-session).
- The journal doubles as the per-agent evidence trail the observability slice
  renders.

## 5. Non-goals and risks

**Non-goals.** Cross-session/`claude --resume` replay; concurrent multi-run
journaling; journaling ordinary `Task` subagents (only the workflow engine's
provider is wrapped — ordinary spawns never touch `cc-workflow-journal`);
merkle-style script-content identity (CC's identity is per-agent, not per-script);
cache eviction policies beyond the size cap.

**Risks.**

- *Fabricated `SubagentRun` compatibility* — mitigated by making it the first
  spike item with a named recourse; the slice does not ship without the spike
  passing, and the core slice's restart-semantics deviation remains the honest
  fallback.
- *Arrival-order == "order agents started"* — argued structurally (chain: FIFO
  MessagePort; `acquireSlot` is the only reorder vector, FIFO in practice), but
  the replay comparison is *self-consistent* — original and resumed runs traverse
  identical scheduling, so the pairing holds even under a divergence; the spike
  still asserts it empirically with a `parallel()` fan-out plus a `pipeline()`
  chain. If reordering is observed despite this, the slice re-plans.
- *Hash canonicalization drift* (float serialization, key order in nested
  schemas) — covered by golden-vector unit tests shared with the future zcode-
  parity implementation notes; a false miss is safe (extra work), a false hit is
  the failure mode the full-request hash exists to prevent.
- *Registry/provider handshake race* — pending-claim is deposited synchronously
  after `engine.start` returns; a child-start can only arrive after the run
  exists; ordering is forced by the engine being synchronous-prefix. The
  composition test asserts the deposit happens before the tool's receipt
  resolves.
- *Journal write amplification* — settle-time appends are small; the byte cap
  plus atomic-append discipline bound cost; fsync policy matches resume-pins.
- *TTL sweep false deletion* — a sibling session alive longer than the TTL
  loses resumability while its registry still names the run; `validateResume`
  checks journal existence and answers with the structured
  "garbage-collected" refusal, so the blast radius is one refused resume, never
  a crash or a misattributed child.
- *Process restart voids resume state* — the registry (and with it the settled
  map) is in-memory and session-scoped, empty at boot; journals surviving on
  disk after a crash serve no resume and exist only until the TTL sweep takes
  them. The sweep is disk hygiene, not crash recovery; cross-session replay is
  the named non-goal that would change this.

## Spike record (DoD 1)

Measured 2026-09-23 from `packages/subagent/workflow-journal/tests/spike.spec.ts`:
real `WorkerThreadWorkflowEngine` + real `SubagentRuntime` + real
`CcWorkflowRunRegistry` with a fake spawn delegate. Script:
`parallel(4) + pipeline(3 items × 2 stages)` = 10 agents.

- **(a) Arrival order.** The provider's arrival order matched invocation
  order 1..10: fan prompts 0..3 in order, and each pipeline item's stage 1
  settled before its stage 2.
- **(b) Durable records.** All 10 `tool-workflow/agent-start` records carry
  `seq` equal to the provider arrival position; live rows carry no `cached`
  field.
- **(c) All-hit resume.** Resuming the settled run with the unchanged script
  performed zero delegate spawns; the run's result value deep-equals run 1's;
  all 10 replay rows carry `cached: true` on agent-start and agent-end; the
  new journal is byte-identical after copy-forward.
- **(d) Edited middle prompt.** Editing fan prompt 2 and resuming re-ran
  exactly the 8-line suffix (fan 2 EDITED, fan 3, and the 6 pipeline agents);
  fan 0 and fan 1 replayed from cache.

Residual noted by the spike: cross-item interleaving *within* a pipeline is
engine-owned and not pinned by the spike's arrival assertions.

## Acceptance (DoD)

1. Spike (timeboxed, recorded in the doc before merge): fabricated-handle
   end-to-end replay of an all-hit run; arrival-order assertions under
   `parallel()` and `pipeline()`; consumer compatibility notes (`localAgent`,
   invariants).
2. Unit matrix with a fake provider as the delegate: all-hit replay performs
   zero real spawns; first-miss freezing reruns exactly the suffix; per-seq hash
   misses behave identically to a mid-script edit; corrupt-line journal fails
   open live; a trailing truncated last line is dropped (not fatal);
   schema-change and model-change both miss; size-cap boundary;
   fabricated-run dispose idempotence; fabricated-run ids are fresh uuids and
   never equal a journaled childId; pending-claim expiry (zero-agent run
   followed by a normal run attributes to the normal run; a settle clears the
   claim); a journal line with failed status *before* the first prompt change
   freezes at that seq (first-miss is status-driven, not only prompt-driven);
   abort mid-replay leaves the journal consistent (no half-written lines);
   copy-forward keeps a second resume's prefix intact (resume of a resumed run
   replays the copied lines instead of re-running everything); replayed rows carry
   `cached: true` on both agent-start and agent-end records while live rows do
   not; `validateResume` distinguishes unknown (lists known ids), in-flight,
   and swept/evicted journals; the settled map's FIFO eviction deletes the
   evicted journal file; resume validation and context disposal both await
   `drain`; context-disposal cleanup deletes the session's own journal
   directory and the startup sweep removes expired session directories only;
   a cancel with a never-settling child flushes only the contiguous settled
   prefix, discards lines beyond the permanent gap, and settle does not hang.
3. Composition: engine row on `cc-workflow-journal`, ordinary `Task` spawns
   unjournaled, delegate lookup race covered (provider registered after engine
   row), isolate map unchanged since #116 while the row-set assertion gains
   the new row; the durable `tool-workflow/agent-start` records assert
   provider arrival index == worker `seq` for every member (live and replayed);
   `smoke:profile-boot` + composition tests green.
4. Manifest: `engine.workflow` deviations list updated — same-session replay
   implemented; residual: cross-session replay; footnotes recorded: our
   cache keying ({prompt, outputSchema, agentOptions}) is intentionally
   stricter than CC's prompt-only keying (an engine-row model edit between
   runs correctly forces a full re-run, where CC would have hit); durable
   descriptors and `subagent/start` identity name `cc-workflow-journal` as the
   provider; the additive `cached` field extends the durable record shape;
   docs:parity regenerated.
5. Dogfood: run a 5-agent script, edit one middle prompt, resume via
   `resumeFromRunId`, verify the first two agents return instantly from cache
   and the suffix re-runs; record agent counts (agentsStarted delta) in the PR.
