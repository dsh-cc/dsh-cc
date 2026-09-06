# @dsh-cc/tool-git-worktree

English | [中文](README.zh.md)

Model-facing `EnterWorktree` / `ExitWorktree` tools that create, keep, and remove isolated git worktrees under `<repo>/.claude/worktrees/`. They run every git command through the `ctx.shell` executor seam (resolve then run — never a direct spawn) and validate every path they act on stays inside the repository through `ctx.fs`.

Requires a loaded shell executor Service Provider (e.g. `@deepseek-ai/dsh-bash-local`), a filesystem provider (`@deepseek-ai/dsh-fs-local`), `ctx.tools`, and `ctx.systemPrompt`. The plugin stays pending until `inject: ['tools', 'shell', 'systemPrompt', 'fs']` is satisfied.

## Tools

### `EnterWorktree`

Creates a worktree on a fresh `worktree-<name>` branch from HEAD and switches the session into it.

| Arg | Type | Notes |
|---|---|---|
| `name` | string | Worktree slug. Each `/`-separated segment allows letters, digits, `.`, `_`, `-`; max 64 chars. A random `adjective-noun-suffix` slug is generated when omitted. |

The tool locates the repository root from the calling agent's session cwd (`git rev-parse --show-toplevel`); outside a git working tree it returns a structured error rather than changing anything. Because the session working directory is fixed at session creation in this harness, the cwd switch is declared two ways that are safe given the immutable session cwd: the tool result and a `tool:worktree:cwd` systemPrompt runtime context both state the new working directory, and the model is told to pass `workdir` equal to the reported `worktreePath` for subsequent shell and fs calls. The pre-release-state choice is recorded in the [git-worktree-tools Agent Note](../../../.agents/notes/implemented/feature/2026-08-14-git-worktree-tools.md).

### `ExitWorktree`

Leaves the active EnterWorktree session and returns to the original directory.

| Arg | Type | Notes |
|---|---|---|
| `action` | `"keep"` \| `"remove"` | `keep` leaves the worktree and branch on disk; `remove` deletes both (destructive). |
| `discard_changes` | boolean | Required `true` with `action: "remove"` when the worktree has uncommitted files or commits not on the base branch; the tool refuses and lists the evidence otherwise. |

`ExitWorktree` only operates on worktrees created by `EnterWorktree` in the current session: it is a no-op otherwise and never touches manually-created or previous-session worktrees. Before a `remove` it probes `git status --porcelain` and `git rev-list --count <base>..HEAD` and **fails closed** — if the state cannot be verified it refuses without `discard_changes: true`, so a silent 0/0 can never destroy real work.

## Safety

- Both tools are `isConcurrencySafe = () => false`; they must not overlap other tools.
- `ExitWorktree` with `action: "remove"` is destructive (deletes the worktree directory and its branch); with uncommitted or unmerged work it requires the explicit `discard_changes: true` grant. dsh-tools has no dedicated `isDestructive` field, so destructiveness is expressed in the human-readable tool description and the `remove`-vs-`keep` call presentation.
- Every on-disk path is validated to stay inside the repository's `.claude/worktrees/` directory before any git command runs.

## Git command construction

All git commands are built in one module (`src/worktree.ts`) as `{ command, workdir, label }` opaque values that the tools hand to `ctx.shell`. This is the seam a future pure-JS git implementation would replace; tool code never interpolates git argument lists itself.

## UI presentation

`EnterWorktree` and `ExitWorktree` own their `presentCall`/`presentResult` render intent as generic cards. `presentCall` is a pure function of the arguments (an `EnterWorktree` call names the worktree; an `ExitWorktree` call distinguishes `remove` (destructive) from `keep` in its title and content). `presentResult` shows a plain message on success and fenced text on error; a `diff` card is not used because a worktree exit has no textual diff to render.

## Known limitations

- The session cwd is immutable, so the worktree switch is expressed through the declared cwd and the systemPrompt runtime context rather than a true per-session cwd mutation; subsequent shell/fs calls must pass `workdir`.
- The active worktree session is a process-wide singleton (mirroring the claude-code reference), so one process has at most one active worktree at a time.
