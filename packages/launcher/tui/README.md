# @dsh-cc/cli

English | [中文](README.zh.md)

Optional `dsh-cc` bin. Canonical command is still `dsh --profile tui`.
`dsh-cc --version` (or `-V`) prints the version label and exits: the
launcher's semver for a release install, `<base>-dev+<commit>[.dirty]` for a
dev-synced profile.

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

The value may also be a PR or MR reference (`#<n>`, a GitHub PR URL, or a
GitLab MR URL): the launcher fetches `pull/<n>/head` on github.com,
`merge-requests/<n>/head` on gitlab.com, and both on an unknown host, then
creates the worktree at `.claude/worktrees/pr-<n>` on branch
`worktree-pr-<n>` from the fetched head. Repository-local filter drivers are
neutralized on creation, so LFS content arrives as pointer files and a
`git lfs pull` in the new tree restores it (`bootstrap.mjs:305-330,365-370`).

Every launch also runs a boot-time sweep (never network I/O, 10s cap,
fail-silent): worktrees under `.claude/worktrees/` on `worktree-*` branches
older than `worktree.cleanupPeriodDays` (default 30, from the `worktree`
settings section read fail-open from user → project → local settings files)
are removed only when clean and nothing is unpushed; stale dsh-cc session
locks are never auto-released — they surface as advisory `git worktree
unlock <path>` lines. New worktrees branch from the base chosen by
`worktree.baseRef` (`fresh` = cached origin/HEAD with a 24h-stale refresh
fetch capped at 5s, `head` = literal HEAD); a reused named worktree is
hard-reset to that base when it is clean and all its own commits are
already merged into it. Created and reused worktrees are locked with
`git worktree lock --reason="dsh-cc session <slug>"` for the session's
duration.

Before the session starts the launcher also converges the profile: a
dev-synced profile paired with a different launcher version is restored to
store bundles, an existing store profile is healed to the current version,
and the bootstrap path stops with a message when `dsh --version` is below
the required minimum (`bootstrap.mjs:708-930`, `bin/dsh-cc.js:110-152`).

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
- `DSH_CC_DISABLE_EXIT_TIP='1'` — disables the resume tip printed to
  scrollback when the TUI quits (see `packages/ui/tui/src/exit-tip.ts`).

`DSH_CC_RESUME_SESSION`, `DSH_CC_AUTO_RESUME`, and `DSH_CC_CONTINUE` are
**launcher-owned**: the bin sanitizes them from the inherited environment at
entry (a parent dsh-cc TUI leaks them to a child launcher) and re-derives
them only from the current invocation's argv. Do not set them manually when
launching `dsh-cc`.

`DSH_CC_PROFILE` names the profile the launcher spawned (`tui`, or `cc-acp`
on the ACP lane) so the plugin can surface it as `ctx.get('dshProfile')`
(`bin/dsh-cc.js:82,385`).

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

## `dsh-cc acp`

`dsh-cc acp [...]` starts the Agent Client Protocol lane. The bin intercepts
it before any TUI processing (`bin/dsh-cc.js:37-99`), bootstraps the separate
`cc-acp` profile from the ACP floor bundles (`bootstrap.mjs:18-32`; the
installed `@deepseek-ai/dsh-acp-app` is pinned at `0.2.1-rc.5`), then spawns
`dsh --profile cc-acp` with the remaining arguments. Stdout belongs to the
ACP NDJSON protocol, so bootstrap and install output goes to stderr, stdin is
never consumed, and the child inherits stdio. No TUI flag processing runs on
this path, so `--worktree` and the resume flags pass through untouched.
