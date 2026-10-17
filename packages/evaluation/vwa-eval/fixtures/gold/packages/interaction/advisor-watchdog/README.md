# @dsh-cc/advisor-watchdog

English | [中文](README.zh.md)

Advisor watchdog: an opt-in **second model** that reviews every completed turn. A passive read-only `llm/stream` listener keeps, per session, the newest qualifying conversation request's message array; at each `agent/turn-stopping`, the plugin extracts the window since its per-session cursor (≈ the last completed turn), renders it as `[role] content` lines (tool-call blocks as `[assistant tool_use <name>] <args>`), and fire-and-forget asks a cheap lane (default alias `haiku`) via `@dsh-cc/side-query`'s one-shot `runSideQuery` — with `onUnrouted: 'skip'` (a hard no-inherit rule: an unconfigured alias can never silently run on the main route) and `rejectToolCalls: true` (no tool loop can exist). The reply is parsed against a strict JSON contract (`nit | concern | blocker`, ≤ 16 notes, ≤ 500 chars, empty allowed) and surviving notes are delivered by one resolve-time `agent.inject()` with source kind `advisor` — never mid-tool-batch, never waking an idle session. **Default off** (`cc-advisor.enabled: false`).

## How it works

Plain plugin (no Service, no isolate key) registering two listeners:

- **`llm/stream`** (read-only, observe-and-passthrough, `{ global: true, prepend: true }` — the cache-health seam): keeps the newest qualifying request's message array per session. A request qualifies iff the loop stamped `sessionId` and no `purpose` is set — so the advisor's own hand-built one-shot calls never enter the snapshots (self-observation excluded by construction), and compaction/session-title auxiliary lanes are skipped. Zero settings/IO work: one array reference, `next()` immediately.
- **`agent/turn-stopping`** (the trigger; synchronous up to capture, never throwing): gates — settings `enabled` (raw dual-half read), the `subagents` gate unless top-level, session-disabled, inFlight (a stop during flight captures nothing and leaves the cursor alone, so the window accumulates into the next stop) — then the cursor protocol over the snapshot: first observation (init) and rewritten history (compaction/rewind reset) are skipped without a run; the candidate window drops every injected source kind (the advisor's own output is invisible to itself, so a re-opened advisory tail turn never spawns anything); an empty-after-filter window or a window without a genuine user message advances the cursor and skips. On review, the cursor advances immediately (eligibility, not completion), the run is spawned detached, and the turn counter increments after capture; at resolve time notes are dropped as stale unless `turnCounter - capturedTurn <= 1`.

Emission guard (ported from oh-my-pi, plan Appendix A), in fixed order: severity filter → normalized exact-set denylist (37 verbatim omp phrases; "Stop." matches, a genuine blocker mentioning "Stop:" does not) → quarantine scan against `@dsh-cc/permission-rules`' `DEFAULT_DANGEROUS_PATTERNS` → flat dedupe LRU (4096 fingerprints) → immune window (fresh `concern` notes suppressed for `immune-turns` after a delivered concern/blocker) → per-run budget (2 non-blockers, blockers exempt). A session cap (24 delivered notes) silences the advisor for the session.

Journals one JSON line per attempted run to `$DSH_HOME/advisor/<sessionId>.jsonl` (fields: ts, turn, alias, model, inheritedRoute, ok, reason, durationMs, deltaMessages, deltaBytes, notesIn, notesOut, drops, `usage: null` — token metering is N/A until `SideQueryResult` surfaces usage, plan §7). Dogfood plan + jq scoreboard: [`docs/dogfood/advisor-watchdog.md`](../../../docs/dogfood/advisor-watchdog.md).

Cross-package obligation: the `advisor` injected kind is added to the denylists in `@dsh-cc/turn-rules` (matcher) and `@dsh-cc/memory` (recall) — the advisor can never feed on its own or other plugins' injected text, and nothing downstream feeds on advisories.

## Settings (user layer only)

Key `cc-advisor` in the **user-layer** `settings.json` (the harness-home file). Project scope is **never read** — invisible, not refused.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master flag. Ship-dark. |
| `alias` | `"haiku"` | Cheap-lane alias resolved through `ccModelRoutes`. |
| `budget` | `2` | Max non-blocker notes per run (1–8); blockers exempt. |
| `immune-turns` | `3` | Turns after a delivered concern/blocker during which fresh concerns are suppressed. |
| `session-cap` | `24` | Delivered notes per session; reaching it disables the advisor for the session. |
| `severities` | all three | Which severities survive the first filter. |
| `subagents` | `"off"` | Global subagent gate (settings-level only, §4.7): `off` reviews top-level sessions only; `on` reviews subagent sessions with the session alias; an alias string reviews them with that alias. |

## Shape

Plain cordis plugin (no Service, no isolate key). Mounted by `packages/preset/cc` in the cc-services group at the group tail, after turn-rules — turn-rules' prompt matcher must see the un-advised prompt (advisor text is denylisted from the matcher's candidate either way). All failure modes fail soft: a listener can never block a step, throw into a waterfall, or wake an idle driver.
