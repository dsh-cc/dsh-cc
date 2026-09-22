# Workflow resume journal: a wrapping subagent provider with frozen-until-first-miss replay

Date: 2026-09-22. Status: **Proposed**. Origin: dynamic-workflow three-way
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

## 2. Current state (harness anchors verified 2026-09-22)

- **A provider wrapper is a supported move.** `ctx.subagents.registerProvider`
  accepts external providers and only rejects duplicate names
  (`packages/subagent/subagent/src/index.ts:509-527`); `getProvider(name)` is
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
  capability-bearing field before delegating (`subagent/src/index.ts:639-658`).
  The returned `SubagentRun` (`types.ts:308`) is `{id: SessionId,
  localAgent?, result: Promise<SubagentResult>, dispose()}`; child failure
  resolves (never rejects) with `stopReason: 'error'`; infrastructure failure
  rejects.
- **What the workflow engine passes to the provider** — exactly
  `{prompt: ContentBlock[], parent, signal, outputSchema?, agentOptions?
  {provider, model}}` (`packages/workflow/workflow-worker-thread/src/host.ts:353-367`).
  The `signal` is a **per-run derived controller** (`host.ts:129`; the caller's
  signal only fans into it via `host.ts:160-170`). Worker-side `seq` is a
  monotonically increasing counter (`runtime.ts:264`) but reaches only the
  emitted `WorkflowAgentInfo` events (`runtime.ts:299`) — **not** the provider.
  `label`/`phase` likewise stay worker-side.
- **Failure mapping at the engine**: provider `start` rejection → fatal
  `WorkflowError('AGENT_START')` that kills the whole script
  (`runtime.ts:285-291`); a published child settling non-completed → `agent()`
  resolves `null` (`runtime.ts:333-338`).
- **Message-order chain**: worker-side `agent()` → `acquireSlot()` (a microtask
  hop — the only reorder vector in the chain) → MessagePort post → host
  `onMessage` → `startChild`. MessagePort delivery is FIFO, so provider arrival
  order equals slot-acquisition order; under free slots the microtask queue is
  FIFO in practice and under contention the waiter queue preserves order. This
  makes arrival order CC's "order agents started" in the only sense that
  matters here, and — the load-bearing property — the original and resumed runs
  traverse the *same* scheduling, so arrival-index comparison is
  self-consistent even if it ever diverges from a hypothetical absolute
  ordering. Asserted empirically in the spike (§DoD).
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
`config.provider` switches to `cc-workflow-journal` in this slice; both rows
stay in the `delegation` isolate group; the new row joins the same group and the
group isolate map gains the `ccWorkflowRunRegistry` key — `smoke:profile-boot`
and the composition test's "exactly these services" assertion are updated
together (both are the only gates that catch realm/set-list drift).

The wrapper mirrors the base provider's `capabilities` and
`inheritsParentContext` from the delegated instance at first use (lazy
`getProvider('spawn')`), passes every request field through untouched, and adds
only journaling behavior.

### 3.2 Run attribution via signal identity

Each run has exactly one derived `AbortSignal` (`host.ts:129`), and every child
of that run carries it. The provider keys a `WeakMap<AbortSignal, JournalRun>`
on the signal: first `start` with an unseen signal claims the registry's
**pending-claim** slot (the core tool, which owns `engine.start`, deposits
`{runId, journalPath, resumeOf}` there immediately after a successful start and
before returning the async receipt; it also retains `signal` reference equality
as the handshake's correctness anchor). Because the core slice enforces a single
active run per session, claim ambiguity cannot arise in v1; the provider refuses
a `start` carrying an unknown signal while no pending claim exists (loud
`AGENT_START` — an impossible-by-construction state, so loudness is correct).

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

Path: `<dshHome>/workflows/runs/<runId>.jsonl` (dsh-home per the dual-home
convention; chosen outside the session directory so a later cross-session slice
can adopt it without migration, while this slice only resumes same-session
runIds present in the registry).

One JSON line per settled child, written at settle time, sequence-complete (a
line is appended only when seq n's result exists):

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
- `result` is the `SubagentResult` content (`structured` when a schema was in
  force, else `output`), persisted verbatim.
- Writes are atomic (tmp+rename per append batch) under the established
  pin-store discipline; corruption of any line fails the whole journal's
  replayability for that run (fail-open to live execution, §3.4). One tolerance:
  a trailing unparseable *last* line (crash mid-append, made near-impossible by
  tmp+rename) is dropped at load rather than poisoning the journal.
- Size guard: a run journal exceeding a configurable byte cap (default 8 MiB)
  stops recording further cacheable lines (later seqs simply re-run on resume);
  the run itself is unaffected. Artifact pressure is bounded by the engine's own
  `maxTotalAgents` cap and per-result text sizes.
- Retention: journals exist to serve same-session resume, and cross-session
  replay is out of scope, so a journal for a run no longer present in the
  session registry is dead weight — context disposal deletes the session's
  journals, and startup sweeps stale ones (same ownership rule as the
  dual-home state discipline: write-owned directory, never user data).

### 3.4 Replay: frozen-until-first-miss

On `resumeFromRunId` the core tool re-enters `engine.start` with the *current*
script text (the caller may have edited it) plus `resumeOf`/`resumeJournalPath`
in the pending-claim deposit. The provider then resolves each incoming child in
arrival order:

- **While unfrozen** (no miss yet): compare the child's request hash with the
  old journal line at the same arrival index. Match → **do not spawn**; return a
  fabricated `SubagentRun` whose `result` resolves to the stored result and
  whose `dispose()` is a no-op (recorded via agent-start/agent-end events with
  `outcome: 'cached'` so the session log shows replay provenance). Mismatch on
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
  the spawn). Timeline consumers observe an instant hit pair; the
  `outcome: 'cached'` extension marks replayed rows.

The resume API on the tool: `resumeFromRunId` requires a runId known to the
same-session registry (else structured refusal listing known runIds); the new
run's `taskId`/`runId` is fresh, and its event stream records `resumeOf` on
`run-start`.

### 3.5 Interplay with the core slice's constraints

- Single active run per session keeps §3.2 sound and also means the old run
  being resumed is settled by construction (registry only accepts resume of
  non-active runs).
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
   settle-time journal cleanup deletes the session's journals and the startup
   sweep removes stale ones.
3. Composition: engine row on `cc-workflow-journal`, ordinary `Task` spawns
   unjournaled, delegate lookup race covered (provider registered after engine
   row), `smoke:profile-boot` + composition tests green.
4. Manifest: `engine.workflow` deviations list updated — same-session replay
   implemented; residual: cross-session replay; footnote recorded that our
   cache keying ({prompt, outputSchema, agentOptions}) is intentionally
   stricter than CC's prompt-only keying (an engine-row model edit between
   runs correctly forces a full re-run, where CC would have hit);
   docs:parity regenerated.
5. Dogfood: run a 5-agent script, edit one middle prompt, resume via
   `resumeFromRunId`, verify the first two agents return instantly from cache
   and the suffix re-runs; record agent counts (agentsStarted delta) in the PR.
