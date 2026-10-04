# Ephemeral Read-Only Subagents

- **Status**: Approved (two-seat external blind review, r1–r4 converged GO; §3.8/R8 reviewed separately, two rounds, both seats GO; axis rulings user-confirmed 2026-10-04)
- **Date**: 2026-10-04
- **Baseline**: v0.8.3 (main `a33c681f` post-merge; probes run against `3ff8de13`)
- **Scope**: `subagent_fork` dispatch for read-only agent definitions; reaper for
  one-shot children; settled write-lane grace-window auto-release (§3.8);
  capability-manifest parity surface

## 1. Problem

`subagent_fork` routes every named spawn through the continuable dispatch:
background = `startBackground`, foreground = `collectForeground` — both call
`ctx.subagents.startContinuable` (`packages/subagent/task/src/background-start.ts`).
Read-only cheap-lane agents (shunt-reader, explore) therefore accumulate as idle
catalog rows: listable, resumable, and permanently resident in `/agents`.

Read-only work lost to a crash is cheap to recover — re-spawn and redo; the
input is unchanged and there are no side effects. Write work lost mid-flight is
expensive — the persisted session plus a `send_message` continuation is the
only cheap recovery for half-written files. Persistence budget should follow
that loss-cost asymmetry:

- **Read-only agents → one-shot**: run to completion, return inline, leave no
  catalog row, auto-free the slot on settle.
- **Write agents → continuable (status quo)**: unchanged, zero code delta.

## 2. Verified evidence (live probes + source)

- **E1** `assertLiveCapacity` (MAX_LIVE_CONTINUABLE_CHILDREN = 25) guards only
  the two continuable paths (`background-start.ts:273` collect, `:368`
  background). The count derivation is `listChildren` rows × registry
  `status === 'running'` with **no mode filter** — running one-shot children
  are counted. The `seam.start` fork path (`tool.ts:273`) is unguarded.
- **E2** One-shot lifecycle (live probe, ×2, same-tick assertion): a one-shot
  child (workflow `agent()` → `delegate().start(request)`,
  `packages/subagent/workflow-journal/src/provider.ts:172`) occupies a
  registry slot while running (observe hook: "1 active subagent child") but
  never appears in `list_agents`/the continuable catalog, and leaves zero
  residue after settle. The target semantics — occupy while running,
  auto-free on settle, never linger — already exist upstream.
- **E3** Write lane (live probe): shunt-writer spawn settles → listed
  `inactive`; `send_message` wakes a new turn; disk state verified.
- **E4** Tool faces (source): shunt-reader = Read/Glob/Grep/read_image;
  explore (`packages/preset/claude-code-agents/src/bundled/explore.ts:9`) =
  Read, Glob, Grep + the read-only serena trio; shunt-writer adds Write.
- **E5** `one-shot-ledger.ts` records every run by `runId` with TTL pruning
  (active and ended — crash-tolerant).
- **E6** Release valve (PR #179): `release-agent.ts` + `runRelease` core,
  10s bounded drain race (`DRAIN_OBSERVE_TIMEOUT_MS`), releasing/released
  marker algebra. `runRelease` gates on `mode === 'continuable'`
  (`release.ts:222`) — one-shot ids are rejected.
- **E7** Classification input chain: `restrict.ts:42
  translateToolNames(tools, 'strict')` → `cc-names.ts:57-83` (`Read` expands
  to `read` + `read_image`; `mcp__*` names pass through verbatim) → stored on
  `toolRestriction.allow`. `sanitize-filter.ts:91-94` appends `ToolSearch` at
  spawn when MCP allow names survive.
- **E8** The working interrupt primitive for a live one-shot child is
  `subagents.interrupt(childId, {kind:'ancestor', agent})` — an authority
  handle (`epoch-collector.ts:46-53, 298-300`). Disposal via
  `drainContinuableChildren` is continuable-only.
- **E9** `wantsBackground` honors a definition `background: true` pin on
  omitted arg (`background-start.ts:161-170`). Foreground one-shot template:
  `seam.start` + `settle()` (`tool.ts:385-400`). `startFailed` tombstones the
  pin and rethrows — no child exists (`background-start.ts:333-347`).
- **E10** `/agents` already skips `mode === 'one-shot'` rows
  (`snapshot.ts:157`); `/resume` lists child sessions today
  (`command-resume/src/index.ts:57-72`). `SubagentsLike.start` takes no
  reserved `childId` and returns none (`background-start.ts:53-64`) — reserved
  ids exist only on `startContinuable` (`:70-74`).

## 3. Design

### 3.1 Classification (R1)

Classification is static, derived from the parsed definition — input is
`toolRestriction.allow` **after `translateToolNames`, before
`sanitizeToolFilter`**. Classifying post-sanitize is forbidden: ToolSearch
injection (E7) would poison the flagship case.

Whitelist (exact stored vocabulary):

```
read, read_image, glob, grep,
mcp__serena__find_symbol, mcp__serena__find_referencing_symbols,
mcp__serena__get_symbols_overview
```

MCP entries match by `mcp__serena__<tool>` prefix so a future hash-suffixed
public name still hits. A definition classifies ephemeral iff `allow` is
present AND every entry whitelist-matches. Everything else — omitted `tools`
(inherit-all), deny-only, empty allow, wildcards, `bash`, `write`, any other
harness or MCP name — classifies persistent. Classification reads the allow
list only and never nets deny lists (`tools: [Read, Write]` +
`disallowedTools: [Write]` stays persistent — conservative by design;
misclassifying a writer as ephemeral loses recoverability, the reverse only
loses convenience).

**Frontmatter fields** (new, parsed — otherwise silently ignored):
`ephemeral?: boolean` (override, both directions) and `ephemeralTtlMs?:
number`. Added to `types.ts` + `parse.ts` with loud-fail on malformed values
(same treatment as `background`).

**ToolSearch**: the ephemeral dispatch branch in `tool.ts` strips
`ToolSearch` from the sanitized filter before spawn (branch-local,
post-sanitize; `sanitize-filter.ts` is not touched — it has no ephemeral
context). A read-only child that can tool-search-load a deferred
write-capable tool would destroy the loss-cost asymmetry. The branch keeps the
`preloadDeferredFilterTools` call unchanged, running BEFORE the strip —
`preload-tools.ts:95-107` eagerly activates exact `mcp__<server>__<tool>`
names from the raw allow list, so a stripped-ToolSearch explore child still
gets its serena trio registered.

### 3.2 Dispatch (R2)

A whitelisted (or `ephemeral: true`) definition spawned in the foreground
dispatches through the one-shot path: `seam.start(PROVIDER_SPAWN, folded)`
carrying the same request fold as `collectForeground` (persona, toolFilter,
agentOptions, maxDepth — provider `'spawn'` means a fresh child with no parent
transcript), plus the existing `settle()` collector. The fork sentinel block
is conversation-inheriting and is explicitly NOT the template.

- **Capacity guard**: the ephemeral branch calls `assertLiveCapacity` before
  `seam.start` — the existing derivation already counts running one-shot
  children (E1). Refusal copy distinguishes "N ephemeral/one-shot runs in
  flight" from the continuable D4 literal (which stays byte-identical). The
  guard applies only to the Task ephemeral branch; `fork` sentinel and
  workflow `agent()` stay unguarded as today (explicit non-goal).
- **Background combination**: explicit `run_in_background: true` + ephemeral →
  fail-fast reject, copy naming the workflow tool for fan-out. A definition
  `background: true` pin + ephemeral + arg omitted → **ephemeral wins**: the
  child runs as a foreground one-shot and the result copy carries a one-line
  notice that the pin was ignored for the lane. (Pin-wins silently re-adds
  catalog residue; load-error makes a legal author shape unusable.)
- **Ctrl+B** does not promote an ephemeral wait (it is out of
  `ccCollectorRegistry`); Esc abort still works via `exec.signal`. Stated in
  copy.
- **Worktree isolation**: `isolation: worktree` + ephemeral → fail-fast
  refuse at dispatch. `SubagentsLike.start` cannot carry a reserved childId
  (E10) and adopt/settle keys on the preallocated id
  (`worktree-isolation.ts:363-367, 414-417`), so a one-shot worktree arm is
  not implementable without a harness reserved-id seam. Copy points at a
  continuable lane; revisit under the reserved-id spike (§6).

### 3.3 Slot semantics (R3)

Running ephemeral children still occupy a registry slot; the capacity guard is
wired (§3.2). Ephemeral delivers zero linger, not zero occupancy. No claim is
made about upstream resident-activation limits (a recorded default could not
be re-verified in the 0.2.0-rc.2 harness source — not cited).

### 3.4 TTL reaper (R4)

- **Arm point**: only at Task ephemeral dispatch, keyed by that run's `runId`,
  using the definition's `ephemeralTtlMs` or the 15-minute default (a
  documented product choice for haiku read lanes; `ephemeral: false` or a
  higher TTL covers expensive scouts). The one-shot ledger is the **kill
  log**, never the candidate set — it records every `subagent/start` including
  continuable, workflow, fork, and internal labels (`memory-recall`,
  `hook-prompt`, …), and a process-wide TTL sweep would interrupt write-lane
  recovery this design exists to protect.
- **Kill identity (parallel-safe binding)**: the binding key is a per-run
  `AbortController` created at dispatch — NOT a child id. The ephemeral branch
  passes `signal: AbortSignal.any([exec.signal, ttlController.signal])` on
  the `seam.start` request (start requests carry `signal` —
  `background-start.ts:57,83`). On TTL expiry, abort ONLY that run's TTL
  controller: `exec.signal` is the turn signal — aborting it would cancel
  every parallel tool call in the turn (Task is concurrency-safe,
  `tool.ts:236`; parallel ephemeral explores are the normal shape). The
  timer closure captures `exec.agent` (the parent is live for the whole
  `settle()` wait) as the interrupt authority; `interrupt(childId, …)` is a
  best-effort extra only when a child id is observed unambiguously — never
  the binding key, because `seam.start` takes no reserved childId and FIFO
  `subagent/start` correlation under a shared `parentId` can bind the
  sibling.
- **Expiry sequence**: abort the per-run controller → (best-effort)
  `interrupt` with the `{kind:'ancestor', agent}` authority handle when an id
  was observed unambiguously → bounded 10s wait for `subagent/end` (same
  observe-timeout pattern as `DRAIN_OBSERVE_TIMEOUT_MS`) → record
  `stopReason` on the ledger row.
- **No `runRelease`/`drainContinuableChildren` reuse** — the mode gate rejects
  one-shot ids (E6/E8). An unsettled zombie after the 10s window is a
  documented residual (upstream cancel-gap; force-disposal stays on the
  upstream proposal list).
- **Foreground failure copy**: a TTL kill of a foreground-waited child
  surfaces as "ephemeral child hit its TTL; re-spawn it" (`settle` throws on
  non-`completed`).

### 3.5 Boundaries (R5)

- `release_agent` on a running ephemeral child: not supported. The mode gate
  rejects one-shot rows and one-shot children are not listable; extending
  `runRelease` is a possible future gate change, gated on a harness spike
  (§6). The reaper is the only mid-run intervention.
- `send_message` to a settled ephemeral child: relies on the harness
  unknown-id clean failure (strictly better than the released-child no-op
  cold-resume gap). A ledger-lookup "ephemeral agent already finished" copy is
  an explicit follow-up, not v1 scope.
- Transcripts are still written (forensics//learn depend on them). `/agents`
  already skips one-shot rows — pinned with a test. `/resume` filter: prefer
  a descriptor flag if the harness `seam.start` options can carry one; if
  not, filter by `parentSession` + ledger membership. The implementation
  spike decides; this doc records the chosen mechanism when it does.

### 3.6 Write-lane failure copy (R6)

The "session persisted; send_message to <id> can resume it" sentence appears
only when a `childId` was accepted (`startContinuable` succeeded; the
failure/interrupt happened after). Start failures (tombstoned pin,
capability/transport error) keep plain error copy — there is no child to
resume (E9).

### 3.7 Obligations and test surface (R7)

- **Manifest**: a new `subagents.ephemeral-agents` row (dsh-cc extension; CC
  upstream has no such field) AND a rewritten `subagents.task-tool` deviation
  entry covering: one-shot foreground for the whitelist, Ctrl+B applying only
  to continuable collects, the pin rule, and the `run_in_background`
  rejection. Same PR, `docs:parity` regen committed together (I3/I4/I6/I7
  respected — positive dimensions carry test/source evidence anchors).
- **File-touch list**: `packages/preset/claude-code-agents/src/types.ts`,
  `parse.ts` (+ parser tests), `packages/subagent/task/src/tool.ts`
  (ephemeral branch + ToolSearch strip), `background-start.ts` (guard
  reuse), reaper module (new file, ledger integration), `/resume` filter,
  manifest + parity docs, optional `ephemeral` annotations on
  `bundled/explore.ts` / shunt agent files.
- **Test matrix**:
  - Classifier (pure, table-driven over real parse outputs): in-tree table
    (explore, dsh-cc-guide, shunt-reader → ephemeral; shunt-writer, critic,
    executor, marathon → persistent); omitted tools / deny-only / empty
    allow / MCP wildcard / `Bash(git status)` arg-spec / comma-string tools /
    typo-dropped entries; `ephemeral` overrides both directions;
    pre-sanitize classification pinned.
  - Dispatch (tool.spec seam, `runs` vs `continuableStarts`): explore
    foreground → `seam.start` with `provider === 'spawn'`; shunt-writer →
    `collectForeground`; critic omit → `startBackground`; ephemeral +
    explicit background → exact fail-fast string; `background: true` pin +
    ephemeral + omit → foreground one-shot + notice copy; capacity refusal
    copy on the ephemeral branch (mixed 24 continuable + 1 one-shot, 26th
    refused); fork sentinel stays unguarded.
  - Reaper: membership predicate (a labeled `memory-recall` row past TTL is
    left alone); TTL expiry → ledger row marked + stopReason recorded; 10s
    bound; interrupt authority-handle signature; foreground TTL kill copy;
    **parallel-safety pin: two concurrent ephemeral explores, one TTL fires,
    the other `settle()`s `completed`**.
  - Lifecycle: post-settle `send_message` → unknown-id failure copy;
    write-lane interrupt after start names `send_message` + id;
    start-failed writer does not claim resumability; `/agents` skips
    one-shot rows; `/resume` filter; worktree+ephemeral → exact fail-fast
    refusal string.
  - Copy pins: `toEqual` on all refusal/notice/failure strings.

### 3.8 Settled write-lane grace-window auto-release (R8)

**Premise (corrected against the intuitive reading).** A settled writer
already frees its slot AND its resident activation at natural settle (F3c:
the end event tears the activation down; the session lives; the catalog row
reads `ready`). The only leftover is the durable catalog row
(`/agents`-listable, cold-resumable — the retry capability the write lane
exists to keep) plus the persisted session on disk. This section therefore
delivers a **bounded continuation window and listing hygiene** — not slot
reduction, not activation-memory hygiene. `runRelease` cannot implement it:
a naturally settled writer is registry-absent, and `runRelease`'s
catalog-hit × registry-miss cell is the documented `not-resident` no-op
(`release.ts:235-237`; integration T18b). The mechanism is a **tombstone on
the ready row** — process-local, drain-free, no parent authority.

- **Membership (dispatch-site arm-registry).** At Task continuable dispatch,
  record `{childId, autoReleaseMs, parentId}` in a process-local
  arm-registry — recorded BEFORE `collectFirstEpoch`/`startContinuable` is
  awaited (the foreground collect's first `subagent/end` fires during that
  await; `startBackground` does not have this race). `subagent/end` for a
  recorded id arms (or re-arms — a second end replaces the pending timer;
  arm is idempotent, timers never stack); `subagent/start` for a recorded id
  cancels the pending timer AND clears the tombstone marker (see below).
  Start-without-pending-timer is a documented no-op. `INTERNAL_LABELS`
  filtering is defense-in-depth only — the dispatch-site registry is the
  primary predicate, so coordinator/epoch-collector/resume-capture
  continuable children are structurally excluded.
- **Grace window.** Default **2 hours** (write-lane recovery is precious and
  in-session-irrecoverable after tombstone; 30 minutes was rejected as
  inside normal interactive cadence). Per-definition override: frontmatter
  `autoReleaseMs?: number` with a NON-negative parser — tri-state pinned:
  absent → default, `0` → disabled (never armed), malformed → loud parse
  failure (`parsePositiveInt` rejects `<= 0` and must NOT be copied
  verbatim). Arm-time copy is rendered at settle with the window in it
  ("session persisted; send_message to <id> can resume it (auto-released
  after <window> of inactivity)") at BOTH delivery sites — the foreground
  `outcomeToResult` result and the background/Ctrl+B `subagent-settled`
  wake (collected epochs drop the wake otherwise). The model that settled
  the child is the one that will later `send_message`; it needs the
  deadline in context.
- **Action on fire.** Re-check the registry first: if the child is live
  again (running or idle-resident — a continuation raced the fire), SKIP the
  tombstone and re-arm. Otherwise `markReleased(childId)` extended to cover
  READY rows — a new `{kind: 'tombstoned'; id}` outcome kind in the release
  module (the manual `release_agent` path on a naturally settled child
  keeps its `not-resident` behavior, T18b; manual release on a tombstoned
  child renders `not-resident` with `releasedEarlier: true` — that copy is
  pinned so it does not drift). **No drain, no `drainContinuableChildren`,
  no parent `Agent` authority** — this dissolves the descendant-eviction
  risk (idle parent with a live grandchild, T18c) and the stale-parent
  failure class entirely.
- **Tombstone lifecycle.** The `released` marker set is one-way today; R8
  adds `clearTombstone(id)`, cleared on the child's `subagent/start` (and
  equivalently on a gate pass). Without it, the accepted in-flight residual
  below would silently become permanent retirement.
- **send_message gate.** The harness `send_message` path does not consult
  dsh-cc markers — the gate rides the existing `tools/pre-execute` seam on
  `send_message` reading `arguments.agent_id` (precedented by
  `resume-pins/src/plugin.ts:296-324`), and the tombstone DENY runs before
  pin admission (`next()`) so a tombstoned id never gets `persistPass`.
  A tombstoned id fails cleanly with the "auto-released after inactivity"
  copy instead of the released-child no-op-turn cold-resume gap.
- **Accepted residual.** A `send_message` in flight at the exact moment the
  tombstone lands resolves once more: the child gets one extra epoch, and
  its `subagent/end` re-arms a fresh window with the tombstone cleared.
  Non-destructive; accepted and test-pinned.
- **Resumed sessions.** The arm-registry is process-local and empty after a
  resume; `listChildren` rows carry no dispatch bit. Eligibility on resume
  is derived from the resume pin: `resume-capture.ts` writes pins only from
  the Task dispatch sites (`startBackground`/`collectForeground`), so a
  ready row is armed-on-resume IFF its resume pin exists and is readable
  (missing/unreadable → left alone, fail-safe toward retention). The window
  then runs from resume load time, not last activity — documented. No
  cross-session cleanup claim: process exit fires nothing.
- **Timer hygiene.** Every grace timer is `.unref()`'d (a settled writer
  must never hold the process open); the fire callback is wrapped — any
  failure logs and does NOT rethrow (fail-open toward retention: skip +
  log, never tombstone on uncertain state). The one-shot ledger's ended
  rows prune at 5 minutes, so a 2-hour fire cannot write to the paired
  row — the tombstone marker state is the record, plus one log line at fire
  time. No ledger schema change.
- **`/agents` surface.** Tombstoned rows get the same TAG treatment as
  released rows (`snapshot.ts:160-165` already tags marker ∧
  registry-absent) — tagged, still listed (upstream catalog rows are not
  removable, F14). `BACKGROUND_SECTION_TEXT`'s "use release_agent on stuck
  children you can discard, not as routine cleanup" bullet is reconciled in
  the same PR (auto-tombstone is the routine lane; manual release remains
  the interactive override for RUNNING children).
- **Test surface additions**: membership (non-registry id never arms;
  coordinator children never arm); idempotent arm (second end replaces;
  exactly one timer); tri-state parse; default constant pin; arm-time copy
  exact strings at both sites; fire (registry-live recheck → skip + re-arm;
  ready row → `tombstoned` + marker set; send_message gate copy; manual
  release on natural-settled still `not-resident`, T18b regression pin;
  manual release on tombstoned renders `releasedEarlier: true`); residual
  (in-flight send_message at fire → one extra epoch → tombstone cleared →
  window re-arms); timers (`.unref()` with pending timers; fire-callback
  failure logs without rethrow); resume arming (pin-eligible row armed,
  unreadable pin left alone).
- **File-touch additions**: arm-registry + timer module (new file under
  `packages/subagent/task/src/`), `release.ts` (tombstone arm + outcome
  kind + `clearTombstone`), `tools/pre-execute` gate, `types.ts` +
  `parse.ts` (`autoReleaseMs`, non-negative helper), `snapshot.ts` (tag),
  R6 copy sites (both), `BACKGROUND_SECTION_TEXT`, tests. Implementation
  lands after (or with) the R4/R7 ephemeral implementation — parser
  references are to this spec, not existing code.


## 4. Non-goals

- Capping `fork` sentinel or workflow `agent()` dispatches.
- A one-shot worktree arm (blocked on the reserved-id seam).
- Extending `release_agent` to one-shot children.
- Any change to the write/continuable lane's DISPATCH semantics (zero code
  delta by design) — §3.8 (grace-window auto-release) is the deliberate
  carve-out: it changes write-lane RETENTION semantics only, after settle,
  via the tombstone mechanism.

## 5. Residual risks

- **Zombie residual**: an ephemeral child that ignores the TTL abort and
  never settles keeps its slot until process exit. Mitigated (bounded
  reaper, ledger observability), not eliminated — the permanent fix is the
  upstream force-disposal proposal.
- **Registry-count coupling**: the capacity guard's derivation is upstream
  behavior (`listChildren` × registry status); a harness change to that
  surface needs a test tripwire.

## 6. Open questions (non-blocking)

1. Does `drainContinuableChildren` tolerate a one-shot id? (Determines
   whether `release_agent` force-evict is ever feasible.)
2. Can `seam.start` carry a descriptor flag for the `/resume` filter — and a
   reserved `childId`, which would unlock a one-shot worktree arm?
3. Upstream force-disposal proposal (PR #179 N3) — the permanent fix for the
   zombie residual.

## 7. Implementation slices (suggested)

1. Frontmatter fields + classifier (pure, fully table-tested).
2. Ephemeral dispatch branch in `tool.ts` (guard, strip, fold, `settle`) +
   copy pins.
3. Reaper module (arm-point, per-run controller, ledger integration) +
   parallel-safety pin.
4. `/resume` filter + manifest/parity surface.
5. R8 grace-window auto-release (arm-registry + timer module, tombstone arm
   in the release module, send_message gate, `autoReleaseMs` parser, surface
   tags and copy) — after or with slice 3.

## 8. Review ledger

Three-seat blind review was dispatched per the high-stakes protocol; the
codex seat failed deterministically before forming any judgment
(`~/.codex/config.toml` model key `gpt-6.1-sol` unsupported for the account —
recorded interrupted(model-config), not retried; the user approved closing on
the reduced roster). All findings below were folded and the folding was
re-verified by the issuing seat.

- **r1** (critic: GO-WITH-AMENDMENTS; grok: NO-GO → fix-and-ready):
  whitelist vocabulary (`serena::` matches nothing; stored form is
  `mcp__serena__*`; classify pre-sanitize) → §3.1; frontmatter fields
  unparsed without `types.ts`/`parse.ts` changes → §3.1; `background: true`
  pin × ephemeral unspecified → §3.2 ruling; capacity guard not wired on the
  one-shot path → §3.2; `runRelease` unusable on one-shots → §3.4; ToolSearch
  injection hole → §3.1; R6 copy on failed starts → §3.6; `release_agent`
  force-evict claim removed → §3.5; test matrix + file-touch list → §3.7.
- **r2** (critic: GO with three one-line amendments — all folded: interrupt
  authority-handle signature, preload-before-strip, strip location ruled
  branch-local; grok: NO-GO → two pins): one-shot spawn must be
  `seam.start(PROVIDER_SPAWN, folded)`, not the fork sentinel block → §3.2;
  reaper membership predicate (Task-armed only, ledger as kill log) → §3.4;
  worktree+ephemeral re-ruled fail-fast refuse → §3.2.
- **r3** (grok: NO-GO, one blocker): kill identity not bindable under
  parallel Task dispatch → §3.4 per-run AbortController binding.
- **r4** (grok: **GO** — "No remaining NO-GO-level hole. Implement from v4.";
  critic seat pre-authorized GO at r2 with its amendments folded).
- **§3.8 (R8) review, 2026-10-04, two seats** (critic + grok; the codex seat
  was already recorded interrupted(model-config) above and was not
  re-dispatched):
  - **R8 r1** (critic: GO-WITH-AMENDMENTS — event-site membership
  unimplementable, fire-time race with continuation, 30-min default
  destroys the recovery lane, resumed children never armed; grok: NO-GO —
  runRelease on a naturally-settled writer is the documented
  `not-resident` no-op since natural settle already tears down the
  activation, so the v1 core action does nothing): the divergence was
  adjudicated in grok's favor on the evidence (integration T18b,
  `release.ts:235-237`) — the core mechanism was REPLACED by the
  ready-row tombstone; membership moved to a dispatch-site arm-registry;
  fire-time registry recheck added; default raised to 2h with arm-time
  copy; resume arming added.
  - **R8 r2** (critic: **GO** — tombstone lifecycle needs `clearTombstone`
  on start or the accepted residual becomes permanent retirement; grok:
  **GO on the mechanism** with three one-line rulings): both seats hit the
  same tombstone-lifecycle point (convergent, folded — `clearTombstone(id)`
  on `subagent/start`/gate-pass); grok's rulings folded: resume
  eligibility via the resume pin (pins are written only by the Task
  dispatch sites), arm-registry records BEFORE `collectFirstEpoch` is
  awaited (the foreground first-epoch end fires inside that await), and
  the send_message gate rides the `tools/pre-execute` seam with the deny
  ordered before pin admission (resume-pins precedent). Critic's minor
  notes folded: manual-release-on-tombstoned copy pinned;
  resume-window base = load time, documented.

User rulings: the read/write loss-cost axis and the shunt-writer → persistent
classification (2026-10-04); reduced-roster closure after the codex seat's
deterministic model-config failure (2026-10-04).
