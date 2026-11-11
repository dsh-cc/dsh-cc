/**
 * Bundled CHANGELOG for `/release-notes`, seeded at author time from the
 * repository's tracked history and README. The full changelog rides a TS string
 * constant so the command is offline-safe and deterministic — no filesystem or
 * network at call time.
 *
 * The newest section's version MUST equal this package's `package.json`
 * version; `tests/command-release-notes.spec.ts` pins that pairing so the
 * snapshot cannot silently age into a wrong report again. `scripts/release.mjs`
 * prepends that section (user-facing commit subjects since the previous
 * section's tag) in the same commit as the version bump; edit it in the
 * release PR when the subjects need a rewrite.
 *
 * @module @dsh-cc/command-release-notes/release-notes
 */

/** The bundled changelog, newest section first. */
export const CHANGELOG = `# Release notes

## 0.9.5-rc.1 — defaults, SystemOne decisions and fixes

- **Defaults** — the completion gate, turn rules (judged and repeat
  reminder), LSP diagnostics-on-write and post-edit auto-verify are now on
  by default; each keeps an explicit \`enabled: false\` opt-out. Context
  compression is on in measurement-only (dry-run) posture.
- **Prompt suggestions** — still off by default; when enabled they run on
  top-level turn stops only, and an unconfigured cheap-lane alias is skipped
  instead of billed to the parent route.
- **SystemOne decisions** — a decision runtime with contract validation,
  budget and metering, routed through the \`gauge\` lane alias. It backs
  optional memory recall selection, a memory extraction gate and semantic
  tool discovery, all off by default.
- **Memory** — recall preselection and admission planning for large corpora,
  plus fixes to recall tie-breaking, grey-zone rows and consolidation.
- **Permissions** — the auto-mode underspec criteria are retuned so
  read-only compound shell commands no longer escalate to ask.
- **Settings** — secret redaction now covers union, intersect and transform
  nodes; frozen cascade sections parse without mutation faults; provider,
  namespace and cascade merge into @dsh-cc/settings.
- **Fixes** — ACP resolves the preset roster per use (no more stock-plugin
  fallback under load) and reports the current version; moa writes
  automatic escalation rows in chain order; /compact resolves its zh alias.
- **Packaging** — serena-first and output-styles merge into
  @dsh-cc/prompt-extras; Node 24 is the primary line and 22 the engines floor.

## 0.9.4 — Claude Code compatibility layer

- **Commands** — 21 human-facing slash commands spanning session inspection
  (/status, /cost, /stats, /export, /diff, /transcript), diagnostics (/doctor),
  configuration (/config, /permissions, /preset, /mcp, /skills, /agents,
  /tasks, /memory, /plugin), workflow (/commit-split, /branch, /resume,
  /rename, /compact, /init) and metadata (/version, /release-notes, /help).
- **Hooks** — a Claude-Code hook bridge over the harness hook protocol,
  covering lifecycle, permission, tool and subagent events, with command and
  http executors plus Stop-block capping.
- **Permissions** — a CC-shaped allow/deny/ask rule engine with modes,
  session-scoped grants, and an auto mode that decides low-risk calls through
  a classifier.
- **Memory** — CLAUDE-style file memory with a project index, sidecar recall
  and background consolidation.
- **Skills and plugins** — SKILL.md discovery across the CC roots, a plugin
  marketplace loader, and deferred tool-name resolution via ToolSearch.
- **MCP** — an MCP client with resources, prompts and deferred startup, plus a
  .mcp.json/.claude.json parser and a migration command.
- **Compaction** — a CC-aware compaction engine with optional cost gating,
  tool-use summaries and staleness microcompaction.
- **Subagents** — a task tool with worktree isolation, resume pins, a handoff
  store and a background-capacity release valve.
- **ACP** — an Agent Client Protocol session surface so external editors can
  drive dsh-cc over stdio.
- **Session plumbing** — a 5-level settings cascade, session projections,
  statusline rendering and a working-directory facade.

See per-package READMEs for detailed contracts.
`

/**
 * Render the release notes, trimming to at most `maxLines` from the top.
 * @param markdown - the changelog markdown (defaults to {@link CHANGELOG}).
 * @param maxLines - maximum number of lines to show (default unlimited), used
 *   to keep the on-screen report short while retaining the newest section.
 * @returns the rendered release notes text.
 */
export function renderReleaseNotes(markdown: string = CHANGELOG, maxLines?: number): string {
  const lines = markdown.replace(/\r\n/gu, '\n').split('\n')
  if (maxLines === undefined || maxLines <= 0) return lines.join('\n')
  return lines.slice(0, maxLines).join('\n')
}
