# @dsh-cc/command-resume

English | [中文](README.zh.md)

Human-facing `/resume` command: list the recent sessions (id, title, cwd, availability, and start time) so a user can pick one to resume. It reads the optional `sessionQuery` service. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md).

## Command contract

| Input | Result |
|---|---|
| `/resume` | List recent sessions newest-first: session id, latest folded title (when the log has one), cwd (when recorded), optional parent, availability (`live`/`persisted`), and creation time. Ends with the host-owned resume pointer. |

Only fields the `sessionQuery` API actually exposes are rendered; a field with no source is omitted. Empty results render a friendly placeholder. The command reads the optional `sessionQuery` seam — a composition without it reports the missing seam.

## Composition

The producer injects `commands`. A custom app mounts the session-query backend (e.g. `@deepseek-ai/dsh-session-query-sqlite`) plus this plugin:

```yaml
- id: session-query
  name: '@deepseek-ai/dsh-session-query-sqlite'
- id: command-resume
  name: '@dsh-cc/command-resume'
```

The `sessionQuery` seam is discovered via `ctx` at run time; it is not injected, so the command loads even without a query backend (and then reports the missing seam).

## Model Experience

The slash input and the direct output are absent from model requests and consume no model tokens. Outputs are pure reads of the session corpus.

## Known Limitations and Deferred Work

- **Session switching is host-owned** — the command only lists; to switch the user restarts with `dsh --resume <sessionId>`. It cannot switch the live process.
- **No `lastActive` field** — the `sessionQuery` API exposes creation time and availability, not a last-active timestamp, so no such line is rendered.
