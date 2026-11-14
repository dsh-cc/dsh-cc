# @dsh-cc/command-init

English | [中文](README.zh.md)

Human-facing `/init` slash command: queue a CLAUDE.md initialization for the model. The command does no analysis itself — it hands a CC-faithful init prompt to the agent as a follow-up user turn and acknowledges after the MoA routing step returns.

## Usage

```ts
import { apply } from '@dsh-cc/command-init'

apply(ctx)
```

## What it provides

- `/init` — submits the init instruction (analyze the repository, identify build/test commands, note conventions, write or refresh CLAUDE.md) via `invocation.agent.followup`, then replies `Initializing CLAUDE.md…`.
- The command injects the init prompt itself. `INIT_PROMPT` and `initContent()` live in `src/init.ts` and stay internal: they are not re-exported from the package entry, and `src` is not published.

## Notes

- Injects only the `commands` service. The model work happens in the queued turn; the handler awaits a MoA routing step (`routeBeforeAdmission`) before the followup, so the acknowledgement is emitted after that await.
- Depends on `@dsh-cc/moa` for entry-point routing. `routeBeforeAdmission` is side-effect-free when moa is unmounted.
- Wraps the command with `@dsh-cc/command-usage` so `help`/`-h`/`--help` render deterministic help.
