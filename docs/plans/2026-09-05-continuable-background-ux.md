# Continuable Background Agents: Background-by-Default Pins, the `/agents` Surface, and Ctrl+B Promotion

Status: **Implemented (dsh-cc-side scope)** — Slice 1 and Slice 3 (epoch collector) shipped in PR #115 (merged 2026-09-05); Slice 2's upstream harness change remains cancelled per the product constraint below. Approved (dual blind review deep-reasoner/Opus + Codex GPT-5.4, independent, both REVISE → findings folded → resolution check: 11/12 CLOSED, 2 verification deltas folded into Slice 0 task 1 and §3.6). 2026-09-10 product constraint: deepseek-harness is NEVER modified (local checkout, fork, or upstream PR) — Slice 2's upstream implementation is cancelled; Slices 2–3 reformulate dsh-cc-side (in-process event + session-log collector) pending a feasibility spike; the handle design doc stands as the proposal for upstream adoption.
Date: 2026-09-05
Scope: `packages/interaction/command-agents` (new), `packages/interaction/command-tasks`, `packages/subagent/task`, `packages/subagent/resume-pins`, `packages/ui/tui`, `packages/preset/cc`, `.claude/agents`, `CLAUDE.md`, `docs/claude-code-capabilities.yaml`, `packages/hooks`, `packages/bundle/cc-shell`; no harness changes

## 1. Problem and goals

dsh-cc already ships continuable background agents: `subagent_fork` (`Task`) can start
a child via `ctx.subagents.startContinuable` and return immediately, completion later
arriving as a `subagent-settled` wake; resume pins give every child a durable,
inspectable identity (`docs/plans/2026-09-04-subagent-resume-pins.md`, implemented).

Missing product surface:

1. **Defaults** — the orchestrator's workhorses (`deep-reasoner`, `fast-worker`)
   should default to background so the main dialog keeps interacting.
2. **Query and control** — a first-class command to list, inspect, and stop these
   agents (`/agents`).
3. **Foreground demotion** — Ctrl+B while blocked on a foreground subagent converts
   the *wait* to background (Claude Code parity), never the child's lifecycle.
4. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` honored as a backgrounding kill switch.

## 2. Verified ground truth

Confirmed by two independent reviewers and by orchestrator spot-checks. Citations:
worktree paths are this repo; `harness:` paths are the read-only sibling checkout
`/Users/bytedance/workspace/github.com/deepseek-harness`.

- **F1. Wait policy exists.** `packages/subagent/task/src/tool.ts:145-149`
  (`wantsBackground`): explicit `run_in_background` boolean wins, then a
  `background: true` frontmatter pin, else foreground. `startBackground`
  (tool.ts:379-461) preallocates the child id, writes the resume pin **before**
  `startContinuable`, tombstones on throw, returns
  `{ status: 'async_launched', agentId }` (schema tool.ts:239-242). `Task` is
  `isConcurrencySafe: true` (tool.ts:248) — parallel collects per step are expected.
- **F2. Foreground today = one-shot.** Foreground branches call one-shot
  `seam.start` + `settle` (tool.ts:266-271, :315-319, :463-478) — **no pin capture**
  on this path (`preparedBackground` runs only in the background branch,
  tool.ts:353-368, :407-418). `settle` throws on any `stopReason !== 'completed'`.
- **F3. `startContinuable` returns no handle.** It yields only
  `{ childId, messageId }` (harness:packages/subagent/subagent/src/continuation.ts:111-138).
  There is **no** result promise, no epoch await, no detach. Slice 2/3's "collect the
  first epoch" needs a new upstream API (§4 Slice 2).
- **F4. Settlement notice is unconditional and start-time options cannot express
  promotion.** `notifySettlement` (harness continuation.ts:1444-1504) always tells the
  durable parent (followup/steer, or inject during teardown). `ContinuableStartSpec`
  (:112-130) has no delivery field. The `'quiet' | 'next-step'` vocabulary exists only
  on **reports** (`SubagentReportDelivery`, :101). A static start-time flag cannot
  express "suppress iff collected inline; deliver if later Ctrl+B-promoted" — the
  decision is made *after* start. The upstream API must be a race-linearized ownership
  handle: exactly one of collect / detach / abort wins; only detach (or never-claimed)
  delivers the settlement notice.
- **F5. Signal ownership ends at inbox acceptance.** `ContinuableStartSpec.signal`
  (:128) owns only until acceptance; post-acceptance abort does **not** interrupt the
  child. Esc-during-collect must therefore map to an explicit child interrupt routed
  through the handle's `abort`, or the child keeps running detached and its later
  settlement still wakes the parent.
- **F6. No subagent pool cap exists.** The previously cited
  `agent-loop/src/constants.ts:6` is `DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10` —
  "maximum in-flight parallel-safe calls **per agent step**"
  (harness:packages/core/agent-loop/src/constants.ts:1-6), i.e. a launch-rate bound,
  not a resident-children bound. Nothing upstream caps steady-state continuable
  children; `interrupt` cancels the current turn but preserves the Activation
  (harness:packages/subagent/subagent/src/index.ts:240-249). Capacity needs an
  explicit dsh-cc-side admission limit (§6.4).
- **F7. `/agents` data is thinner than the original spec assumed.**
  `listChildren` (harness list-children.ts:35-86) returns only `{id,
  activity: 'running'|'inactive', hasChildren, label?, mode}` per child, ordered
  oldest-first with no `createdAt`; descriptor content is deliberately model-hidden.
  The coordinator's status derive `live === undefined ? 'ready' :
  (live.status === 'running' ? 'running' : 'idle')`
  (packages/subagent/coordinator/src/index.ts:321-330) is a **pattern**, not a data
  source: `worker_tasks` is a tool registered into the coordinator-mode agent's own
  scope over a private WorkerRegistry — not injectable. Resume-pins add
  route/definition/workspace/cached-resume + gate deny codes
  (`packages/subagent/resume-pins/src/{store.ts,gate.ts}`), but no prompt, usage,
  counters, or epoch history. Rich fields (provider/model, prompt excerpt, stopReason)
  exist **only** in the TUI's own event fold (`SubagentRunView`,
  packages/ui/tui/src/store/views.ts:206-222).
- **F8. Realm isolation constrains mounting.** `resumePinStore` is provided inside
  the `cc-services` realm (packages/preset/cc/agent.cordis.yml:314-324,
  resume-pins/src/plugin.ts:157-164) while `command-tasks` mounts outside it
  (agent.cordis.yml:435-481). A parallel-row clone cannot resolve pin data;
  `command-agents` must mount **inside** `cc-services` or consume pin data via an
  explicit realm-visible service.
- **F9. Busy-key attribution does not exist today.** `subagent/*` lifecycle payloads
  carry run id/provider/child id/locality but **no parent session id and no wait
  policy** (harness types.ts:36-50); the TUI folds them process-wide
  (driver-catalog.ts:239-275). "Is THIS busy dialog waiting on a promotable child?"
  cannot be answered from the store alone — a session-scoped registry is required
  (§4 Slice 3).
- **F10. Busy Esc and busy Ctrl+C both interrupt** (root.ts:185-213, :309-321 →
  driver-queue.ts:269-278 → `parent.cancel({kind:'user'})` → `Agent.cancel` clears
  the inbox and aborts the whole active driver, harness agent.ts:134-140; the
  scheduler drains started calls and aborts the rest, harness tool-calls.ts:210-241).
  With N parallel Task collects, Esc must interrupt **all** collecting children and
  return promptly without awaiting their settlement. Idle Ctrl+C is double-press
  quit; idle Ctrl+B is `tui.editor.cursorLeft`
  (pi-tui/src/keybindings.ts:82-85).
- **F11. `fork + background` is rejected** deliberately (tool.ts:274-284; upstream
  #2124). Fork waits are never promotable.
- Verified-reusable patterns: `command-tasks` register/mount shape is genuinely
  mirrorable (subject to F8); jobs README "Foreground work cannot be promoted"
  constrains the substrate — promotion here flips the **wait policy** of a child
  created continuable at launch; it never converts a live one-shot run.

## 3. Product behavior

### 3.1 Two-axis model (unchanged)

**Wait policy** (when the parent's tool call returns): collect-first-epoch vs
immediate background. Resolution: explicit `run_in_background` argument > frontmatter
pin > foreground collect. **Lifecycle**: `fork` → one-shot; named agents and
`general-purpose` → continuable. Axes are independent; promotion changes only the
wait policy of an already-continuable child.

| Call shape                   | deep-reasoner / fast-worker (pinned) | explore / dsh-cc-guide / general-purpose (unpinned) | fork                |
| ---------------------------- | ------------------------------------ | --------------------------------------------------- | ------------------- |
| omit `run_in_background`     | continuable + background             | continuable + collect first epoch                   | one-shot + collect  |
| `run_in_background: true`    | continuable + background             | continuable + background                            | rejected (upstream) |
| `run_in_background: false`   | continuable + collect first epoch    | continuable + collect first epoch                   | one-shot + collect  |

Deliberate deviation: no global "omit = background" default. `explore` results are
consumed in-turn; auto-background would force a wake-then-synthesize round trip per
scout call. The pin-per-agent approach keeps the deviation local and testable
(Slice 1 repo-guard test).

### 3.2 `/agents` (Slice 0) — descoped MVP contract

Shared package `packages/interaction/command-agents`, owning one **thin snapshot
provider** consumed by both the preset command and the TUI local slash. Bridge
decision: the snapshot is exposed through an explicitly realm-visible/host-plane
read-only service (F8's alternative) — the TUI local-slash path cannot be assumed to
resolve realm-interior mounts; Slice 0 task 1 must demonstrate resolution from BOTH
consumers before any rendering work starts:

- Snapshot fields per child (from `listChildren` + `ctx.agents.get` + `PinStore`):
  `id`, `label`, `residency: 'running' | 'idle' | 'ready'` (derive per the F7
  pattern), `hasChildren`, pin state (`pinned` + gate deny code when applicable).
- **Groups follow residency only** — `Working` / `Idle` / `Ready` (resumable, no
  live run; includes settled-continuable children, per the harness's own `ready`
  semantics). There is **no `Done` group** for continuable children: a settled
  continuable is `ready`, not done; the TUI's own `parked` vs `done` distinction is
  retained only where the TUI fold already knows it (decorated rows may append
  `last epoch: <stopReason>` when the fold has it).
- `/agents` — grouped list, label-rendered rows (no prompt excerpts in the list).
- `/agents <id>` — detail: pin provenance (pin path, gate evaluation, intended
  route/definition), residency, ids. **Prompt excerpt / provider+model / usage /
  last stopReason are emitted only on the TUI surface**, decorated from its event
  fold (F7); when shown, prompt excerpts are newline-normalized, control/ANSI-stripped,
  unicode-aware-truncated. The preset (non-TUI) surface renders the thin detail only;
  the field divergence is documented as deliberate.
- `/agents stop <id>` — one `interrupt` request on a `running` child (child stays
  continuable/resumable); short no-op explanation for idle/ready children.
- `/agents attach <id>` — P1, namespace reserved, not implemented.
- **Busy-time availability**: the TUI keeps `/agents` on LOCAL_SLASH
  (local execution, no busy-epoch round trip); the TUI's pre-existing flat `/agents`
  (driver-run-local.ts:268-285) is **replaced/subsumed** by this surface. First task
  of the slice: grep for any harness-level `agents` command namespace collision.
- `/tasks` footer gains: `N background agents — /agents for details`.
- Output parity note: preset and TUI share the snapshot and row grammar; TUI-only
  decorations are visually additive, never different ids/ordering.

### 3.3 Pins (Slice 1)

- `.claude/agents/deep-reasoner.md`, `fast-worker.md`: frontmatter `background: true`.
  No other repo agent pinned; `explore` stays unpinned by design (§3.1).
- `CLAUDE.md` §"Foreground vs background" gains a fourth bullet: omitting the flag now
  **backgrounds** the two pinned agents; a *mutating same-tree* `fast-worker`
  delegation MUST pass `run_in_background: false`. Prompt-only and unverifiable by the
  repo-guard test — declared as prompt guidance, not a mechanism.
- `BACKGROUND_SECTION_TEXT` (task/src/index.ts:47-65) is updated **in this slice**
  (moved up from the old Slice 2): it must spell the asymmetry explicitly — pinned
  agents return `async_launched` immediately; the result arrives later as a wake;
  do not compose on a nonexistent inline result. Config-is-prompt: commit message
  states the expected observable; verified in a later real session.
- Repo-guard test pins both frontmatters and asserts all other bundled agents remain
  unpinned.

### 3.4 Ctrl+B promotion of a foreground wait (Slice 3)

- **Precondition**: dialog busy AND this session has ≥1 in-flight promotable collect
  (a continuable child whose first epoch the parent awaits). Fork waits and `!`-bash
  are never promotable (F11).
- **Attribution**: a session-scoped promotion registry
  (`ActiveContinuableCollects`, §4 Slice 3) keyed by parent session + tool-call token;
  the TUI busy-branch keybinding consults it (F9) instead of guessing from the store.
- **Effect**: the winning race arm is `detach` on the ownership handle (F4): the tool
  call resolves `{ status: 'async_launched', agentId, backgroundedByUser: true }`;
  the child keeps running untouched and its eventual settlement notice delivers
  normally. TUI echoes one status line.
- **Ctrl+B plumbing**: dedicated intent via the registry — **not** an overload of
  `cancel({kind:'user'})` (F10: that path tears down the whole parent turn; promotion
  must not). Idle Ctrl+B remains `cursorLeft`. tmux: Ctrl+B is the default prefix —
  double-press passes a literal Ctrl+B through (`send-prefix`); the Ctrl+X Ctrl+B
  chord is P1. Non-TUI clients have no promotion path (accepted; declared in the
  capability matrix).
- **Esc/Ctrl+C preservation** (F5, F10): busy Esc/Ctrl+C still interrupt; the collect
  abort path maps to `abort` on **every** in-flight collect handle of this parent
  (parallel collectors all interrupted), resolves the tool calls promptly with a
  clear error (never awaiting child settlement), and the aborted epochs emit **no**
  settlement wake later (abort wins the ownership race). Copy for the Esc'd collect:
  `Subagent <id> interrupted; it may still be resumed — /agents for status.`
- **`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`**: non-empty value (except `0`/`false`,
  case-insensitive) disables pins (omissions collect in foreground) and disables
  Ctrl+B promotion. Explicit `run_in_background: true` remains honored — upstream
  semantics for this exact precedence are **unverified**; declared as a partial-parity
  deviation in the capability matrix rather than asserted as parity.

### 3.5 Notifications

No new machinery. Background settlement remains the existing wake. The upstream
ownership handle (Slice 2) makes the collected/aborted epoch emit no
`subagent-settled`; a detached (promoted) child emits it normally — one delivery,
exactly once, by construction rather than by filtering.

### 3.6 Capacity guard

Since no upstream resident-children cap exists (F6), the Task tool enforces a
conservative per-parent admission limit: refuse to start a new continuable child when
the parent already has **25 live continuable children** — counted directly as
`listChildren` entries with `activity: 'running'` (live in `ctx.sessions`); no
residency derive is needed or trusted, and parked/persistence-only children are not
the resource this guards. Verification dependency: Slice 0 task 1(d) confirms this
count is reachable from the task package's execution realm; if not, the guard
consumes the same realm-visible snapshot service the slice establishes. Actionable
error: `parent has 25 live subagents; /agents stop <id> to release one, or let
children settle`. Constant in one place, test-covered. This is a safety valve, not a
scheduling policy; tuning is a follow-up.

## 4. Implementation design

### Slice 0 — `/agents` MVP (no harness changes)

1. **Verification spike first, before any code:**
   (a) grep for command-namespace collisions (`agents`) across harness + repo;
   (b) confirm the needed service ids (`commands`, the subagents service exposing
   `listChildren`, `agents`, `resumePinStore`) resolve inside the `cc-services`
   realm (F8);
   (c) confirm a realm-visible/host-plane read-only snapshot service reaches BOTH
   the preset command handler AND the TUI local-slash path — the bridge shape
   (realm-interior mount + exported service vs pure host-plane service) is decided
   by this spike, not assumed;
   (d) confirm the live-children count (`listChildren` `activity: 'running'`) is
   reachable from the task package's execution realm, for the §3.6 capacity guard.
   Then scaffold `packages/interaction/command-agents` mirroring `command-tasks`
   (register/input/handler shape), mounting per the spike outcome, with `inject`
   listing exactly the services used.
2. Thin snapshot provider (pure function over the injected services) + grouped render
   functions (`renderAgentsList`, `renderAgentDetail`), unit-tested with fakes:
   empty state, each residency group, deny-code row, stop no-op copy, ordering.
3. TUI local `/agents` (+`<id>`, `stop <id>`) joins LOCAL_SLASH; consumes the same
   snapshot; decorates with `SubagentRunView` fold data where present; busy-time
   execution regression test; old flat renderer removed.
4. `/tasks` footer cross-link + test.
5. Capability manifest: new `commands.agents` row (documenting thin-vs-decorated
   divergence), `commands.tasks` cross-link note; regenerate parity docs same commit.

### Slice 1 — pins and orchestration contract (no harness changes)

1. Frontmatter pins on both agents; `CLAUDE.md` bullet; `BACKGROUND_SECTION_TEXT`
   update with the asymmetry spelled out (§3.3).
2. Repo-guard vitest for the pins + unpinned-ness of the rest.
3. Capability manifest: `subagents.task-tool` behavior-matrix row (pinned defaults);
   regenerate docs same commit.
4. Ordering rationale: `/agents` (Slice 0) lands before defaults change (Slice 1) so
   users always have query/control before omission behavior shifts; interim-window
   risk eliminated.

### Slice 2 — dsh-cc epoch collector (no harness changes)

A feasibility spike established dsh-cc can collect a continuable child's first
epoch inline with zero harness changes: subscribe to `subagent/start`/`end` on
the cordis event bus, race the epoch against abort/promotion, suppress the
duplicated `subagent-settled` notice with a pop-once pre-step filter, and abort
via `ctx.subagents.interrupt` (exactly once, prompt synthetic resolution). The
normative design — collector loop, abort semantics, suppression, race register,
and TDD plan — is `docs/plans/2026-09-05-epoch-collector-dsh-cc.md`. The
harness-collectable-handle doc
(`docs/plans/2026-09-05-harness-collectable-handle.md`) remains the upstream
adoption path; because collection sits behind a small internal interface
(collector doc §7), that swap is one file when upstream lands.

### Slice 3 — collect refit + Ctrl+B promotion (dsh-cc only)

1. **Collect refit** (tool.ts execute branches, F2): non-fork foreground calls
   route through the epoch collector (see collector doc); same pin
   preallocation/tombstone parity with `startBackground` — a foreground-launched
   child is pinnable/resumable exactly like a background one, and
   `$CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`-forced foreground also gets pins.
2. **Outcome mapping**: `stopReason: completed` → tool result as today; all other
   stop reasons keep `settle`'s throw semantics with per-reason copy
   (aborted/error/max-tokens/refusal enumerated; tests pin the messages).
3. **Output schema**: optional `backgroundedByUser: true`.
4. **Promotion registry**: `ccCollectorRegistry` published as a root-realm
   service per the collector doc §6 (pattern
   `packages/bundle/cc-shell/src/ccPlugins.ts:121-133`) —
   `{parentSessionId+toolCallToken -> {childId, promote(), abort()}}`,
   registered before start, unregistered on any resolution; queried by the TUI
   keybinding (F9).
5. **TUI busy-branch Ctrl+B**: gated on (a) busy, (b) the root-realm
   `ccCollectorRegistry` non-empty for this session, (c) env kill switch unset;
   invokes `promote()` on the promotable collect(s) of this session; else falls
   through (idle behavior untouched).
6. **Esc mapping**: on the existing cancel path, each registered collect for
   this session aborts per the collector abort semantics (collector doc §4) —
   exactly-once interrupt; synthetic prompt resolve without awaiting
   settlement.
7. Tests: race matrix (settle-vs-promote, Esc-vs-promote, promote-before-acceptance,
   repeated Ctrl+B, N parallel collectors), exactly-once settlement delivery for both
   collected and promoted children, pin capture parity between collect and
   background paths, capacity-limit denial (§3.6), env parsing table, idle-Ctrl+B
   regression.
8. `BACKGROUND_SECTION_TEXT` + tool description: promotion, matrix, env var.
9. Capability manifest: promotion, `backgroundedByUser`, env var, capacity guard rows;
   regenerate docs same commit.

## 5. Verification

Per slice, the commit demonstrates: new tests green (`./node_modules/.bin/vitest`
inside the worktree — never `pnpm vitest`), `pnpm check:capabilities` and
`pnpm check:parity` green, and the slice's smoke list:

- Slice 0: render unit tests + busy-time LOCAL_SLASH regression + manual smoke on two
  live background children (`/agents`, `/agents <id>`, `/agents stop <id>`).
- Slice 1: repo-guard test + observable statement in commit message (pins return
  `async_launched` immediately when the flag is omitted).
- Slice 2: upstream PR merged + released + version pin bumped + dsh-cc capability gate
  test against the new version.
- Slice 3: full race matrix green; manual smoke: foreground pinned call, Ctrl+B →
  `async_launched + backgroundedByUser`, child settles into one wake; Esc smoke →
  child interrupted exactly once, no later wake.

PR body lists declared deviations (no global pin; env-var precedence piece;
TUI-vs-preset detail divergence) explicitly.

## 6. Load-bearing risks (post-review state)

### 6.1 Settlement delivery — resolved dsh-cc-side (no upstream changes)

Double delivery is ruled out dsh-cc-side: the pop-once suppression set in the
pre-step waterfall (collector doc §5) drops the `subagent-settled` notice for
independently collected epochs, while promoted children are removed from the
set and deliver normally. **Documented parity deviation:** for inline-collected
epochs the parent session log lacks the settlement account (it lives only in
the tool result); under the upstream handle it would have been structural.
Residual risk is bounded to the suppression-set lifetime, which dies with the
parent process (collector doc §8).

### 6.2 Signal ownership — covered

`abort()` on the handle is the only Esc/abort route for collecting children (F5);
tested exactly-once.

### 6.3 Keybinding conflicts

Busy-branch gating preserves idle `cursorLeft` (F10); tmux passthrough documented;
chord P1. Tests per §4 Slice 3 item 7.

### 6.4 Capacity — corrected and guarded

No upstream cap (F6); dsh-cc-side per-parent admission limit (§3.6) is the guard.
Interim risk between Slice 1 and Slice 3 noted: pins can raise resident children
before the guard ships — accepted for one-PR delivery (the whole feature lands on one
branch; the guard is in the same PR).

### 6.5 Busy-branch attribution

Registry-in-tool (F9) resolves it; residual risk is process restart mid-collect (the
registry is in-memory) — acceptable: a restarted session has no collecting waits.

## 7. Capability manifest and docs

Every slice updates `docs/claude-code-capabilities.yaml` in the same commit and
regenerates `docs/cc-parity-matrix.md` + README block via `pnpm docs:parity`
(pre-commit enforces). Rows: new `commands.agents`; `commands.tasks` cross-link;
`subagents.task-tool` matrix + promotion + `backgroundedByUser` + env var + capacity
guard. Deviations declared, not smoothed.

## 8. Non-goals

- Global "omit = background" default for all agents (deliberate, §3.1).
- `Done` group / epoch history / usage in `/agents` (needs a durable projection
  service — follow-up).
- `/agents attach` (P1), Ctrl+X Ctrl+B chord (P1), @-mention typeahead entries.
- Upstream pool-cap changes.
- Upstream adoption of the handle (tracked by the companion design doc, out of
  scope here).
- Live-conversion of one-shot runs (impossible per F11-adjacent substrate facts).

## 9. Rollout

1. Slices 0+1 (landed: ee9063b, 50ca96f).
2. Slice 2 collector (TDD per collector doc §9).
3. Slice 3 Ctrl+B.
4. Open one PR; body declares deviations; the upstream handle doc is attached
   as the future upstream proposal (not implemented).

## 10. Review provenance

Dual blind review (deep-reasoner/Opus and Codex GPT-5.4, blind to each other):
both REVISE. Convergent findings — pool-cap mischaracterization (now §6.4/F6),
`/agents` data thinness (now §3.2 descope), static delivery flag insufficient
(now §4 Slice 2 ownership handle), dedicated-intent seam (now §4 Slice 3.4/3.5).
Codex-unique: no result handle on `startContinuable` (§4 Slice 2), realm-isolation
mount (F8), busy-attribution gap (F9), parallel-Esc fan-out (§3.4), env-var
precedence unverified (§3.4), prompt-excerpt hygiene (§3.2), Ctrl+C copy (F10).
Deep-reasoner-unique: collect-path pin capture gap (§4 Slice 3.1), Slice-0-alone
prompt gap (fixed via Slice 1 text move), promotion-registry mechanism (adopted).
Resolution check (deep-reasoner): 11/12 findings CLOSED; two verification deltas
folded — realm-bridge decision is now Slice 0 task 1(c) spike output, and the §3.6
guard counts directly from `listChildren` (task 1(d)).
