# @dsh-cc/tool-notebook-edit

English | [中文](README.zh.md)

Model-facing `NotebookEdit` tool that edits Jupyter notebook (.ipynb) cells, aligned to Claude Code's `NotebookEditTool` replace/insert/delete semantics and cell addressing. It registers into `ctx.tools` via the `@dsh-cc/tools` `ToolRuntime` and reads/writes through the harness `ctx.fs` seam.

## Tools

### `NotebookEdit`

Edits one cell of a `.ipynb` notebook.

| Arg | Type | Notes |
|---|---|---|
| `notebook_path` | string | Absolute path to the `.ipynb` file (must be absolute; non-.ipynb rejected). |
| `new_source` | string | The new source for the cell. |
| `cell_id` | string | Optional. The cell to edit; when `edit_mode=insert`, the new cell is inserted after this one (or at the beginning when omitted). |
| `cell_type` | `code` / `markdown` | Optional. Defaults to the current cell type; required for `insert`. |
| `edit_mode` | `replace` / `insert` / `delete` | Optional. Defaults to `replace`. |

Cell references address a cell by its real `id` first, then by the legacy zero-based `cell-<index>` form CC displays for id-less cells — so older notebooks (nbformat 4 < 4.5) are editable the same way CC edits them. Replace clears a code cell's `execution_count` and `outputs`; insert mints a fresh id on nbformat >= 4.5; delete removes the cell.

## Read-before-write gate

Matching CC's `validateInput`, the tool refuses to write a notebook the model never read, and refuses a stale write when the file changed since that read. The gate is driven by the harness observation seam: the plugin keeps a `readStates` map on `apply()` and records every present `fs/observed` observation (the event the Read/Write/Edit tools emit on commit), keyed by resolved path. On execute it rejects a path with no observed read, rejects a path whose current `ctx.fs.stat()` version no longer equals the observed one, and after writing re-baselines the map to the write outcome's version — so its own write counts as the latest read. The seam exposes an opaque `FsVersion` freshness token rather than an mtime; comparing that token is the seam's native staleness check and is strictly stronger than CC's mtime comparison.

The tool is `isConcurrencySafe = () => false`: it mutates shared cell state and the read baseline, so it must never overlap a sibling `NotebookEdit` call.

## Configuration

`Config` is schemastery-typed and currently empty (reserved for future caps):

```ts
export const Config = z.object({})
```

Each `apply(ctx, config)` call registers the `NotebookEdit` tool into `ctx.tools` and its `fs/observed` listener. Requires a loaded `ctx.tools` and an active `ctx.fs` backend (e.g. `@deepseek-ai/dsh-fs-local`); the plugin stays pending until `inject: ['tools', 'fs']` is satisfied.

## Install / registration

```ts
import * as ToolNotebookEdit from '@dsh-cc/tool-notebook-edit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'

await ctx.plugin(SystemPrompt)
await ctx.plugin(ToolRuntime)            // @dsh-cc/tools
await ctx.plugin(LocalFileSystem, { cwd }) // ctx.fs backend
await ctx.plugin(ToolNotebookEdit)        // registers the NotebookEdit tool + listener
```

## Choice of semantics

- **replace / insert / delete** and **cell addressing** mirror CC's `NotebookEditTool` exactly, including the `cell-<n>` fallback for id-less notebooks and the clear-outputs-on-replace behavior.
- **Read-before-write gate** reproduces CC's "read first" / "modified since read" rejections as typed `NotebookEditError`s with stable codes.
- **Write re-baselines** so a second edit without a fresh Read is allowed, exactly as CC's `readFileState` is updated by its own write.

## Build order

`tool-notebook-edit` depends on the workspace `@dsh-cc/tools` package and harness base packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-fs`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/schemastery`). It has no dependency on any other workspace package, so it builds as soon as `core/tools` does; `tsc -b` resolves the reference order automatically.

## Known limitations

- The notebook is rewritten as single-space-indented JSON (matching CC's `IPYNB_INDENT = 1`); surrounding formatting is not preserved.
- `source` arrays in existing cells are replaced with the given `new_source` string rather than preserved as arrays (same as CC).
- The read baseline is plugin-lifetime: it resets on plugin reload (HMR), so a model that read a notebook before a reload is asked to Read again first.
