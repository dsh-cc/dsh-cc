# @dsh-cc/command-skills

English | [中文](README.zh.md)

Human-facing `/skills` command that lists every available skill with its description, source, and invocation policy (invocable by model, user, or both). The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/skills` | List each skill as `name — description (source: <source>, invocable by: <model and/or user>)`, sorted by name. A composition with no skills shows a placeholder. |

The catalog reflects whatever skill providers are composed; it is a read of `ctx.skills.list()` and loads no skill bodies.

## Composition

The plugin injects `commands` and `skills`. A custom app mounts the owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: skills
  name: '@deepseek-ai/dsh-skill'
- id: command-skills
  name: '@dsh-cc/command-skills'
```

## Model Experience

The slash input and output are absent from model requests and consume no model tokens. Presentation text is never logged.

## Known Limitations and Deferred Work

- **Provider-catalog view** — skills are shown only when a skill provider is composed and returns them; no bodies are loaded by this command.
