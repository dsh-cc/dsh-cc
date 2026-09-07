# Plugin management for dsh-cc (install / uninstall / enable / disable / update / marketplaces)

- **Status:** approved design (Staff-Engineer cold review: PROCEED-WITH-CHANGES; all blocking findings closed by on-machine probes).
- **Date:** 2026-09-06
- **Scope:** full plugin CRUD for Claude Code plugins from inside dsh-cc sessions, implemented as dsh-cc packages only. The deepseek-harness repo is read-only (user directive).

## 1. Problem and goals

dsh-cc can already *load* Claude Code plugins (`packages/compat/cc-plugin-loader`) and *display* the mounted set (`/plugin`, `/reload-plugins`). It cannot **manage** them: no install, uninstall, enable, disable, update, or marketplace operations. Users must drop out to the real `claude` CLI, which defeats the compat layer.

**Goals**

- G1. In-session slash commands cover the CC management surface: install / uninstall / enable / disable / update / list and marketplace add / remove / list / update.
- G2. Byte-shape interoperability: dsh-cc reads and writes the *same* on-disk state files as the real Claude Code CLI (v2.1.236), so both tools observe each other's changes immediately and neither corrupts the other.
- G3. TDD throughout: every behavior in this plan has a failing test before its implementation.
- G4. Live effect: after any mutation the running session reflects the new state via the existing `ccPlugins.rescan()` seam.

**Non-goals (v1)**

- Interactive `/plugin` menu UI (CC opens a TUI panel; we keep text output). Existing deviation, now documented.
- Interactive trust/consent dialogs for marketplace hooks/MCP servers. We print a static security warning line instead; the capability manifest claims `behavioral: partial` for this surface.
- Standalone argv parity (`claude plugin ...`): argv parsing belongs to the harness CLI, which is read-only.
- CC surface items: `details`, `eval`, `init|new`, `prune`, `tag`, `validate`, `--config userConfig`, `--sparse`, `--keep-data`, `--prune`, `--available` JSON listing, `managed` (policy) scope.
- Orphan-cache sweeping: we write the `.orphaned_at` marker; the real CC CLI's sweep (or the user's `rm`) reclaims disk.
- Command aliases CC ships (`plugin|plugins`, `install|i`, `uninstall|remove`, `remove|rm`).

## 2. Verified ground truth

### 2.1 dsh-cc (this repo, fresh recon)

- D1. Loader: `packages/compat/cc-plugin-loader` (`@dsh-cc/plugin-loader`) parses `.claude-plugin/plugin.json` and mounts skills/agents/commands/hooks/mcp/settings via optional structural seams (`ctx.get(...)`). Exports `resolveClaudeHome`, `discoverCcPluginRoots`, `mountCcPlugin`, `parsePluginManifest` (src/index.ts:36,105).
- D2. Discovery = `enabledPlugins` (union over CC settings files: user `<claudeHome>/settings.json`, project `<cwd>/.claude/settings.json`, local **git main checkout** `.claude/settings.local.json`) intersected with `installed_plugins.json` under `<claudeHome>/plugins/` (src/discovery.ts:53-61,116-131). Read-only; bare keys without `@` are skipped with a warning.
- D3. Runtime wiring: `packages/bundle/cc-shell/src/ccPlugins.ts` registers the `ccPlugins` cordis service (`list()`, `rescan()`), preset-anchored at `packages/preset/cc/agent.cordis.yml` (`- id: cc-shell-glue`, ~L334-338). `rescan()` re-reads disk state live.
- D4. Commands exist read-only: `packages/interaction/command-plugin` registers `/plugin` (mounted list) and `/reload-plugins` via `ctx.commands.register`, probing the `ccPlugins` seam structurally (src/index.ts:62-71). Pattern for all `packages/{interaction,session}/command-*` packages.
- D5. Gates: `vitest run`, `tsc -b`, ≤500 lines per source `.ts` (`check:size`), capability manifest + regenerated parity docs in the same commit for any CC-surface change (`check:capabilities`, `check:parity`); manifest rows with `mounted: true, plane: preset` need anchored evidence `- id: <row>` from `agent.cordis.yml`; `behavioral: divergent` forbids `ux: full` (validator rules I3/I4/I7).
- D6. Settings cascade (dsh): user/project/local/flag/policy; kebab-case namespaces; CC camelCase keys bridged by a `CC_KEY_ALIASES` whitelist (only `statusLine` today). **Decision:** `enabledPlugins`/`extraKnownMarketplaces` do *not* become dsh settings namespaces — see §4.

### 2.2 Claude Code behavior (probed on this machine, real `claude` v2.1.236 CLI with tmp `HOME` + `CLAUDE_CONFIG_DIR`)

State root: `<claudeHome>/plugins/` with `known_marketplaces.json`, `installed_plugins.json`, `marketplaces/` (git clones), `cache/<marketplace>/<plugin>/<version>/` (materialized copies), `data/<id>/` (persistent plugin data).

- C1. `marketplace add <dir>` → `known_marketplaces.json` entry `{ "source": { "source": "directory", "path": "<abs>" }, "installLocation": "<abs>", "lastUpdated": ISO }` (no clone; `installLocation` is the dir itself) **plus** a declaration in scope `settings.json`: `extraKnownMarketplaces: { "<name>": { "source": {...} } }`. `--scope user|project|local` picks the settings file (default user). GitHub sources are `{ "source": "github", "repo": "owner/repo" }` with a real clone at `<plugins>/marketplaces/<name>`; git URLs are `{ "source": "git", "url": "..." }`. Optional `"autoUpdate": true` observed on real entries; v1 never writes it.
- C2. `install <id>` (default scope user) copies the plugin dir to `<plugins>/cache/<mkt>/<plugin>/<version|unknown>/`, appends to `installed_plugins.json` (`{ "version": 2, "plugins": { "<id>": [ { "scope", "installPath", "version", "installedAt", "lastUpdated", "gitCommitSha"? , "projectPath"? } ] } }`), and writes `enabledPlugins: { "<id>": true }` in the scope's settings file. One array entry **per scope**; project/local entries carry `"projectPath": <realpath(cwd)>`.
- C3. `enable/disable` write `enabledPlugins["<id>"] = true|false` in exactly one scope file; the key is **kept** on disable. Allowed even at a scope where the plugin has no install entry. CLI default scope is *auto-detect*.
- C4. `uninstall` (default scope user, scope-surgical): removes that scope's array entry and deletes the `enabledPlugins` key **in that scope's file only** (an empty `enabledPlugins: {}` object remains). When the removed entry was the last reference to a cache dir, the dir is **not deleted** — a `.orphaned_at` file containing epoch milliseconds as ASCII (e.g. `1788700858583`, no newline) is written into it; other content is left behind.
- C5. Uninstall safety guard: refusing message, verbatim — `Plugin "<id>" is enabled at project scope (.claude/settings.json, shared with your team). To disable just for you: claude plugin disable <id> --scope local` (we render with `/plugin disable ...` in-session).
- C6. `marketplace remove <name>` removes the known-marketplaces key and the settings declaration at all scopes where present, and uninstalls every plugin installed from that marketplace (docs-stated; v1 applies the C5 guard per plugin and refuses the whole remove if any installed plugin is enabled at project scope).
- C7. `update` (default scope user): after `marketplace update`, a version bump materializes `cache/<mkt>/<plugin>/<newVersion>/` alongside the old dir (old dir orphaned only when unreferenced), and only the targeted scope's installed entry is rewritten (`version`, `installPath`, fresh `installedAt` + `lastUpdated`). Message: `Plugin "<name>" updated from <old> to <new> for scope <s>. Restart to apply changes.`
- C8. `marketplace update [name]`: all marketplaces when name omitted; directory sources just refresh `lastUpdated`.
- C9. Effective enablement (for `list`, must match loader discovery): scan `local → project → user`, first defined boolean wins; absent everywhere ⇒ disabled. When scopes disagree, CC's `list` notes the override.
- C10. `~/.claude/plugins/known_marketplaces.json` defaults to `{}`; `installed_plugins.json` defaults to `{ "version": 2, "plugins": {} }`. Settings files are strict JSON, 2-space indented, trailing newline.
- C11. Settings round-trip: CC rewrites the whole settings file but preserves unrelated keys (guarded by an explicit test, S1).

## 3. Command surface (in-session grammar)

All management happens through the existing `/plugin` command, which grows subcommands (CC's slash surface is the same shape):

```
/plugin                                   # unchanged: mounted-plugins view + hint footer
/plugin list [--enabled|--disabled]
/plugin install <plugin[@mkt]> [--scope user|project|local]   # default user
/plugin uninstall <plugin[@mkt]> [--scope user|project|local] # default user; C5 guard
/plugin enable <plugin[@mkt]> [--scope user|project|local]    # default: auto-detect
/plugin disable <plugin[@mkt]> [--scope user|project|local]   # default: auto-detect
/plugin update <plugin[@mkt]> [--scope user|project|local]    # default user
/plugin marketplace list
/plugin marketplace add <source> [--scope user|project|local] # default user
/plugin marketplace remove <name>
/plugin marketplace update [name]
```

- `<source>`: absolute/relative directory containing `.claude-plugin/marketplace.json`, GitHub shorthand `owner/repo`, or a git URL (`https://…`, `git@…`).
- Auto-detect (enable/disable): the unique scope where the plugin is installed wins; multiple ⇒ error listing the scopes.
- Install id resolution: exact `<name>@<mkt>`; a bare `<name>` resolves iff exactly one known marketplace declares it, else a not-found/ambiguous error. The same resolution applies to *installed* keys for uninstall/enable/disable/update.
- Every successful mutation prints a static warning footer for `install`/`marketplace add` of remote sources: `Note: plugins can add hooks and MCP servers; only install from sources you trust.`
- After any mutation, the command calls `ccPlugins.rescan()` and tail-prints the reload summary line (existing renderer), satisfying G4.

### Success/output strings (frozen for tests)

| Command | Exact first line |
|---|---|
| install | `Installed plugin: <id> (scope: <s>, version: <v>)` |
| uninstall | `Uninstalled plugin: <id> (scope: <s>)` |
| enable | `Enabled plugin: <name> (scope: <s>)` |
| disable | `Disabled plugin: <name> (scope: <s>)` |
| update (changed) | `Plugin "<name>" updated from <old> to <new> for scope <s>. Restart to apply changes (or /reload-plugins).` |
| update (unchanged) | `Plugin "<id>" is already up to date (scope: <s>).` |
| marketplace add | `Added marketplace: <name> (<source-kind>, declared in <s> settings)` |
| marketplace remove | `Removed marketplace: <name> (also uninstalled <k> plugin installation(s))` |
| marketplace update | `Updated marketplace: <name>` / `Updated <k> marketplaces.` |
| list | see renderer below |

`/plugin list` renderer (per installed, cwd-visible entry — user-scope entries always, project/local entries only when `projectPath` realpaths to the session cwd):

```
Installed Claude Code plugins:

  ❯ <id>
    Version: <v>
    Scope: <s>
    Status: ✔ enabled | ✘ disabled
    Overrides: <one line per C9 disagreement>   # omitted when scopes agree
```

`/plugin marketplace list` renderer: `Configured marketplaces:` then per entry `  ❯ <name>` / `    Source: Directory (<path>) | GitHub (<owner>/<repo>) | Git (<url>)`, matching the probed CC text.

### Error catalog (exact strings; all are typed errors in core, rendered as one-line text)

- `Unknown plugin "<arg>". Installed: <id1>, <id2>` (or `…none` when empty)
- `Plugin name "<name>" is ambiguous: <id1>, <id2>. Use the full <name>@<marketplace> id.`
- `Plugin "<id>" is not installed.`
- `Plugin "<id>" is already installed at scope <s> on this machine.`
- `Plugin "<id>" has no installation at scope <s> (installed at: <s1>, <s2>).`
- `Plugin "<id>" is installed at multiple scopes (<s1>, <s2>); pass --scope.` (auto-detect failure)
- `Unknown scope "<s>". Expected user, project, or local.`
- C5 guard, verbatim semantics: `Plugin "<id>" is enabled at project scope (.claude/settings.json, shared with your team). To disable just for you: /plugin disable <id> --scope local`
- `Unknown marketplace "<name>". Known: <n1>, <n2>` (or `…none`)
- `Marketplace "<name>" is already registered from a different source (<existing-kind>).`
- `Marketplace "<name>" does not declare a plugin named "<p>".`
- `Marketplace source "<src>" is not a readable directory, owner/repo, or git URL.`
- `Marketplace at <src> has no readable .claude-plugin/marketplace.json (<detail>).`
- `git <verb> failed for <target>: <first stderr line>`
- `State file <path> is malformed JSON: <detail>` (never silently rewritten)

## 4. Architecture

**A. Single source of truth = CC's files.** Mutations write `known_marketplaces.json`, `installed_plugins.json`, and the per-scope `settings.json` `enabledPlugins`/`extraKnownMarketplaces` sections directly. No dsh settings namespace is introduced (D6): the loader already bypasses the cascade for reads, so a second representation would fork the truth. Discovery (D2) is unchanged, so state written by the manager is immediately visible to `rescan()`.

**B. New pure package `packages/compat/cc-plugin-manager/` (`@dsh-cc/plugin-manager`)** — no cordis, no imports beyond node + `@dsh-cc/plugin-loader` (reuses `resolveClaudeHome`, D1). Every file ≤500 lines.

```
src/
  index.ts            # createCcPluginManager factory + CcPluginManager interface (API below)
  types.ts            # KnownMarketplaces, InstalledPlugins v2, scope/entry types, Githubish source union
  errors.ts           # typed errors carrying the §3 exact strings
  paths.ts            # claudeHome, pluginsStateDir, settingsPath(scope) — local = git MAIN checkout
                      #   .claude/settings.local.json (probe C1/C3: matches loader, realpath applied)
  state-store.ts      # atomic JSON load/save (tmp+rename), missing-file defaults, unknown-key preservation
  resolve-id.ts       # plugin id parsing + installed/declared name resolution
  list.ts             # C9 effective enablement + cwd-filtered rendering rows
  toggles.ts          # enable/disable (auto-detect, C3)
  install.ts          # install/uninstall (C2/C4/C5), cache materialization, .orphaned_at
  update.ts           # plugin update (C7)
  marketplace.ts      # add/remove/list/update (C1/C6/C8)
  git.ts              # GitRunner contract: runGit(args, cwd) → {code, stdout, stderr};
                      # default impl shells to git with a 60s timeout; clones go to a tmp dir
                      # then rename into marketplaces/<name> (no half-clones)
```

API (all mutations internally serialized through a per-instance promise queue — in-process lost-update protection; cross-process races are out of scope, CC does not lock either):

```ts
createCcPluginManager({ claudeHome?, cwd, runGit?, now? }): CcPluginManager
interface CcPluginManager {
  list(): Promise<PluginListEntry[]>
  enable(arg, opts?): Promise<ScopeResult>
  disable(arg, opts?): Promise<ScopeResult>
  install(arg, opts?): Promise<InstallResult>
  uninstall(arg, opts?): Promise<ScopeResult>
  update(arg, opts?): Promise<UpdateResult>          // { fromVersion, toVersion } | upToDate
  listMarketplaces(): Promise<MarketplaceEntry[]>
  addMarketplace(source, opts?): Promise<AddedMarketplace>
  removeMarketplace(name): Promise<RemovedMarketplace> // includes uninstalled count
  updateMarketplaces(name?): Promise<string[]>         // names refreshed
}
```

**C. Commit-point ordering** (crash-safe, leak-safe):

- install: (1) read+validate marketplace → (2) copy into cache dir → (3) write `enabledPlugins` → (4) write `installed_plugins.json` (commit). Crash between (2)-(4) leaves an unreferenced cache dir (swept later) or an enabled-but-not-installed flag, which discovery's intersection ignores. Tests inject failures at each step and assert the invariants.
- uninstall: (1) C5 guard → (2) remove scope's `enabledPlugins` key → (3) remove scope's installed entry (commit) → (4) `.orphaned_at` on cache dirs left unreferenced.
- marketplace remove: (1) pre-flight guard over installable plugins → (2..n) per-plugin uninstall sequence → (n+1) remove clone dir (git-backed only) → (n+2) remove `extraKnownMarketplaces` at scopes where present → (n+3) remove known-marketplaces key (commit).
- update: materialize new cache dir → rewrite the targeted installed entry. Old dir orphaned only when unreferenced.

**D. Cordis wrapper (cc-shell)**: `packages/bundle/cc-shell/src/ccPluginManager.ts` registers a `ccPluginManager` service (structural, optional — consumers follow the D4 probe pattern) bound to `resolveClaudeHome()` + session cwd; wired in `ccPlugins.ts`'s composition and preset-anchored (`agent.cordis.yml`, same `cc-shell-glue` block).

**E. Commands (extend `packages/interaction/command-plugin`)**:

```
src/
  index.ts            # register /plugin (subcommand dispatch) + /reload-plugins (unchanged)
  plugin.ts           # existing mounted-view/reload renderers (unchanged)
  subcommands.ts      # argv parsing → {verb, args, scope}  (pure)
  manage.ts           # handlers: resolve ccPluginManager seam structurally, call core, rescan
  render-manage.ts    # list/marketplace/result renderers (pure)
```

Unknown/absent seam ⇒ graceful text (existing pattern). `/plugin` bare keeps today's mounted view plus footer `Manage: /plugin install|uninstall|enable|disable|update|list · /plugin marketplace add|remove|list|update`.

**F. Capability manifest** (`docs/claude-code-capabilities.yaml`, same commit): `commands.plugin` updated description (`/plugin [subcommand]`), `behavioral: partial` + `ux: partial` with deviation notes (no interactive menu; static trust warning instead of interactive consent) — validator I3 requires ux ≤ behavioral. New row `plugins.management` (category `plugins`, plane `preset`, `mounted: true`, `behavioral: full`, anchored evidence `- id: cc-shell-glue` + new unit tests) with a note that interop is file-format parity. `plugins.loader` unchanged. Regenerate with `pnpm docs:parity`; `check:capabilities`/`check:parity` must pass.

## 5. Slices (TDD: failing test(s) → implementation → package tests + typecheck green)

- **S1 — core state I/O.** Scaffold `packages/compat/cc-plugin-manager` (package.json/tsconfig/vitest conventions copied from `cc-plugin-loader`); `types.ts`, `errors.ts`, `paths.ts`, `state-store.ts`. Fixtures capture §2.2 byte shapes verbatim under `tests/fixtures/` (known-marketplaces directory+github entries, installed v2 multi-scope, settings before/after). Tests: missing-file defaults; unknown-key + key-order preservation round-trip; atomic write (no tmp residue); local-scope path = git main checkout from a linked worktree (fixture fake dirs); malformed JSON error (C10/C11).
- **S2 — enable/disable/list.** `resolve-id.ts`, `list.ts`, `toggles.ts`. Tests: C3 (single-scope write, key kept on disable, allowed without install entry, auto-detect unique/multiple/absent), C9 effective enablement incl. override rows, cwd filtering of project entries (realpath), id resolution exact/unique/ambiguous/unknown error strings.
- **S3 — marketplaces.** `git.ts` (fake-runner-first design), `marketplace.ts`. Tests: C1 directory add (known + settings declaration, default user + explicit scopes), owner/repo → correct clone args against fake git, clone failure cleanup, already-registered same/different source, malformed marketplace.json, list renderer fields, C8 update (directory lastUpdated bump; git pull invoked), C6 remove incl. multi-plugin cascade refusal via C5 pre-flight.
- **S4 — install/uninstall/update.** `install.ts`, `update.ts`. Tests: C2 (cache materialization, entry fields incl. `gitCommitSha` from fake git rev-parse, enabledPlugins write), per-scope entries, already-installed, unknown plugin/marketplace, C4 uninstall semantics incl. `.orphaned_at` epoch content only when unreferenced, C5 refusal exact string, C7 version-bump layout + per-scope rewrite, up-to-date no-op, §4.C injected-failure invariant tests.
- **S5 — command surface + wiring.** `command-plugin` new files; cc-shell `ccPluginManager` service + preset anchor; seam-absent graceful text; parser table tests (every grammar row incl. bad input); handler tests with a fake manager seam asserting rescan is invoked after mutations; exact §3 output strings.
- **S6 — alignment + gates.** Cross-package integration: manager writes state in a tmp `CLAUDE_CONFIG_DIR`, then loader `discoverCcPluginRoots` (D1/D2) must return exactly the enabled, installed-for-this-cwd plugins (the interop money test). Capability manifest + `pnpm docs:parity` artifacts. Full gate suite.

## 6. Verification plan

- Per-slice: `pnpm vitest run <pkg>` + `pnpm typecheck` (and `check:size`).
- S6 gates: `pnpm test`, `pnpm typecheck`, `pnpm check:capabilities`, `pnpm check:parity`, `pnpm check:size`, `pnpm check:exports`.
- Smoke (manual, opt-in): in a scratch `HOME`/`CLAUDE_CONFIG_DIR`, run `dsh cc-tui` and drive `/plugin marketplace add` + `/plugin install` + `/plugin disable`; then open the **real** `claude` CLI in the same scratch home and confirm `claude plugin list` reflects the dsh-cc-written state (and vice versa).
- Behavior observation (per repo "config is prompt" discipline): the verifiable claim is "management commands mutate CC state files in v2.1.236 byte shape and live-rescan reflects them" — demonstrated by S6 tests + smoke transcript in the PR.

## 7. Open questions / confirm-in-slice

- O1. Exact CC auto-detect rule for enable/disable default scope is inferred (unique installed scope). If S2 fixtures ever show CC picking differently, follow the probe.
- O2. `projectPath` on local-scope installed entries is assumed (project-scope verified). S4 fixture notes if real CC differs.
- O3. CC `marketplace remove` plugin-uninstall refusal granularity is approximated by our pre-flight C5 guard (conservative: refuses the whole operation). Acceptable v1 divergence (documented in manifest deviation notes if it survives review).
- O4. `.orphaned_at` sweep cadence (`.last_inuse_sweep`) is CC-internal; v1 never deletes orphaned dirs.
