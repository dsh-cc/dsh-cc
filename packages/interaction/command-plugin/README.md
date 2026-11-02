# @dsh-cc/command-plugin

English | [中文](README.zh.md)

Human-facing `/plugin` and `/reload-plugins` commands: list the mounted Claude Code plugins (name, root, and per-component load counts) and rescan the on-disk discovery roots to remount them live. The plugin registers two global commands through `ctx.commands`, so every composed command adapter finds and executes them without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/plugin` | List each mounted plugin's manifest name, plugin root, and per-component counts (`commands: N`, `agents: N`, `skills: N`, …), annotating non-zero skipped/failed components. |
| `/plugin list [--enabled\|--disabled]` | List installed plugins from the manager, optionally filtered to enabled or disabled ones. |
| `/plugin install\|uninstall\|enable\|disable\|update <plugin[@mkt]> [--scope user\|project\|local]` | Manage an installed plugin; `--scope` selects where the change applies. |
| `/plugin marketplace list\|add\|remove\|update` | Manage marketplaces (`add <source>`, `remove <name>`, `update [name]`, all accept `--scope` where applicable). |
| `/reload-plugins` | Dispose all tracked mounts in reverse mount order, re-run discovery, and remount; report the fresh mount list plus any per-root failures. |

The bare `/plugin` view and `/reload-plugins` read the optional `ccPlugins` service that cc-shell-glue mounts; the manage verbs also drive the optional `ccPluginManager`. A composition without the glue reports the seam gracefully instead of failing. None of the commands consumes model tokens.

## Composition

The producer injects `commands`. A custom app mounts the glue plus this plugin:

```yaml
- id: cc-shell-glue
  name: '@dsh-cc/bundle-shell'
- id: command-plugin
  name: '@dsh-cc/command-plugin'
```

The `ccPlugins` seam is discovered via `ctx` at run time; it is not injected, so the command loads even when glue is absent (and then reports the missing seam).

## Model Experience

The slash input and the direct outputs are absent from model requests and consume no model tokens. Outputs are pure reads of the mounted-plugin registry; presentation text is never logged.

## Known Limitations and Deferred Work

- **Plugin mount internals are glue-owned** — the command only enumerates/rescans what `ccPlugins` already tracks; it cannot mount a plugin root that discovery skipped.
- **No per-component detail** — the report is counts plus reasons where the loader supplies them; verbatim component bodies are out of scope.
