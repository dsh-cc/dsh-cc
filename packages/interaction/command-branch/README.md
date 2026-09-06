# @dsh-cc/command-branch

English | [中文](README.zh.md)

Human-facing `/branch [note]` command: fork the current session into a new child branch and report the child session id. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md).

## Command contract

| Input | Result |
|---|---|
| `/branch` | Fork the invocation's own session (through the current last event) and report the new child session id plus entry instructions. |
| `/branch <note>` | Same, with the free-text note echoed back in the success report. |

Forking is read from the injected session store. A composition without the store, or a fork that the store rejects (e.g. a non-live source), reports a friendly error instead of failing. No form consumes model tokens.

## Composition

The producer injects `commands`. A custom app mounts the session store plus this plugin:

```yaml
- id: sessions
  name: '@deepseek-ai/dsh-session'
- id: command-branch
  name: '@dsh-cc/command-branch'
```

The session store is discovered via `ctx` at run time; it is not injected, so the command loads even without a store (and then reports the missing seam).

## Model Experience

The slash input and the direct output are absent from model requests and consume no model tokens. The output is a one-shot fork drive over the session store; presentation text is never logged.

## Known Limitations and Deferred Work

- **Fork boundary is the current last event** — the command does not expose a `boundary` argument, so it always forks through the session's latest event.
- **The note is not persisted** — an optional note is echoed back to the user but is not written into the session title/log by this command (no lightweight title API is wired).
- **Switching is host-owned** — like `/resume`, the command reports `dsh --resume <childId>` but does not switch the live process.
