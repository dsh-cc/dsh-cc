# DIVERGENCE.md — @dsh-cc/acp vs upstream @deepseek-ai/dsh-acp

Vendored from `packages/acp/acp` (deepseek-harness, source ref
`2f97f60455605e915b8176d9170cae337bfedcc6`, `release(dsh): 0.2.2-rc.1`,
@deepseek-ai/dsh-acp 0.2.2-rc.1), **re-vendored in full** for the
harness-0.2.2-rc.1 migration (design D4): every source and test file is the
upstream file with the deltas below re-applied, and the drift gate
(`tests/upstream-drift.spec.ts`) compares them line by line against a sibling
checkout at that ref 〔src:ws:packages/acp/cc-acp/tests/upstream-drift.spec.ts#L83-L83〕.
Two upstream bodies live in `src/cancellation-status.ts`
(agent error/status handling, prompt cancellation and the quiescence loop)
〔src:ws:packages/acp/cc-acp/src/cancellation-status.ts#L1-L124〕 and the two
lifecycle listener registrations live in `src/lifecycle.ts`
〔src:ws:packages/acp/cc-acp/src/lifecycle.ts#L24-L30〕, because upstream
`session.ts` exceeds this package's size budget once the deltas are applied;
both are verbatim moves — `session.ts` imports them at
〔src:ws:packages/acp/cc-acp/src/session.ts#L24-L24〕 and `index.ts` at
〔src:ws:packages/acp/cc-acp/src/index.ts#L201-L201〕.

**What the re-vendor adopted from upstream** (deltas the previous vendoring
carried are now upstream's own code, so they are no longer listed here):
`AcpModelControl` wraps the Agent's `Model` (`agent.model.current()` /
`agent.model.select()`) instead of a mutable `ModelSelectionRef`; prompt
admission pins the route through `agent.model.current()`; ordinary forks are
resumable/listable regardless of `parentSession` lineage; a recorded pending
model selection is restored without a request header
〔src:ws:packages/acp/cc-acp/src/model-control.ts#L57-L70〕.

Each intentional divergence from upstream behavior is listed here with its design
reference (`docs/plans/2026-10-09-acp-m2-own-plugin.md`, slice S2 = §5.2/§5.3 + PR-B 1–3,
and `docs/plans/2026-11-07-harness-0.2.2-rc.1-migration.md` D4).

## S2 divergences

1. **Plugin name** (§5.3 identity): exported `name` is `'acp-cc'` (upstream:
   `'acp'`). Replaces the upstream Cordis plugin identity so the CC plugin
   does not collide with the upstream row
   〔src:ws:packages/acp/cc-acp/src/index.ts#L69-L69〕.

2. **Preset composition seam** (§5.2, **revised 2026-10-09 after live
   acceptance; re-revised for issue #380**): the roster is resolved PER USE by
   `src/preset-roster.ts` (`presetRosterResolver`) — never captured at apply
   time — and every stamped agent is joined on the serial `agent/created`
   event through `AcpPresetsService.select()`
   〔src:ws:packages/acp/cc-acp/src/preset-roster.ts#L18-L45〕
   〔src:ws:packages/acp/cc-acp/src/index.ts#L117-L121〕
   〔src:ws:packages/acp/cc-acp/src/session.ts#L51-L57〕. Issue #380 root
   cause: the loader mounts group siblings concurrently
   (`EntryGroup.update` → `Promise.all`) and strict `ctx.get` reads a LOADING
   sibling as `undefined`, so the original apply-time capture threw whenever
   the registry's async `Service.init` lost the import-order race, killing
   the whole ACP lane. Session admission (`newSession`/`resumeSession`) now
   additionally settles on `loader.await()` first
   〔src:ws:packages/acp/cc-acp/src/preset-roster.ts#L48-L61〕 — the same
   primitive `boot()` itself awaits — because `app.connect` runs at the end
   of `apply` while `boot()` is still settling, so an early client can race
   its first request past a LOADING registry. The absent-registry failure
   throws a wire-preserving `RequestError` at the first session admission.
   The original form declared `inject: ['agentPresets']` — rejected: inject
   couples this plugin's fiber lifecycle to the registry's, so a registry
   fiber restart would re-apply acp-cc and drop every live `AcpSession`
   (the sessions map is apply-scoped; the harness's own declarative
   `preset-cc` row accepts exactly that trade, a stateful server cannot).
   The 2026-10-09 claim that inject "re-composes the service and
   double-registers the roster" does not reproduce after the PR-B
   dsh-scope module-instance-split fix — the lifecycle coupling above is
   the standing rationale. Evidence chain: five-step floor A/B (acp-app
   removal, bundle-tui swap, acp-cc row disable, inject override) pinned
   the original trigger; the issue #380 three-seat review (critic + grok
   + codex) converged on per-use resolution plus the admission gate.
   Upstream has no preset composition at all ("No preset composition"
   comment removed from `newSession`).

3. **`presetId` config** (§5.2): `AcpConfig`/`Config` gain optional
   `presetId: Schema.string().default('cc')`, resolved in `apply()` and passed
   to `AcpSession.create` (`CreateAcpSessionOptions.presetId`)
   〔src:ws:packages/acp/cc-acp/src/index.ts#L105-L105〕
   〔src:ws:packages/acp/cc-acp/src/session.ts#L62-L65〕. Upstream has
   no preset config; `presetId` applies to fresh creates only (a resumed
   session keeps its recorded stamp).

4. **Create: header stamp** (§5.2): `AcpSession.create` passes
   `meta: { cwd, agentPreset: options.presetId }` (agents.create copies
   `meta.agentPreset` into the frozen session header)
   〔src:ws:packages/acp/cc-acp/src/session.ts#L146-L146〕. The join itself runs
   on `agent/created` (divergence 2), so the setup order stays upstream's
   (model control, then MCP — MCP mounts plugins immediately, so it goes
   last) 〔src:ws:packages/acp/cc-acp/src/session.ts#L107-L108〕. Upstream
   stamps no preset identity.

5. **Resume: joins the recorded preset** (§5.2): resume reads the frozen
   header's `agentPreset` on `agent/created` and joins **that** id
   〔src:ws:packages/acp/cc-acp/src/index.ts#L139-L160〕. Recorded id absent
   from the roster → `select()` throws and session/resume fails loudly;
   recorded presetless → resume stays presetless — `config.presetId` never
   applies on resume. The create header is a frozen fact
   (`ResumeAgentOptions` has no `meta`), so resume never re-stamps. Upstream
   resume performs no preset work.

6. **Branding** (§5.3): `initialize` returns
   `agentInfo: { name: 'dsh-cc', version: readOwnVersion() }` (new
   `src/version.ts`, the `command-version` readOwnVersion pattern, ESM-safe
   with a compile-time fallback) 〔src:ws:packages/acp/cc-acp/src/index.ts#L237-L237〕
   〔src:ws:packages/acp/cc-acp/src/version.ts#L20-L30〕, and the SDK `agent()`
   builder name is `'dsh-cc'` 〔src:ws:packages/acp/cc-acp/src/index.ts#L430-L430〕.
   Upstream hardcodes `'deepseek-harness-acp'` / `'0.0.1'`. Capability
   advertisement unchanged.

## Harness-0.2.2-rc.1 divergences (D4)

11. **Model-selection notice sanitizer, co-located (D4a)**: `composeAgent` in
    `src/session.ts` calls `installModelControl(agentCtx)`
    〔src:ws:packages/acp/cc-acp/src/session.ts#L107-L107〕, which installs
    `installModelSelection(agentCtx)` and **immediately after** it
    `installModelSelectionSanitizer(agentCtx)`
    〔src:ws:packages/acp/cc-acp/src/model-control.ts#L43-L46〕 — the
    load-bearing co-location rule of the effective-model-truth design §5.1
    (the `later-with-prepend` registration makes it the OUTERMOST
    `agent/pre-step` listener, publishing the frozen per-step selection before
    the inner chain runs). This lived in `model-control.ts` in the previous
    vendoring because upstream rc.5's `AcpModelControl` owned a selection ref;
    upstream 0.2.2 moved selection ownership onto the Agent, so the install
    site is a module-level helper beside the selection seam instead of an
    instance method. Side-effect-free when moa is unmounted.

12. **ACP pre-admission routing hook (D4b)**: `AcpSession.prompt` awaits
    `routeBeforeAdmission(this.agent, message)` on the exact admitted
    `UserMessage` before `agent.followup(message)`
    〔src:ws:packages/acp/cc-acp/src/session.ts#L303-L307〕 — the D3.2
    entry-point seam, identical to the TUI driver's queued-batch admission.
    Inert when moa is unmounted or disarmed (no admission entry registered).

13. **ACP config-set model change notifies moa (D4c)**:
    `AcpModelControl.set` calls `noteUserSelection(...)` with the exact
    recorded write after `agent.model.select(...)` — for the `model` option
    〔src:ws:packages/acp/cc-acp/src/model-control.ts#L98-L98〕 and for the
    `reasoning_effort` option
    〔src:ws:packages/acp/cc-acp/src/model-control.ts#L112-L118〕, mirroring the
    TUI `/model` and `/effort` paths
    〔src:ws:packages/acp/cc-acp/src/model-control.ts#L14-L14〕. An ACP model
    change is an explicit USER write: `userBaseSelection` updates, arming
    disarms (or re-arms on the boot pair), stale moa status rows drop, and the
    `user-select` sidecar row is appended. Upstream only records the
    selection.

## Test-side divergences

7. **`tests/bridge.spec.ts` agentInfo assertion** (PR-B day-one hunk): the
   initialize-response assertion expects `{ name: 'dsh-cc', version: pkgVersion }`,
   read from the package's own `package.json`
   〔src:ws:packages/acp/cc-acp/tests/bridge.spec.ts#L21-L21〕 (a verbatim port
   goes red on the rename). Package-local fixture paths
   (`./http-fixture.ts`, `./fixture-server.ts`) replace the cross-package
   relative imports, the `fixture-server.ts`/`http-fixture.ts` precedent.

8. **Rig extension** (`tests/harness.ts`): the bridge rig provides a spy
   `agentPresets` roster (records `select(agent, presetId)` joins in
   `presetMounts`, throws on unknown ids like the real registry)
   〔src:ws:packages/acp/cc-acp/tests/harness.ts#L264-L293〕 and registers the
   real `agentPresetProjectionDefinition` so resume reads the recorded
   identity exactly as the composed bundle does
   〔src:ws:packages/acp/cc-acp/tests/harness.ts#L294-L294〕.
   `BridgeHarness.presetMounts` exposes the record; `knownPresets` overrides
   the accepted roster.

9. **New specs**: `tests/preset-composition.spec.ts` (header stamp, create
   join, resume-joins-recorded, presetless-stays-presetless, unknown presetId
   fails session/new) and `tests/branding.spec.ts` (agentInfo name/version),
   per PR-B gates.

10. **Dev dependency**: `@deepseek-ai/dsh-agent-preset-registry` added as a
    `link:` devDependency — type-only import in `src/index.ts`
    〔src:ws:packages/acp/cc-acp/src/index.ts#L57-L57〕 (Context augmentation
    for `ctx.agentPresets`) plus the projection definition in the test rig
    〔src:ws:packages/acp/cc-acp/tests/harness.ts#L294-L294〕. No runtime import
    in `src/`; the service arrives via composition. `@dsh-cc/moa` is a runtime
    dependency for divergences 11–13 (the plugin root and its side-effect-free
    `/sanitizer` subpath) 〔src:ws:packages/acp/cc-acp/src/model-control.ts#L14-L16〕.

## DRIFT_ALLOWANCE map (per file, in `tests/upstream-drift.spec.ts`)

| file | allowance covers |
|---|---|
| `src/index.ts` | 1, 2, 3, 4, 6 + the `lifecycle.ts` extraction 〔src:ws:packages/acp/cc-acp/tests/upstream-drift.spec.ts#L87-L166〕 |
| `src/model-control.ts` | 11, 13 〔src:ws:packages/acp/cc-acp/tests/upstream-drift.spec.ts#L168-L213〕 |
| `src/session.ts` | 2, 4, 5, 11, 12 + the `cancellation-status.ts` extraction 〔src:ws:packages/acp/cc-acp/tests/upstream-drift.spec.ts#L215-L295〕 |
| `tests/bridge.spec.ts` | 7 〔src:ws:packages/acp/cc-acp/tests/upstream-drift.spec.ts#L307-L323〕 |
| `tests/harness.ts` | 8 〔src:ws:packages/acp/cc-acp/tests/upstream-drift.spec.ts#L324-L365〕 |
| `tests/turns.spec.ts` | package-local fixture copies 〔src:ws:packages/acp/cc-acp/tests/turns.spec.ts#L6-L15〕 |

Every other `src/` and `tests/` file is byte-identical to upstream at the pin
〔src:ws:packages/acp/cc-acp/tests/upstream-drift.spec.ts#L441-L449〕.
