# @dsh-cc/session-cwd

English | [中文](README.zh.md)

Session-scoped working directory facade for DeepSeek Harness CC — a thin adapter
over the harness `workingDirectory` service (the WS1 + WS2 foundation of the
worktree-session-isolation design, `docs/plans/2026-09-02-worktree-session-isolation.md`).

## What it owns

- **Facade** (`src/api.ts`): `resolveSessionCwd(agent)` — undefined-able, reads the
  service-projected state through the agent's own context, falls back to the legacy
  fold only when the service is absent in the realm — and `getSessionCwd(agent, options?)`,
  total (`resolve ?? options.fallback ?? process.cwd()`). Neither throws, so
  cwd-less and TUI-style agent fixtures keep working.
- **Legacy log hydration** (`src/hydration.ts`): `worktree/entered` stays registered in
  the persistence layer's `KNOWN_SESSION_EVENT_TYPES` so old logs still open. On
  `agent/created`, a legacy-only log is migrated into the service exactly once; a newer
  `working-directory/change` (by event seq) is never overwritten, and a vanished legacy
  directory warns instead of failing creation.
- **Workspace boundary guard** (WS2, `src/listener.ts`): a `tools/pre-execute` listener
  registered with `{ prepend: true }` — ahead of the permission-rules waterfall — that
  checks every fs-family call's target against the session cwd. Containment canonicalizes
  BOTH sides (`realpath`, raw on failure), so a target arriving in the pre-symlink spelling
  matches a root the service already committed canonically. Out-of-workspace targets return
  `{ kind: 'ask' }` ("Operation targets path outside session workspace") in every mode except
  `bypassPermissions`, which allows. Non-fs tools, pathless calls, agentless and cwd-less
  execution pass through; the guard is a pre-execute convenience, not a hard security boundary.
- **`{{cwd}}` prompt variable**: registered in `apply()` (WeakSet-deduped) for the cc personas.

## What is gone

The process-local cwd overlay (`SessionCwdStore`), the write-through holder, and the
mirror bridge were retired: the harness `workingDirectory` service is the single owner.
`setSessionCwd` / `getSessionCwdForSession` are removed, and nothing appends
`worktree/entered` any more (no dual write).

## Consumers

- `tool-git-worktree`: `EnterWorktree` / `ExitWorktree` commit through the awaited
  `workingDirectory.set`.
- `subagent/handoff-store`: project keys hash the **canonicalized** cwd (`realpath`), so a
  parent's raw spelling and the manager's canonical child spelling map to one key.
- CC preset (`packages/preset/cc/agent.cordis.yml`) composes the plugin, which installs
  hydration and the boundary guard.

## Tests

```bash
cd packages/workspace/session-cwd && npx vitest run tests/
```

(In a worktree whose root `node_modules` is a symlink the sandbox cannot write
into, add `--configLoader runner` to skip the `.vite-temp` bundle step.)
