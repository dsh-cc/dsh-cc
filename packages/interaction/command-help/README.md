# @dsh-cc/command-help

English | [中文](README.zh.md)

Human-facing `/help` command that lists every registered slash command, or shows the detail for one named command (including its input hint). The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/help` | List every registered command as `/name — description`, sorted by name. |
| `/help <cmd>` | Show one command's detail (name, description, and input hint when declared). An unknown command yields a friendly notice. |

Command details come from the command registry itself; only commands registered in the current composition are shown.

## Composition

The plugin injects `commands`. A custom app mounts the owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-help
  name: '@dsh-cc/command-help'
```

## Model Experience

The slash input and output are absent from model requests and consume no model tokens. Presentation text is never logged.

## Known Limitations and Deferred Work

- **Registry-scoped view** — only commands registered in the current composition are listed; a command mounted under another agent scope is not shown.
