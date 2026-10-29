# @dsh-cc/plugin-dsh-cc-agents

English | [中文](README.zh.md)

Official dsh-cc plugin with three subagents, five skills, and optional Serena hooks.

## Components

| Component | Purpose | Model alias |
| --- | --- | --- |
| `dsh-cc-agents:critic` | Analysis, architecture decisions, plan review, and cause analysis | `opus` |
| `dsh-cc-agents:executor` | Execution of approved plans with complete specifications | `sonnet` |
| `dsh-cc-agents:marathon` | Changes to many files, tasks with unknown requirements, and long debugging tasks | `fable` |
| `dsh-cc-agents-orchestration` | Agent selection and report contracts | Main agent |
| `data-analysis` | Metric definitions, reconciliation, and report checks | Main agent |
| `vwa-writing` | Source evidence, argument review, article writing, and delivery | Configured VWA reviewer |
| `formal-design` | Bounded TLA+ modeling, TLC checks, Lean proofs with implementation conformance, and evidence review before the existing design review | Main agent |
| `vwa-batch` | Unattended multi-page VWA review batch: manifest, one task grant, nine checkpoints, resume, and the batch ledger | Configured VWA reviewer |

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

## Formal design

Use `formal-design` for protocol or state-machine changes with shared-state
ordering, retries or late messages, crash recovery, or asynchronous ownership
and authorization. The main dialog owns modeling and reviews counterexamples.
The packaged runner checks the bounded model and audits the evidence. It adds
no runtime enforcement or new review lane.

Installation makes the skill available. It does not enable project-wide
screening. A human must adopt the [project rules snippet](skills/formal-design/references/agents-snippet.md)
into the effective project rules. Explicit requests and a loaded orchestration
skill can also select it. The main dialog reports adoption and missing review
rules on first use; it does not edit AGENTS.md automatically. After a plugin
update, restart dsh to use the updated skill and runner.

Model checks need Java >=17 on PATH. The plugin includes the exact pinned
TLC v1.7.4 JAR, so no separate download or JAR configuration is required.
Normal dsh startup does not need Java. Neither runtime nor installation runs
a download script. The default order is --jar, then TLA2TOOLS_JAR, then the
bundled JAR. A missing or checksum-invalid configured JAR blocks the check;
it never silently falls back. All selections must match the pinned checksum.
The [third-party notices](skills/formal-design/toolchain/THIRD-PARTY-NOTICES.md)
record the original artifact, source and licenses. See the
[skill](skills/formal-design/SKILL.md), [modeling guide](skills/formal-design/references/modeling-guide.md),
[review contract](skills/formal-design/references/review-contract.md) and
[worked example](skills/formal-design/examples/task-lifecycle/workflow.md).

### Lean verification

Lean covers high-impact deterministic behavior: permission, policy, eligibility
or configuration composition with a stated invariant; budget, quota, allocation
or ranking arithmetic with a stated conservation, bound or ordering requirement;
a deterministic transformation with a requested general correctness property; or
an explicit Lean request. Event ordering, retries and recovery stay on the TLA+
path; selection `both` adds a reviewed bridge.

Lean is not bundled. Provision the pinned `leanprover/lean4:v4.35.0` archive
once on Linux x86-64 or macOS arm64:

```sh
node skills/formal-design/scripts/lean-provision.mjs --dest <root>
```

The helper verifies the SHA-256 in `scripts/lean-toolchain.json`, extracts the
archive and writes a receipt. Checks resolve the root from `--lean-root`, then
`FORMAL_DESIGN_LEAN_ROOT`; a missing or mismatched installation blocks. No
startup or check-time download occurs.

The Lean commands are `lean-preflight.mjs`, `lean-check.mjs`,
`lean-check-conformance.mjs` and `lean-check-evidence.mjs --stage
proof|acceptance`; `check-combined-evidence.mjs` audits both backends. Proofs
are checked for declaration kind, an exactly matching proposition and an allowed
axiom set (`propext`, `Classical.choice`, `Quot.sound`). Conformance runs the
Lean reference and the project implementation over a committed finite corpus.
Limits: a deterministic pure function with JSON boundaries, bounded file and
corpus sizes, no Mathlib, no Lake or third-party packages, and no
TypeScript-to-Lean translation〔src:ws:docs/plans/2026-10-26-formal-design-lean-verification.md#L51-L55〕.

A Lean result means the listed propositions were kernel-checked under the
recorded definitions, assumptions and allowed axioms, and the implementation
matched the reference on the recorded corpus. It does not prove arbitrary
TypeScript code equivalent to the model, nor whole-program or deployment〔src:ws:docs/plans/2026-10-26-formal-design-lean-verification.md#L903-L911〕
correctness. See the [Lean modeling guide](skills/formal-design/references/lean-modeling-guide.md),
[conformance guide](skills/formal-design/references/lean-conformance.md) and
[combined models](skills/formal-design/references/combined-models.md).

Every configured case must verify, including expansion cases. Fresh valid
evidence alone does not mean the model passed; check its verification field.
Complete coverage and the existing review approvals are separate conditions.
Reviewers need the full same-run model inputs and both logs for every case.
These checks establish no correctness claim beyond the specified model,
parameters, properties and assumptions.

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
3. Read sources. Then register source excerpts without changes with `evidence.register`.
4. Record actual searches with `evidence.search_log`.
5. Build claims, evidence groups, and arguments through `argument.update`.
6. Bind the bound body through `argument.update`.
7. Run `argument.review` with `input.stage: "all"`.
8. Wait for the host job and inspect the findings.
9. Make approved repairs within the frozen budget. Bind changed material again. Then review it.
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

## VWA batch

Use `vwa-batch` when the user gives one instruction plus a page list and wants
the loop run to a ledger without per-page interaction: a project per page,
review, a frozen evaluation, one fix-and-report commit, push, PR, CI, then the
ledger in `docs/vwa-reports/batch-<batchId>.md`.

The driver is the agent. There is no runner and no daemon. The batch directory
`.dsh/vwa/batches/<batchId>/` holds the manifest, the grant descriptor and the
state file, and a resumed session recomputes every checkpoint from disk evidence
instead of trusting the state cache.

The one user action is `/permissions grant .dsh/vwa/batches/<batchId>/grant-descriptor.json`.
That command comes from the task-grant chain, delivered separately. Until it
lands, the batch aborts at the grant checkpoint; the contract is the same either
way.

See the [skill](skills/vwa-batch/SKILL.md), [state contract](skills/vwa-batch/references/state-contract.md)
and [report template](skills/vwa-batch/references/batch-report-template.md).

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
