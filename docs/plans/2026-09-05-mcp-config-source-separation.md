# MCP config source separation and Claude Code migration

Date: 2026-09-05. Status: **Implemented** — PR #116 (merged 2026-09-05). Reviewed (deep-reasoner cold review; 9 findings folded in — see §9). Gate scope approved by the user: both `cwd/.mcp.json` and `$DSH_HOME/.mcp.json` count as dsh-native.

## 1 Background

The `cc-shell-glue` plugin (`packages/bundle/cc-shell/src/index.ts`) discovers
MCP server configs at session start by reading, when
`config.mcpConfigFiles` is absent, all of these files that exist:

1. `<cwd>/.mcp.json`
2. `$DSH_HOME/.mcp.json` (default `~/.dsh/.mcp.json`)
3. `~/.claude/.mcp.json`
4. `~/.claude.json` (top-level `mcpServers`)

Every server from every file mounts. In practice this mixes the user's dsh
configuration with their Claude Code configuration: the same server is often
declared in both worlds (duplicate `serverName` → the second mount throws and
is swallowed into a warn), removals in one world are defeated by the other,
and there is no visible answer to "which file is actually in effect".

## 2 Goals / non-goals

Goals:

- A dsh-native config (project `.mcp.json` or `$DSH_HOME/.mcp.json`) that
  declares at least one valid server takes sole effect: Claude Code files are
  not loaded in that case.
- When Claude Code servers are thereby skipped, the user is told and offered
  a one-command migration.
- `/mcp migrate` imports the Claude Code `mcpServers` into
  `$DSH_HOME/.mcp.json` without touching the Claude Code files.
- Pure discovery default change: explicit `config.mcpConfigFiles` behavior is
  byte-for-byte unchanged, and a config knob restores the old all-merge
  behavior.

Non-goals:

- No hot reload: MCP config is read once at plugin apply; activation after
  migration still requires a session restart (restart messaging is part of
  the UX instead).
- No editing, renaming, or deletion of Claude Code files.
- No dedup between the two dsh-native files (pre-existing, orthogonal).
- No harness (deepseek-harness) changes; everything lives in dsh-cc.

## 3 Terminology and path classification

`resolveDefaultMcpPaths` (new, §7.1) returns the only classification:

| class | paths |
| --- | --- |
| dsh-native | `<cwd>/.mcp.json`, `$DSH_HOME/.mcp.json` (default `~/.dsh/.mcp.json`) |
| claude-code | `<claudeDir>/.mcp.json`, `<home>/.claude.json` |
| migration target | `$DSH_HOME/.mcp.json` |

`claudeDir = $CLAUDE_CONFIG_DIR ?? <home>/.claude` — honoring
`CLAUDE_CONFIG_DIR` matches Claude Code's treatment of its config directory
and makes the paths testable without `chdir`. The `~/.claude.json` state file
stays anchored at the user home (Claude Code keeps global state there
regardless of the config dir; review finding 8 accepted this anchoring rather
than relocating it).

The classification is a pure function of injectable `{ env, cwd, home }`;
only the defaults touch `process`/`os`.

## 4 Loader behavior (`cc-shell-glue`)

In discovery mode (`config.mcpConfigFiles === undefined`), `apply`:

1. Reads each dsh-native file via `readMcpServerNames` (§7.1) and tallies
   declared servers across files with `kind: 'ok'`.
2. Gate decision: **gated** when the tally is ≥ 1, else ungated. A dsh file
   that is absent, unparseable, or declares no servers does not gate — the
   existing per-file parse warn stays, but Claude Code files must not be
   silently killed by an empty or broken dsh file (review finding 3).
3. Ungated → mount dsh files then Claude Code files, exactly today's order
   and behavior (backward compatible).
4. Gated → mount dsh files only. If `claudeOnlyServers` (§7.1) reports any
   Claude Code server not declared by a dsh file, emit the notice (§5).

Escape hatch: new optional config field `mcpLoadClaudeFiles?: boolean | null`
(schema: `z.union([z.boolean(), z.const(null)])` — bare `z.boolean()` risks
an implicit default from schemastery, same trap the union pattern already
documents in `index.ts:36`). When it is `true`, discovery mounts dsh files
then Claude Code files and never notices: one patch row in
`~/.dsh/.agent-presets/cc/cordis.patch.yml` restores the old behavior
(review finding 4).

Explicit `config.mcpConfigFiles` → unchanged: no gating, no notice, the knob
is ignored.

## 5 User-facing notice

Three channels, all carrying the same information — which Claude Code files
were skipped, how many servers each holds, and the remedy:

1. `ctx.logger.warn` at apply time (log/debug channel).
2. A one-shot session-start notice: the glue registers (only when a notice is
   pending) one `ctx.on('agent/session-start', ...)` listener guarded by a
   closure flag, injecting on the first event a plugin notice message —
   `agent.inject(createUserMessage({ content: [{ type: 'text', text }],
   source: { kind: 'plugin', plugin: 'cc-shell-glue', form: 'notice',
   summary: text } }))`, the pattern established in
   `packages/hooks/hooks-claude-code/src/turn-safety.ts:96` (TUI renders it
   as a dim status row; `source.kind: 'plugin'` means it never looks like
   user input). The flag makes subagent/resume fan-out (review finding 1) a
   cosmetic-only risk: the first `agent/session-start` in a process is the
   root session's.
3. A live status line appended to `/mcp` list output whenever the loader
   gate **is actually in effect** (some dsh-native file declares ≥1 server)
   AND `claudeOnlyServers(resolveDefaultMcpPaths())` is non-empty. The gate
   check matters: without it a user with only Claude Code configs (nothing
   gated, everything loaded) would be nagged with a false "not loaded" line.
   Because the name comparison re-runs on every call, the line self-clears in
   the same session once `/mcp migrate` has run.

Notice text (single line, ≤ ~300 chars), e.g.:

```
MCP: dsh config takes precedence — skipped Claude Code MCP config: ~/.claude/.mcp.json (2 servers), ~/.claude.json (1 server). Run /mcp migrate to import them into ~/.dsh/.mcp.json, then restart the session.
```

## 6 Migration command: `/mcp migrate`

In `packages/interaction/command-mcp`:

- `parseMcpInput` gains `{ kind: 'migrate' }`; usage text gains
  `/mcp migrate                    import Claude Code MCP config into dsh`;
  the command description mentions migrate.
- The parse happens **before** the `mcpConnections` seam check: migrate is
  pure file I/O and must work when mcp-client never mounted (review finding
  9). `list` / `reconnect` / `disconnect` still require the seam.
- Handler: `paths = resolveDefaultMcpPaths()`;
  `migrateMcpServers({ sources: paths.claude, target: paths.target })` (§7.2);
  renders per-source counts, `added` / `kept` / `sourceConflicts`, the backup
  path when written, and the restart line. Result text must state:
  servers become visible only after restarting the session; the Claude Code
  files were not modified and may be removed manually afterward.
- Nothing to migrate → reports so and writes nothing.
- Unparseable target → the function throws; the handler renders it as a
  normal `/mcp` failure text (no stack).

## 7 Package and API changes

### 7.1 `packages/mcp/mcp-config/src/paths.ts` (new)

```ts
export interface ResolvedMcpPaths { dsh: string[]; claude: string[]; target: string }
export interface McpPathInputs { env?: Record<string, string | undefined>; cwd?: string; home?: string }
export function resolveDefaultMcpPaths(inputs?: McpPathInputs): ResolvedMcpPaths

export type McpServerNames =
  | { kind: 'absent' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; names: string[] }
export function readMcpServerNames(path: string): McpServerNames

export interface ClaudeOnlySource { path: string; names: string[] }
export function claudeOnlyServers(paths: Pick<ResolvedMcpPaths, 'dsh' | 'claude'>): ClaudeOnlySource[]
```

`readMcpServerNames` catches: absent file → `'absent'`; unreadable JSON or
`parseMcpServers` failure → `'invalid'` with the message; else `'ok'` with
the raw `mcpServers` key order. Names are never expanded or normalized here.
`claudeOnlyServers` = per-claude-file declared names minus the union of all
readable dsh files' names; invalid/absent files on either side are skipped.

### 7.2 `packages/mcp/mcp-config/src/migrate.ts` (new)

The package's only file-WRITING surface (review finding 5): the parse API in
`index.ts` and reads in `paths.ts` stay side-effect-free; the module
docstring of `index.ts` and the "no live registries" comment in
`invariant.ts` are updated to say so.

```ts
export interface McpMigrationSourceReport { path: string; servers: string[]; error?: string }
export interface McpMigrationResult {
  target: string
  added: string[]                                   // written by this run
  kept: string[]                                    // already in the target
  sourceConflicts: { name: string; kept: string; skipped: string }[]
  sources: McpMigrationSourceReport[]               // per source, argument order
  wrote: boolean                                    // false → no write, no backup
  backup?: string                                   // set when an existing target was overwritten
}
export function migrateMcpServers(options: { sources: string[]; target: string }): McpMigrationResult
```

Semantics, exact:

- Server entries are copied **raw** — the parsed `mcpServers` values
  verbatim. No `${VAR}` expansion, no name normalization, no transport
  reshaping (those belong to load time; round-tripping them would corrupt
  the config — review finding 6).
- Target read first: absent → create `{ mcpServers: {…} }`; existing object
  without `mcpServers` → gains the key; map-form → merged in place with
  existing keys first; array-form (`mcpServers: [ {…}, … ]`, supported by
  `parseMcpServers`) → one appended group object; other top-level keys
  preserved. An existing target that is unparseable or whose `mcpServers`
  fails validation throws with an actionable message and writes nothing.
- Name collisions: existing target names win (reported `kept`, never
  overwritten). Across sources, the first declaration wins; subsequent ones
  are reported in `sourceConflicts` with which source kept vs. skipped.
  Sources are read independently; an unreadable source contributes an error
  entry and does not abort the others.
- Write: `mkdirSync(dirname(target), { recursive: true })`; if the target
  existed, `copyFileSync` it to `${target}.bak` first (the backup duplicates
  any secrets in `env`/`headers` — one doc line says so); write
  `${target}.tmp-${process.pid}` then `renameSync` onto the target (same-dir
  rename is atomic); on write failure remove the temp file and rethrow with
  context. Nothing added → no write, `wrote: false`, no backup (idempotent).
- Claude Code sources are never modified.

All public symbols re-exported from `src/index.ts`.

### 7.3 `packages/interaction/command-mcp`

- `src/mcp.ts`: `McpInput` gains `{ kind: 'migrate' }`; `parseMcpInput`
  accepts exactly `migrate` with no extra tokens; `formatUsage` gains the
  line; new `formatMigrateReport(result: McpMigrationResult): string` and
  `formatDiscoveryNotice(sources: ClaudeOnlySource[], target: string): string`
  stay pure/render-only.
- `src/index.ts`: parse before the seam check; `list` appends the discovery
  notice when non-empty; `migrate` resolves `resolveDefaultMcpPaths()` and
  calls `migrateMcpServers`; command `description`/`input.hint` updated.
- Depends on `@dsh-cc/mcp-config` (`workspace:^`, added to both
  `dependencies` and `devDependencies`, mirroring mcp-config's own
  declaration style). CI installs per-package, so the declaration plus a
  `pnpm install --lockfile-only` lockfile sync are what
  `scripts/check-spec-deps.mjs` enforces.

### 7.4 `packages/bundle/cc-shell`

`index.ts` restructures per §4; `defaultMcpFiles()` is replaced by
`resolveDefaultMcpPaths()`; the existing registry-ownership child fiber and
per-server try/catch are untouched. No dependency change (mcp-config is
already a dependency).

## 8 Capability manifest and docs

`docs/claude-code-capabilities.yaml`:

- `commands.mcp`: evidence gains the new spec file(s); summary mentions the
  `migrate` subcommand; dimensions unchanged.
- New entry `mcp.config-discovery` in the mcp category: the dsh-vs-Claude-Code
  gating + escape hatch + migration surface has no Claude Code analog, so
  `deviation.kind: divergent` with the rule summarized, evidence anchored to
  the glue source and the new tests.

Then `pnpm docs:parity` regenerates `docs/cc-parity-matrix.md` and the README
parity block; all three land in the same commit. `pnpm check:capabilities` and
`pnpm check:parity` must pass pre-commit.

## 9 Review log

deep-reasoner cold review verdict: revise — 9 findings, dispositions:

1. session-start notice is racy/mis-scoped → **kept**, once-per-process flag;
   justified by visibility (the TUI cannot see `logger.warn`); worst case is
   a cosmetic duplicate-free miss.
2. cordis `mcpConfigDiscovery` service from a LOADING fiber → **cut**; `/mcp`
   computes state directly from the shared fs helpers.
3. gate on bare existence → **tightened** to ≥1 declared server (§4.2).
4. near-universal `~/.claude.json` → **escape hatch** `mcpLoadClaudeFiles`
   (§4).
5. mcp-config "no side effects" contract → module docstring + invariant
   comment updated; writes isolated to `migrate.ts`.
6. migration write hardening → atomic rename, `mkdir -p`, raw entries, `.bak`
   duplicates-secrets note, per-source conflict report (§7.2).
7. `chdir`/env-mutation tests → injectable `resolveDefaultMcpPaths` shared by
   all three packages (§3).
8. `CLAUDE_CONFIG_DIR` vs `~/.claude.json` → `.mcp.json` relocates with the
   dir; the state file stays home-anchored (§3).
9. Minor: cut from `/mcp` list when nothing to report; migrate exempt from
   the seam check (§6); run `check:capabilities` before committing (§8).

## 10 Test plan (TDD: failing tests first, then implementation)

`packages/mcp/mcp-config/tests/` (new `paths.spec.ts`, `migrate.spec.ts`) —
all against tmp dirs via injected `{ env, cwd, home }`, no process mutation:

- paths: classification with/without `DSH_HOME`/`CLAUDE_CONFIG_DIR`; target
  follows `DSH_HOME`.
- `readMcpServerNames`: absent / invalid JSON / missing `mcpServers` / ok
  (map + array forms, order kept, `${VAR}` not expanded).
- `claudeOnlyServers`: dsh union subtracted per claude file; empty result
  when claude files absent or fully shadowed.
- `migrateMcpServers`: create-from-absent; merge into map; append-group into
  array-form; `kept` on target collision (target entry bit-identical);
  cross-source first-wins reported; unreadable source tolerated; unparseable
  target throws + leaves target bytes unchanged; `.bak` written only when
  overwriting; re-run is a no-write (`wrote: false`); other top-level keys
  preserved; raw `${VAR}` entries byte-identical after migration.

`packages/bundle/cc-shell/tests/` (new `mcp-gating.spec.ts`; existing
`mcp-registry.spec.ts` untouched and expected to stay green):

- gated: `DSH_HOME` tmp file with one fixture server + claude tmp files with
  another → only the dsh server mounts; a warn is logged; the
  session-start notice listener is registered and injects exactly once
  (emit `agent/session-start` twice with a stub agent exposing `inject`).
- ungated: no dsh file → claude fixture server mounts (backward compat).
- empty-dsh: dsh file present but `mcpServers: {}` → claude still loads.
- escape hatch: `mcpLoadClaudeFiles: true` → claude loads despite gating.
- machine-pollution guard: point `cwd`/`home` at tmp dirs through
  `resolveDefaultMcpPaths` inputs so the host's real configs never leak in.

`packages/interaction/command-mcp/tests/command-mcp.spec.ts` (extend):

- parse: `migrate`, `migrate extra` → usage, list/reconnect/disconnect
  unchanged.
- migrate runs with `mcpConnections` absent (seam check must not gate it).
- handler against tmp `HOME`/`DSH_HOME`/`CLAUDE_CONFIG_DIR`: full report
  text (added/kept/conflict/backup/restart line) and no-write case.
- list appends the notice line only when gating is in effect AND claude-only
  servers exist; absent, ungated, or fully-migrated → no line.

## 11 Verification

1. `npx vitest run` for the three touched packages; then the full suite
   (root config change risk: none planned, but the file's own rules say
   harness aliases are whole-repo side effects — we add none).
2. `node scripts/check-spec-deps.mjs`, `pnpm check:capabilities`,
   `pnpm check:parity`, `pnpm check:publish` (command-mcp gained a dep).
3. Typecheck/lint per repo scripts; pre-commit hooks green.
4. Commit on `worktree-mcp-config`, push, open a PR. Commit message states
   the observable behavior change: dsh-native config now shadows Claude Code
   MCP config with a session notice and `/mcp migrate` import path.
