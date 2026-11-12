# Per-step Input Ledger

- Date: 2026-11-12
- Status: Design — accepted (four three-seat blind-review rounds converged; final: all seats CONFIRMED, one prescribed clause folded verbatim)
- Program: context-engineering input governance (doc 3 of 8)
- Depends on: nothing (substrate). Docs 1 and 7 define *their* row payload shapes here by reference (single schema source, per review finding).
- Literature basis: Four-condition evidence-utilization protocol; interaction-budget auditing of context compression (arxiv 2608.16370); "Context Is a Pipeline" (2610.36114).

## Formal design

- mode: auto (session-adopted; no formal-design screening clause in the project rules at this revision; adoption snippet at `<skill>/references/agents-snippet.md`).
- decision: not-needed
- triggerIds: none — no protocol or state-machine behavior: pure observers over final snapshots, fail-soft per event, no cross-step state beyond per-session counters and a rotation rule.
- backends: `none`
- rationale (selected scope): row emission, byte accounting, attribution, rotation, and the reference-counted mount are covered by unit and integration tests in the doc's Verification section; nothing here is an ordering property that property tests cannot decide. Re-screen if the ledger ever gains admission or arbitration behavior.

## Problem

Nothing records what actually entered the model on a given step. The existing records are fragmented (`cache-health` = prefix/cache shape only; `context-crusher` = savings only; `decision-usage` = SystemOne decisions only; full trajectories only offline in the eval harness). The budget governor (doc 1), CCR graduation evidence (doc 5), injection dedupe (doc 7) and pollution detection (doc 8) all need a shared, content-free composition record per request.

## Goals / Non-goals

Goals:

1. Record, per assembly and per outgoing LLM request, a compact metrics row: section-level composition and message-source-level composition — never content.
2. Do it for every agent in the process (root and subagents), exactly once per scope even when multiple presets mount the observer.
3. Provide the **single schema source** for all program row types (ledger, governor, dedupe, cap) plus typed readers and an append API used by docs 1/7.

Non-goals:

- No prompt text, message text, tool arguments, or conversation capture. Names, counts, byte sizes, 8-char hashes only (privacy boundary §Privacy).
- No transport off the machine.
- No runtime behavior change (pure observer).
- Not a cache-prefix-stability tracker (that stays `cache-health`; deliberately a different question — cache-health itself documents its rows as a pre-middleware view, not wire fidelity, `observability/cache-health/src/tracker.ts:65-69`).

## Current behavior (anchors)

- `llm/stream`: observe-only seam `(options: GenerateOptions, next) => AsyncIterable<StreamChunk>`, registered `{global:true, prepend:true}` (`cache-health/src/index.ts:152-158`). It fires **after** `agent/request` has resolved the call config; options are deep-frozen by the llm layer (`llm/src/index.ts:67-70` in the pinned harness copy). What the listener sees is the options object as handed to the middleware chain — a pre-middleware view, not a wire-faithful byte rendering (inherited limitation, documented).
- Main-loop system prompt travels **inside** `options.messages` as leading system-role message(s) with `source.kind === 'system-prompt'`; `options.system` is a one-shot field and is `undefined` for loop-built requests (`llm/src/types.ts:572-580`, `agent-loop/src/agent.ts:735-742` in the pinned harness copy). All system metrics must therefore be computed from messages, not from `options.system`.
- `GenerateOptions.purpose` is an **open** augmentation map (`LlmRequestPurposeMap`, `llm/src/types.ts:554-558`) currently populated by `'compaction' | 'session-title'` producers; unknown members are data, not type errors.
- Main-loop discriminator (three existing consumers): `purpose === undefined && sessionId !== undefined` (`compaction-cost-gate/src/index.ts:182`, `advisor-watchdog/src/wiring.ts:90`, `context-crusher/src/defer/counter.ts:61-63`).
- `system-prompt/assemble` waterfall returns `{ sections: AssembledSection[] }`; sections carry `name`, `text` (no `order` field at this surface; `core/system-prompt/src/index.ts:93-129` in the pinned harness copy). Interpolation and complete-section restoration happen around/after the waterfall (`:298`, `:685-695`), and listeners outer than the observer may still rewrite → **an assemble observation is not the authoritative final prompt text** (see caveat in Observer A).
- `agent/pre-step` payload carries `{ agent, messages, turn, step, signal }` (`core/agent/src/runtime-types.ts:350` in the pinned harness copy): both `turn` and the per-request `step` are available for attribution without inventing a parallel counter.
- `sidecar-io` provides `appendJsonl` (tail-repair, best-effort, currently swallows write errors — `observability/sidecar-io/src/index.ts:71-97`) and `encodeSegment` (`:136`, handles `.`/`..`/surrogates). The earlier draft cited a harness-only path for encodeSegment; corrected.
- `cwdProjectKey(agent)` in `@dsh-cc/handoff-store` is the projectKey convention; absent → row skipped.
- Both `agent.cordis.yml:12` and `agent.vwa.cordis.yml:12` include `agent.shared.cordis.yml` (verified), so a preset-mounted `{global:true}` listener would double-register in a process running both presets → the reference-counted mount guard below.
- `cache-health` already operates a 2000-row trim precedent for sidecar ledgers (`cache-health/src/ledger.ts:14`).

## Design

### Package

New package `packages/observability/input-ledger` (`@dsh-cc/input-ledger`). Non-isolate plugin row in `agent.shared.cordis.yml` in the observability neighbourhood, enabled by default.

### One schema source: `LedgerRow` union (v1)

All program row types are defined **here** and only here. Docs 1 and 7 reference this section; their own docs do not redefine shapes.

```ts
type BaseRow = {
  v: 1; ts: number; sessionId: string; gen: string;   // gen = process boot id (random at apply)
  turn?: number; step?: number                        // from Observer C; undefined for auxiliary calls
}
type AssembleRow  = BaseRow & { type: 'assemble'; isSubagent: boolean;
  sections: Array<{ name: string; bytes: number; hash8: string }>;
  totalBytes: number; renderedFromCache: boolean }
type RequestRow   = BaseRow & { type: 'request'; seqPerGen: number;
  provider: string; model: string; purpose?: string; mainLoop: boolean;
  systemBytes: number; systemHash8: string;
  toolsCount: number; toolsBytes: number;
  messages: { count: number; bytesTotal: number; nonTextBlocks: number;
    bySourceKind: Record<string, { count: number; bytes: number }>;
    toolResults: { count: number; bytes: number }; assistantBytes: number } }
type GovernorRow  = BaseRow & { type: 'governor'; mode: 'observe' | 'enforce';
  bytesByClass: Record<string, number>;
  trimmed: Array<{ kind: string; bytes: number; action: 'defer' | 'drop-expired' | 'drop-oversize' }>;
  offeredBacklog: number; hardOver: boolean; error?: true }
type DedupeRow    = BaseRow & { type: 'dedupe'; applied: boolean; kind: string; hash12: string; suppressedWithin: number }
type CapRow       = BaseRow & { type: 'cap'; applied: boolean; kind: string; runningCount: number; suppressedTotal: number }
```

Units are **UTF-8 bytes everywhere** (r1 fold: no chars/bytes mix). `bySourceKind` key = `message.source?.kind` with `'user'` fallback. `runningCount` in `CapRow` exists so observe mode can answer distributional flip questions. Governor trim actions are exactly the three the governor's algorithm can take in doc 1: `defer` (moved to backlog), `drop-expired` (TTL), `drop-oversize` (alone exceeds its own class budget — evaluated at trim time, never enqueued). Observe mode represents its decisions with the same `trimmed` array under `mode: 'observe'` (`wouldTrim` is not a separate field — grok/codex delta fold). All row types have `applied`/`mode` semantics defined by their producer docs (1, 7), counting on readers filtering unknown types.

### Observer A — assembly observations (`system-prompt/assemble`)

Registered **without prepend** (runs inside all prepended rewriters → sees the innermost-final view at its position). Emits `AssembleRow`:

- `sections`, `totalBytes` from the returned `{ sections }`.
- `renderedFromCache`: computed against a per-`(sessionId, scopeKey)` cache of the previous row's `totalBytes` + per-section hashes (scope key = scope identity string; scope-less assemblies are skipped by convention).
- Caveat recorded in README and in the row itself (implicit): this is an **assembly observation**, not the authoritative final prompt — outer listeners or complete-section restoration may alter text later; the request row (Observer B) is the measurement of record for prompt bytes.

### Observer B — request rows (`llm/stream`, `{global:true, prepend:true}`)

Synchronous computation before `next()`; never touches options:

- `systemBytes`/`systemHash8`: sum/hash over **leading system-role message(s) and any message with `source.kind === 'system-prompt'`** inside `options.messages`; `options.system` (one-shot calls) is measured separately and added when present.
- Per-message stats: `bytesTotal` (text blocks), `nonTextBlocks` (count only), `bySourceKind` (count+bytes), `toolResults`, `assistantBytes`.
- `seqPerGen`: per-`(sessionId, gen)` monotonically increasing.
- `turn`/`step`: looked up from Observer C's per-session map; auxiliary calls (`purpose` set or `sessionId` absent) leave both `undefined` explicitly (r1 fold: no inherited attribution).
- `purpose`: recorded verbatim as `string | undefined` (open map; do not narrow).

### Observer C — attribution (`agent/pre-step`, `{prepend:true}`, delegate-first)

Records `(turn, step)` per session from the payload; returns `next()` unchanged. Uses the payload's `step` (r1 fold: no parallel counter).

### Sink, errors, rotation

- Path: `<dshHome>/input-ledger/<projectKey>/<encodeSegment(sessionId)>.jsonl`.
- Write via `appendJsonl`, which gains an additive optional `onError?: (err: unknown) => void` parameter in sidecar-io (r1 fold: today's sink swallows errors invisibly). The ledger passes a callback incrementing an in-process `droppedRows` counter, exposed by `getLedgerHealth()`.
- Rotation: when a session file exceeds `maxRowsPerFile` (default 2000, cache-health precedent), it is renamed to `<file>.1` (previous `.1` clobbered) and a fresh file starts. Readers tolerate a torn final line (sidecar-io contract).
- No fsync; dshHome absent → no-op.

### Exported API

```ts
appendLedgerRow(filePath: string, row: LedgerRow, onError?): Promise<void>   // shared writer for docs 1/7
readAssembleRows / readRequestRows / readGovernorRows / readDedupeRows / readCapRows
  (file: string): AsyncIterable<...>      // each skips rows of other types and unparseable lines
sessionLedgerPath(dshHome, projectKey, sessionId): string
getLedgerHealth(): { droppedRows: number }
```

Pure functions; no cordis context required (docs 5/8 use these offline).

### Mounting singleton (reference-counted, root-owned)

Cordis automatically unregisters a preset's listeners when that preset unloads (`vendor/cordis/src/events.ts:264-269` in the pinned harness copy) — so a naive `WeakSet<rootCtx>` guard would permanently suppress observation after the *owning* preset unloads while another preset remains mounted (codex delta MAJOR). The contract is therefore:

- Listeners are registered **on the root context** (not the preset scope), at first mount, with a module-level `Map<rootCtx, { listenerCount: number; refs: number }>`.
- Each preset mount increments `refs`; each unmount decrements. Listener disposal happens only when `refs → 0` (never tied to any single preset's unload). Idempotence: a second mount of the same preset body on the same root is a refs-only no-op (cc+vwa double-include covered).
- Test: mount cc, mount vwa, unmount cc → listeners still fire; unmount vwa → listeners disposed.
- The waterfall return type of the assemble path is `PromptPresentation` (`{ sections, contexts, variables }` — `core/system-prompt/src/index.ts:677-687` in the pinned harness copy): Observer A intentionally records `sections` only; `contexts`/`variables` are out of v1 scope (grok delta note, stated here so an implementer doesn't "fix" it).
- The pre-step payload line is `{ agent, messages, turn, step, signal, modelSelection }` (`runtime-types.ts:350`); `modelSelection` is unused by the ledger (shape is not exhaustive — stale four-field subset quotations describe consumers, not the type).

### Settings — `cc-input-ledger` (kebab, user-layer, hot-read per event)

| key | type | default | bounds |
|---|---|---|---|
| `enabled` | bool | true | — (disabling stops future rows; files are never deleted) |
| `include-subagents` | bool | true | — |
| `max-sections-per-row` | int | 64 | 8..256 |
| `max-rows-per-file` | int | 2000 | 100..100000 |

Four-surface default discipline (schema / `DEFAULT_` constants / raw reader fail-soft / wiring fallback) + "no settings file → observers fire" wiring test.

### Privacy boundary (r1 MAJOR fold)

- Recorded verbatim: section names and source-kind strings (compile-time identifiers), each hard-capped at 64 chars; provider/model route strings; numeric stats; eight-hex truncated sha256 fingerprints (local-only; policy stated in README: a hash of local prompt text that never leaves the machine).
- Never recorded: block texts, tool arguments, file paths inside content, environment data.
- Enforcement is structural (row types contain no text fields) plus a test fixture: synthetic messages containing credential-shaped strings (`sk-…`, `Bearer …`) produce serialized rows in which the strings provably never appear (grep assertion on the emitted JSONL).

### Failure semantics

Any exception inside an observer → zero rows for that call + debug log; observers never throw into a waterfall. Write failure → `droppedRows` via `onError`, no notices.

## Registration / repo checklist additions

Package skeleton + README pair; preset row; composition.spec snapshot; capability manifest row + `pnpm docs:parity`; `tsconfig.packages.json`; sidecar-io additive `onError` (its own test); check:size (<500 lines/file).

## Verification

- Unit: row shapes; role/kind-aware system accounting (fixture with leading system-role message + with `options.system` one-shot); aux-call attribution (`purpose` set → turn/step undefined); scope-key caching; rotation at cap; singleton guard (double apply → single listener set); privacy fixture (credential-shaped text absent from output); unknown-purpose passthrough.
- Integration (real boot, `JsonlSessionPersistence` + MockAdapter, 3 requests): 3 request rows + ≥1 assemble rows in temp DSH_HOME; `seqPerGen` monotonic; `systemHash8` non-empty on main-loop requests (the r1 acceptance check that previously could not pass); cache-health output unchanged with ledger present.
- Interplay: simultaneous cc+vwa session test → exactly one row per emission point (singleton).
- Acceptance: one-week dogfood; report row volume, bytes/session, p95 observer cost (< 0.5 ms/request measured by counter-wrap timestamps), `droppedRows === 0`.

## Risks

- Pre-middleware (not wire-faithful) measurement: inherited and documented; byte drift vs wire is constant overhead per render path.
- Rotation loses history older than 2000 rows/session: accepted (matches cache-health; dogfood sizes will tune `max-rows-per-file`).
- An outer listener rewriting options post-observer would be invisible: documented seam limitation, same as cache-health's.

## R1 fold ledger (three seats: internal critic, grok, codex)

Folded: system-from-messages (BLOCKER-equivalent); assemble-observation caveat + scope key; encodeSegment anchor; `onError` sink outcome; single-schema union incl. governor/dedupe/cap rows; turn/step from payload + gen; open purpose map; row rotation; byte units + `nonTextBlocks`; cc+vwa singleton; privacy boundary section; settings authority/bounds/hot semantics; stale `llm/stream` contract lines corrected.

## R2 → R3 delta fold ledger (three seats)

Folded: GovernorRow trim-action union reconciled with doc 1's actual algorithm (`defer`/`drop-expired`/`drop-oversize`; unreachable `drop-hard`/`drop-cap-memory` removed); observe mode maps its decisions onto the same `trimmed` field under `mode: 'observe'`; singleton replaced by a **reference-counted, root-owned** mount with load/unload lifetime tests (cordis unloads listeners with the owning preset — a plain WeakSet would orphan the observation); `agent.cordis.yml:12` include anchor corrected; `PromptPresentation` contexts/variables excluded-by-decision stated; pre-step payload shape corrected to include `modelSelection`.
