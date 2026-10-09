# @dsh-cc/skill-usage

English | [中文](README.zh.md)

Skill-usage telemetry: an observe-only cordis plugin counting every committed skill load into a per-workspace sidecar ledger, with a derived per-workspace utility report whose demote-candidate list is **report-only** — demotion is manual. **Default on** (`cc-skill-usage.enabled: true`).

## What it observes

- **Tool form** — a read-only `tools/result` listener (`@mode emit`, never `tools/post-execute`): a load counts when the final canonical outcome is success (`exec.name === 'skill'`, `result.isError === false`), i.e. post-waterfall, post-cancellation. The skill name comes from `exec.arguments.name` (narrowed to string); a string `provider` on the result value is copied onto the row for free attribution.
- **Slash form** — a `session/event` listener matching persisted `user/message` events whose `source.kind === 'skill-invocation'`. Gesture semantics live in tool-skill; this listener never re-parses user text. One event per validated skill, several per message when several `/name` tokens appear.
- **Rollup trigger** — a `session/created` listener recomputes the utility report when it is stale (input-watermark based); a `skills/learned-changed` listener deletes every report so churn invalidates all workspaces.

Every load is one append-only JSONL row `{ v:1, ts, sessionId, skill, via: 'tool'|'slash', provider? }` (`ts` in epoch milliseconds). An unresolvable project key skips the row (debug-logged); a providerless host makes telemetry a complete no-op. Nothing is appended to session transcripts — a custom session event would poison reopen at the JSONL persistence layer (design §3.6), so v1 is sidecar-only and the `sessionId` column preserves the later join.

## Sidecar layout (`<dshHome>/skill-usage/`)

- `loads-<projectKey>.jsonl` — the append-only ledger, one row per committed load.
- `observing-since-<projectKey>` — observation-coverage start marker (create-if-absent; deleted while telemetry is disabled, so coverage means wall-clock while enabled).
- `utility-<projectKey>.md` — the derived, regenerable utility report: per-skill loads (30d / all-time), distinct sessions, last-loaded, never-loaded learned skills with SKILL.md-mtime age, demote candidates (learned, 0 loads in 30d, age > 14d, coverage ≥ 30d), and current-shadowing annotations marked attribution-uncertain. Published via unique temp file + rename; stated rule text includes **demotion is manual** (`manage_skill` delete or edit) — v1 takes no action.

## Settings (user layer only)

Namespace `cc-skill-usage` in the user-layer `settings.json`. Project scope is invisible to the per-event raw read (same limitation as the advisor watchdog).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master flag, hot-reloaded via the raw user-layer read per matched event. When false: no ledger appends and no report writes; existing files remain, and the coverage marker is deleted. |
| `rollup-stale-hours` | `24` | Report staleness window (cascade read at rollup time). |
| `never-loaded-days` | `30` | Gates only the "Never loaded" report section. |

## Limitations

- **Main-realm only**: the observation seams are scope-filtered, so subagent skill loads are invisible (a stated boundary, not a gap in the numbers).
- **User-layer-only raw read** of `enabled` — project/repo-layer settings are invisible to the per-event gate.
- **Per-name attribution**: loads key on the skill name; a currently-shadowed learned skill's loads may belong to the shadowing skill (marked attribution-uncertain in the report).
- **Unbounded ledger in v1**: append-only, full scan per rollup; rotation is a follow-up.
