# @dsh-cc/compaction-pinning

English | [中文](README.zh.md)

Governed-message pinning across compaction. Behavioral-governance messages — turn-rule reminders, post-edit-verify recovery hints — travel as ordinary `user/message` events, so summarization compaction can replace the whole region holding them with one checkpoint message and leave the instructions to survive only as whatever the summary kept. This plugin captures those messages verbatim in a bounded per-session ring and restores them verbatim once the checkpoint commits, so a governance instruction keeps its durable effect for the whole session instead of only until the next compaction.

## How it works

- **Capture:** one observation-only `session/event` listener. For every `user/message` whose `source.kind` is one of the configured kinds, the WHOLE message object (content blocks plus source metadata, by reference, never cloned or destructured) is stored in that session's ring together with its seq and timestamp. The ring is FIFO-bounded by entry count and by estimated message bytes; the oldest entries are evicted first.
- **Restore:** the compaction's summary names the shadowed seqs, and that summary is provisional evidence only, because the engine appends `compaction/summary` before the checkpoint commit. A per-`compactionId` restore schedule therefore has to settle before it drains, and only settled pins are re-appended verbatim, oldest first, each as its own append so source boundaries survive. Rule (a): a successful `compaction/end` for that id proves the checkpoint committed, so the pins drain in the same pass. Rule (b): with no `compaction/end` of any kind, a schedule becomes eligible once it has aged at least one turn and the checkpoint commit was actually witnessed by the replacement `user/message` citing the summary's seq; that witness gate keeps a summary-only phantom from being restored over a live original. An `end` carrying `error` cancels the schedule outright, and a schedule that never becomes eligible is garbage-collected after two turns. Restored messages re-enter the ring naturally under a new seq, which makes re-shadowing self-healing rather than a loop.
- **Bounded:** two caps (entries and bytes) and a fixed kind list keep capture cheap and the restoration batch small. Nothing is appended from inside the event observer — restores drain from the agent's pre-step seam.
- **Defaults:** on, with the two durable behavioral-constraint kinds. Turning the feature off stops capture and restore; a ring is never retroactively rebuilt.

## Settings (namespace `cc-compaction-pinning`)

Hot-read: the value is re-read on every message, so a settings edit applies immediately.

| Key | Type | Default | Bounds / meaning |
|---|---|---|---|
| `enabled` | bool | `true` | — Disabling stops capture and restore. |
| `pinned-source-kinds` | string[] | `['turn-rules','edit-recovery-hint']` | Each entry ≤ 64 chars; an empty or fully invalid list falls back to the default pair. |
| `max-pinned` | int | `16` | `1..64` — ring entry cap. |
| `max-pinned-bytes` | int | `16384` | `1024..262144` — ring byte cap. |

```json
{
  "cc-compaction-pinning": {
    "max-pinned": 24,
    "pinned-source-kinds": ["turn-rules", "edit-recovery-hint"]
  }
}
```

## API

- `createScheduleStore()` returns the per-session restore-schedule store (`arm`, `get`, `succeed`, `cancel`, `commit`, `isEligible`, `eligible`, `pending`, `drop`, `gcDead`, `clear`). `raiseTurn(state, turn)` raises the monotonic rule-(b) turn clock, and `RULE_B_TURNS` / `SCHEDULE_GC_TURNS` export the two windows.
- `getPinningHealth()` / `bumpPinningHealth(key, by?)` / `resetPinningHealth()` expose process-wide counters `captured`, `restored`, `evicted`, `dropped`. They exist for tests: no user-facing notice, no ledger, no durable record.

## Known gaps

- **Resume-generation gap.** The ring is process memory. A compaction in a session that was resumed by this process can shadow pins this process never captured; the producer re-fires over time (turn-rule reminders especially), but the interim is unprotected. Reconstructing immediately-present pins from the session's own projection at mount is a possible later version, deliberately out of scope here.
- **In-request one-request gap.** Compaction triggered inside a request retry (context overflow, model switch) commits after the retried request's messages were already derived, and a session event observer cannot append (re-entering publication throws). Pins return on the next step, so exactly one request can run without them. Closing it needs an engine-side seam that exempts pinned messages from span selection.
- **No summary input linkage.** The summarizer never sees the restored content; restoration mirrors the post-commit remedy rather than repairing the summary.

## Usage

```ts
import type { Context } from '@deepseek-ai/cordis'
import * as CompactionPinning from '@dsh-cc/compaction-pinning'

export function apply(ctx: Context): void {
  ctx.plugin(CompactionPinning)
}
```

Plain plugin, non-isolate. Settings live in `<dshHome>/settings.json`; the package registers its namespace for `/config` UX and validation and re-reads it per message, and it also exports a raw user-layer reader for callers that must exclude project scope entirely.
