# @dsh-cc/permission-rules

English | [中文](README.zh.md)

Claude Code-compatible permission-rule engine. Parses `ToolName` and `ToolName(content)` rules, folds a mode-aware decision on the `tools/pre-execute` waterfall, and enforces bypass-immune content rules through the monotonic `guard()` layer so neither a mode switch nor `bypassPermissions` can override them. Rules fail loud at load; settings hot-reload by rebuilding merged state and re-registering guards.

## Rule syntax

A rule is `ToolName` (whole tool) or `ToolName(content)` (content-scoped). `content` may escape `(`/`)`/`\` with a backslash, use `*` as a wildcard, or end in `:*` to declare a prefix rule.

| Rule | Meaning |
|---|---|
| `Bash` | whole-tool rule for every `Bash` call |
| `Bash(npm install)` | prefix rule: any command starting with `npm install` |
| `Bash(npm publish:*)` | prefix rule on the stem `npm publish:` |
| `Edit(foo/*.json)` | wildcard: commands/paths matching `foo/*.json` (a `*` matches any run) |
| `Bash(python -c "print\(1\)")` | literal parens inside content |

Malformed rules (unclosed paren, content after the closing paren, content with no tool name) throw a `TypeError` at load — fail loud. `escapeRuleContent`/`unescapeRuleContent` round-trip content safely (`\` first, then parens).

## Evaluation order

The plugin registers a `tools/pre-execute` listener and folds one decision per call:

1. **Bypass-immune** content rules (e.g. `.git` internals, shell-config paths) always deny — registered as monotonic **guards**, never overridable by a mode switch or `bypassPermissions`.
2. **Risk classifier** (when `classifierEnabled`, default on), three tiers for bash commands: **HIGH** catastrophic shell commands (`rm -rf /`/`~`, `sudo`, `dd of=/dev`, `kill -9 1`, piping curl/wget into sh, redirecting into system paths) hard-**deny in every mode**; **MEDIUM** destructive-but-not-catastrophic commands (`git push --force`, `git reset --hard`, `git clean -f`, `rm -rf` on ordinary targets, `npm|pnpm|yarn publish`, `gh repo|release delete`, `docker rm -f`/`system prune`/`volume rm|prune`, `kubectl delete`, `helm uninstall`, `terraform apply|destroy`) fall through to the waterfall and **ask** afterwards unless a rule or session grant already allowed; writes to protected files (`.bashrc`, `.ssh/**`, credentials) are HIGH denies; writes that escape the working directory scope are **ask** outside `bypassPermissions` (allowed under it).
3. **whole-tool deny** → deny.
4. **content deny** (all sources) → deny — deny-first ordering (D2): a content deny beats any content allow and any whole-tool ask, in every mode.
5. **whole-tool ask** → ask (a sandboxed, confining `Bash` is exempt and allowed instead when `exemptSandboxedBashFromToolAsk` is set).
6. **content ask**, then **content allow**, by source priority (behavior outer, sources inner; declaration order preserved within behavior+source).
7. **mode** short-circuits: `bypassPermissions` allows everything (unless `disableBypassPermissionsMode`); `acceptEdits` auto-allows file-edit tools; `plan` auto-allows read-only tools. `auto` is not an evaluate short-circuit — it evaluates like `default` but with broad allow rules suspended (see below).
8. **whole-tool allow** is the coarse default for that tool when nothing more specific matched.
9. **no match** → passthrough to downstream listeners (ultimately the approval seam), which may still `ask`.
10. **plan wrap**: leftover `ask`/`passthrough` on a non-read-only call becomes a deny with `plan mode is read-only; submit via exit_plan_mode`. Matching allow/deny rules still stand.

## Config

```ts
import PermissionRules from '@dsh-cc/permission-rules'

await ctx.plugin(PermissionRules, {
  rules: {
    deny: ['Bash(rm -rf)', 'Edit(.git*)'],
    bypassImmune: ['Edit(~/.bashrc)', 'Edit(~/.zshrc)'],
  },
  bashToolName: 'Bash',           // default
  fileEditTools: ['edit'],        // auto-allowed under acceptEdits
  readOnlyTools: ['read'],        // auto-allowed under plan
  exemptSandboxedBashFromToolAsk: false,
  defaultMode: 'default',
  classifierEnabled: true,        // risk-classifier escalation stage
})
```

All fields are optional; the service schema applies the illustrated defaults. Rule strings are parsed with source `config`.

## Settings and hot reload

When `ctx.settings` is mounted, the plugin registers the `permissions` namespace (`permissions.allow` / `permissions.deny` / `permissions.ask` / `permissions.defaultMode`, plus `additionalDirectories` / `protectedFiles` / `dangerousPatterns` / `mediumPatterns` feeding the risk classifier (`mediumPatterns` replaces the curated MEDIUM tier, replace semantics like `dangerousPatterns`), and the optional `autoMode` section — `autoMode.soft_deny` prose rules (with `$defaults` expansion), `autoMode.classifyAllShell` (suspend EVERY bash/PowerShell allow rule in auto mode), and `autoMode.classifier` (`enabled` / `route` / `timeoutMs` / `cacheMaxEntries`) arming the opt-in LLM risk-classifier stage for `auto` mode; an absent `autoMode` key stays absent, so the stage remains disarmed). Settings rules carry the `settingsSource` label (default `userSettings`) and merge with Config `rules` by source priority — settings rules win. A stored change re-runs the merge and re-registers guards immediately (hot reload); a malformed settings rule fails loud at the settings boundary. When `ctx.settings` is absent, only the Config `rules` are in force (the classifier uses its curated defaults).

## Sources and modes

Every rule carries a `PermissionRuleSource` (`session` > `cliArg` > `policySettings` > `flagSettings` > `localSettings` > `projectSettings` > `userSettings` > `config`) used for content-rule priority. The engine resolves the effective mode at call time: plan activation (from `@deepseek-ai/dsh-plan-mode`) overlays first, then the session's recorded `permission/mode` override (`foldPermissionMode`), falling back to `defaultMode`.

Modes are **durable** — `setMode(agent, mode)` appends a last-wins `permission/mode` session event (registered into `KNOWN_SESSION_EVENT_TYPES` at plugin load so persistence resumes it). `plan` is owned by plan-mode and throws here. Entering `bypassPermissions` pins the session sandbox to `danger-full-access` and records `resumeSandbox`; leaving restores the recorded (or `workspace-write` fallback) confinement. Under `auto` the engine is **strict-rule** (design doc D3/D11): the legacy LOW+ask→allow proxy is removed, so a matched ask rule PROMPTS even at LOW risk; broad allow rules are suspended at evaluation time (`filterAutoAllowRules`) — whole-tool bash/PowerShell allows, effectively-blanket bash content allows, interpreter and package-runner prefixes (`python`, `node`, `npm run`, `npx`, …), and any `Task`/`Agent`/`subagent`/`subagent_fork` allow; `autoMode.classifyAllShell: true` suspends every bash and PowerShell allow rule. `/permissions` lists suspended rules with a "suspended in auto mode" annotation, and `effectiveRuleSet(mode)` is the single seam for any preview consumer. "Allow for this session" grants now apply to rule-derived asks in every non-plan mode (grant-on-ask, D2). When the LLM classifier stage is armed, read-only tool calls are exempt — they never reach the model (zero added latency on read traffic). Verdict parsing is strict and fail-closed: a malformed model output yields the constant reason `classifier output unparseable` (model output is never shown; audit records are digest-only). A per-route consecutive-failure circuit breaker (threshold 3, keyed `provider/model`) opens the stage for a failing lane — no further classifier calls on that route, one warn per process, one `breaker` audit event per session; `rebuild()` (a settings change) resets the breaker state and re-arms.

## Switching modes

`permissionRules.setMode(agent, mode)` switches durably (see above); the `/permissions <mode>` command (in `@dsh-cc/command-permissions`) drives it for `default | acceptEdits | plan | auto | bypassPermissions`. A human-facing notice is injected into the session's model transcript on each switch.

## Pure exports for host UI

- `parseRuleString(rule)`, `parseRule(rule, behavior, source)`, `escapeRuleContent`/`unescapeRuleContent` — parse rules to `PermissionRule`.
- `evaluatePermission(input)` — fold a `PermissionDecision` for a call (`allow` / `deny` / `ask` / `passthrough`) given tool, subject, rule set, mode, and exemption flags. Use it to preview what a rule hits without mounting the plugin.
- `mergeRuleSets(...sets)` — merge rule sets by source priority.
- `foldPermissionMode(events)`, `foldResumeSandbox(events)`, `setPermissionMode(session, mode, resumeSandbox?)` — read/write the durable `permission/mode` override. `setPermissionMode` rejects `plan` and unknown modes; other plugins can fold a session's recorded mode via `foldPermissionMode`.
- `assessBashCommand(command, patterns?, mediumPatterns?)` — risk-classify a shell command (`LOW`/`MEDIUM`/`HIGH`).
- `assessFilePath(filePath, opts)` — risk-classify a file write (`LOW`/`MEDIUM`/`HIGH`).
- `PERMISSION_MODES`, `SOURCE_PRIORITY` — closed vocabularies.

Rule parsing and evaluation are browser-safe (pure string logic), so the type/parser/evaluate modules import cleanly into UI previews.

## Invariant companion

`@dsh-cc/permission-rules/invariant` validates `permission/mode` session events at the session boundary: `mode` must be switchable (never `plan`), and `resumeSandbox` — when present — must be a known sandbox mode (`read-only` | `workspace-write` | `danger-full-access`).

See the [Agent Note](../../../.agents/notes/implemented/feature/2026-08-14-cc-permission-rules.md).
