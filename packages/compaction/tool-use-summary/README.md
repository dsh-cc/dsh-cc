# @dsh-cc/tool-use-summary

English | [中文](README.zh.md)

The Tool Use Summary (TUS) pipeline (docs/plans/2026-09-15-side-queries.md §5): a fire-and-forget cheap-lane digest of every large tool result, keyed by `callId`, consumed at compaction time instead of re-reading raw output. Plain cordis plugin (publishes no Service — handoff-store/reasoning-fold pattern, so it needs no isolate key), mounted in the `cc-services` group of `packages/preset/cc`.

## Producer

The plugin registers an internal `tools/post-execute` listener **without `prepend`** (§5.6): the context-crusher uses `prepend: true` and stays the outermost listener, while TUS runs inside it and summarizes the RAW tool result regardless of any decision-level rewrite. After `next()` returns an accept decision, summarization is fire-and-forget: the listener returns the decision immediately and every fault degrades to a ledger row — never a throw into the waterfall, never an unhandled rejection.

Gates inside `maybeSummarize`, in order (first gate wins in the ledger): `enabled` → top-level sessions only (`topLevelOnly`; subagent workers are skipped, recall.ts precedent, fail closed) → result size ≥ `minResultBytes` → tool not in `excludeTools` → per-session cap `maxSummariesPerSession` (LRU eviction in memory) → dedupe by `callId`.

The side query runs through `@dsh-cc/side-query` (`runSideQuery`) on the configured `alias` (default `haiku`; unconfigured → parent-route inherit, recorded as `inheritedRoute: true`). The raw result is wrapped in hard delimiters with an explicit never-follow-instructions line (prompt-injection discipline on the way IN); the model is asked for a ≤150-word digest preserving file paths, identifiers, error messages, and numbers. Digests are clamped to 800 chars in the ledger.

Lifecycle (§5.2): `exec.signal` is deliberately NOT used (tool-scoped; it aborts before the digest lands). The side query composes `AbortSignal.timeout(timeoutMs)` with the plugin's effect-scope disposal signal. A disposal-aborted run writes no ledger row; a timed-out run writes `status: 'failed'`.

## Storage

Two faces of the same rows:

- In-memory `Map<callId, SummaryRow>` per session, LRU-bounded (`SummaryStore`).
- Append-only JSONL ledger `$DSH_HOME/tool-use-summary/<sessionId>.jsonl` (context-crusher `SavingsLedger` pattern: `mkdir -p` + one `appendFile` per row, all I/O errors swallowed).

```json
{"callId":"...","tool":"read","resultBytes":31240,"status":"ok","summary":"Read src/main.ts: exported run(), 312 lines.","inheritedRoute":false,"durationMs":12,"at":"2026-09-15T00:00:00.000Z"}
```

`status: 'skipped'` rows carry a `skipReason` (`disabled` / `not-top-level` / `small` / `excluded` / `duplicate`). `retentionDays: 0` disables persistence (memory only). A fire-and-forget sweep at plugin mount deletes ledger files older than `retentionDays`.

Consumers read via the exported pure reader `loadSummaries(dshHome, sessionId)` — tolerant of a truncated tail line (torn final write).

## Consumers

- **compaction-micro (Consumer A, §5.4):** stale microcompact placeholders are upgraded to carry the digest inside the mandatory untrusted-framing wrapper (`tusFramedSummary`); absent rows → the legacy placeholder bit-for-bit; context-crusher stubs (pinned marker `[dsh-cc compressed N→M tokens. Original: ccr://<hash>]`) are never substituted — their `context_retrieve` locator must survive.
- **compaction-basic-cc (Consumer B, §5.4):** the upstream `SummarizationInput` was probed POSITIVE (tool results arrive as `ToolResultMessage` with `source.callId`), so qualifying blocks are substituted with the same framed form in `applyTusSummaries`.

The untrusted framing on the CONSUMER side is mandatory: the haiku model can be made to emit injection text by a malicious tool result, and that text reaches the main model at compaction time.

The `upgradeMicroPlaceholders` gate is read through the same `cc-tool-use-summary` settings namespace (single source: `registerTusSettings` is idempotent per settings provider, so producer and consumers share one registration).

## Settings

Namespace `cc-tool-use-summary`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master flag; first gate. |
| `topLevelOnly` | `true` | Skip subagent sessions (workers compress inside their own session). |
| `minResultBytes` | `4096` | Minimum UTF-8 result size before eligibility. |
| `maxSummariesPerSession` | `200` | In-memory LRU cap per session (ledger keeps all rows). |
| `maxTokens` | `256` | Side-query token budget. |
| `timeoutMs` | `5000` | Side-query wall clock. |
| `alias` | `'haiku'` | Cheap-lane alias. |
| `excludeTools` | `['structured_output']` | Tool names never summarized. |
| `retentionDays` | `7` | Ledger retention; `0` = memory only. |
| `upgradeMicroPlaceholders` | `true` | Consumer A gate: micro placeholders carry the digest. |

## Shape

Plain cordis plugin (no Service, no isolate key). Degrades to a passthrough listener without a settings provider (schema defaults) and to in-memory-only without `dshHomePath`. Mounted by `packages/preset/cc` in the cc-services group. Tests: `tests/producer.spec.ts` (listener + gates + lifecycle), `tests/ledger.spec.ts` (round-trip + sweep), `tests/framing.spec.ts` (pinned crusher marker + consumer wrapper).
