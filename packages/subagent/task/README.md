# @dsh-cc/subagent-task

English | [中文](README.zh.md)

The Claude Code-compatible **Task tool** and **per-workspace subagent catalog** for the
DeepSeek Harness. It mounts:

- the `subagent_fork` tool (CC display name `Task`) with `subagent_type` dispatch over the
  session workspace's `.claude/agents` definitions;
- the `Available subagents` system-prompt section, rendered per workspace;
- the reserved tool names (`subagent`, `workflow`) that keep disabled harness rows
  restrictable;
- a pre-step strip listener that removes the harness `agent-instructions` workspace
  baseline (CLAUDE.md / AGENTS.md) from delegated Task children.

The `ccModelRoutes` service (from `@dsh-cc/model-aliases`) supplies the spawn-time
alias resolver; when it is absent, every child inherits its parent's route (the builtin
fallback).

## What it is

Claude Code's `Task` tool lets the main agent delegate to a named subagent
(`subagent_type`, e.g. `deep-reasoner`) defined in `.claude/agents`, and the runner loads
that agent's own system prompt, model, and tool restriction. Historically the DeepSeek
Harness only had a generic fork (`description`/`prompt`), so `subagent_type` dispatch was a
dead letter: the child only ever got the *hand-written role copy* the main model put in the
prompt, and the agent's `model: opus` alias never reached the backend route.

This package restores the real link. It discovers the CC `.claude/agents` definitions that
are visible from the **session's** working directory (not the host process cwd — a web host
serves many workspaces, so `~/.dsh/…` startup must still see `my-repo/.claude/agents`), and
turns the internal `subagent_fork` tool into a genuine subagent-type dispatcher.

## How dispatch works

Given a `Task(subagent_type, description, prompt)` call from a CC preset session:

1. **`subagent_type` omitted, blank, or `general-purpose`** → a **fresh spawn** of the
   caller: the prompt text becomes the child's first user message, no definition
   participates, no parent conversation is copied. Write a self-contained prompt.
2. **`subagent_type` equal to the reserved sentinel `fork`** → a conversation-inheriting
   **fork** of the caller (Claude Code's `subagent_type: "fork"`): completed parent turns
   seed the child; no definition participates. The sentinel is reserved and wins over a
   workspace file of the same name — `.claude/agents/fork.md` is unreachable.
3. **A type that matches a definition** under the session cwd (`cwdOf` the assembling agent)
   → a `spawn` with:
   - `persona` = the definition's `systemPrompt` (delivered as the child's system segment);
   - the task text as the child's **first user message**;
   - `agentOptions` = the alias-resolved `{ provider?, model? }` from
     `ctx.get('ccModelRoutes').resolve(def.model)` (only provider/model fields that resolve
     to a value are forwarded, so per-field inheritance never breaks);
   - `toolFilter` = the definition's `toolRestriction` (allow/deny), **sanitized** of tool
     names this composition no longer registers;
   - `maxDepth` = 3 (matches the harness default; configurable).
4. **Any other type containing no colon** (not found in the workspace) → an **error
   result** listing the available types in this workspace (or noting the workspace
   defines none) — with a colon-aware hint when the type contains `:`.
5. **A type matching a plugin agent's scoped id (`plugin:agent`)** → a `spawn` with the
   same fold as a file definition (persona, sanitized toolFilter, alias-resolved model,
   `maxDepth` 3), enumerated live from the `subagents` seam. Plugin agents are addressed
   **only by their scoped id** — a bare plugin agent name is not addressable, matching
   Claude Code.

The resolution order is: reserved sentinels (`general-purpose` / `fork`) → workspace file
definitions → plugin agent scoped ids. File definitions and scoped plugin ids occupy
disjoint name spaces (file definitions whose `agentType` contains `:` are skipped with a
warning at discovery), so a scoped id can never shadow a file type and vice versa.

The dispatch is **foreground unless the child is explicitly or definition-pinned background**:
with `run_in_background` omitted, the run is foreground — the tool awaits the child to
completion, surfaces a non-`completed` stop reason as an error, and concatenates only the
`text` blocks of the child output — unless the definition pins `background: true`, in which
case the run backgrounds on omit. Explicit `run_in_background: false` wins over the pin and
forces foreground. An explicit `run_in_background: true` (or a pin on omit) starts the child
as a durable continuable background agent and returns promptly with its `agentId`.

### Tool-restriction sanitization and reserved names

When a definition's frontmatter narrows tools (e.g. `tools: Read, Task`), the allow/deny
lists are forced through the CC→harness translation and then checked against the **live**
set of names the tools registry knows (`ctx.tools.view(callingAgent).restrictableNames` —
registered and reserved names, read at execute time against the calling agent's scope so
standing-scope MCP reservations are visible). A name the registry does not know is dropped
with a warning; there is no static legal-names set, so mounted MCP tools and any future
registered row are accepted without code churn:

- **MCP public names.** An exact `mcp__<server>__<tool>` entry is kept as written — it must
  be the tool's public name, including the deterministic 12-hex identity-hash suffix when
  normalization truncated or replaced the name.
- **Server-level MCP wildcards.** `mcp__<server>` and `mcp__<server>__*` both expand to
  every mounted tool of that server (`mcp__<server>__` prefix), so frontmatter survives
  servers publishing new tools without naming hashed entries.
- **A bare `mcp__`** (no server segment) is dropped with an invalid-wildcard warning.
- **Auto-`ToolSearch`.** If the filter carried an `allow` list, any kept allow name is an
  MCP tool, and the `ToolSearch` tool is itself mounted (restrictable), `ToolSearch` is
  appended (deduped) — otherwise the child would hold MCP names with no load path. When
  `ToolSearch` is not mounted it is never injected.
- **Spawn-time preload of explicit deferred MCP names.** An explicit `tools:` entry that is
  still deferred (not yet registered) is activated through the duck-typed `ctx.toolSearch`
  seam at spawn, BEFORE the child starts, on BOTH dispatch paths (foreground collect and
  background) — activation is process-global, so every admitting agent's schema grows after
  the spawn. Server-level wildcard entries (`mcp__<server>`, `mcp__<server>__*`) are
  restrict-only: their expansions are never preloaded. Names the sanitized deny list
  excludes, or that sanitize dropped as unknown, are never activated; already-registered
  (eager) names are skipped silently. Outcomes surface in the Task result text
  (`Preloaded deferred tools for child: …`, plus `Not preloaded: <name> (<reason>)` for
  denied/unknown activations); with no `toolSearch` service mounted the step degrades to a
  single warning and the spawn proceeds normally.
- **Unmounted names are dropped** with the standard `dropping unknown tool name …`
  warning — including MCP names of servers that are not mounted.
- **An allow-list that matches nothing is deny-all, loudly.** If the filter carried an
  `allow` list and sanitization left zero names, the emitted filter is `{ allow: [] }`
  (the child runs with zero tools) with a warning naming the dropped originals — omitting
  `allow` would instead widen the child to every tool. An emptied `deny` list is simply
  omitted.

The internal tool name `subagent_fork` is registered by this package, and
`ctx.tools.reserve('subagent')` / `reserve('workflow')` keep those names in the restrictable
universe without exposing visible definitions (the CC frontmatter `Task` translation is
`['subagent', 'subagent_fork']`, so `subagent` must remain legal even though the harness
spawn row is disabled; `workflow` is reserved for the deferred workflow row). Because
sanitization checks the live registry rather than a static list, these reserved names and
every static CC name (`read`, `bash`, …) survive only when they are actually
reserved/registered — which they are in the cc preset. A definition that omits both
`tools` and `disallowedTools` passes no `toolFilter`, so the child inherits the full
parent tool view (including MCP schemas).

## Available subagents system-prompt section

A single global section (`cc:subagent-catalog`, order 110) serves every agent. Its text
callback receives the assembling agent through the assemble scope, derives that agent's cwd,
and renders:

```
## Available subagents

- deep-reasoner — reason through hard architecture and design problems
- fast-worker — execute a pre-approved mechanical plan

To delegate to one, pass its name as the `subagent_type` argument of the Task tool.
```

Because the section text is composed synchronously but discovery is async, the first
assembly for an unknown workspace shows nothing, then `system-prompt/change` fires once
discovery lands and reassembly reveals the catalog. When a workspace defines no agents (or
there is no agent to scope to) the section renders an empty string and drops out of the
prompt. The catalog lists file definitions plus plugin agents by their scoped ids — it
deliberately does **not** enumerate seam
backend provider names (`fork`/`spawn`/`codex`/`claude-code`) as if they were addressable
agent types; bare plugin agent names are not addressable either — only `plugin:agent`
scoped ids are.

## Workspace instructions on Task children

The harness `agent-instructions` plugin injects the workspace CLAUDE.md / AGENTS.md
baseline as an `agent-instructions`-sourced user message on every session — including
Task children. This package mounts an `agent/pre-step` listener that strips that baseline
from delegated children (`delegationDepth > 0`):

- A delegated child receives only the enter batch and pending inbox messages that are not
  `agent-instructions`-sourced; its persona remains the agent-file `systemPrompt` (or the
  deployment persona for `general-purpose`).
- Fork children still inherit any CLAUDE.md already in the parent seed — the listener only
  skips a *fresh* child scan; parent history is never rewritten.
- This is an intentional deviation from Claude Code, whose custom subagents **do** load
  CLAUDE.md (Explore/Plan in CC skip it). dsh-cc applies the skip to every Task child
  because the dsh-cc repo CLAUDE.md is orchestrator policy, not a worker contract.
- Residual: the harness still reads the instruction files from disk on the child's behalf;
  they just never enter the child's model-visible batch.

## Mounting

Mounted by the `cc` preset's `tool-task` row (`@dsh-cc/subagent-task`) inside the
`cc-services` group, alongside `cc-model-routes` (`@dsh-cc/model-aliases`) which
supplies the alias resolver. The cc preset **disables** the harness `tool-subagent` and
`tool-subagent-fork` rows in favour of this tool so there is no double registration of the
`subagent_fork` name.

## Known limits

- **Cold resume drops extra `agentOptions`.** Background (continuable) dispatch exists —
  `run_in_background: true` or a `background: true` definition pin — but cold resume restores
  `persona`/`toolFilter`/model route only and drops every other `agentOptions` field
  (alias-stamped `reasoningEffort`, `maxTokens`). See the parity matrix for the full
  background contract (drain on parent exit, no `outputFile`, fork + background rejected).
- **Process-level discovery cache.** The registry caches per workspace root for the process
  lifetime and does not watch the filesystem. Editing a `.claude/agents` definition takes
  effect on the next session for a workspace whose cache entry has not yet been created, and
  on process restart otherwise. mtime-based invalidation is a follow-up.
- **Reserved type names.** `general-purpose` and `fork` are sentinels, not file types. A
  workspace file `.claude/agents/fork.md` is unreachable; `subagent_type: "fork"` always
  means inherit completed parent turns.
- **Instruction files are still scanned.** The strip happens after the harness
  `agent-instructions` plugin has read the workspace CLAUDE.md / AGENTS.md from disk and
  injected them; this listener only keeps them out of the child's model-visible batch, so
  the disk scan itself cannot be prevented without changing the harness. A fork child's
  parent seed is never rewritten, so CLAUDE.md already in the seed is inherited.

## API

- `apply(ctx)` — cordis plugin entry (plugin id `cc-subagent-task`); safe when either the
  tools or the system-prompt seam is absent.
- `AgentRegistry` (`./registry`) — per-workspace definition cache (`ensure` / `list` /
  `resolve`), lazily loading `loadClaudeCodeAgents(root)` (user layer + project layer,
  project shadows user).
- `registerTaskTool` / `TASK_TOOL` (`./tool`) — register the `subagent_fork` Task tool.
- `mountAgentCatalog` / `CATALOG_SECTION_NAME` / `CATALOG_SECTION_ORDER` (`./catalog`) —
  mount the `Available subagents` section.
- `mountStripWorkspaceInstructions` / `isDelegated` / `isAgentInstructions`
  (`./strip-instructions`) — mount (or classify for) the pre-step strip of the harness
  `agent-instructions` workspace baseline on delegated Task children.

## Non-goals

- Treating omitted `run_in_background` as background as a session policy (the Claude Code
  interactive omit=background rule); dsh-cc stays foreground on omit unless the definition
  pins `background: true`.
- In-flight promotion of a running foreground Task to background (TUI Ctrl+B) — a follow-up,
  not a limitation of the package's existence.
- CC frontmatter `permissionMode` / `isolation` / `memory` / `effort` projection onto the
  child (the loader parses them, v1 does not consume them).
- `registerBaseAgents` in cc-shell (base-agent discovery moved here; see the cc-shell README).
