# @dsh-cc/sidecar-io

English | [中文](README.zh.md)

Shared sidecar IO plumbing for dsh-cc observer packages: dsh-home resolution, project-key hashing, and JSONL ledger append/read with swallow-on-error. Ledger ordering/trimming sinks stay per-package; this module holds only the byte-identical primitives that were being copied across five packages.

## Exports

| Export | Kind | Notes |
|---|---|---|
| `HomeFn` | type | `(...segments: string[]) => string` — the `ctx.dshHomePath` resolver shape. |
| `dshHomeFn(ctx)` | function | Reads `ctx.dshHomePath` defensively; cordis throws on the property access itself, so the read is guarded. Returns `undefined` when absent. |
| `shortHash(input, width = 16)` | function | sha256 hex, first `width` chars — the shared project/content key shape. |
| `projectKeyOf(cwd, width = 16)` | function | `shortHash(cwd, width)` alias for ledger project keys. |
| `jsonlPath(root, ...parts)` | function | Path join for ledger files under a dsh-home root. |
| `appendJsonl(filePath, row)` | async | `mkdir -p` the dirname, append `JSON.stringify(row) + '\n'`. Never throws. |
| `readJsonl<T>(filePath)` | async | Parse per line, skip blank and malformed lines (torn tail writes are skipped, not fatal). Never throws. |

## Consumers

- `@dsh-cc/reasoning-fold`
- `@dsh-cc/cache-health`
- `@dsh-cc/compaction-cost-gate`
- `@dsh-cc/tool-use-summary`
- `@dsh-cc/context-crusher`
