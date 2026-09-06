# Plan-mode switching via the `/plan` command channel

Status: design, reviewed direction; implementation pending.
Owner surface: `@dsh-cc/command-permissions`, `@dsh-cc/tui`.

## 1. Problem

Shift+Tab cycling into `plan` in the TUI fails with the notice
`plan mode is not mounted in this composition`, and `/permissions plan` fails
with the same error. A second, silent defect: after entering plan mode via
`/plan on`, cycling away with Shift+Tab flips the rule-engine mode but never
exits plan, so the plan-mode write-deny overlay keeps blocking writes while
the statusline claims otherwise.

Three write entry points are affected by the first defect, one by the second:

| Surface | Code path | Today |
|---|---|---|
| TUI Shift+Tab | `cyclePermissionMode` → `applyMode` (`packages/ui/tui/src/harness/driver.ts:2055`, `:1306`) | errors, no switch |
| TUI permission picker | `permissionPickerSubmit` → `runHarness('/permissions <id>')` (`driver.ts:2216-2231`) | errors, no switch (via host command) |
| Browser popupSelect | client decoration submits `/permissions <id>` (`packages/interaction/command-permissions/src/client/index.ts`, `onSelect`) | errors, no switch (via host command) |
| (latent) leave plan via cycle | `applyMode` non-plan branch, `planMode?.set(agent, false)` (`driver.ts:1318-1319`) | silently skipped |

## 2. Root cause

`planMode` is a cordis **Service provided inside an entry-local isolate realm**
of the cc agent preset (`packages/preset/cc/agent.cordis.yml:118-128`,
`isolate: { planMode: true }`, vendored verbatim from upstream
`standard/agent.cordis.yml`). Under cordis realm semantics
(`deepseek-harness/vendor/cordis/src/reflect.ts`, `_getImpl`), a service
provided under an isolated key is invisible to every `ctx.get` outside that
subtree — it resolves to `undefined`, no throw.

Both broken call sites do exactly that: `ctx.get('planMode')` from the
host-plane TUI driver context (`driver.ts:1308`) and from the preset-scope
host command context (`command-permissions/src/index.ts:91`). Meanwhile the
tui profile's patch disables the host-plane `plan-mode` row by design
(`packages/bundle/cc-tui/cordis.patch.yml:43-44`, mirroring dsh-web-app), so
no host-realm instance exists. The notice text is literally accurate.

Upstream dsh never consumes `planMode` from outside the realm. The single
sanctioned cross-plane write path is the **`/plan` command**, which plan-mode
registers itself (`deepseek-harness/packages/plan/plan-mode/src/index.ts:296`
— handler closes over the realm context). The upstream web UI switches plan
mode exclusively this way (`apps/web/tests/plan-control-row.e2e.ts`).

## 3. Design constraints

1. **CC parity is the product contract.** Real Claude Code presents `plan` as
   a permission mode: Shift+Tab cycles into it, the statusline shows it.
   `docs/cc-parity-matrix.md#cap-engine.plan-mode` tracks plan mode as ✅. The TUI cycle is
   deliberately sourced from the same `PERMISSION_COMMAND_MODES` list as
   `/permissions` (`packages/ui/tui/src/mode-cycle.ts`: "so the cycle cannot
   drift from the `/permissions` list"). Dropping `plan` from the list would
   strip it from picker, popup, and cycle in one move.
2. **Ownership stays with plan-mode.** The rule engine refuses `plan`
   outright (`packages/interaction/command-permissions/../permission-rules/src/index.ts:468-469`:
   `permission mode "plan" is owned by plan-mode`). Any fix must keep
   `PlanModeController` the single owner of plan state; façades may delegate,
   never reimplement.
3. **Only the command channel leaves a replayable trace of queued intent.**
   A mid-turn `/plan` is queued as a pending intent applied at the next
   accepted pre-step. The logged `command/run` (`name: 'plan'`) +
   `command/done` pair (`plan-mode/src/index.ts:255-291`) lets the plan
   projection restore the pending-aware *phase* across a restart, so guards
   (§5) and any client display stay truthful. Caveat, verified upstream: the
   intent application itself lives only in the in-memory `pendingIntents`
   WeakMap (`plan-mode/src/index.ts:466-489`) and is **not re-armed after a
   host restart** — a switch queued but not yet committed at restart
   survives as a stale `entering`/`leaving` phase and resolves no-op on the
   next explicit switch. That is a pre-existing upstream limit, unchanged by
   this design. What remains true: a direct `planMode.set()` from the host
   plane would skip the log pair entirely and break even the phase restore —
   the command channel is not a workaround, it is the seam.
4. **The vendored preset must diff clean.** `tests/composition.spec.ts`
   (packages/preset/cc) gates drift against upstream; the preset file is not
   a lever.
5. **Honest degradation stays.** A composition genuinely lacking plan-mode
   (row disabled/removed) must keep failing with the existing, accurate
   not-mounted error rather than a silent no-op.

## 4. Decision

Keep `plan` in `PERMISSION_COMMAND_MODES` (both surfaces, per constraint 1).
Make `/plan` (command channel) the single write path for entering and
leaving plan mode, and drive the leave-guard from a **pending-aware plan
phase** read instead of a bare fold. Remove every `ctx.get('planMode')`.

Concretely, two host-side call sites change; everything else heals
transitively:

- `/permissions` host command plan/exit branches
  (`command-permissions/src/index.ts:90-105`) — fixing this one heals the
  picker, the browser popup, and typed `/permissions …`, because all three
  already submit `/permissions <mode>` through the command channel.
- TUI `applyMode` (`driver.ts:1306-1327`) — the Shift+Tab path.

## 5. Core abstraction: the plan phase

The exit guard must see *queued* intent, not just committed state. plan-mode
already folds exactly this into the session-projection unit keyed `'plan'`
(`plan-mode/src/index.ts:262-291`, `stateVersion: 2`), recoverable from the
log alone. The registry is host-plane
(`deepseek-harness/packages/bundle/base/cordis.patch.yml:126-127`), mounted in
the tui profile (the cc-tui patch does not disable it), and readable from both
call sites via `ctx.get('sessionProjections').stateOf(session, 'plan')`
(`deepseek-harness/packages/session/session-projection/src/index.ts:288`).

The unit state is `{ active, wanted, running }`; its wire view defines
pending as `(running?.wanted ?? wanted) !== null && ≠ active`. We lift that
into a four-phase model — the only predicate every caller needs:

```ts
type PlanPhase = 'off' | 'entering' | 'on' | 'leaving'
// off:      !active && !pending      — enter by dispatching '/plan'
// entering: !active && pending       — a queued entry is in flight
// on:       active  && !pending      — enter is a no-op
// leaving:  active  && pending       — a queued exit is in flight
```

New pure, browser-safe helper `planPhaseOf(events, planState)` in
`@dsh-cc/command-permissions` (alongside `modes.ts`, which both the
host command and the TUI already import):

- `planState` is the structural minimum
  `{ active: boolean; wanted: boolean | null; running: { wanted: boolean } | null }`
  (re-declared structurally; no cross-package type import of upstream internals).
- When `planState` is `undefined`, degrade to
  `foldPlanMode(events) ? 'on' : 'off'`. Both shipped profiles mount the
  registry through the upstream base bundle, so this fallback only fires in
  custom minimal compositions that omit `session-projection` — there
  `entering`/`leaving` collapse into `off`/`on` and the §7
  entering-then-switch-away cancellation guarantee is lost; committed state
  stays exact.

Driver and host command each resolve `planState` from their own context;
both are inside the host realm, so the host-plane registry is reachable.

## 6. Mechanics per call site

### 6.1 `/permissions` host command (`command-permissions/src/index.ts`)

`inject = ['commands']` already holds (`:52`) — the channel is in hand.

```
executePermissions(ctx, invocation):
  mode validation unchanged.
  if mode === 'plan':
    phase = planPhaseOf(agent.session.events, planState(ctx, agent.session))
    if phase === 'on':
      return success `Permission mode is now "plan".`        // honest no-op, avoids upstream noop wording
    return relay(commands.execute(agent, '/plan', [], signal))
      // undefined  → error 'plan mode is not mounted in this composition'   (constraint 5)
      // otherwise  → return the inner CommandResult verbatim (kind + text), no wrapper
      // images arg stays []: /permissions declares no input.images, so the
      // command admission rejects image-bearing invocations before the
      // handler runs — forwarding attachments would be unreachable code.
  else:
    phase = planPhaseOf(...)
    if phase !== 'off':
      result = commands.execute(agent, '/plan off', [], signal)
      if result is undefined: return error (same not-mounted text)
      if result.kind === 'error': return it       // a failed exit must not strand the mode switch half-done
    service.setMode(agent, mode)                  // engine rejects 'plan' — unreachable here
    return success `Permission mode is now "<mode>".`
```

Hard rules:

- **Dispatch bare `/plan`, never `/plan on`.** The upstream handler steers
  any non-`off` argument into the conversation as a user message
  (`plan-mode/src/index.ts:322-341`); `/plan on` would inject the literal
  text "on". Pin the exact line with a test (§9).
- **`/plan off` strictly before `setMode`.** The engine overlays plan over
  every other mode at evaluation time; switching the underlying mode while
  plan is still on is invisible work at best.
- The inner result text is relayed as-is ("Plan mode on. Use /plan off to
  leave.", "Entering plan mode (applies from the next step).", …). One
  narration line per surface, no double wrapper.
- `signal`: pass `invocation.signal` when present, else a fresh
  `AbortController().signal` (mirrors the TUI's existing call shape).

### 6.2 TUI `applyMode` (`driver.ts:1306-1327`)

The write becomes async; rapid Shift+Tab presses must not interleave exits
and engine switches. Serialize per driver instance:

```ts
let modeWrites: Promise<void> = Promise.resolve()
const applyMode = (mode: PermissionCommandMode): void => {
  modeWrites = modeWrites.then(() => applyModeInner(mode)).catch(showErrorNotice)
}

applyModeInner(mode):
  if mode === 'plan':
    const result = await runHarness('/plan')      // tri-state, see below
    if (result === undefined) showNotice('plan mode is not mounted in this composition')
    return                                        // NO optimistic emit — display waits for plan/mode
  if (planPhaseOf(events, planState) !== 'off'):
    const exit = await runHarness('/plan off')
    // Hard rule (mirrors §6.1): a failed or unmatched exit must NOT strand
    // the switch half-done — abort before touching the engine mode.
    if (exit === undefined) { showNotice('plan mode is not mounted in this composition'); return }
    if (exit.kind === 'error') return
  … existing rules-undefined notice, rules.setMode(agent, mode), emit(setPermissionMode(state, mode))
```

Supporting changes:

- `runHarness(line)` (`driver.ts:1818-1829`) returns a tri-state
  `Promise<CommandResult | undefined | null>`: `null` = no command registry
  (today's `No command registry is mounted.` notice, unchanged);
  `undefined` = registry present but the line matched no command (callers
  map it to the not-mounted notice); otherwise the `CommandResult`, whose
  non-empty text is echoed as a status row exactly as today. The picker
  call site (`driver.ts:2231`) ignores the return — behavior unchanged.
- Serialization is per-driver and covers only the Shift+Tab writer. The
  picker and typed `/permissions …` bypass `modeWrites` deliberately: every
  host-command execution re-derives the phase guard at dispatch time,
  plan-mode's `set()` is convergent (an overlapping second `/plan off` is a
  no-op), and `session.append` is synchronous, so any human-scale
  interleaving converges on the session log. If a future surface writes
  modes *without* re-deriving the guard, route it through `modeWrites` —
  do not grow a second queue.
- Delete `PlanModeLike` and both `ctx.get('planMode')` reads.
- Delete the optimistic `emit(setPermissionMode(state, 'plan'))` in the plan
  branch: the display already re-folds on `plan/mode` (`driver.ts:1065-1067`
  → `liveMode`, `driver.ts:573-576`), so an idle enter flips the statusline
  when the event lands, and a queued enter stays truthful until the pre-step
  commit — the echoed "applies from the next step" row narrates the wait.
- `cyclePermissionMode` (`driver.ts:2055-2060`) and the `Driver` interface
  stay synchronous (fire-and-forget into `modeWrites`); input/root callers
  unchanged.

### 6.3 Surfaces that intentionally do not change

- TUI permission picker and browser popupSelect — both already submit
  `/permissions <id>`; fixed transitively by §6.1.
- `mode-cycle.ts`, `modes.ts` lists — `plan` stays (constraint 1).
- `transcript.ts` `plan/mode` / `permission/mode` folds (`:315-325`) and the
  session-switch re-fold — the display source of truth is untouched.

## 7. Semantics matrix (post-fix)

| Situation | Action | Result |
|---|---|---|
| Idle, any → plan | `/plan` commits immediately → `plan/mode` event | statusline flips on the event; row: "Plan mode on. …" |
| Mid-turn → plan | queued as pending intent (`command/run` logged) | row: "Entering plan mode (applies from the next step)."; statusline flips at pre-step commit; a restart before that commit restores the `entering` phase from the log pair but does not re-arm the intent (upstream limit, §3.3) — it resolves no-op on the next explicit switch |
| plan `on` → other mode | `/plan off` commits, then `setMode` | two narrations (off + mode), overlay lifts, engine mode flipped |
| plan `entering` → other mode | guard sees pending → `/plan off` cancels the queued entry ("Plan mode entry cancelled."), then `setMode` | **the latent re-activation bug is dead** |
| plan `leaving` → cycle again | `/plan off` idempotently re-narrates, `setMode` proceeds | no harmful re-entry |
| plan `on`, enter plan again (typed `/permissions plan`) | §6.1 no-op pre-check | `Permission mode is now "plan".` |
| Composition without plan-mode | `execute` unmatched → undefined | existing not-mounted error, verbatim (constraint 5) |

## 8. Rejected alternatives

- **Drop `plan` from `/permissions` / the cycle ("removal").** Violates
  constraint 1 and does not even remove the hazard class: `/plan on` always
  exists (registered by plan-mode itself), so Shift+Tab while in plan would
  become a *silent* half-switch — today it is at least an honest error.
  Fixing the guard is mandatory either way, and with the guard in place the
  delegation branch costs ~10 lines over removal.
- **Expose `planMode` to the host realm** (re-enable the host row, or
  re-declare the isolate with a shared realm label). Re-enabling creates a
  second `PlanModeController` — the realm instance serving `/plan`,
  `exit_plan_mode`, and the `plan:policy` section diverges from the decoy.
  A shared label forks the vendored preset and fails the drift gate
  (constraint 4). And any direct `set()` loses restart durability for queued
  switches (constraint 3).
- **Read pending by re-folding `command/run`/`command/done` in dsh-cc.** The
  projection unit already implements exactly this fold with a versioned
  schema; duplicating it invites drift against `stateVersion`. The
  events-only fallback exists only for headless assemblies.

## 9. Test plan

Current tests cannot catch this bug class: they provide a fake `planMode` at
the root context (`command-permissions/tests/command-permissions.spec.ts:42`)
— precisely what the realm forbids in production.

1. **`command-permissions` unit tests** — fake `commands` service (capture
   `execute` calls), fake/stub `sessionProjections`; remove the root
   `planMode` provider.
   - `/permissions plan` dispatches exactly `'/plan'` (regression pin for the
     steer trap) and relays the inner result verbatim (kind + text).
   - `execute → undefined` ⇒ the not-mounted error survives.
   - plan `on` + `/permissions auto` ⇒ call order: `execute('/plan off')`
     **before** `setMode('auto')`.
   - phase `entering` (projection says pending, fold says off) +
     `/permissions auto` ⇒ still exits first.
   - phase `on` + `/permissions plan` ⇒ pre-check no-op, no `execute` call.
   - error from `/plan off` propagates and blocks `setMode`.
2. **TUI driver unit tests** (`packages/ui/tui/tests/driver-permissions.spec.ts`)
   — fake agent + fake `commands`.
   - cycle into `plan` ⇒ `execute('/plan')`; statusline does **not** flip
     optimistically; after injecting a `plan/mode` event, it shows `plan`.
   - plan `on` + cycle away ⇒ `/plan off` ordered before the engine switch;
     statusline lands on the target mode.
   - pending-only projection state ⇒ cycle away still issues `/plan off`.
   - `execute → undefined` ⇒ the not-mounted notice; rejected execution ⇒
     notice with the message (no unhandled rejection).
   - two rapid cycle presses ⇒ writes serialize (second starts after first
     resolves).
3. **Realm-boundary static gate** — a test asserting the literal
   `get('planMode')` no longer appears in
   `packages/ui/tui/src/**` or `packages/interaction/command-permissions/src/**`.
   This is the class of bug a mock-heavy suite structurally misses.
4. **Composition-level integration (mandatory).** Items 1-2 mock
   `commands`, so none of them pins the runtime assumption that a
   host-command context resolves `/plan` through the scope layers
   (`commands.execute` resolves per-agent views,
   `deepseek-harness/packages/interaction/commands/src/index.ts:427-429`) —
   which is exactly the assumption today's bug broke. Landed as
   `packages/interaction/command-permissions/tests/plan-channel.integration.spec.ts`:
   boots the essential slice in-process with real services (session store,
   command runtime, system prompt, tools) and plan-mode mounted behind a
   real `ctx.isolate('planMode')` realm — pinning that
   `ctx.get('planMode')` is undefined while `/permissions plan` still
   switches, exits, and no-ops correctly. The full preset-roster boot is
   intentionally not used: this slice discriminates the wiring with far
   less boot weight. Verified red against the pre-fix source: it is the
   test that would have caught the realm bug at introduction.
5. **`mode-cycle.spec.ts`** — untouched: `plan` remains in the cycle; existing
   expectations keep passing and thereby pin constraint 1.
6. Optional e2e mirroring upstream `plan-control-row.e2e.ts` — browser popup
   "Plan" selection narrates the commit; manual TUI Shift+Tab pass over the
   full cycle including mid-turn entry/exit.

## 10. Text and docs touch-ups

- `permission-rules/src/index.ts:469` error text:
  `use planMode.set or /permissions plan` → `use /plan or /permissions plan`
  (`planMode.set` is unreachable outside the realm; the message currently
  sends a future author down the same broken road).
- `command-permissions` module docstring (`index.ts:1-26`): the write path
  sentence now reads: engine modes route through `setMode`; `plan` routes
  through the `/plan` command channel.
- `docs/cc-parity-matrix.md#cap-engine.plan-mode`: extend the plan-mode note —
  `Shift+Tab / /permissions plan switch into it through the /plan command channel`.

## 11. Definition of done

- [ ] `/plan` is the only write seam; zero `ctx.get('planMode')` outside
      `dsh-plan-mode` internals (grep gate green).
- [ ] All four surfaces switch into and out of plan; queued entry cancels
      cleanly when cycling away mid-turn.
- [ ] Not-mounted compositions still report the exact original error.
- [ ] §9 items 1-4 green; existing suites unaffected.
- [ ] §10 text/doc updates landed in the same change.
- [ ] Manual pass: Shift+Tab full cycle on a live session, including
      mid-turn entry, mid-turn cancel, resume-then-cycle.

## 12. Non-goals (tracked, not blocking)

- **Pending-state statusline affordance.** During a queued entry the
  statusline truthfully shows the pre-switch mode. A "→ plan" pending hint
  sourced from the same projection (the driver's existing projection-read
  pattern, cf. `driver.ts:1782-1787` for `tokenUsage`) is polish for a later
  slice.
- **Upstream noop-enter wording.** `/plan` while entering already answers
  "Entering plan mode (applies from the next step)." — relayed verbatim by
  design; the common active case is pre-empted by §6.1's no-op branch.
- **Cycle gating for `bypassPermissions`.** Observed in passing: Shift+Tab
  can reach bypass without the picker's `BYPASS_CONFIRMATION` gate
  (`driver.ts:2055-2060` never passes `bypassDisabled`). Pre-existing,
  orthogonal; file separately.
