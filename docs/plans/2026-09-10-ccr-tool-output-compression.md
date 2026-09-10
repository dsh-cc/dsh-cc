# CCR: Reversible Tool-Output Compression (Compress-Cache-Retrieve)

Date: 2026-09-10. Status: implemented (this PR) — critic cold review passed
with amendments (8 items: tokenMeter injection, post-next composition,
project-keyed content-addressed store, order-tripwire test, result.meta
original stash, final-result bypass note, ponytail cuts, protected-tools
widening); all baked in. Staff review (binding) later removed the
`result.meta` stash (D1) and is folded in below. No harness changes;
everything composes via existing seams.

## 1. Problem

Large tool outputs (ripgrep hits, build/test logs, multi-file diffs, big
JSON API responses) enter the context verbatim and stay re-sent on every
subsequent turn. dsh-cc-shunt gates *pre-read* bulk output by delegating to
reader subagents, but anything that slips past the gate — or is produced by
tools other than Read/Bash — lands full-size in the session. dsh-cc has no
post-hoc compression layer today.

The approach: compress aggressively, keep the original in a
local content-addressed store, and give the model a retrieval tool.
Compression becomes risk-free because the original is always one call away.

## 2. Feasibility ground truth (verified 2026-09-10, re-verified in review)

Harness anchors (the `deepseek-harness` checkout, read-only):
- `tools/post-execute` waterfall (`packages/core/tools/src/index.ts:167`,
  dispatch ~:1733-1774; worktree mirror
  `packages/core/tools/src/runtime-results.ts:54-80`) runs BEFORE the loop
  commits the result (`agent-loop/src/tool-calls.ts:269`, called from
  `commitReady` ~:152-159), and the commit writes exactly
  `result.content`. Replacing `PostToolDecision.content` is therefore what
  the session — and the next model turn — sees. Live-zone-only by
  construction: the already-committed prefix is never touched, so provider
  KV-cache stays warm.
- `content` and `value` cannot be replaced together (throws,
  `runtime-results.ts:68`).
- Known current post-execute listeners: memory recall
  (`packages/memory/memory/src/recall.ts:247`, pure observer), resume-pins
  (`packages/subagent/resume-pins/src/plugin.ts:323`, send_message only),
  and the PostToolUse hooks bridge
  (`packages/hooks/hooks-claude-code/src/register-events.ts:117`,
  registered WITHOUT prepend). Waterfalls are outermost-first by
  registration order; `{ prepend: true }` makes the crusher outermost
  TODAY but only by mount-order accident — pinned by test (§5).
- A token meter IS exposed: `ctx.tokenMeter.estimateMessage` /
  `estimateContent` (harness `packages/llm/token-meter/src/index.ts:198-200`);
  dsh-cc consumption precedent `packages/compaction/compaction-micro/src/index.ts:74,164`
  (`static inject = ['tokenMeter']`).
- Host packages register agent-visible tools on `ctx.tools`
  (precedent: `packages/memory/memory/src/save.ts:123-130`).
- Project bucket convention: `sha256(projectRoot).slice(0, 16)`
  (`packages/ui/tui/src/project.ts:190-192`).
- Freeze order correction (staff review): deepFreeze/materialization happens
  AFTER the post-execute waterfall — `finalizeScheduledExecution` (:1602)
  runs the waterfall, then `finishScheduledExecution` (:1625+) materializes
  and freezes the result. The pre-committed prefix stays untouched (true as
  claimed); the earlier "result already frozen at listener time" claim was
  wrong.
- `final-result` results bypass post-execute entirely
  (`packages/core/tools/src/tool-types.ts:234-243`) — the crusher is
  best-effort for those dispatches (extent unverified; documented).

## 3. Design

New package `packages/context/context-crusher` (cordis host package,
`inject = ['tokenMeter']`, mounted in the cc preset's cc-services group).

### 3.1 ContentRouter (pure, deterministic)

Inspects the tool result and dispatches to one compressor. Detection by
structure, no LLM. Phase 0 ships ONLY Search and Log (see §4):

| Signal | Compressor | Preserves |
|---|---|---|
| `file:line:content` rows | SearchCompressor | matching lines + file paths, clusters |
| timestamps/log levels, pytest/npm markers | LogCompressor | errors, stack traces, first N lines per cluster |

Diff and JSON compressors deferred (JsonCrusher's lossy "shape summary" is
the riskiest piece — needs ledger data first). Every compressor is pure
`string -> string | null` (null = no safe saving → passthrough). Sizes use
`tokenMeter.estimateContent` — NOT chars/4 (CJK/JSON mis-gating).

### 3.2 CrusherStore

**Content-addressed, project-keyed, session-agnostic:**
`$DSH_HOME/ccr/<projectKey>/<hash>` where hash = sha256(original).slice(0,16)
and projectKey follows the `sha256(projectRoot).slice(0,16)` convention.
NO `<sessionId>` segment: resume/fork re-id sessions, and session-keyed
markers would 404 after resume. Plain UTF-8 files (no zstd subprocess).
LRU eviction at 200 entries and TTL 3600 s are hard-coded constants with
sweep-on-write; corrupt/expired entries fail closed on retrieve.

### 3.3 `tools/post-execute` crusher listener

Registered `{ prepend: true }`, composed post-`next()` (strip-instructions
pattern, `strip-instructions.ts:72-76`):

```
async (decision, next) => {
  const d = await next();              // downstream decides first
  if (d.kind !== 'accept') return d;   // NEVER replace a block/deny
  ...compress d.content..., keep d.additionalContexts spread through
}
```

Consequence to state explicitly: PostToolUse hooks (inner) see the
ORIGINAL content; the session stores the compressed form. Gates, in order:
flag off → skip; tool in `protectedTools` → skip (defaults: `edit`,
`write`, `memory_save`, `ask_user_question`, plus any tool whose output is
parsed by downstream code — structured-output class); short errors
(`isError && size < 2×minBytes`) → skip; size < `minBytes` (default 8 KB)
→ skip — min-bytes is the primary defense for misparsed outputs; router
returns null → passthrough; saving ratio < `minSavingsRatio` (default 0.4)
→ passthrough. On replace: store the original atomically and append a
ledger row. Provenance carriers are the MARKER TEXT (persisted with the
compressed content) plus the ledger row — `result.meta` is NOT writable
from post-execute: `PostToolDecision` carries no meta field, and mutating
the result in place is forbidden (results may be frozen; violates the
Readonly contract). A future UI expansion surface reads the marker +
ledger instead.

Dry-run mode: everything above minus the replace — ledger row gets
`applied: false`. **Phase 0 ships dry-run only** — measure before
replacing — so savings are measured on dogfood sessions
before anyone turns replacement on.

### 3.4 Retrieval tool

Same package registers `context_retrieve({ hash })` via `ctx.tools`:
resolves `$DSH_HOME/ccr/<projectKey>/<hash>`; needs no session resolution
at all (content-addressed store). Returns original text or typed error
(`unknown_hash` / `expired` / `corrupt`). Fail-closed; never reads outside
the store root. Marker wording (`ccr://<hash>`) ↔ tool description is a
pinned contract test.

### 3.5 Savings ledger

Append-only `$DSH_HOME/ccr/savings.jsonl`: `{ts, sessionId, tool, kind,
charsBefore, charsAfter, tokensBefore, tokensAfter, applied, hash}` —
sessionId lives ONLY here, never in the store path. Read by the
cache-health observer feature and a future `/cost` enrichment.

### 3.6 Configuration (kebab namespace, settings-cascade)

`cc-context-compression.enabled` (default `false`),
`.mode` (`dry-run`|`on`, default `dry-run`), `.min-bytes` (default 8192),
`.min-savings-ratio` (default 0.4), `.protected-tools` (string[]). TTL and
max-entries are constants until ledger data justifies knobs.

## 4. Phases

0. Router (Search+Log) + store + dry-run + ledger. No replacement path
   ships. Goal: measured ratios on real sessions.
1. Replacement + `context_retrieve` + marker contract; default stays
   `dry-run`; docs to opt in.
2. Tuning from ledger; consider default `on` for Search/Log. Follow-ups
   (own PRs): Diff/Json compressors, UI expansion via `result.meta`,
   `/cost` savings surface, shared artifact-store extraction (see the
   handoff-store design's follow-up).

## 5. Verification

- Unit: compressor invariants on synthetic fixtures; store LRU/TTL/
  corruption; marker round-trip.
- Composition (real preset, no hand-rolled fakes — resume-pins lesson):
  - crusher fires outermost vs the hooks PostToolUse bridge ORDER-TRIPWIRE
    (the order fragility is pinned by test, not comment);
  - PostToolUse hook payload sees ORIGINAL content; next model-facing
    `tool/result` carries the compressed text + marker;
  - `context_retrieve(hash)` returns the original verbatim;
  - downstream `block` decision passes through untouched;
  - the committed `tool/result` content carries the marker text with the
    `ccr://<hash>` handle (the ledger row carries the same hash) —
    `result.meta` is not a provenance carrier (see §3.3).
- Cache safety: identical-prefix turns around a large tool result; assert
  prior events byte-untouched via `snapshotEvents()` window.

## 6. Risks / explicit non-goals

- Transcript effect: `appendToolResult` persists compressed content — TUI
  replay and `command-export` show the compressed blob forever; the original
  lives only in the store + ledger (the marker text is the in-transcript
  provenance), documented here deliberately.
- `final-result` dispatches bypass the waterfall — best-effort coverage.
- `applyFinalContent` bypass: definition-owned content finalization runs
  after the waterfall and may rewrite crushed content — residual bypass
  class alongside `final-result`.
- Model retrieval loops: marker is inert text; no auto-restore.
- No LLM summarization in v1; no `agent/request`/history mutation (cache
  hot-zone protection by construction).
- Harness read-only; all composition via existing seams.
