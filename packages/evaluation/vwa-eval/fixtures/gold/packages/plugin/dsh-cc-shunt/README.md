# dsh-cc-shunt

English | [中文](README.zh.md)

Official dsh-cc plugin that keeps bulk file content out of the main context.

**How it works**: two hard PreToolUse gates (Read and Bash) block whole-file
reads of large files; the block message redirects to the `bulk-reader` /
`code-writer` skills, which delegate to the plugin's cheap-lane worker
subagents (`shunt-reader`, `shunt-writer`). The file corpus is read — or
written — by the worker; only a compact digest or a one-line confirmation
returns to the main context.

- `shunt-reader` — answers questions across large files / many files / big
  diffs, returning a structured digest led by `file:line` references.
- `shunt-writer` — generates tests/config/stubs to disk matching a mandatory
  reference file's patterns; never returns the generated code body.

## Install / enable

The `dsh-cc` marketplace ships this plugin. Enable it in settings.json:

```json
{
  "enabledPlugins": { "dsh-cc-shunt@dsh-cc": true }
}
```

## Configuration

Set via the top-level `"env"` object in settings.json:

| Variable           | Default  | Meaning                                                            |
| ------------------ | -------- | ------------------------------------------------------------------ |
| `SHUNT_MIN_LINES`  | `350`    | Line-count threshold; whole-file reads above it are blocked        |
| `SHUNT_MAX_BYTES`  | `100000` | Byte threshold; blocks minified/one-line files regardless of lines |
| `SHUNT_DISABLED`   | unset    | Set to `1`/`true`/`yes` to disable both gates entirely             |

## Model alias requirement

**The shunt-worker agents pin `model: haiku`.** If your deployment's haiku
alias is unconfigured, the workers silently inherit the parent's model route
— everything works, but you get **zero token savings**. Configure the haiku
alias for actual savings.

## Subagent exemption

Hook invocations that carry CC-parity caller identity (`agent_id` on the
PreToolUse payload) bypass both gates. The field is injected by the dsh-cc
bridge when the caller is a live subagent — it is not user-settable via
`tool_input` — so workers (critic/executor/marathon, shunt-reader,
shunt-writer, and any other subagent) paginate and inspect files freely;
the gate's value lives on the main thread, where the harness read caps
would make a block pure churn anyway.

## Images

The Read gate sniffs magic bytes (PNG, JPEG, GIF, WEBP) before the
thresholds: `read_image` has no offset/limit, so large images are allowed
regardless of size, extensioned or extensionless. There is no extension
shortcut — a large **text** file named `*.png` is still gated. Any read
error falls through to the normal thresholds.

## Known limits

- Digest line references can go stale after edits — verify with a targeted
  offset/limit read before editing at a cited location.
- Nothing about debugging or architecture gets delegated — only bulk
  reading and boilerplate generation.
- Worker calls are one-shot and foreground; follow-ups mean re-spawning.
