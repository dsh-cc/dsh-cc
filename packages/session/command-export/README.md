# @dsh-cc/command-export

English | [中文](README.zh.md)

Human-facing `/export` command that writes the current session transcript to a file through [`ctx.fs`](../../fs/fs/README.md) as markdown (default) or lossless JSON. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/export` | Write a markdown transcript of the session to `<defaultDir>/transcript-<sessionId>.md` and report the written path and byte count. |
| `/export json` | Write a lossless JSON transcript (the raw event log) instead. |
| `/export [json] <path>` | Write to `<path>` (a trailing `/` or a bare name resolves against the default directory; a `.md`/`.json` extension is honored, otherwise appended). |

The markdown transcript renders each model-visible event (user, assistant, tool result) as a section; a session with no conversation events exports a document that says so. The JSON transcript is the raw durable event log, so command lifecycle (and any) records appear verbatim alongside conversation events.

## Configuration

The plugin `Config` carries the default export directory:

```yaml
- id: command-export
  name: '@dsh-cc/command-export'
  config:
    defaultDir: ./exports
```

When no explicit path is supplied the transcript is written under `defaultDir`; an explicit path overrides it.

## Composition

The producer injects `commands` and `fs`. A custom app mounts their owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: fs
  name: '@deepseek-ai/dsh-fs-local'
- id: command-export
  name: '@dsh-cc/command-export'
```

## Model Experience

The slash input, the file write, and the direct success/error output are absent from model requests and consume no model tokens. Rendering is a pure function of the session log; presentation text is never logged.

## Known Limitations and Deferred Work

- **No archive directory creation** — the target directory must exist; the filesystem seam does not mkdir.
- **Plain-text-only output** — HTML, PDF, or sanitized redacted transcripts remain future work.
