# @dsh-cc/serena-first

Serena-first prompt steering for the CC preset (`packages/preset/cc`).

When a serena MCP server is connected (repo `.serena/project.yml`, user-scoped
`~/.claude.json` entry — see `docs/code-intelligence-health.md`), the session
carries ~30 `mcp__serena__*` symbol tools that answer code questions without
loading whole files. This plugin makes the system prompt say so:

- **Contribution A** — a registered section `serena-first` (order 105) with a
  dynamic provider that renders the policy paragraph while serena is ready and
  an empty string (dropped at render) otherwise.
- **Contribution B** — a `system-prompt/assemble` waterfall listener
  (`{ prepend: true }`, outermost, so its return value is authoritative) that
  replace-not-mutate appends one sentence each to the upstream
  `tool:read` and `tool:grep` sections while serena is ready.

Detection is registry-only and live: a duck-typed `mcpConnections` entry
(`state: 'ready'` with `toolCount > 0`), re-evaluated on every assembly, so a
mid-session disconnect stops the steering on the next turn. Scope-less
assemblies pass through (mirrors `tool-append-order`); `tool:write`,
`tool:edit`, and `tool:glob` are never rewritten.

Config: `enabled` (default `true`), `serverName` (default `'serena'`) — the
latter drives both detection and every emitted `mcp__<serverName>__*` name.
