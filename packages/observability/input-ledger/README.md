# @dsh-cc/input-ledger

English | [中文](README.zh.md)

Per-step input ledger for the context-engineering input-governance program: the single schema source, a pure sink and typed readers, and the three row-emitting observers registered by a reference-counted mount. It records what actually entered the model on a given step — section-level and message-source-level composition, byte sizes and short local hashes — and never any content 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L19-L27〕. The preset mounts it as the top-level `input-ledger` row 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L53-L53〕.

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

## Observers

Three observe-only listeners, all registered by `mountInputLedger(ctx)`. Any exception inside an observer yields zero rows for that call plus a debug log — an observer never throws into a waterfall 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L152-L154〕.

- **Assembly** (`system-prompt/assemble`, no `prepend`) — runs inside every prepended rewriter, so it sees the innermost-final view at its position. Emits an `assemble` row with per-section `{name, bytes, hash8}` and `totalBytes`; `renderedFromCache` compares the row against the previous one for the same `(sessionId, scopeKey)` cache 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L84-L90〕. Scope-less assemblies carry no session identity and are skipped by convention.
- **Request** (`llm/stream`, `{global: true, prepend: true}`) — synchronous, computed before `next()`, never touching the options. `seqPerGen` is monotonic per `(sessionId, gen)`; `purpose` is recorded verbatim from the open augmentation map; `mainLoop` is `purpose === undefined` and auxiliary calls leave `turn`/`step` undefined 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L92-L104〕.
- **Attribution** (`agent/pre-step`, `{prepend: true}`, delegate-first) — records `(turn, step)` and the session's project/routing facts from the payload, then returns `next()` unchanged 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L102-L104〕.

Rows are emitted only after Observer C has attributed the session (the request path needs its project bucket), and delegated sessions are skipped when `include-subagents` is false.

## Mounting

The preset's top-level `input-ledger` row mounts this package as a plain cordis plugin: `apply(ctx)` is the whole plugin entry, and it declares no `inject` because the package publishes no Service. Everything else lives in `mountInputLedger(ctx)`, which registers the listeners on the **root** context and returns a release handle 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L125-L133〕. Cordis unregisters a preset's listeners when that preset unloads, so a plain "already mounted" flag would suppress observation after one preset unloads while another stays mounted; the mount is therefore reference-counted:

- first mount on a root registers three listeners; every further mount only increments `refs` (the cc + vwa double include of the preset body is covered);
- each release decrements; listeners are disposed only when the count reaches zero, and a repeated release is inert;
- `apply(ctx)` registers the release handle as a fiber effect, so the owning preset's unload decrements the count instead of orphaning the listeners; a package without that entry point never starts at preset composition.
- `mountStateOf(ctx)` exposes `{ listenerCount, refs }` for tests.

## Writing

```ts
import { appendLedgerRow, sessionLedgerPath } from '@dsh-cc/input-ledger'

const file = sessionLedgerPath(dshHome, projectKey, sessionId) // <dshHome>/input-ledger/<projectKey>/<encodeSegment(sessionId)>.jsonl
await appendLedgerRow(file, row, onError)
```

- `sessionLedgerPath(dshHome, projectKey, sessionId)` — the session id is encoded as a single safe path segment by `encodeSegment` (`@dsh-cc/sidecar-io`), so `../`, separators and NUL never escape the project directory 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L108-L108〕.
- `appendLedgerRow(filePath, row, onError?, maxRowsPerFile?)` — appends through sidecar-io `appendJsonl`, which creates parent directories and never throws. An `undefined` file path (no dshHome on the host) is a **no-op**, so a providerless host writes nothing and crashes nothing 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L111-L111〕.
- Rotation: once a session file holds `maxRowsPerFile` rows (default 2000, the cache-health precedent), the next append renames it to `<file>.1` — clobbering any previous archive — and starts a fresh file with that row. Readers tolerate a torn final line, so no fsync is needed 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L110-L110〕.
- `getLedgerHealth()` returns `{ droppedRows }`, an in-process counter of rows lost to failed appends. Write failures are never surfaced as notices and never propagate to a caller's waterfall 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L109-L109〕.
- Appends to the same file are serialized per target path, so the rotation count cannot race.

## Reading

`readAssembleRows` / `readRequestRows` / `readGovernorRows` / `readDedupeRows` / `readCapRows` each take a file path and return an `AsyncIterable` of their own row type. They skip rows of the other types (all producers share one file), rows that are not schema `v: 1`, and unparseable lines — including a torn final write. A missing file yields nothing. The sink and readers require no cordis context at all, so offline tooling (docs 5/8) uses the same writer and readers 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L113-L123〕.

## Settings — `cc-input-ledger`

Kebab-key, user-layer settings, re-read per observed event, so a toggle applies on the next event without a restart 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L135-L144〕.

| key | type | default | bounds |
|---|---|---|---|
| `enabled` | bool | `true` | — (disabling stops future rows; files are never deleted) |
| `include-subagents` | bool | `true` | — |
| `max-sections-per-row` | int | `64` | 8..256 |
| `max-rows-per-file` | int | `2000` | 100..100000 |

Defaults are carried on four surfaces that must agree: the schema `.default()`s, the `DEFAULT_INPUT_LEDGER_SETTINGS` constants, the fail-soft raw reader (absent or malformed file, out-of-bounds integers → defaults or bounds) and the wiring fallback. No settings file means the defaults, and the observers fire.

## Privacy boundary

Recorded: section names and source-kind strings (compile-time identifiers, each hard-capped at 64 characters via `clampLabel`), provider/model route strings, numeric stats, and eight-hex truncated sha256 fingerprints of local prompt text 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L148-L148〕. The hashes never leave the machine; they are a local-only prefix-stability fingerprint, not an export format.

Never recorded: block texts, tool arguments, file paths inside content, environment data 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L149-L149〕. Enforcement is structural — the row types contain no text field at all — and pinned by a fixture: synthetic messages carrying `sk-…` and `Bearer …` credential-shaped strings must produce serialized rows in which those strings provably do not appear (`tests/privacy.spec.ts`) 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L150-L150〕.

## Measurement caveats

- An `assemble` row is an **assembly observation**, not the authoritative final prompt: outer listeners and complete-section restoration can still rewrite the text afterwards. The `request` row is the measurement of record for prompt bytes 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L90-L90〕.
- `request` rows read the `llm/stream` options as handed to the middleware chain — a pre-middleware view, not a wire-faithful byte rendering (the inherited `cache-health` seam limitation) 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L38-L38〕. `systemBytes`/`systemHash8` are computed from leading system-role and `source.kind === 'system-prompt'` messages, plus a one-shot `options.system` when present, because loop-built requests carry the system prompt inside `messages`.
- Rotation drops history older than `max-rows-per-file` rows per session, matching the cache-health precedent 〔src:ws:docs/plans/2026-11-12-per-step-input-ledger.md#L170-L170〕.
