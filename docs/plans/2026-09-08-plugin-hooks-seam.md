# Plugin Hooks Seam — Wiring `hooks/hooks.json` from CC Plugins into the Hook Bridge

Date: 2026-09-08. Status: implemented. Mirrors the mcp seam precedent
(docs/plans/2026-09-07-plugin-mcp-seam.md) where applicable; critic-reviewed
design with two amendments baked in (intra-group reorder rationale,
copy-on-write merge, leaked-services variant test).

## 1. Problem

`cc-plugin-loader` ships a complete `mountHooks` path
(`packages/compat/cc-plugin-loader/src/hooks.ts`): it reads a plugin's
`hooks/hooks.json` (or an inline manifest `hooks` declaration) and calls
`HooksSeam.mergePluginHooks(name, config)` from `seams.ts`. But the seam had
no provider: `MountedSeams.hooks` was documented as "guest; absent in the
harness today", and the loader's `ctx.get('hooks')` probe returned
`undefined` in production, so every plugin's hooks component tallied
`skipped: hooks seam "hooks" is not mounted` and mounted nothing — plugin
hooks shipped with `hooks/hooks.json` were silently ignored.

## 2. Design

- **The bridge owns the seam.** `packages/hooks/hooks-claude-code/src/index.ts`
  now provides `ctx.provide('hooks', { mergePluginHooks })` after
  `createRunPoint`, mirroring the cc-shell `mcp` seam wiring.
- **Unconditional provide.** `apply()` was restructured so the `parsed` boot
  config is `{}` when there is no config path or the boot config fails to
  read/parse, and execution CONTINUES through detached runs, turn safety,
  the run point, event registration, and the seam provide. The
  `hookBridgeStatus` provide semantics (loaded/failed/no-config) and all
  boot-file warnings/diagnostics are unchanged. A boot-empty but
  plugin-present session therefore still fires plugin hooks.
- **`mergePluginHooks(pluginName, raw, pluginRoot?)`** parses the raw value
  via `parseClaudeCodeConfig` (bare per-event map or `{hooks: {…}}`), with
  `pluginRoot` substituted for `${CLAUDE_PLUGIN_ROOT}` and the configured
  `projectDir` for `${CLAUDE_PROJECT_DIR}`. On parse throw (e.g. an invalid
  matcher regex) it warns naming the plugin, records a `config` diagnostic
  when a writer exists, and returns a no-op disposer — never throws (the
  mcp seam's D1 precedent). `result.skipped`/`result.warnings` are logged in
  the same shapes as the boot path, warnings recorded as `config`
  diagnostics.
- **Copy-on-write merge.** For each `[event, groups]`, `parsed[event]` is
  REPLACED with `[...(parsed[event] ?? []), ...groups]` — never spliced in
  place. runPoint snapshots the per-event array reference at dispatch start
  and then awaits per hook, so an in-place splice during dispose would skip
  groups mid-iteration; replacement keeps in-flight snapshots stable.
  Added groups are tracked in a Set plus per-event lists; the disposer
  filters them back out and `delete parsed[event]` when an event becomes
  empty.
- **Loader passes the plugin root.** `HooksSeam.mergePluginHooks` gains the
  optional third param `pluginRoot` (backward compatible with two-arg
  stubs); `mountHooks` forwards `options.pluginRoot`.
- **Seam type.** The bridge imports `type { HooksSeam } from
  '@dsh-cc/plugin-loader'` (a dev-only type dep — no runtime cycle), plus
  the cordis `Context` augmentation declaring the optional `hooks` service
  alongside `hookBridgeStatus`.
- **Isolation and ordering.** `hooks` is added to the cc-services group's
  `isolate:` map next to `mcp`, and the `- id: hooks-claude-code` block
  moves INSIDE the cc-services group immediately before `- id:
  cc-shell-glue`: the glue's `CcPluginsService.mountAll` probes
  `ctx.get('hooks')` at boot, so the bridge must have provided the seam
  first. Nothing between the glue and the bridge consumes bridge services
  at mount time (command-doctor reads `hookBridgeStatus` lazily), and the
  bridge's interception listeners use `prepend: true`, so ordering vs
  permission-rules is compose-order-insensitive.

## 3. Rejected alternative

A glue-owned buffering seam: have cc-shell-glue provide a `hooks` seam that
buffers `mergePluginHooks` calls until the bridge mounts, then replays them.
Rejected because it splits ownership of one lifecycle across two packages,
needs replay/dispose bookkeeping across the buffer boundary, and still
requires the same intra-group ordering constraint (the buffer must be
provided before the glue probes it) — all of the complexity with none of
the single-owner clarity. The direct bridge-owned provide is smaller and
matches the mcp seam precedent.

## 4. Known v1 limits (accepted)

- `/doctor` and `hookBridgeStatus` report boot config only: a
  boot-empty/plugin-present session shows "no hook events registered" even
  though plugin hooks are live. Surfacing merged plugin hooks in the status
  is a follow-up.
- Plugin merges are process-scoped; the per-session-hook-config TODO in the
  bridge config is untouched.
- A parse-FAILED plugin hooks file still counts `tally.addLoaded` in the
  loader (the seam call succeeded; the bridge rejects the config with a
  warn). Documented acceptance.

## 5. Verification

- `pnpm vitest run packages/hooks/hooks-claude-code
  packages/compat/cc-plugin-loader packages/bundle/cc-shell`
- `pnpm typecheck && pnpm check:capabilities && pnpm check:parity && pnpm
  check:spec-deps && pnpm check:deep-imports && pnpm check:size`
