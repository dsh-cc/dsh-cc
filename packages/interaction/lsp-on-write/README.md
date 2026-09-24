# @dsh-cc/lsp-on-write

English | [中文](README.zh.md)

LSP diagnostics-on-write: after a successful `edit`/`write`/`NotebookEdit`, the plugin pulls the touched file's current diagnostics from the **running serena language servers** (via the `mcpConnections` registry, one uncached `tools/call`) and appends a compact `[lsp]` block to the **same** tool result — the model sees "argument of type X is not assignable" immediately and self-corrects next step, instead of finding out at test time. **Default OFF** (`cc-lsp-on-write.enabled: false`, opt-in).

## How it works

The plugin registers a `tools/post-execute` listener (plain plugin, no Service, no isolate key) that composes inside context-crusher's outermost post-execute listener — the listener is registered **without prepend**. On every accepted editing-tool result it re-reads the raw user-layer settings file (hot reload, a few KB), and if enabled issues exactly **one** MCP call per edit (`get_diagnostics_for_file` with the path computed relative to the session cwd) through the `mcpConnections` registry — never through the tools waterfall, so there is no recursion and no permission-gating round trip. Any failure (absent server, timeout over the `timeout-ms` budget, MCP error, response schema drift) degrades to a silent drop with a debug counter; the appended block is capped at `max-diagnostics` entries and 4 KB with a reconciled `… (N more)` suffix. After 3 consecutive dropped calls for the same server the listener auto-disables for the rest of the session (one debug line).

Diagnostics are sourced from serena's `get_diagnostics_for_file`, which queries its language server on demand. Known limitation: serena resolves `relative_path` against its own project root, which normally equals the session cwd; if they differ the call returns empty or drops.

## Settings (user layer only)

Key `cc-lsp-on-write` in the **user-layer** `settings.json` (the harness-home file). Project scope is never read.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master flag, **opt-in** (ships dark). |
| `server-name` | `serena` | The MCP connection name to call; a renamed serena mount yields zero diagnostics (one lazy warn). |
| `timeout-ms` | `1500` | Hard latency budget per call; timeout → drop, never a failed tool result. |
| `max-diagnostics` | `8` | Rendered-entry cap (errors before warnings). |
| `min-severity` | `warning` | `warning` = errors + warnings; `error` = errors only. |
| `tool-names` | (built-in) | Optional override replacing the matched tool set (`edit`, `write`, `NotebookEdit`). |

## Shape

Plain cordis plugin (no Service, no isolate key). Mounted by `packages/preset/cc` in the cc-services group, right after edit-recovery-hint. Fail-soft: every fault degrades to a passthrough — the user's tool result is never turned into an error.
