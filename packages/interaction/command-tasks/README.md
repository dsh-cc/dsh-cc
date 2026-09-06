# @dsh-cc/command-tasks

English | [中文](README.zh.md)

Human-facing `/tasks` command: list the caller-visible background jobs and their status. It reads the injected `jobs` service. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md).

## Command contract

| Input | Result |
|---|---|
| `/tasks` | List each caller-visible job's id (`<kind>-N`), kind, lifecycle status, start time, and producer label. An empty visible set renders a friendly placeholder. |

The command injects `commands` and `jobs`, so a composition that runs background jobs is required. No form consumes model tokens.

## Composition

The producer injects `commands` and `jobs`. A custom app mounts the job registry (e.g. `@deepseek-ai/dsh-jobs-local`) plus this plugin:

```yaml
- id: jobs
  name: '@deepseek-ai/dsh-jobs-local'
- id: command-tasks
  name: '@dsh-cc/command-tasks'
```

## Model Experience

The slash input and the direct output are absent from model requests and consume no model tokens. Outputs are pure reads of the jobs service; presentation text is never logged.

## Known Limitations and Deferred Work

- **Todos are out of scope** — the command renders background jobs only; todo-style items live outside the background-job registry and are intentionally not surfaced.
- **Read-only** — the command lists jobs; cancellation goes through the job controller (`kill`) and is not wired here.
