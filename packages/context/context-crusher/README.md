# @dsh-cc/context-crusher

English | [中文](README.zh.md)

CCR (Compress-Cache-Retrieve) reversible tool-output compression. A `tools/post-execute` listener compresses large grep/log-shaped tool results, caches the original in a content-addressed store, and appends a `ccr://<hash>` marker; the `context_retrieve({ hash })` tool restores the original verbatim. Compression is risk-free because the original is always one call away.

## Gated flow

1. `tools/post-execute` fires; the crusher is the OUTERMOST listener (`{ prepend: true }`, mounted before the hooks bridge) and composes post-`next()`.
2. A non-`accept` downstream decision passes through untouched.
3. Gates, in order: disabled → protected tool (replace-semantics list) → short error (< 2×min) → under min size → non-text blocks → router `null` → savings ratio below threshold. Each gate degrades to passthrough.
4. `mode: 'dry-run'` (default) measures and appends a ledger row with `applied: false`; `mode: 'on'` stores the original, appends the marker, and replaces the result with one fresh text block. Downstream `additionalContexts` survive the replace.
5. Every I/O error degrades to passthrough; a missing `dshHomePath` force-disables the crusher. A throw here would turn the user's tool result into an error — data loss — so it never throws into the waterfall.

## Marker contract (pinned)

`[dsh-cc compressed BEFORE→AFTER tokens. Original: ccr://<hash>]` — appended to every replaced result. The `context_retrieve` tool description references the same `ccr://<hash>` spelling; a test pins the pairing. `hash` is `sha256(original utf8)` hex, first 16 chars.

## Store

`$DSH_HOME/ccr/<projectKey>/<hash16>`, projectKey = `sha256(session cwd)` first 16 hex (the worktree-path divergence from the TUI project-root convention is accepted: the store is self-consistent). Atomic temp+rename writes, plain UTF-8 envelope files, LRU 200 entries, TTL 3600 s, sweep-on-write (fire-and-forget). Corrupt/expired entries fail closed (`corrupt` / `expired` / `unknown_hash`).

## Config

Namespace `cc-context-compression` (settings overlay re-read on every use; config defaults under it). `protected-tools` REPLACES the default list when explicitly set — not a union.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master flag; the feature is opt-in. |
| `mode` | `dry-run` | `dry-run` measures only; `on` replaces. |
| `min-bytes` | `8192` | Minimum size before eligibility (token-meter tokens; the key keeps its legacy name). |
| `min-savings-ratio` | `0.4` | Minimum token saving fraction. |
| `protected-tools` | over-inclusive default list | Tools never crushed. |

## Caveats

- The transcript keeps the COMPRESSED form forever: TUI replay and `command-export` show the compressed blob (the original lives only in the store + ledger).
- `final-result` dispatches and tool-definition `finalizeContent` bypass or follow the waterfall and may rewrite crushed content — residual bypass classes, best-effort coverage.
- The marker is inert text; there is no auto-restore and no model-summarization.
