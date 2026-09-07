# @dsh-cc/plugin-loader

English | [中文](README.zh.md)

Load a Claude Code plugin's `plugin.json` manifest and mount each component as an in-memory dsh plugin.

This compatibility loader reads a CC plugin manifest subset, translates each component with the pure helpers from [`@dsh-cc/skill-loader`](../../skill/skill-claude-code/README.md) and [`@dsh-cc/claude-code-agents`](../../preset/claude-code-agents/README.md), and consults the host seam for that component through `ctx.get(...)`. It is not a runtime: it produces typed mounts and a structural report, leaving execution to the seams it registers onto.

## Discovery

`discoverCcPluginRoots({ pluginDirs?, claudeHome?, cwd? })` is the glue's on-disk finder:

| `pluginDirs` | Behavior |
|---|---|
| `undefined` (default) | Intersection of `enabledPlugins` (user → project → local settings cascade) and `{claudeHome}/plugins/installed_plugins.json`. Keys must be exact `name@marketplace`. `$CLAUDE_CONFIG_DIR` (else `~/.claude`) is the Claude home. |
| `[]` or `null` | Empty — discovery disabled. |
| non-empty | Flatten those dirs: the dir itself, or one-level children, that hold `.claude-plugin/plugin.json` or top-level `plugin.json`. Marketplace-only dirs are not flatten roots. |

Unreadable JSON and missing `installPath`s skip rather than throw. Project/local `enabledPlugins` are boot-cwd-biased (host-plane singleton); `/reload-plugins` re-reads the cascade.

## Loader

`mountCcPlugin(ctx, { root, nameHint?, seams? })` resolves the manifest, validates the subset, and mounts every present component as a Cordis effect. It returns `{ report, dispose }` — `report` is the per-component outcome, and `dispose` recalls every mounted component (a context teardown calls it automatically).

Manifest resolution order:

1. `${root}/.claude-plugin/plugin.json` (preferred Claude Code path)
2. `${root}/plugin.json` (legacy / explicit-`pluginDirs` fixtures)
3. `${root}/.claude-plugin/marketplace.json` matching `nameHint` — synthesizes the overlay and **replaces** the default `skills/` scan. A marketplace file with no matching `nameHint` is a hard miss (never fall through to synthesis).
4. Else synthesize `{ name: nameHint ?? basename(root) }` so an optional manifest still mounts default dirs.

When the manifest omits `commands`, the loader scans `commands/*.md`. Nested command directories are skipped with a reason. Declared `commands` still replace the default dir.

### Manifest subset

The loader validates `name` (mandatory, kebab-case), `version`, `description`, `author`, and the component fields `commands`, `agents`, `skills`, `hooks`, `mcpServers`, and `settings`. A malformed manifest throws at load with the plugin name. Unknown top-level fields are ignored, matching Claude Code's tolerant handling.

### Components and their seams

Each component is peer-style: the loader probes the host seam via `ctx.get(...)` and reports the component `skipped` (never failing the whole load) when the seam is absent.

| Component | Source | Seam (probed) | Translation |
|---|---|---|---|
| `commands` | manifest inline/source, or default `commands/*.md` | `commands` | registers each slash command via `register`; the handler returns the command content |
| `agents` | `agents/` dir or manifest paths | `subagents` | loads `AgentDefinition`s via `loadAgentsDir` and registers each as a named provider via `registerProvider` — namespaced under the plugin name (`namespacePrefix: manifest.name`), so `provider.name` is the scoped id `plugin:agent` while `provider.definition.agentType` stays bare; the provider also exposes its `definition` for the Task tool's live enumeration. Mounting **without** a `namespacePrefix` keeps bare names — such agents are then **undiscoverable to the Task tool** (a back-compat escape hatch, not a supported dispatch mode) |
| `skills` | `skills/` dir or manifest paths | `skills` | discovers `SKILL.md` via `discoverCcSkills`, parses frontmatter, and registers each as a runtime skill via `register` |
| `hooks` | `hooks/hooks.json` or inline | `hooks` (guest) | injects the per-event hook map via `mergePluginHooks` |
| `mcpServers` | inline record or `.mcp.json` | `mcp` (guest) | registers each server via `registerServer` (tool naming is the seam's responsibility) |
| `settings` | manifest record | `settings` (guest) | filters to the allowlist (currently `agent`) and writes via `set` |

The `hooks` and `mcp` seams have no harness-owned service today; a deployment that wants those components provides a guest seam or they are reported skipped.

## Skill semantic wiring

On top of the skill mount, this package is the consumer that turns `skill-claude-code`'s metadata into actionable registrations:

- **`allowed-tools`** — `skillToolRestriction(metadata)` builds the allow-only `tools.restrict()` filter; `applySkillRestriction(metadata, agent)` applies it to a scoped agent and returns the disposer.
- **`context: fork`** — `resolveSkillExecution(metadata, subagentsPresent)` routes the skill to subagent execution; when the subagent seam is absent it downgrades to inline and is reported.
- **`paths`** — `registerSkillPathActivator(ctx, skill, projectRoot)` wires the `fs/observed` path activator for conditional activation.
- **Inline shell** — `activationFor(metadata, subagentsPresent)` reports `forbidInlineShell` (a `shell: false` skill must not open an inline shell).

## Known Limitations and Deferred Work

- **Guest seams are absent in the harness** — `hooks`, `mcp`, and `settings` report `skipped` unless a deployment supplies the guest seam. There is no harness-owned `ctx.mcp` or `ctx.hooks` service today.
- **Agent providers forward execution** — the agents provider names its backend (default `fork`) and delegates `start`; executing a CC agent requires a `fork` backend on the subagent seam at run time.
- **Skill activation is host-driven** — the loader registers the wiring and activation descriptors; applying them at the model-facing moment is the host's responsibility.
- **Agents ADD the default `agents/` dir to manifest paths** — Claude Code replaces the default when `agents` is declared. Unchanged here.
- **Skills-directory plugins, managed settings, `defaultEnabled`, and walking `cache/`/`marketplaces/` are out of scope.**
