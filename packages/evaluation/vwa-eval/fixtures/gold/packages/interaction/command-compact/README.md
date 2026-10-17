# @dsh-cc/command-compact

English | [中文](README.zh.md)

The human-facing `/compact` slash command with optional preservation instructions: `/compact` runs the same idle-session manual compaction as upstream, and `/compact <instructions>` additionally parks the free-text hint on the invoking agent so the CC compaction engine's summarizer preserves what the user asked for.

## Usage

The package is a cordis plugin; registering it mounts the command for every composed human-command adapter:

```ts
import commandCompact from '@dsh-cc/command-compact'

ctx.plugin(commandCompact) // injects `commands` and `compaction`
```

## What it provides

- `/compact` — compact older conversation history and report the shadowed item count and approximate token count; `No compactable history yet.` when nothing is compactable.
- `/compact [instructions]` — free-text preservation instructions, handed to `@dsh-cc/compaction-basic`'s hint seam before compaction runs.
- Trailing `help` / `-h` / `--help` is answered by `@dsh-cc/command-usage` with plain-text help, no model turn.
- Expected capability failures (`busy`, `cancelled`, `changed`, `summary`, `commit`, `persistence`) from `ManualCompactionError` are converted into concise human-only error outcomes instead of raw errors.

## Notes

- The hint is cleared in a `finally` block, so a failed or no-op compaction never leaves a stale hint parked for a later turn.
- Already-started handler promises quiesce on teardown (yielded drain before unregister), so no invocation is left in flight during composite teardown.
- Subcommand `@dsh-cc/command-compact/invariant` registers the package's invariant companion; it installs no runtime invariant because the command is a thin adapter over the upstream-verified compaction seam.
