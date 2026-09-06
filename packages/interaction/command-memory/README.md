# @dsh-cc/command-memory

English | [中文](README.zh.md)

Human-facing `/memory` command that lists the memdir memory files (name, type, first line) or prints one memory's body by name, reading through `ctx.fs`. The plugin registers one global command through [`ctx.commands`](../../interaction/commands/README.md), so every composed command adapter discovers and executes it without a model turn.

## Command contract

| Input | Result |
|---|---|
| `/memory` | List each topic as `- name (type) — first line`, sorted by name, plus the memory directory header. |
| `/memory <name>` | Print a single memory's frontmatter and full body, matched by frontmatter `name` or filename. An unknown name yields a friendly notice. |

Reads the default memory home unless configured via `memoryHome`; the project-scoped `.claude/memory` overlay is used when discoverable and no override is set. Fully read-only.

## Composition

The plugin injects `commands` and `fs`. A custom app mounts the owners plus this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: command-memory
  name: '@dsh-cc/command-memory'
```

The filesystem service provides the `fs` seam. Pass a `memoryHome` config to point at an explicit directory.

## Model Experience

The slash input and output are absent from model requests and consume no model tokens. Presentation text is never logged.

## Known Limitations and Deferred Work

- **Directory resolution** — the project overlay is used only when no explicit `memoryHome` is configured and a `.git` root is discoverable.
