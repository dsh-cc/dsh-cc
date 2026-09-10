# Session Failure Learning (`/learn`)

Date: 2026-09-10. Status: proposed — critic cold review passed with
amendments (8 items: child-session naming fix, approval-event analyzer
rewire, correlation-heuristic tightening, exact event shape doc, memory
helper anchors, host confirmation, LLM pass cut from v1, unverified
residuals recorded); all baked in.
Borrowed from headroom's `headroom learn`
(https://docs.headroomlabs.ai/docs/failure-learning); adapted to dsh-cc's
session JSONL store and memory subsystem, zero harness changes.

## 1. Problem

The same mistakes recur across sessions: wrong file paths re-guessed,
environment commands retried until the right incantation syntax, searches
scoped too narrowly, commands the user keeps rejecting. dsh-cc has a
durable memory system, but nothing distills failures into it
automatically. Headroom's insight is *success correlation*: don't catalog
failures — find what FIX followed each failure and record the correction.

## 2. Feasibility ground truth (verified 2026-09-10 on real transcripts)

Exact event shapes (verified against sampled real session logs):
- Transcripts at `$DSH_HOME/sessions/<projectKey>/<id>/session.jsonl.zstd`
  (all sampled dirs zstd; plaintext path exists in harness
  `packages/session/session-persistence-jsonl/src/format.ts:35-38`).
- `tool/call`: `{type:"tool/call", seq, data:{turn, step, callId, name,
  arguments}}` — **`arguments` is a JSON-encoded string**, analyzers must
  `JSON.parse` and tolerate parse failures.
- `tool/result`: `data.message.content[0]` is `{type:"tool-result",
  toolCallId, content:[{type:"text", text}], isError}`; pairing key at
  `data.message.source.callId`.
- **Child sessions are separate session DIRECTORIES** whose first line is
  `{"type":"session", ..., "parentSession", "origin":"subagent",
  "delegationDepth":1}` — there is no `session.N.jsonl` naming. Filtering
  by origin is header-based.
- Approval events are structured and pairable: `approval/asked`
  (`data:{id, toolName, callId, reason}`) → `approval/decided`
  (`data:{id, outcome}`; `allowed-once` observed — the denied-outcome
  strings are unverified and must be confirmed against
  `packages/core/session/src/known-event-types.ts` consumers before
  hardcoding). `approval/policy` events (e.g. `policy:"never",
  source:"delegation"`) explain zero-ask subagent sessions.
- Memory write path: `packages/memory/memory/src/writeback.ts:137`
  `writeMemoryFiles(fs, dir, writes)` plus `save.ts:66/73`
  `pointerLine()` / `upsertPointer()` are exported pure helpers — exactly
  the "index surgery" this feature needs; the caller must supply a
  host-side `FileSystem` seam (same as the writeback host).
- Cordis slash command is the right host (verified): commands run
  host-side with fs/spawn access; hooks fire on the wrong cadence; a
  standalone CLI loses `ctx`.

## 3. Design

New packages: `packages/session/session-forensics` (pure analysis
library, no cordis) + `packages/session/command-learn` (cordis command).

### 3.1 Scanner (`session-forensics`)

Walk `$DSH_HOME/sessions/**/session.jsonl.zstd`
(project filter default: current project key; `all` opt-in; `days=N`
recency filter, default 14 — file mtime vs. parse-everything is a
phase-0 spot-check, not assumed). zstd via child process (precedent:
`scripts/audit-subagent-children.mjs`); tolerate truncated tail lines.
Emit normalized records: `{project, sessionId, origin, delegationDepth,
turn, step, name, argsRaw, args(parsed|null), resultChars, isError,
ts}`.

### 3.2 Analyzers (deterministic; no LLM in v1)

Each consumes records + approval events and emits `Finding`s with
evidence anchors `session:<id>#turn=<n>`.

1. **Success correlation** — tightened in review:
   - tool allowlist: `read`, `edit`, `glob`, `grep`, `bash` only;
   - per-tool arg extractors work on the PARSED args object
     (paths may hide inside JSON values, e.g. serena MCP tools'
     `name_path_pattern`);
   - path tools: failed path and successful path share a filename but
     differ in directory;
   - bash: require identical first token AND ≥1 differing path-ish token,
     first tokens like `pnpm`/`node` alone are noise;
   - **gate**: the failure's error text must be path/file-shaped
     (ENOENT / "No such file" / "not found") before path correlation is
     attempted — logic/test failures are out of this analyzer's scope.
2. **Environment facts**: same first-token failing vs succeeding command
   pairs with distinct error signatures (e.g. ModuleNotFoundError under
   `python3`, success under `uv run python`).
3. **Search scope**: failed greps on narrow roots followed by successful
   broader-root greps on similar patterns.
4. **Permission denials — rewired in review**: driven by
   `approval/asked`|`approval/decided` pairs (by `data.id`), filtered on
   the denied outcome string (confirm enum before hardcoding — see §2);
   yields toolName + human reason for free. Sessions with
   `approval/policy: never` are excluded from the denominator. Reason
   this beats result-text sniffing: `[sandbox: ...]` markers are prose,
   locale/format-brittle.
5. **Large files**: Read results above a size threshold → "always use
   offset/limit on X".

### 3.3 Writer

One workspace-scope topic file `session-learnings.md` with a
marker-delimited managed block:

```
<!-- dsh-cc:learn:start -->
## Session Learnings
*Auto-generated by /learn — do not edit manually*
...
<!-- dsh-cc:learn:end -->
```

Persisted via `writeMemoryFiles` + `upsertPointer` (exported helpers) with
the host-supplied fs — no re-implementation, no direct pen on MEMORY.md.
Re-run replaces only the block. Nothing writes into the repo.

### 3.4 Command surface

`/learn` (dry-run: ranked findings + proposed block), `/learn apply`,
`/learn all`, `/learn days=30`, `/learn help` via `helpable()`.
Structure precedent: `/plugin` subcommands.

### 3.5 Configuration

`cc-learn.enabled` (default `true` — on-demand command, nothing runs
unprompted), `cc-learn.days` (default 14), `cc-learn.min-occurrences`
(default 2 — only repeated corrections are written).

## 4. Phases

0. Forensics library + dry-run `/learn`; mtime-vs-parse spot-check;
   dogfood; manual precision check on 20 findings (this gate survives).
1. `apply` + writer + marker blocks.
2. Future, only if deterministic findings prove too raw: a forked
   cheap-lane summarizer returning structured `writes[]` (toolFilter
   mandatory — rogue-fork lesson). A weekly scheduled suggestion is NOT
   planned.

## 5. Verification

- Unit: JSONL parsing (zstd-child, truncated tails); argument JSON-string
  parsing incl. parse-failure tolerance; each analyzer on synthetic
  streams (correlation window edges; non-path failures excluded from
  analyzer 1; `approval/policy: never` sessions excluded from 4).
- Component: real preset composition with tmp-seeded `$DSH_HOME` fixture
  sessions (house rule); `/learn` snapshot; `apply` writes via the REAL
  writeback path (no faked fs service).
- Negative: empty history → clean "no findings"; corrupt lines skipped
  with count, never thrown.

## 6. Risks / explicit non-goals

- Precision of analyzer 1 after clamping is the main unknown — the
  phase-0 20-finding manual gate catches it before `apply` ships.
- Denied-outcome enum strings unverified — confirm against
  `known-event-types.ts` consumers at implementation time.
- Residual: if mtime is unreliable on session dirs, `days` filtering must
  parse headers — noted for phase 0.
- Stale learnings: blocks are wholesale-refreshed per run, findings keep
  evidence anchors/counts.
- No repo writes, no CLAUDE.md target, no LLM in v1, strictly local.
