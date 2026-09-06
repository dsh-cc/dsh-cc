Legacy snapshot of the hand-maintained parity matrix, preserved for one release cycle (see docs/plans/2026-09-03-claude-code-capability-manifest.md Phase 0 step 7). Do not edit.
# Claude Code parity matrix

Single source of truth for how the dsh-cc stack (`@deepseek-ai/dsh-base` +
`cc-bundle-permissions` + `cc-bundle-shell`) covers Claude Code's user-facing
features. Status legend:

- ✅ implemented and mounted
- 🔶 partial (call out what's missing)
- ❌ missing (no design asset yet)
- 🚫 won't port (vendor-bound or out of scope, with reason)

## Mode placement (host plane vs preset plane)

How the stack is split across dsh's planes when CC Mode is the active preset.

**Host plane — globally retained, no visible change for the four built-in modes:**

- `@dsh-cc/tools` (tools-registry fork + deferred capability)
- `@dsh-cc/settings-cascade` and `@dsh-cc/permission-rules`
  (the `cc-permissions` bundle)
- `@dsh-cc/settings-migrations`

**Preset plane — CC mode only:** `tool-search`, `skill-claude-code`,
`cc-shell-glue`, `memory`, `memory-consolidation`, `cc-output-styles`,
`compaction-micro`, `coordinator`, `schedule` (upstream package),
`tool-git-worktree`, `tool-sleep`, `tool-notebook-edit`,
`tool-structured-output`, `hooks-claude-code`, `tool-web-fetch`, and the 21 `command-*` packages.
**Among the `cc-services` group** (isolated realm, `mcpConnections` must be
isolated): `tool-search`, `compaction-micro`, `cc-shell-glue`,
`command-plugin`, `command-mcp`, `cc-model-routes`
(`@dsh-cc/model-aliases`), `tool-task` (`@dsh-cc/subagent-task`),
and `tool-web-fetch` (`@dsh-cc/tool-web-fetch`).

**Not reassigned — the untouched upstream host face:** the `system-prompt`
service, the `subagents` registry, and `tokenMeter` (kept per the existing
dsh-web-app surgery criteria).

## Engine subsystems

| CC subsystem                            | Status    | Where / notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent loop + tool pipeline              | ✅        | `@deepseek-ai/dsh-agent-loop`, `dsh-tools` (this repo's `core/tools` swap adds `reserve()`/`isAdmitted()` for deferred tools). CC↔harness tool-name translation lives in `core/tools/src/cc-names.ts` (`translateToolNames` strict/lenient for `restrict()`-bound lists, `ccToolAliases` for rule/matcher matching, `ccCanonicalToolName` for CC-facing payloads) — agent/skill frontmatter, permission rules, and hook matchers all consume it                                                                            |
| File tools (Read/Edit/Write), Glob/Grep | ✅        | `dsh-tool-fs`, `dsh-tool-fs-search`, `dsh-tool-str-replace-editor`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Bash / PowerShell + background jobs     | ✅        | `dsh-tool-bash`/`dsh-tool-pwsh` + `dsh-jobs` + `dsh-tool-jobs`; CC's `TaskCreate/Output/Stop` naming not aliased                                                                                                                                                                                                                                                                                                                                                                                                           |
| WebSearch                               | ✅        | `dsh-tool-web` + `dsh-web-search-deepseek`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| WebFetch                                | 🔶        | tool is mounted via `@dsh-cc/tool-web-fetch` (optional `prompt` summarized on `resolve('haiku')` when configured; otherwise raw converted text + notice). **No fetch provider is shipped** through 0.1.1-rc.2 (`WEB_PROVIDER_UNAVAILABLE` at execute until a deployment mounts one). No host allowlist; enable only on egress-restricted deployments. Upstream SSRF allowlist remains a follow-up.                                                                                                                                                                                                                                                                                          |
| Subagents / Agent tool / teams          | 🔶        | `dsh-subagent*` providers + `tool-subagent-control` (`send_message`/`interrupt`/`list_agents`); CC `.claude/agents` now really dispatched via `@dsh-cc/subagent-task` (CC `Task`, tool row `tool-task`) — `subagent_type` dispatch over per-workspace `.claude/agents` definitions: persona = definition systemPrompt, task text = child's first user message, model alias routed through the `ccModelRoutes` service, sanitized toolFilter, `maxDepth` 3; an `Available subagents` system-prompt section lists the options; CC-mode additionally ships **bundled `explore` and `dsh-cc-guide` agents** (`model: haiku`, read-only Read/Glob/Grep allow-list, `source: 'bundled'`, lowest rank) that a `.claude/agents` file of the same name shadows. **Background/continuable loop:** `run_in_background: true` starts the child as a durable continuable agent on the `spawn` provider (same definition folding as foreground: persona, sanitized toolFilter, alias-resolved agentOptions, `maxDepth` 3) and returns promptly with a durable `agentId` once the child accepts its first turn; the child's `report` or the runtime's finish notice wakes the parent, and `send_message` / `interrupt_agent` / `list_agents` address the child by that id (only the child's exact live direct parent may continue it). Omitting `run_in_background` stays foreground unless the definition pins `background: true` (explicit `run_in_background` always wins — true or false alike); the prompt teaches the Claude Code human heuristic (need-this-turn → omit, human can keep talking → background). Task now consumes the already-parsed `background` pin (Claude Code documents the same field). Still a deliberate deviation from Claude Code interactive omit=background. **Deliberate deviations from CC:** `fork` + background is rejected with an error naming upstream harness issue #2124 (fork stays foreground one-shot); there is **no `TaskOutput` alias and no `outputFile` field** — collection flows through the report wake / `list_agents` / `send_message`, and the child's persisted session transcript is inspectable via existing session tooling; **cold resume restores `persona`/`toolFilter`/model route from the persisted descriptor but drops every other `agentOptions` field** (alias-stamped `reasoningEffort`, `maxTokens`) in favor of the resumed route's defaults; **exiting the parent session drains children's in-flight turns** (their persisted Sessions survive and cold-resume on the next `send_message` from the resumed parent); bundled cheap agents (`explore`, `dsh-cc-guide`) **may** run in the background — CC's "built-ins return no agent id" restriction is not mirrored, since background-vs-foreground is the caller's choice and the continuable machinery is uniform. Other known limits: Task children **spawn fresh** (no parent conversation; pass `subagent_type: "fork"` to inherit completed parent turns, matching CC), every Task child **skips the workspace CLAUDE.md/AGENTS.md baseline** (the harness `agent-instructions` user message) so its persona stays the agent file — an intentional deviation from CC, whose custom subagents load CLAUDE.md (fork children still inherit any CLAUDE.md already in the parent seed), **no seam plugin-agent dispatch** (`subagent_type` only addresses file definitions), and discovery is a **process-level cache** — editing `.claude/agents` needs a restart (mtime invalidation pending). Unknown `subagent_type` errors with the available list. MCP deferral interacts with children: a default spawn inherits the parent's deferred MCP reservations; a named child's sanitized `toolFilter` keeps mounted `mcp__*` public names (and `mcp__<server>` / `mcp__<server>__*` wildcards), auto-includes `ToolSearch` when that name is restrictable, and treats an emptied allow-list as deny-all. The harness `tool-subagent`/`tool-subagent-fork` rows are disabled in the cc preset in favour of `tool-task` (the disabled `tool-subagent-fork` row's `backgroundMode: continuable` config is inert while disabled).                                                          |
| Coordinator mode                        | ✅        | `subagent/coordinator` (`DSH_COORDINATOR_MODE=1`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Workflow / Ralph loop                   | ✅        | `dsh-tool-workflow`, `dsh-tool-ralph` (base)                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Plan mode                               | ✅        | `dsh-plan-mode` (base), incl. `/plan`; Shift+Tab and `/permissions plan` switch through the `/plan` command channel (see docs/plan-mode-command-channel.md)
| Todo list                               | 🔶        | `dsh-tool-todo` (base) is model-facing; the TUI now renders the session todo list in a modal Ctrl+T panel, but human-facing `/tasks` still lists jobs only — the `/tasks` todo seam remains pending                                                                                                                                                                                                                                                                                                                         |
| Auto-compaction                         | ✅        | `dsh-compaction-basic` + `command-compact` (`/compact`) + tool-result pruner; this repo adds model-free `compaction-micro`                                                                                                                                                                                                                                                                                                                                                                                                 |
| Session persistence / resume / fork     | ✅ engine | jsonl/sqlite + projection + checkpoint policy; see command-surface row for `/resume` `/branch` limits. Titles: first-prompt titles generate through the host-plane `session-title-llm-cc` provider (`compat/session-title-provider`) — the auxiliary route stamps the `haiku` cheap lane when configured, else inherits the logged main route (explicit `provider`+`model` config wins); `/rename <title>` pins a user title via `interaction/command-rename` |
| Skills system                           | ✅        | `skill-claude-code` loader + base `tool-skill`; CC `paths` conditional activation ✅; bundled skills subset (debug/simplify/batch) ✅ — CC's `verify`/`stuck` not ported (ant-only, `verify` companion files absent). TUI `/name` routing ✅: user-invocable skills appear in the `/` menu and an unmatched `/name` submits as a user prompt so `dsh-tool-skill` injects at pre-step (skills are not `/help` entries; `/` autocomplete and `/skills` are the discovery surfaces) |
| Plugin system                           | ✅        | `cc-plugin-loader` (agents/commands/hooks/mcp servers/skill/settings from `.claude-plugin/plugin.json` or top-level `plugin.json`) + cc-shell-glue discovery: default is `enabledPlugins` ∩ `installed_plugins.json` (`name@marketplace` + `installPath`); explicit `pluginDirs` still flattens. Marketplace-root overlays replace default `skills/`. Project-scope enablement is boot-cwd-biased. |
| Model aliases                           | ✅        | `compat/cc-model-aliases` (`@dsh-cc/model-aliases`) — `model:` frontmatter aliases (`sonnet`/`opus`/`haiku`/`fable` plus dsh-cc lanes `sketch`/`draft`/`blueprint`/`masterplan`/`architect` + open set) resolve to `{provider, model, reasoningEffort?}` routes (object form may stamp an opaque effort onto the child; string form cannot); `inherit` and unconfigured-builtin aliases inherit the parent route (fixes the old `inherit` pass-through bug); settings `model-aliases` overlay + config `modelAliases` defaults, null-delete, builtin fallback; shared **`toAgentOptions`** drops undefined route fields (per-field inheritance) and the cheap background lane **is** `resolve('haiku')` (no second alias). Now shipped as the **`ccModelRoutes` service** (cc preset row `cc-model-routes`) owning the `model-aliases` namespace; cc-shell `AgentProvider` and the Task tool consume it lazily via `ctx.get('ccModelRoutes')`. Follow-ups: `/model` command, `ANTHROPIC_*` env vars (no Anthropic semantics), and aliasing the main-session default model |
| Output styles | ✅ | `compat/cc-output-styles` + `/output-style` |
| Settings precedence | ✅ | `settings-cascade` (user/project/local/flags) |
| Settings migrations | ✅ | `settings/settings-migrations` (`@dsh-cc/settings-migrations`) — version-gated `runMigrations` over an atomically-written settings.json, auto-run on mount; mechanism only (no real migrations yet) |
| Permission rules | ✅ | rule engine + dangerous-command/path risk classifier. Modes are **durable**: `permission/mode` session events (registered into `KNOWN_SESSION_EVENT_TYPES` at plugin load so persistence resumes them); `/permissions <mode>` switches `default\|acceptEdits\|plan\|auto\|bypassPermissions`; the bare `/permissions` opens a picker of those five modes (`bypassPermissions` with the same risk gate as host `/permission` Full access) — browser via popupSelect, TUI via an overlay that submits `/permissions ${id}` through the host command; plan non-read-only calls deny with `exit_plan_mode` guidance; auto auto-allows classifier-LOW asks and still prompts on MEDIUM; entering bypassPermissions pins `danger-full-access` and records `resumeSandbox` for restore. The TUI approval modal's always-allow answer (`3`/`a`) persists a derived rule into the settings allow list — a trailing-space first-word prefix for shell commands (`Bash(npm )` matches `npm install …`, never `npmx …`), a whole-tool rule otherwise — merging via describe → merge → replace with one revision-conflict retry. Remaining vs CC: ML/bash risk classifier service, managed/enterprise remote settings, UI mode cycle |
| Hooks | 🔶 | 18 of 30 events bridged (see table below); `command`+`http` executors always on, `prompt`/`agent` executors behind `enablePromptHooks`/`enableAgentHooks` (default off); those forks resolve their `model:` through `ccModelRoutes` (omitted `model` → the `haiku` cheap lane) and the `memory` + `hooks-claude-code` rows live inside the `cc-services` isolate group so the service is visible |
| MCP client | ✅ | tools + resources + prompts + OAuth 2.1. Tools are deferred through ToolSearch when a server lists at least the per-server threshold (default 8; counts `tools/list` including alwaysLoad tools) — deferred tools stay out of the model-visible schema until a ToolSearch hit activates them; `_meta['anthropic/alwaysLoad']` tools stay eager; the resource bridge stays eager; no `toolSearch` seam ⇒ eager fallback. A generation swap (reconnect / `tools/list_changed`) unloads previously activated tools. |
| Memory / CLAUDE.md | ✅ | `memory` + `memory-consolidation` (AutoDream analog); per-repository isolation mirroring CC auto memory (derived from the git repo so worktrees and subdirectories share one store at `<memoryHome>/projects/<slug>/`, slug = dash-encoding of the canonical git root, not the raw cwd) plus a shared global layer at the home root (`memory_save` `scope`); `memory_save` tool is the save channel (the memdirs sit outside the session sandbox, so direct Write is fenced; forks report structured output and the plugins write host-side under a memdir-confined per-call policy); recall suppresses reference-doc memories for recently used tools; opt-in `teamEnabled` shared team memory (`<workspaceDir>/team`, also collapsed onto the repo) with a seam-native symlink/containment validation chain |
| Cost / token tracking | ✅ | `token-meter` (base) + `/cost`; the TUI `/usage` panel renders live context occupancy, token totals (cache rows only when non-zero), and a system/tools/messages breakdown, each section degrading independently when its projection is missing; CC quota/limit surfaces are vendor-billing-bound 🚫 (the panel footnotes quota as unavailable) |
| Schedule / reminders | 🔶 | `@deepseek-ai/dsh-schedule` mounted: `after_seconds` / `at` / `every_seconds` (≥300s). CC's cron-expression selectors unsupported — upstream extension planned |
| Worktree tools | ✅ | `EnterWorktree`/`ExitWorktree` |
| Sleep tool | ✅ | `tool-sleep` (`@dsh-cc/tool-sleep`) — `Sleep` with cooperative interrupt-cancel and concurrency-safe semantics aligned to CC's SleepTool |
| StructuredOutput (synthetic output tool) | ✅ | `core/tool-structured-output` (`@dsh-cc/tool-structured-output`) — `StructuredOutput` validates the model's final output against a caller-supplied JSON schema and echoes it back, aligned to CC's SyntheticOutputTool; registered only when a schema is declared |
| NotebookEdit | ✅ | `core/tool-notebook-edit` (`@dsh-cc/tool-notebook-edit`) — `NotebookEdit` edits Jupyter notebook (.ipynb) cells over the `ctx.fs` seam with CC's replace/insert/delete, real-id + `cell-<n>` addressing, and a read-before-write gate on `fs/observed` |
| AskUserQuestion | ✅ | mounted via `dsh-user-questions` + `dsh-tool-ask-user` (harness 包，工具名 `ask_user_question`；UI provider 归宿主 app，无 provider 时优雅报错). The TUI registers a modal provider; questions and approvals share one FIFO so a question arriving mid-approval queues instead of stacking an unreachable second box |
| ToolSearch (deferred tools) | ✅ | `core/tool-search`; mcp-client is now a production caller (deferred MCP tools above the per-server threshold) |
| Sandbox | ✅ | `dsh-sandbox-local` + policy (base) |
| Credentials | ✅ | `dsh-credentials-local` (base) |
| Notifications (bell/OS/iterm) | ❌ | no notification seam in deepseek-harness; needs a new design |
| Vim mode / keybindings / statusline / ghost text | 🔶 | `dsh --profile tui` (`@dsh-cc/bundle-tui`) is the terminal surface. Keybindings: Shift+Tab cycles CC permission modes, Esc interrupts (and closes/cancels overlays), idle Ctrl+C exits on a double press, Ctrl+S injects the queued outbox into the running turn, Ctrl+T toggles the todo panel, Ctrl+O toggles global collapse of thinking + tool output, ↑ recalls queued messages, and Tab completes `/model`/`/effort`/`/permissions`/`/resume` arguments; slash catalog via `ctx.commands`. Bare `/permissions` opens the TUI permission-mode picker (argued `/permissions <mode>` still switches directly). Approval prompts render a preview (shell command / per-file diff / pretty-printed args) and answer `1`/`y` once, `2`/`n` reject, `3`/`a` always-allow (persists a permission rule — see the Permission rules row); approvals and ask-user questions share one modal FIFO (`Approval (1 of N)`), including subagent approvals. A leading `!` runs a local shell command (warning border, separate `bash-history.txt`, output shown as status rows that never reach the model or the session log). TUI-local commands: `/export-md [path]` (Markdown transcript, default under `$DSH_HOME/tui/exports/`), `/copy` (OSC 52 clipboard, most recent assistant reply), `/usage` (live context bar + token buckets + breakdown panel; quota has no source and is never shown). The `theme` config block recolors six roles (accent/success/error/warning/muted/highlight) via ANSI color names or raw SGR codes. The statusline renders exact context occupancy (`ctx NN% (used/window)`), and transcript rendering covers multi-hunk diffs with gutter numbers plus consecutive-read collapse. Vim / ghost text still later |
| IDE integration / LSP | 🔶 | Two paths. **Production: Serena MCP** — user-scope `~/.claude.json` (v1.7.0 pin, `--context claude-code --project-from-cwd`): symbol-level retrieval (`find_symbol`, `get_symbols_overview`, `find_referencing_symbols`, `find_implementations`), symbol-level editing (`replace_symbol_body`, `rename_symbol`, `safe_delete_symbol`, `insert_before/after_symbol`, `replace_content`, `replace_in_files`), pull diagnostics (`get_diagnostics_for_file`); ~30 tools deferred through ToolSearch (per-server threshold 8). Gaps vs CC: no hover tool, no call hierarchy, no push diagnostics. **Native: `dsh-lsp`/`dsh-lsp-stdio`/`dsh-tool-lsp`** — packages exist with a closed 4-operation read-only seam (goToDefinition/findReferences/goToImplementation/hover) but are **not mounted by any shipped composition** (`cordis.patch.yml`/`agent.cordis.yml` have no lsp rows; only `packages/bundle/cc-shell/tests/lsp-bundle.spec.ts` mounts them). cc-plugin-loader gap: `lspServers`/`.lsp.json` manifests are not parsed, so CC code-intelligence plugins have no effect. PreToolUse hooks ignore `additionalContext`, bounding hook-based pre-tool shaping. `/ide` 与 editor pods 属交互壳范畴，headless 仍不适用 |
| Remote / web sessions | 🔶 different | CC `bridge/` is claude.ai-bound 🚫; dsh has its own web/host/sdk/acp stack outside this repo |
| Voice | 🚫 | vendor feature, no design asset |
| Buddy / KAIROS / undercover / ultraplan / computer-use | 🚫 | Anthropic-internal or vendor-bound |
| Onboarding / tips | ❌ | no package or design doc |

## Hook events (18 of 30 bridged)

Supported now: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`,
`PermissionRequest`, `PermissionDenied`, `Notification` (`permission_prompt`
subtype only), `PostCompact`, `SessionEnd`, `StopFailure`, `TaskCreated`,
`TeammateIdle`, `Setup` (first-run approximation), `SessionResume` (`resume`
source only).

Not bridged (with reason):

- `PreCompact` — needs an upstream compaction waterfall seam (planned).
- `Notification` subtypes `idle_prompt` / `auth_success` / `elicitation*` — no
  equivalent seam in a headless harness (cannot map).
- `UserPromptCancel` — no dsh cancel seam; the bridge does not do a lossy
  approximation (not bridged by design).
- `SessionResume` `clear`/`compact` sources — no dsh emit point (pending; only
  `resume` is bridged).
- The remaining CC event×source payload variants — tracked as hook-bridge
  follow-ups in the package README.

Executors: `command`, `http` (SSRF-allowlisted via `allowedHttpHookUrls`),
`prompt`, `agent` (forked subagent; gated by `enablePromptHooks` /
`enableAgentHooks`, default **off**).

## Command surface (/…)

Mounted CC-parity commands (21): `/cost`, `/doctor`, `/export`, `/stats`,
`/status`, `/output-style`, `/memory`, `/skills`, `/help`, `/config`,
`/permissions [mode]` (bare invocation opens a picker of the five CC
rule-engine modes — default/acceptEdits/plan/auto/bypassPermissions, with
bypassPermissions carrying the same risk gate as host `/permission` Full
access; a CC session's slash catalog hides host `/permission` so only
`/permissions` appears — the composer chip still drives sandbox presets
through `/permission <preset>`. The popupSelect browser half is a
host-plane `dsh.client` row on the cc-permissions bundle, because
preset rows never appear in `ctx.loader.entries()` and would not be
discovered otherwise; the TUI intercepts the same bare invocation and
opens an overlay that submits `/permissions ${id}` through the host
command), `/version`,
`/release-notes`, `/diff`, `/init`,
`/plugin`, `/reload-plugins`, `/mcp`, `/tasks`, `/rename <title>`, plus base `plan-mode`'s `/plan`.

Degraded by design (documented):

- `/resume` — lists sessions; switching is host-owned (`dsh --resume <id>`).
- `/branch` — forks and reports the child id; switching requires restart.
- `/config` — text-only render/patch with an allowlisted key set.
- `/init` — drives a follow-up turn that writes/refreshes `CLAUDE.md`.

TUI-local: `/clear` `/new` `/reset` start a new empty session in-process; the previous session stays on disk and is `/resume`-able. Excluded: `/model`, `/exit` (host-owned), `/copy` (preset-side has no
clipboard seam; the TUI surface now ships a local `/copy` over OSC 52 — see the
keybindings row above),
`/rewind` (needs checkpoint/file-snapshot design — deferred), billing/login
commands (🚫 vendor-bound).

## Deferred upstream items

1. Upstream catalog pin of `permission/mode` — the plugin registers the type
   into `KNOWN_SESSION_EVENT_TYPES` at load (a runtime `Set.add`), which already
   unblocks resume in this process; bumping the harness's own compiled catalog is
   an upstream polish, not a blocker.
2. SSRF host allowlist for `web-fetch-http` (then un-caveat WebFetch).
3. Cron-expression selector for `dsh-schedule` (then full `ScheduleCronTool`
   parity).
4. `PreCompact` interception seam in `dsh-compaction`.
5. Human-facing todo-list seam for `/tasks`.
6. Memory freshness — CC threads `mtimeMs` through recall and ages memories
   (`memoryAge`). Both depend on the harness `FsInfo` carrying mtime; the
   current `dsh-fs` seam does not expose it, so mtime tracking and `memoryAge`
   are deferred until the seam grows an mtime field (see the Memory row above
   and the `memory` package README Known Limitations).
