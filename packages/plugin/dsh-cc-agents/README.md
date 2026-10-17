# @dsh-cc/plugin-dsh-cc-agents

English | [中文](README.zh.md)

Official dsh-cc plugin with three subagents, three skills, and optional Serena hooks.

## Components

| Component | Purpose | Model alias |
| --- | --- | --- |
| `dsh-cc-agents:critic` | Analysis, architecture decisions, plan review, and cause analysis | `opus` |
| `dsh-cc-agents:executor` | Execution of approved, fully specified plans | `sonnet` |
| `dsh-cc-agents:marathon` | Large changes, uncertain tasks, and extended debugging | `fable` |
| `dsh-cc-agents-orchestration` | Agent selection and report contracts | Main agent |
| `data-analysis` | Metric definitions, reconciliation, and report checks | Main agent |
| `vwa-writing` | Source evidence, argument review, article writing, and delivery | Configured VWA reviewer |

The critic has a read-only persona and usually runs in the background. Executor and marathon can change files and usually run in the foreground.

Check their reports before you use the results. Critic read-only behavior is a persona rule, not a host-enforced write restriction.

A missing built-in alias inherits the parent route. Configure aliases to select different models for different tasks.

## Install

Use a Claude-compatible client with plugin installation commands.

```text
/plugin marketplace add dsh-cc/dsh-cc
/plugin install dsh-cc-agents@dsh-cc
```

Restart dsh to load the plugin. Use `/skills` to find `vwa-writing` and the other installed skills.

## Update

Update the marketplace first. Then update the installed plugin cache.

```text
/plugin marketplace update dsh-cc
/plugin update dsh-cc-agents@dsh-cc
```

Restart dsh after the update. A marketplace update by itself does not update the installed plugin.

## VWA writing

Use `vwa-writing` for research articles, historical or literary analysis, and technical reports with source evidence.

Use it to review an article without body changes, or to write and revise a new article.

This workflow is optional for coding, translation, and copy editing. Use it if you want evidence review.

### Prerequisites

The skill does not enable VWA. CC is the default preset.

Use a dsh-cc build with the lane-2 delivery tools. Other clients can load the skill without those tools.

1. Add the following entries to `$DSH_HOME/settings.json`. The default directory is `~/.dsh`.

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

2. Restart dsh after you change the enable flag.
3. Run `/preset vwa`. If the active session is locked, start a new session.
4. Run `/vwa init` one time in the workspace.
5. Use `/vwa status` to inspect the project.

`review-alias` is a configured alias, not a fixed model name. Its default is `sonnet`. A missing built-in alias can inherit the parent model.

Project limits are frozen at initialization. The reviewer uses the host model route. Review uses model calls, tokens, and time.

`semantic-mode` sets the initial project mode label. It does not make a passed review necessary for each delivery.

The skill gives missing prerequisites in one message. Its read-only script checks settings, project metadata, and the tool names from live discovery.

The script does not prove data integrity or article quality. Runtime tools perform those checks.

The skill does not change global settings or write internal project state directly. Only the user can run user commands.

### Requests

For a new article, give the question, source scope, language, and output path. For example:

```text
Use vwa-writing to write a Chinese article about the port closure.
Use docs/sources/ as evidence. Write docs/article.md.
Explain the supported conclusions, disputed claims, and missing evidence.
You may revise the article after review.
```

For an available article, tell the agent if it can change the body. For example:

```text
Use vwa-writing to review docs/article.md against docs/sources/.
Do not change the article. Make a report of the findings.
```

### Workflow

1. Check the available tools, settings, and active project.
2. Set the research contract through `argument.update`.
3. Read sources and register source excerpts without changes with `evidence.register`.
4. Record actual searches with `evidence.search_log`.
5. Build claims, evidence groups, and arguments through `argument.update`.
6. Bind the bound body through `argument.update`.
7. Run `argument.review` with `input.stage: "all"`.
8. Wait for the host job and inspect the findings.
9. Make approved repairs within the frozen budget. Rebind and review changed material.
10. Make the report with `argument.report`.
11. Present the specified body and report paths through the host.

### Results and limits

The runtime sets evidence grades, active findings, and delivery status. The skill cannot give itself a pass.

A pending or incomplete job is not a passed review. A report or reviewed candidate is not a confirmed delivery.

The two specified paths must be in the host presentation event before `delivered-reviewed` is possible. Without presentation, delivery is not confirmed.

A failed review, missing evidence, or an exhausted budget stays visible. The result can be an unverified draft.

Use the runtime report for claim strength, premises, reasoning, disputes, and evidence gaps. Put necessary limits in the body also.

Only the user can run `/vwa sign` and `/vwa adjudicate`. A critic opinion does not replace `argument.review`.

Semantic review is experimental. Human calibration and live-model acceptance are incomplete. A grade does not show that all claims are correct.

The package includes the [skill](skills/vwa-writing/SKILL.md), [tool contract](skills/vwa-writing/references/tool-contract.md), and [writing rules](skills/vwa-writing/references/writing-rules.md).

Relative resources resolve from the installed skill directory. A repository checkout is not necessary.

## Name collisions

Project agents can use the same bare names. Plugin agents use the specified scoped identifiers in the component table.

The two definitions can be in the catalog. The plugin definitions have an official-build description.

## Optional MCP tools

The agent definitions name optional MCP tools. The dsh-cc Task dispatcher removes unavailable names with a warning.

With those servers connected, the dispatcher activates their named tools before the child starts. It also adds ToolSearch where necessary.

- Critic has five read-only Serena tools, sequential_thinking, and two context7 lookups.
- Executor has twelve Serena tools, including symbol changes, diagnostics, and language-server restart.
- Marathon has the executor tools plus the critic reasoning tools.

Keep the server aliases `serena`, `sequential_thinking`, and `context7`. Different aliases can make the named tools unavailable.

The direct `AgentProvider.start` path does not remove unavailable tool names. For direct calls, sanitize the list or remove unavailable MCP entries.

## Serena hooks

The PreToolUse hook can stop raw read/grep calls that occur again and again and give a symbol-tool reminder. Its limit is one reminder per two minutes per session.

The SessionEnd hook removes that session's hook state. The two hooks must have a Serena project and `serena-hooks` on PATH.

The project check searches from the session directory to the Git root for `.serena/project.yml`. Without the two prerequisites, the hooks do nothing.

Install the binary with this command.

```sh
uv tool install git+https://github.com/oraios/serena@v1.7.0
```

Hook state uses `SERENA_HOME=<repo>/.serena` to stay in the sandbox write boundary. Keep `.serena/hook_data/` out of version control.

Keep each reminder in one place. A second repository reminder can count the same calls twice.

Without a Serena project, each read/grep starts a gated Node process, usually about 50 ms. It does not start Python.

Disable the plugin to remove that hook cost. Update the plugin after releases to get hook changes.

## Local plugin directories

The host composition setting `pluginDirs` can load a checkout or an installed `@dsh-cc/plugin-dsh-cc-agents` package.

Plugin CLI commands do not change this composition setting. Use marketplace installation for the usual setup.
