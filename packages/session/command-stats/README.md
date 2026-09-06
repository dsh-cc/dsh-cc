# @dsh-cc/command-stats

English | [中文](README.zh.md)

Human-facing `/stats` command over the session event log: turn and step counts, tool-call distribution, and token usage totals. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/stats` | Show completed turn count, closed step count, surface user and assistant message counts, tool calls grouped by tool name (most-called first) with the total, and summed token usage (input / output / cache-read / cache-write) across every logged `assistant/message` usage record. A session with no activity says so directly. |

The counts and token totals fold from the session's durable event log; a command run consumes no model tokens.

## Composition

The producer injects `commands`. A custom app mounts its owner plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-stats
  name: '@dsh-cc/command-stats'
```

## Model Experience

The slash input and the direct statistics output are absent from model requests and consume no model tokens. Folding is a pure function of the session log; presentation text is never logged.

## Known Limitations and Deferred Work

- **Whole-log totals only** — per-turn or per-model breakdowns remain future work.
- **Raw counts, not wall times** — LLM/tool latency figures live in the `sessionStats` projection and are not duplicated here.
