# @dsh-cc/command-status

English | [中文](README.zh.md)

Human-facing `/status` command: a session status summary showing the current model, permission preset, session id, and working directory. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/status` | Show the current `provider/model` (from the latest `request/header`), the effective permission preset (when the permission service is mounted), the session id, and the working directory. Lines whose source is absent in the current composition are omitted rather than shown empty. |

The model line reads the session's durable `request/header` log; the preset line reads [`ctx.permissionPresets`](../permission-presets/README.md) when present. A composition without either source simply omits that line. Running `/status` consumes no model tokens.

## Composition

The producer injects `commands`. A custom app mounts their owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-status
  name: '@dsh-cc/command-status'
```

When the permission-presets stack is composed, its line appears automatically; otherwise it is omitted.

## Model Experience

The slash input and the direct status output are absent from model requests and consume no model tokens. All lines are pure reads of the session log and composed services; presentation text is never logged.

## Known Limitations and Deferred Work

- **No MCP/hooks mount line** — the harness has no runtime registry of mounted hooks or MCP servers to enumerate; that line is omitted until such a registry exists.
- **Model is the last logged route** — a header is only known after the first `request/header` event; before that the line is omitted.
