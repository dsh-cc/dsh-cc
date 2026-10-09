# @dsh-cc/config-snapshot

English | [中文](README.zh.md)

Session config snapshot sidecar ledger — per-Session-construction attribution substrate. Every Session construction appends one JSONL row to `<dshHome>/config-snapshot/<encodedId>.jsonl` recording the configuration that produced it: the dsh-cc version, the harness version (when the host surfaces one, else `null`), the process default preset id, and the visible marketplace/user plugin install inventory (flagged with the loader's per-id selection). Consumers join by raw `session.id` directly — filenames carry the harness `encodeSegment` form of the id, so hostile ids (`../`, `/`, `..`) stay single safe path components.

## Row shape

One row per construction: `{schemaVersion, sessionId, seq, bootId, appendedAt, dshCc, harness, preset: {id}, plugins, note?, delegationDepth, parentSession, origin}`. `seq` is a per-file monotonic counter assigned by the write queue; `bootId` is per plugin activation. Plugin rows are sorted by id then scope; exactly one row per enabled id carries `loaderSelected: true` (greatest `lastUpdated`, tie → later entry order), matching the runtime loader's discovery rule. A consumer attributes a transcript event at time `t` to the row with the greatest `appendedAt` ≤ `t` (ties broken by `seq`); no qualifying row means UNKNOWN — there is deliberately no fallback to the earliest row.

## Failure discipline

Observability, never on a behavior path: the sync `session/created` listener only stamps header fields and kicks the async writer, so it can never veto session creation; the async writer catches every failure (unreadable/corrupt plugin state, blocked sidecar dir, serialization) and logs at debug level. Corrupt plugin state ⇒ `plugins: []` plus the fixed reason code `plugins-state-corrupt` (never raw error text — no absolute user paths in rows). A crashed mid-append torn tail is repaired on append (newline prepended), so a crash fragment can never swallow the next row.

## Configuration

```yaml
- id: config-snapshot
  name: '@dsh-cc/config-snapshot'
  config:
    config-snapshot.enabled: true   # default; kill switch for minimal-footprint consumers
```

Reads are fail-open `true` and happen inside the async writer only — a broken settings layer never disables capture and never blocks session creation.

## Composition

Passive sidecar; no Service, no event emission, no transcript writes. Residual design notes, the `session.append` non-viability evidence chain, and the consumer contract live in [docs/plans/2026-10-09-session-config-snapshot-event.md](../../../docs/plans/2026-10-09-session-config-snapshot-event.md).
