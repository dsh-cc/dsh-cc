Cursor-dialect plugin fixture pack (S0 probe deliverable, plan
docs/plans/2026-09-15-cursor-plugin-dialect.md §3.5):

- `minimal/` — default-layout cursor plugin; hooks/hooks.json exercises the full
  inventoried Cursor event vocabulary.
- `declared-paths/` — manifest explicitly declares component paths, including an
  `agents/**` directory-recursive glob.
- `github-mcp/` — mirrors cursor/plugins `third_party/github`: `mcpServers: "./mcp.json"`,
  `variables` JSON Schema, marketplace metadata fields.
- `dual-manifest/` — BOTH `.claude-plugin/plugin.json` and `.cursor-plugin/plugin.json`
  present (CC takes precedence, with a report warning).

Hooks probe verdict (S0): DIVERGENT — mapping table required; see the plan doc §3.5.
