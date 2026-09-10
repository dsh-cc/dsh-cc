# dsh-cc

**English** | [简体中文](README.zh.md)

## Claude Code-style workflows. Your models. DeepSeek Harness.

`dsh-cc` turns [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) into a batteries-included coding environment for everyday development. Keep familiar project assets and interaction patterns while choosing the models, tools, permissions, and agent composition that fit your environment.

- **Reuse familiar workflows:** `.claude/agents`, `SKILL.md`, `CLAUDE.md`, hooks, permissions, slash commands, and resumable sessions.
- **Bring your own model strategy:** route aliases such as `sketch`, `draft`, `blueprint`, and `masterplan` to any provider/model pair supported by your dsh deployment.
- **Run a complete coding loop:** TUI, MCP, memory, subagents, background tasks, worktrees, structured output, and deferred tool discovery.
- **Stay composable:** install the experience through native dsh profiles and plugins instead of maintaining a permanent DeepSeek Harness fork.

> `dsh-cc` is not Claude Code and is not a wrapper around Claude Code. It implements familiar Claude Code-style workflows on the open, composable DeepSeek Harness runtime.

## Quick start

Install DeepSeek Harness and the `dsh-cc` launcher, then start coding:

```sh
npm install -g @deepseek-ai/dsh @dsh-cc/cli
dsh-cc
```

`dsh-cc` requires `dsh` **>= 0.1.2-rc.1**; the default `npm install -g @deepseek-ai/dsh` currently satisfies this (as of 2026-09-12), and the launcher enforces the floor at bootstrap.

Already have `dsh` **>= 0.1.2-rc.1**? Install only the launcher:

```sh
npm install -g @dsh-cc/cli
dsh-cc
```

The launcher creates and boots the CC-oriented `tui` profile. To compose the profile explicitly instead:

```sh
dsh plugin --profile tui add \
  @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell \
  @dsh-cc/bundle-tui
dsh --profile tui
```

The same backend also works with the dsh web UI:

```sh
dsh plugin --profile web add \
  @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell
dsh web
```

### Optional: official plugins

The bundles above are the whole quick start. Two optional official plugins — shipped through the repo's `dsh-cc` marketplace — add preconfigured subagent lanes:

- **`dsh-cc-agents`** — the `dsh-cc-agents:critic` (reasoning and plan review, `opus` alias) and `dsh-cc-agents:executor` (mechanical execution, `sonnet` alias) subagents, plus an orchestration routing skill.
- **`dsh-cc-shunt`** — PreToolUse gates that redirect bulk file reads and boilerplate generation to cheap-lane worker subagents, keeping large file corpora out of the main context (configure a `haiku` alias for real token savings).

Install them inside a session:

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-agents@dsh-cc
/plugin install dsh-cc-shunt@dsh-cc
```

`/plugin install` flips the `enabledPlugins` flag for you; restart the session so the new agents and hooks are picked up. To update later, re-pull the marketplace and then update the plugin: `/plugin marketplace update dsh-cc`, then `/plugin update <id>`. Each plugin's own README ([agents](packages/plugin/dsh-cc-agents/README.md), [shunt](packages/plugin/dsh-cc-shunt/README.md)) covers configuration and known limits.

## Why developers use dsh-cc

| Need | What dsh-cc provides |
| --- | --- |
| Keep project conventions | Loads Claude Code-style agents, skills, project memory, settings, hooks, and plugin commands |
| Mix fast and capable models | Maps stable aliases to deployment-controlled provider/model routes |
| Delegate larger tasks | Supports subagent dispatch, background work, task inspection, and resume-aware routing |
| Work safely in parallel | Adds permission rules, approval flows, worktree tools, and workspace boundaries |
| Avoid loading every tool up front | Provides deferred discovery through `ToolSearch` and MCP integration |
| Move between interfaces | Exposes the same CC-oriented backend through terminal and web profiles |

`dsh-cc` is developed with `dsh-cc` itself. The repository's current setup routes work across Kimi, GLM, and DeepSeek models; see [Dogfooding dsh-cc](#dogfooding-dsh-cc) for the concrete mapping.

## Compatibility at a glance

<!-- parity:matrix:start -->
| Category | Full | Partial | Missing | Non-goal |
| --- | --- | --- | --- | --- |
| Engine subsystems | 11 | 10 | 4 | 2 |
| Hook events | 12 | 4 | 4 | 0 |
| Command surface | 21 | 7 | 1 | 2 |
| Sessions and context | 1 | 0 | 1 | 0 |
| Memory and CLAUDE.md | 0 | 1 | 1 | 0 |
| Skills | 0 | 1 | 0 | 0 |
| Subagents | 0 | 1 | 0 | 0 |
| MCP | 2 | 1 | 0 | 0 |
| Plugins and marketplaces | 0 | 2 | 0 | 0 |
| Settings | 2 | 1 | 0 | 0 |
| Permissions | 0 | 1 | 0 | 0 |
| Models | 0 | 1 | 0 | 0 |
| Workspace | 1 | 0 | 0 | 0 |
| Interactive UX | 1 | 2 | 0 | 0 |

Statuses were verified against upstream documentation retrieved as of 2026-09-05 (freshness threshold: 120 days).

For the exact feature-by-feature status and known gaps, see the **[Claude Code parity matrix](docs/cc-parity-matrix.md)**.
<!-- parity:matrix:end -->

## Familiar coding-agent workflows

### Subagents

Project-local Claude Code-style agent definitions under `.claude/agents` can be discovered and dispatched by the CC preset.

```text
.claude/
  agents/
    reviewer.md
    debugger.md
```

Agent frontmatter can continue using familiar model aliases while dsh decides which provider/model actually serves the request.

### Skills

`SKILL.md`-based skills are discovered by the CC skill provider, including project-specific skills and bundled utility skills.

### Memory

The memory layer supports `CLAUDE.md`-style context plus a dedicated write channel for durable memories. Memory is isolated by workspace, with optional shared team memory.

### MCP

The CC profile includes an MCP client with:

- tools;
- resources;
- prompts;
- OAuth 2.1 flows.

Use `/mcp` to inspect and manage MCP connections.

#### Optional: Serena code intelligence

When your MCP configuration connects a [Serena](https://github.com/oraios/serena) server, dsh-cc automatically takes advantage of it: the system prompt steers toward Serena's symbol tools for code questions, and the bundled `explore` subagent gains read-only symbol retrieval (`find_symbol`, `find_referencing_symbols`, `get_symbols_overview`). Serena is strictly optional — without it, sessions behave identically through the built-in Read/Grep tools, minus the steering hints.

Install Serena once so a local `serena` binary is on `PATH`:

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

Then add it to `~/.dsh/.mcp.json` (or a project `.mcp.json`) using the local binary:

```json
{
  "mcpServers": {
    "serena": {
      "command": "serena",
      "args": ["start-mcp-server", "--context", "claude-code", "--project-from-cwd"]
    }
  }
}
```

Avoid launching it via `uvx --from git+…`: every server start would write `~/.cache/uv`, which the session sandbox denies.

`/doctor` reports the connection under the `mcp.serena` check.

### Hooks

Claude Code-style hooks can react to session, prompt, tool, permission, compaction, task, and subagent lifecycle events. Command and HTTP executors are supported, with additional prompt/agent executors available behind configuration gates.

This repository ships a tracked `hooks.json` (the CC preset loads it from the launch cwd). The PreToolUse remind hook requires `serena-hooks` on `PATH` — see [Local development](#local-development).

See the [parity matrix](docs/cc-parity-matrix.md) for the currently bridged event set.

## Slash commands

The CC preset exposes a growing command surface, including:

```text
/cost              token / cost information
/doctor            session health report (--verbose / --json)
/status            environment and session status
/memory            inspect memories
/skills            list installed skills
/config            inspect or change settings
/permissions       inspect or change permission mode/rules
/mcp               manage MCP connections
/tasks             inspect current tasks/jobs
/resume            resume an interrupted session
/branch            worktree branch management
/diff              inspect CLAUDE.md / settings differences
/init               scan a project and scaffold CLAUDE.md
/plugin             manage plugins
/provider           manage LLM providers (list/add/remove, rotate keys, set default)
/onboard            re-run the first-run setup (clears the onboarding opt-out)
/release-notes      show release notes
/version            show version information
```

The TUI also provides terminal-oriented interactions such as todo inspection, approval flows, queued prompts, transcript export, usage/context display, and local shell commands.

`/provider` opens an overlay over your configured model providers: `/provider list` prints the current routes, `/provider add <preset-id>` walks a wizard for the built-in presets (Moonshot, Z.AI/Zhipu, DeepSeek) or a fully custom endpoint, and the per-route detail view rotates keys, refreshes the model list, sets the default, or removes the route. API keys are typed into a masked field and stored in the credential store (`~/.dsh/.credentials.yaml`), never in settings; keys already supplied by the environment are shown read-only. Changes take effect for new sessions immediately (credentials resolve per request); the running session keeps its current provider until you pick again with `/model`.

### First-run onboarding

On a fresh install with no model configured, the boot seed settles with no default route and the TUI opens the provider panel automatically: pick a preset, paste your API key (stored only in the credential store), and set the default model — then you are ready to go. Dismissing the panel with `Esc` only skips it for the current session; the flow is re-offered on the next boot. To opt out permanently, set `cc-onboarding.suppressed: true` under the user settings namespace in `~/.dsh/settings.json`, and re-arm any time with `/onboard`. Non-interactive (non-TTY) runs never trigger the flow and keep the plain "No model configured" notice.

## Use the models you want

Claude Code-style agent definitions often refer to models using aliases:

```yaml
model: sonnet
```

`dsh-cc` can route those aliases to provider/model pairs configured for your deployment.

Conceptually:

```text
sonnet / draft      -> <provider>/<general coding model>
opus / blueprint    -> <provider>/<reasoning model>
haiku / sketch      -> <provider>/<fast model>
fable / masterplan  -> <provider>/<maximum-reasoning model>
architect           -> parent agent route (planning / orchestration)
inherit             -> parent agent route
```

Aliases are configuration, not hard-coded vendor bindings. This lets you preserve familiar agent definitions while choosing the models that fit your own environment.

### Dogfooding dsh-cc

`dsh-cc` is now developed with `dsh-cc` itself. The project's current development setup uses the same model-alias routing described above, with this mapping:

| Alias | Model |
| --- | --- |
| `fable` / `masterplan` | `kimi-k3` |
| `opus` / `blueprint` | `glm-5.3` |
| `sonnet` / `draft` | `glm-5.3-flash` |
| `haiku` / `sketch` | `deepseek-v4-flash-0731` |
| `architect` | inherit (main thread) |

This is a real project configuration rather than a required default: users can map the aliases to any provider/model combination supported by their DeepSeek Harness deployment.

## How this is different

### vs. Claude Code

Claude Code is a complete coding-agent product. `dsh-cc` instead brings many familiar interaction patterns to the DeepSeek Harness runtime, where the deployment controls models, tools, plugins, permissions, and agent composition.

### vs. a DeepSeek Harness fork

This repository is designed primarily as an out-of-repo plugin stack. Most functionality is installed and composed through dsh profiles, reducing the amount of permanent fork maintenance required as upstream evolves.

A small number of upstream packages are vendored where the required extension point cannot currently be expressed as a wrapper. See [Architecture notes](#architecture) below.

### vs. model/API routers

This is not just a model-routing proxy. It extends the agent runtime and developer experience itself: UI, commands, tools, memory, subagents, hooks, MCP, permissions, sessions, and worktree workflows.

## CC Mode

CC Mode is an additional dsh agent preset. The four built-in dsh modes remain behaviorally unchanged.

On the `tui` profile, CC Mode is the default. On other profiles it can be selected through the preset selector or configured as the default agent preset.

The terminal profile launches in fullscreen mode by default. To opt out for one invocation:

```sh
DSH_CCTUI_UI_MODE=regular dsh --profile tui
```

## Configuration

Your profile remains ordinary dsh composition. Local tweaks can be placed in:

```text
~/.dsh/profiles/tui/cordis.patch.yml
```

They are applied after the installed bundles.

Model alias configuration, permissions, settings precedence, hook behavior, memory options, and TUI behavior are exposed through the corresponding plugins/settings namespaces.

For exact semantics, use the package READMEs and the [parity matrix](docs/cc-parity-matrix.md) as the source of truth.

### Custom status line

On the `tui` profile, you can replace the built-in bottom status line with your own shell command (Claude Code-compatible). The block can live in the user file `~/.dsh/settings.json` or in a project `.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.dsh/statusline.sh",
    "padding": 0,
    "refreshInterval": 10
  }
}
```

Project `.claude/settings.json` files shared with a Claude Code checkout work as-is; if both a camelCase `statusLine` and a dsh-native kebab `statusline` key are present, the dsh-native key wins.

The command receives a Claude Code-compatible JSON session payload on stdin (the [CC statusline docs](https://code.claude.com/docs/en/statusline) describe the contract); dsh-cc supplies only the fields it can source truthfully. Its stdout's first line becomes the status line (ANSI escapes are passed through); a failure or empty output renders a blank line. The command reruns on session boot/resume, new messages, mode and model changes — and immediately when the command itself changes — plus on the `refreshInterval` timer, which is in **seconds** (minimum 1). Scripts get `COLUMNS`/`LINES` in their environment.

v1 caveats: only the first output row is rendered (CC renders every row), and edits to `settings.json` made outside the running session apply at the next restart.

## Compatibility and known limits

The goal is **useful Claude Code-style workflow compatibility**, not byte-for-byte emulation of Claude Code.

Some areas are intentionally partial or depend on DeepSeek Harness extension points. Examples include parts of the hook event vocabulary, background subagent workflows, notification/IDE-shell behavior, and vendor-specific features.

The project tracks those differences explicitly instead of hiding them:

**[Read the full Claude Code parity matrix →](docs/cc-parity-matrix.md)**

## Architecture

The repository is a monorepo of small plugins and bundles grouped by responsibility:

```text
packages/
  settings/       settings cascade and migrations
  interaction/    permissions and slash commands
  mcp/            MCP client and configuration
  hooks/          hook protocol and CC bridge
  core/           tools, ToolSearch, NotebookEdit, StructuredOutput, Sleep
  skill/          SKILL.md support
  preset/         CC agent preset and agent compatibility
  compat/         plugin loader, model aliases, output styles
  memory/         CLAUDE.md memory and consolidation
  workspace/      worktree tools
  subagent/       coordinator / subagent integration
  compaction/     micro-compaction
  session/        cost, export, and stats commands
  bundle/         installable profile bundles
  ui/             terminal UI
  launcher/       optional dsh-cc executable
```

Most packages are normal out-of-repo dsh plugins.

A few packages vendor upstream implementations when the required changes need private/internal extension points rather than composition. These currently include the tools registry, MCP client, hook protocol, and Claude Code hook bridge. At runtime they are mounted under distinct package names while preserving the expected service interfaces.

## Local development

This repository expects a sibling DeepSeek Harness checkout at `../deepseek-harness` for local `link:` development dependencies.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

### Serena (`serena-hooks` on PATH)

Dogfooding this repo loads the tracked `hooks.json`. Its PreToolUse remind hook runs `serena-hooks remind --client claude-code` on every Read/Grep, so the binary must already be on `PATH`:

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

That pin provides `serena`, `serena-agent`, and `serena-hooks`. Do **not** invoke `uvx --from git+…` from the hook: that writes `~/.cache/uv` on every call, the session sandbox denies it, and Read hangs behind PreToolUse.

Health-check and index remain one-shot `uvx` commands; see [docs/code-intelligence-health.md](docs/code-intelligence-health.md).

To test unpublished packages against a real profile:

```sh
pnpm run build
bash scripts/sync-local-profile.sh web
dsh web
```

To prove the production bundle set actually boots in a user-grade
environment (fresh `DSH_HOME`, harness-healed fallback, pseudo-TTY, no LLM
calls) — the same gate presubmit and publish run:

```sh
pnpm smoke:profile-boot
```

To install/update the CC preset during local development:

```sh
bash scripts/sync-cc-preset.sh
```

See **[docs/dev.md](docs/dev.md)** for offline development details and repository-specific dependency rules.

## Packages and releases

Published plugins use the `@dsh-cc` npm scope. The root monorepo package is private; installable packages are released individually through the repository release tooling.

Release process details: **[docs/release.md](docs/release.md)**.

## Project status

`dsh-cc` is evolving alongside DeepSeek Harness. The compatibility surface can change as upstream adds new extension points or changes existing ones.

If you find a workflow that works differently from Claude Code, the [parity matrix](docs/cc-parity-matrix.md) is the best place to check whether it is implemented, partial, intentionally out of scope, or still missing.

Contributions, compatibility reports, and focused upstream extension proposals are welcome. Useful ways to help include:

- compatibility reports with reproduction steps and `/doctor --json` output;
- focused fixes and tests for one capability;
- upstream extension proposals that reduce vendored code;
- real-project model-routing and workflow examples.

**[Open an issue](https://github.com/dsh-cc/dsh-cc/issues) · [View pull requests](https://github.com/dsh-cc/dsh-cc/pulls)**

## License

[Apache-2.0](LICENSE)
