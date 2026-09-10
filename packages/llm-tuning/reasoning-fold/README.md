# @dsh-cc/reasoning-fold

English | [中文](README.zh.md)

Stage-0 reasoning-fold **probe**: a READ-ONLY `llm/stream` listener that byte-counts `reasoning-delta` vs `text-delta` chunks and captures the terminal usage chunk into a per-session JSONL ledger. Measurement before any behavior change (docs/plans/2026-09-10-reasoning-fold-deepseek.md): the probe is **read-only, ledger-only, no behavior change** — every chunk passes through untouched, probe failures are swallowed inside the listener, and a ledger failure never degrades a model call. The fold itself (dropping reasoning from the re-send) is a gated, separate Stage-1/2 effort.

## How it works

The plugin registers one read-only `llm/stream` waterfall listener (the only legal read-only shape in a cordis waterfall: it observes chunks while forwarding them from `next()`). Per call it keeps a local record `{provider, model, sessionId, purpose, reasoningBytes, textBytes, usage?}` — no shared state across calls — and appends exactly one ledger row in a `finally`, so an aborted or mid-stream-failed call still records its partial counts. The probe decision is read once per call at its start: a settings flip mid-call never discards an in-flight record.

Byte counts are UTF-8 (`Buffer.byteLength`), so multibyte reasoning (CJK, emoji) counts by wire bytes. A call with no usage chunk simply omits `usage` from its row.

## Ledger

`$DSH_HOME/reasoning-fold/<sessionId>.jsonl`, append-only, one JSON line per model call:

```json
{"ts":"2026-09-10T12:00:00.000Z","sessionId":"...","provider":"...","model":"...","purpose":null,"reasoningBytes":1234,"textBytes":567,"usage":{"inputTokens":100,"outputTokens":20,"totalTokens":120,"cacheReadTokens":80,"cacheWriteTokens":0,"reasoningTokens":50}}
```

`purpose` is `null` for ordinary conversation calls and `"compaction"` / `"session-title"` for auxiliary ones. All ledger I/O errors are swallowed. Growth is bounded by session count (one file per session); rotate/cap only when `reasoning-fold/` exceeds ~10MB or Stage 1 ships.

Usage semantics (harness `llm/src/types.ts` TokenUsage): `inputTokens` counts uncached input only; billed input = `inputTokens + cacheReadTokens + cacheWriteTokens`. Any "re-sent reasoning share of metered input" analysis MUST use that summed billed-input denominator. `reasoningTokens` is output-side and cannot measure re-send cost.

## Settings

Namespace `cc-reasoning-fold`:

| Key | Default | Meaning |
|---|---|---|
| `probe` | `true` | Master flag. `false` (read live per call) disables the probe; an in-flight call keeps the decision pinned at its start and still appends its row. |

Stage-1 keys below are documented for the future fold — they are **inert in Stage 0** and deliberately NOT declared in the settings schema (schema keys without a consumption chain fail the capability manifest audit):

- `providers` — restrict the probe/fold to matching provider routes.
- `head-chars` (default 4000), `tail-chars` (default 2000) — Stage-1 fold window sizes; `floor-chars` (default 12000) is the minimum reasoning block length for the fold to apply, with the `floorChars > headChars + tailChars` validation landing at Stage 1.

## Shape

Plain cordis plugin (publishes no Service, handoff-store/memory pattern — avoids leakedServices/isolate-key concerns); it registers nothing when the settings provider is absent, `probe` is false, or `dshHomePath` is missing (ledger skipped, chunks still pass through). Mounted by `packages/preset/cc` in the cc-services group.
