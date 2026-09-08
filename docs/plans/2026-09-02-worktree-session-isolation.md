# Worktree Session Isolation — Design Document

**Date:** 2026-09-02
**Status:** Implemented — PR #82 (merged 2026-09-02). Original readiness record: "Ready for implementation (WS0 verification passed)."
**Scope:** `dsh-cc` monorepo — interactive harness, permission rules, workspace tools

---

## 1. Problem Statement

The agent currently lacks a stable session boundary for filesystem operations. Three related issues were identified:

1. **Unreliable working directory:** `EnterWorktree` only writes a process-local singleton (`packages/workspace/tool-git-worktree/src/index.ts:195-216`) without updating `session.header.cwd`. Subsequent Bash commands that omit an explicit `workdir` parameter execute in the main checkout rather than the worktree (`tools/beta-modules/tool-bash/src/node/bash-command.ts:277-297`).

2. **Permission rule ineffectiveness:** The permission classifier uses `session.cwd` as its scope boundary (`packages/interaction/permission-rules/src/index.ts:429`). In launcher-mode sessions, the actual working directory is the worktree but the sandbox scope remains the main checkout, causing repeated approval prompts. Additionally, `allowRuleOf` fails to strip environment variable prefixes (`approval-preview.ts:115-126`), causing persisted rules to never match incoming commands.

3. **No session-scoped approval memory:** The permission pipeline (`decide()`) only checks exact string matches and persistent allow rules. There is no mechanism to remember approvals for the duration of a session without writing to global settings.

## 2. Root Cause Analysis

| Issue | Root Cause | Evidence |
|-------|-----------|----------|
| CWD mismatch | `EnterWorktree` does not propagate the new path to `session.header.cwd`; Bash falls back to process CWD | `tool-git-worktree/src/index.ts:195-216`, `bash-command.ts:277-297` |
| Scope misalignment | Classifier uses `session.cwd` as scope; sandbox scope is main checkout; mismatch triggers MEDIUM classification | `permission-rules/src/index.ts:429` |
| Rule derivation failure | `allowRuleOf` includes env prefixes (e.g., `FOO=bar npm`) in the derived rule, which never matches subsequent commands | `approval-preview.ts:115-126` |
| Session amnesia | `decide()` returns early on HIGH/MEDIUM without consulting session-scoped allowlists | `permission-rules/src/index.ts:397-400` |

## 3. WS0 Gate Verification

Pre-implementation verification confirmed the following constraints and opportunities:

| Finding | Evidence | Design Impact |
|---------|----------|---------------|
| Sandbox escalation prompts are independent of permission modes | `runtime-code.ts:124-130` shows sandbox escalations use a separate `approval/request` seam; `auto` mode only suppresses LOW-risk asks from permission-rules | WS4 must implement an approval-seam listener, not just a permission-mode override |
| Session event types are extensible | `session.ts` defines a live `KNOWN_SESSION_EVENT_TYPES` set; plugins register new types at load time | WS1 can add `worktree/entered` events; registration must occur at plugin initialization |
| Plugin ordering uses `prepend`, not YAML row order | `agent.cordis.yml:460-465` shows how to register listeners before the permission-rules waterfall | WS2's guard listener must use `{ prepend: true }` |
| Per-call sandbox policy exists | `writeback.ts:71-78` shows the fs sandbox accepts `{mode, workspaceRoot}` per call | WS3 can inject session-scoped policies without modifying the sandbox implementation |
| Git writes are workspace-scoped | Bash writes to `.git/` only for paths inside the worktree; `git -C` writes to shared repo only when worktree is main | Permission model can treat "inside worktree" as the default allow boundary |

## 4. Architecture Overview

The solution is organized into four workstreams, each delivering an independent PR:

- **WS1 — Session CWD Foundation**: Introduce a session-scoped working directory state managed by a new `session-cwd` plugin.
- **WS2 — Filesystem Boundary Enforcement**: Add a pre-execute listener that guards against unauthorized filesystem access outside the workspace.
- **WS3 — Sandbox Integration**: Align sandbox policies with the session workspace to eliminate unnecessary approval prompts.
- **WS4 — Permission UX Improvements**: Fix rule derivation and implement session-scoped approval memory.

## 5. Detailed Design

### WS1 — Session CWD Foundation

**Objective:** Establish a reliable, session-scoped working directory that persists across restarts and is respected by all tools.

**Changes:**

1. **New plugin `session-cwd`:**
   - Registers the `worktree/entered` session event type at plugin load (required for persistence layer compatibility).
   - Maintains a foldable session state tracking the current working directory.
   - Exposes `getSessionCwd()` and `setSessionCwd(path)` APIs.
   - On `setSessionCwd`, emits a `worktree/entered` event with the new path.

2. **Update `EnterWorktree` tool:**
   - Instead of writing only to the process-local singleton, call `setSessionCwd(worktreePath)`.
   - Update the tool description and system prompt to remove instructions about manually passing `workdir` (the session cwd is now authoritative).

3. **Update `ExitWorktree` tool:**
   - Call `setSessionCwd(originalCwd)` to restore the previous working directory.
   - Emit a `worktree/exited` event for audit purposes.

**Key Invariants:**
- The session cwd is a logical property of the session, not the process.
- The default session cwd is the worktree root (or the user's home directory if not in a git repo).
- The `worktree/entered` event is persisted to survive session restarts.

### WS2 — Filesystem Boundary Enforcement

**Objective:** Prevent silent escape from the session workspace via filesystem operations.

**Changes:**

1. **Pre-execute guard listener:**
   - Register a listener on the `tools/pre-execute` waterfall with `{ prepend: true }` to ensure it runs before permission-rules.
   - For every `fs` operation, resolve the target path against the session cwd (from WS1).
   - If the resolved path is outside the session workspace:
     - If permission mode is `bypassPermissions`, allow (audit log only).
     - Otherwise, return `{ kind: 'ask' }` with a clear reason: "Operation targets path outside session workspace."

2. **Integration with `cd` tool:**
   - Update the `cd` tool to call `setSessionCwd` instead of mutating process state directly.

**Key Invariants:**
- The boundary is workspace-scoped, not path-scoped. Any path inside the workspace is allowed.
- The guard is a pre-execute convenience, not a hard security boundary. It does not intercept system calls.
- The listener must not interfere with the git-worktree tool's internal operations (which legitimately operate on the main checkout).

### WS3 — Sandbox Integration

**Objective:** Align sandbox policies with the session workspace to reduce unnecessary approval prompts.

**Changes:**

1. **Per-call policy injection:**
   - For the agent's Bash tool, inject a sandbox policy with `workspaceRoot` set to the session cwd.
   - This allows the Bash tool to operate within the workspace without triggering sandbox escalation prompts.

2. **Approval flow alignment:**
   - When a sandbox escalation occurs (operation outside the policy), the approval prompt should reference the session workspace boundary.

**Key Invariants:**
- The sandbox policy is per-call and derived from the current session cwd.
- The policy is additive: it grants workspace access without removing other permissions.

### WS4 — Permission UX Improvements

**Objective:** Fix rule derivation and implement session-scoped approval memory.

**Changes:**

1. **Fix `allowRuleOf` derivation:**
   - Strip environment variable prefixes (e.g., `FOO=bar npm install` → rule matches `npm`).
   - Handle common command prefixes (e.g., `sudo`, `npx`, `yarn`) correctly.

2. **Session-scoped allowlist:**
   - Add a session-scoped allowlist that is checked in `decide()` before returning early on MEDIUM/HIGH.
   - When the user approves an ask, offer "Allow for this session" as an option.
   - Session-scoped approvals are not persisted to global settings.

3. **Approval seam listener:**
   - Register a listener on the `approval/request` seam to handle sandbox escalations.
   - In `auto` mode, auto-approve sandbox escalations that originate from within the session workspace.

**Key Invariants:**
- Session-scoped approvals are ephemeral and do not persist across sessions.
- The approval flow is auditable: all approvals (persistent and session-scoped) are logged.

## 6. Implementation Plan

### Phase 1: WS1 — Session CWD Foundation (fast-worker)

**Deliverables:**
- New `session-cwd` plugin with event registration and foldable state.
- Updated `EnterWorktree` and `ExitWorktree` tools.
- Unit tests for event folding and API behavior.
- Integration tests for tool behavior.

**Acceptance Criteria:**
- `EnterWorktree` updates `session.cwd` correctly.
- `ExitWorktree` restores the original cwd.
- Session cwd persists across restarts.

### Phase 2: WS2 — Filesystem Boundary Enforcement (fast-worker)

**Deliverables:**
- Pre-execute guard listener with workspace boundary checks.
- Updated `cd` tool integration.
- Unit tests for boundary enforcement.
- Integration tests for tool behavior.

**Acceptance Criteria:**
- Operations outside the workspace trigger an ask.
- Operations inside the workspace proceed without interference.
- The guard does not interfere with legitimate git-worktree operations.

### Phase 3: WS3 — Sandbox Integration (fast-worker)

**Deliverables:**
- Per-call sandbox policy injection for Bash tool.
- Approval flow alignment.
- Unit tests for policy injection.
- Integration tests for approval flow.

**Acceptance Criteria:**
- Bash operations within the workspace do not trigger sandbox escalation prompts.
- Sandbox escalations reference the session workspace boundary.

### Phase 4: WS4 — Permission UX Improvements (fast-worker)

**Deliverables:**
- Fixed `allowRuleOf` derivation.
- Session-scoped allowlist in `decide()`.
- Approval seam listener for sandbox escalations.
- Unit tests for rule derivation and allowlist behavior.
- Integration tests for approval flow.

**Acceptance Criteria:**
- Derived rules correctly match subsequent commands.
- Session-scoped approvals are remembered for the duration of the session.
- Auto mode auto-approves sandbox escalations within the workspace.

## 7. Testing Strategy

Each phase includes:

- **Unit tests:** Test individual components in isolation (event folding, boundary checks, policy injection, rule derivation).
- **Integration tests:** Test component interactions (tool → plugin → listener).
- **End-to-end tests:** Test complete workflows from the agent's perspective.

## 8. Rollout Plan

1. **Phase 1:** WS1 — Session CWD Foundation. Must merge first (foundation for other phases).
2. **Phase 2:** WS2 — Filesystem Boundary Enforcement. Depends on WS1.
3. **Phase 3:** WS3 — Sandbox Integration. Depends on WS1.
4. **Phase 4:** WS4 — Permission UX Improvements. Depends on WS1, WS2, WS3.

## 9. Success Criteria

The refactor is successful when:

- The agent's working directory is always explicit and consistent across tools.
- Operations outside the session workspace require explicit user approval.
- Operations within the session workspace proceed without unnecessary prompts.
- Approval rules are correctly derived and remembered for the session duration.
- All existing functionality continues to work without regression.

## 10. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Session cwd manipulation breaks existing workflows | Comprehensive integration tests; gradual rollout with feature flags |
| Sandbox policy injection is too permissive | Workspace-scoped by default; audit logging for all policy injections |
| Session-scoped approvals are confused with persistent approvals | Clear UI distinction; audit logging; documentation |
| Pre-execute listener interferes with legitimate operations | Allowlist for git-worktree internal operations; comprehensive testing |

## 11. Open Questions

1. Should session cwd be persisted across sessions, or reset to worktree root on new sessions?
2. Should the "Allow for this session" option be available for all operations or only specific risk levels?
3. Should sandbox policy injection be configurable per-project or global?

---

**References:**
- [WS0 Verification Report](./ws0-verification.md) (pre-implementation verification)
- [Permission Rules Architecture](./permission-rules-architecture.md) (existing permission system)
- [Sandbox Architecture](./sandbox-architecture.md) (existing sandbox system)
