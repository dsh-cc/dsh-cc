# Subagent release valve: model-facing `release_agent` + `/agents release`

Status: **Approved — seven-round blind-review arc closed (critic & grok seats convergent; grok scored GO at round 7; critic pre-authorized GO upon the two r7 folds, both landed; codex seat: full findings through r3 (incl. its verified critical), interrupted twice (bridge crash signature) and quota-windowed once, then reduced by explicit user decision). Implementation per §7.**

(Draft history: v1 `.scratch/design-subagent-release-valve-v1.md` · v2
`.scratch/design-subagent-release-valve-v2-reviewed.md` · v3
`.scratch/design-v3-snapshot-pre-v4.md` · v4
`.scratch/design-v4-snapshot-pre-v5.md`.)

## 1. Problem

`subagent_fork` refuses new background starts once a parent session accumulates
25 "live" continuable children:

```
parent has 25 live subagents; /agents stop <id> to release one, or let children settle
```

(`packages/subagent/task/src/background-start.ts:35,200-223`,
`MAX_LIVE_CONTINUABLE_CHILDREN = 25`; design origin
`docs/plans/2026-09-05-continuable-background-ux.md` §3.6.)

Two compounding defects make this cap a dead end in long-running sessions
(observed in production 2026-09-25 / 2026-09-29):

1. **No reachable release path.** The only mechanism that frees a slot is the
   harness `SubagentRuntime.drainContinuableChildren(parent, childIds)` seam
   (harness `packages/subagent/subagent/src/index.ts:359`). dsh-cc reaches it
   only from tests (`packages/subagent/task/tests/integration.spec.ts:354`).
2. **The error copy points at a command that cannot release.** `/agents stop`
   only interrupts a running turn ("it stays resumable" —
   `packages/interaction/command-agents/src/snapshot.ts:265-272`).

There is currently **no in-session relief whatsoever**.

## 2. Verified current-state facts (anchors)

(Fact labels F1–F16 here are distinct from review-seat findings, cited in §8
with seat prefixes: `critic F#`, `grok #`, `codex #`.)

Residency model (`command-agents/src/snapshot.ts:111-122`; harness
`AgentStatus = 'idle' | 'running'`, `core/agent/src/runtime-types.ts:109`):

- F3a. `running` — live activation, status `'running'` — **holds a guard slot**.
- F3b. `idle` — live activation, status `'idle'` — holds NO guard slot.
- F3c. `ready` — no live activation; the durable catalog row persists.

F1. **Cap location and counting.** `assertLiveCapacity` counts
    `listChildren(parent.id)` entries whose registry status is `'running'`, NO
    mode filter (`background-start.ts:205-216`) — running ONE-SHOT children
    count and are invisible to `list_agents` (harness `list-agents.ts:69-71`).
    Only a `listChildren` throw is swallowed; registry access propagates.
F2. **Healthy children free themselves; stuck ones don't.** Natural settle
    evicts the activation and cold resume works (integration pins §4.10/§4.12,
    `tests/integration.spec.ts:287,296-341`). Cap growth comes from turns that
    never settle (F6 class). Failed starts are NOT residue:
    `continuation-activation.ts:496-502,685-694` roll back and remove them.
F4. **The seam: selective among siblings, evicts the whole resident subtree,
    cooperative-only, may reject after evicting.**
    `drainContinuableChildren`: exact-live-parent identity check before any
    dispose (`UNAUTHORIZED`; the two distinct messages
    `'selected child teardown requires the exact live parent agent'` (stale
    handle) vs `'subagent "<id>" is not a direct child of agent "<parent>"'`
    (lineage) at `continuation-activation.ts:420/:428` — verified
    non-overlapping match keys); skips non-resident targets (`:425`);
    recursively disposes resident `ownedChildren` first (`:808-829`; pin
    `continuation.spec.ts:1787-1798`); preserves the persisted session.
    **Critical limiting truth (codex r3 #1, verified):** the non-flushed
    disposal path is `cancel()` → `await idle (whenIdle())` →
    `resident.delete` (`:808,830,862`) — an **unbounded** wait: a
    cancel-resistant turn (the F6 population) blocks the drain forever and
    keeps its slot. No upstream force-disposal primitive exists.
    Teardown failure rejects with `ACTIVATION_TEARDOWN_FAILED` AFTER
    `resident.delete` (`:862` precedes `:867`; pin
    `continuation.spec.ts:1810-1828`) — the ONLY rejection class with
    degraded-success evidence.
    **Causation rule (round-4 fold, replaces the v4 stopReason
    discriminator):** stopReason cannot witness causation — an idle child
    drained via this seam emits `subagent/end` with `'completed'` (idle cancel
    clears the inbox and captures a clean epoch; harness
    `packages/core/agent-loop/src/agent.ts:174-181` (the inbox clear is at
    :176), `lifecycle.ts:237-262`, `:192-194`), and a self-terminal child emits its
    own reason even when the drain owned the eviction (recorded failure beats
    cancellation, `lifecycle.ts:230-234`). The adopted rule: **registry hit at
    pre-read + drain resolved + post absent ⇒ released**. The residual race is
    NOT a pre-read gap: the pre-read through the drain's own `resident.get` is
    synchronous end to end (`drainChildren` at `:424` runs before the first
    await), so that window is empty. The real residual is the **join**:
    `watchSettlement` may already be inside `dispose(activation,
    /*finalStateFlushed*/ true)` (`:753,797-800`) when the drain lands;
    `inbox.close` memoizes (`inbox.ts:62-74`), so the drain awaits the same
    memoized natural disposal, resolves with it, and the post-read is absent.
    Window = one `handle.dispose` duration (`:842` → `:862`) — milliseconds.
    A child caught mid-natural-settlement then wears the released label (and
    its F5 continuation claim) although F2 cold-resume would have worked for
    it: an accepted mislabel, disclosed here and in §5.
F5. **Post-drain continuation: same-session BROKEN (pinned), cross-session
    UNVERIFIED.** Same-session `sendMessage` after a drain resolves but runs
    no model turn (skipped pin `tests/integration.spec.ts:386-400`, re-probed
    at 0.1.2/0.1.5/0.1.7-rc.2). Natural-settle cold resume works (F2).
    Cross-session: Slice-0 probe attempt recorded in §8 (fixture-limited,
    inconclusive) — copy never promises it.
F6. **Interrupt is neither a release nor a guaranteed eviction** — accepted
    cancel sometimes leaves the child `running` indefinitely
    (`tests/integration.spec.ts:215-225`).
F7. **Control tools live in the harness**; dsh-cc must not shadow their names.
F8. **Surface contracts.** `defineTool` handlers get `(args, exec)` with
    `exec.agent`/`exec.signal`; output-schema/render/`isConcurrencySafe` idiom
    at `tool.ts:221-237`. `CommandInvocation.signal` exists at
    `interaction/commands/src/index.ts:56-57`. The TUI driver reaches the
    registry via the `rt.ctx.agents` PROPERTY
    (`packages/ui/tui/src/harness/driver-agents.ts:89`) and has no invocation
    signal. The harness drain takes NO signal (`subagent/src/index.ts:359-363`)
    — once issued it cannot be cancelled; caller cancellation is honored only
    before issuance.
F9. **All `/agents` surfaces.** Host `command-agents/src/index.ts`;
    grammar/copies `snapshot.ts`; TUI `harness/driver-agents.ts:130-151`
    (fold fallback synthesizes rows incl. one-shots — release never authorizes
    from it); autocomplete `packages/ui/tui/src/slash.ts`; `/tui-help`
    `packages/ui/tui/src/slash-help.ts`.
F10. **Manifest/docs discipline.** Validator invariants (I3/I4/I7) named in
    `scripts/check-capability-evidence.mjs`'s header, exercised in its
    `*.test.mjs` (the labels are not grep-able in the script itself).
    `pnpm docs:parity` regenerates THREE artifacts (root `README.md`,
    `docs/cc-parity-matrix.md`, `docs/claude-code-capabilities.json`). README
    hash gate: `node scripts/check-readme.mjs --write` DIRECT (pnpm never
    forwards the flag). Tool-row template: the `engine.subagent-handoff` row of
    `docs/claude-code-capabilities.yaml` (:872-903). Evidence objects are
    `{ type, path, anchor? }`, never shorthand. All D6 line citations refer to
    `docs/claude-code-capabilities.yaml`.
F11. **Harness `maxActiveSubagents` defaults to 8** (`subagent/src/index.ts:
    194-203`), never overridden by dsh-cc — capacity proof is unit-seam (T16).
F12. **A drain emits its settlement account DURING the call**
    (`notifySettlement` :864, `observer.settle` :866 precede the drain's own
    resolution). Consequences: (a) an armed first-epoch collect resolves
    DURING the drain — the releasing mark lands BEFORE issuance so the
    collect's copy gate sees it (D1/D3); (b) a finish wake may arrive after
    release — inert (accepted assumption: process-wide `subagent/end`
    listeners unrelated to release are keyed by runId/child state and see a
    normal terminal edge; the fold pins OUR surfaces' behavior at T13b/T18 and
    records the assumption for the rest).
F13. **Catalog establishment has a transient window**
    (`establishCatalogChild` after materialization, `continuation.ts:161-185`).
F14. **Released state is not representable upstream.** Catalog rows survive a
    drain and read `ready`; released rows need OUR process-local marker; after
    a process restart the marker is gone.
F15. **Thrown normalization:** every `<failure>`/`<cause>` interpolation is
    `error instanceof Error ? error.message : String(error)`; an absent catalog
    `mode` renders the literal `unknown`.
F16. **Mount precedent:** `apply()` invokes `registerTaskTool(...)` and DROPS
    its disposer (`task/src/index.ts:199`) — registrations live with the tools
    seam's context lifetime; `registerReleaseAgentTool(ctx)` mirrors that and
    returns `undefined` when the tools seam is absent (`tool.ts:148-149`).

## 3. Goals / non-goals

G1 model-reachable `release_agent`. G2 identical release on `/agents release
<id>` (host+TUI) via ONE shared operation/copy set. G3 guard copy naming the
real path + running-only slots + the releasable population. G4 copy honesty:
outcome-derived claims; subtree eviction disclosed; released marking exactly
when supportable; the cooperative-only nature of eviction disclosed.

N1 no cap tuning. N2 no auto-release-on-settle (harness does it). N3 no
upstream fixes — the future proposal list now carries BOTH cold-resume-after-
drain (F5) and a bounded force-disposal primitive (F4's unbounded idle wait);
harness stays read-only. N4 no authorization bypass. N5 one-shot slot
occupants are not releasable (disclosed in copy); changing the guard's mode
counting is a separate-reviewed follow-up.

## 4. Design

### D1. Shared release operation (single source of truth)

New module `packages/interaction/command-agents/src/release.ts`; exported via
a new `./release` entry in `command-agents/package.json` (mirroring
`./snapshot`) plus a `tsconfig.base.json` alias
`"@dsh-cc/command-agents/release":
["./packages/interaction/command-agents/src/release.ts"]` beside the
`./snapshot` alias (:260-262). The task package gains
`@dsh-cc/command-agents` in BOTH `dependencies` and `devDependencies`, plus a
`tsconfig` project reference `{ "path": "../../interaction/command-agents" }`.

```ts
export interface ReleaseSubagentsLike {
  listChildren?(parentSessionId: SessionId, signal?: AbortSignal):
    Promise<readonly { id: string; mode?: string }[]>   // readonly rows — host duck compat
  drainContinuableChildren?(parent: Agent, ids: SessionId[]): Promise<void>
}
export interface ReleaseRegistryLike {
  get(id: string): { status?: 'idle' | 'running' | string } | undefined
}

type PreStatus = 'running' | 'idle' | 'unknown'
type CatalogNote = 'catalog' | 'registry-only' | 'catalog-unreadable'

export type ReleaseOutcome =
  | { kind: 'released'; id: string; preStatus: PreStatus; catalogNote: CatalogNote;
      cause?: string /* present iff catalogNote === 'catalog-unreadable' */ }
  | { kind: 'issued-unobservable'; id: string; catalogNote: 'catalog' }
  | { kind: 'evicted-degraded'; id: string; failure: string; catalogNote: CatalogNote;
      cause?: string /* present iff catalogNote === 'catalog-unreadable' */ }
  | { kind: 'not-resident'; id: string; releasedEarlier: boolean }
  | { kind: 'still-resident'; id: string; drainPending: boolean }

export type ReleaseFailureReason =
  | 'unknown-id' | 'not-continuable' | 'no-drain-seam'
  | 'catalog-unreadable' | 'not-direct-child' | 'stale-parent'
export class ReleaseFailure extends Error {
  constructor(readonly reason: ReleaseFailureReason, message: string) {
    super(message) // message IS the final §5 copy
  }
}

export const DRAIN_OBSERVE_TIMEOUT_MS = 10_000

export async function runRelease(deps: {
  parent: Agent
  id: string
  subagents: ReleaseSubagentsLike | undefined
  agents: ReleaseRegistryLike | undefined
  signal?: AbortSignal   // absent → fresh never-aborted controller
}): Promise<ReleaseOutcome>

export function renderReleaseOutcome(outcome: ReleaseOutcome): string

// Process-local markers (F14) — TWO sets: `releasing` and `released`.
// markReleasing(id) adds releasing-membership AFTER the final throwIfAborted
// and BEFORE drain issuance (F12a). markReleased(id) moves the id
// releasing → released (removes releasing membership).
// clearReleasing(id) removes releasing membership ONLY and is refused while
// the id is released (a no-op then) — the invariant that makes a concurrent
// retry's mark clobber-proof against a stale attempt's late handlers
// (critic r5 #3). The timeout arm KEEPS the releasing mark and attaches a
// late completion continuation (step 5). Snapshot tagging rule:
// (isReleased(id) || isReleasing(id)) && registry-absent-at-snapshot-time —
// never from the marker alone.
export function markReleasing(id: string): void
export function markReleased(id: string): void
export function clearReleasing(id: string): void
export function isReleased(id: string): boolean
export function isReleasing(id: string): boolean
export function resetReleasedMarkers(): void  // test-only; clears BOTH sets
```

Marker-state totality: every terminal leaves {releasing, released} in exactly
one documented state — released-marked: `released`, `evicted-degraded`
(including its late-continuation variant), and `not-resident {
releasedEarlier: true }` (the pre-existing mark persists — grok r6 #5);
releasing-marked: `still-resident` with `drainPending: true` (until the late
continuation settles it); UNMARKED (both sets clear): every gate error,
`not-resident` WITHOUT an earlier mark, `still-resident` with `drainPending:
false`, `issued-unobservable`, every propagated rejection.

Residency-derivation comment (critic C10): release.ts names the sibling sites
`snapshot.ts residencyOf` / `background-start.ts assertLiveCapacity`.

`runRelease` flow (gate errors before any marking/drain; every transition
test-pinned):

- Step 0: no `drainContinuableChildren` → `ReleaseFailure('no-drain-seam')`;
  `signal!.throwIfAborted()`.
- Step 1 catalog: `listChildren` missing → unreadable (cause `the subagents
  seam exposes no listChildren`); call THROWS: `signal.aborted` → rethrow the
  abort (cancellation is never catalog failure); else unreadable (F15 cause);
  success → clean rows.
- Step 2 registry (guarded): absent service or throwing `get` → `unobservable`;
  else `hit` (record `preStatus`, mapped to `'unknown'` when the status string
  is neither `running` nor `idle`) or `miss`.
- Step 3 mode gate (clean hit only): `row.mode !== 'continuable'` →
  `not-continuable` (`row.mode ?? 'unknown'`).
- Step 4 matrix:

  | catalog          | registry      | action |
  |------------------|---------------|--------|
  | hit continuable  | hit           | drain; note `catalog` |
  | hit continuable  | unobservable  | drain; note `catalog` |
  | hit continuable  | miss          | `not-resident`; NO drain |
  | miss (clean)     | hit           | drain; note `registry-only` |
  | miss (clean)     | miss          | `unknown-id`; NO drain |
  | miss (clean)     | unobservable  | `unknown-id`; NO drain |
  | unreadable       | hit           | drain; note `catalog-unreadable` |
  | unreadable       | miss          | `catalog-unreadable(cause)`; NO drain |
  | unreadable       | unobservable  | `catalog-unreadable(cause)`; NO drain |

- Step 5 drain rows only: `signal!.throwIfAborted()` FIRST (the last honored
  cancellation point — critic r5 #1: an abort must never orphan a releasing
  mark on an unissued drain); then `markReleasing(id)`; then issue
  `drain = subagents.drainContinuableChildren(parent, [SessionId(id)])`,
  raced against `DRAIN_OBSERVE_TIMEOUT_MS` (the race's timer is cleared on
  BOTH the resolve and reject arms — grok r5 #6: a leftover rejecting timer
  is an unhandled rejection on the happy path):
  - **rejects** message-matched `'not a direct child'` → clearReleasing;
    `ReleaseFailure('not-direct-child')`.
  - **rejects** message-matched `'exact live parent'` → clearReleasing;
    `ReleaseFailure('stale-parent')`.
  - **rejects** `code === 'ACTIVATION_TEARDOWN_FAILED'` → guarded post-read:
    absent OR unobservable → `markReleased`; `evicted-degraded` (F4's
    code-order pin); still present → clearReleasing, rethrow.
  - **rejects** anything else → clearReleasing; rethrow verbatim.
  - **times out** → KEEP the releasing mark and attach
    `void drain.then(onLateResolve, onLateReject)` where BOTH callbacks are
    total (every guarded read inside them is try/catch-wrapped; they never
    throw — no unhandled rejection is ever possible from the orphan):
    `onLateResolve` = guarded read → absent ⇒ `markReleased` (the tag becomes
    visible; the collect gate stays armed throughout); present ⇒
    clearReleasing; unobservable ⇒ KEEP the releasing mark — a NO-OP, never a
    re-insert (the id may already sit in `released` courtesy of a concurrent
    retry — critic r6 #4 / grok r6 #6); `onLateReject` = code `ACTIVATION_TEARDOWN_FAILED` ⇒ the same
    delete-before-throw evidence as the sync arm (guarded read →
    absent/unobservable ⇒ `markReleased`); any other late rejection ⇒
    clearReleasing; either way swallowed. Outcome now: `still-resident
    { drainPending: true }`.
  - **resolves** → guarded post-read, polled bounded (10 × 200 ms real timers
    while it reads present):
    - still present past the budget → clearReleasing; `still-resident
      { drainPending: false }`.
    - `unobservable` AT PRE-READ (registry never worked end to end —
      possible only on the catalog-hit row) → clearReleasing;
      `issued-unobservable` (no mark, no slot claim).
    - post-read THROWING after a resolved drain whose pre-read was a HIT
      (observability died mid-flight — grok r6 #3) → `markReleased`;
      `released` with the preStatus captured at pre-read (eviction evidence:
      issuance + resolution; the tag's render degrades per the §5
      contradictions entry).
    - absent (pre-read was a HIT) → `markReleased`; `released` (F4's
      causation rule; a HIT whose status string was neither `running` nor
      `idle` yields the unknown-preStatus variant).

### D2. Tool surface: `release_agent`

`packages/subagent/task/src/release-agent.ts`:
`export const RELEASE_AGENT_TOOL = 'release_agent'`;
`export function registerReleaseAgentTool(ctx: Context): (() => void) | undefined`
(missing tools seam → undefined, F16). Mounted beside the
`registerTaskTool` call in `task/src/index.ts` `apply()`, return dropped
(precedent, F16).

`defineTool` (mirror `tool.ts:221-237`):
- parameters: `agent_id: { type: 'string', required: true, description:
  'Id of a direct continuable child of this session (see list_agents). Grandchildren are refused — release their direct parent instead.' }`
- output `{ type: 'object', additionalProperties: false, properties: { text:
  { type: 'string', required: true } } }`, render = one text block.
- `isConcurrencySafe: () => true` (double-release converges to
  releasing/not-resident).
- execute: guard `exec.agent` (`release_agent requires a calling agent
  (exec.agent was undefined)`); `subagents = ctx.get('subagents')`;
  `agents = parent.ctx?.get?.('agents') as ReleaseRegistryLike | undefined`;
  `signal: exec.signal`; runRelease; success → `{ text:
  renderReleaseOutcome(outcome) }`; errors propagate (`ReleaseFailure.message`
  is the copy).

Tool description (verbatim):

> Release a direct continuable subagent: its resident activation is evicted,
> and with it the resident activations of any descendants (a running turn is
> aborted; no separate interrupt needed). Eviction is cooperative — a turn that
> refuses cancellation keeps its slot until it settles (this tool reports that
> as still-resident with the release still in flight instead of hanging). A
> slot toward the 25-child capacity guard is freed only when the agent was
> running; idle agents hold no slot but are still evicted (one-way); an
> already-settled agent is a harmless no-op. The persisted session survives on
> disk. Within THIS session a released agent cannot be continued:
> `send_message` resolves but runs no turn (a known upstream
> cold-resume-after-drain gap); continuation from a future session is not
> currently verified. `list_agents` and `/agents` still list a released agent
> (the durable catalog is retained); `/agents` marks it [released] for the
> rest of this process.

### D3. `/agents release <id>` — host command + TUI local slash

Grammar (`snapshot.ts`): `ParsedAgentsInput` gains `{ kind: 'release'; id:
string }`; bare `release` → `Usage: /agents release <id>`.

Snapshot state/copies:
- `AgentRow` gains `released?: boolean`; `SnapshotServices` gains optional
  `isReleased?: (id: string) => boolean` AND `isReleasing?: (id: string) =>
  boolean`; `toSnapshotServices` wires both; tagging rule:
  `(isReleased(id) || isReleasing(id)) && registry-absent-at-snapshot-time`
  (the row's residency is `'ready'`).
- List: tagged rows carry `[released]` in Ready. Detail: `released: this
  process — resident activation evicted or release in flight; same-session
  continuation unavailable (upstream gap)`, emitted BEFORE the pin
  early-return (`snapshot.ts:226-228`).
- `stopReleasedCopy`: `Agent <id> was released (or its release is in flight)
  in this process; it cannot be continued here — nothing to stop.`

Host command (`command-agents/src/index.ts`):
- Local `SubagentsLike` gains `drainContinuableChildren?(parent, ids)`.
- `executeAgents` gains the registry parameter (threaded from `apply()`'s
  `:113` resolve, not re-resolved).
- The release branch runs BEFORE `rows.find` / any snapshot fast path:
  `runRelease({ parent: invocation.agent, id, subagents, agents, signal:
  invocation.signal })`. `ReleaseFailure` → `{ kind: 'error', text:
  failure.message }`; outcome → `{ kind: 'success', text:
  renderReleaseOutcome(outcome) }`.
- helpable: description `list, inspect, stop, or release continuable
  background agents`; new subcommand `{ word: 'release', args: '<id>',
  summary: 'Evict an agent\'s resident activation (and resident descendants\'), freeing its capacity slot when it was running; cooperative; one-way in this session' }`; stop summary `'Interrupt a running agent\'s current turn (the activation stays resident; "/agents release <id>" evicts it)'`.

TUI (`packages/ui/tui/src/harness/driver-agents.ts`):
- Order: after parse, the release branch runs BEFORE `agentsRows()`.
  `ccAgents` absent → the §5 release-unavailable copy (one comment sentence
  noting the fold's one-shot listing stays out of scope).
- Call: `runRelease({ parent: rt.current.agent, id, subagents:
  rt.ctx.get('subagents'), agents: rt.ctx.agents /* property per F8 */ })`;
  signal omitted → internal controller.
- `slash.ts`: description `List, inspect, stop, or release background
  agents`, `argumentHint: '[<id>|stop <id>|release <id>]'`.
- `slash-help.ts` agents: usage `['[<id>|stop <id>|release <id>]', '(no
  argument — list background agents)']` + note `'release <id> evicts the
  resident activation (its resident descendants\' too); frees a capacity slot
  for running agents; cooperative; one-way in this session.'`.

Foreground-collect cross-copy (`background-start.ts` `stopReasonMessage`
`aborted` branch): when `isReleased(childId) || isReleasing(childId)` →
`subagent <id> was released (or its release was in flight) while it was being
collected; it cannot be continued in this session.` (armed from the
pre-issuance mark, F12a.)

Stop-copy gates at the in-flight boundary (critic r6 #3, made fully symmetric
per critic r7 #1): BOTH stop branches (host `executeAgents` and TUI
`driver-agents.ts`) render `stopReleasedCopy` instead of `stopRunningCopy` when
the row's id `isReleasing` — a drain-pending child must not read "stays
resumable" — and BOTH branches render `stopReleasedCopy` for a Ready row whose
`released` tag is set, placed BEFORE the `stopNotRunningCopy` early-return
(host `index.ts:86-88`; TUI `driver-agents.ts:137-138`; grok r6 #4). T-pins:
T20 (host matrix) + T25b-tui.

### D4. Capacity-guard error copy fix (`background-start.ts:218-221`)

Verbatim (wraps doc-only — the runtime value is ONE single-line string; T16's
full-equality pin exists against exactly that literal, grok r6 #8), the file is
`packages/subagent/task/src/background-start.ts`:

```
parent has 25 live subagents; free a slot with release_agent on a running child
(or /agents release <id> interactively), or let children settle — only running
children hold slots, and only list_agents-visible children are releasable
```

### D5. System-prompt guidance block (`task/src/index.ts` ~:128-144)

(a) Session-exit bullet QUALIFIED (Slice-0 probe was fixture-limited —
recorded §8; the conservative variant ships), verbatim replacement:

> `- Exiting your session drains every background child's in-flight turn (whole-forest teardown); its persisted session survives on disk — a child that settled on its own stays cold-resumable, but a DRAINED child does not resume on the next send_message (known upstream gap; cross-session resume after a drain is unverified).`

(b) Append verbatim:

> `- A background child holds one of 25 live-child capacity slots while it is running; settled children free theirs automatically. release_agent <id> evicts a stuck running child's resident activation (and its resident descendants') one-way: same-session continuation is unavailable after release; its persisted session survives; eviction is cooperative — a cancel-resistant turn keeps its slot until it settles. Use it on stuck children you can discard, not as routine cleanup.`

(`BACKGROUND_SECTION_TEXT` pins in `tool.spec.ts` cover both bullets.)

### D6. Capability manifest + generated docs + READMEs

All three edits are in `docs/claude-code-capabilities.yaml`:

1. `subagents.task-tool` (row at :2465): rewrite the capacity-guard paragraph
   (:2578-2583 — stale error string + “activity running” wording) to the
   registry-status derivation + release path.
2. NEW `subagents.release-tool` between `subagents.isolation` and
   `subagents.task-tool` (I7), mirroring `engine.subagent-handoff` (:872-903):
   title `Background subagent release valve (release_agent)`; category
   `subagents`; plane `preset`; upstream.summary "Not an upstream CC surface:
   a dsh-cc extension …"; `refs: []`; dimensions `recognized: true / mounted:
   true / behavioral: full / ux: full`; evidence as `{ type, path, anchor? }`:
   `{ type: source, path: packages/preset/cc/agent.cordis.yml, anchor: "- id:
   tool-task" }`, `{ type: source, path: packages/subagent/task/src/release-agent.ts }`,
   `{ type: source, path: packages/interaction/command-agents/src/release.ts }`,
   `{ type: test, path: packages/subagent/task/tests/release-agent.spec.ts }`,
   `{ type: test, path: packages/subagent/task/tests/integration.spec.ts }`,
   `{ type: test, path: packages/interaction/command-agents/tests/command-agents.spec.ts }`,
   `{ type: test, path: packages/ui/tui/tests/driver-subagent.spec.ts }`,
   `{ type: test, path: packages/bundle/cc-shell/tests/release-valve-composition.spec.ts }`;
   deviation.kind `divergent`, summary carrying running-only slots, F5's
   one-way gap, subtree eviction, cooperative-only eviction (drainPending),
   the process-local marker.
3. `commands.agents` (:1590): summary/deviation name `release`.

`pnpm docs:parity`; all three generated artifacts (`README.md`,
`docs/cc-parity-matrix.md`, `docs/claude-code-capabilities.json`) commit
together (F10).

README trios (README.md + README.zh.md + README.i18n.yaml hash records):
`packages/subagent/task`, `packages/interaction/command-agents`; TUI trio only
if its README enumerates `/agents` capabilities (executor checks). Re-record:
`node scripts/check-readme.mjs --write` (F10).

No new package, no settings keys, no env flags.

## 5. Copy contracts (verbatim; ONE renderer keyed by (kind, preStatus, catalogNote); every string full-equality-pinned)

`<id>`/`<mode>`/`<failure>`/`<cause>` interpolate per F15. Every
eviction-claiming string contains the descendant clause `Its resident
descendants (if any) were evicted with it. ` verbatim (DoD).

released (preStatus running):
`Released agent <id>: its in-flight turn was aborted and its resident activation evicted — the capacity slot it held is free. Its resident descendants (if any) were evicted with it. The persisted session survives on disk. Within this session it cannot be continued (send_message resolves but runs no turn — upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`

released (preStatus idle):
`Released agent <id>: its resident (idle) activation was evicted; it held no capacity slot (only running children count toward the 25-child guard). Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued (upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`

released (preStatus unknown):
`Released agent <id>: its resident activation was evicted; any capacity slot it held is free (its running state could not be observed). Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued (upstream cold-resume-after-drain gap); /agents marks it [released] for the rest of this process.`

Provenance prepend when catalogNote === 'registry-only':
`(Note: <id> was absent from the readable child catalog — released via the live registry only.) `

Provenance prepend when catalogNote === 'catalog-unreadable':
`(Note: the child catalog was unreadable (<cause>) — released via the live registry only.) `

issued-unobservable:
`Release of agent <id> was issued against the authoritative drain seam; this composition cannot observe the registry, so residency after the drain could not be confirmed and the child is NOT marked released. Eviction, when it applies, also covers resident descendants. If it was resident, the drain evicts it by the seam's own contract; its continuation state here is unknown.`

evicted-degraded (post-absent OR post-unobservable teardown failure — F4's
code-order pin justifies both):
`Release of agent <id> reported a teardown failure (<failure>), but the activation entry is removed before that failure surfaces per the seam's disposal order — any capacity slot is free. Its resident descendants (if any) were evicted with it. The persisted session survives on disk; within this session it cannot be continued; /agents marks it [released] for the rest of this process.`

not-resident:
`Agent <id> has no resident activation (settled or released); nothing was evicted and no capacity slot is held by it.`

not-resident (releasedEarlier):
`Agent <id> was released earlier in this process and has no resident activation; nothing was evicted.`

still-resident (drainPending false):
`Release of agent <id> was issued, but the registry still reports it resident after the drain; check /agents detail <id> and retry if it persists.`

still-resident (drainPending true):
`Release of agent <id> is in flight: its turn did not reach idle within 10s (a cancel-resistant turn). The release still completes by itself if the turn ever becomes idle — /agents then marks it [released] — but nothing locally force-evicts a cancel-resistant turn; a process restart is the only hard boundary.`

unknown-id (error):
`No agent <id> among this session's continuable children; use list_agents or /agents for current ids.`

not-continuable (error):
`Agent <id> is not a continuable child (mode: <mode>); release only covers continuable children.`

no-drain-seam (error):
`Cannot release <id>: this composition's subagents seam exposes no drainContinuableChildren; free capacity by letting children settle or by restarting the session.`

catalog-unreadable (error):
`Cannot verify <id> against this session's child catalog (<cause>); refusing to release blind. Retry, or restart the session if listing stays broken.`

not-direct-child (error):
`Agent <id> is not a direct child of this session (the drain seam refused with UNAUTHORIZED); release its direct parent instead — if that parent is one of this session's children. Releasing a parent evicts its whole resident subtree.`

stale-parent (error):
`This session's agent handle is stale (the drain seam refused with UNAUTHORIZED against the parent identity); retry the release, or restart the turn if it persists.`

TUI release-unavailable:
`Release needs the authoritative agents surface (ccAgents), which this composition does not publish; /agents release is unavailable here.`

Foreground-collect terminated (releasing OR released):
`subagent <id> was released (or its release was in flight) while it was being collected; it cannot be continued in this session.`

Declared contradictions (not fixed): upstream `list_agents` implies released
children accept send_message; after a process restart `/agents` Ready rows
lose the marker (F14); one-shot running children occupy slots and are not
releasable (N5); a child caught MID-natural-disposal by a drain wears the
released label although its own cold-resume would have worked (F4's join —
accepted mislabel, milliseconds-wide); in a composition whose registry is
unreadable, the `[released]` tag cannot render (tagging requires observed
registry absence) although the `evicted-degraded` text says it marks — the
marker is still recorded and the tag claim degrades to intent there
(critic r5 #5).

## 6. Tests

Unit fixture recipe: the `tool.spec.ts:1164-1177` pattern extended — parent
whose `ctx.get('agents')` answers a mutable fake registry; seam stub with
`withListChildren` + a recorded `drainContinuableChildren` (call log; optional
registry mutation; optional `{code,message}` rejection; optional
never-resolving-then-late-resolving promise for the timeout cases); real
200 ms poll timers; the 10 s timeout is paid ONCE by T13b;
`resetReleasedMarkers()` in beforeEach. **Every §5 variant is
`toEqual`-pinned (full string), never substring.**

`packages/subagent/task/tests/release-agent.spec.ts`:
- T1 clean catalog miss + registry miss → `unknown-id`; no drain.
- T2 `mode: 'one-shot'` → not-continuable (`mode: one-shot`); T2b mode absent
  → the literal `unknown`.
- T3 catalog hit continuable + registry miss → not-resident; no drain.
- T3b releasedEarlier full text; and a repeat release after `released` → same.
- T4 clean catalog miss + registry hit → released w/ registry-only prepend.
- T4b as T4 but reject message-matched not-direct → not-direct-child;
  cleared (not releasing, not released).
- T5 catalog hit + running → released running-variant full text; drain args
  `(exactParent, [SessionId(id)])`.
- T6 catalog hit + idle → released idle-variant full text (no discriminator
  preconditions — causation is positional per F4's rule).
- T6b registry HIT whose status string is neither `running` nor `idle`
  (e.g. `'paused'`) → released unknown-preStatus variant. (The
  pre-read-THROWS cell is `issued-unobservable`'s — T14a; the two cells are
  never merged — grok r5 #1.)
- T7 reject ACTIVATION_TEARDOWN_FAILED + post absent → evicted-degraded full
  text, marked; T7b + registry-only prepend on this kind (critic r3 F3
  second-kind pin); T7c post still present → rethrow, cleared (not releasing, not released).
- T8 reject unknown code → verbatim rethrow; cleared (not releasing, not released).
- T9 reject message-matched `'exact live parent'` → stale-parent; cleared (not releasing, not released).
- T10a listing throws (live signal) + registry hit → drain w/
  catalog-unreadable prepend; T10b listing throws + registry miss →
  catalog-unreadable error, no drain; T10c method absent + miss → error w/
  exposes-no-listChildren cause, no drain.
- T11 no drain seam → no-drain-seam.
- T12 `exec.agent` undefined → guard error.
- T13 resolved + still present past the poll budget → still-resident
  (drainPending false); cleared (not releasing, not released).
- T13b drain never resolves within 10 s → still-resident (drainPending true),
  marker STAYS releasing; then the leftover drain: (i) resolves with registry
  now absent → markReleased (tag on), no unhandled rejection; (ii) rejects
  late with `ACTIVATION_TEARDOWN_FAILED` + guarded absent → markReleased +
  swallowed (the sync arm's evidence reused — grok r5 #2); (iii) rejects late
  with an unknown code → clearReleasing + swallowed (no unhandled rejection);
  (iv) resolves with the registry unobservable at that late read → releasing
  mark KEPT (critic r5 #4); (v) late-reject clobber-proofing: attempt 1 times
  out, attempt 2 completes released, attempt 1's drain then rejects → the tag
  survives (critic r5 #3); (vi) late RESOLVE variants against the same retry
  shape: absent → markReleased is idempotent (tag stays), present →
  clearReleasing is refused (tag stays), unobservable → KEEP is a pure no-op
  (never a re-insert into releasing after markReleased) — critic r6 #4 /
  grok r6 #6.
- T13c pre-read HIT, drain resolves, post-read THROWS (observability dies
  mid-flight) → released (preStatus from the hit), full text — grok r6 #3.
- T14 registry face absent: T14a resolves → issued-unobservable full text,
  markers cleared (neither set); T14b rejects ACTIVATION_TEARDOWN_FAILED →
  evicted-degraded.
- T15 collect-gate ordering: an armed epoch-collect listener resolves DURING
  the drain (end emitted before it settles) and observes
  `isReleasing(id) === true` at that moment (the pre-issuance mark); T15b
  after a not-direct-child failure the gate is OFF (clearReleasing ran).
- T15d the join contract (critic r6 #1 / grok r6 #1): the drain seam's stub
  resolves immediately with the registry dropping the row and NO cancel/end
  signal of ours in play — the released (idle-variant) text STILL renders in
  full. Role: documents the accepted join mislabel as a CONTRACT (the outcome
  never depends on end-event or cancel evidence), not a classifier — the
  join-vs-fresh distinction is harness-internal by construction (F4).
- T16 (in `tool.spec.ts`, beside the capacity describe; its two copy
  assertions move to D4 text): 25 fake running rows → background start throws
  D4 copy; release one (fake drain drops the row) → next start admitted.
- T17 (in `tool.spec.ts`): an armed foreground collect whose child is marked
  releasing resolves the aborted branch with the released-specific copy.

`packages/subagent/task/tests/integration.spec.ts`:
- T18 background hang child → real `release_agent` → `waitNoActivation` →
  persisted session loads w/ interrupted prompt → released text; the child's
  settle account on the parent is tolerated present-or-absent (F12b).
- T18b natural-settled child → not-resident text.
- T18c NEW subtree pin: background parent child scripted to spawn its OWN
  background child (MockAdapter drives the grandchild spawn through the same
  tool stack; cross-agent FIFO ordering per MockAdapter discipline), then the
  parent idles with the grandchild running → `release_agent(parentId)` → both
  `waitNoActivation`s → released text incl. the descendant clause. (F4 subtree
  semantics re-pinned through OUR surface; the harness's own pin is
  `continuation.spec.ts:1787-1798`.)
- Cancel-resistant class NOT integration-tested (MockAdapter can't express a
  never-idle turn without faking disposal; covered by T13b) — recorded.
- The §4.13 skipped pin gains one comment line cross-referencing this valve.

`packages/bundle/cc-shell/tests/release-valve-composition.spec.ts` (NEW):
- T25 one Context carrying task plugin + command-agents with a fake seam:
  `release_agent` via `ctx.tools.execute` → `/agents` via
  `ctx.commands.execute` renders the row's `[released]` tag;
  `buildAgentsSnapshot` agrees (module-instance identity of the marker set —
  codex r3 #13).

`packages/interaction/command-agents/tests/command-agents.spec.ts`:
- T19 parse forms + bare-release usage + legacy forms unchanged.
- T20 execute matrix: unknown-id / not-resident / idle / running /
  no-drain-seam / not-continuable / not-direct-child / catalog-unreadable /
  issued-unobservable; `invocation.signal` reachability pinned twice: abort
  DURING the stubbed listChildren (no drain follows) AND abort at the
  pre-issuance checkpoint after a successful listing (critic r5 #1: no
  releasing mark is left behind and no drain is issued).
- T21 help renders the release row + amended stop summary.
- T22 tagging: `[released]` only when marker && residency ready; released
  detail line on an UNPINNED row; `stopReleasedCopy` on stop-of-released.

`packages/ui/tui/tests/driver-subagent.spec.ts`:
- T23 ccAgents published + stubbed listChildren/registry/drain → released
  copy; spy called with the driver's current agent and `[id]`; the branch ran
  without consulting snapshot rows (catalog-miss + registry-hit shape incl.).
- T24 ready row → not-resident; drain not called.
- T25-tui fold-only composition → release-unavailable text; fold listing
  unchanged.
- T25b-tui `/agents stop` boundary copies (critic r6 #3 + grok r6 #4): a Ready
  row WITH the released tag → `stopReleasedCopy` (before the
  `stopNotRunningCopy` early-return); a RUNNING row whose id isReleasing →
  `stopReleasedCopy` again (never "stays resumable" mid-drain).
- `slash.spec.ts` hint pin contains `release`; `/tui-help` agents text contains
  the release note.

## 7. Implementation plan (branch `worktree-subagent-release-valve`; two commits; one PR)

- **Slice 0 (orchestrator — DONE, recorded §8).**
- **Slice 1 (commit 1) — shared core + model valve:** `command-agents/src/
  release.ts`; `command-agents/package.json` `./release` export;
  `tsconfig.base.json` alias; `packages/subagent/task/tsconfig.json` project
  reference `{ "path": "../../interaction/command-agents" }`; task
  `package.json` BOTH dep entries; real `pnpm install`; `snapshot.ts`
  row/isReleased+isReleasing/tag/detail/stopReleasedCopy;
  `command-agents/src/index.ts` SubagentsLike+threading+branch(BEFORE
  rows.find)+helpable; `task/src/release-agent.ts`; `task/src/index.ts`
  mount (drop-return) + D5 bullets; `background-start.ts` D4 + the
  stopReasonMessage gate; T1–T18c + T25 + T19–T22 (shared-core owning slices
  may hold the command-side tests in commit 1 if it keeps the commit green);
  manifest edits 1–2 + `pnpm docs:parity`; README trios + hash re-record.
- **Slice 2 (commit 2) — human surface:** `harness/driver-agents.ts`;
  `slash.ts`; `slash-help.ts`; T23–T25-tui; manifest edit 3 +
  `pnpm docs:parity`; README re-record if changed.

Executors write files and run targeted vitest only; ALL git writes and the §9
battery are orchestrator-run.

Gate-risk note for Slice 1 (critic r6 #5): the `subagent/task →
interaction/command-agents` edge is a NEW inter-layer dependency with no
existing precedent under `packages/subagent/*` (verified: no such package.json
entry anywhere in that tree). `check:exports` / `check:deep-imports` /
`check:tui-boundary` behavior on it is unproven until the battery runs; a gate
red on this edge routes BACK to design review — never worked around ad hoc.

## 8. Review ledger

### Round 1 — critic REVISE(10) / grok REVISE(15) / codex REVISE(15), blind

40 findings, all folded into v2 (table in the v2 file).

### Round 2 — critic REVISE(8) / grok REVISE(16) / codex INTERRUPTED, on v2

- Codex lane: exit 101 + Rust stderr panic; printed verdict reprinted the
  round-1 text (pollution signature) — interrupted, re-seated in round 3.
- 24 findings folded into v3 (table in the v3 file); critic-vs-grok
  `CommandInvocation.signal` conflict adjudicated to grok by direct read of
  `commands/src/index.ts:56-57`.
- v3 ledger gap found by round 3 (critic F4 missing row) repaired in v4 AND
  here.

### Slice-0 spike — DONE between rounds 2 and 3

Throwaway spec (deleted): a second cordis Context cannot re-materialize a
parent onto an existing jsonl session id in this fixture (persistence
`findLog` → `encodeSegment(undefined)`). Per the pre-registered decision rule
all copy ships the conservative variant; D5(a) is qualified. The upstream
proposal's evidence pack is the existing F5 skipped pin + this record.

### Round 3 — critic REVISE(7) / grok REVISE(11) / codex NO-GO(13), on v3

(Table in the v4 file; headline: codex #1's unbounded `await idle` critical
VERIFIED (:830 precedes :862 delete); convergent high cluster on marker
timing/algebra totality/copy totality; all folded into v4's mechanisms (i)-(iii).)

### Round 4 — critic REVISE(6) / grok NO-GO(5) / codex INTERRUPTED, on v4

- **Codex lane INTERRUPTED a second time** — identical signature (exit 101 +
  Rust stderr panic; printed verdict was the round-3 text verbatim against v3
  anchors — stale-pollution, unconsumed). The seat re-runs on v5 (round 5);
  no verdict fabricated. Per lane discipline this was the interrupted round's
  first die; the v5 run is its single in-place recovery.
- **Cross-seat convergence (the two blockers are the same in both seats):**
  | finding | disposition |
  |---|---|
  | grok r4 #1 + critic r4 #2: the `aborted`-only stopReason discriminator misclassifies (idle drains emit `completed`; self-terminal children keep their own reason; causation unwitnessable at our layer) | ADOPTED with grok's replacement rule (registry-hit + resolved + post-absent ⇒ released; residual sub-tick ambiguity disclosed in F4) — the stopReason discriminator and the v4 `settled-or-released` outcome are REMOVED; T6/T15c re-shaped accordingly; T18c added as the real idle+subtree integration pin; F12's faulty `'aborted'` citation fixed (aborted comes from the child log via `epochStopReason`, not :192-194). |
  | grok r4 #2 + critic r4 #1: timeout unmarks and orphans the in-flight drain (late completion invisible; late reject unhandled; collect gate disarmed; the guard's own copy promise broken) | ADOPTED — timeout keeps the releasing mark; `void drain.then(...)` late continuation: resolve+absent ⇒ markReleased, late reject ⇒ unmark+swallow (no unhandled rejection); tagging rule `(isReleased \|\| isReleasing) && registry-absent`; T13b pins both late paths; T15 pins gate-visible-during-drain. |
  | grok r4 #3: "session restart is the only bounded escape" is false for the F6 class (exit teardown is the same cooperative drain) | ADOPTED — still-resident(drainPending) copy rewritten: nothing locally force-evicts; process restart is the only hard boundary. |
  | grok r4 #4: D6 line citations didn't name the yaml file | ADOPTED — D6 now names `docs/claude-code-capabilities.yaml` per item. |
  | grok r4 #5 + critic r4 #3: r3-table totality (missing rows: grok r3 #5, #7; critic r3 #1) | ADOPTED — this table now lists every r3 id; the three missing rows read here: grok r3 #5 (registry-get-throw ⇒ unobservable) and #7 (descendant/foreign UNAUTHORIZED mapping) and critic r3 #1 (missing r2-critic-F4 row + F#-label collision) were all ADOPTED in v4 (code/registry policy; not-direct-child/stale-parent split; ledger repair + §2 footnote) and had been dropped from the table itself — a pure ledger defect, fixed. |
  | critic r4 #4: T6 fixture precondition note | MOOTED by the causation-rule fold (T6 no longer needs an aborted end) — recorded. |
  | critic r4 #5: F8 cite off-by-one | ADOPTED — :56-57. |
  | critic r4 #6: late orphan-drain end reaching other process-wide listeners | ADOPTED AS DISCLOSURE — F12(b) carries the accepted assumption + its justification; our own surfaces' behavior is pinned by T13b/T18. |

### Round 5 — critic REVISE(6) / grok REVISE(6) / codex QUOTA-INTERRUPTED, on v5

- **Codex lane: quota window** ("usage limit … try again at 9:55 PM") — the
  printed verdict was again the round-3 text (pollution signature), so no
  r5 content was consumed at all. Per lane discipline, quota-class reruns need
  the user's explicit release; the seat's recovery decision is the open
  question routed to the user with the v6 fold (stay three-seat into round 6,
  or converge on critic+grok).
- Dispositions (all adopted; nothing contested between the two live seats —
  the round-5 class is marker/timer hygiene + one disclosure rewrite):

  | finding | disposition |
  |---|---|
  | critic r5 #1: markReleasing landed before the final throwIfAborted — an abort there orphans a releasing mark on an unissued drain | ADOPTED — step-5 order swapped (abort-check → mark → issue); T20 pins both cancellation points. |
  | critic r5 #2 / grok r5 #4 (convergent): the undisclosed **join** — a drain joins an in-flight natural disposal (inbox.close memoized), labeled released although F2 cold-resume would have worked | ADOPTED — F4's residual is rewritten from the (empty) microtask window to the real join window (`handle.dispose` duration); §5 contradictions gain the entry; T15d-style pin = release of a pre-closing child asserts the released text renders (documented accepted mislabel). |
  | critic r5 #3: a stale attempt's late reject clobbers a concurrent retry's released mark | ADOPTED — two-set markers; `clearReleasing` refuses while released; T13b(v) pins. |
  | critic r5 #4: the late-continuation unobservable terminal was unspecified | ADOPTED — keep the releasing mark (fail-open philosophy), T13b(iv). |
  | grok r5 #2: the late-reject arm blanket-unmarked even the delete-before-throw class | ADOPTED — onLateReject reuses the ACTIVATION_TEARDOWN_FAILED evidence path; T13b(ii)/(iii). |
  | grok r5 #1 (blocker): T6b required pre-throw+post-absent → released, contradicting the issued-unobservable rule | ADOPTED — T6b reshaped to a HIT with an unmapped status string (unknown-preStatus variant); thrown pre-reads stay issued-unobservable. |
  | grok r5 #3: the catalog-unreadable prepend interpolates <cause> the outcome objects never carried | ADOPTED — `cause?: string` on released/evicted-degraded, present iff catalogNote is catalog-unreadable. |
  | grok r5 #5: marker API totality (markReleased transition, late unmark rules) | ADOPTED — two-set semantics + the lifecycle's full terminal enumeration in D1. |
  | grok r5 #6: the race's observe timer never cleared on the happy path | ADOPTED — cleared on both settle arms (D1 step 5). |
  | critic r5 #5: evicted-degraded promises a tag that an unobservable-registry composition cannot render | ADOPTED AS DISCLOSURE — §5 contradictions entry. |
  | critic r5 #6: the r5 REVIEW BRIEF said "7 rows" for the round-4 table that actually has 8 | ADOPTED — bookkeeping-only; the mismatch lived in the brief, not the doc; briefs no longer carry row counts. |

### Round 6 — critic REVISE(6) / grok REVISE(8) / codex SEAT REDUCED (user decision), on v6

- **Codex seat reduced by explicit user decision** (the interim check-in:
  quota exhaustion + three interrupted/polluted runs in a row; the user's
  standing need is delivery). Roster from round 6 on: critic + grok. The codex
  r1–r3 findings remain folded (its critical lives on as F4/N3's upstream
  proposal item); the seat may be re-seated for the final document the user
  elects.
- Dispositions (convergent where the same defect surfaced twice):

  | finding | disposition |
  |---|---|
  | critic r6 #1 / grok r6 #1 (convergent): the r5 fold's JOIN pin (T15d) existed only as a ledger sentence; §6 had no such test, and a naive pin would not distinguish join from fresh-cancel | ADOPTED — §6 gains T15d as a CONTRACT pin: accepted-mislabel documentation (the outcome never depends on end-event/cancel evidence); the harness-internal distinction is undisclosed-to-us by construction (F4). The seat wording fixes land alongside. |
  | critic r6 #2 / grok r6 #7 (convergent): F4's bare `agent.ts` cite | ADOPTED — `agent-loop/src/agent.ts:174-181` (harness path prefix). |
  | critic r6 #3: stop/collect copy overclaims at the resident-during-release boundary | ADOPTED — both stop branches gate on isReleasing (→ stopReleasedCopy; never "stays resumable" mid-drain); TUI stop gates tagged Ready rows BEFORE stopNotRunningCopy (grok r6 #4 same fold); the collect copy past-tense softened to "(or its release was in flight)". |
  | critic r6 #4 / grok r6 #6 (convergent): the clobber-proof guard was pinned only for late REJECT | ADOPTED — T13b(vi) adds the three late-RESOLVE arms (idempotent markReleased / refused clearReleasing / no-op KEEP). |
  | critic r6 #5: the new task→command-agents edge's gate behavior is unproven | ADOPTED — §7 carries the gate-risk sentence (a red route returns to design review). |
  | critic r6 #6: the r6 BRIEF re-introduced a row count | RECORDED — brief-side only. |
  | grok r6 #2: resetReleasedMarkers' contract was unclear about the second set | ADOPTED — comment now says both sets. |
  | grok r6 #3: resolve arm had no cell for pre-HIT + post-read THROW | ADOPTED — the cell is named (markReleased/released with the disclosed tag-render degradation); T13c pins it. |
  | grok r6 #5: marker totality missed the not-resident releasedEarlier carve-out | ADOPTED — the totality list splits it out. |
  | grok r6 #8: D4's fenced string needed a single-literal note for T16's equality pin | ADOPTED — the note lands with D4. |

### Round 7 — grok GO / critic REVISE(2) with pre-authorized GO, on v7 (two seats; codex reduced per user)

- Grok: **GO** — all r6 dispositions verified present; totality closed ("every
  outcome kind and failure reason has a string and a `toEqual` pin"); "Ready
  to implement."
- Critic: REVISE with two cheap fixes and an explicit pre-authorization ("fix
  those two and this seat goes GO without a further round"):
  | finding | disposition |
  |---|---|
  | #1: the r6 stop-gate fold was asymmetric — the released-tag gate was TUI-side while the host sent tagged Ready rows to stopNotRunningCopy (T22 already pinned the symmetric behavior) | ADOPTED — D3's stop-gate paragraph made fully symmetric (both branches, both gates, order anchors named); T20/T25b-tui pin the pair. |
  | #2: DoD's "every §5 variant full-string pinned" exceeded the test list | ADOPTED — DoD scoped to every string + every prepend kind per renderer (not the full cross-product). |

**Convergence: both seats' terminal states reached — grok GO; critic's GO
pre-authorized upon these two folds (now landed). The design is APPROVED for
implementation; the document ships to `docs/plans` and §10's DoD is the
implementation battery's checklist.**

## 9. Gates battery (orchestrator-run)

`pnpm build` (includes `bundle:client`) → `pnpm typecheck` → root
`node_modules/.bin/vitest run` → `check:capabilities` → `check:parity` →
`check:readme` → `check:exports` → `check:spec-deps` → `check:size` →
`check:tui-boundary` → `check:vendor-purity` → `check:deep-imports` →
`check:identity`. `set -o pipefail`; outputs to files, grep'd. Flake
acceptance signature as before (timeout-only + zero AssertionError +
untouched + green isolated rerun).

## 10. DoD

- [ ] T16 green: a release flips the unit-seam guard from refusing to admitting.
- [ ] T18 + T18c green: real cooperative release evicts (incl. subtree), preserves
      the session log.
- [ ] T13b green: a cancel-resistant drain reports within ~10 s with the mark
      retained; a late completion flips it to released with no unhandled
      rejection.
- [ ] T15/T17 green: a collect resolved mid-release renders the released copy —
      never "may still be resumed".
- [ ] Every §5 string and every prepend kind is full-string pinned per renderer
      (not the full (kind × note × preStatus) cross-product — scoped per
      critic r7 #2); every eviction-claiming string
      carries the descendant clause; no string promises in-session continuation
      of a released id or unverified cross-session continuation.
- [ ] `/agents`, help, autocomplete, `/tui-help`, and the guard error name a
      path that actually releases; one-shot occupants disclosed.
- [ ] Manifest parity (three artifacts) + README hash gates green in the same
      commits; §8 complete through the final round.
