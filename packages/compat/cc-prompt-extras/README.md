# @dsh-cc/prompt-extras

English | [中文](README.zh.md)

Two system-prompt overlays for the CC preset, shipped as one package with two
entry points:

| Entry point | What it contributes |
|---|---|
| `@dsh-cc/prompt-extras/serena-first` | Steers code questions toward the `mcp__serena__*` symbol tools while a serena MCP server is ready. |
| `@dsh-cc/prompt-extras/output-styles` | Claude Code-style output styles, including project- and user-authored custom styles. |

They are separate cordis plugins (distinct plugin ids, distinct `inject`
sets), so the preset mounts them as two rows:

```yaml
- id: serena-first
  name: '@dsh-cc/prompt-extras/serena-first'

- id: cc-output-styles
  name: '@dsh-cc/prompt-extras/output-styles'
```

## Serena-first steering

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

## Output styles

Claude Code-compatible output style selection for the DeepSeek Harness. The selected style contributes a system-prompt section through the `systemPrompt` registry — empty for the `default` style — so the model's communication contract mirrors the familiar Claude Code `Explanatory` / `Learning` styles plus project- and user-authored custom styles.

### Output styles

Three built-in styles ship with the package:

| Style | Effect |
|---|---|
| `default` | Contributes no section. |
| `Explanatory` | Directs the model to explain its implementation choices and codebase patterns as it works. |
| `Learning` | Directs the model to teach collaboratively, requesting short hands-on practice contributions gated by a single `TODO(human)` marker. |

Custom styles are loaded from `<project>/.claude/output-styles/*.md` (project) and the harness home `~/.dsh/output-styles/*.md`, with the later project directory overriding a same-named earlier style. Each file name becomes the style name; frontmatter supplies a `description` (required) and an optional `keep-coding-instructions` boolean (default `true`):

```md
---
description: Keep answers concise and skip the usual preamble.
keep-coding-instructions: false
---
Your concise coding and communication instructions here.
```

When `keep-coding-instructions` is `false`, the contributed section states that it replaces the default coding-instruction section; when `true` (the default), the default coding instructions are retained alongside the style's prose. Malformed or missing frontmatter fails the plugin load loud.

### Selection

The active style is the settings key `outputStyle` in the `cc-output-styles` namespace, layered over the plugin composition `outputStyle` config. Without a settings provider the composition value stands; then `/output-style` still switches in-session.

A switch re-emits `system-prompt/change`, so the next assembled prompt picks up the new style's section.

### `/output-style` command

Registered through `ctx.commands`; every composed command adapter discovers it without a model turn.

| Input | Result |
|---|---|
| `/output-style` | Show the current style and the selectable styles. |
| `/output-style <name>` | Set the active style; unknown names return an error listing the selectable styles. |

### Composition

The plugin injects `systemPrompt` and `commands`. Custom apps mount their owners plus this row:

```yaml
- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: cc-output-styles
  name: '@dsh-cc/prompt-extras/output-styles'
  config:
    outputStyle: Explanatory
```

### Model Experience

#### Output style section

##### What the model sees

While a non-default style is active, its prose appears as the `cc:output-style` prompt section, rendered before the deployment persona. The `default` style contributes nothing.

##### Token effect

The `default` style adds no tokens. Non-default styles add their section prose to each assembled prompt.

##### KV Cache effect

The contribution is a fixed prompt-section provider; a style switch changes the section text and so the assembled prompt for the following turn, like any system-prompt section change.

### Known Limitations and Deferred Work

- **Prompt-section replacement only** — `keep-coding-instructions: false` is expressed in the contributed section's lead-in rather than by unregistering the harness's own coding-instruction provider, which owns that slot.
- **Composition fallback is static** — without a settings provider the selection reverts to the composition `outputStyle` after a reload; `/output-style` persistence needs the `settings` service.
- **No plugin-forced styles** — Claude Code's plugin-authored `force-for-plugin` output styles are out of scope for this row.
