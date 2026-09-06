# @dsh-cc/hooks-claude-code

English | [中文](README.zh.md)

A cordis plugin that runs the supported command-hook subset of a user's existing **Claude Code** hook config (a `hooks.json`, or a settings file's `hooks` key) on the harness's canonical interception points. It is the **CC dialect** half of the hooks subsystem: it owns the bridge's CC-shaped per-event stdin payloads, CC's env + `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` substitution, and the mapping from a hook's neutral outcome onto the harness's typed Decisions. The dialect-agnostic primitives (matcher, exit-code/stdout codec, `ctx.shell` execution, most-restrictive merge, the `hook/*` events) come from [`@dsh-cc/hook-protocol`](../hook-protocol/README.md).

A native cordis plugin could do everything this bridge does — more powerfully, with typed returns and no serialization boundary. **The bridge exists only as a compatibility path for the mapped CC command-hook subset**; anything bespoke should be a native plugin on the same extension points (see [the interception extension-points Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md)).

## Config

```ts
import type { Config } from '@dsh-cc/hooks-claude-code'
const config: Config = {
  configPath: '/path/to/hooks.json', // required: a hooks.json or a settings file with a `hooks` key
  pluginRoot: '/path/to/plugin',     // optional: replaces ${CLAUDE_PLUGIN_ROOT} in command strings
  projectDir: '/path/to/project',    // optional: replaces ${CLAUDE_PROJECT_DIR} AND sets the hook env var; defaults to the session cwd when omitted
  defaultTimeoutMs: 600_000,         // optional: per-hook timeout when a hook sets none (CC default)
  stderrSummaryMaxChars: 500,        // optional: char cap on the hook/result event's persisted stderr summary
  allowedHttpHookUrls: ['https://hooks.example.com/*'], // optional: URL allowlist for http hooks (absent/empty = unrestricted)
  httpAllowedEnvVars: ['MY_TOKEN'],  // optional: env names allowed to interpolate into http hook header values
  enablePromptHooks: false,          // optional: run `prompt` hooks by forking a small-model subagent (default off)
  enableAgentHooks: false,           // optional: run `agent` hooks by forking a verification subagent (default off)
}
```

In a `cordis.yml`:

```yaml
- dsh-hooks-claude-code:
    configPath: ./.claude/hooks.json
    pluginRoot: ./.claude/plugins/my-plugin
    projectDir: .
```

The config is parsed **once** at load. `configPath` is **process-level**: a relative path resolves against the process's launch cwd at load time, so a single config applies to the whole process — there is no per-session (`session/new.cwd`) config discovery yet (`TODO(per-session-hook-config)`). A read/parse failure is contained — including an invalid regex matcher on an event that consumes matchers, reported with its pattern and event — and the bridge logs a warning and registers nothing rather than crashing boot (a typo'd path must not take the agent down). The `command`, `http`, `prompt`, and `agent` executor kinds all run (the latter two only when their enable flags below are set); an unknown handler `type` is skipped with a warning. A hook with no per-hook `timeout` runs under the protocol's reference default (`DEFAULT_HOOK_TIMEOUT_MS` from `dsh-hook-protocol`, 10 minutes — the CC default; a `prompt`/`agent` hook's per-hook `timeout` is not applied to the fork — the parent operation's signal governs).

The hooks **themselves** run in the agent's session workspace: for the agent-scoped points the bridge passes the session's `cwd` (the `session/new.cwd`) as the hook process's working directory, so a hook's `pwd`/relative-path/marker operates in the user's project tree, not the server launch dir.

## Executor kinds

The config parser accepts all four CC executor kinds and the runner dispatches them by `type`:

- **`command`** — the shell executor (through `ctx.shell`), unchanged from before.
- **`http`** — POSTs the hook input JSON to `hook.url`, mapping the HTTP response onto the same exit-code contract as a command hook (a 200 body is parsed as structured stdout, so a 200-with-`permissionDecision:deny` body blocks). Header values interpolate `$VAR`/`${VAR}` names but only those listed in the hook's `allowedEnvVars` (intersected with the `httpAllowedEnvVars` config) — other references become empty strings. `allowedHttpHookUrls` restricts destinations (`*` wildcards; absent/empty = unrestricted).
- **`prompt`** and **`agent`** — fork a one-shot `subagents` subagent: the hook input JSON is embedded in the hook's `prompt` template via `$ARGUMENTS` (appended after a blank line when the template names no placeholder), the fork's text output is parsed for the same structured-output vocabulary as a command hook (`hookSpecificOutput.permissionDecision`, `additionalContext`, `continue`, `stopReason`, `systemMessage`, top-level `approve`/`block`, …), a parse failure is a non-blocking empty output, and a fork `stopReason:'error'` is surfaced as a non-blocking hook error. `model` (when set) resolves through the `ccModelRoutes` alias service and maps onto the fork's `agentOptions`; an omitted `model` defaults to the cheap lane `resolve('haiku')` (the configured haiku alias, or inherit when unconfigured); `model: inherit` / an unconfigured builtin alias / a missing `ccModelRoutes` service all omit `agentOptions` (inherit the parent route). These executors are **off by default**: running them needs `enablePromptHooks: true` / `enableAgentHooks: true`, else the hook is skipped with a warn (the old safe default). A per-hook `timeout` is not applied to the fork — the parent operation's signal governs. They degrade to a warned no-op when no `subagents` service or parent agent is available. Missing fork headroom: the ephemeral subagent re-enters the loop like any Task tool would, so a `prompt`/`agent` hook costs a model request rather than a shell process. In the cc preset this plugin's row lives inside the `cc-services` isolate group so `ccModelRoutes` is visible to the fork's model resolution.

## Hook points → typed Decisions

| CC hook | Harness point | Mapping |
|---|---|---|
| `SessionStart` | `agent/session-start` (emit) | additionalContext → `agent.inject()` into the new session (cannot block) |
| `UserPromptSubmit` | `agent/pre-step` (waterfall) | `deny` → `PreStepDecision.reject`; additionalContext-only → delegate via `next()` then append a separately sourced message to a downstream `enter` decision (a later outer listener can still reject/rewrite) |
| `PreToolUse` | `tools/pre-execute` (waterfall) | `deny` → `PreToolDecision.deny`; `ask` → `PreToolDecision.ask` |
| `PostToolUse` | `tools/post-execute` (waterfall) | `deny` → `block` with feedback; additionalContext-only → delegate via `next()` then prepend a separately sourced context to the downstream decision; Code Mode defers sub-call contexts until the outer `run_code` result |
| `PostToolUseFailure` | `tools/post-execute` on an `isError` result (emit) | observe-only; fires when a tool result is an error, mutually exclusive with `PostToolUse` on a single call; payload carries `tool_name`/`tool_input`/`tool_use_id` + flattened `error` text |
| `Stop` | `agent/turn-stopping` (serial) | a blocking Stop hook feeds its reason through `steer()`, forcing another step |
| `SubagentStart` | `subagent/start` (emit) | additionalContext → `agent.inject()` into a live in-process child; a remote child has no local injection target |
| `SubagentStop` | `subagent/end` (emit) | observe-only |
| `PermissionRequest` | `approval/request` (waterfall) | `deny` → rejects the approval; `allow`/`approve` → pre-approves (`allowed-once`); no decision → delegates to the answerer chain |
| `PermissionDenied` | `session/event` observing `approval/decided {outcome:'rejected'}` (emit) | observe-only |
| `Notification` | `session/event` observing `approval/asked` (emit) | **partial**: only the `permission_prompt` subtype fires; payload `notification_type: 'permission_prompt'` |
| `PostCompact` | `session/event` observing `compaction/end` (emit) | observe-only |
| `SessionEnd` | `session/disposed` (emit) | observe-only; `reason` always `'other'` (not derivable from the seam) |
| `StopFailure` | `agent/error` (emit) | observe-only; maps the error to CC's error-code vocabulary (`rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, else `unknown`) |
| `TaskCreated` | `ctx.jobs` change-diff (emit) | bridge diffs `list()` snapshots, emitting once per newly-appeared job id (unowned/scoped to the change owner) |
| `TeammateIdle` | `agent/status` → `idle` (emit) | observe-only; fires only for agents seen as subagents (a root agent's idle does not fire it) |
| `Setup` | `agent/session-start` `source:'startup'` (emit) | **partial first-run approximation**: emits `source:'init'` only for a brand-new (seeded) session; resume/clear/compact sources do not fire it |
| `SessionResume` | `agent/session-start` `source:'resume'` (emit) | observe-only; fires only on a `resume` source — `clear`/`compact` have no dsh emit point, and `UserPromptCancel` has no dsh seam (both deferred) |

The emit points run detached — no extension point awaits a `SessionStart`/`SubagentStart`/`SubagentStop`/`PermissionDenied`/`Notification`/`PostCompact`/`SessionEnd`/`StopFailure`/`TaskCreated`/`TeammateIdle`/`Setup` hook. `PermissionRequest` is the only interception point in the set and returns its decision synchronously. Each detached run chain is tracked, and disposing the bridge aborts still-running hook processes, then drains the continuations before the dispose resolves (`createDetachedRuns` in `dsh-hook-protocol`).

The matcher subject is the tool name (`PreToolUse`/`PostToolUse`), the session source (`SessionStart`), or a constant `agent_type` of `general-purpose` (`SubagentStart`/`SubagentStop` — the harness subagent seam carries no per-kind label, so the bridge reports Claude Code's own Task-tool default; a default/`*`/empty `agent_type` matcher fires, a specific-kind matcher does not); `UserPromptSubmit`/`Stop` ignore matchers. Multiple file-configured hooks on one point run **serially, in config order**, and fold most-restrictively (`deny > ask > allow`, see `dsh-hook-protocol`); serial keeps each hook's `hook/invoked`/`hook/result` pair adjacent in the log, and the fold is order-independent for the decision (see the Agent Note's "run serially, not concurrently" note).

Every agent-scoped stdin payload carries `session_id` and string-shaped `transcript_path`. The bridge resolves the latter through `ctx.sessionPersistence.locate(session.header)` when available and otherwise sends `''`. Lookup does not create or flush the artifact, so a path can be absent before the first turn-end checkpoint or omit the current open turn.

## Context source

Injected context carries an explicit `{ kind: 'plugin', plugin: 'hooks-claude-code' }` source so the durable message is never mistaken for a user prompt.

## Model Experience

### Hook-provided context

#### What the model sees

`SessionStart`, accepted prompt, post-tool, and live in-process subagent-start hooks can add source-attributed context messages; a blocking `Stop` hook adds its reason as next-step steering. Remote-child injection has no local target.

#### Token effect

No cost when hooks return no context. Hook text is data-dependent, logged, and resent in later conversation requests until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Blocked prompt or tool outcome

#### What the model sees

Provider-supplied reasons pass through verbatim. When absent, a blocked prompt uses exactly `blocked by UserPromptSubmit hook`, a denied tool becomes `Error: blocked by PreToolUse hook`, blocked post-tool feedback is exactly `blocked by PostToolUse hook`, and a blocking stop adds steering exactly `continue: blocked by Stop hook`. `systemMessage` is surfaced as a durable dim notice row in the session transcript (model-visible — see Known Limitations below); `updatedInput` is logged + warned but not honored (still deferred).

#### Token effect

Blocking a prompt removes that prompt's request tokens; denial or feedback adds the retained fallback or provider text; forced continuation pays another full request.

#### KV Cache effect

A blocked prompt sends no request and invalidates nothing. Denial, feedback, and forced-continuation context append after the reusable prefix without rewriting it.

## Known Limitations and Deferred Work

- **Supported hook events (18):** `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`, `PermissionRequest`, `PermissionDenied`, `Notification` (partial — `permission_prompt` subtype only), `PostCompact`, `SessionEnd`, `StopFailure`, `TaskCreated`, `TeammateIdle`, `Setup` (partial — first-run approximation), and `SessionResume` (partial — `resume` source only). **Unsupported (14):** `PreCompact` (needs an upstream `compaction/start` seam), `InstructionsLoaded`, `UserPromptExpansion`, `MessageDisplay`, `PostToolBatch`, `TaskCompleted`, `ConfigChange`, `CwdChanged`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `Elicitation`, `ElicitationResult`, and `UserPromptCancel` (dsh has no cancel seam — the bridge does not do a lossy approximation) — plus the `Notification` idle / `auth_success` / `elicitation` subtypes (headless cannot map them) and `SessionResume`'s `clear`/`compact` sources (no dsh emit point). Config for unsupported events is ignored before group parsing, so an unsupported event cannot invalidate or register hooks. The comparison baseline is Claude Code's [official hook-event reference](https://code.claude.com/docs/en/hooks#hook-events).
- **`SessionStart` is partial:** JSON `additionalContext` is consumed, but plain stdout context, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills`, and `CLAUDE_ENV_FILE` are unsupported. The hook runs detached, so context can miss the first request (`TODO(session-start-gating)`), and the payload omits current optional fields such as `model`, `agent_type`, and `session_title`.
- **`UserPromptSubmit` is partial:** blocking and JSON `additionalContext` work, but plain stdout context, `sessionTitle`, and `suppressOriginalPrompt` are unsupported. Unless overridden, the bridge also uses its 600-second default instead of the event-specific 30-second command timeout Claude Code applies.
- **`PreToolUse` decisions:** `deny`, `ask`, and `allow` work — `allow` pre-approves the call (bypassing the permission prompt); a downstream boundary deny still wins over a hook `allow` (and turns a hook `ask` on the same call into a deny), and runtime integrity guards still re-check `allow`ed calls. `defer` is unsupported. `additionalContext` is injected as post-result context, visible from the next model request (CC attaches it to the tool call itself — an accepted ordering divergence); a `deny` carries the hook reason instead. `updatedInput` is logged + warned but not honored ([the pre-tool-input-rewrite Agent Note](../../../.agents/notes/proposed/feature/2026-06-30-pre-tool-input-rewrite.md)).
- **`PostToolUse`:** blocking feedback, JSON `additionalContext`, and `updatedToolOutput` / `updatedMCPToolOutput` work. Replacement is a content projection: it replaces only the model-facing text of the tool result (`{ kind:'accept', content:[{type:'text', text}] }`), keeps the canonical value, applies only when the downstream decision is a plain accept with no content of its own (downstream/boundaries win), and a `block` decision beats replacement. `updatedMCPToolOutput` applies only to `mcp__*` tool names; mismatched fields are ignored. Non-text tool content (e.g. images) is flattened to text on replacement, and the `tool_response` in the hook payload is flattened to text.
- **`SubagentStart` and `SubagentStop` are partial:** both report a constant `agent_type` of `general-purpose` and use the child session id where Claude Code reports the parent session. Start context is best-effort and can only reach a live in-process child, while stop is observe-only and cannot block the subagent or feed it context. Start omits `transcript_path`; stop also omits `agent_transcript_path`, `last_assistant_message`, `background_tasks`, and `session_crons` and always reports `stop_hook_active: false`.
- **`Stop` is partial:** blocking forces another model turn, with a consecutive-block cap of 8 (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` overrides; `0`/invalid falls back to 8) — past the cap the hook is overridden, the turn ends, and the override is recorded as a `stop-cap` diagnostic. `stop_hook_active` is `true` while the agent is already continuing because of a Stop hook. `last_assistant_message`, `background_tasks`, and `session_crons` are omitted.
- **Common payload and output fields are partial:** mapped event payloads omit `prompt_id`, `transcript_path`, `permission_mode`, and `effort` where Claude Code would provide them. `systemMessage` is surfaced as a durable dim notice row — a degradation vs CC's user-only message: notice-form rows are model-visible (they enter session history), though their plugin source keeps them out of the user row and out of the stop-block counter; empty/whitespace messages render a `(<point> hook message)` fallback label. `{"continue": false}` halts the run via `agent.cancel({kind:'hook'})` — any queued or steering input is discarded (stated in the halt notice); at detached emit points, where no run is in flight, the halt is a logged no-op. `suppressOutput` and `terminalSequence` are not applied; `stopReason` appears only inside the halt notice.
- **Handler support is partial:** shell-form `command` handlers run, and `http` handlers run (with `allowedHttpHookUrls` + intercept-header `allowedEnvVars`). `prompt` and `agent` handlers run only when `enablePromptHooks`/`enableAgentHooks` is set (otherwise skipped with a warn); an unknown handler `type` is skipped with a warning. Command-handler options such as `args`, `async`, `asyncRewake`, `shell`, `if`, `once`, and `statusMessage` are not honored; the `prompt`/`agent` `model` override resolves through `ccModelRoutes` aliases onto the fork's `agentOptions` (omitted `model` → the `haiku` cheap lane; unresolvable → inherit), and a per-hook `timeout` is not applied to the fork. Matching handlers run serially and are not deduplicated, whereas Claude Code runs them in parallel and deduplicates identical handlers. One process-level `configPath` is parsed once at load; Claude Code's layered project, user, plugin, and policy discovery and live reload are not implemented (`TODO(per-session-hook-config)`).
- **New-event payloads are partial:** `PermissionDenied`/`Notification` are driven by the `approval/decided`/`approval/asked` audit records, which carry no tool arguments/inputs, so `tool_input` and `permission_mode` are omitted and `PermissionDenied`'s reason is a fixed approximation. `SessionEnd` always reports `reason: 'other'`. `TaskCreated` reads only the job `id`/`label` (no `statusMessage`/priority fields) and observes no-caller-owned and change-owner-scoped jobs. `Setup` uses `source:'init'` with no `edit_mode`/`cwd` detail, the `TeammateIdle` payload only carries the session base fields, and `StopFailure` maps only the `error`/`error_code` (no `stop_hook_active`, `last_assistant_message`, or `background_tasks`). `PostToolUseFailure` omits the optional `is_interrupt` (not derivable from the seam) and flattens the error text; `SessionResume` carries only the session base fields plus `source`.
- **Hook diagnostics:** hook issues of kinds `timeout`, `exit-code`, `parse-failure`, `spawn-failure`, `stop-cap`, and `config` are appended as JSON lines to `<dsh home>/hooks/diagnostics.jsonl` and are visible in `/doctor` (the last 10 entries plus a count of all recorded issues). The file is a best-effort shared log: concurrent appends across processes may interleave, every filesystem error is swallowed (diagnostics never break a hook run), readers skip torn/malformed lines, and the log is compacted past 256 KB, keeping the newest 100 valid entries.
