# @dsh-cc/command-diff

English | [中文](README.zh.md)

Human-facing `/diff` slash command for git working directories: show `git diff --stat` for the whole tree, or the capped diff for a single file, through the session's shell service. Timeboxed (10s per git invocation); a non-git working directory yields a friendly message, never a thrown error.

## Usage

```ts
import { apply } from '@dsh-cc/command-diff'

apply(ctx)
```

## What it provides

- `/diff` — runs `git diff --stat` in the session's working directory and renders the summary (or `No changes.` when empty).
- `/diff [path]` — runs `git diff -- <path>` and caps the output at `MAX_DIFF_LINES` (400) lines, appending a `… (N more lines)` note when truncated.
- A git probe (`rev-parse --is-inside-work-tree`) runs first; outside a repository the command answers with a friendly message instead of failing.

## Notes

- Injects the `commands` and `shell` services; paths are single-quote-escaped before being placed in the shell command string.
- Wraps the command with `@dsh-cc/command-usage` so `help`/`-h`/`--help` render deterministic help.
