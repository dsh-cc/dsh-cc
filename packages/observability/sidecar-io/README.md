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
| `truncateUtf8(text, maxBytes)` | function | UTF-8-safe byte truncation: a split multi-byte sequence degrades to a replacement character instead of corrupting earlier bytes. |
| `encodeSegment(raw)` | function | Encode an arbitrary string as one safe, injectively decodable path segment (safe code units stay literal, every other unit becomes `~XXXX`; `.` and `..` are special-cased). Throws on an empty string. |
| `AppendJsonlOptions` | type | `{ repairTail?: boolean; onError?: (err: unknown) => void }`, the options of `appendJsonl` |
| `appendJsonl(filePath, row, opts?)` | async | `mkdir -p` the dirname, append `JSON.stringify(row) + '\n'`. Never throws. `opts` carries `repairTail` (append a missing trailing newline first) and `onError` (receive the swallowed error). |
| `readJsonl<T>(filePath)` | async | Parse per line, skip blank and malformed lines (torn tail writes are skipped, not fatal). Never throws. |

## Consumers

17 packages depend on this module:

- `@dsh-cc/cache-health`
- `@dsh-cc/command-cost`
- `@dsh-cc/compaction-basic`
- `@dsh-cc/compaction-cost-gate`
- `@dsh-cc/compaction-micro`
- `@dsh-cc/completion-gate`
- `@dsh-cc/config-snapshot`
- `@dsh-cc/context-crusher`
- `@dsh-cc/decision-usage`
- `@dsh-cc/handoff-store`
- `@dsh-cc/input-ledger`
- `@dsh-cc/moa`
- `@dsh-cc/reasoning-fold`
- `@dsh-cc/skill-usage`
- `@dsh-cc/tool-use-summary`
- `@dsh-cc/turn-rules`
- `@dsh-cc/vwa-evidence`
