# @dsh-cc/plugin-manager

English | [中文](README.zh.md)

Manage Claude Code plugin state in-session: marketplaces, installs, per-scope enablement — reading and writing the same on-disk files (and byte shapes) as the real `claude plugin` CLI, so the two stay interoperable.

## State root: dual-home (compat-read `~/.claude`, write `~/.dsh`)

Plugin state is dual-home:

- **Write root — `$DSH_HOME` / `~/.dsh`.** Every mutation (install / uninstall / enable / disable / update / marketplace add / remove / update) writes only under the dsh home (`plugins/{known_marketplaces.json, installed_plugins.json, marketplaces/, cache/}` and `~/.dsh/settings.json` for user-scope `enabledPlugins` / `extraKnownMarketplaces`). Per-repo project/local scope files (`<cwd>/.claude/...`) stay exactly where Claude Code keeps them.
- **Read root — `$CLAUDE_CONFIG_DIR` / `~/.claude`, fully visible.** Existing Claude-home state simply keeps working; nothing migrates and nothing is ever deleted from the Claude home.
- **Per-key dsh-wins merge.** When both homes carry the same key (marketplace name or plugin id), the dsh entry wins; claude-only keys pass through. A dsh `known_marketplaces.json` value of `null` is a private tombstone that hides a claude-only marketplace. A dsh `installed_plugins.json` entry list — including an empty list — shadows the claude list for that id.

Consequences:

- **One-way fork.** dsh-cc sees both homes; real Claude Code sees only its own. A plugin claimed by dsh is invisible to the `claude` CLI until installed there.
- **Takeover staleness.** Once dsh-cc writes an id into the dsh `installed_plugins.json`, later claude-side changes to that id become invisible to dsh-cc — dsh manages what it has touched.
- **`CLAUDE_CONFIG_DIR` no longer relocates writes.** With `$CLAUDE_CONFIG_DIR` set, writes follow `$DSH_HOME` (previously they followed `CLAUDE_CONFIG_DIR`); users who used it as a relocation knob should set `DSH_HOME` instead.
- **Legacy single-root.** A caller passing **only `claudeHome`** (no `dshHome`) keeps the pre-dual-home behavior byte-identically: that directory is both the read and the write root.

The resolution chain is: explicit `dshHome` → explicit `claudeHome` (legacy single-root) → `resolveDshHome()` (`$DSH_HOME` → `~/.dsh`). Resolution happens before deps are built, so a no-options production caller always resolves dual-home.

## Surface

`createCcPluginManager({ claudeHome?, dshHome?, cwd?, runGit? })` returns a manager with `list`, `install`, `uninstall`, `enable`, `disable`, `update`, `listMarketplaces`, `addMarketplace`, `removeMarketplace`, `updateMarketplaces`. Mutations resolve against the merged view; every operation re-reads both homes, so a real-CC change appears on the very next operation (except for taken-over ids, above). Claude-owned material (marketplace clones, cache dirs) is never deleted, moved, or orphan-marked; marketplace updates of claude-owned git entries are served by promote-on-write (a fresh clone into the dsh home, the claude entry untouched).

## Known limits and deferred work

- No interactive menu UI, trust dialogs, `details/eval/init/prune/tag/validate` subcommands, `managed` scope, or orphan sweeping (CC-shape parity scope: `docs/plans/2026-09-06-plugin-management.md`).
- `extraKnownMarketplaces` user-scope declarations write to `~/.dsh/settings.json`; removing one that exists only in the claude file is a no-op for dsh-cc's own view (nothing reads it) and leaves the claude file untouched.
- No bulk migration command (`/plugin migrate`); revisit on user demand.
