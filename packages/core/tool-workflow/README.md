# @dsh-cc/tool-workflow

English | [中文](README.zh.md)

CC-parity dynamic `workflow` tool. It replaces the harness thin adapter
(`@deepseek-ai/dsh-tool-workflow`) in the cc preset: a workflow script written
per the Claude Code documentation — inline `export const meta = {...}` block,
a saved file addressed by `name`, or any `scriptPath` — launches on the first
try, and the consolidated result arrives as exactly one completion delivery.

## Behavior

- **Inline meta extraction.** The script's leading
  `export const meta = { name, description }` block is located and lifted by a
  dependency-free strict-literal parser (no eval/`new Function` — the wrapper
  runs in the harness host process). Trailing commas and comments are
  accepted; template literals, identifiers, spreads, computed keys, and
  function values are rejected with errors naming the construct. Shape
  validation stays delegated to the engine's `validateMeta`.
- **Source resolution.** Precedence `scriptPath > script > name`. `name`
  resolves against `<cwd>/.claude/workflows/<name>.js` (project; shadows the
  user level) and `<dshHome>/workflows/<name>.js` (`resolveDshHome()`;
  `$DSH_HOME` → `~/.dsh`), and a miss lists the probed directories. A saved
  script whose meta name disagrees with its file name is accepted, with the
  disagreement surfaced as the receipt's `warning` field.
- **Async launch.** The tool returns immediately with CC's documented receipt
  subset `{status: "async_launched", taskId, taskType: "local_workflow",
  workflowName, runId, summary, warning?}` (`taskId === runId`; a no-start
  failure returns `{status, error}` with no `taskId`).
- **Exactly-once completion delivery.** A session-scoped cordis service
  (`ccWorkflowRunRegistry`) tracks in-flight runs. On settle, the payload
  joins the `agent/pre-step` batch when the session is busy (never the
  pending inbox) and is delivered as one `agent.inject()` wake when idle —
  one wake per run, by construction. A second concurrent run is refused with
  a structured error naming the in-flight runId (v1 single-active-run).
  Context disposal cancels in-flight runs and swallows settle delivery.
- **Durable session events.** The four harness event types verbatim —
  `tool-workflow/run-start` (extended with a `source` field: `inline` |
  `project-saved` | `user-saved` | `scriptPath`), `agent-start`, `agent-end`,
  `run-end` — projected top-level only, with the try/catch-drop append guard.
- **Invariant companion.** `@dsh-cc/tool-workflow/invariant` exports the
  workflow-record fold for profiles that opt into invariant rows; the cc
  preset mounts none.

## Deviations from CC (recorded)

Per-user workflows directory maps to `$DSH_HOME/workflows/` (not
`~/.claude/workflows/`); monorepo chain loading up to the repository root and
built-in workflows are not implemented; `taskId` aliases the harness run id
(no `wf_` prefix); the receipt omits `transcriptDir`/`scriptPath`/`sessionUrl`;
`ultracode` is an opt-in trigger only (no session-effort side effect);
same-session resume (`resumeFromRunId`) is implemented by the
`@dsh-cc/workflow-journal` provider (frozen-until-first-miss); cross-session
replay remains unimplemented.
