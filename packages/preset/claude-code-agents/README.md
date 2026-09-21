# dsh-claude-code-agents

English | [中文](README.zh.md)

Load Claude Code's `.claude/agents/*.md` and `*.json` sub-agent definitions as dsh agent presets. The package is a pure, filesystem-backed translation: it discovers the bundled, user, and project layers, parses and validates each agent file, and returns one typed [`AgentDefinition`](./src/types.ts) per agent — no harness runtime is involved, so the loader can be reused by a Claude Code plugin loader alongside this preset package and consumed however a deployment wires it up.

## What it does

- **Three layers, highest wins.** The bundled layer ships in-package utility agents (`explore` and `dsh-cc-guide`, both pinning `model: haiku` with a Read/Glob/Grep allow-list) via `discoverBundledAgents()`. The project layer is the nearest `.claude/agents` directory found by walking up from the project root; the user layer is the author's own `~/.claude/agents`. A definition is keyed by its file basename, and layers shadow by rank — bundled < user < project — so a local file of the same name always overrides its bundled namesake.
- **Two formats.** A `.md` file's YAML frontmatter supplies the fields and its markdown body (or the `prompt` frontmatter override) supplies the system prompt. A `.json` file is a single object whose `prompt` field is the system prompt.
- **Loud failures.** Every bad known frontmatter value throws at load time with the file path and field name, so a broken agent is fixed rather than silently degraded. Unknown fields are ignored, so a definition authored against a newer Claude Code release ports to the supported subset.
- **Field translation.** `description` becomes the when-to-use guide; `tools`/`disallowedTools` compile to one effective `allow`/`deny` tool restriction whose names intersect (a name in both lists is denied); `model` (with the `inherit` sentinel normalized), `effort`, `permissionMode`, `maxTurns`, `initialPrompt`, `background`, `memory`, `skills`, `mcpServers`, `hooks`, and `isolation` are all carried through — and `background` is no longer inert: the Task tool honors it (backgrounds on omitted `run_in_background`); `isolation: worktree` is consumed by the Task tool too (the child runs in a per-child git worktree — see `@dsh-cc/subagent-task`'s isolated-worktree section).

## API

- `loadClaudeCodeAgents(root, options?): Promise<AgentDefinition[]>` The project layer resolved by walking up from `root`, shadowing the user layer; `options.userDir` overrides the user `.claude/agents` directory (useful for a harness with a non-default home and for hermetic tests). Throws on the first unparsable agent file.
- `parseAgentMarkdown(path, text, source): AgentDefinition` and `parseAgentJson(path, text, source): AgentDefinition` Parse one in-memory file; useful for unit tests and non-directory inputs.
- `splitFrontmatter(text): ParsedMarkdown` Split the leading YAML block out of a markdown string.
- `discoverBundledAgents(): AgentDefinition[]` The in-package bundled agent set (`source: 'bundled'`); a bundled document that fails to parse throws, like any broken agent file.
- `discoverAgents(projectRoot, userDir?): Promise<AgentDefinition[]>` The layer merge without the home-dir default.
- `loadAgentsDir(dir, source): Promise<AgentDefinition[]>` and `findProjectAgentsDir(start): Promise<string | undefined>` The per-directory scan and the upward walk.
- `resolveToolRestriction(tools, disallowedTools): ToolRestriction | undefined` and `normalizeModel(model): string | undefined` The pure restriction-merge and model-normalization helpers, exported for reuse and for testing.
- `applyActorContract(persona, candidates, patterns): string` Apply the `<!-- actor-contract:start -->`/`end` marker gate to a persona: the marker lines are always removed, and the block between them is kept iff some candidate model id matches some pattern — otherwise the content is excised too, with the surrounding text collapsed cleanly. Input with no markers is returned byte-identical.
- `matchesModelPattern(value, pattern): boolean` and `matchesAnyModelPattern(values, patterns): boolean` The case-insensitive whole-string model matcher behind the gate: `*` is the only wildcard, every other regex metachar in the pattern is literal.

`AgentDefinition` carries `agentType` (the file basename), `whenToUse`, `systemPrompt`, `source` (`user` | `project` | `bundled`), `baseDir`, `filename`, and the translated optional fields. The `toolRestriction` value is structurally identical to [`dsh-tools`](../../core/tools/README.md)'s `ToolRestriction`, so a consumer can hand it to a scoped `ctx.tools.restrict()` unchanged.

## Design

The loader is deliberately integration-free. It produces typed definitions and leaves consumption — a scoped tool restriction, a request rewrite, a permission selection — to the caller, so the model-facing parts stay reusable without dragging in the harness runtime. This mirrors [`agent-presets`](../../preset/agent-presets/README.md)'s philosophy of a self-contained vocabulary feeding an explicit consumer, rather than hiding a defaulting step inside the loader.
