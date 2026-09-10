# @dsh-cc/handoff-store

English | [中文](README.zh.md)

Subagent handoff store: the `handoff_put` / `handoff_get` tool pair lets a sandboxed or read-only subagent park a large artifact (a long review, plan, or report) in a durable store and hand back a short summary embedding a `handoff://<id>` handle; the orchestrator or a follow-up child resolves the handle with `handoff_get`. This closes the residual-bulk gap in dsh-cc's delegation discipline — a critic (no Write) cannot put its report in a repo file, and the parent's only other channel is the full final-message text.

## Store

`$DSH_HOME/handoff/<projectKey>/<id>.md`, flat per project (no per-session subdir; the session lives in the ledger). `projectKey = sha256(session cwd)` first 16 hex, derived from the FETCHING session's cwd (CCR `context_retrieve` precedent). `id = sha256(content utf8)` first 16 hex + a 4-hex random suffix — identical content stored twice yields distinct ids. Files are plain UTF-8 JSON envelopes `{v, ts, text, label?, agent?}`, written atomically (temp + rename).

**Same-cwd requirement**: a handle only resolves for sessions whose cwd hashes to the same projectKey. Cross-project fetch is intentionally `unknown_id`. **Git-worktree caveat**: two worktrees of one repo are different keys — a child spawned in a different worktree cannot fetch a handle parked elsewhere.

## Retention

TTL 24 h (checked against the stored envelope `ts` on every read; expired → typed `expired` error and a lazy delete) plus a 500-entry LRU per project. Both sweeps are DISK-BASED (`readdir` + envelope/mtime over the projectKey dir, run on put) — deliberately no in-memory LRU, because spawned children are separate processes and a fresh store instance must see the same eviction state. Reads bump mtime (LRU touch); the sweep's TTL pass uses mtime as a cheap proxy while the envelope `ts` stays authoritative on read.

## Ledger

`$DSH_HOME/handoff/ledger.jsonl`, append-only rows `{ts, project, sessionId, id, label?, agent?, chars}`. A rebuildable observability index, never on the read path; interleaved appends from sibling children are tolerated. All ledger I/O errors are swallowed.

## Settings

Namespace `cc-handoff` (settings overlay, re-read on every put — CCR settings pattern):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master flag; `false` disables `handoff_put`. |
| `threshold-chars` | `8192` | Advisory size threshold referenced in the tool description. ADVISORY ONLY: put never enforces or rejects on it. |

## Tools

- `handoff_put({ content, label?, agent? })` → summary text including `handoff://<id>` and the char count (plus an advisory note when over the threshold). Keyed by the putting session's cwd.
- `handoff_get({ id, maxChars? })` → the content, head-truncated with a trailing truncation note when `maxChars` is given. Typed errors `unknown_id` / `expired` / `corrupt`. Fail-closed: the id must match `^[0-9a-f]{20}$` and resolves only inside the current projectKey directory — never outside the store root.

The plugin is a plain cordis plugin (publishes no Service, memory pattern); it no-ops when the tools service, fs seam, or `dshHomePath` is absent.
