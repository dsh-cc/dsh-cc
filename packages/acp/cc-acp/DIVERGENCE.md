# DIVERGENCE.md — @dsh-cc/acp vs upstream @deepseek-ai/dsh-acp

Vendored verbatim in S1 from `packages/acp/acp` (deepseek-harness, source ref
`c1b47e41fcd54d20a0f061df28683bfc29ee24e5`). Each intentional divergence from
upstream behavior is listed here with its design reference
(`docs/plans/2026-10-09-acp-m2-own-plugin.md`, slice S2 = §5.2/§5.3 + PR-B 1–3).

## S2 divergences

1. **Plugin name** (§5.3 identity): exported `name` is `'acp-cc'` (upstream:
   `'acp'`). Replaces the upstream Cordis plugin identity so the CC plugin
   does not collide with the upstream row.

2. **Preset composition seam** (§5.2, **revised 2026-10-09 after live
   acceptance**): the roster is resolved in `apply()` via plain
   `ctx.get('agentPresets')` (absent → loud throw) and threaded into
   `AcpSession.create`/`resume` options (`AcpPresetsService`). The original
   form declared `inject: ['agentPresets']` — **wrong**: cordis re-composes an
   injected service in the consuming plugin's own scope, re-applying the
   preset-cc declaration row and double-registering the roster (persona +
   command collisions; boot-time `record.broken`, surfacing only at
   session/new). Evidence chain: five-step floor A/B (acp-app removal,
   bundle-tui swap, acp-cc row disable, inject override) pinned the trigger;
   the TUI's `preset.ts` rosterOf pattern and the upstream `subagents`
   duck-type are the precedents for non-inject service access. Upstream had
   no preset composition at all ("No preset composition" comment removed from
   `newSession`).

3. **`presetId` config** (§5.2): `AcpConfig`/`Config` gain optional
   `presetId: Schema.string().default('cc')`, resolved in `apply()` and passed
   to `AcpSession.create` (`CreateAcpSessionOptions.presetId`). Upstream had
   no preset config; `presetId` applies to fresh creates only.

4. **Create: header stamp + setup order** (§5.2): `AcpSession.create` passes
   `meta: { cwd, agentPreset: options.presetId }` (agents.create copies
   `meta.agentPreset` into the frozen session header) and its setup runs
   **preset mount → model control → MCP**, the TUI's preset-before-listeners
   order (`driver.ts:100-103`; MCP mounts plugins immediately so it goes
   last). Mount failures propagate and fail session/new loudly. Upstream
   setup only installed model control and MCP and stamped no identity.

5. **Resume: reads the projection** (§5.2): `AcpSession.resume` setup reads
   the recorded identity via `sessionProjections.stateOf(session,
   'agentPreset')` (command-permissions stateOf access pattern) and mounts
   **that** id. Recorded id absent from the roster → `mount()` throws and
   session/resume fails loudly; recorded presetless (null/undefined) →
   resume stays presetless — `config.presetId` never applies on resume. The
   create header is a frozen fact (`ResumeAgentOptions` has no `meta`), so
   resume never re-stamps. Upstream resume performed no preset work.

6. **Branding** (§5.3): `initialize` returns
   `agentInfo: { name: 'dsh-cc', version: readOwnVersion() }` (new
   `src/version.ts`, the `command-version` readOwnVersion pattern, ESM-safe
   with a compile-time fallback), and the SDK `agent()` builder name is
   `'dsh-cc'`. Upstream hardcoded `'deepseek-harness-acp'` / `'0.0.1'`.
   Capability advertisement unchanged.

## Test-side divergences

7. **`tests/bridge.spec.ts` agentInfo assertion** (PR-B day-one hunk): the
   initialize-response assertion now expects
   `{ name: 'dsh-cc', version: pkgVersion }`, read from the package's own
   `package.json` (a verbatim port goes red on the rename).

8. **Rig extension** (`tests/harness.ts`): the bridge rig provides a spy
   `agentPresets` roster (records `mount(ctx, presetId)` calls, throws on
   unknown ids like the real registry) and registers the real
   `agentPresetProjectionDefinition` so resume reads the recorded identity
   exactly as the composed bundle does. `BridgeHarness.presetMounts` exposes
   the record.

9. **New specs**: `tests/preset-composition.spec.ts` (header stamp, create
   mount, resume-mounts-recorded, presetless-stays-presetless, unknown
   presetId fails session/new) and `tests/branding.spec.ts` (agentInfo
   name/version), per PR-B gates.

10. **Dev dependency**: `@deepseek-ai/dsh-agent-preset-registry` added as a
    `link:` devDependency — type-only import in `src/index.ts` (Context
    augmentation for `ctx.agentPresets`) plus the projection definition in
    the test rig. No runtime import in `src/`; the service arrives via
    inject/bundle composition.
