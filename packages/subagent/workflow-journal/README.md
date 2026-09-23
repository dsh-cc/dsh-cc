# @dsh-cc/workflow-journal

English | [中文](README.zh.md)

CC-parity workflow resume journal. It registers the `cc-workflow-journal`
subagent provider, which wraps the preset's `spawn` provider and journals
every settled workflow child so a later run started with `resumeFromRunId`
in the same session replays the unchanged prefix instead of re-spawning it
(frozen-until-first-miss).

## Behavior

- **Journaling.** Every live child is journaled at its provider arrival
  index once it settles (prompt, status, result). The journal file for a run
  lives at `$DSH_HOME/workflows/runs/<sessionId>/<runId>.jsonl` and is
  rewritten whole on each flush (tmp+rename) through the
  `ccWorkflowRunRegistry` service's drain ordering.
- **Replay.** On a resume claim, incoming children are resolved in arrival
  order against the old journal: a hash match (prompt + outputSchema +
  agentOptions) on a completed line returns a fabricated `SubagentRun` —
  fresh session id, result resolved from the journal, immediate `dispose()` —
  and the durable `tool-workflow/agent-start`/`agent-end` records gain
  `cached: true` via `registry.markCached(runId, arrivalIndex)`. The first
  mismatch (hash, non-completed status, missing line, corruption, size-cap
  truncation) flips the run frozen permanently: the miss and every later
  child spawn live (fail-open).
- **Retention.** Journals are same-session only: a runId is resumable while
  its settled-map entry survives in the registry. A boot sweep removes
  session directories under `runs/` whose mtime is older than the TTL
  (default 24h); the sweep is disk hygiene, not crash recovery.
- **Copy-forward.** A resume of a resumed run copies the replayed prefix
  into its own journal first, so a second resume keeps the original prefix.

## Deviations from CC (recorded)

Same-session replay only — cross-session and `claude --resume`-class replay
are not implemented; the cache key is the request triple (stricter than CC's
prompt-only keying); the durable agent records gain an additive `cached`
field the harness does not have.
