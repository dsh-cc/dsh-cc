# @dsh-cc/session-cwd

English | [中文](README.zh.md)

Session-scoped working directory for DeepSeek Harness CC — the WS1 + WS2
foundation of the [worktree-session-isolation design](../../../docs/plans/worktree-session-isolation.md).

## What it owns

- **`worktree/entered` session event** (WS1): registered into the persistence
  layer's `KNOWN_SESSION_EVENT_TYPES` at module load, so logs containing it
  resume cleanly. Payload: `{ path }` — the new absolute session cwd.
  `ExitWorktree` restores the previous directory through the same event
  (last-wins fold).
- **Foldable state** (`src/state.ts`): `foldSessionCwd` folds the current cwd
  out of the event log; a process-local `SessionCwdStore` overlays the live
  value so reads are immediate and sessions stay independent in one process.
- **APIs** (`src/api.ts`): `getSessionCwd(agent)` (live overlay → durable fold
  → session header → fallback) and `setSessionCwd(agent, path)` (durable
  event + overlay; absolute paths only).
- **Workspace boundary guard** (WS2, `src/listener.ts`): a
  `tools/pre-execute` listener registered with `{ prepend: true }` — ahead of
  the permission-rules waterfall — that checks every fs-family call's target
  path against the session cwd. Out-of-workspace targets return
  `{ kind: 'ask' }` ("Operation targets path outside session workspace") in
  every mode except `bypassPermissions`, which allows (the existing audit
  trail covers it). Non-fs tools, pathless calls, and agents without a
  resolvable cwd pass through untouched; the guard is a pre-execute
  convenience, not a hard security boundary.

## Consumers

- `tool-git-worktree`: `EnterWorktree` calls `setSessionCwd(worktreePath)`;
  `ExitWorktree` restores `session.originalCwd` the same way.
- TUI driver: project/history resolution prefers the durable fold over the
  boot-time header cwd.
- CC preset (`packages/preset/cc/agent.cordis.yml`) composes the plugin, which
  installs the boundary guard.

## Tests

```bash
cd packages/workspace/session-cwd && npx vitest run tests/
```

(In a worktree whose root `node_modules` is a symlink the sandbox cannot write
into, add `--configLoader runner` to skip the `.vite-temp` bundle step.)
