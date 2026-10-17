# Code-intelligence health runbook

Operational notes for the Serena MCP path (the production code-intelligence
path; see the "IDE integration / LSP" row in `docs/cc-parity-matrix.md`).

## Health check

```
uvx --from git+https://github.com/oraios/serena@v1.7.0 serena project health-check
```

- Exits 1 on failure (since v1.7.0); a zero-match `find_symbol` during the
  check counts as failure.
- **Caveat**: this spawns a separate uvx instance with its own language
  server. It validates project configuration, not the live session's
  server — a passing health check does not prove the in-session LS is
  healthy, and vice versa.

## Index pre-warming

```
uvx --from git+https://github.com/oraios/serena@v1.7.0 serena project index
```

The symbol cache is per-worktree: a fresh worktree starts cold even if the
main checkout is already indexed. Pre-warming is optional in worktrees —
useful for long sessions on large projects, skippable otherwise (first
symbol queries pay the indexing cost once).

## Startup failure behavior

The `~/.claude.json` (user-scope) discovery path defaults
`failOnStartupError: true`: a failed Serena startup rejects plugin
activation loudly in logs — it is not silent. However, the model is not
told the tools are missing; a session whose `mcp__serena__*` calls all fail
mysteriously may simply be a startup failure. Check the harness logs first.

## Failure classes

| Class | What it looks like | Visible to the model? |
| --- | --- | --- |
| a. MCP startup failure | plugin activation rejected at session start | No — loud in logs only (`failOnStartupError`), the model is not told tools are missing |
| b. Mid-session LS crash | Serena tool calls return errors | Yes, as tool errors |
| c. Stale/empty/misrouted results | indexing races or per-language routing bugs return successful but wrong/empty results | No — successful tool results, structurally invisible to hooks; carried by the prompt-level fallback rules in `CLAUDE.md` (MCP routing → Serena fallback rules) |
| d. Other tool-level errors | individual tool failures (timeouts, bad args) | Yes, as tool errors |
