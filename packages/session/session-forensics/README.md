# @dsh-cc/session-forensics

English | [中文](README.zh.md)

Pure analysis library behind the `/learn` feature: it walks the durable session JSONL store and distills recurring failure→success corrections. It has no cordis dependency and no runtime dependencies at all — hosts inject a `decompress(file): Promise<string>` seam (a default `decompressJsonl` shells out to the `zstd` binary, mirroring the audit-scripts precedent) so unit tests run on plain fixture text.

## What it does

- **Scanner** (`scan.ts`): walks `<DSH_HOME>/sessions/<projectKey>/<sessionId>/session.jsonl.zstd`, reads the session header (`origin`, `delegationDepth`, `parentSession`), and normalizes `tool/call` + `tool/result` events into records. `tool/call` arguments arrive as a JSON-encoded string and are parsed with tolerance for parse failures. Truncated live-tail lines are ignored; corrupt middle lines are skipped and counted — never thrown. A `days` recency filter uses directory mtime first and falls back to the header timestamp only when mtime is missing or unreasonable; a session inside the window is decompressed exactly once.
- **Approval pairing**: `approval/asked` events are paired with `approval/decided` by `data.id`; `approval/policy` events (e.g. `policy: "never"`) mark sessions excluded from denial analysis.
- **Analyzers** (`analyze/`), all deterministic — no LLM in v1:
  1. `path-correlation` — same-tool failures (path-shaped error gate: ENOENT / "No such file" / "not found") correlated with the first later success in line order sharing a basename in a different directory; bash pairs require the same first token plus ≥1 differing path-ish token.
  2. `env-facts` — same first-token commands failing vs succeeding with distinct error signatures (e.g. `python3` ModuleNotFoundError vs `uv run python` success).
  3. `search-scope` — failed narrow-root greps followed by successful broader-root greps on similar patterns.
  4. `permission-denials` — `rejected` approval outcomes only (`cancelled` and `unavailable` are not denials); `approval/policy: never` sessions excluded from the denominator.
  5. `large-files` — read results above a size threshold → "always use offset/limit".
- **Aggregation** (`runForensics`): findings merge by `(kind, title)`, rank by occurrence count, and pass a `minOccurrences` gate (default 2). Every finding carries `session:<id>#turn=<n>` evidence anchors.

## Composition

This is a library, not a plugin — import it. The consumer that mounts it as a user-facing command is [`@dsh-cc/command-learn`](../command-learn/README.md).

## Known Limitations and Deferred Work

- Deterministic analyzers only — an optional LLM summarization pass over the findings is deliberately out of v1.
- The bash path-ish token rule is intentionally simple (`/`-containing or file-extension-shaped tokens); `minOccurrences` is the actual precision mechanism. Upgrading the rule is future work.
