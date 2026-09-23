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
Pre-implementation audit (2026-09-23, both landed dependencies in tree — core
slice PR #116, resume-journal PR #117): all anchors re-verified against the
current code; **five amendments applied**: (1) the driver-catalog anchor path
gained its `packages/…/harness/` prefix (line number unchanged); (2) the
"boot tally channel" skip-surfacing claim was falsified — the ComponentTally
channel is the plugin loader's own mount report consumed by `CcPluginsService`,
and this provider has no such consumer; surfacing is rescoped to
`ctx.logger.warn` + `/<name> help` text + one clause in the `tool:workflow`
prompt section; (3) scan-time behavior pinned: each `*.js` candidate is parsed
with the core slice's strict meta parser and invalid-meta files are skipped
with a reason line (CC parity: invalid meta drops the command from
autocomplete); (4) D1's mounting point pinned to the EXISTING tool-workflow
plugin's `apply` (no new preset row, keeping §3.3's I4 claim true), probing
`ctx.get('commands')` instead of declaring an inject; (5) three CC-doc drift
items recorded as deviations (CC's `/reload-skills` mid-session re-read,
monorepo multi-root `.claude/workflows` loading since CC v2.1.178, and the
`/workflow-authoring` bundled skill since CC v2.1.248). Focused compliance
re-review of those amendments (2026-09-23, cold): **GO-WITH-AMENDMENTS**, six
findings, all applied in place: (F1) scan cwd pinned to `process.cwd()` with
the session-cwd divergence class named — the tool resolves
`exec.agent.session.header.cwd ?? process.cwd()` at launch
(`launch.ts:139`) but no agent exists at apply time, and the only apply-time
scan precedent uses `process.cwd()` (`ccPluginManager.ts:43`); (F2) the "new
1s tick" was killed — `tests/no-polling.spec.ts` whitelists exactly one file
(`packages/ui/tui/src/components/working-line.ts:1-6`), and riding the
existing WorkingLine instance's `messageFn` is ALSO wrong because the root
stops that instance when no turn is active — precisely when a background
workflow run needs the row; the pinned shape is a SECOND WorkingLine instance
for the workflow row, so interval creation stays inside the single
whitelisted file and `tests/no-polling.spec.ts` is untouched; (F3) the skip
taxonomy gained the parse-ok/shape-invalid class — `extractInlineMeta`
validates literal-ness only and returns `meta: unknown`, so the scan
replicates the engine's shape rules (harness
`workflow-worker-thread/src/meta.ts:13-44`); (F4) "one row per session"
reframed: the single-run guarantee is per SESSION while `workflow/*`
payloads carry no session attribution and cordis emit is unfiltered
process-wide — the row is process-scoped, labeled accordingly (the
driver-catalog `subagent/start` posture); (F5) two anchor paths fixed; (F6)
resume-mid-run row fallback pinned (no `workflow/start` replay on resume:
the row appears on the first observed event for an unknown run id, elapsed
counted from that first observation). Compliance re-review of
the fixes (2026-09-23): all six RESOLVED; two residuals applied (§2's stale
"one row per session is a guarantee" reworded to the per-session registry
fact + render-latest policy; WorkingLine teardown pinned on the driver
dispose path in addition to `workflow/end`, and the root.ts slot pinned
against the 500-line cap — wiring lives in a new
`packages/ui/tui/src/harness/workflow-row.ts` module). **Design review
closed — GO.**

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
  `WorkflowRunInfo {id, meta}` plus per-event detail (payloads verified
  2026-09-23 against deepseek-harness
  `packages/workflow/workflow/src/index.ts:31-100`:
  `start(info)`, `phase(info, title)`, `log(info, message)`,
  `agent-start(info, agent)`, `agent-end(info, agent)`, `end(info, result)`).
  The declared `emitWorkflowEvent` helper lives on the abstract base class
  (`:170-186`) and already contains listener failures (throw and rejection
  alike are caught and logger-warned); the concrete emission call sites are
  host-side in `workflow-worker-thread/src/index.ts:182-201`, so events fire
  on the host context and reach an idle TUI renderer under the local-driver
  composition. Reachability from a preset isolate realm up to the TUI driver's
  `rt.ctx` is not an assumption: `ccPlugins/change` is emitted on the
  cc-shell-glue fiber inside the preset's `cc-services` isolate realm
  (`packages/bundle/cc-shell/src/ccPlugins.ts:191,228`) and is heard by the same
  `rt.ctx.on` pattern in driver-catalog — the delegation realm the engine
  lives in sits at the same agent-ctx depth. (Verified at cordis source:
  `ctx.events` is one root-level EventsService shared by every realm, and
  plain `ctx.emit` passes no `thisArg`, so dispatch is unfiltered —
  `vendor/cordis/src/events.ts:165-197`; the engine's `emitWorkflowEvent`
  takes the same unfiltered path.) The same unfiltered property means the
  payloads carry NO session attribution — see §3.2's process-scoped posture. `phase()` accepts any
  non-empty string (`workflow-worker-thread/src/runtime.ts:471-477`): matching
  with `meta.phases[].title` is a documented convention, **not** an engine
  guarantee (CC's own docs: a `phase()` title with no `meta.phases` entry
  gets a progress group of its own).
- dsh-cc's TUI taps lifecycle cordis events directly from the driver — the
  established shape is `rt.ctx.on('subagent/start', …)` in
  `packages/ui/tui/src/harness/driver-catalog.ts:248` (plus `driver-agent.ts`
  listeners), so a `workflow/*` listener feeding a status row follows a proven
  local pattern.
- The run registry enforces a single active run per session
  (`packages/core/tool-workflow/src/registry.ts:228-236`) — the only
  guarantee the row's process-scope needs; a process can still hold one
  active run per session, hence the render-latest policy (§3.2).
- The core slice resolves `name` against exactly two directories
  (`packages/core/tool-workflow/src/launch.ts:76-91`):
  `<cwd>/.claude/workflows/<name>.js` first, then
  `<dshHome>/workflows/<name>.js` (via `resolveDshHome()`), file name
  governing lookup on a meta-name disagreement. The strict literal meta
  parser `extractInlineMeta` is already exported from the same package —
  the scan reuses it, so "invalid meta" means exactly one thing across the
  tool and the command catalog.
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

No new package and **no new preset row**: the scan lives in the existing
`@dsh-cc/tool-workflow` plugin's `apply` (a new `commands.ts` module in the
same package, called from `apply`), mounted by the preset row the core slice
already added. This keeps §3.3's I4 claim true and the command lifecycle
effect-scoped to the same fiber as the tool. The provider probes
`ctx.get('commands')` (the plugin-loader posture — `cc-plugin-loader`'s
`mountCcPlugin` resolves the seam the same way from inside a preset realm)
and skips the whole mount with one logger line when the seam is absent;
`inject` is unchanged, so compositions without a commands registry and
`smoke:profile-boot` are unaffected.

- At session start (i.e. when the preset fiber mounts, once per agent), scan
  `<cwd>/.claude/workflows/*.js` and `<dshHome>/workflows/*.js`; project
  shadows user on name collision (same rule as name resolution in the core
  slice — one rule, two consumers, made structural: the directory pair is
  extracted from `launch.ts` into an exported `savedWorkflowDirs(cwd)` helper
  consumed by both `resolveScriptSource` and this scan). The scan's cwd is
  pinned to `process.cwd()`: no agent/session exists at apply time, and the
  only apply-time directory-scan precedent uses `process.cwd()`
  (`ccPluginManager.ts:43`). The tool's `name` resolution instead uses
  `exec.agent.session.header.cwd ?? process.cwd()` at launch
  (`launch.ts:139`), so in a session whose header cwd differs from the
  process cwd (API/headless compositions; a resumed session started
  elsewhere) the mounted `/<name>` set can diverge from what the tool
  resolves — a named, recorded deviation: the local-TUI composition always
  has header cwd == process cwd at mount, and a miss surfaces the tool's
  existing "probed <dirs>" error with `scriptPath` as the escape hatch.
- Scan-time parsing: each candidate file is read and run through the core
  slice's strict literal meta parser (`extractInlineMeta`), then — because
  that parser validates literal-ness only and returns `meta: unknown` —
  through a local replication of the engine's shape rules (name and
  description non-empty strings, no unknown fields, `phases` entry shape;
  source of truth: harness `workflow-worker-thread/src/meta.ts:13-44`, kept
  in sync by a comment-pinned contract test). A file failing EITHER check is
  **skipped with a reason line naming the failing check** (CC parity: CC
  drops such workflows from `/` autocomplete); it never poisons sibling
  mounts and stays reachable via `scriptPath`. Without the shape check a
  parse-ok/shape-invalid file would mount a command whose every invocation
  the engine then refuses — a listed-but-always-broken command. Non-`*.js`
  directory entries are ignored. The slash-catalog description comes from
  `meta.description` (guaranteed non-empty by the shape check); the command
  name is the file basename (file name governs lookup, per the core slice's
  disagreement rule).
- Each surviving file becomes a slash command `/<name>` whose handler
  composes a fixed instruction: "Run the workflow named `<name>` via the
  workflow tool. User arguments, verbatim, are: …" — the command body never
  inlines the script (keeps the file the single source of truth and keeps
  the command payload tiny); the tool's `name` resolution does the fetch.
  Dispatch uses the plugin-loader precedent:
  `agent.followup(createUserMessage(...))` with verbatim interpolation of the
  invocation's raw input where the instruction marks the args slot. User text
  after the command name is passed through as free-form args context;
  structured `args` stay model-authored per CC semantics (CC's own docs show
  the model structuring `/<name>` free text into the tool's `args`).
- Collision policy is registry-scoped: the harness registry throws "already
  registered in this scope" on duplicates (deepseek-harness
  `packages/interaction/commands/src/index.ts:100-101`), so we try/catch and
  **skip with a warn** per command (the plugin-loader's per-command
  `catch → addSkipped` precedent in
  `packages/compat/cc-plugin-loader/src/commands.ts:155-157`), never aborting
  the remaining mounts. Registration order between this provider and the
  plugin loader is not guaranteed, so either side may win a given collision;
  the warn names the winner and the resolution (rename the file). Two
  admitted limits: file names failing the registry regex
  `/^[a-z][a-z0-9_-]*$/` are skipped with a reason line; and names
  matching TUI-local slash commands (`clear`, `model`, …) register fine
  server-side but are **silently shadowed** in the TUI, because locals never
  enter the harness registry — documented limitation, with the workflow still
  fully reachable via the tool's `name` param (the skip line says so).
- Skip/warn surfacing is logger-grade plus self-describing UI, and that is
  deliberate: the "boot tally channel" named in the first draft does not
  exist for this provider (the `ComponentTally` report is the plugin loader's
  own channel, consumed by `CcPluginsService`'s `/plugin` listing). What the
  user actually gets: (a) `ctx.logger.warn` per skip/collision; (b) `/<name>
  help` printing the meta description **and the mounted file path** (the
  staleness antidote — the help text names exactly which file won); (c) one
  new clause in the `tool:workflow` prompt section telling the model, when it
  saves a workflow on the user's behalf, to say it becomes invocable as
  `/<name>` in the next session (a prompt change; the commit message states
  the expected observable difference per the config-is-prompt rule). A
  user-visible boot notice was considered and rejected: the only existing
  mechanism (`mcp-ready-notice`) is a pre-step decision rewrite with a
  documented phantom-wake hazard (PR #31) — far too heavy for a skip line.
- Save flow: none. CC's `s`-key dialog is a TUI surface; per the core slice's
  prompt section, the model saves on explicit user request via its `write` tool,
  and the new command appears next session. This asymmetry vs CC is recorded in
  the manifest deviation rather than compensated with new UI.
  Two further CC-doc behaviors are recorded as deviations, not built: CC's
  documented mid-session escape hatch — `/reload-skills` re-reads the
  workflow directories — has no dsh-cc counterpart (there is no
  `/reload-skills`; `/reload-plugins` is plugin-scoped), so run-by-`name`
  stays the same-session workaround; and CC's monorepo loading since
  v2.1.178 (project workflows load from every `.claude/workflows/` between
  cwd and the repo root, closest wins) is narrowed to the single
  `<cwd>/.claude/workflows` directory, matching the core slice's resolution
  rule. CC's `/workflow-authoring` bundled skill (v2.1.248+) is a non-goal:
  the script-authoring contract already lives in the tool description and
  the `tool:workflow` prompt section.
- Descriptor discipline: generated commands go through `helpable()` so `/<name>
  help` prints the meta description + file path; descriptors are read-only
  wrappers, never executable handlers of their own.

### 3.2 Progress row in cc-tui (D2)

Minimal, non-blocking, and strictly passive:

- A cc-tui subscription to `workflow/start|phase|agent-start|agent-end|end`
  maintains one status row per active run. Attribution is process-scoped, NOT
  per-session: the registry's single-active-run guarantee is per session
  (`registry.ts:228-236` — "in this session"), the `WorkflowRunInfo {id, meta}`
  payload carries no session identity, and cordis emit is unfiltered
  process-wide (§2) — two sessions in one process can each hold an active run
  and this listener hears both. The row therefore follows the driver-catalog
  `subagent/start` posture verbatim: track runs by `id`, render the most
  recently started still-active run, never claim session parentage (when a
  second run is observed active, the row suffix shows `+N more`). The row
  content: `running <elapsed> · phase <currentPhaseTitle> · agents
  <settled>/<started>`, driven by the engine's cordis payloads (the row is the
  first consumer of that family; see §2's tripwire note). The row **echoes**
  emitted phase titles and counts agents; it never groups or validates against
  `meta.phases` (exact-match is convention, not guarantee — §2). `workflow/log`
  is deliberately not subscribed: per-run log lines are high-volume and the
  consolidated result already arrives via the core slice's wake.
- Render surface, pinned: a SECOND instance of the existing `WorkingLine`
  component (`packages/ui/tui/src/components/working-line.ts`) with a
  workflow-specific `messageFn`, placed next to the turn's working line in
  the HUD. This is deliberately NOT a new timer and NOT a rider on the turn's
  instance: `tests/no-polling.spec.ts:103` whitelists exactly that one file
  for `setInterval` (stack-frame attribution — a second instance's interval
  still originates inside the whitelisted file, so the test is untouched),
  and the turn's own instance is stopped whenever no turn is active — which
  is precisely the mid-run state this row exists for. The instance gets its
  own slot in the root chrome (`dock.addChild` next to the turn's working
  line, same `{shrink: 1, minSize: 0}` posture) — with a hard constraint:
  `root.ts` sits at the 500-line cap, so the listener/tracker/factory wiring
  lives in a NEW module (`packages/ui/tui/src/harness/workflow-row.ts`) and
  the `root.ts` delta must be net-zero. The instance is
  `start()`ed on the first observed event for a run and `stop()`ed on its
  `workflow/end` (empty Text collapses to zero lines, so an idle row
  allocates nothing); `stop()` tears the interval down, so no orphan
  interval outlives a run. Teardown is also pinned on the disposal path:
  the row's listener teardown (driver dispose / root destroy) calls `stop()`
  on the workflow instance, so no interval dangles past the UI's lifetime. Render-time width, no reflow of history.
  Resume-mid-run fallback (no `workflow/start` replay exists): the row
  appears on the first observed event for an unknown run id, with elapsed
  counted from that first observation — cosmetic understatement, never a
  bogus claim. Listener robustness is layered: the engine's
  `emitWorkflowEvent` already contains listener failures (§2), and the row's
  own handler try/catches per event so a malformed payload freezes cosmetics
  at worst.
- No interactivity in this slice: no cancel key, no expansion, no `/workflows`
  panel. Cancellation remains out of scope (core slice §3.5 records the gap);
  adding keys is a separate slice once pause/cancel semantics exist end-to-end.
- Absence is total in observable behavior: profiles without the workflow
  engine enabled allocate no row and no interval. The subscription itself is
  unconditional (the driver-catalog posture — subscribing does not require
  the service to exist, and a presence gate would miss late-mounted engines,
  the documented ccPlugins race); without the engine no `workflow/*` event
  ever fires, so the row never starts.

### 3.3 Manifest and gates

`engine.workflow` gains `/<name>` command mounting + passive progress row as
implemented items; deviations remaining after this slice: no `/workflows` panel,
no save dialog, no pause/cancel keys, session-start scan staleness with no
`/reload-skills`-style mid-session re-read (new saves mounted next session;
run-by-`name` works immediately), single-directory project scan (no monorepo
multi-root loading, CC v2.1.178+), no `/workflow-authoring` bundled skill,
scan cwd pinned to `process.cwd()` while tool resolution uses the session
header cwd (divergence only when they differ — API/headless compositions),
progress row process-scoped without session attribution (payloads carry
none), TUI-local-name silent shadowing, skip surfacing logger-grade. Validator
discipline: the row's dimensions stay consistent (I3) and its evidence anchors
point at package sources plus the existing preset row — D1/D2 add no preset
row (D1 rides the core slice's existing tool-workflow row; D2 is a cc-tui
listener), so no new I4 anchor is needed and no reordering (I7) is triggered.
docs:parity regenerated in the same commit.

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

- *Catalog staleness surprise* — mitigated by three honest surfaces (§3.1):
  `ctx.logger.warn` skip lines, a `/<name> help` output that prints the file
  path actually mounted, and the prompt-section clause that makes the model
  say "invocable as `/<name>` next session" when it saves a workflow.
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
- *TUI row lifecycle* — the listener is driver-level (rt.ctx), so `/clear`
  mid-run no longer drops the row (it tracks the run, not the session); a
  resumed session picks the row up on the first observed event with elapsed
  counted from that observation (§3.2). The row is cosmetic state only; the
  run and its completion wake are unaffected either way.

## Acceptance (DoD)

1. Unit tests: two-directory scan with project-shadowing; scan cwd pinned to
   `process.cwd()` with the divergence note in place; the scanned set and
   the tool's `name`-resolution set come from the same `savedWorkflowDirs`
   helper (structural one-rule assertion); registry-collision skip-warn
   (plugin-name case) with the winner named and the remaining mounts
   unaborted; file names failing the registry regex `/^[a-z][a-z0-9_-]*$/`
   skipped with a reason line; parse-failing meta skipped with a reason line;
   parse-ok but shape-invalid meta (missing/empty description, unknown field,
   bad `phases` entry) skipped with a reason line naming the shape check,
   while valid siblings mount (CC autocomplete-drop parity); generated
   descriptor help output printing the meta description and the mounted file
   path; user free-text passes through verbatim to the composed instruction;
   the `tool:workflow` prompt section carries the new next-session `/<name>`
   clause; the whole mount skips with one logger line when the commands seam
   is absent.
2. cc-tui tests: event sequence drives row contents (phase transition,
   settle-ratio, end-clears-row); the row's WorkingLine instance is stopped
   (interval gone) after `workflow/end` AND after driver dispose mid-run; two
   concurrent active runs render the latest with the `+N more` suffix; a
   first event for an unknown run id (resume-mid-run) starts the row with
   elapsed counted from first observation; listener never throws on malformed
   payloads; contract test pins the five subscribed `workflow/*` payloads
   against `@deepseek-ai/dsh-workflow` types; `tests/no-polling.spec.ts`
   untouched and green.
3. Composition: no new preset row (the scan rides the existing tool-workflow
   row); `smoke:profile-boot` green; catalog snapshot semantics asserted
   (save during session → not listed this session, runnable by `name`).
4. Manifest + docs:parity regenerated; deviations list matches §3.3 exactly.
5. Dogfood: save a workflow (via the model, `write` tool), start a fresh
   session, invoke `/<name>`, observe the progress row through a 3-phase script
   and one consolidated wake.
