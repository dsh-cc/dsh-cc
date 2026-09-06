# Product-grade `/doctor` health report

Status: approved (Staff cold review folded; 2026-09-03). Constraint: **dsh-cc only** — do not modify deepseek-harness.

Decisions locked by the requester:

- `--json` writes `$DSH_HOME/tui/doctor-report.json` (overwrite, not timestamped).
- Surface the dsh profile as `ctx.get('dshProfile')` (`'tui'`). The launcher has no cordis context; it stamps `DSH_CC_PROFILE=tui` on the child env and the TUI plugin provides the value.

## Goal

Turn `/doctor` from a three-line seam dump into a product-grade health report of the **live session**, with three renderings of one data object:

| Invocation | Behaviour |
|---|---|
| `/doctor` | Cheap in-process checks. `ok` collapsed; `warn`/`fail`/`skip`/`info` expanded with summary + fix. Target &lt; 500 ms. |
| `/doctor --verbose` | Cheap checks plus slow probes (PATH scan, git, session-store write, LLM catalog). Evidence expanded. |
| `/doctor --json` | Same collection as `--verbose`. Full JSON written to `$DSH_HOME/tui/doctor-report.json` (mkdir + overwrite). The command result is the path + summary counts + fail/warn ids — never a JSON blob in the TUI transcript. |

`--verbose` + `--json` together: collect verbose, emit json.

A headless `dsh doctor` CLI is **Phase 2** (out of this PR).

Observable in a later real session (not claimed at merge): `/doctor` prints grouped health; `--json` leaves a file a human can paste into an issue.

## Why this, not Claude Code's `/doctor`

Claude Code's `claude doctor` is a read-only install/settings scan; in-session `/doctor` (2026-w28) proposes CLAUDE.md / unused-skill fixes and asks before mutating. We take the **read-only + findings + suggested fix** shape. We do **not** mutate CLAUDE.md or skills. MCP operations stay on `/mcp`. `--json` is ours (CC has no equivalent), so the write-to-disk channel is required — TUI markdown would mangle a JSON blob.

## Non-goals (this PR)

- `--check &lt;id&gt;` (not requested; invents partial-collection semantics).
- Per-check `elapsedMs`.
- A generic probe-runner / timeout framework (three slow probes, one 30-line helper).
- Replicating `mergeAliasMaps` inside doctor.
- Prefix-counting deferred MCP tools via `mcp__&lt;srv&gt;__`.
- Spawning `dsh --version` on the default path (use `ctx.get('harnessVersion')`; skip when absent).
- `which` / `where` for `serena-hooks` (pure fs PATH scan, and only when a loaded hook command references the binary).
- Splitting this-repo worktree quirks (node_modules symlink, settings.local fallback, `.serena`) into three separate checks with rotting fix text.

## Current code (do not fight it)

- `packages/interaction/command-doctor` — `gatherReport` + `formatDoctorReport`; sync handler; row is **top-level** in `packages/preset/cc/agent.cordis.yml:430`. Tests import `@dsh-cc/command-doctor/doctor`.
- `cc-services` isolate (`toolSearch`, `microcompactor`, `ccModelRoutes`, `mcpConnections`). Consumers of those services (`command-mcp`, `command-plugin`) live **inside** the group. Doctor must move in. `composition.spec.ts:155` asserts exactly those inside-group command ids.
- `/status` already folds `session.id`, `header.cwd`, last `request/header` provider/model, `permissionPresets.current(events)`. Reuse that folding; do not invent a second model source.
- `/version` already reads this package's manifest + `ctx.get('harnessVersion')`. Reuse; do not spawn.
- `ccModelRoutes.resolve(name) → {provider?, model, reasoningEffort?} | undefined`. Builtin: `fable/opus/sonnet/haiku` + lanes `sketch/draft/blueprint/masterplan/architect`. `LANE_PEERS`: sketch→haiku, draft→sonnet, blueprint→opus, masterplan→fable; architect has no peer. Merge is settings (null deletes) &gt; config &gt; builtin inherit. String targets follow **one hop**.
- `mcpConnections.entries()`: `{name, state, error?, toolCount?, authRequired?}`. `setToolCount` is already called on ready (`mcp-client/src/index.ts:247`). No eager/deferred split.
- `syncTools` (`mcp-client/src/tools.ts`) knows defer vs eager per listed tool (`deferServer && !alwaysLoad`). Resource-bridge tools are always eager (`connection.ts` `toolCount` = listed disposers + resource disposers).
- `parseClaudeCodeConfig` returns `{config, skipped: {event, type}[]}`. Unknown executor types are recorded; **malformed command/http entries are dropped silently**. A `SyntaxError` from a bad matcher rejects the whole file (`hooks-claude-code/src/index.ts:172` logs and returns — no status object).
- `ccPlugins.list()` already forwards `PluginLoadReport.components`, which **already includes `reasons: string[]`**. `command-plugin`'s local `CcComponentResult` simply omits the field. Doctor duck-types `reasons`; do not invent a new loader field.
- `agentPresets.defaultId` is `'cc'` in the TUI. dsh **profile** (`tui`) has no in-session seam today.
- Command handlers may return `Promise&lt;CommandResult&gt;` (`command-mcp`, `command-plugin`, `command-version` already do).
- Source files are gated at 500 lines (`scripts/check-file-size.mjs`). Split checks.

## Additive APIs (do these first; TDD; no behaviour change for existing `resolve` / `/mcp` text)

### 1. `ccModelRoutes.inspect` — do **not** restage merge

`resolve()` stays byte-identical. Add `inspect` on the same closure so the route cannot drift.

```ts
export type AliasInspectKind = 'route' | 'inherit' | 'literal'
export type AliasInspectVia = 'configured' | 'peer' | 'one-hop' | 'builtin'

export interface AliasInspection {
  readonly kind: AliasInspectKind
  readonly route?: ResolvedRoute
  readonly via?: AliasInspectVia
  readonly hop?: string  // followed alias name, when via === 'one-hop' or 'peer'
}

export interface ModelRoutes {
  resolve(model: string | undefined): ResolvedRoute | undefined
  inspect(model: string | undefined): AliasInspection
}
```

Implementation: refactor `createModelResolver` so the inner function returns an `AliasInspection` and `resolve` is `inspect(name).route`. Classification is **coarse** (Staff): `configured` = key present in the merged map; `peer` = unconfigured lane followed `LANE_PEERS`; `builtin` = unconfigured CC alias / architect; `one-hop` = string target named another alias; `literal` = passthrough. Do **not** distinguish settings vs config layers. Do **not** re-read `settings.get` inside doctor.

Wire `inspect` through `ctx.provide('ccModelRoutes', { resolve, inspect })`. Export the types from `index.ts`.

Tests in `packages/compat/cc-model-aliases/tests/resolver.spec.ts` (extend) + `service.spec.ts`:

- configured object route → `kind:'route', via:'configured'`
- settings null-delete of a config entry → same as unconfigured (`inherit` + `via:'peer'`/`'builtin'`)
- `sketch` unconfigured, `haiku` configured → sketch inspect equals haiku route, `via:'peer'`, `hop:'haiku'`
- `sketch: haiku` (string) with haiku object → `via:'one-hop'`, `hop:'haiku'`
- `architect` unconfigured → `kind:'inherit', via:'builtin'`
- `inherit` token → `kind:'inherit'`
- existing `resolve()` assertions unchanged

### 2. MCP eager / deferred counters — no prefix approximation

Extend `McpConnectionEntry`:

```ts
eagerCount?: number
deferredCount?: number
```

Count at the publish site, not by scanning tool names.

- In `syncTools`, while looping `definitions`, increment `deferred` when `deferServer && !entry.alwaysLoad`, else `eager`. Put both on `ToolGeneration`.
- Resource-bridge tools are always eager: `eagerCount += registrations.resources.size` at the handle.
- `McpConnectionsService.setToolBreakdown(name, { eager, deferred })` sets the two fields **and** `toolCount = eager + deferred` (keep `setToolCount` as a thin wrapper or have `setToolCount` remain for total-only callers).
- On ready (`index.ts` after `setToolCount`), also set the breakdown from the handle.
- On error / disconnect, leave counts undefined (or zero); do not invent numbers.

`/mcp` rendering stays as today (toolCount only). Doctor reads the new fields when present.

Tests: extend `packages/mcp/mcp-client/tests/defer.spec.ts` (cases A/B/C already distinguish eager vs deferred) to assert the registry entry's `eagerCount`/`deferredCount`. Extend `registry.spec.ts` for `setToolBreakdown`.

Do **not** add `configSource` in this PR (the glue does not pass a discovery path into mcp-client Config). Omit the field.

### 3. Hook load-report, instance-scoped

`SkippedHook` gains `reason: string`. **Malformed entries (missing command string, malformed http, non-object hook) are recorded**, not only unknown executor types. Update `config.spec.ts` cases that currently `toEqual` skipped arrays and the "drops malformed" tests so they assert the new skipped rows.

`hooks-claude-code` `apply()` always `ctx.set('hookBridgeStatus', report)` on the plugin context (same isolate as doctor after the row move):

```ts
export interface HookBridgeStatus {
  readonly sourcePath: string          // path.resolve'd
  readonly events: readonly { name: string; groups: number; hooks: number }[]
  readonly skipped: readonly SkippedHook[]
  readonly error?: string              // SyntaxError / ENOENT / JSON.parse
  readonly enablePromptHooks: boolean
  readonly enableAgentHooks: boolean
}
```

On read/parse failure: set `error`, empty `events`, then return (same as today: no listeners). Do not use a module-level singleton.

Tests: a new spec (or extend an existing apply-level spec) that mounts the plugin with a temp `hooks.json` and `ctx.get('hookBridgeStatus')` matches; a broken JSON file yields `error` and zero events.

### 4. `dshProfile` from launcher → TUI plugin

Launcher has no ctx. Follow the existing `DSH_CC_*` env contract.

- `packages/launcher/tui/bin/dsh-cc.js`: `env.DSH_CC_PROFILE = PROFILE` (`'tui'`) on the spawned `dsh` child. Do **not** add it to `sanitizeInheritedEnv`'s stripped set (it is not a leaked resume flag).
- `packages/ui/tui/src/index.ts` `apply`: `ctx.provide('dshProfile', process.env.DSH_CC_PROFILE || 'tui')` so a `dsh --profile tui` launch without the wrapper still reports `'tui'` whenever the TUI plugin is mounted.
- Tests: `bootstrap.spec.ts` is the wrong layer (it does not spawn). Add a small unit test next to TUI `apply` **or** a focused test of a tiny helper `resolveDshProfile(env, fallback='tui')` extracted from `apply` if `apply` is too heavy to mount. Prefer the helper — `apply` requires a TTY.

## Data model (`packages/interaction/command-doctor`)

Replace the old `DoctorReport` (`version/settings/seams`). Keep the `./doctor` export path; tests and tsconfig path alias stay valid.

```ts
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip' | 'info'
export type CheckGroup =
  | 'env' | 'session' | 'models' | 'mcp' | 'hooks' | 'web'
  | 'storage' | 'git' | 'plugins' | 'seams'

export interface Check {
  readonly id: string            // kebab, dotted: 'models.alias.blueprint'
  readonly group: CheckGroup
  readonly status: CheckStatus
  readonly summary: string
  readonly detail?: string
  readonly evidence?: Readonly<Record<string, string | number | boolean | null>>
  readonly fix?: string
}

export interface DoctorReport {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly durationMs: number
  readonly env: {
    readonly dshCc: string
    readonly harness?: string
    readonly node: string
    readonly os: string
    readonly arch: string
    readonly cwd: string
  }
  readonly checks: readonly Check[]
  readonly summary: { ok: number; warn: number; fail: number; skip: number; info: number }
}
```

Contract: adding a check id is **not** breaking. Consumers must tolerate unknown ids. Only `schemaVersion` bumps are breaking.

`generatedAt` / `durationMs` take an injected clock (`now: () => Date`, `ms: () => number`) so snapshots are deterministic. Tests never real-spawn.

Redaction is a pure function over the **report object**, shared by text render and JSON:

- Evidence is a whitelist of primitives (ids, paths, counts, versions, enums). No free-form blobs.
- A fallback regex scrubs `sk-`, `ghp_`, `xoxb-`, `Bearer ` from summary/detail/fix/evidence string values.
- Call redact once; both renderers consume the redacted report.

## Status → severity (write the snapshot against this table)

| Observation | status |
|---|---|
| MCP `ready` and `toolCount &gt; 0` | ok |
| MCP `connecting` | info |
| MCP `ready` and `toolCount === 0` | warn |
| MCP `error` / `disconnected` | fail |
| MCP `authRequired === true` | warn |
| MCP name matches `/serena/i` and not `ready` | fail (Serena-specific; git group may add an info cross-note about `.serena`) |
| `mcpConnections` seam absent | skip |
| alias `inspect` → inherit (unconfigured builtin / architect) | info |
| alias has route; provider missing from `listProviders` | fail |
| alias has route; model missing from `listModels` | **warn** (custom provider catalogs are incomplete) |
| effort not in `resolveModelInfo.reasoning.efforts` | warn |
| effort list empty, or route has model but no provider | skip (cannot attribute) |
| `inspect('haiku')` has a full `{provider, model}` | ok (cheap lane configured) |
| haiku unconfigured | info (titles / WebFetch prompt / hooks inherit) |
| WebFetch tool mounted, fetch provider missing | **info** (known limit, `WEB_PROVIDER_UNAVAILABLE`) |
| hook config SyntaxError / unreadable | fail (zero hooks registered) |
| hook malformed entries recorded in skipped | warn |
| prompt/agent hooks present but enable flags default-off | info |
| a loaded command string references `serena-hooks` and the binary is not on PATH | fail |
| no loaded command references `serena-hooks` | skip (do not scan PATH) |
| `sessionPersistence.locate(header).path` dirname writable | ok |
| locate fails | skip |
| path exists, not writable | fail |
| cwd is not a git repo | skip |
| worktree (`.git` is a file) | one git check, info; at most one extra warn (e.g. no `node_modules`) |
| plugin component `skipped &gt; 0` or `failed &gt; 0` | warn, list `reasons` |
| `ccPlugins` absent | skip |
| Node does not satisfy the installed package's `engines.node` | fail |

Node engines: root / this package is `"^22.19 || &gt;=24"`. There is no `semver` dependency in the repo — **do not add one**. Implement a tiny `nodeSatisfiesEngines(version: string)` that understands only this range, with tests for `22.18.0` (fail), `22.19.0` (ok), `23.0.0` (fail), `24.0.0` (ok). Read engines from **this package's** `package.json` (same walk as `readVersion` / `/version`).

## Flags

Parse `invocation.rawInput` the way `/mcp` does (`trim.split`). Accepted tokens: `--verbose`, `--json`. Anything else → usage text, **do not run checks**:

```
Usage:
  /doctor              session health report
  /doctor --verbose    include slow probes and evidence
  /doctor --json       write $DSH_HOME/tui/doctor-report.json (overwrites)
```

Register `input: { hint: '[--verbose|--json]' }` on the command definition.

## Collection

`collect(ctx, invocation, options: { verbose: boolean; now(); sinceMs(); writeJson?(report) })`.

Every check is `try/catch` → `fail` with `String(error)`. Missing optional seams → `skip` with reason. The command result is always `{ kind: 'success', text }` (usage is success too).

Default (`verbose: false`) is in-process only:

- env (versions, node engines, os/arch)
- session (id, cwd, permission preset, agent preset, dshProfile)
- models: `inspect()` of the nine builtins, peer-deduped (see below); **no** `listModels` / `resolveModelInfo`
- mcp: `entries()` as-is
- hooks: `hookBridgeStatus` (no PATH scan unless a command references `serena-hooks` — that scan is verbose-only; default reports "not probed")
- web: `ctx.web` presence; fetch-provider presence via a duck-typed `ctx.web.fetch` try or a documented `ctx.get` — if the only signal is "tool is mounted", report the known-limit info when `ctx.web` has no fetch (the cc preset sets `tool-web` `fetch: false`)
- plugins: `ccPlugins.list()`
- seams: today's seven names (keep as a compatibility section)
- storage / git: **skip with "use --verbose"** on the default path (or a one-line info "not probed")

Verbose adds:

- LLM catalog validation (cache `listProviders` once, `listModels(provider)` per distinct provider, `resolveModelInfo` per distinct provider+model; `Promise.all`, never 27 serial awaits)
- PATH scan for `serena-hooks` (pure fs: split `process.env.PATH`, append platform executable suffixes `''`, `'.cmd'`, `'.exe'` on win32; `lstat` / `stat`; no `which`)
- git: `.git` is file → worktree; `git rev-parse --show-toplevel` and `--git-common-dir` through `ctx.shell`/`ctx.subprocess` if mounted, 1 s timeout each; tests inject a fake. Report main checkout, branch (`git rev-parse --abbrev-ref HEAD`), whether `node_modules` exists (`lstat`, detect symlink/junction), whether `.serena` exists in cwd
- session store: `sessionPersistence.locate(header).path`; write `${path}.${pid}.doctor-tmp` + unlink in `finally`

### Models group, peer-deduped

Render five rows, not nine:

| Row id | Aliases shown |
|---|---|
| `models.alias.haiku` | `haiku (+ sketch)` |
| `models.alias.sonnet` | `sonnet (+ draft)` |
| `models.alias.opus` | `opus (+ blueprint)` |
| `models.alias.fable` | `fable (+ masterplan)` |
| `models.alias.architect` | `architect` |

Inspect the **canonical** name (haiku/sonnet/…). Also inspect the peer lane; if a lane is **configured independently** (not following the peer), add a sixth+ row for that lane so a divergent `sketch` is visible. Cheap lane is the haiku row (no extra check id).

Last-request model: copy `/status`'s `lastModel(events)` and label the check `models.last-request` with summary `Last request: provider/model`. If `header.config.reasoningEffort` exists, include it; if not, omit (do **not** call this "the main model" — a command can run from a child agent). No TUI picker selection (not visible to the command).

### Serena

One mcp check id `mcp.server.&lt;name&gt;` per entry, plus `mcp.serena` that finds the entry whose name matches `/serena/i`. If git verbose sees a worktree without `.serena`, add `detail` on `mcp.serena` pointing at that (cross-note), not a second competing check.

## JSON file

Path: `join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'tui', 'doctor-report.json')`. `mkdir({recursive:true})`, overwrite. If write fails, the command text says so and still prints the summary; do not throw.

## Package layout (stay under 500 lines / file)

```
packages/interaction/command-doctor/src/
  index.ts          register, parse flags, async handler
  collect.ts        orchestrate checks
  report.ts         types + summary counts
  redact.ts         pure
  render.ts         default + verbose text
  json.ts           path + write
  flags.ts          parse + usage
  version.ts        readVersion (move from index) + nodeSatisfiesEngines
  last-model.ts     fold request/header (do not import command-status)
  checks/env.ts
  checks/session.ts
  checks/models.ts
  checks/mcp.ts
  checks/hooks.ts
  checks/web.ts
  checks/storage.ts
  checks/git.ts
  checks/plugins.ts
  checks/seams.ts   today's seven seams
```

Keep `doctor.ts` as a re-export of `formatDoctorReport` + `DoctorReport` so `@dsh-cc/command-doctor/doctor` and the tsconfig path keep working.

Duck-type every optional seam locally (copy the `command-mcp` / `command-plugin` pattern). **Do not** add mcp-client, cc-shell, hooks-claude-code, or cc-model-aliases as runtime dependencies of command-doctor.

`readVersion` stays exported from `index.ts` (existing test).

## Composition

Move the `command-doctor` row **inside** `cc-services` in `packages/preset/cc/agent.cordis.yml` (alongside `command-mcp` / `command-plugin`). Update `composition.spec.ts` to expect `command-doctor` in `configIds` and **not** in `topIds`. Root-realm services (`llm`, `fs`, `shell`, `settings`, `agentPresets`, `dshProfile`) remain visible from inside the group — do not isolate new names.

## Tests (TDD: write the failing spec first in each package)

### Additive packages

Covered above. Existing assertions must stay green (`resolve` identity, `/mcp` text, hook happy-path parse).

### command-doctor

Replace `tests/command-doctor.spec.ts` in slices; keep a registration test (Loader-safe exports, dispose). Handler is async — `await ctx.commands.execute`.

New files (suggested):

- `tests/flags.spec.ts` — empty, `--verbose`, `--json`, both, unknown → usage
- `tests/redact.spec.ts` — whitelist preserved; `sk-` / `ghp_` / `xoxb-` / `Bearer ` scrubbed
- `tests/render.spec.ts` — snapshots with injected clock; ok collapsed; fail expanded
- `tests/collect-seams.spec.ts` — bare composition: seams not mounted, settings skip/not-mounted, command still success
- `tests/collect-session.spec.ts` — session id / cwd from invocation; dshProfile provided / absent → skip; permission preset throw → omit/skip
- `tests/collect-models.spec.ts` — fake `ccModelRoutes.inspect`; inherit info; peer dedup; verbose catalog warn/fail
- `tests/collect-mcp.spec.ts` — mapping table; serena name; seam absent
- `tests/collect-hooks.spec.ts` — status object; parse error; serena-hooks PATH skip unless referenced
- `tests/collect-json.spec.ts` — writes overwrite path under isolated `DSH_HOME`; TUI text contains the path and counts, not the full JSON
- `tests/engines.spec.ts` — 22.18 / 22.19 / 23 / 24
- `tests/crash.spec.ts` — every seam getter throws → corresponding check fail, command success

**Tests must not spawn** `dsh`, `git`, or `which`. Fake `ctx.shell` / fs.

`check-spec-deps`: any new import in specs must be declared on that package's `package.json` (then `pnpm install --lockfile-only` if the lockfile changes). command-doctor specs that only duck-type do not need mcp-client as a dep.

Worktree vitest: if `node_modules/.vite-temp` is EPERM, use the `.verify/` pattern from the repo notes — do not fight the sandbox.

## Docs

- `packages/interaction/command-doctor/README.md` + `README.zh.md` — three flags, JSON path, schemaVersion consumer rule, known limits (no headless CLI; no CC-style mutations; fetch provider unshipped is info). Re-record i18n hashes: `pnpm run verify-translation-pairing --write packages/interaction/command-doctor/README.md`.
- `docs/cc-parity-matrix.md` command-surface bullet: `/doctor` is a health report (`--verbose` / `--json`).
- Root `README.md` `/doctor` line: add the two flags.

## Implementation order

1. Additive APIs (independent, TDD each package): inspect, MCP counters, hook status, dshProfile.
2. command-doctor types + flags + redact + render + collect skeleton (env / session / seams) + move the cordis row + composition.spec.
3. Remaining check groups + JSON write + README pair + parity matrix.
4. Run the touched package tests + `node scripts/check-spec-deps.mjs` + `pnpm check:size`.

## Verification (this PR)

```
pnpm exec vitest run packages/compat/cc-model-aliases packages/mcp/mcp-client packages/hooks/hooks-claude-code packages/interaction/command-doctor packages/preset/cc packages/launcher/tui packages/ui/tui packages/bundle/cc-shell
node scripts/check-spec-deps.mjs
pnpm check:size
```

Pass = those suites green, composition.spec asserts doctor inside `cc-services`, JSON test wrote and overwrote the isolated file.

Not claimed at merge: a live `/doctor` in TUI. That is a later-session observation.
