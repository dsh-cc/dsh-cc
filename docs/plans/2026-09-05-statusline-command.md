# Custom status line (`statusLine` settings contract, Claude Code parity)

Status: **Implemented** — PR #118 (merged 2026-09-05). Approved post-review (deep-reasoner cold review verdicts incorporated).
Date: 2026-09-05
Scope: Let the dsh-cc TUI (`dsh --profile tui`) execute a user-configured shell command for the bottom status line, honoring the Claude Code `statusLine` settings contract (`statusLine.type = "command"`), while leaving today's built-in HUD untouched when no command is configured.

## 1. Problem and goals

Today dsh-cc renders its own fixed, event-driven HUD status line (cwd, branch, session, mode, model, effort, context occupancy, token counters). Claude Code instead lets the user point `statusLine` in `settings.json` at a shell command whose stdout replaces that line — CC feeds the command a JSON session payload on stdin and reruns it on session events. The capability manifest already records this gap: `ux.statusline` is missing on all dimensions (`docs/claude-code-capabilities.yaml:2028-2049`).

Goals:

1. Parse the CC `statusLine` settings key through the existing five-layer settings cascade, CC file-compatible.
2. When active (`type: "command"` + non-empty `command`), run the command with a CC-shaped JSON payload on stdin and render its stdout as the status line.
3. Match CC execution semantics: trigger points, 300 ms debounce, cancel-in-flight-on-new-trigger, blank-on-failure, ANSI pass-through, `padding`, `refreshInterval`, `COLUMNS`/`LINES` env.
4. Ship zero regression when unconfigured: built-in HUD remains the default and stays event-driven, no polling when no `refreshInterval` is set.
5. Flip the `ux.statusline` capability to recognized/mounted with an honest partially-limited deviation, regenerating parity docs in the same PR.

A deliberate constraint: only fields the dsh-cc runtime can supply **truthfully** go into the JSON payload; the rest are omitted (CC's official example scripts all tolerate missing fields via `// 0`-style fallbacks), and every omission is recorded in the capability manifest.

## 2. Verified ground truth

### Claude Code contract (code.claude.com/docs/en/statusline + /docs/en/settings-reference via context7, and the verbatim `statusline.md` variant, retrieved 2026-09-05)

- **C1 — Configuration.** `statusLine` is a top-level object in user or project `settings.json`: `{ "type": "command", "command": "…" }` plus optional keys:
  - `padding` — "adds extra horizontal spacing (in characters) to the status line content. Defaults to `0` … relative indentation rather than absolute distance from the terminal edge."
  - `refreshInterval` — "re-runs your command every N **seconds** in addition to the event-driven updates. The minimum is `1`. … Leave it unset to run only on events." (Seconds, not milliseconds.)
  - `hideVimModeIndicator` — suppresses the built-in vim-mode display.
- **C2 — Stdin payload.** The command receives one JSON object on stdin. Documented fields: `cwd`, `session_id`, `session_name`, `prompt_id`, `transcript_path`, `model{id, display_name}`, `workspace{current_dir, project_dir, added_dirs, git_worktree, repo{host, owner, name}}`, `version`, `output_style{name}`, `cost{total_cost_usd, total_duration_ms, total_api_duration_ms, total_lines_added, total_lines_removed}`, `context_window{total_input_tokens, total_output_tokens, context_window_size, used_percentage, remaining_percentage, current_usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}}`, `exceeds_200k_tokens`, `fast_mode`, `effort{level}`, `thinking{enabled}`, `rate_limits{five_hour{used_percentage, resets_at}, seven_day{…}}`, plus prompt-cache fields with `expires_at`, `vim{mode}`, `agent{name}`, `pr{…}`, `worktree{name, path, branch, original_cwd, original_branch}`.
- **C3 — Display.** stdout is displayed on the status line; ANSI color codes are supported (every official example embeds SGR escapes). **Multiple output lines are supported: "each `echo` or `print` statement displays as a separate row."** (v1 of this feature renders the first row only — see §6/S6.)
- **C4 — Triggers (verbatim list).** "Your script runs once when a session starts, including when you resume one. After that, it runs again when: a new assistant message arrives; `/compact` finishes; the permission mode changes; Vim mode toggles; **you change the `command` in your `statusLine` settings**; a `refreshInterval` timer elapses, if you set one; a rate-limit window in the data your script last received reaches its `resets_at` time; a warm prompt cache in the data your script last received reaches its `expires_at` time." The last two depend on payload fields we omit (§3.4) and are therefore recorded as skipped-by-construction.
- **C5 — Cadence.** "Updates are debounced at 300 ms; in-flight scripts are canceled if a new update triggers. **A change to the `command` itself skips the debounce: Claude Code runs the new command right away.**" Slow scripts block updates until completion (or cancellation). No timeout is documented.
- **C6 — Terminal env.** "Claude Code sets [the `COLUMNS`/`LINES` environment variables] to the current terminal dimensions before running your script" — width-aware scripts should read them instead of probing the TTY (stdout is captured, not a TTY).
- **C7 — Failure + gating.** From the page's Troubleshooting section (context7 extraction, 2026-09-05; the current `.md` variant no longer carries this paragraph — doc drift noted): "Status line scripts that exit with non-zero codes or produce no output will cause the status line to go blank. Slow scripts block updates until completion and will be cancelled if a new update triggers." Debug mode logs exit codes and stderr. `disableAllHooks` / `allowManagedHooksOnly` "can disable or restrict custom status lines to managed configurations". Windows: use forward slashes; the script must be executable and write to stdout.

### dsh-cc current state (source-verified in this worktree; re-verified by the reviewer)

- **D1 — HUD pipeline.** Fixed formatter `formatStatusLine` (`packages/ui/tui/src/statusline.ts:75`); data assembly in `statusLineOf(width)` (`packages/ui/tui/src/harness/driver-hud.ts:180-195`); driver surfaces `statusLine`/`statusLineIn(width)` (`packages/ui/tui/src/harness/driver.ts:430-431`); rendered as the last dock row (`packages/ui/tui/src/components/root.ts:136`), re-set on every driver emit (`root.ts:454-458` — re-reads `statusLineIn` on EVERY emit; `emit()` notifies listeners unconditionally, `driver.ts:74-77`; same-reference emits are already used at `driver-hud.ts:68`). This is the reactivity channel the async runner settle rides on (see §4/Slice 4).
- **D2 — Updates are event-driven, zero polling.** `createHudSection` (`driver-hud.ts:48`) subscribes to the host `sessionProjections.onChanged` feed (`driver-hud.ts:141-178`), folding `tokenUsage` / `contextPressure` / `todos` / `contextBreakdown` into `state.hud` with dedupe-before-emit. Proven by `packages/ui/tui/tests/no-polling.spec.ts:147`.
- **D3 — Branch probe.** Best-effort async probe per bind/rebind, injectable (`driver-hud.ts:58-71`; seam `state/driver-types.ts:310`).
- **D4 — Settings cascade (BLOCKER found in implementation prep, resolved).** Five layers user → project → local → flag → policy (`packages/settings/settings-cascade/src/index.ts:119-137`). File layout: user `settings.json` under dsh home (`~/.dsh/settings.json`), project `<project>/.claude/settings.json`, local `.claude/settings.local.json` (hoisted to git root), plus `--settings` flag and policy. **The settings-namespace name equals the raw top-level key in the file** (`settings-cascade/tests/cascade.spec.ts:63-78`; `PERMISSION_SETTINGS_NAMESPACE = settingsNamespace('permissions')`, `packages/interaction/permission-rules/src/index.ts:89`). **Constraint discovered at Slice-1 verification: `settingsNamespace` enforces `/^[a-z][a-z0-9-]*$/` and throws at module load on camelCase** (harness `settings/src/index.ts:21-29`; the harness repo is untouchable by directive), and the service resolves sections by exact raw key `document[ns]` — so CC's top-level `"statusLine"` key cannot be a namespace directly. **Resolution (dsh-cc-side, our own package): CC-key aliasing inside the cascade** — after the five-layer merge and before publish (`settings-cascade/src/index.ts:263-271`), recognized CC camelCase top-level keys are aliased onto kebab-case namespaces (`statusLine` → `statusline`); the merge itself is key-agnostic, so cross-layer sub-key merging happens on the CC key *before* aliasing. See Slice 1(b).
- **D5 — Adding a settings key.** Schemastery schema registered via `installSettingsSection(ctx, namespace, schema, defaults, { setSource, onChange })` (`packages/compat/cc-output-styles/src/index.ts:115-130`). Semantics: `setSource` installs the live resolver (fallback first, replaced once the provider injects); `onChange` fires from the provider's `scope.watch` — **only on in-process commits** (harness `settings/src/index.ts:748-768`); the cascade has NO file watcher (`settings-cascade/src/index.ts:168-175` comment), so external edits to `settings.json` mid-session are invisible until next boot. Absent settings provider → tolerated, fallback value stays in force.
- **D6 — Command-spawning seam (CORRECTED after review).** The real dsh-shell executor takes a `ShellExecRequest` with fields `command`, `timeoutMs`, `stdoutMaxBytes`, `stdin`, `signal`, `env`, and **`workdir`** (NOT `cwd`) — harness `packages/shell/shell/src/types.ts:38-44`; `packages/hooks/hook-protocol/src/runner.ts:74-87` passes `stdin` (`JSON.stringify(payload) + '\n'`), `signal`, `env`, `workdir` through `bash.run(bash.resolve(request))`. `resolve` **bakes these into the returned spec**, so the TUI's structural types must be widened on BOTH sides: the request (`state/driver-types.ts:442`) and `ShellExecSpecLike` (`driver-types.ts:425-430`). `ShellRunResultLike` (`:432-439`) has no `aborted` flag: a killed run surfaces as `exitCode: null` → treated as failure → blank line (acceptable, stated). The shell service itself may be ABSENT (`ctx.get('shell')` undefined in degraded profiles, `driver-agent.ts:249`) — feature must then stay inert; do NOT fall back to `driver-bash.ts:33-41`'s `execFileAsync` (no stdin/signal story).
- **D7 — Driver-readable state (reviewer-corrected).** `current.agent.session` → `id`, `header.cwd` (`driver-hud.ts:184-185`); `selection.current` → `model`, `reasoningEffort` (`:186-187`); projections → token totals (`tokenUsage`: cumulative `cacheReadTokens`/`cacheWriteTokens`/`input`/`output` totals, `usage-view.ts:24-25`), context pressure (occupancy %/window), and **`contextBreakdown` which is role counts `{system, tools, messages}` ONLY (`usage-view.ts:132-140`) — NOT token buckets**: CC's `context_window.current_usage.*` has no truthful source and is omitted (see §3.4). Permission mode + busy live in the store. Transcript path via `ctx.sessionPersistence.locate(session.header)?.path` (existing use: `hooks-claude-code/src/payloads.ts:115`); the same persistence facade exposes `createdAt` (`state/driver-types.ts:363-371`) — the base for `cost.total_duration_ms`. Worktree descriptors may be on the session (worktree-exit flow) — best-effort, confirm in slice.
- **D8 — TUI is a cordis plugin.** `mountTui(ctx, config)` (`src/plugin.ts:16`) → `createDriver(ctx, …)` (`:29`); full ctx available; a writable settings facade is already consumed at `harness/driver-approvals.ts:108-126`. Driver tests inject a fake settings service — pin that for Slice 4 (the driver does `ctx.inject(['settings'])`-style access in the approvals path).
- **D9 — CC gating keys absent.** `disableAllHooks` / `allowManagedHooksOnly` match nothing under `packages/` — recorded as a gap, not implemented piecemeal.
- **D10 — Manifest gap recorded.** `ux.statusline` (`docs/claude-code-capabilities.yaml:2028-2049`), all dimensions `false`/`missing`; referenced from `engine.tui` (`:524-526`).
- **D11 — No Vim mode.** `engine.tui`: "Vim mode and ghost text are still later"; `hideVimModeIndicator` parsed but inert.
- **D12 — Test harness.** Root `vitest.config.ts` (tsconfig paths + exact-match aliases into the linked harness checkout; include `packages/*/*/tests/**/*.spec.ts`). Patterns: fake-projections driver specs (`packages/ui/tui/tests/driver-hud.spec.ts`); cascade specs (`settings-cascade/tests/cascade.spec.ts`).
- **D13 — Confirm-in-slice (small unknowns for the implementer, never guessed):** exact read API for a namespace the TUI does not own (`output_style.name` — if not cheaply readable, omit + manifest note); bundle version string source for payload `version`; whether a worktree descriptor rides the session header (fills `worktree` / `workspace.git_worktree`).

## 3. Product behavior

### 3.1 Configuration

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.dsh/statusline.sh",
    "padding": 0,
    "refreshInterval": 10,
    "hideVimModeIndicator": false
  }
}
```

- File locations + precedence: the five cascade layers (D4); the project file `.claude/settings.json` may be shared verbatim with a real CC checkout. **Key naming:** users write CC's camelCase top-level key `"statusLine"` (aliased onto namespace `statusline` by the cascade, D4/Slice 1b); a dsh-native kebab `"statusline"` key is also recognized and **wins when both are present** anywhere in the merged document (consistent with the repo-wide "dsh config takes precedence" rule, mirroring the MCP resolution).
- **Activation predicate:** activates iff `type === "command"` and `command` is a non-empty string. Any other shape → inert, built-in HUD stays in charge, no banner/error row (CC parity: silent).
- `padding`: non-negative integer (characters, CC's "in characters"), default 0; invalid/negative → 0.
- `refreshInterval`: **seconds** (C1); values < 1 clamp to 1; absent → no timer (keeps the zero-polling property true when unconfigured, D2; see §6/R1).
- `hideVimModeIndicator`: parsed, stored, behaviorally inert (D11).
- Unknown sibling keys tolerated (passthrough, not reject) so a shared CC settings file never hard-fails the cascade.

### 3.2 Rendering

- When active, the bottom status line shows the command's stdout **first line**, `trimEnd`-ed, prefixed by `padding` spaces. ANSI SGR passes straight through (existing `Text` dock renders SGR — the built-in HUD is theme-colored). Terminal overflow is clipped by the dock, as the fixed HUD is today. **CC renders every output line as its own row (C3); v1 discards rows 2+** — recorded deviation, multi-row is a deliberate non-goal (§8).
- Failure (spawn error, non-zero exit, timeout/hard-cap, killed, `exitCode: null`) or empty stdout → **blank line** (C7). No fallback to the built-in HUD — CC parity.
- Inactive → byte-identical built-in HUD (D1). Deactivation mid-session restores it immediately.

### 3.3 Execution semantics

- Spawn through the widened structural shell seam (D6): `stdin = JSON.stringify(payload) + '\n'`, `workdir` = session cwd, `env` = inherited process env plus **`COLUMNS`/`LINES` = current terminal dimensions at spawn time** (C6), `signal` from the runner's per-generation `AbortController`. Feature is inert when the shell service is absent (D6).
- Payload assembled **at fire time** from live state (D7) — model switches, effort changes, rebinds, usage updates reflected immediately.
- **Debounce 300 ms** trigger→spawn (C5). A trigger during an in-flight run **kills the child first** (C5), then debounce-schedules the replacement. **Settings-driven changes to `command` itself skip the debounce and run immediately** (C5).
- **Generation-guarded settle:** every run carries a generation number; if a run settles after it was superseded (its promise can resolve after the kill signal), its result is discarded — newer output is never clobbered by a stale settle.
- **Internal hard cap 60 s/run** (undocumented-by-CC dsh-cc guard against hangs; a capped run = failure → blank). Plus `stdoutMaxBytes` (64 KiB); overrun = failure → blank.
- Triggers (C4 mapped):
  1. session boot and every bind/rebind (`/resume`, session switcher) — HUD boot/re-seed path (D2),
  2. any `sessionProjections.onChanged` key for our session (token usage advances at assistant-message boundaries in the projection feed — CC's "new assistant message arrives"; debounce collapses bursts),
  3. permission-mode and model/effort changes — **there is no shared funnel today**: mode emits from `driver-mode.ts:76`, model/effort from `driver-pickers.ts:103,112,228` (reviewer S1). Mechanism: wrap `createDriver`'s `emit` (`driver.ts:74-77`) to diff `state.permissionMode` and `selection.current` before/after each emission and fire the statusline trigger when either changed — one seam, exhaustive by construction,
  4. `refreshInterval` (seconds) timer, when configured,
  5. in-process settings commits to the `statusLine` section (D5): a change to `command` runs immediately (C5); other key changes re-render via debounce; deactivation restores the built-in HUD. External file edits do NOT re-trigger mid-session (no file watcher, D5) — stated in README + manifest,
  6. CC's rate-limit `resets_at` / prompt-cache `expires_at` triggers: skipped by construction (those payload fields are omitted — nothing to schedule, C4).

### 3.4 Payload shape

CC-shaped JSON with only truthfully-sourced fields (C2, D7, D13):

| CC field | dsh-cc source | Status |
| --- | --- | --- |
| `cwd` | `session.header.cwd` (fallback driver cwd) | ✓ |
| `session_id` | `session.id` | ✓ |
| `transcript_path` | `ctx.sessionPersistence.locate(session.header)?.path` | ✓ (omit when unlocatable) |
| `model.id` | `selection.current.model` | ✓ |
| `model.display_name` | same as `model.id` (no display-name registry exists) | ✓ (duplicated; deviation-noted) |
| `workspace.current_dir` / `project_dir` | session cwd / driver project root | ✓ |
| `workspace.added_dirs` | — | `[]` constant |
| `workspace.git_worktree` | — | **omitted**: the session header verifiably carries no worktree descriptor (D13) |
| `version` | — | **omitted**: no truthful runtime source (a dsh-cc bundle version is not a CC version) |
| `output_style.name` | — | **omitted**: sourcing it from the `cc-output-styles` settings section would double-register another plugin's namespace |
| `cost.total_duration_ms` | `now − session.header.createdAt` (the harness `SessionHeader` carries `createdAt` directly), falling back to bind time when absent | ✓ (reviewer N1: `/resume` of an old session must not restart the clock) |
| `cost.total_cost_usd`, `total_api_duration_ms`, `total_lines_*` | no truthful source | **omitted** |
| `context_window.total_input_tokens` / `total_output_tokens` | token-usage totals from projections | ✓ when present |
| `context_window.context_window_size` / `used_percentage` / `remaining_percentage` | context-pressure projection | ✓ when present |
| `context_window.current_usage.*` | **NO truthful source** — `contextBreakdown` is role counts `{system, tools, messages}`, not token buckets (reviewer B1, `usage-view.ts:132-140`) | **omitted** |
| `exceeds_200k_tokens` | derived from the uncached input-token total (NOT total incl. cache) | ✓-approximate (reviewer N2; deviation-noted) |
| `effort.level` | `selection.current.reasoningEffort` | ✓ when set |
| `worktree{…}` | — | **omitted**: the session header verifiably carries no worktree descriptor (D13) |
| `session_name`, `prompt_id`, `fast_mode`, `thinking`, `rate_limits`, prompt-cache fields, `vim`, `agent`, `pr`, `workspace.repo` | no truthful source | **omitted** (consequently their C4 triggers never fire either) |

The payload type is structural and open (serialized, not validated): future fields add without a schema bump.

## 4. Implementation design

All work lands in `packages/ui/tui` (the only surface with a status line) plus the manifest/docs. TDD: every slice writes its spec first, watches it fail, then implements. Commit per slice; each slice independently green.

### Slice 1 — settings section (cascade CC-key alias + schema + normalize)

**1(a) — CC-key aliasing in the cascade (TDD in its own package).** New module `packages/settings/settings-cascade/src/cc-key-aliases.ts`: an explicit whitelist map `{ statusLine: 'statusline' }` applied to the merged document right after the five-layer merge at `settings-cascade/src/index.ts:263-271` (before the `env` split / publish; the shadow at `:169-174` therefore always mirrors the aliased doc, keeping `persist` diffs coherent). Rules: alias is injected only when the CC key is a plain object AND the dsh-native kebab key is absent from the merged document (dsh-native wins); non-object CC values are ignored; unknown camelCase keys are never auto-aliased (no fuzzy matching — the map is the contract). Update the package README with the aliasing rule. Test first in `packages/settings/settings-cascade/tests/cc-key-aliases.spec.ts` (style of `cascade.spec.ts`): a project file with top-level `"statusLine"` resolves through `settingsNamespace('statusline')`; sub-keys deep-merge across two layers under the CC key; both-present → kebab wins; non-object `statusLine` ignored; a `persist` to an unrelated namespace keeps the alias stable.

**1(b) — ui/tui dependency.** `packages/ui/tui/package.json` gains `@deepseek-ai/dsh-settings` following the exact style/version of the existing `@deepseek-ai/*` entries in that file (devDependencies links today); run `pnpm install` so the lockfile stays in sync.

**1(c) — settings module (pure).** New file `packages/ui/tui/src/harness/statusline-settings.ts`: `STATUSLINE_SETTINGS_NAMESPACE = settingsNamespace('statusline')` (kebab — passes the enforced pattern, D4); a tolerant Schemastery schema for `{ type, command, padding, refreshInterval, hideVimModeIndicator }` that passes unknown keys through; `describeStatusLine(resolved): { active: true, command, padding, refreshIntervalSec? } | { active: false }` implementing the §3.1 predicate + clamps (padding ≥ 0 default 0; refreshInterval SECONDS, < 1 → 1). Test first: `packages/ui/tui/tests/statusline-settings.spec.ts` — activation matrix (valid activates; other `type` values inert; empty command inert; absent inert; unknown keys survive; `refreshInterval: 0.2` → 1; negative `padding` → 0).

### Slice 2 — payload builder (pure)

- New file `packages/ui/tui/src/harness/statusline-payload.ts`: `buildStatusLinePayload(view: StatusLinePayloadView): Record<string, unknown>` — pure and total over the §3.4 table; absent sources drop their field; a sub-object that would be entirely unknown is dropped wholesale. **No `current_usage`, no role-count leaks.**
- Test first: `packages/ui/tui/tests/statusline-payload.spec.ts` — full view → full payload; omissions exactly per table; `exceeds_200k_tokens` boundary on the input total (200 000 → false, 200 001 → true); `cost.total_duration_ms` uses `createdAt`, falling back to bind time; JSON round-trip stays small (≤ a few KiB).

### Slice 3 — command runner (concurrency + failure semantics)

- Widen the seam in `packages/ui/tui/src/state/driver-types.ts`: the `resolve` REQUEST gains `stdin?: string`, `signal?: AbortSignal`, `env?: Record<string, string>`, `workdir?: string` (reviewer B2: `workdir`, not `cwd`); the resolved `ShellExecSpecLike` (`driver-types.ts:425-430`) gains the same optional fields (resolve bakes them in, D6). All optional → existing fakes keep type-checking.
- New file `packages/ui/tui/src/harness/statusline-command.ts`: `createStatusLineCommand(deps)` returning `{ update(config, payload): void, latest(): string, dispose(): void }` (final signatures pinned by the failing tests). Contract:
  - 300 ms debounced spawn (injectable clock/timers); `update` while in-flight aborts the current child (generation N signal) before scheduling generation N+1;
  - `update({ immediate: true })` skips the debounce (settings-driven `command` changes, C5);
  - generation counter: a superseded run's settle is discarded (reviewer S2);
  - settle: exit 0 + non-empty → `latest()` = first stdout line trimEnd-ed; anything else (non-zero, `exitCode: null`, timeout, spawn throw, empty, stdout overrun) → `latest()` = `''` (C7);
  - `env` carries `COLUMNS`/`LINES` from a terminal-size getter passed in (read at spawn time, C6);
  - hard cap 60 s via `timeoutMs`; `stdoutMaxBytes` 64 KiB;
  - `onSettled` callback notifies after every generation that lands (success or blank) so the driver can re-emit;
  - `dispose()` aborts in-flight, clears debounce + refresh timers, and makes later settles no-ops (reviewer S3 — `driver.dispose()` calls this; the no-polling invariant D2 stays intact because `dispose` clears the only timer the feature can create).
- Test first: `packages/ui/tui/tests/statusline-command.spec.ts` — fake `ShellExecutorLike` (deferred promises, records requests/signals) + fake timers: 5 rapid updates → 1 spawn; in-flight kill observed (abort signal) before respawn; **stale settle from generation N is discarded when N+1 already landed** (S2 test); immediate-update bypasses debounce; each failure class → `latest() === ''`; ANSI bytes verbatim; first-line-only; hard cap cuts a hung run; `COLUMNS`/`LINES` present in the request env; `dispose()` mid-flight kills and quiets.

### Slice 4 — driver wiring (integration) — as built

As implemented, `packages/ui/tui/src/harness/statusline-wiring.ts` is the single integration point: `createStatusLineWiring(rt)` owns settings registration + lifecycle, the `refreshInterval` timer, payload assembly, and the emit-diff trigger (mode / model / effort), and exposes `statusLineOf(width)` plus `dispose()`. `driver.ts` was kept within its net-zero line budget by delegating to the wiring module at boot and dispose; `plugin.ts` was untouched. The rest of the design below is unchanged from the planned version:

- Registration: `createDriver`/`mountTui` registers the section via `installSettingsSection` (D5; tolerant when no settings provider is mounted). `onChange` → re-resolve; `command` change → `runner.update(immediate: true)`; deactivation → runner disposed/absent → `statusLineOf` back on the built-in lane.
- `driver-hud.ts`: `statusLineOf(width)` gains the single conditional: active → `' '.repeat(padding) + runner.latest()`; inactive → built-in (unchanged). **No `root.ts` / `statusline.ts` edits.**
- Trigger wiring: projections subscription (existing, `driver-hud.ts:141-178`) + boot/re-seed (`:99-131`) → `runner.update`; **emit-wrapper seam**: wrap the driver `emit` (`driver.ts:74-77`) diffing `state.permissionMode` and `selection.current` (model + reasoningEffort) before/after; on change → `runner.update` (reviewer S1); `refreshInterval` timer inside the runner (created/cleared by config updates; cleared by `dispose`); runner `onSettled` → the same store→emit path the HUD uses (verified real: `root.ts:454-458` re-reads on every emit — R6 risk resolved by the reviewer).
- Dispose: `driver.dispose()` (`driver.ts:493-498`) calls `runner.dispose()` (S3).
- Test first: `packages/ui/tui/tests/driver-statusline.spec.ts` (modeled on `driver-hud.spec.ts`; fake projections feed + fake shell executor + fake in-process settings service — the driver's approvals path already requires one, D8): configured output replaces `driver.statusLine`; a `tokenUsage` projection change re-runs with fresh stdin JSON; failure blanks; programmatic settings flip mid-session (in-process commit, D5 — NOT a file edit, S4) restores the built-in HUD; `/resume` rebind re-runs with the new `session_id`; permission-mode change triggers via the emit wrapper; `refreshInterval: 1` creates exactly one interval while active and `dispose()` clears it (keeps `no-polling.spec.ts` semantics: unconfigured ⇒ zero timers — add that explicit assertion).
- Keep green: `driver-hud.spec.ts`, `statusline.spec.ts`, `no-polling.spec.ts` (whitelist untouched by construction; assert rather than edit).

### Slice 5 — capability manifest + docs

- `docs/claude-code-capabilities.yaml` `ux.statusline`: `recognized: true`, `mounted: true`, `behavioral: partial`, `ux: partial`; evidence: the four source anchors + the four new spec paths; deviation kind `downgrade`, rewritten summary covering: omitted payload fields (§3.4 incl. `current_usage` and its reason), `display_name === model.id`, no `disableAllHooks`/`allowManagedHooksOnly` gating (D9), **multi-row output discarded (rows 2+)** vs CC's per-row rendering (C3), first trigger set excludes rate-limit/prompt-cache timers (tied to omitted fields), approximate `exceeds_200k_tokens` (uncached input only), 60 s hard cap, `hideVimModeIndicator` inert (no Vim mode), external `settings.json` edits apply at next boot (no file watcher), Windows untested (forward-slash note from C7).
- `engine.tui` summary trailing sentence updated to point at the now-supported contract (still cross-referencing `ux.statusline` for limits).
- Regenerate: `pnpm docs:parity` (matrix + README parity block); `pnpm check:capabilities` + `pnpm test:capabilities` green.
- README.md + README.zh.md: short "Custom status line" section — config example, seconds-based `refreshInterval`, `COLUMNS`/`LINES`, stdin payload pointer to the CC doc, the next-boot caveat, the v1 first-row-only note.
- This plan's Status stays `Approved (post-review)`; §10 records the review.

## 5. Verification

Planned verification (fast-worker executes; ambiguous results route to deep-reasoner). Gate names from root `package.json`, verified 2026-09-05:

1. `./node_modules/.bin/vitest run packages/ui/tui` — all TUI specs green (existing + 4 new spec files); `./node_modules/.bin/vitest run packages/settings/settings-cascade` — cascade specs green (existing + the new alias spec).
2. `pnpm test` — no cross-package regressions (seam widening is additive/optional).
3. `pnpm typecheck`; gates covering touched files: `pnpm check:tui-boundary`, `pnpm check:size` (fix, never ratchet), `pnpm check:spec-deps`, `pnpm check:deep-imports`, `pnpm check:exports` if module surfaces changed.
4. `pnpm docs:parity` (regen) + `pnpm check:parity` + `pnpm check:capabilities` + `pnpm test:capabilities`.
5. **SKIPPED — Behavioral proof through the REAL executor.** Not executed: `dsh-shell` is not importable in the `ui/tui` test environment. Instead, the seam field names were verified against the harness executor source types (`workdir`, `stdin`, `signal`, `env` on both the request and spec sides), so the B2 drift class is covered by type checking against the real contract rather than by an end-to-end run.
6. Stretch (not CI-gating): PTY e2e suite `packages/ui/tui/scripts/e2e/run_core.py` (real `dsh` CLI, temp DSH_HOME, mock LLM) gains a scenario asserting a scripted status line's marker on the bottom row — manual confidence run.

## 6. Load-bearing risks

- **R1 Fork churn (resolved by design + tests).** Projection bursts could fork a shell per event; CC's own floor (300 ms debounce + cancel-in-flight, C5) bounds it to ≲3 spawns/s; generation guard + kill-first ordering covered by Slice 3 tests.
- **R2 Settings provider absent** — tolerated by `installSettingsSection` fallback (D5); feature inert, HUD unaffected. Shell service absent (D6/N3) — same inertness by explicit `undefined` check; **never** the `execFileAsync` fallback.
- **R3 Schema strictness vs. shared CC files** — passthrough-tolerant schema + activation predicate; Slice 1 tests.
- **R4 Structural-seam drift vs. the real executor (reviewer B2 — closed).** Field names taken from the harness type `ShellExecRequest` (`workdir`, `stdin`, `signal`, `env`) and BOTH request and spec sides widened; verification item 5 exercises the real `LocalBashExecutor` so drift fails loudly.
- **R5 Multi-row rendering (reviewer S6 — rescoped).** CC genuinely supports multi-row status lines; v1 discards rows 2+. Deliberate non-goal (§8) recorded in the manifest deviation — the deviation text must not imply CC is single-row.
- **R6 Reactivity loop (closed by review).** `emit()` notifies unconditionally and `root.ts:454-458` re-reads `statusLineIn` on every emit; runner `onSettled` routes through the existing store→emit path exactly like the HUD.
- **R7 Windows.** Executor abstracts the platform; README carries CC's forward-slash note; no CI coverage; deviation-noted.
- **R8 Payload staleness between triggers.** Same as CC (payload at fire time); `refreshInterval` is the user's remedy.
- **R9 Omission honesty.** Nothing is fabricated (§3.4); CC's official scripts all guard with `// 0`-style fallbacks, so omission is compatible in practice.
- **R10 Settings reactivity scope (reviewer S4 — stated, accepted).** Only in-process commits retrigger; external file edits apply at next boot. Documented; test pinned to programmatic updates. A file watcher is a future enhancement, out of scope.

## 7. Capability manifest and docs

Per repo rule (CLAUDE.md): manifest edit + regenerated docs land in the same commit/PR as the behavior change. Exact edits in Slice 5. Gates: `check:capabilities`, `check:parity`, `test:capabilities` (pre-commit/presubmit).

## 8. Non-goals

- Multi-row status lines (CC renders each line as a row; v1 keeps row 1 only) — deliberate, deviation-noted.
- Vim mode; `hideVimModeIndicator` beyond parsing (D11).
- `disableAllHooks` / `allowManagedHooksOnly` gating (D9).
- USD cost, API-duration, lines-added/removed, rate-limit data, prompt-cache expiry payloads and their timers, `agent`, `pr`, `session_name`, `prompt_id`, `workspace.repo`, `thinking`, `fast_mode`.
- `context_window.current_usage.*` (no truthful source — role-count breakdown is not token buckets).
- A file watcher for external `settings.json` edits; a `/statusline-setup` helper agent; ANSI-aware width truncation (dock clips); Windows CI; headless surfaces.

## 9. Rollout

- Single PR from branch `worktree-status-line` (this worktree): plan doc + slices in TDD commit order (cascade alias → settings → payload → runner → wiring → docs), each slice independently green.
- No migration: absent `statusLine` keeps today's behavior bit-for-bit; a project `.claude/settings.json` shared with real CC gains immediate, identically-specified meaning in dsh-cc.

## 10. Review provenance

- CC behavior: context7 (`/anthropics/claude-code`, `/websites/code_claude`) + verbatim `code.claude.com/docs/en/statusline.md`, all retrieved 2026-09-05 — the seconds-based `refreshInterval`, the command-change debounce skip, multi-row support, and `COLUMNS`/`LINES` were corrected/confirmed verbatim at this step. Failure/gating semantics (C7) come from the page's Troubleshooting section via the context7 extraction; the current `.md` variant no longer carries that paragraph (doc drift, noted).
- dsh-cc facts: `explore`-agent survey, re-verified against `path:line` at authoring time (D1–D13).
- **Cold adversarial review by deep-reasoner (Opus), verdict "revise-and-ship", all verdicts incorporated:**
  - [BLOCKER] B1 — `context_window.current_usage.*` mapped from `contextBreakdown`, which is role counts only (`usage-view.ts:132-140`). → field omitted; false test dropped; omission manifest-noted.
  - [BLOCKER] B2 — seam widening named `cwd`; the real executor takes `workdir`, and `resolve` bakes options into the spec (harness `packages/shell/shell/src/types.ts:38-44,86-110`) — both sides widened; `exitCode: null` on kill documented as failure→blank.
  - [SHOULD-FIX] S1 — trigger 3's "shared emit path" premise was false (scattered emits: `driver-mode.ts:76`, `driver-pickers.ts:103,112,228`); replaced with the `emit`-wrapper diff seam (`driver.ts:74-77`), plus the CC command-change debounce skip.
  - [SHOULD-FIX] S2 — stale-settle race closed with a generation guard (+ test).
  - [SHOULD-FIX] S3 — `runner.dispose()` wired into `driver.dispose()` (kill + timer cleanup; protects the no-polling invariant).
  - [SHOULD-FIX] S4 — `onChange` fires only on in-process commits (harness `settings/src/index.ts:748-768`; no cascade file watcher); README/manifest state it; tests use programmatic updates.
  - [SHOULD-FIX] S5 — `COLUMNS`/`LINES` env added (C6).
  - [SHOULD-FIX] S6 — multi-row deviation re-worded (CC IS multi-row; v1 discards rows 2+).
  - [NIT] N1 — `cost.total_duration_ms` from session `createdAt` (not bind time; `/resume` correctness).
  - [NIT] N2 — `exceeds_200k_tokens` is uncached-input-only; approximate, noted.
  - [NIT] N3 — inert when the shell service is absent; no `execFileAsync` fallback.
  - [NIT] N4 — C4 trigger list completed (rate-limit/prompt-cache timers skipped-by-construction with omitted fields).
  - [NIT] N5 — blank-on-failure re-verified: verbatim quote obtained from the official doc's Troubleshooting section (context7); absent from the current `.md` variant.
  - Reviewer verified accurate: D1–D5, D8–D12 spot-checks, the R6 channel, Slice 2/3 standalone TDD-ability; Slice 4 needs the fake settings service (now pinned, D8).
- **Implementation-prep verification by fast-worker (Sonnet) caught a further BLOCKER before any code was written:** `settingsNamespace` enforces kebab-case and throws on `'statusLine'` at module load (harness `settings/src/index.ts:21-29`, untouchable), and the service resolves sections by exact `document[ns]` raw-key lookup — CC's camelCase top-level key could never resolve. **Resolution adopted (Slice 1 reworked):** dsh-cc-side CC-key aliasing in the cascade (whitelist `{ statusLine: 'statusline' }`, post-merge/pre-publish, dsh-native key wins), plus the missing `@deepseek-ai/dsh-settings` dependency for `packages/ui/tui`. The CC-file-compat goal survives unchanged; Slice 2/3 confirmed unaffected.
- **Implementation provenance (2026-09-05).** Slices 1–3 landed at 75cc99f, slice 4 at c1e32d1. TDD caught two real bugs before they could land: a boot-generation result discarded by the runner, and a dispose/re-emit ordering bug. Slice 5 (capability manifest, regenerated parity docs, README sections, this truth-sync) is part of the same slice-5 commit.
