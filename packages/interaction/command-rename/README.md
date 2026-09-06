# @dsh-cc/command-rename

English | [中文](README.zh.md)

Human-facing `/rename <title>` command: pin an explicit user title on the current session through the optional host `sessionTitle` service. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md).

## Command contract

| Input | Result |
|---|---|
| `/rename <title>` | Rename the session to the trimmed `<title>`. The title service pins it, so automatic generation stops scheduling. Replies `Renamed to: <title>`. |
| `/rename` (no argument) | Error: `Usage: /rename <title>`; the service is not called. |

The command reads the optional `sessionTitle` seam at run time — a composition without it replies `renaming is unavailable: this deployment mounts no session-title service`. Validation failures raised by the service (e.g. a title with no visible characters) pass through as the command's error text.

## Composition

The producer injects `commands`. Mount it wherever the session-title service is composed (cc preset users already get it):

```yaml
- id: command-rename
  name: '@dsh-cc/command-rename'
```

## Model Experience

The slash input and the direct output are absent from model requests and consume no model tokens. The rename itself is a host-side log event (`session/title` with source `user`) that never reaches the model surface.

## Known Limitations and Deferred Work

- **No interactive confirmation** — like CC, the rename is immediate; undo is a second `/rename`.
- **No picker** — CC's title suggestions/rename menu is out of scope; this is the argued `<title>` form only.
