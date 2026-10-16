# @dsh-cc/progress-rebuild

English | [中文](README.zh.md)

Structured progress state + post-compact context rebuild. A registered **session projection** derives a typed per-session progress state from already-committed session events — goal state via the upstream canonical `applyGoalProjection` fold (fed EVERY event, `clear` tombstones and goal-round counting included), the latest `todo/write` snapshot, verified bash execution receipts, and the last genuine user message. On a **successful** `compaction/end`, the derived brief is delivered into the **first model request built after the compaction boundary**: in-turn compaction via an `agent/pre-step` decision splice (the same step's request), idle compaction via a deferred durable `agent.inject` (survives persist+resume, claimed by the user's next turn). **Default ON** since 2026-10-16 (`progress-rebuild.enabled: true`; promoted from ship-dark after the production dogfood). 〔src:ws:packages/context/progress-rebuild/src/settings.ts#L28-L48〕

## How it works

Plain plugin (no Service) with `inject: ['sessionProjections']`, registering:

- **The `progress-rebuild` session projection** (host-only key, no client view): a pure, never-throwing fold over every committed session event, driven and resume-restored by the projections framework — no `snapshotEvents()`/`eventAt()`/`ownEvents()` call anywhere (new production uses are deprecated upstream). State is plain JSON (arrays only).
- **Listener B** (`session/event`, `compaction/end`): skips error-carrying ends (a failed compaction amputated nothing), gates on `enabled`, resolves the agent through the sessionId-keyed agents registry, then branches on `turn` — `null` (idle) defers a durable `agent.inject` to a microtask (the session append reentry guard forbids inlining it); non-null sets an in-memory `pendingBrief` flag. 〔src:ws:packages/context/progress-rebuild/src/delivery.ts#L1-L40〕
- **Listener C** (`agent/pre-step` waterfall): after `next()`, splices the brief message into the enter decision's messages — the loop commits it as a durable `user/message`, so the brief rides the first post-compaction request. A `reject` decision leaves the flag for the next step. 〔src:ws:packages/context/progress-rebuild/src/delivery.ts#L40-L90〕
- **The ACK observer** (`session/event`, `progress-rebuild`-sourced `user/message`): delivery acknowledgment is the COMMITTED brief, not the splice call — a cancelled step before the durable append yields no row. Emits the `progress-rebuild/injected` dogfood event (`{bytes, sections, path}`) through a deferred, KNOWN_SESSION_EVENT_TYPES-registered widened append. 〔src:ws:packages/context/progress-rebuild/src/events.ts#L14-L20〕

Verified receipts are conservative by construction: bash tool only, `isError` false, a rendered tail carrying NO terminal marker line (`[exit code: N]` / signal / timed-out / stopped / still-running / sandbox markers — a clean exit-0 renders no marker at all), non-compound commands only (`;`, `&&`, `||`, `|`, newline, `&`, `$(…)`, backticks all rejected), and no `run_in_background`. Receipts render execution evidence (command head + exit 0), never inferred completion claims; dedup is keyed by `callId` (first occurrence kept — microcompact replacement re-appends do not double-count). The goal arm latches `failure` explicitly and renders "goal state unavailable" instead of stale state. 〔src:ws:packages/context/progress-rebuild/src/state.ts#L56-L160〕

Cross-package obligation: the injected kind `progress-rebuild` is added to the denylists in `@dsh-cc/turn-rules` (matcher), `@dsh-cc/memory` (recall), and `@dsh-cc/advisor-watchdog` (delta) — the brief can never feed on injected text, and the projection's own brief is excluded from `lastUser` by the genuine-user rule (`source` undefined or `kind === 'user'` with non-empty text). 〔src:ws:packages/context/progress-rebuild/tests/denylists.spec.ts#L1-L30〕

## Settings

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master flag (default ON since the 2026-10-16 flip). Gates Listener B, Listener C, and the measurement append (the projection registration stays mounted so resume restore is unaffected). 〔src:ws:packages/context/progress-rebuild/src/settings.ts#L28-L48〕 |
| `max-lines` | `120` | Brief line budget (a 6 KiB byte cap and 240-char line truncation apply independently). 〔src:ws:packages/context/progress-rebuild/src/settings.ts#L29-L33〕 〔src:ws:packages/context/progress-rebuild/src/brief.ts#L14-L20〕 |
| `include-verified` | `true` | Governs the whole verified section (bash fallback now, D1 receipts once the sibling design ships). 〔src:ws:packages/context/progress-rebuild/src/settings.ts#L32〕 |

## Shape

Plain cordis plugin mounted by `packages/preset/cc` in the cc-services group, after advisor-watchdog. All failure modes fail soft; no path wakes a settled session. Known trade-off (session-cwd class): once a session records `progress-rebuild/injected`, resuming it requires a composition that loads this package.
