# @dsh-cc/progress-rebuild

English | [中文](README.zh.md)

Post-compaction progress rebuild: a plain plugin that rides the `session/event` firehose to keep, per session, a deterministic shadow state — the current goal (goal/change vocabulary: create|edit|pause|resume|complete|block|clear, discriminated on `operation` before touching `.goal`), the latest todo snapshot (verbatim), verified shell receipts (a command counts as verified only when a `[exit code: N]` marker with `N === 0` is parsed from the result text and the command matches a proof class — test/presubmit/build/lint/git commit — by its first 4 whitespace tokens), and the last real user instruction (only `source.kind === 'user'` messages update it; every injected kind, this plugin's own included, is invisible by construction). After each **successful** `compaction/end` (an `error`-carrying one is skipped), the plugin renders a small derived brief and injects it into the live agent via one `agent.inject()` with source kind `progress-rebuild` — so the post-compact turn keeps its bearings without any model call. The injection (and its own inbox-splice side effects) runs inside a `queueMicrotask` to leave the publishing append's reentry window; the plugin NEVER appends its own session-event type (a custom non-ignorable type poisons the JSONL log under 0.2.0-rc.x persistence and would make compacted sessions un-resumable). **Default on** (`progress-rebuild.enabled: true`).

## How it works

Plain plugin (no Service, no isolate key) registering one listener:

- **`session/event`** (the firehose): every event first updates the per-session pure reducer (`applyEvent` — fail-soft, debug-logged and swallowed); on `compaction/end`, the handler — deferred to a microtask — re-checks the error field, resolves the live agent through the agents registry (`ctx.get('agents')?.get(session.id)`; no live agent → silent skip), reads settings, renders the brief, injects it, and measures it.

Brief layout (fixed template): title line → Goal → Verified done (exit-code receipts) → Todo snapshot (verbatim; elided head 2/3 + tail 1/3 with a `… (N elided)` marker when over the line budget) → Last user instruction → Not-verified warning. One fixed microcompact stub-marker sentence is included; the degenerate form (empty shadow) is the stub sentence + last-user line (when known) + the warning. A kill switch is always available: `progress-rebuild.enabled: false` disables injection entirely.

Shadow state is process-lifetime only (Map keyed by session id) — no deprecated session readers (`snapshotEvents`/`eventAt`/`ownEvents`) are ever called; after restart/resume it starts empty and the brief degenerates by design.

Dogfood measurement: one JSON line `{ts, bytes, sections}` appended per injection to `$DSH_HOME/progress-rebuild/<sessionId>.jsonl` (detached write; harness home absent → no-op; all errors swallowed). NO sidecar dogfood doc yet — the sidecar file itself is the measurement surface.

Cross-package obligation: the `progress-rebuild` injected kind is added to the denylists in `@dsh-cc/turn-rules` (matcher), `@dsh-cc/memory` (recall), and `@dsh-cc/advisor-watchdog` (delta) — the rebuild can never feed on its own or other plugins' injected text.

## Settings (user layer only)

Key `progress-rebuild` in the **user-layer** `settings.json` (the harness-home file). Project scope is **never read** — invisible, not refused.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master flag. `false` = kill switch (no injection at all). |
| `max-lines` | `120` | Brief line budget; the todo section elides head 2/3 + tail 1/3 to fit. |
| `include-verified` | `true` | Whether the Verified-done section is rendered. |

## Shape

Plain cordis plugin (no Service, no isolate key). Mounted by `packages/preset/cc` in the cc-services group, after advisor-watchdog. All failure modes fail soft: a listener can never block a step or throw into a waterfall; the publishing append's reentry window is never reentered.
