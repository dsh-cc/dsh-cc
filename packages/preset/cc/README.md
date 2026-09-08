# @dsh-cc/preset-cc

English | [中文](README.zh.md)

The **CC 模式** (CC mode) agent preset for the DeepSeek Harness (dsh): the fifth agent preset alongside the stock `standard`, `minimal`, and the other built-ins. It composes the Claude Code surface — Claude hooks, on-disk CC plugin directories, slash commands, memory, CC output styles, and CC-style WebFetch — on top of the complete standard preset. This package is **composition-only**: no TypeScript runtime code, just `agent.cordis.yml` (the flatted agent entry list) plus `preset.yml` metadata.

## What it does

- **A full standard-mode baseline.** `agent.cordis.yml` opens with a verbatim copy of the stock `standard` preset (the 16 baseline rows), so a CC-mode session keeps every capability of the standard coding agent.
- **A scoped CC surface.** The `cc rows` section mounts the Claude Code parity plugins — hook bridge (18 of 30 hook events), CC plugin-directory glue, `ToolSearch`, memory + consolidation, output styles, the coordinator, 21 slash commands, and the worktree/sleep/notebook/structured-output and git tools. WebFetch: stock `tool-web` runs with `fetch: false` and the 60s search timeout carried forward; `web_fetch` is replaced by the cc-services `tool-web-fetch` row (`@dsh-cc/tool-web-fetch`, optional `prompt` summarized on the cheap lane). The fetch executor is the stock dsh-base provider (DNS-pinned, public-only per hop) with CC egress caps restated in the cc-shell patch, and the tool upgrades `http:` URLs to `https:` (CC parity); an optional prompt without the `haiku` route hard-fails before any fetch.
- **Session titles and `/rename`.** The cc-shell bundle swaps the stock `session-title-llm` host row for `@dsh-cc/session-title-provider`, a first-prompt title provider that stamps the `haiku` cheap lane when configured (else it inherits the main route), and this preset mounts `@dsh-cc/command-rename` so `/rename <title>` pins a user title.
- **Isolated service realms.** Service-bearing rows (tool search, microcompactor, plugin registry, MCP connections, hook-bridge status, plugin MCP seam) live inside the `cc-services` group with the seven required `isolate` keys, so they publish into an entry-local realm instead of the process-global root realm (which would trip the preset mount gate).
- **CC Task delegation (`tool-task` + `cc-model-routes`).** The `cc-services` group also mounts `@dsh-cc/subagent-task` (the CC Task tool, `subagent_type` dispatch over per-workspace `.claude/agents` definitions) and `@dsh-cc/model-aliases` (`cc-model-routes`, owning the `model-aliases` settings namespace and the spawn-time alias resolver). In this preset the harness `tool-subagent` and `tool-subagent-fork` rows are **disabled** in favour of the replacement Task, which is a **foreground one-shot** — it no longer offers the durable background/`continuable` workflow (`report`/`send_message`) that `tool-subagent-fork` previously exposed. See the task package README and the parity matrix for the known limits.

These rows previously lived in the global `cc-shell` patch (`packages/bundle/cc-shell/cordis.patch.yml`) and leaked into every agent preset. Scoping them to this preset is exactly what isolates each surface.

## Install

```bash
bash scripts/sync-local-profile.sh web   # mirror @dsh-cc/* packages into the profile
bash scripts/sync-cc-preset.sh           # install the cc preset into ~/.dsh/.agent-presets/
```

Both scripts copy, they do not symlink; plugin code and preset files are read at boot, so **restart dsh** after the first install (subsequent file edits are picked up on the next restart too).

## Select

- **Web UI**: pick "CC mode" from the agent-preset selector; or
- **settings**: `~/.dsh/settings.json` → `"agent-presets": { "default": "cc" }`.
- **TUI**: `dsh --profile tui` (or `dsh-cc`) boots the terminal surface with this preset as the default.

## Known limits

1. **Standing mount, host-plane singletons.** A preset is mounted once per process under a standing scope. MCP connections, the on-disk CC plugin directories loaded by the glue, the subagent-provider roster, and CC-plugin `settings.json` writes resolve to process-shared host-plane singletons (the same criterion upstream `subagents`/`goals` already follow), so those are not per-session across simultaneously mounted presets.
2. **Vendored baseline, drift gate.** The standard baseline is vendored. After upgrading dsh, run the drift gate (`pnpm vitest run packages/preset/cc`, or the binary directly) to re-diff it against the new standard preset and fold in upstream changes. On a CI machine with no dsh install present, the gate auto-skips via `it.runIf`.
3. **Uninstall is deletion.** Remove `~/.dsh/.agent-presets/cc` (or however it was installed); the four built-in modes are unaffected — a user-root preset of the same `id` never overrides the installed system-root entries.
4. **`DSH_COORDINATOR_MODE=1` breaks this preset's mount.** The coordinator needs an agent `ctx`, and a standing mount has none; that failure is now scoped to this preset's session creation. In the old global-patch era the whole app failed to boot — the blast radius is narrower, but the mode is still unsupported here.
5. **A settings default to a missing preset errors.** If the default names a preset that does not exist, session creation reports `agent-preset-not-found` (the `details.available` list names the valid ids). Reset by pointing `~/.dsh/settings.json` → `agent-presets.default` back to `standard`.

## Links

- Source composition: `agent.cordis.yml` (baseline + `cc rows`)
- Metadata: `preset.yml`
- Origin rows: `packages/bundle/cc-shell/cordis.patch.yml`
- Composition contract: `tests/composition.spec.ts`
