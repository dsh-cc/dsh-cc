# dsh-cc-bundle-shell

English | [中文](README.zh.md)

The CC shell **host-plane infra** bundle. This package carries the pieces that are genuinely host-level — the tools-registry swap with deferred-name support, and the settings-migrations mechanism — plus the `cc-shell-glue` plugin *code* (the glue code still lives here, but its mount action is performed by the CC preset, not this bundle's patch). All agent-facing composition — tool-search, skill loader, memory, coordinator, worktree/sleep/notebook/structured-output tools, the 19 slash commands, the hook bridge, output-style rendering — moved to the [`@dsh-cc/preset-cc`](../../preset/cc/README.md) composition package, so it can be isolated per preset instead of leaking into every mode.

## What it does

- **Tools registry swap.** Disables the in-box `tools` row and remounts `@dsh-cc/tools`. `reserve()`/`isAdmitted()` join the restrictable-name universe, so permission gates can name deferred tools before they load; the shipped behavior otherwise matches upstream. The base row's `DSH_TOOLS_MODE` toggle is carried forward ($DSH_HOME / process.cwd() semantics unchanged).
- **Settings migrations.** Mounts `@dsh-cc/settings-migrations` to apply version-gated `settings.json` migrations at startup (equivalent to CC's `runMigrations`). Empty registry — mechanism only — for now.
- **Glue plugin code (mounted by the CC preset).** `cc-shell-glue` mounts what a cordis patch row cannot express statically: on-disk Claude Code plugins, `.mcp.json` server wiring, and a built-in plugin `mcp` seam (`cc-mcp-seam`, so plugin `mcpServers` mount via mcp-client). Default plugin discovery is `enabledPlugins` ∩ `installed_plugins.json` under `$CLAUDE_CONFIG_DIR` / `~/.claude` (exact `name@marketplace` keys, `installPath` as the plugin root). Explicit `pluginDirs` still flattens those dirs; `[]`/`null` disables. Discovery is best-effort — missing paths and unreadable JSON mount nothing. It also exposes the `ccPlugins` service for live enumeration/rescan of mounted plugins (`/reload-plugins` re-reads the cascade). The glue threads the spawn-time `resolveModel` into `AgentProvider` as a
  **lazy trampoline** over the `ccModelRoutes` service:
  `(model) => ctx.get('ccModelRoutes')?.resolve(model)` — queried on every spawn, degrading to
  inherit the parent route when the service is unmounted.

### What moved out of the glue

Two pieces that used to live in `cc-shell-glue` moved to their owning packages:

- **`model-aliases` settings-namespace registration** → the `@dsh-cc/model-aliases`
  `ccModelRoutes` service (`packages/compat/cc-model-aliases`). The glue no longer registers
  the namespace (a duplicate registration would throw); it only consumes the service lazily.
  `Config.modelAliases` was removed from the glue config.
- **Base CC-agent discovery** (`~/.claude/agents` + `<cwd>/.claude/agents` → subagent
  providers) → the `@dsh-cc/subagent-task` Task tool, which discovers per the **session**
  cwd (not the host process cwd). `Config.registerBaseAgents` was removed.

## Known limits / notes

- This bundle no longer globally mounts any agent-facing surface. Only the host-plane infra rows (tools registry swap + settings-migrations) are mounted by this bundle's `cordis.patch.yml`; the glue plugin and all agent surfaces are mounted by `@dsh-cc/preset-cc` so they stay scoped to that preset.
- Because the tool-web executor row is unshipped by the CLI dependency tree through rc.6, fetch-based web tooling is mounted by the preset, not here; see the preset's "Known limits" for the current fetch status.
- Project/local `enabledPlugins` are boot-cwd-biased (the glue is a host-plane singleton, same as `.mcp.json`). `/reload-plugins` is the live escape hatch. `$CLAUDE_CONFIG_DIR` is honored for plugin discovery; `.mcp.json` still hardcodes `~/.claude`.
