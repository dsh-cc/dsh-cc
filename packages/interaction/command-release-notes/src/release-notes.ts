/**
 * Bundled CHANGELOG for `/release-notes`, seeded at author time from the
 * repository's tracked history and README. The full changelog rides a TS string
 * constant so the command is offline-safe and deterministic — no filesystem or
 * network at call time.
 * @module @dsh-cc/command-release-notes/release-notes
 */

/** The bundled changelog, newest section first. */
export const CHANGELOG = `# Release notes

## 0.1.0-rc.5 — Claude Code feature parity

- **Permissions durability** — the permission-rule engine (allow/deny/ask +
  mode) now reads its rules from a durable settings section, so edits survive
  restarts and hot-reload without a re-deploy.
- **Hook events** — a 27-event CC hook bridge (command + http executors)
  surfaces lifecycle, permission, and tool events to external hook runners.
- **Schedule** — hook and command scheduling runs recurring work through the
  harness's turn-loop seams.
- **WebFetch / WebSearch** — web fetch and search tooling integrates with the
  standard tool registry.
- **Commands** — human-facing slash commands: /status, /doctor, /cost,
  /export, /stats.
- **Memory** — CLAUDE.md-style file memory with dynamic recall by a forked
  side-query, plus background consolidation.
- **Skills** — SKILL.md providers read CC directories; ToolSearch resolves
  deferred tool names.
- **MCP** — a vendored MCP client with OAuth 2.1, resources, and prompts, plus
  a .mcp.json parser.
- **Project shape** — settings-cascade (5-level file precedence), subagent
  coordinator, compaction-micro, and git-worktree tools.

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
