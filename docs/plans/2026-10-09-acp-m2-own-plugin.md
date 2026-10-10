# dsh-cc ACP lane (M2): own `@dsh-cc/acp` plugin, `cc-acp` profile — design

Status: reviewed — three-seat blind review converged all-GO (r1 full review,
r2 delta round, r3 micro-confirmation; ledger §11). User decision to build
M2 recorded in §1. Awaiting user sign-off before implementation (PR-B).

## 1. Background and problem

ACP (Agent Client Protocol, v1) is the Zed-initiated stdio protocol that lets an
editor drive a coding agent: JSON-RPC over NDJSON on stdio. The DeepSeek Harness
already ships a native ACP front-end:

- `@deepseek-ai/dsh-acp` (plugin, packages/acp/acp, 1 823 src LOC across 7 files)
- `@deepseek-ai/dsh-acp-app` (profile bundle) + an `acp` profile template
  (`packages/boot/app-boot/src/profile.ts:180-182`)

dsh-cc's product value is the Claude-Code-compatible surface (CC preset: CLAUDE.md
injection, CC tool names, slash commands, memory, hooks, permission rules,
settings cascade). The harness ACP plugin is **automation-only and composes no
agent preset by design** (`packages/acp/acp/src/index.ts:196-203`, comment verbatim:
"No preset composition: … A deployment that configures a roster has to join one
here"). Its protocol surface also lacks everything CC-specific: no
`available_commands_update`, no `plan`, no `session/set_mode`, no cost in
`usage_update`, no transcript replay on resume, no `fs/*` or `terminal/*`
forwarding, hardcoded `agentInfo deepseek-harness-acp/0.0.1`.

The harness repo is read-only for dsh-cc (user directive, 2026-09-10), and the
package exports only its cordis plugin face (`name/inject/Config/apply`); its
internal modules (codec, content mapping, session) are not reusable
(`exports "./src/*"` points at files absent from the published tarball's
`files` whitelist — deep imports 404).

**Decision (user, 2026-10-09): go straight to M2** — dsh-cc ships its own ACP
plugin that *replaces* the harness plugin in a dedicated `cc-acp` profile,
porting the harness implementation and extending it with the CC surface. The
smaller M1' variant (keep harness plugin + joiner) was explicitly skipped in
favor of owning the protocol layer from day one.

## 2. Measured evidence (2026-10-09 live probes, full log in session memory `acp-support-probe-results`)

All three probes ran against a hand-built non-template profile floor
`~/.dsh/profiles/cc-acp` in a throwaway `DSH_HOME=/tmp/dsh-cc-acp-probe-home`,
with npm-published closures (188 packages) and a zero-dependency NDJSON client
driver (`.scratch/cc-acp-probe/client.mjs`). The real user home was never
written.

- **P1 (profile composition) — PASS.** Non-template profile name boots:
  `dsh --profile cc-acp` with floor `dsh.profile.bundles = [dsh-base,
  dsh-acp-app, @dsh-cc/bundle-permissions, @dsh-cc/bundle-shell, probe-bundle]`.
  Full ACP handshake green: `initialize` (protocolVersion 1) → `session/new`
  → `session/prompt` (stopReason end_turn, agent_message_chunk + usage_update
  streamed, stdout pure NDJSON, zero unparseable lines).
- **P2b (preset join) — PASS.** The harness plugin creates agents with no
  preset (verified behaviorally: header `agentPreset` absent, no
  `agent-preset/selected` event). A dsh-cc-side joiner listening on
  `agent/created` (serial awaited event; payload `{agent, source, signal}` —
  `core/agent/src/runtime-types.ts:261`) and calling
  `ctx.get('agentPresets').select(agent, 'cc')` joins the CC preset:
  transcript records `agent-preset/selected {agentPreset: 'cc'}`; prompt still
  completes; CC sub-surface activates (memory-recall fork agents inherit
  `agentPreset: cc` via `packages/subagent/subagent/src/child-agent.ts:145`
  parentage).
- **P3 (patch-layer swap) — PASS.** A later bundle layer carrying
  `- id: acp, disabled: true` plus an insert row for a replacement plugin:
  initialize goes unanswered (protocol plugin removed) while the replacement
  mounts in the same boot. This is the same mechanism `tools-cc` already uses
  to swap `id: tools` (packages/bundle/cc-shell precedent).

**Probe blind spots (caught in r1 review, not covered by P1–P3):** the probe
floors did not carry the cc-tui host-plane disable roster (§5.1 row block A),
did not exercise the create-path `mount()` (P2b used post-creation
`select()`), and never booted a floor without `@deepseek-ai/dsh-acp-app`.
"Green" for P1–P3 means: boots, joins, swaps — not "the CC tool plane is the
only tool plane" and not "create-path composition works". The PR-B gate (§6)
therefore re-probes the exact production floor.

Code-level survey facts (not live probes; anchors from the harness checkout at
the pinned 0.2.0-rc.2 line and the dsh-cc worktree) are cited inline below.

## 3. Port risk analysis (what forking actually costs)

Source inventory (harness `packages/acp/acp/src/`, MIT, no per-file headers):

| file | LOC | purpose |
|---|---|---|
| index.ts | 536 | cordis apply, 8 request handlers + cancel, session registry, teardown |
| session.ts | 524 | AcpSession create/resume, single-prompt admission, event→update queueing |
| content.ts | 237 | prompt-block admission (image validation), assistant-block projection |
| model-control.ts | 237 | config options over model/reasoning selection |
| mcp.ts | 143 | ACP mcpServers → dsh-mcp-client mounts |
| updates.ts | 111 | committed SessionEvent → SessionUpdate[] |
| codec.ts | 35 | turnEndToStopReason pure map |

Plus tests ≈ 2 700 LOC with a self-contained in-process rig (real cordis
Context + AgentLoop + JsonlSessionPersistence + scripted MockAdapter + the real
SDK client over TransformStreams, tests/harness.ts).

External surface: `@agentclientprotocol/sdk` 1.4.0 public API only (`agent()`
builder, `methods`, `ndJsonStream`, `PROTOCOL_VERSION`, `RequestError`, types);
harness peers (dsh-agent, dsh-llm, dsh-mcp-client, dsh-session,
dsh-session-persistence, dsh-token-meter, dsh-user-approval, dsh-attachment)
are the same packages every dsh-cc plugin already links against the sibling
checkout — no new class of dependency. Two soft spots, flagged:

- **R1 (type surface — corrected in r1)**: `installModelSelection` /
  `ModelSelectionRef` are **public exports** of `@deepseek-ai/dsh-agent`
  (r1 verification), not internals. The genuine drift surface is
  `agent.session.requestHeader()` (session.ts:156; public-export status
  unverified) and the duck-typed `ctx.get('subagents')` cast (session.ts:22-26).
  Both resolve against the sibling checkout during build (same as every
  dsh-cc package) — drift risk, not build blocker. Mitigation: R-items in the
  harness-migration checklist (§6.4), plus a boot-probe assertion for the
  `agentPresets` inject (the TUI's preset.ts documents a self-deadlock for
  `resolve()/list()` during Host activation; `mount` deferred into setup
  should be safe — assert it in the smoke script).
- **R2 (test fixture)**: `tests/bridge.spec.ts:14` imports a cross-package
  unpublished fixture (`mcp/mcp-client/tests/http-fixture.ts` via relative
  path). The port vendors a trimmed copy of that fixture (it is MIT harness
  code) or re-implements the minimal HTTP fixture locally. Decided at
  implementation; default is local re-implementation to avoid a second
  vendored tree.
- **R3 (test kit)**: the ported test rig depends on
  `mountAgentLoopTestDependencies` from `dsh-agent-loop-testkit` — another
  sibling-checkout surface; added to the migration checklist alongside R1.
- **R4 (MIT notice)**: the harness `LICENSE` requires retaining its copyright
  and permission notice with redistributed source. The vendored files carry a
  `LICENSE-harness` copy (or equivalent notice block) that must survive
  package publishing (`files` whitelist + `check:publish` gate).

## 4. Fork strategy (the drift question)

This is a **fork-with-divergence-ledger**, not a byte-identity vendor. The
harness plugin is the right baseline, but M2's whole point is to diverge
(preset composition, new methods, new update variants). Byte-identity gates
(p i-tui model) don't apply to intentionally-diverged code.

Mechanics:

1. **Provenance header** on every ported file: source package, harness ref
   (exact commit `c1b47e41fcd54d20a0f061df28683bfc29ee24e5` — note this is
   *past* the 0.2.0-rc.2 tag, not at it; the ledger records the SHA, never a
   tag label), copy date, and the standing rule: "structural fixes flow from
   upstream during harness migrations; CC-specific divergences are listed in
   `packages/acp/cc-acp/DIVERGENCE.md`".
2. **DIVERGENCE.md ledger**: every intentional divergence from the vendored
   baseline, one entry each: what changed, why, which upstream behavior it
   replaces. Reviewed as part of every harness-migration PR.
3. **Drift gate (CI — redesigned in r1)**: `tests/upstream-drift.spec.ts` runs
   a **two-way diff of the port against the live sibling harness checkout**
   (the same checkout CI already pins via `DSH_HARNESS_REF`), failing on any
   hunk not present in `DRIFT_ALLOWANCE`. It hard-fails when the checkout is
   missing (a hash of a *historical* ref can never detect migration drift),
   detects added/deleted files on both sides, and covers upstream tests
   alongside src. This is the preset-cc baseline gate shape
   (packages/preset/cc/tests/composition.spec.ts:534-575, DRIFT_ALLOWANCE)
   applied to source files; no installed-tarball fallback exists because the
   upstream tarball ships no src. Hash updates require explicit review
   evidence in the migration PR.
4. Fork strategy is **re-decided at every harness migration** (the
   `@dsh-cc/tools` fork rule): re-vendor wholesale, or compile-fix only.
   The drift gate exists precisely to force that decision to be conscious.

## 5. Design

### 5.1 Package layout (three new things, one launcher change)

```
packages/acp/cc-acp/          → @dsh-cc/acp       (plugin; the fork+extensions)
packages/bundle/cc-acp/       → @dsh-cc/bundle-acp (profile bundle, patch-only)
packages/launcher/tui/        → @dsh-cc/cli        (new `acp` subcommand)
```

- `@dsh-cc/acp`: cordis plugin, `name: 'acp-cc'`, same inject set as upstream
  plus `agentPresets` (`['agents','llm','sessionPersistence','sessions',
  'agentPresets']`). Source tree mirrors upstream file structure (index,
  session, content, model-control, mcp, updates, codec) so upstream diffs
  apply cleanly, with new files for extensions (`commands.ts`, `modes.ts`,
  `replay.ts`, `client-fs.ts` — see §5.4).
- `@dsh-cc/bundle-acp`: patch-only bundle (the `@dsh-cc/bundle-permissions`
  shape: package.json with `files: [cordis.patch.yml]` + `dsh.bundle.patch`).
  Rows, in order:
  - **A. Host-plane disable roster** — the agent-plane rows
    `packages/bundle/cc-tui/cordis.patch.yml:13-83` disables (tool-bash,
    tool-pwsh, tool-jobs, tool-fs, tool-fs-search, tool-str-replace-editor,
    skill-filesystem, …, workflow-worker-thread, tool-workflow, tool-ralph,
    agent-instructions, tool-todo, tool-web), copied verbatim minus the tui
    row. Without this block the host defaults coexist with the CC preset
    (duplicate tool planes) — an r1 blocker (codex-B2) the probes never
    covered. `hmr`: the base predicate (`disabled: !!js "!ctx.get('profileContext')"`)
    disables hmr only when **no** profile is active — under our profile it
    would be ON; what keeps this lane's hmr off is the retained acp-app's
    explicit `hmr disabled` row (acp-app/cordis.patch.yml:23; r2 wording fix,
    both grok and codex flagged the reversed prose). The smoke probe asserts
    it off.
    As with cc-tui: must NOT touch `tools` (cc-shell remounts tools-cc),
    `settings`/`permission-rules` (cc-permissions), `user-questions`,
    HTTP/webserver rows.
  - **B.** `insert agent-preset-registry` (config `default: cc`) — copied
    from cc-tui:94-98
  - **C.** `insert preset-cc` + nested `cc-composition` include row pointing
    at `node_modules/@dsh-cc/preset-cc/agent.cordis.yml` — copied from
    cc-tui:99-110
  - **D.** `insert acp-cc` (name `@dsh-cc/acp`, **`inject: [acpAppStartup]`**
    — the bundle-level stdio latch, same gate upstream uses
    (acp-app/cordis.patch.yml:17-18); without it the plugin can claim stdout
    before the startup plugin parses the command line, breaking `--help`),
    config: provider/model optional route override, `presetId: 'cc'`)
  - **E.** `- id: acp, disabled: true` — the P3-proven swap of the harness
    plugin (this row works precisely because the acp-app bundle stays in the
    floor — the `acp` row is inserted by acp-app, not dsh-base)
  - **F.** `- id: session-title-llm-cc, disabled: true` — disable the CC
    title provider that bundle-shell inserts (upstream acp-app disables the
    stock `session-title-llm`; that alone leaves the CC replacement live and
    paying a title-model call per session)
  - Dependencies (runtime rows must all resolve from the packed package, not
    the workspace — r1 codex-M8/critic-7, extended in r2): **`@dsh-cc/acp`
    itself** (the inserted replacement plugin — bundle-tui's precedent
    declares `@dsh-cc/tui` the same way; r2 codex-major: without it the floor
    provides no installation path for the plugin), `@dsh-cc/preset-cc` (new
    direct dep; today it rides via `@dsh-cc/tui` which this lane does not
    install), `@deepseek-ai/dsh-agent-preset-registry` and
    `@deepseek-ai/dsh-agent-preset` (**declared deps, not ambient**: r2 grok —
    `dsh-base` carries neither; the probes resolved them ambiently through
    the dsh installation's runtime resolution, exactly the fragile path a
    packed floor must not rely on), `@deepseek-ai/cordis-plugin-include`
    (today a devDep of preset-cc only — must become a real dep of bundle-acp
    or preset-cc). `@deepseek-ai/dsh-acp` stays a dep of nothing (its row is
    disabled). Packed-tarball floor install is the closing check.
- **Floor / launcher**: `dsh-cc acp [<args>]` subcommand in the existing bin.
  Floor bundle list: `[dsh-base, @deepseek-ai/dsh-acp-app,
  @dsh-cc/bundle-permissions, @dsh-cc/bundle-shell, @dsh-cc/bundle-acp]` —
  **D1 resolved in r1: keep `@deepseek-ai/dsh-acp-app` in the floor** and swap
  only the `acp` row (three-seat convergence: the bundle carries the startup
  latch + hmr/system-prompt rows our patch-only bundle cannot absorb; its
  persona rows are inert under the CC preset). The `acp` branch in
  `bin/dsh-cc.js` dispatches **before** any TUI-specific processing (worktree
  parsing, `interceptResume`, `DSH_CC_*` env) and uses its own bundle list +
  profile stamp (`cc-acp`) — the TUI bootstrap's heal/restore paths write to
  inherited stdout, which would corrupt the NDJSON channel; installation
  output for the acp lane goes to **stderr**, and the branch must never
  consume stdin. Subprocess tests assert exact argv and pure-protocol stdout
  across fresh/warm/upgrade/heal/restore launches. The canonical-command
  precedent holds: no new `dsh-cc-acp` bin.
- **Zed wiring** (docs only): agent_servers entry
  `{"command": "dsh-cc", "args": ["acp"]}`; cwd comes from the editor
  workspace via `session/new`.

### 5.2 Preset composition (the P2b mechanism, promoted into the plugin)

Upstream `AcpSession.create` runs `ctx.agents.create({sessionId, meta:{cwd},
agentOptions, signal, setup})` where setup only installs model control and
MCP. The port changes setup to also join the CC preset — exactly what the
TUI does (`packages/ui/tui/src/harness/driver.ts:96`, `composePreset(ctx,'cc')`
→ `{setup: (agentCtx) => presets.mount(agentCtx, id)}`; the reusable seam is
`ctx.agentPresets.mount(agentCtx, presetId)`, registry README "Composing a
child agent", the same pointer the upstream comment gives):

- **create**: `setup` composes in the TUI's order — **preset → model control
  → MCP** (TUI precedent `driver.ts:100-103` mounts the preset before
  installing model-selection listeners; MCP mounts plugins immediately,
  `mcp.ts:26-32`, so it goes last): `agentPresets.mount(agentCtx,
  config.presetId ?? 'cc')` first, then `modelControl.install`, then
  `mountAcpMcpServers`. The create call passes
  `meta: { cwd, agentPreset: config.presetId ?? 'cc' }` so the frozen v4
  header carries the identity (TUI stamps the same way, `driver.ts:112`;
  `agents.create` copies `meta.agentPreset` into the header —
  `core/session/src/index.ts:1058`).
- **resume**: `ResumeAgentOptions` has **no `meta` field** (r1 three-seat
  finding — `core/agent/src/index.ts:125-141`; the header is a frozen
  creation fact), so resume cannot re-stamp. Instead the resume setup reads
  the **recorded** identity from the projection —
  `sessionProjections.stateOf(agent.session, 'agentPreset')` (the registry
  registers this projection itself; our plugin composes the registry via row
  B, so `stateOf` resolves directly — unlike the headless bundle, which
  re-reads events *structurally* precisely because it does not compose the
  registry; r2 citation fix) — and mounts **that** id. Bare `mount()` appends
  no `agent-preset/selected` event; `select()` can append it but throws
  `agent-preset/locked` once the session has started a turn (registry
  `index.ts:319-332` — the guard is the turn boundary, not session
  non-blankness; r2 wording fix). Mounting the *recorded* id avoids the
  write entirely and stays consistent with the registry's
  model-visible⟺logged rule. Mismatch handling: recorded id absent from
  the roster → fail the resume request loudly (headless throws the same
  way); **recorded presetless → resume stays presetless** (r2 grok-major:
  silently mounting `config.presetId` on a session that already has turns
  is exactly the unlogged-composition split this paragraph forbids —
  `config.presetId` applies to fresh creates only).
- Join failures fail session/new / session/resume loudly (not silent).

Divergence from the external joiner probe (P2b used `agent/created` +
`select()`): doing it inside setup composes *before* the agent is published,
needs no event race reasoning, and stamps the create header. Note the probe
did NOT validate this create-path `mount()` form (r1 finding) — the PR-B
gate covers it with a composed-session test asserting model routing + MCP
visibility + the header stamp.

### 5.3 Branding and identity

`agentInfo: {name: 'dsh-cc', version: <own package version>}` (read from the
plugin's package.json — the `command-version` readOwnVersion pattern,
`packages/session/command-version/src/version.ts:26`). App name passed to the
SDK `agent()` builder likewise. No functional change otherwise in
`initialize`; capability advertisement unchanged from upstream in M2-core
(image stays runtime-probed via `supportsAcpImagePrompts`).

### 5.4 Extensions (each: seam, probe status, gate)

| # | feature | seam (verified anchor) | probed? | gate before implementation |
|---|---|---|---|---|
| E1 | `available_commands_update` + slash dispatch + **command result surface** | enumerate: `commands` service `CommandsLike.list(agent)` (`driver-catalog.ts:26-28`); dispatch: `commands.execute(agent, line, [], signal)` (TUI's `runHarness` closure is the shape, `driver-run-local.ts:387-407`); unmatched `/x` falls through to prompt (`driver-queue.ts:236-249`); change signal `commands/change`. **Commands return presentation text, not agent events** (`interaction/commands/src/types.ts:33-53`) — the extension must define how results/errors reach the ACP client (emit as `agent_message_chunk` at dispatch settlement) and run dispatch inside the prompt admission/cancellation lifecycle (`session.ts:243-330` single-slot semantics) | **unprobed** | live probe: `/cost` through the client rig — assert visible command output at the client, concurrent-prompt rejection, cancellation, command-that-enqueues-agent-work, and mixed text/image inputs; "no model turn" alone is insufficient (r1 codex-M7) |
| E2a | `current_mode_update` + `session/set_mode` | permission modes: `PERMISSION_COMMAND_MODES` (`command-permissions/src/modes.ts:10`) + `switchSessionPermissionMode` (`permission-rules/src/mode.ts:188-229` — it **rejects switching to `plan`**: plan entry/exit goes through the `/plan` command channel, the one cross-plane seam — `command-permissions/src/index.ts:115-155` has the full enter/leave orchestration, including "leave plan first" before any other switch). **Two event sources** (r2): engine modes emit `permission/mode`; plan-mode activity emits `plan/mode {active}` (separate fold, `foldPlanMode`, `mode.ts:72-84`) — the emitter must watch both | **unprobed** | live probe: both event folds → emitted `current_mode_update`; set_mode roundtrip into **and out of** plan (via the /plan channel), disabled-mode handling |
| E2b | `plan` update (task-plan entries) | **seam discovery needed** — ACP `plan` update carries entries/priorities/statuses; harness plan-mode is collaboration state (`active`/`pending`, `plan-mode/src/types.ts:21-45`), a different concept. Candidate source: todo/plan projection; must be designed against a live probe of the todo surface | **unprobed** | seam-discovery probe first (todo_write → session events → shape), then design review before implementation |
| E3 | cost in `usage_update` | `foldCost(events, modelTable)` from `@dsh-cc/command-cost` (`index.ts:15-16`); ACP schema: `cost: {amount, currency}` alongside required `used`/`size`; upstream emits usage only when meter **and** context window exist (`updates.ts:88-100`) — cost emission skips gracefully when either is absent; price table = deployment Config (shared with `/cost`), unknown price → omit cost, never fabricate | **unprobed** (fold API CI-covered) | wire test incl. no-meter and unknown-price cases |
| E4 | `session/load` + transcript replay | new method + `loadSession` capability advertisement (upstream advertises resume only, `index.ts:183-186`); read persisted events post-resume, synthesize updates from the same mapping code as live; replay ordering assertions explicit: stopReason boundaries, interleaved tool_call/tool_call_update pairs (upstream tests never exercise replay ordering — r1) | **unprobed** | live probe: prompt → close → cold-process `session/load` → assert replayed chunk order; same-process load is insufficient (r1) |
| E5 | `fs/read_text_file` / `write_text_file` forwarding | **seam corrected in r2 (grok)**: the CC file tools are upstream `@deepseek-ai/dsh-tool-fs` (preset roster `agent.cordis.yml:70-76`) — read-only, not an editable executor site, and `checkedTarget` is private on `SandboxedFileSystem`. The editable intercept that holds the agent and never touches host-plane `ctx.fs` consumers is the **`tools/execute` waterfall in the `@dsh-cc/tools` fork** (`runtime-execute.ts` dispatch region). Open questions the discovery probe must answer: wrapping vs skipping the tool body (skipping the body skips the sandbox fence — delegation must wrap, not bypass), and how `writeText` delegation preserves the fence contract. **No implementation until the seam-discovery probe lands** (same tier as E2b) | **unprobed** (seam itself under discovery) | seam-discovery probe: waterfall wrap site + fence behavior; then capability probe (advertised client sees model reads/writes hit the client; host-plane reads stay local) |
| E6 | terminal/*, elicitation, session/delete, additionalDirectories | — | — | **out of scope** (§9) |

E1–E2a are the user-visible wins (Zed command palette + mode UI); E3–E4
are quality; E2b/E5 are editor-integration depth. **Implementation order E1 →
E3 → E2a → E4 → E2b → E5**, each in its own commit slice with its probe gate
green first.
M2-core (port + composition + branding) ships before any extension; the
reviewed-and-merged core is independently useful (it already beats M1' by
owning the protocol layer).

### 5.5 Explicitly unchanged

- NDJSON transport, `PROTOCOL_VERSION=1` from the SDK, all upstream method
  semantics (single-prompt admission, resume restrictions incl. cwd realpath
  check, session/list paging, image admission pipeline, MCP stdio+http
  mounting, approval waterfall mapping) — ported as-is unless listed in
  DIVERGENCE.md.
- The `acp` harness package and its `acp-app` bundle remain untouched on npm
  and in the harness repo (read-only directive). Plain `dsh --profile acp`
  keeps working exactly as before — our lane is a *separate* profile name
  (`cc-acp`), so no floor collision (probe-rejected the shared name).
- No changes to the TUI lane, preset-cc roster, or any existing bundle.

## 6. Implementation checklist

1. **PR-A (this design, docs-only after review)**: this doc lands in
   `docs/plans/2026-10-09-acp-m2-own-plugin.md` with review ledger filled.
2. **PR-B (M2-core)**: port + fork strategy + bundle + launcher subcommand:
   - vendor 7 src files + tests (rig + 11 specs), provenance headers,
     harness LICENSE notice, DIVERGENCE.md seeded with §5.2 (create stamp /
     resume-reads-projection / setup order), §5.3 branding, and the
     `bridge.spec.ts:51` agentInfo assertion hunk (r1: a verbatim port goes
     red on the rename — that hunk is a day-one divergence entry);
   - preset composition in create/resume setup + tests: assert the create
     **header** `agentPreset` stamp + mounted composition + model routing +
     MCP visibility through the ported rig (not the `agent-preset/selected`
     event — the create path mounts without appending it, r1);
   - agentInfo branding + version read;
   - drift gate `tests/upstream-drift.spec.ts` (two-way diff vs the live
     sibling checkout, DRIFT_ALLOWANCE, missing-checkout hard-fail, covers
     src + tests);
   - `@dsh-cc/bundle-acp` (rows §5.1 incl. disable roster) + full runtime dep
     set (§5.1 deps note; packed-tarball floor install check);
   - launcher `acp` subcommand + bootstrap floor logic + tests
     (`bootstrap.mjs` pure helpers shape; five launch forms: fresh / warm /
     upgrade / heal / restore, exact argv, pure protocol stdout, install
     output on stderr);
   - capability manifest + `pnpm docs:parity` regeneration (new
     user-visible surface: the subcommand); new-package registration
     checklist (bundle rows, not agent preset rows — but `check:identity`,
     `check:publish`, tsconfig paths, spec-deps all apply);
   - dogfood gate: `.scratch/cc-acp-probe/client.mjs` promoted to a smoke
     script (`smoke:acp` style) driving the **exact production floor** in a
     scratch DSH_HOME — asserting hmr off, single tool plane (CC names only,
     no host duplicates), preset header stamp, and `agentPresets` mount with
     no Host-activation deadlock (R1).
3. **PR-C (E1 commands)**, **PR-D (E3 cost)**, **PR-E (E2a modes)**,
   **PR-F (E4 replay)**, **PR-G (E2b plan entries)**, **PR-H (E5 fs)** —
   one extension per PR, each gated on its §5.4 probe.
4. **Harness migrations**: R1 surfaces (`installModelSelection`,
   `requestHeader`, subagents cast) + drift gate triage added to the standing
   migration checklist.

## 7. Tests

- Port the 11 upstream specs verbatim (they are the behavior contract),
   re-homed onto the ported rig; keep names matching upstream files for
   drift-diff readability.
- New: preset-composition spec (create joins cc; resume reconstructs via
  projection; join failure → session/new error), branding spec (agentInfo
  name/version), drift gate spec, launcher bootstrap specs (floor contents,
  version convergence — reuse the `bootstrap.mjs` pure-helper test shape).
- Per-extension specs as their PRs land (E1: command dispatch + update
  emission; E2: mode fold + set_mode; E3: cost projection; E4: replay
  ordering; E5: delegation fallback matrix).
- Rig: extend the ported in-process harness (real cordis Context + AgentLoop
  + JsonlSessionPersistence + MockAdapter + real SDK client) — this is the
  upstream rig, which already solves the "no stdio in CI" problem via
  `config.stream` injection.

## 8. Verification (observable acceptance)

- M2-core: `dsh-cc acp` in a scratch DSH_HOME answers initialize/new/prompt
  (probe client reuse); the session **header** carries `agentPreset: cc` and
  the composition is observably mounted (CC tool plane only — no host
  duplicates, e.g. a tool-call round-trip through a CC-named tool like
  `read` with the stock `tool-fs` id absent); resume of that session mounts
  the recorded preset id (read back via projection). And — the acceptance
  differentiator — `available_commands_update` is *not yet* present (that's
  PR-C).
- Manual: Zed agent_servers entry boots the lane, chat + tool call + approval
  prompt work end-to-end in a real workspace.
- Upstream parity: ported spec suite green.

## 9. Out of scope / future work

- terminal/* forwarding, elicitation/*, `session/delete`, additionalDirectories
  (E6), MCP stdio advertisement (upstream mounts but advertises http only —
  keep parity), M1' joiner as a published artifact (superseded by §5.2),
  Zed-side config automation (docs only).
- Subagent-ACP reuse: different direction (agent→agent), orthogonal.

## 10. Decision points for the user

- **D1 — RESOLVED (r1, three-seat convergence)**: **keep
  `@deepseek-ai/dsh-acp-app` in the floor, swap only the `acp` row** (§5.1).
  The original absorb-and-drop option is rejected: the bundle carries the
  stdio latch (`inject: [acpAppStartup]` on the protocol row), hmr and
  persona rows, and its startup plugin parses cmdline before publishing
  readiness (acp-app/src/index.ts:41-47) — a patch-only bundle cannot absorb
  executable code. Its persona rows are inert under the CC preset.
- **D2**: extension order E1→E3→E2a→E4→E2b→E5 (commands first; E2b needs
  seam discovery before its design exists; fs executor-delegation last).
  Alternative orders fine; E2b/E5 carry the remaining design depth.
- **D3**: runtime dep closure enumerated in §5.1 — `@dsh-cc/acp` itself,
  preset-cc new direct dep, cordis-plugin-include must become a real dep of
  bundle-acp or preset-cc, and **registry/agent-preset declared as bundle
  deps** (r2: `dsh-base` carries neither — the probes resolved them
  ambiently through the dsh installation, which a packed floor must not
  rely on). Packed-tarball floor install is the closing check (workspace
  tests can conceal missing published deps).

## 11. Review ledger

### r1 (2026-10-09, three-seat blind, v1 → v2)

- **codex (gpt-6.1-sol, 65k tokens): NO-GO** — 12 findings (2 blocker / 6
  major / 4 minor), all code-anchored.
- **grok (grok-4.6, $0.68, 37 turns): GO-WITH-CHANGES** — 9 findings
  (1 blocker / 5 major / 2 minor / 1 nit).
- **critic (Opus): GO-WITH-CHANGES** — 11 findings (4 major / 4 minor /
  3 nit).

Cross-seat tally and dispositions (fold locations in parentheses):

| finding | seats | disposition |
|---|---|---|
| preset identity not recorded / resume not automatic; create must stamp meta, resume must read projection & mount recorded id | codex-B1 ≡ grok-#2 ≡ critic-1,2 | folded §5.2 (create/resume rewritten; impossible "resume stamps meta" struck) |
| D1 absorb-startup unimplementable; keep dsh-acp-app, swap acp row only | codex-M3 ≡ grok-B1 ≡ critic-3 | folded §5.1/§10-D1 (resolved: keep) |
| missing `inject: [acpAppStartup]` on the acp-cc row | grok-B1 ≡ critic-4 | folded §5.1 row D |
| host-plane disable roster missing from bundle-acp | codex-B2 (single seat, orchestrator-verified against cc-tui:13-83) | folded §5.1 block A + §2 blind-spot note |
| drift gate: hash pin wrong; two-way diff vs live checkout + allowlist | codex-m10 ≡ grok-#3 ≡ critic-6 | folded §4.3 |
| launcher TUI-path reuse corrupts stdio; acp branch before TUI args; stderr discipline | codex-M4 ≡ grok-#6 | folded §5.1 launcher + §6 tests |
| setup order preset→modelControl→MCP | codex-M5 | folded §5.2 |
| E2 plan semantic mismatch (task entries vs collaboration mode) | codex-M6 ≡ grok-#7 (partial) | folded §5.4: split E2a/E2b, E2b seam-discovery gate |
| E1 command-result surface + admission lifecycle | codex-M7 | folded §5.4 E1 |
| runtime dep closure (include plugin, registry, packed floor) | codex-M8 ≡ critic-7 | folded §5.1 deps + §10-D3 |
| title row: disable session-title-llm-cc | codex-m9 ≡ grok-#5 | folded §5.1 row F |
| E5 fs forwarding unimplementable as written; executor-level delegation | grok-#4 | folded §5.4 E5 (redesigned) |
| E3/E4 integration decisions (price table, emission preconditions, load capability, cold-process replay) | codex-m11 ≡ grok-#7 ≡ critic-10 | folded §5.4 E3/E4 |
| R1 overstated: installModelSelection public; testkit dep; MIT notice | critic-5,8 ≡ codex-m12 | folded §3 R1/R3/R4 |
| agentInfo rename breaks bridge.spec.ts:51 on verbatim port | grok-#9 | folded §6 DIVERGENCE day-one seed |
| anchor nits (child-agent path, 48 lines, driver-queue line, probe-artifact rest state) | grok-#8,9; critic-9 | folded §2/§3 |

Verdict divergence note: codex NO-GO vs GO-WITH-CHANGES ×2 on the same
substance — severity labeling differs (codex blocker = the other seats'
major), reconciled as blocker-grade per "implement-as-written produces a
bug or a broken boot".

### r2 (2026-10-09, three-seat delta-only, v2 → v3)

Delta verdicts: **critic GO** (all 16 folds verified, 3 nits), **grok GO**
($0.78, 9 fold-checks + 2 major / 3 minor / 1 nit), **codex NO-GO sustained**
(15/16 folds OK, 1 major / 1 minor / 2 nits — all mechanical). Convergence
signal: zero architecture-level findings; everything remaining is dependency
enumeration, seam-naming precision, and wording.

| finding | seats | disposition |
|---|---|---|
| bundle-acp omits `@dsh-cc/acp` itself as a runtime dep | codex major | folded §5.1 deps + §10-D3 |
| E5 seam unimplementable as written: CC file tools are upstream `@deepseek-ai/dsh-tool-fs` (roster :70-76, orchestrator re-verified), editable site = `tools/execute` waterfall in the `@dsh-cc/tools` fork; fence-preservation open | grok major (fold#4 PROBLEM) | folded §5.4 E5: candidate-seam framing + seam-discovery probe gate (E2b tier) |
| presetless resume fallback via silent `mount()` violates model-visible⟺logged rule | grok major | folded §5.2: presetless sessions resume presetless; `config.presetId` applies to fresh creates only |
| E2a misses `plan/mode` event source + `/plan` channel orchestration for entering/leaving plan | codex minor ≡ grok minor | folded §5.4 E2a (two event sources, /plan channel, leave-plan-first) |
| registry/agent-preset do NOT arrive via dsh-base (ambient resolution worked in probes = fragile) | grok minor ≡ critic nit | folded §5.1 deps + §10-D3: declared deps |
| HMR predicate prose reversed (base disables only when NO profile; acp-app's explicit row is what keeps this lane off) | codex nit ≡ grok nit | folded §5.1 block A |
| §5.4/§6 order sentences stale vs D2's E2a/E2b split | codex nit ≡ grok minor | folded both |
| headless citation conflates structural re-read with `stateOf` (mechanism fine, citation wrong) | critic nit | folded §5.2 resume bullet |
| `select()` locked guard is turn-boundary, not "non-blank session" | critic nit ≡ grok fold#2 detail | folded §5.2 |

r3 micro-confirmation (codex seat, the only non-GO after r2): **GO** — all six
fold checks OK, no new findings ("No NO-GO-grade design problems remain;
E2b/E5 implementation remains gated on seam discovery"). All three seats GO;
document landed in docs/plans. grok and critic verdicts stand (both GO since r2).
