# Workflow saved commands and progress observability

Date: 2026-09-22. Status: **Proposed**. Origin: dynamic-workflow three-way
investigation. Depends on: `2026-09-22-workflow-cc-parity-core.md` (name
resolution, save locations, prompt section). Optional synergy:
`2026-09-22-workflow-resume-journal.md` (journal as the per-agent evidence
trail). Design-review record: cold review (three-way parallel, 2026-09-22) —
**GO-WITH-AMENDMENTS applied**: two falsified anchors corrected
(`ui-workflow-run` consumes durable `tool-workflow/*` session events, not the
`workflow/*` cordis family — the canary argument is replaced; the TUI event-tap
precedent re-cited to `driver-catalog.ts:248`); the builtin-collision skip-warn
was found unimplementable at the provider layer (TUI-local commands never enter
the harness registry and silently win) — rescoped to registry collisions with
the TUI-local shadow documented as a known limitation; phase exact-match is now
stated as a convention, not a guarantee, with the row echo-only. Amendment
compliance re-review (2026-09-22): all five items RESOLVED; one residual wording
fix applied (§5 pins five payloads, matching the unsubscribed `log`).

## 1. Problem

Two documented CC surfaces remain after the core slice:

1. **Saved workflows run as `/<name>`.** CC's save flow (`/workflows` → select
   run → `s`) lands a script in the project or user workflows directory and the
   saved workflow is invocable as `/<name>` in future sessions. Without command
   mounting, a saved workflow in dsh-cc is only reachable by asking the model to
   pass `name` to the workflow tool — one extra model turn per invocation and no
   discoverable surface.
2. **Progress visibility.** CC renders workflows "grouped by phase" in a
   progress view and a `/workflows` runs panel with per-agent rows and cancel
   keys. dsh-cc's core slice delivers only the launch receipt and the final
   consolidation; mid-run the user sees nothing.

## 2. Current state (anchors verified 2026-09-22)

- dsh-cc has a working precedent for scanning CC-style directories and turning
  entries into slash commands: `packages/compat/cc-plugin-loader/src/commands.ts`
  mounts plugin `commands` entries via the typed commands seam
  (`register({name, description, input?, handler})`, effect-scoped), dispatching
  a composed user message (`agent.followup`). `skill-claude-code` discovery scans
  the same class of directories for skill material but feeds the skills catalog,
  not slash commands. The harness command registry itself is **live** (the TUI
  re-lists on every catalog refresh); making the scan session-start-only is this
  provider's deliberate choice, matching CC's "available in future sessions"
  phrasing and avoiding mid-session refresh races (users can always run by
  `name` through the tool today).
- Command definitions support argument pass-through and the universal `help`
  tail (`@dsh-cc/command-usage`, PR #6): a generated `/<name>` command gets
  `/<name> help` for free by using `helpable()` on a fixed descriptor.
- The engine already emits cordis events for every run: `workflow/start`,
  `workflow/phase`, `workflow/log`, `workflow/agent-start`,
  `workflow/agent-end`, `workflow/end`, each carrying
  `WorkflowRunInfo {id, meta}` plus per-event detail
  (deepseek-harness `packages/workflow/workflow/src/index.ts:36-100`). The
  declared `emitWorkflowEvent` helper lives on the abstract base class
  (`:174-189`); the concrete emission call sites are host-side in
  `workflow-worker-thread/src/index.ts:182-201`, so events fire on the host
  context and reach an idle TUI renderer under the local-driver composition
  (cc-tui's driver and the engine share the host ctx). `phase()` accepts any
  non-empty string (`workflow-worker-thread/src/runtime.ts:469-475`): matching
  with `meta.phases[].title` is a documented convention, **not** an engine
  guarantee.
- dsh-cc's TUI taps lifecycle cordis events directly from the driver — the
  established shape is `rt.ctx.on('subagent/start', …)` in
  `ui/tui/src/driver-catalog.ts:248` (plus `driver-agent.ts` listeners), so a
  `workflow/*` listener feeding a status row follows a proven local pattern.
- The harness web client renders workflow runs in
  `packages/client/ui-workflow-run`, but from **durable session events**
  (`tool-workflow/run-start|agent-start|agent-end|run-end`), not the cordis
  family — there is no phase-transition session event (phase rides as a
  per-agent label there). D2 is therefore a first-of-kind consumer of the
  `workflow/*` cordis events; the regression tripwire is a typed compile-time
  dependency on `@deepseek-ai/dsh-workflow` types in cc-tui plus a contract
  test, not the web client's tests.

## 3. Design

### 3.1 `/<name>` command mounting (D1)

A new provider inside `packages/core/tool-workflow` (no new package):

- At session start, scan `<cwd>/.claude/workflows/*.js` and
  `<dshHome>/workflows/*.js`; project shadows user on name collision (same rule
  as name resolution in the core slice — one rule, two consumers).
- Each file becomes a slash command `/<name>` whose handler composes a fixed
  instruction: "Run the workflow named `<name>` via the workflow tool. User
  arguments, verbatim, are: …" — the command body never inlines the script
  (keeps the file the single source of truth and keeps the command payload
  tiny); the tool's `name` resolution does the fetch. User text after the
  command name is passed through as free-form args context; structured `args`
  stay model-authored per CC semantics.
- Collision policy is registry-scoped: the harness registry throws "already
  registered in this scope" on duplicates (`interaction/commands`), so we
  try/catch and **skip with a warn** — the plugin-loader precedent
  (`commands.ts`'s `tally.addSkipped` path). The warn surfaces through the boot
  tally channel plugin skips use, plus `ctx.logger.warn`. Registration order
  between this provider and the plugin loader is not guaranteed, so either side
  may win a given collision; the warn names the winner and the resolution
  (rename the file). Two admitted limits: file names failing the registry
  regex `/^[a-z][a-z0-9_-]*$/` are skipped with a reason line; and names
  matching TUI-local slash commands (`clear`, `model`, …) register fine
  server-side but are **silently shadowed** in the TUI, because locals never
  enter the harness registry — documented limitation, with the workflow still
  fully reachable via the tool's `name` param (the skip line says so).
- Save flow: none. CC's `s`-key dialog is a TUI surface; per the core slice's
  prompt section, the model saves on explicit user request via its `write` tool,
  and the new command appears next session. This asymmetry vs CC is recorded in
  the manifest deviation rather than compensated with new UI.
- Descriptor discipline: generated commands go through `helpable()` so `/<name>
  help` prints the meta description + file path; descriptors are read-only
  wrappers, never executable handlers of their own.

### 3.2 Progress row in cc-tui (D2)

Minimal, non-blocking, and strictly passive:

- A cc-tui subscription to `workflow/start|phase|agent-start|agent-end|end`
  maintains one status row per active run (the core slice guarantees at most
  one): `running <elapsed> · phase <currentPhaseTitle> · agents
  <settled>/<started>`, driven by the engine's cordis payloads (the row is the
  first consumer of that family; see §2's tripwire note). The row **echoes**
  emitted phase titles and counts agents; it never groups or validates against
  `meta.phases` (exact-match is convention, not guarantee — §2). `workflow/log`
  is deliberately not subscribed: per-run log lines are high-volume and the
  consolidated result already arrives via the core slice's wake.
- Rendering follows the existing statusline/resize discipline (render-time
  width; no reflow of history); the row vanishes on `workflow/end`.
- No interactivity in this slice: no cancel key, no expansion, no `/workflows`
  panel. Cancellation remains out of scope (core slice §3.5 records the gap);
  adding keys is a separate slice once pause/cancel semantics exist end-to-end.
- Absence is total: profiles without the workflow engine enabled subscribe to
  nothing and allocate no row.

### 3.3 Manifest and gates

`engine.workflow` gains `/<name>` command mounting + passive progress row as
implemented items; deviations remaining after this slice: no `/workflows` panel,
no save dialog, no pause/cancel keys, session-start scan staleness (new saves
mounted next session; run-by-`name` works immediately), TUI-local-name silent
shadowing. Validator discipline: the row's dimensions stay consistent (I3) and
its evidence anchors point at package sources plus the existing preset row —
D1/D2 add no preset row, so no new I4 anchor is needed and no reordering (I7)
is triggered. docs:parity regenerated in the same commit.

## 4. Expected effect

- Repeated-team workflows (`review this branch`, `audit routes`) become
  one-token invocations with zero model round-trip spent describing the script.
- Long runs stop being invisible: the user sees phase + fan-out progress where
  previously the session looked idle between launch and wake.

## 5. Non-goals and risks

**Non-goals.** `/workflows` runs panel with selection/pause/cancel; save dialog
UI; mid-session catalog refresh (the session-start-scan staleness is this
provider's deliberate choice, with run-by-`name` as the same-session
workaround); remote/team-shared workflow galleries; editing workflows from the
TUI.

**Risks.**

- *Catalog staleness surprise* — mitigated by the boot tally line naming the
  mechanism (save → mounted next session, or `name`-param today) and by a
  `/<name> help` output that prints the file path actually mounted.
- *Name collisions* — the harness registry throws on duplicates; we skip-warn
  (plugin-loader precedent). Registration order vs the plugin loader is not
  guaranteed, so the warn names the actual winner; TUI-local names are a
  documented silent-shadow limitation with the tool `name` param as the escape
  hatch.
- *Event-shape coupling* — the progress row trusts `workflow/*` payload shape;
  a harness change breaks the row but never the runs (passive listener, try/
  catch per event, worst case the row freezes and is cleared on `workflow/end`).
  No existing consumer watches the cordis family (the web client watches
  session events), so the tripwire is ours: a typed compile-time dependency on
  `@deepseek-ai/dsh-workflow` types in cc-tui plus a contract test pinning the
  five event payloads the row reads (the unsubscribed `log` is excluded).
- *TUI row lifecycle under session clear/resume* — `/clear` mid-run drops the
  row but the run continues; on completion the core slice's wake still delivers
  (the row is cosmetic state only).

## Acceptance (DoD)

1. Unit tests: two-directory scan with project-shadowing; registry-collision
   skip-warn (plugin-name case) with the winner named; file names failing the
   registry regex `/^[a-z][a-z0-9_-]*$/` skipped with a reason line; generated
   descriptor help output printing the mounted file path; malformed workflow
   file (directory contains a non-script) does not poison the command mount;
   user free-text passes through to the composed instruction.
2. cc-tui tests: event sequence drives row contents (phase transition,
   settle-ratio, end-clears-row); listener never throws on malformed payloads.
3. Composition: core package rows unchanged except new code paths;
   `smoke:profile-boot` green; catalog snapshot semantics asserted (save during
   session → not listed this session).
4. Manifest + docs:parity regenerated; deviations list matches §3.3 exactly.
5. Dogfood: save a workflow (via the model, `write` tool), start a fresh
   session, invoke `/<name>`, observe the progress row through a 3-phase script
   and one consolidated wake.
