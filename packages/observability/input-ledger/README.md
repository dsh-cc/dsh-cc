# @dsh-cc/input-ledger

English | [中文](README.zh.md)

Single schema source and pure sink/reader core for the per-step input ledger — the shared, content-free composition record the context-engineering input-governance program builds on. It holds **no observers and no cordis wiring** of its own: docs 1, 5, 7 and 8 import these row types, the writer and the typed readers, and the row-emitting observers are mounted by the preset 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L53-L53〕.

Units are **UTF-8 bytes everywhere** 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L82-L82〕. Timestamps are epoch milliseconds.

## Row schema (v1) — the single source

All five row types share a base and live only in `src/rows.ts`; the governor, dedupe and cap rows of docs 1/7 reference that file instead of redefining shapes 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L55-L80〕.

```
BaseRow = { v: 1; ts; sessionId; gen; turn?; step? }
```

`gen` is the process boot id (random at apply); `turn`/`step` come from the per-step payload and are absent — explicitly undefined, never inherited — for auxiliary calls.

| `type` | Producer | Payload |
|---|---|---|
| `assemble` | `system-prompt/assemble` observation | `isSubagent`, `sections: {name, bytes, hash8}[]`, `totalBytes`, `renderedFromCache` |
| `request` | `llm/stream` observation | `seqPerGen`, `provider`, `model`, `purpose?`, `mainLoop`, `systemBytes`, `systemHash8`, `toolsCount`, `toolsBytes`, `messages{count, bytesTotal, nonTextBlocks, bySourceKind, toolResults, assistantBytes}` |
| `governor` | Budget governor (doc 1) | `mode: 'observe' \| 'enforce'`, `bytesByClass`, `trimmed: {kind, bytes, action}[]`, `offeredBacklog`, `hardOver`, `error?: true` |
| `dedupe` | Injection dedupe (doc 7) | `applied`, `kind`, `hash12`, `suppressedWithin` |
| `cap` | Per-class cap (doc 7) | `applied`, `kind`, `runningCount`, `suppressedTotal` |

Governor trim actions are exactly `defer`, `drop-expired` and `drop-oversize`; observe mode maps its decisions onto the same `trimmed` array under `mode: 'observe'` rather than adding a parallel `wouldTrim` field. `runningCount` exists so observe mode can answer distributional flip questions.

## Writing

```ts
import { appendLedgerRow, sessionLedgerPath } from '@dsh-cc/input-ledger'

const file = sessionLedgerPath(dshHome, projectKey, sessionId) // <dshHome>/input-ledger/<projectKey>/<encodeSegment(sessionId)>.jsonl
await appendLedgerRow(file, row, onError)
```

- `sessionLedgerPath(dshHome, projectKey, sessionId)` — the session id is encoded as a single safe path segment by `encodeSegment` (`@dsh-cc/sidecar-io`), so `../`, separators and NUL never escape the project directory 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L108-L108〕.
- `appendLedgerRow(filePath, row, onError?)` — appends through sidecar-io `appendJsonl`, which creates parent directories and never throws. An `undefined` file path (no dshHome on the host) is a **no-op**, so a providerless host writes nothing and crashes nothing 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L111-L111〕.
- Rotation: once a session file holds `maxRowsPerFile` rows (default 2000, the cache-health precedent), the next append renames it to `<file>.1` — clobbering any previous archive — and starts a fresh file with that row. Readers tolerate a torn final line, so no fsync is needed 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L110-L110〕.
- `getLedgerHealth()` returns `{ droppedRows }`, an in-process counter of rows lost to failed appends. Write failures are never surfaced as notices and never propagate to a caller's waterfall 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L109-L109〕.
- Appends to the same file are serialized per target path, so the rotation count cannot race.

## Reading

`readAssembleRows` / `readRequestRows` / `readGovernorRows` / `readDedupeRows` / `readCapRows` each take a file path and return an `AsyncIterable` of their own row type. They skip rows of the other types (all producers share one file), rows that are not schema `v: 1`, and unparseable lines — including a torn final write. A missing file yields nothing. Every function in this package is pure module code: no cordis context is required, so offline tooling can use the same writer and readers.

## Privacy boundary

Recorded: section names and source-kind strings (compile-time identifiers, each hard-capped at 64 characters via `clampLabel`), provider/model route strings, numeric stats, and eight-hex truncated sha256 fingerprints of local prompt text 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L148-L148〕. The hashes never leave the machine; they are a local-only prefix-stability fingerprint, not an export format.

Never recorded: block texts, tool arguments, file paths inside content, environment data 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L149-L149〕. Enforcement is structural — the row types contain no text field at all — and pinned by a fixture: synthetic messages carrying `sk-…` and `Bearer …` credential-shaped strings must produce serialized rows in which those strings provably do not appear (`tests/privacy.spec.ts`) 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L150-L150〕.

## Measurement caveats

- An `assemble` row is an **assembly observation**, not the authoritative final prompt: outer listeners and complete-section restoration can still rewrite the text afterwards. The `request` row is the measurement of record for prompt bytes 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L90-L90〕.
- `request` rows read the `llm/stream` options as handed to the middleware chain — a pre-middleware view, not a wire-faithful byte rendering (the inherited `cache-health` seam limitation) 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L38-L38〕. `systemBytes`/`systemHash8` are computed from leading system-role and `source.kind === 'system-prompt'` messages, plus a one-shot `options.system` when present, because loop-built requests carry the system prompt inside `messages`.
