# @dsh-cc/tool-sleep

English | [中文](README.zh.md)

Model-facing `Sleep` tool that waits for a specified duration with cooperative cancellation, aligned to Claude Code's `SleepTool` semantics. It registers into `ctx.tools` via the `@dsh-cc/tools` `ToolRuntime`.

## Tools

### `Sleep`

Waits for `{ duration }` seconds.

| Arg | Type | Notes |
|---|---|---|
| `duration` | number | Seconds to wait. Must be a finite, non-negative number. `0` is a no-op. |

The wait is cooperative with cancellation: it arms a timer and an `abort` listener on `exec.signal`, and settles on whichever fires first. When a new turn cancels the call mid-sleep, the tool stops waiting immediately and reports the canonical `ABORTED` outcome — matching CC's `interruptBehavior: 'cancel'`.

The tool is `isConcurrencySafe = () => true`, so it may overlap sibling tool calls (CC: "You can call this concurrently with other tools — it won't interfere with them"). Prefer it over spawning a sleeping subprocess, because it does not hold a subprocess or a shell.

## Configuration

`Config` is schemastery-typed (mirroring the git-worktree tools' convention):

```ts
export const Config = z.object({
  minDurationSeconds: z.number(),  // optional lower bound (clamped up)
  maxDurationSeconds: z.number(),  // optional upper bound (clamped down)
})
```

Each `apply(ctx, config)` call registers the `Sleep` tool into `ctx.tools`. Requires a loaded `ctx.tools`; the plugin stays pending until `inject: ['tools']` is satisfied.

## Install / registration

```ts
import * as ToolSleep from '@dsh-cc/tool-sleep'

await ctx.plugin(ToolRuntime)   // @dsh-cc/tools
await ctx.plugin(ToolSleep)     // registers the Sleep tool
```

## Choice of semantics

- **Duration in seconds** matches the model-facing parameter contract.
- **Interrupt-cancel** via `exec.signal` reproduces CC's behavior where a user prompt during sleep interrupts and cancels the current turn.
- **Concurrency-safe** so `Sleep` never forms an ordering barrier against sibling calls.

## Build order

`tool-sleep` depends only on the workspace `@dsh-cc/tools` package and harness base packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/schemastery`). It has no dependency on git-worktree or any other workspace package, so it builds as soon as `core/tools` does; `tsc -b` resolves the reference order automatically.

## Known limitations

- The `minDurationSeconds` / `maxDurationSeconds` clamps are a loose analog of CC's `minSleepDurationMs` / `maxSleepDurationMs` process settings; they are per-`apply` config here rather than global runtime settings.
- No `tick`/progress steaming is emitted (CC emits `sleep_progress` ticks in its REPL); the wait is silent on the protocol level.
