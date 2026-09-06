# @dsh-cc/cli

Optional `dsh-cc` bin. Canonical command is still `dsh --profile tui`.

First run bootstraps `$DSH_HOME/profiles/tui` with the three CC bundles.
The launcher is a thin flag translator: it derives the session-mode env the
TUI plugin consumes, then spawns `dsh --profile tui`. It never reads a
resume marker itself — marker reads and writes are owned by the TUI plugin.

`--worktree [name]` starts the session inside a git worktree at
`<repoRoot>/.claude/worktrees/<slug>` on branch `worktree-<slug>` (random
slug when no name is given). A newly created worktree starts a fresh
session (equivalent to `--new`). Re-invoking `--worktree <name>` when that
directory already exists reuses it and, because sessions are scoped to the
*project* (main git root; worktrees share it), falls back to the default
auto-resume — the TUI resumes the project's last session. `--resume` /
`--new` still override. The launcher marks the session via
`DSH_CC_WORKTREE`, and the TUI offers to keep or remove the worktree at
`/quit`. Requires a git repository with at least one commit.

## Resume environment contract

The launcher communicates the user's session intent to the TUI plugin (via
`cordis.patch.yml` `!!js` expressions) through three variables:

- `DSH_CC_RESUME_SESSION=<id>` — explicitly resume that session id
  (`--resume <id>` / `--resume=<id>`).
- `DSH_CC_RESUME_SESSION=''` — an explicit fresh start (`--new`/`-n`, or a
  freshly created worktree); the TUI must not read any marker.
- `DSH_CC_AUTO_RESUME='1'` — no explicit choice was made, so the TUI reads
  its own project resume marker and resumes if one exists. Only ever set
  when `DSH_CC_RESUME_SESSION` is left undefined.
- `DSH_CC_CONTINUE='1'` — the user passed `-c`/`--continue`; the TUI shows
  a "no previous session to continue" notice when no marker exists
  (previously this was a one-line launcher stderr hint; the marker-read
  move into the TUI took that knowledge away from the launcher).

`DSH_CC_RESUME_SESSION`, `DSH_CC_AUTO_RESUME`, and `DSH_CC_CONTINUE` are
**launcher-owned**: the bin sanitizes them from the inherited environment at
entry (a parent dsh-cc TUI leaks them to a child launcher) and re-derives
them only from the current invocation's argv. Do not set them manually when
launching `dsh-cc`.

### Mixed-version degradation

Because the launcher npm package and the `tui` profile plugin version are
locked at install time, a mismatch only appears after upgrading the launcher
without reinstalling the profile:

- New launcher + old plugin: the plugin never sees `DSH_CC_AUTO_RESUME`, so
  auto-resume is silently off — `/resume` still works for manual selection.
  Fix by reinstalling the profile (`dsh-cc` re-runs bootstrap on a fresh
  profile).
- Old launcher + new plugin: the old launcher reads the legacy marker and
  the new plugin dual-writes it, so the common same-directory-restart path
  keeps working.

This package does **not** ship a `dsh-tui` binary.
