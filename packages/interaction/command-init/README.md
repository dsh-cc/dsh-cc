# @dsh-cc/command-init

English | [中文](README.zh.md)

Human-facing `/init` slash command: queue a CLAUDE.md initialization for the model. The command does no analysis itself — it hands a CC-faithful init prompt to the agent as a follow-up user turn and immediately acknowledges.

## Usage

```ts
import { apply } from '@dsh-cc/command-init'

apply(ctx)
```

## What it provides

- `/init` — submits the init instruction (analyze the repository, identify build/test commands, note conventions, write or refresh CLAUDE.md) via `invocation.agent.followup`, then replies `Initializing CLAUDE.md…`.
- The prompt is exported as `INIT_PROMPT` (with `initContent()` returning its user-message content block) so hosts can inspect or reuse it.

## Notes

- Injects only the `commands` service; the actual work happens in the queued model turn, not the command handler.
- Wraps the command with `@dsh-cc/command-usage` so `help`/`-h`/`--help` render deterministic help.
