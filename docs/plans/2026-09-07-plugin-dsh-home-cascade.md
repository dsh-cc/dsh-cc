# Plugin state split: compat-read `~/.claude`, write `~/.dsh`

- **Status:** approved design — Staff-Engineer cold review returned APPROVE-WITH-CHANGES; every finding is closed by an explicit ruling in this revision (§3.1 default-chain, §3.4, §4.3, §4.5, §4.7, §5, §7).
- **Date:** 2026-09-07
- **Scope:** relocate every dsh-cc plugin-management write out of the Claude home (`$CLAUDE_CONFIG_DIR` / `~/.claude`) and into the harness home (`$DSH_HOME` / `~/.dsh`), keep Claude-home state fully readable for Claude Code compatibility, define per-key dsh-wins merge semantics when both homes carry state, and audit all other `~/.claude` touchpoints for the same defect. In-scope packages: `packages/compat/cc-plugin-manager`, `packages/compat/cc-plugin-loader`, `packages/bundle/cc-shell` wiring, docs and capability manifest.

## 1. Problem and goals

Today `/plugin` management (PR #3, design doc `2026-09-06-plugin-management.md`) implements byte-parity against a *single* state root, `$CLAUDE_CONFIG_DIR ?? ~/.claude` (`cc-plugin-manager/src/index.ts:95`). Every mutation lands inside the other product's home directory: state files (`plugins/known_marketplaces.json`, `plugins/installed_plugins.json`), marketplace clones (`plugins/marketplaces/`), materialized cache (`plugins/cache/`), orphan markers, and user-scope settings (`~/.claude/settings.json`: `enabledPlugins` / `extraKnownMarketplaces`). That is wrong for a tool with its own identity:

- **dsh-cc pollutes the Claude home.** Every other dsh-cc subsystem rooted at `$DSH_HOME` long ago: the settings cascade's user layer is `~/.dsh/settings.json`, the MCP migration target is `~/.dsh/.mcp.json`, memory/launcher/TUI/doctor state all live under `~/.dsh`.
- **Internal inconsistency.** The settings cascade's writable user layer is `~/.dsh/settings.json`, while `/plugin enable` writes `enabledPlugins` into `~/.claude/settings.json` — the same conceptual "user settings" split across two homes depending on which feature touches them.

**User directive (the contract):**

- R1. Reads stay Claude-Code compatible: state under `~/.claude` remains visible.
- R2. Writes go to `~/.dsh`, never `~/.claude`.
- R3. When both homes carry the same content, `~/.dsh` overrides `~/.claude` (per key).
- R4. Audit other features for the same defect; fix whatever is found.

**Goals**

- G1. `/plugin` mutations (install / uninstall / enable / disable / update / marketplace add / remove / update) perform zero writes under the Claude home; all writes land under the dsh home or the unchanged per-repo `.claude` scope files.
- G2. Discovery (`cc-plugin-loader`) and listing (`/plugin list`, `/plugin marketplace list`) present the merged view: Claude-home state readable (R1), dsh-home entries override per key (R3).
- G3. Backward compatibility of the option surface: no existing call site, glue config, or test rig breaks. A missing `dshHome` option falls back to `claudeHome` (legacy single-root semantics), so pre-existing specs' behavior assertions hold byte-identically with zero rig edits.
- G4. TDD throughout: every behavior below lands with a failing test first.
- G5. Capability manifest and parity docs updated in the same PR (validator rules I3/I4/I7).

**Non-goals**

- No bulk migration of existing `~/.claude` plugin state into `~/.dsh` (R1 makes it unnecessary; see §7).
- No settings-cascade changes; in particular the cascade user layer is *not* extended to compat-read `~/.claude/settings.json` (deliberate, existing behavior — recorded in §2.2).
- No new read-compat layers for user skills / output-styles / agents (audit findings F1–F3 in §2.2, recorded as follow-ups).
- No `/plugin migrate` command and no interactive provenance UI (a `--json` provenance annotation is cheap but unrequested; revisit when a user asks).
- CC surface items already deferred by PR #3 stay deferred (interactive menu, trust dialogs, `details/eval/init/prune/tag/validate`, `managed` scope, orphan sweeping).

## 2. Verified ground truth

### 2.1 dsh-cc current state (fresh recon in this worktree)

- **D1. Single root.** Manager deps resolve `claudeHome = options.claudeHome ?? $CLAUDE_CONFIG_DIR ?? ~/.claude` (`cc-plugin-manager/src/index.ts:95`); the state layout `<claudeHome>/plugins/{known_marketplaces.json, installed_plugins.json, marketplaces/, cache/, data/}` comes from `pluginsStatePaths` (`paths.ts:50-60`). The loader resolves the same home via `resolveClaudeHome` (`cc-plugin-loader/src/discovery.ts:69-74`).
- **D2. Scope settings files** (`paths.ts:140-149`): user → `<claudeHome>/settings.json`; project → `<cwd>/.claude/settings.json`; local → git main checkout `.claude/settings.local.json` (worktree-aware walk). Project/local files are per-repo Claude-Code parity surfaces and **stay exactly as they are** — they are not user-home state.
- **D3. Writer inventory (each of these writes into the Claude home today):**
  - `install.ts:122-185` — materializes into `<claudeHome>/plugins/cache/<mkt>/<name>/<version>/`, sets `enabledPlugins[id] = true` in the scope file, appends the `installed_plugins.json` entry.
  - `uninstall.ts:39-67` — removes the scope's `enabledPlugins` key (C4), removes the scope's array entry, `.orphaned_at`-marks an unreferenced cache dir.
  - `update.ts:32-70` — materializes the new cache dir, rewrites the scope entry, orphan-marks the old dir.
  - `toggles.ts:55-67` — writes `enabledPlugins[id] = true|false` into the resolved scope file (key kept on disable, C3).
  - `marketplace.ts` — add clones into `marketplaces/` then writes the known entry + `extraKnownMarketplaces` declaration; update runs `git -C <installLocation> pull --ff-only` (a write *inside* `~/.claude` when the clone lives there); remove cascade-uninstalls, deletes the clone dir, strips declarations at all scopes, removes the known key.
  - `list.ts:67-104` — read-only; C9 effective enablement scans local → project → user, first defined boolean wins; project/local rows filtered to the session cwd by `projectPath` realpath.
- **D4. Loader discovery** (`discovery.ts:116-176`): enabled keys cascade over `[<claudeHome>/settings.json (user), <cwd>/.claude/settings.json (project), <mainRoot>/.claude/settings.local.json]` with later files overriding per key; installed keys come from `<claudeHome>/plugins/installed_plugins.json` (per key, latest `lastUpdated` wins); discovery = enabled ∩ installed. It reads settings files directly — it does **not** consume the settings cascade provider.
- **D5. Wiring.** `createSessionCcPluginManager()` passes `claudeHome: resolveClaudeHome()` (`ccPluginManager.ts:37-43`) — the one explicit resolution site. `CcPluginsService` forwards only defined options into `discoverCcPluginRoots` (`ccPlugins.ts:137-144`), so with no glue config the loader's defaults apply. Glue config has `pluginDirs` / `mcpConfigFiles` / `mcpLoadClaudeFiles` only; `CcPluginsServiceOptions.claudeHome` is a documented public knob.
- **D6. Loader↔manager agreement contract.** `cc-plugin-manager/tests/alignment.spec.ts` constructs both sides against the same fixtures and asserts discovery matches manager listing — the established seam to extend with dual-home scenarios.
- **D7. Harness-home idiom.** `resolveDshHome(configured?, env?)` from `@deepseek-ai/dsh-home-paths` (explicit path → `$DSH_HOME` → `~/.dsh`; tilde-expanded; resolved absolute). Already used by settings-cascade, mcp-config, memory, output-styles, launcher, TUI. Dependency declaration pattern: runtime range `">=0.1.1-rc.2"` in `dependencies` plus the workspace `link:../../../../deepseek-harness/packages/util/home-paths` in `devDependencies` (copied from `settings-cascade/package.json`).
- **D8. CC-shape parity rules from the interop spec** (`2026-09-06-plugin-management.md` §2.2): C3 key-kept-on-disable; C4 uninstall key-removal + orphan marker; C5 project-scope guard; C10 state-file defaults (`{}`, `{version:2,plugins:{}}`); C11 surgical settings writes preserving unrelated keys. These remain the byte contract for every file under the Claude home (which we now only read) and for single-root mode.

### 2.2 Audit of every other `~/.claude` touchpoint (R4)

Repo-wide scan for writes under the OS-home `.claude` (source, not tests: write syscalls, `mkdir`, atomic-save helpers) — independently re-verified during the cold review. Verdict column: ✅ compliant · 🔧 fixed by this PR · 📌 recorded follow-up (read-side compat gap, not a write defect — deliberately separate PRs).

| Feature / surface | Package | Reads | Writes | Verdict |
|---|---|---|---|---|
| Plugin state + mgmt | cc-plugin-manager, cc-plugin-loader, cc-shell | `~/.claude` (single root) | `~/.claude` | 🔧 this PR |
| User settings layer | settings-cascade | `~/.dsh/settings.json` (+ project/local `.claude` files) | `~/.dsh/settings.json` | ✅ already dsh-rooted; does *not* compat-read `~/.claude/settings.json` — unchanged, documented |
| MCP config | mcp-config, cc-shell | `<claudeDir>/.mcp.json`, `~/.claude.json` (compat + gating notice) | `~/.dsh/.mcp.json` migration target only | ✅ precedent for exactly this policy |
| `~/.claude.json` trust/state | — | read (mcp gating) | nobody writes it | ✅ |
| User agents layer | preset/claude-code-agents, subagent/task | `~/.claude/agents` is the *only* user layer; no `~/.dsh/agents` exists | no writer | 📌 F1 follow-up (adding a dsh user layer interacts with the plugin-agent shadowing design — separate decision) |
| User skills | skill/skill-claude-code | `$DSH_HOME/skills`, project `.claude/skills`, legacy project `.claude/commands` | no writer | 📌 F2 follow-up (`~/.claude/skills`, `~/.claude/commands` not compat-read) |
| Output styles | cc-output-styles | `$DSH_HOME/output-styles`, project `.claude/output-styles` | no writer | 📌 F3 follow-up (`~/.claude/output-styles` not compat-read) |
| Memory | memory/memory | `$DSH_HOME/memory/…`, project `.claude/memory` overlay | `$DSH_HOME/memory/…` | ✅ |
| Doctor report | command-doctor | — | `~/.dsh/tui/doctor-report.json` | ✅ |
| Launcher/TUI/history/sessions | launcher, ui/tui | `$DSH_HOME` | `$DSH_HOME` | ✅ |
| Per-repo `.claude` (project settings, local settings, worktrees under `.claude/worktrees/`, project CLAUDE.md, plugin scope files) | settings-cascade, tool-git-worktree, command-init, plugin manager scope writes | yes | yes | ✅ per-repo parity — out of scope by definition (CC must share these files) |

**Conclusion.** The plugin manager trio is the *only* user-home `~/.claude` writer; R4's fix surface is exactly this PR. F1–F3 are read-layer compat gaps (nothing is being written to the wrong place); each is a small, separable additive change that deserves its own probe-verified PR rather than riding along here.

### 2.3 Claude Code behavior that bounds this design

The interop spec (`2026-09-06-plugin-management.md` §2.2, probe-verified against CC v2.1.236) stays authoritative for byte shapes. New dsh-side facts: the dsh plugin state root mirrors the CC layout — `<dshHome>/plugins/{known_marketplaces.json, installed_plugins.json, marketplaces/, cache/, data/}` and `<dshHome>/settings.json` carry the same shapes, with **one dsh-private extension**: a `null` value in the dsh `known_marketplaces.json` tombstones a Claude-home entry (§3.5, §4.6).

## 3. Core design: two homes, one merged view

### 3.1 Homes, resolution, and the default chain

- **dshHome** (write root) resolution chain: explicit `dshHome` option → explicit `claudeHome` option (legacy single-root semantics) → `resolveDshHome()` (`$DSH_HOME` → `~/.dsh`).
- **claudeHome** (compat read root) resolution chain, unchanged: explicit `claudeHome` option → `resolveClaudeHome()` (`$CLAUDE_CONFIG_DIR` → `~/.claude`).
- **Why not a both-or-neither guard.** A first draft required both options together or neither, throwing otherwise. Cold review showed the blast radius: `CcPluginsServiceOptions.claudeHome` is a documented public knob, virtually every existing spec seeds only `claudeHome`, and module-level functions accept raw deps — a throwing guard would either break all of them or silently default `dshHome` to the real `~/.dsh` (the exact hazard it existed to prevent). The default chain eliminates the hazard structurally instead: `dshHome ?? claudeHome` at the module level means an explicit `claudeHome` alone always means *single-root* — writes can only ever go to an explicitly supplied directory or to the intended product defaults, never to a real home by accident.
- **Single-root degenerate** — when both homes canonicalize to the same directory (compared via `canonicalizeExistingPath`, so symlinked homes collapse correctly), the merge layer is a no-op and behavior is byte-identical to today's.
- **Resolution happens at the option level.** `createCcPluginManager` and `discoverCcPluginRoots` compute `dshHome = options.dshHome ?? options.claudeHome ?? resolveDshHome()` *before* building deps, so a no-options production caller always resolves dual-home — never single-root against the real `~/.claude`. The deps-level fallback (`deps.dshHome ?? deps.claudeHome`) exists only for direct module-function callers (tests, internal composition) that already pass an explicit `claudeHome`.
- **No API break**: existing glue configs and specs that pass only `claudeHome` keep today's behavior verbatim; `dshHome` is purely additive.

### 3.2 The uniform merge rule

All state surfaces merge with the same template: **layered per-key map, dsh layer authoritative over the claude layer for keys it carries; claude-only keys pass through.** Keys are marketplace names (`known_marketplaces.json`), plugin ids (`installed_plugins.json`), or plugin ids (`enabledPlugins` in scope settings).

- Manager: new module `cc-plugin-manager/src/merged-state.ts` (keeps every existing file under the 500-line cap) exposing `loadMergedKnownMarketplaces` (drops dsh `null` tombstones, tracks per-key origin), `loadMergedInstalledPlugins` (per-key dsh shadow; merged ids with empty entry lists are dropped from the *resolution* view so `resolveInstalledPluginId` never reports a shadowed id as installed), `loadMergedUserEnabledPlugins`.
- Loader: `discovery.ts` consumes the same rules (same package-local implementation shape as today — the two packages deliberately share no new runtime coupling; `alignment.spec.ts` already exists to pin behavioral agreement and grows dual-home scenarios).
- Read freshness: nothing is cached; every operation re-reads both homes, so a real-CC change appears on the very next dsh-cc operation (with the takeover exception of §3.4/§7).
- Future readers of merged installed/known state must treat `data/` as dsh-only: the dsh `plugins/data/` dir is created on demand; nothing merges data dirs.

### 3.3 enabledPlugins (user scope)

Effective enablement extends C9's scan `local → project → user` to `local → project → dsh-user → claude-user`, first defined boolean winning; absent everywhere ⇒ disabled. Discovery's cascade becomes `[claude-user, dsh-user, project, local]` (later overrides ⇒ the same order). `/plugin list` keeps its `enabledByScope`/`overrideNote` shape: the `user` slot reports the merged user value (dsh ?? claude); a claude `true` masked by a dsh `false` therefore reads `user=false` — accepted provenance compression, pinned by a test. Deleting a dsh-side key re-exposes the claude-side value — the natural "un-override".

### 3.4 installed_plugins.json

Per plugin id: a dsh entry list — **including the empty list** — shadows the claude list for that id; ids present only in claude pass through. Entries' absolute `installPath`s freely mix homes (a claude-created install keeps pointing into `~/.claude/plugins/cache/…`, readable forever). Per-key latest-`lastUpdated` pick in the loader is unchanged.

**Materialization-on-write:** every mutation that changes an id's entry list writes the id's *whole post-mutation merged list* to the dsh file (the id is dsh-owned from then on; `[]` when nothing remains). This is what makes scope-surgical edits to claude-resident ids expressible without any format invention: uninstalling the `user` scope of an id whose entries live in the claude file writes the surviving (e.g. project-scope) entries into the dsh file, and the claude array is never touched.

**Documented consequence (takeover staleness).** Once an id's list is materialized into the dsh file, later claude-side mutations to that id (a real-CC uninstall, e.g.) become invisible in dsh-cc — dsh has taken over that id. This is inherent to shadowing, matches R3's intent, and is pinned by a test + README copy (§7).

### 3.5 known_marketplaces.json

Per marketplace name: a dsh entry wins; claude-only names pass through. A dsh value of `null` **tombstones** the name (the merged view has no such marketplace). `null` is the minimal extension that can express "removed here, still present below" — materializing the surviving keys into the dsh file *cannot* express it, because per-key merge would let the claude entry show through again. Nulls are dsh-private: the shared claude file never carries them, single-root mode never writes them, and every reader filters them. An `update` against a tombstoned marketplace resolves to `unknownMarketplace` from the merged map (`update.ts:46-48` behavior, now against the merged view).

### 3.6 Scope settings declarations (`extraKnownMarketplaces`)

A write-only parity artifact in dsh-cc (nothing reads it; `listMarketplaces` is sourced from the known file). User-scope declarations move to `~/.dsh/settings.json`; project/local unchanged. Removing a user-scope declaration that exists only in the claude file is a no-op for dsh-cc's own view (nothing reads it) and stays untouched in the claude file (out of write jurisdiction) — documented behavior.

## 4. Write model — per operation (dsh-only mutations)

Global rules:

- **W1.** No code path opens a Claude-home path for write. Every mutation spec asserts byte-identity of seeded claude fixtures before/after.
- **W2.** The only `.claude` paths ever written remain the *per-repo* scope files (`<cwd>/.claude/settings.json`, main-checkout `.claude/settings.local.json`) — Claude-Code parity surfaces, not user-home state.
- **W3.** Claude-owned material (marketplace clones, cache dirs, install path targets) is never deleted, moved, or orphan-marked; it remains intact for real Claude Code.
- **W4.** Orphan markers are written only for install paths under the dsh cache dir (realpath-prefix check), and only when no remaining merged entry references the path.

Per operation (dual-home mode; single-root is today's behavior verbatim):

1. **install** — resolves against the *merged* known marketplaces (`pluginAlreadyInstalled` checks the merged list per scope, regardless of which home holds the prior entry), so a claude-known marketplace is installable: its `installLocation` is read (claude clone stays put), the plugin materializes into the **dsh** cache, the scope entry is appended to the id's merged list and saved to the dsh installed file, and `enabledPlugins[id] = true` lands in the scope file (user → `~/.dsh/settings.json`).
2. **enable / disable** — auto-detect over the merged installed lists; user-scope flags are written to the dsh user settings (`false` shadows a claude `true`, C3 key-kept behavior intact).
3. **uninstall** — C5 guard unchanged. The id's post-removal merged list materializes into the dsh installed file (`[]` possible — §3.4). **Conditional user-flag shadow (deviates from C4 in one case):** on user-scope uninstall the user-file `enabledPlugins` key is *removed* per C4 — **unless** we are dual-home AND the claude user file currently carries `true` for that id, in which case the dsh file gets an explicit `false` instead (removal would un-shadow the claude `true` and resurrect the plugin). The explicit `false` is deliberately conditional: an unconditional one would mask a *future* claude-side `true` forever with no provenance. Single-root mode keeps C4 byte-parity verbatim. `.orphaned_at` per W4.
4. **update** — merged view throughout; the new version materializes into the dsh cache even when the marketplace clone is claude-owned; the scope entry is rewritten in the dsh file; an old claude-owned `installPath` is never orphan-marked.
5. **marketplace add** — clones go to `<dshHome>/plugins/marketplaces/`; known entry + scope declaration write dsh-side (user declaration → `~/.dsh/settings.json`). Idempotent re-add compares against the merged known map (same source re-added ⇒ idempotent success, no clone, regardless of which home holds the entry). **Tombstone replacement rule:** a dsh-tombstoned name counts as *absent* for all of these checks — the tombstone rule takes precedence over the idempotent re-add rule. Re-adding over a tombstone always succeeds and writes a fresh dsh entry (clearing the tombstone). When the claude file still carries the same name: a *same* source is reused by reference — the dsh entry points at the claude entry's `installLocation` with no clone (promote-on-write handles freshness on the next update); a *different* source clones fresh (for git-backed sources) and the return payload carries `shadowedClaudeEntry: true` so the command layer can print a one-line notice (no throw: the user explicitly management-claims the name in dsh).
6. **marketplace remove** — C6 pre-flight (C5 project-guard per plugin) unchanged; each affected id goes through the uninstall semantics of (3); claude-owned clone dirs are never deleted (W3); the known name gets a dsh `null` tombstone (§3.5); `extraKnownMarketplaces` stripping per §3.6.
7. **marketplace update — promote-on-write.** Never run `git pull` inside `~/.claude`. For a claude-only git/github entry, promote first: fresh `git clone <source>` into `<dshHome>/plugins/marketplaces/<name>` under the same tmp-dir + rename + rollback discipline as `add`, with four refinements:
   - **Manifest name must match** the entry's name; on mismatch the clone is dropped and a typed `marketplaceNameMismatch(expected, actual)` error is thrown (new factory in `errors.ts`).
   - **Field carry-over:** the dsh entry is `{ ...claudeEntry, installLocation: <dsh clone>, lastUpdated: <now> }` so `autoUpdate` and any unknown extra fields survive.
   - **Self-healing residue:** if the target dsh clone dir already exists but no dsh known entry references it (crashed earlier attempt), it is removed and re-cloned.
   - **Per-entry commit (loop-wide, deliberate behavior change):** the dsh-side known file is saved after *each* successfully processed marketplace rather than once at the end — for promotes this is required (an on-disk clone must be tracked immediately, or a mid-batch failure leaves clones no file knows about and the next run re-clones into an existing dir), and the same per-entry commit is applied uniformly to the whole update loop. Consequence: a mid-batch failure now persists the already-processed prefix (previously all-or-nothing for dsh-owned `pull` updates). No existing spec pins the old all-or-nothing shape (the single-name failure spec at `marketplace.spec.ts:298-306` is unaffected); recorded as decision G in §6.
   Directory sources need no clone: the dsh entry is written pointing at the same external path with refreshed `lastUpdated`. Dsh-owned entries update exactly as today (`pull --ff-only` / re-validate). A promote clone failure leaves the claude home untouched and throws.

## 5. Files-touched impact map

| Package | Change |
|---|---|
| `cc-plugin-manager` | `paths.ts`: dual-home inputs (`dshHome?` defaulting to `claudeHome`), user write path → dsh, cascade reader helper. New `merged-state.ts`. `index.ts`: option + default chain (`resolveDshHome`). `install.ts`/`uninstall.ts`/`update.ts`/`toggles.ts`/`settings-write.ts`: retarget per §4 (incl. conditional shadow). `marketplace.ts`: retarget + promote-on-write + tombstone; split `marketplace-promote.ts` if the 500-line cap demands (file is at 343). `errors.ts`: `marketplaceNameMismatch`. README en+zh. `package.json`: `@deepseek-ai/dsh-home-paths` dep per D7. |
| `cc-plugin-loader` | `discovery.ts`: `dshHome?` option with the same default chain; merged enabled cascade (§3.3) and merged installed view (§3.4) — extract a new module if the 500-line cap demands (file is at 249). README en+zh. `package.json`: same new dep (it resolves `resolveDshHome` for its default). |
| `bundle/cc-shell` | `ccPluginManager.ts`: pass `resolveDshHome()` alongside `resolveClaudeHome()`. `ccPlugins.ts`: optional `dshHome` passthrough for symmetry; doc comments noting `claudeHome`-alone keeps legacy single-root behavior. **README.md:11,32 and README.zh.md:11,24** state plugin discovery/state lives under `$CLAUDE_CONFIG_DIR`/`~/.claude` — update both. |
| Docs / manifest | `docs/claude-code-capabilities.yaml`: `plugins.management` behavior text (state root split), `plugins.loader` summary (dual-home discovery), **`commands.plugin`** behavior text + evidence (the row's structural `deviation` entries need care — run `pnpm check:capabilities`), evidence anchors for new specs; regenerate `pnpm docs:parity`. This plan doc. Root README plugin-state mention if present (verify during implementation). |

## 6. Decisions and rejected alternatives

- **A. Merged layered state (chosen) vs MCP-style gated source separation** (precedent: `cc-shell/src/index.ts:10-17` — dsh `.mcp.json` with ≥1 server replaces the claude files wholesale, plus a `/mcp migrate` notice). Rejected: gating would hide *all* claude-installed plugins the moment the first dsh-side write appears, unless a migration runs first; plugin state is a directory tree plus three settings files, not one importable config; and R1+R3 explicitly ask for a merged view with per-key override.
- **B. Conditional explicit-`false` shadow vs unconditional vs C4 key-removal** (§4.3): unconditional `false` would mask future claude-side enablement forever; removal alone resurrects a claude `true`. The conditional rule is the only one correct in both directions; single-root keeps literal C4.
- **C. `null` tombstone vs materialize-survivors for `marketplace remove`** (§3.5): materialization cannot express key absence under per-key merge.
- **D. Promote-on-write clone vs in-place `git pull` vs refusal** (§4.7): pull violates R2; refusal breaks update for every CC-side marketplace user; clone costs disk once per marketplace (documented).
- **E. Default-chain instead of a both-or-neither options guard** (§3.1): the guard's blast radius (public `claudeHome` knob, all existing specs) breaks G3; the chain makes the accident structurally impossible instead of policed.
- **F. Loader keeps reading settings files directly** rather than switching onto the settings-cascade seam: current architecture, smaller blast radius; the dsh user settings file doubles as the cascade user layer with zero conflict (`enabledPlugins`/`extraKnownMarketplaces` pass through as unknown keys; hot-reload republish on manager writes is benign; the pre-existing "concurrent writers can lose updates" settings-cascade limitation is unaffected in kind).
- **G. Per-entry commit for `marketplace update` is loop-wide** (§4.7), mandated by promote crash-safety and applied uniformly: a mid-batch failure persists the processed prefix instead of rolling back to no-save. Accepted as the better failure shape; no existing spec pins the old all-or-nothing shape.

## 7. Consequences and migration story

- Nothing migrates and nothing is deleted, ever: existing `~/.claude` plugin state simply keeps working in dsh-cc the moment this lands.
- The fork is one-way by design: dsh-cc sees both homes; real Claude Code continues to see only its own. A plugin "moved" to dsh management is invisible to the CC CLI until re-installed there.
- **Takeover staleness (§3.4):** once dsh-cc mutates an id, that id's entry list lives in the dsh file and later claude-side changes to that id become invisible to dsh-cc. "dsh manages what it has touched" — called out in README copy.
- With `$CLAUDE_CONFIG_DIR` set, writes follow `$DSH_HOME` (previously they followed `CLAUDE_CONFIG_DIR`) — release-notes/README line, since a user who used `CLAUDE_CONFIG_DIR` as a *relocation* knob will observe a new write target.
- No ghost-install UI in v1: a data-row provenance surface (per row `home: dsh|claude`) is a natural follow-up if users ask "why is this here".

## 8. TDD slices (executor work order)

Each slice: failing tests first, implementation, package-scoped `vitest run` + `tsc -b` green before the next.

- **S1** paths & resolution: `dshHome` option + default chain (module-level `dshHome ?? claudeHome`), single-root canonical collapse, user-scope write path = dsh. (`paths.spec.ts`, new cases; existing cases untouched per G3.)
- **S2** merged readers: §3.2–§3.6 semantics in both packages incl. resolution-view dropping of empty-list ids; `alignment.spec.ts` dual-home scenarios (manager listing ≡ loader discovery against the same fixtures); the `overrideNote` provenance pin (§3.3).
- **S3** simple mutations: install / enable / disable / uninstall / update per §4.1–4.4, including claude-byte-identity assertions (W1/W3/W4) and the conditional explicit-`false` shadow (both branches).
- **S4** marketplaces: add (tombstone replacement + `shadowedClaudeEntry`), remove (tombstone), update (promote-on-write with injected git runner: name-mismatch error, field carry-over, residue self-heal, per-entry commit; batch prefix persistence).
- **S5** wiring: cc-shell manager construction passes both homes; service passthrough; cc-shell spec updates + README pairs.
- **S6** docs & gates: manager + loader READMEs (en+zh), capability manifest rows (`plugins.management`, `plugins.loader`, `commands.plugin`) + evidence, `pnpm docs:parity`; final full gates: `vitest run` (repo), `tsc -b`, `check:size`, `check:capabilities`, `check:parity`, `check-spec-deps`, plus `check:publish` sanity given the new dependency declarations.

## 9. Verification plan

- Unit/integration per slice (S1–S5). No new claude-side byte shapes are introduced (the only new byte shape, the `null` tombstone, lives in the dsh-private file), so no fresh real-CC probe is required; the v2.1.236 probe record in the S1 doc remains the interop baseline.
- Scripted smoke (executor, tmp homes): seed a claude home with one marketplace + one installed/enabled plugin + one user-scope `enabledPlugins`; run the full mutation grammar under split `HOME`/`DSH_HOME`/`CLAUDE_CONFIG_DIR`; assert (a) seeded claude tree byte-identical afterwards, (b) merged listing/discovery correct at every step, (c) dsh tree carries every new artifact.

## 10. Risks

- **Cross-tool divergence confusion** (a plugin visible in dsh-cc but not in `claude plugin list` and vice versa): mitigated by README/release-notes copy; no UI change in v1.
- **Takeover staleness ghosts** (§7): dsh-owned ids stop tracking claude-side changes; accepted product semantics, possible provenance surface later.
- **Promote-on-write disk duplication**: one extra clone per claude-owned git marketplace on update; bounded, documented.
- **`enabledPlugins` living in the cascade's user file**: pass-through, benign watcher republish; pre-existing cross-process lost-update limitation unchanged in kind.
- **`CLAUDE_CONFIG_DIR` semantics change for writes**: documented in §7; users relying on it for full relocation should set `DSH_HOME` instead.
- **Upstream collision**: if a future CC version assigns its own meaning to `null` values in `known_marketplaces.json`, the dsh-private tombstone extension diverges — unprobeable from here; the v2.1.236 baseline has no such key semantics.
