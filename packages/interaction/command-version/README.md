# @dsh-cc/command-version

English | [中文](README.zh.md)

Human-facing `/version` command that prints the plugin bundle version and, when the host surfaces one, the harness version. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/version` | Print `@dsh-cc/plugins <version>`, plus a `harness <version>` line when the host exposes one. No network. |

The bundled version is read from this package's `package.json` at call time (with a compile-time fallback), so it is deterministic and offline-safe. The harness line appears only when a compatible host value is present.

## Composition

The plugin injects `commands`. A custom app mounts the owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-version
  name: '@dsh-cc/command-version'
```

## Model Experience

The slash input and output are absent from model requests and consume no model tokens. Presentation text is never logged.

## Known Limitations and Deferred Work

- **Harness version is optional** — the line appears only when the host surfaces a version; a harness that exposes none still prints the plugin bundle line.
