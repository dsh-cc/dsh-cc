# dsh-cc

**English** | [简体中文](README.zh.md)

## Coding and document workflows on DeepSeek Harness

`dsh-cc` adds Claude Code workflows to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). You select the models, tools, permissions, and agent configuration.

- Reuse `.claude/agents`, `SKILL.md`, `CLAUDE.md`, hooks, slash commands, and saved sessions.
- Map model aliases to the provider and model that your deployment has.
- Use TUI, MCP, memory, subagents, background tasks, worktrees, and structured output.
- Use `context-crusher` and `context_retrieve` for reversible tool-output compression.
- Add evidence checks for documents with the optional `vwa-writing` skill.

`dsh-cc` is a plugin stack for DeepSeek Harness. It is not Claude Code or a wrapper for Claude Code.

## Quick start

Install DeepSeek Harness and the launcher.

```sh
npm install -g @deepseek-ai/dsh @dsh-cc/cli
dsh-cc
```

The launcher must have `dsh >= 0.2.0-rc.2`. If dsh is an earlier version, the launcher stops with an upgrade message.

If the necessary dsh version is installed, install only the launcher.

```sh
npm install -g @dsh-cc/cli
dsh-cc
```

### Upgrade

```sh
npm install -g @dsh-cc/cli@latest
dsh-cc
```

Stable releases (`vX.Y.Z`) publish to the npm `latest` dist-tag. Release candidates (`vX.Y.Z-rc.N`) publish to `next` and never take `latest`. To try a release candidate, use `npm install -g @dsh-cc/cli@next`.

After an upgrade, the launcher updates the profile bundles at the next start. It records the version in `~/.dsh/profiles/tui/.dsh-cc-bootstrap.json`.

If the update cannot complete, the launcher shows a warning and starts the active profile. The next start runs the update again.

Network errors and the npm/pnpm minimum-release-age limit can delay an update. Profiles from a development sync use the development restore process.

### Profile installation

The launcher makes the `tui` profile. To install its bundles directly, use these commands.

```sh
dsh plugin --profile tui add \
  @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell \
  @dsh-cc/bundle-tui
dsh --profile tui
```

For the web UI, use these commands.

```sh
dsh plugin --profile web add \
  @dsh-cc/bundle-permissions \
  @dsh-cc/bundle-shell
dsh web
```

### dsh version compatibility

Each release has one dsh version for CI verification. The launcher also uses that version as its minimum requirement.

| dsh-cc release | Verified dsh |
| --- | --- |
| v0.8.3-rc.1 – v0.9.2 | 0.2.0-rc.2 |
| v0.8.2 | 0.1.7-rc.2 |
| v0.6.3 – v0.8.1 | 0.1.5-rc.1 |
| v0.6.0 – v0.6.2 | 0.1.2-rc.1 |
| v0.5.0 | 0.1.1-rc.2 (no launcher version gate) |

There is no maximum version limit. A newer dsh version can be untested. Upgrade dsh first when a dsh-cc release raises its minimum.

The two packages have different release schedules. Their `@latest` versions are not always a verified pair.

Maintainers: keep this table consistent with `DSH_HARNESS_REF` in `.github/workflows/presubmit.yml` and `MIN_DSH_VERSION` in `packages/launcher/tui/bootstrap.mjs`.

### Optional official plugins

The bundles are sufficient for the quick start. The `dsh-cc` marketplace has five optional official plugins.

- **`dsh-cc-agents`** has three subagents, five skills, and optional Serena hooks.
  - `critic` uses `opus` for analysis and review.
  - `executor` uses `sonnet` to execute a specified plan.
  - `marathon` uses `fable` for changes to many files or tasks with unknown requirements.
  - The skills are `dsh-cc-agents-orchestration`, `data-analysis`, **`vwa-writing`**, **`formal-design`**, and **`vwa-batch`**.
  - `formal-design` checks bounded TLA+ models and proves high-impact deterministic rules in Lean before the existing design review. TLC checks need Java >=17 and the pinned JAR ships with the plugin. Lean checks need the separately provisioned pinned Lean toolchain and never download anything at startup or check time. Installing the plugin does not enable project-wide screening; [adopt the rules manually](packages/plugin/dsh-cc-agents/skills/formal-design/references/agents-snippet.md) and restart after plugin updates.
- **`dsh-cc-writing`** has three skills for article writing, article review, and language editing, plus one supporting workflow skill.
  - The public skills accept Chinese and English articles in three genres.
  - A run keeps a brief, a plan, reviews, and a preservation check on disk.
- **`dsh-cc-shunt`** sends bulk reads and code generation again and again to worker subagents. Configure `haiku` for lower model cost.
- **`cc-codex-bridge`** lets you run one specified Codex command form through its PreToolUse hook.
- **`cc-grok-bridge`** lets you run one specified Grok command form through its PreToolUse hook.

Use the scoped subagent names, for example, `dsh-cc-agents:critic`. The bridge hooks do not get approval for each permitted command invocation.

Install plugins in a session.

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-agents@dsh-cc
/plugin install dsh-cc-writing@dsh-cc
/plugin install dsh-cc-shunt@dsh-cc
```

Installation sets `enabledPlugins`. Restart dsh to load the new agents, skills, and hooks.

To update an installed plugin, update the marketplace first. Then update the plugin cache.

```text
/plugin marketplace update dsh-cc
/plugin update dsh-cc-agents@dsh-cc
```

A marketplace update by itself does not update the installed plugin. Restart dsh after the plugin update.

Read each plugin README for its configuration and limits: [agents](packages/plugin/dsh-cc-agents/README.md), [writing](packages/plugin/dsh-cc-writing/README.md), [shunt](packages/plugin/dsh-cc-shunt/README.md), [Codex](packages/plugin/cc-codex-bridge/README.md), and [Grok](packages/plugin/cc-grok-bridge/README.md).

## Write and review documents with VWA

CC is the default preset. Installation of `dsh-cc-agents` does not select VWA or enable semantic review.

The `vwa-writing` skill can write a new article or review an article. Its workflow has evidence, claims, arguments, review, and delivery.

Use a dsh-cc build with the lane-2 tools. A different Claude-compatible host can load the skill without the necessary tools.

1. Install or update `dsh-cc-agents` with the procedure above.
2. Add these settings to `$DSH_HOME/settings.json`. The default directory is `~/.dsh`.

```json
{
  "vwa-argument": {
    "semantic-enabled": true,
    "review-alias": "sonnet"
  },
  "vwa-evidence": {
    "enabled": true
  }
}
```

3. Restart dsh to mount the enabled tools.
4. Run `/preset vwa`. If the session is locked, start a new session.
5. Run `/vwa init` one time in the workspace.
6. Use `/skills` to check that `vwa-writing` is present.

Then tell the agent to use the skill. For example:

```text
Use vwa-writing to review docs/article.md against docs/sources/. Do not change the article.
```

For a new article, give the research question, source scope, and output path. If you want repairs, let the agent change the body.

The skill checks prerequisites before work. If setup is not complete, it gives the necessary user actions in one message.

It does not change global settings or execute user-only commands. Only the user can run `/vwa sign` and `/vwa adjudicate`.

### Review behavior and limits

The workflow registers source excerpts, builds the argument graph, binds the bound body, and starts `argument.review` with `input.stage: "all"`.

The agent waits for the job before it makes a report. After related changes, approved repairs must have a new binding and review.

The runtime sets grades and delivery status. The skill and a critic opinion cannot replace those checks.

The specified body path and report path must be in the host presentation event before `delivered-reviewed` is possible.

A pending job, a failed check, or an exhausted budget cannot count as a passed review. The runtime can deliver an unverified draft.

`review-alias` selects a model alias. The default is `sonnet`. An unconfigured built-in alias can inherit the main model.

`semantic-mode` sets the initial project mode label. It does not make a passed review necessary for each delivery.

Project review limits are frozen at initialization. Review adds model calls, time, and token use.

Semantic review is experimental. The human annotation study has 60 cases. That study and acceptance tests with live models are not complete. A grade does not show that all claims are correct.

See the [plugin guide](packages/plugin/dsh-cc-agents/README.md#vwa-writing) and [acceptance record](docs/vwa/lane2-validation.md).

## Why use dsh-cc?

| Need | Capability |
| --- | --- |
| Keep project rules | Agents, skills, memory, settings, hooks, and commands |
| Select models by task | Configured provider/model aliases |
| Divide large tasks | Subagents, background jobs, and saved sessions |
| Control changes | Permissions, approval rules, worktrees, and workspace boundaries |
| Find tools when needed | ToolSearch and MCP discovery |
| Change interfaces | Terminal and web profiles |
| Review document evidence | Optional VWA runtime and vwa-writing skill |

This project uses dsh-cc for development. Its model routes are user configuration, expressed only through [model aliases](#model-aliases).

## Users

- Developers that use DeepSeek Harness for coding.
- Teams that reuse `.claude/` agents, skills, hooks, and project memory.
- Users that select different models for different tasks.
- Plugin authors that extend an agent runtime.
- Writers that want evidence and argument checks for documents.

## Compatibility at a glance

<!-- parity:matrix:start -->
| Category | Full | Partial | Missing | Non-goal |
| --- | --- | --- | --- | --- |
| Engine subsystems | 11 | 26 | 4 | 2 |
| Hook events | 10 | 7 | 4 | 0 |
| Command surface | 22 | 10 | 1 | 1 |
| Sessions and context | 0 | 2 | 1 | 0 |
| Memory and CLAUDE.md | 0 | 1 | 1 | 0 |
| Skills | 2 | 1 | 0 | 0 |
| Subagents | 0 | 4 | 0 | 0 |
| MCP | 2 | 1 | 0 | 0 |
| Plugins and marketplaces | 0 | 6 | 0 | 0 |
| Settings | 2 | 1 | 1 | 0 |
| Permissions | 0 | 1 | 0 | 0 |
| Models | 0 | 1 | 0 | 0 |
| Workspace | 0 | 4 | 0 | 0 |
| Interactive UX | 1 | 2 | 0 | 0 |

Statuses were verified against upstream documentation retrieved as of 2026-09-23 (freshness threshold: 120 days).

For the exact feature-by-feature status and known gaps, see the **[Claude Code parity matrix](docs/cc-parity-matrix.md)**.
<!-- parity:matrix:end -->

## Agent workflows

### Subagents

The CC preset discovers project agent definitions in `.claude/agents`. Agent frontmatter can select a model alias.

```text
.claude/
  agents/
    reviewer.md
    debugger.md
```

### Skills

The skill provider discovers `SKILL.md` files in project and installed skill directories. Use `/skills` to inspect the effective catalog.

### Memory

Memory has `CLAUDE.md` context and a separate write channel. Workspace memory is isolated. Shared team memory is optional.

When memory-index pressure increases, a background consolidation process runs automatically.

### MCP

The MCP client has tools, resources, prompts, and OAuth 2.1 authentication. Use `/mcp` to inspect and manage connections.

#### Optional Serena code intelligence

A configured [Serena](https://github.com/oraios/serena) server adds symbol tools and prompt guidance. The `explore` subagent gets read-only symbol tools.

Without Serena, the agent uses built-in Read/Grep tools. Install Serena if you want its symbol tools.

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

Add the server to `~/.dsh/.mcp.json` or a project `.mcp.json`.

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

Use the installed binary. A `uvx --from git+…` start writes to `~/.cache/uv`, which the session sandbox denies.

Use `/doctor` to inspect the `mcp.serena` check.

### Hooks

Hooks can react to session, prompt, tool, permission, compaction, task, and subagent events. Command and HTTP executors are available.

Prompt and agent executors must have their configuration flags. See the [parity matrix](docs/cc-parity-matrix.md) for the implemented events.

The CC preset loads this repository's tracked `hooks.json` from the launch directory. It contains development hooks.

The optional `dsh-cc-agents` plugin contains the Serena hooks. See [local development](#local-development) for their prerequisites.

## Slash commands

The CC preset includes these commands. Use `/help` to inspect the commands in your installed build.

```text
/agents            manage continuable background agents
/auto-mode         inspect the auto permission mode (defaults, config, decision review)
/branch            worktree branch management
/commit-split      propose an atomic-commit split of the working tree (dry-run)
/compact           compact the session context
/config            inspect or change settings
/cost              token / cost information
/diff              inspect CLAUDE.md / settings differences
/doctor            session health report (--verbose / --json)
/export            write the session transcript to a file
/help              list commands or show one command's help
/init              scan a project and scaffold CLAUDE.md
/learn             distill recurring corrections into workspace memory
/mcp               manage MCP connections
/memory            inspect memories
/onboard           re-run the first-run setup (clears the onboarding opt-out)
/permissions       inspect or change permission mode/rules
/plugin            manage plugins
/provider          manage LLM providers (list/add/remove, rotate keys, set default)
/release-notes     show release notes
/rename            pin an explicit title on the current session
/resume            resume an interrupted session
/skills            list installed skills
/stats             session event-log stats (turns, tools, tokens)
/status            environment and session status
/tasks             inspect current tasks/jobs
/version           show version information
```

The shared presets also include `/preset`. The VWA preset adds `/vwa` project commands.

The TUI adds its own local commands: `/model`, `/effort`, `/clear` (`/new`, `/reset`), `/exit` (`/quit`), `/usage`, `/export-md`, `/copy`, and `/tui-help`. See the [TUI package](packages/ui/tui/README.md#keys).

The TUI also has task lists, approvals, queued prompts, transcript export, usage displays, and local shell commands.

### Provider setup

Use `/provider list` to inspect routes. Use `/provider add <preset-id>` to add Moonshot, Z.AI/Zhipu, DeepSeek, or a custom endpoint.

The provider panel can change keys, refresh model lists, select defaults, and remove routes.

Type keys into the masked field. The credential store is `~/.dsh/.credentials.yaml`. Settings do not contain those keys.

Keys from environment variables are read-only in the panel. Credentials resolve per request. Changed defaults apply to new sessions.

Use `/model` to change the running session's model route.

### First start

Without a default model, the TUI opens the provider panel. Select a provider. Enter its key. Set a default model.

Esc skips setup for the active session. The panel returns at the next start.

Set `cc-onboarding.suppressed: true` in user settings to suppress automatic setup. Use `/onboard` to enable setup again.

Non-TTY runs do not open this panel. They show the no-model message.

## Model aliases

An agent definition can select an alias.

```yaml
model: sonnet
```

The configured route selects the actual provider and model.

```text
sonnet / draft      -> <provider>/<general coding model>
opus / blueprint    -> <provider>/<reasoning model>
haiku / sketch      -> <provider>/<fast model>
fable / masterplan  -> <provider>/<maximum-reasoning model>
architect           -> parent agent route (planning / orchestration)
gauge               -> typed-decision cheap lane (System One models; not generative)
inherit             -> parent agent route
```

Aliases are configuration, not fixed vendor assignments. A missing built-in alias usually inherits the parent route.

## Product boundaries

Claude Code is a separate product. dsh-cc adds Claude-compatible workflows to the DeepSeek Harness runtime.

A model router changes model routes. This stack also adds UI, commands, tools, memory, subagents, hooks, permissions, sessions, and worktrees.

Most features use external plugins. Some packages contain upstream source copies because the necessary extension points are internal.

## CC Mode

CC is the default preset for the `tui` profile. The four built-in dsh modes keep their original behavior.

For other profiles, select CC in the preset selector or configure CC as the default.

`/preset vwa` can change the saved default for new sessions. To return to CC, use `/preset cc`.

The terminal profile uses fullscreen mode by default. To use regular mode for one start, run this command.

```sh
DSH_CCTUI_UI_MODE=regular dsh --profile tui
```

## Configuration

Profiles use standard dsh composition. Put local profile overrides in this file.

```text
~/.dsh/profiles/tui/cordis.patch.yml
```

The overrides apply after the installed bundles. Package READMEs define settings precedence, model routes, permissions, hooks, memory, and TUI behavior.

### Custom status line

On `tui`, a shell command can replace the bottom status line. Put its configuration in user settings or project `.claude/settings.json`.

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

If the two keys are present, the dsh-native `statusline` key takes precedence over the compatible `statusLine` key.

The command receives a JSON session payload on stdin. It contains only available fields from the [statusline contract](https://code.claude.com/docs/en/statusline).

The first three stdout rows become the status line. The output keeps ANSI escape sequences. A command error or empty output gives a blank line.

The command runs at start, resume, new messages, mode changes, model changes, and each refresh interval.

`refreshInterval` is in seconds, with a minimum of one. The environment includes `COLUMNS` and `LINES`.

Settings edits apply without a restart. A changed command runs immediately. The three-row limit is different from Claude Code.

## Known limits

Compatibility is functional, not an exact copy of Claude Code. Some hook events, background workflows, IDE features, and vendor features are partial.

Read the [parity matrix](docs/cc-parity-matrix.md) for the active status.

## Architecture

Packages are grouped by responsibility.

```text
packages/
  settings/       settings cascade, migrations, namespaces
  interaction/    slash commands, permission rules, interaction plugins
  mcp/            MCP client and configuration
  hooks/          hook protocol and CC bridge
  core/           tool registry, ToolSearch, NotebookEdit, StructuredOutput, Sleep, workflow, web-fetch
  skill/          SKILL.md support
  preset/         CC agent preset and agent compatibility
  compat/         plugin loader and manager, model aliases, output styles
  memory/         CLAUDE.md memory and dream consolidation
  workspace/      worktree tool and session-cwd guard
  subagent/       coordinator, task tool, handoff store, resume pins
  compaction/     compaction tiers, cost gate, tool-use summaries
  session/        session commands (cost, export, stats, learn) and forensics
  context/        reversible tool-output compression (context-crusher) and post-compact progress rebuild
  llm-tuning/     reasoning-fold and side-query
  observability/  cache-health observer, config snapshot sidecar, shared sidecar IO
  plugin/         first-party plugins of the in-repo marketplace
  test-support/   shared test fixtures and eval harnesses (not published)
  bundle/         installable profile bundles
  ui/             terminal UI and the vendored pi-tui renderer
  launcher/       the dsh-cc executable
```

Source copies include the tools registry, MCP client, hook protocol, Claude Code hook bridge, and pi-tui renderer.

Runtime packages keep different names and service interfaces. The `check:vendor-purity` gate checks pi-tui source boundaries.

## Local development

Install workspace dependencies from the lockfile.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
```

### Serena hooks

The official agents plugin contains the Serena reminder and session cleanup hooks. Their prerequisites are in its [README](packages/plugin/dsh-cc-agents/README.md#serena-hooks).

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

This repository has `.serena/project.yml`. With the plugin enabled and `serena-hooks` on PATH, the hooks can run.

Hooks use `SERENA_HOME=<repo>/.serena`. This keeps hook state in the write boundary of the session sandbox.

The default home can be unwritable, and Serena can suppress that error. Keep `.serena/hook_data/` out of version control.

The installed pin also supplies `serena` and `serena-agent`. Health checks and indexing use one-shot uvx commands.

See [code intelligence health](docs/code-intelligence-health.md) for those commands.

To test unpublished packages in a real profile, use these commands.

```sh
pnpm run build
bash scripts/sync-local-profile.sh web
dsh web
```

After a development sync, `dsh-cc --version` shows `-dev+<commit>[.dirty]`. A launcher update through npm returns the profile to published bundles.

Run the production boot check before delivery. It uses a temporary DSH_HOME and a pseudo-TTY, with no model calls.

```sh
pnpm smoke:profile-boot
```

The bundles include `@dsh-cc/preset-cc`. A separate preset installation is not necessary for CC. See [development instructions](docs/dev.md) for dependency rules and offline work.

## Packages and releases

Published packages use the `@dsh-cc` npm scope. The root package is private. Installable packages use the repository release tools.

See [the release process](docs/release.md).

## Project status

Upstream changes can change this project's interfaces and compatibility. Use the parity matrix to check implemented features and known gaps.

For English documentation, use the [ASD-STE100 writing rules](docs/i18n/ste100.md). Keep each Chinese README consistent with its English pair.

Give reproduction steps, `/doctor --json` output, fixes with tests, extension proposals, or real project examples.

[Open an issue](https://github.com/dsh-cc/dsh-cc/issues) · [View pull requests](https://github.com/dsh-cc/dsh-cc/pulls)

## License

[Apache-2.0](LICENSE)
