# Worktree resume tombstone + boot gate

Status: Proposed

## Problem

Boot auto-resume reads the project-level anchor `$DSH_HOME/tui/projects/<projectKey>/resume.txt`
(`readResumeTarget` in `packages/ui/tui/src/resume-target.ts`; `projectKey = sha256(main repo
root)`, worktrees collapse to the main root — see `packages/ui/tui/src/project.ts`
`resolveProject`). The anchor stores a session id, but its lifecycle is asymmetric: it is
written whenever a session persists content, yet nothing clears it when a worktree is deleted.
After a same-named worktree rebuild, a bare `dsh` launch in the worktree auto-resumes the old
(session-undoable) session whose files are gone.

Related: `docs/plans/2026-09-01-p3-project-resume-marker.md` (anchor mechanics). The resumed-cwd
warning half of this design arrived as the cherry-picked commit `dc12586` (originally slice 2 on
the unmerged branch `worktree-exit-resume-message`; its design doc never landed on main).

## CC reference

The official Claude Code worktrees doc says the session binding is validated before resume and
dropped when the worktree is gone (degrade to a fresh session + clear the binding). Upstream
harness exposes no `resume({ meta })` cwd override (`ResumeAgentOptions` has none), so the
binding-clearing semantics live entirely in the TUI layer here; any deeper parity is an upstream
proposal.

## Design (two pieces, both fail-open)

1. **Tombstone on removal** — `/quit` → ExitWorktree(remove): after a successful
   `worktreeExit.cleanup`, `tombstoneResumeTargetForRemovedWorktree` reads the anchor, looks up
   the anchored session's persisted `header.cwd` via `sessionPersistence.list()`, and clears the
   anchor only when the stored cwd resolves inside the removed path (segment-boundary safe).
   Fail-open on: no anchor, `persistence === undefined`, `list()` throwing, unknown id, missing
   `header.cwd`. Failure never blocks quitting.
2. **Boot gate** — the autoResume branch runs `gateAutoResumeTarget` before resuming: if the
   anchored session's `header.cwd` no longer exists, clear the anchor and boot fresh with a
   Chinese notice; otherwise resume. Fail-open identical to (1). Explicit `--resume <id>` and
   the `/resume` picker keep their existing semantics (including the resumed-cwd warning from
   the exit-resume-tip slice).

Clearing is deliberately conservative: an anchored session whose cwd is the main root or a
different worktree is never touched.

## Accepted degradations

1. **Pure-shell remove window.** If the worktree is deleted and rebuilt by shell commands with
   no TUI launch in between, the removal is unobservable — the old semantics (auto-resume into
   the stale session) still apply on the next bare boot. The boot gate then catches it one boot
   later only if the rebuilt path has no live session cwd; in the common rebuild case the
   resumed session's cwd is missing and the gate fires then.
2. **Tool-path removal rebind.** After `ExitWorktree(remove)` run from a tool (not `/quit`) plus
   a same-named rebuild, a bare boot may resume a session whose cwd now rebinds to the parent
   (main) directory — usable, but not CC's clear-binding semantics.

Both stem from the same root: deletion of a directory tree carries no signal the anchor layer
can observe; we only close the two windows we can see (TUI quit, boot).
