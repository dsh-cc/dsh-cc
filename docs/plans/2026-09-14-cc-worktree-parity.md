# Claude Code Worktree Parity Program — Design Document

**Date:** 2026-09-14
**Status:** Implemented — PR #62 (open). Review provenance: critic verdict approve-with-changes with all must-fix findings folded in; Codex blind review attempted but blocked by the session sandbox
**Scope:** `dsh-cc` monorepo; upstream `deepseek-harness` touched as proposal-only annex
**Baseline:** Claude Code worktree surface per the official docs (`code.claude.com/docs/en/worktrees`, `settings-reference`, `tools-reference`, `hooks`), verified 2026-09-14; dsh-cc at `origin/main` d5227f0.

---

## 1. Problem Statement

dsh-cc's worktree support covers mid-session enter/exit, launcher `--worktree`, `/quit` cleanup, session-cwd persistence, and a removed-worktree resume guard (PR #58). Claude Code's worktree surface has since grown far beyond that: isolation enforcement backed by the sandbox, creation-time security hardening, a managed lifecycle (locks, sweep, base selection), resume-time identity verification, and an ecosystem layer (`.worktreeinclude`, `WorktreeCreate`/`WorktreeRemove` hooks, PR-referenced worktrees, subagent `isolation: worktree`). The capability manifest entry `workspace.worktree` still reads `deviation: none` against an upstream summary that only describes mid-session enter/exit — it materially understates the delta.

## 2. Hard Constraint: Harness Is Read-Only

Per user directive (2026-09-10), `deepseek-harness` must never be modified — no checkout edits, no fork, no upstream PR from us. Three parity items physically require harness seams. They are designed here as **upstream proposals only** (§11) and are explicitly out of the implementation scope of this program:

1. **Sandbox extra writable roots** — `SandboxExecutionPolicy { mode, workspaceRoot, sessionId? }` (harness `packages/sandbox/sandbox/src/index.ts:34-50`) has no extra-roots field; `writableRoots()` (`sandbox/src/roots.ts:47-54`) is the single allow-list feeding both the fs fence and the macOS Seatbelt profile. Without it, `git add`/`git commit` from inside a worktree cannot be sandbox-legal (they write the main checkout's shared `.git`).
2. **`SubagentStartRequest.cwd`** — the harness stamps every child session's `header.cwd` with the parent cwd (`subagent/src/child-agent.ts:146`); sandbox policy and the bash default workdir follow `header.cwd`. True subagent worktree isolation needs a per-child cwd at spawn.
3. **`resume({ meta })` cwd override** — needed for CC's "resume a deleted/unsafe worktree session in the launch directory and clear the binding" behavior; dsh-cc currently warns instead (PR #58).

## 3. Current-State Inventory (verified)

| Layer | Where | State |
|---|---|---|
| Enter/ExitWorktree tools | `packages/workspace/tool-git-worktree` | Slug validation, `-B` branch reset, path-containment refusal, `discard_changes` remove gate. Repo root via `git rev-parse --show-toplevel` (`src/index.ts:165`) — **wrong inside a linked worktree** (returns the worktree itself → nested creation). Plain `git worktree add` runs repository-local filter drivers — a security gap. |
| Session cwd | `packages/workspace/session-cwd` | Durable `worktree/entered` event; pre-execute boundary guard (`listener.ts`) returns ask outside the session workspace. The harness sandbox does **not** read the fold (WS3 of the 2026-09-02 design remains unimplemented). |
| Launcher `--worktree` | `packages/launcher/tui/bootstrap.mjs`, `bin/dsh-cc.js` | Plain-JS duplicate of the TS convention ("keep in sync" comment); named-reuse, random slugs, `DSH_CC_WORKTREE` marker; base is a literal `HEAD`; runs `git worktree prune` pre-launch (`bin/dsh-cc.js:71`). Reads no settings. |
| Exit cleanup | `packages/ui/tui/src/harness/worktree-exit.ts` | `/quit` overlay: keep/remove/cancel, managed-vs-detected, evidence gate. Always asks; no CC-style auto-remove for clean unnamed sessions. |
| Resume | `packages/ui/tui/src/harness/resumed-cwd-guard.ts` | Guard notice, anchor tombstone, boot gate (PR #58). No git-identity verification of the stored worktree. |
| Subagents | `packages/subagent/task` | `isolation` parsed (`claude-code-agents/src/parse.ts:139,164`), carried on the definition, behaviorally ignored. Child cwd = parent `header.cwd`, always. |
| Hooks | `packages/hooks/hooks-claude-code` | `WorktreeCreate`/`WorktreeRemove` in the unsupported list (`src/config.ts:24-43` `CLAUDE_EVENTS`); `Setup` is the closest standalone-async template (`src/index.ts:275-279`). |
| Settings | `packages/settings/settings-cascade` | No `worktree` namespace; the `permissions` section is the registration pattern (`src/permissions.ts:40-50` + `installSection`). |
| Sandbox escalation UX | `packages/interaction/permission-rules/src/approval-listener.ts` | `approval/request` waterfall listener exists and auto-answers sandbox escalations — the extension point for the git-write interim. |

## 4. Target Feature Matrix

| # | Feature (CC baseline) | dsh-cc today | Priority | Workstream |
|---|---|---|---|---|
| 1 | Sandbox permits worktree git-metadata writes | Escalation prompt every time | P0 | WS-2 (documented limitation) + §11.1 (real fix) |
| 2 | Filter-driver neutralization at creation | Runs repo filter drivers | P0 | WS-1 |
| 3 | Worktree git-identity check before adopt/resume | Existence check only | P0/P1 | WS-1 (adopt), WS-5 (resume) |
| 4 | `isolation: worktree` wired for subagents | Parsed, ignored | P0 | WS-3 |
| 5 | `git worktree lock` + metadata marker + periodic sweep (`worktree.cleanupPeriodDays`) | None | P1 | WS-4 |
| 6 | `worktree.baseRef` `fresh`/`head` | Literal `HEAD` | P1 | WS-4 |
| 7 | Exit: clean + unnamed → auto-remove | Always prompts | P1 | WS-5 |
| 8 | Name reuse: reset-to-default-when-merged | Reuse at old tip | P1 | WS-4 |
| 9 | `.worktreeinclude` | None | P2 | WS-6 |
| 10 | `WorktreeCreate`/`WorktreeRemove` hooks | Unsupported | P2 | WS-6 |
| 11 | `--worktree "#1234"` / PR/MR URL | None | P2 | WS-6 |
| 12 | EnterWorktree `path` form + outside-`worktrees/` approval | `name` only | P2 | WS-6 |
| 13 | Worktree-sandboxed background sessions (agent view) | No agent view | out of scope | — |
| 14 | Non-interactive `-p` worktree semantics | No `-p` in this surface | out of scope | — |
| 15 | Windows junction-safe removal | Not audited | out of scope (note only) | — |

Common CC conventions dsh-cc already matches and keeps: `.claude/worktrees/<slug>` location, `worktree-<slug>` branch prefix, 64-char slug cap, flattened `+` segments, random adjective-noun slugs, settings.local.json / project plugins read from the main checkout.

## 5. Architecture Overview

Six workstreams, each an independent PR, ordered by priority then coupling. All creation-path changes land in **both** call sites (TS tool + plain-JS launcher) unless marked otherwise; the triplication with `worktree-exit.ts` is acknowledged as accepted debt with a "keep in sync" pointer, matching today's convention.

- **WS-1 — Creation hardening (P0):** pin the repository root to the git common dir; neutralize repository-local filter drivers during `git worktree add`; refuse symlinked creation paths; verify worktree git identity before adopting an existing directory.
- **WS-2 — Git-write sandbox limitation (P0, documentation-only):** verified during review that the `approval/request` payload (`{ agent, toolName, callId?, reason?, signal? }`, harness `@deepseek-ai/dsh-user-approval` types) carries no command, argv, or tool args, and parsing the free-form `reason` string is version-coupled to a read-only upstream; an argv0-only gate would also be exploitable via `git -c core.fsmonitor=<cmd>`. No dsh-cc-side interim is sound; the gap is documented as an explicit deviation and the real fix is §11.1. No implementation PR.
- **WS-3 — Subagent `isolation: worktree` (P0):** create/delegate/cleanup inside `packages/subagent/task`, documenting the header-cwd deviation.
- **WS-4 — Lifecycle & base selection (P1):** `worktree` settings section (`baseRef`, `cleanupPeriodDays`); lock/marker on enter and launcher sessions; boot-time sweep; name-reuse merged-reset.
- **WS-5 — Exit & resume semantics (P1):** auto-remove clean unnamed worktrees on `/quit`; resume-time worktree git-identity verification.
- **WS-6 — Ecosystem (P2):** `.worktreeinclude`; `WorktreeCreate`/`WorktreeRemove` hooks; `--worktree` PR reference; EnterWorktree `path` form.

## 6. Detailed Design

### WS-1 — Creation hardening

**Files:** `packages/workspace/tool-git-worktree/src/{worktree.ts,index.ts}`, `packages/launcher/tui/bootstrap.mjs`, `packages/launcher/tui/bin/dsh-cc.js`; tests in each respective `tests/`.

1. **Common-dir root pinning.** One resolution rule, shared by this item and item 4 below: run `git rev-parse --git-common-dir` at the probe cwd; resolve relative answers against that cwd; the repository root is the parent directory of the resulting `<mainRoot>/.git`. (Inside a linked worktree `--git-common-dir` already returns the main `…/.git` — no `worktrees/<name>` case exists on this path; that spelling only appears in a worktree's `.git` *file* `gitdir:` line, which is item 4's input.) Both call sites. Effect: EnterWorktree invoked from inside a worktree creates a **sibling** under the main root's `.claude/worktrees/`, never a nested tree.
2. **Filter-driver neutralization.** Before `git worktree add`, read the repository's *local* config (`git config --local --list` at the main root; a read failure → refuse with a named error, mirroring CC). Collect every `filter.<name>.*` key. Refuse creation when the local config contains `includeIf` or a filter name contains `=` or a newline (both CC refusal shapes). Local scope only, matching CC's threat model exactly — CC likewise does not refuse on a global `includeIf`. The neutralization mechanism (empty `-c filter.<name>.command=` overrides vs `required=false`-only vs env-based `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` injection) is chosen **empirically at implementation**: the integration test creates a repo whose local config wires a filter `command` to a script that writes a marker file, and asserts the marker file *does not exist* after `git worktree add` — "no filter binary executes", not "exit 0". Document the CC-identical consequence: LFS content arrives as pointer files; `git lfs pull` inside the worktree restores it.
3. **Symlink refusal.** Reuse `fs.resolve`-based containment and additionally refuse when `.claude`, `.claude/worktrees`, or the target path itself is a symlink (CC v2.1.212 parity), with the error naming the offending path.
4. **Identity check on adoption.** When `EnterWorktree`/reuse targets an existing directory: read its `.git` entry; refuse when it is a directory whose `commondir` resolves into the main checkout's own `.git` root (a plain clone or a `core.worktree` redirect would make `git reset --hard` hit the main checkout), when the entry is unreadable, or when the directory contains the main checkout. A directory with no git metadata at all is refused under the convention dir (it may hold user work) — hook-created trees are WS-6's concern. Refusals leave the directory in place and name the recovery.

**Behavioral deviations from CC admitted here:** CC only allows the `path` form from within a worktree; dsh-cc keeps allowing `name` creation but now anchors it correctly — strictly more permissive, recorded in the manifest.

### WS-2 — Git-write sandbox limitation (documentation-only, resolved at review)

**No implementation.** Review established the facts:

- The sandbox-escalation `approval/request` payload is `{ agent, toolName, callId?, reason?, signal? }` — no command, argv, or tool args; `toolName` yields at most `"Bash"`. A sandbox-runtime-originated escalation may even lack `callId`, so session-log correlation is unreliable against a pinned, read-only upstream.
- The denied target path is only available by parsing the free-form `reason` string — undocumented, version-coupled, fragile.
- Even with command identity, a gate on argv0 `git` is exploitable: `git -c core.fsmonitor=<cmd>`, `-c core.pager=<cmd>`, and shell aliases execute arbitrary commands *as* `git`.

Conclusion: no dsh-cc-side auto-allow is sound. The limitation is recorded as an explicit deviation on the `workspace.worktree.tools` manifest entry (WS-1 re-scopes it in §7) and the durable fix is upstream proposal §11.1 (which must then grant `objects` + refs, not just `worktrees/<name>`, or `git commit` stays denied).

### WS-3 — Subagent `isolation: worktree`

**Files:** `packages/subagent/task/src/{tool.ts,worktree-isolation.ts}` (new), `packages/workspace/tool-git-worktree/src/index.ts` (export `addWorktree`-family constructors — they are pure and need no session singleton), `packages/preset/claude-code-agents` README, `docs/claude-code-capabilities.yaml`.

Flow per dispatch whose definition has `isolation: 'worktree'`:

1. **Create.** Slug = derived from the child id (preallocated — `background-start.ts` already does this), validated by `validateSlug`; run `addWorktree` via `ctx.shell` at the WS-1 pinned repo root; record the base `HEAD` for the cleanliness probe. Creation failure → dispatch fails with a named error (never silently fall back to the parent tree).
2. **Adopt.** On the first `agent/created`/`subagent/start` for that child id: `setSessionCwd(childAgent, worktreePath)` — writes to the **child's** log (parent log untouched; the fold is last-wins per session), which fixes the permission-rules workspace, the session-cwd boundary guard (the 2026-09-02 design's WS2), and the context buckets for the child. Append a paragraph to the child persona: *your working directory is `<path>`; pass absolute paths inside it to every tool and shell `workdir`; the parent checkout is off-limits.*
3. **Clean up.** One `subagent/end` listener keyed to the child id: probe `status` + `commitsAhead`; clean and no commits → `forceRemoveWorktree` + `deleteBranch`; otherwise leave the tree and say so in the final text. Continuable/background children re-fire start/end per epoch — removal only ever fires on a clean probe, and a dirty tree stays for the next epoch by construction.
4. **Lock.** Take `git worktree lock --reason` at creation, release before removal (feeds WS-4's sweep). Tolerate pre-2.15 git by treating "unknown option" as a no-op.

**Documented deviations (manifest):** the child's `header.cwd`, the harness sandbox root, and the bash default workdir remain the parent's (needs §11.2). Consequently: containment is strongest when the parent runs at the repo root (worktrees live inside the sandbox root); when the parent runs in a subdirectory, child writes to the worktree are **denied** by the fs sandbox and the delegated child hard-fails — the tool description and persona both state the absolute-path contract, matching EnterWorktree's own convention. Serena (user-mounted) pins one project root per session and will not follow the child — noted in the tool description.

### WS-4 — Lifecycle: settings, locks, sweep, reuse

**Files:** `packages/settings/settings-cascade/src/` (new `worktree.ts` section), `packages/workspace/tool-git-worktree` (lock/unlock/marker), `packages/launcher/tui/bootstrap.mjs` + `bin/dsh-cc.js` (lock, sweep, reuse reset, bespoke settings read), `packages/ui/tui/src/harness/worktree-exit.ts` (unlock on remove).

1. **Settings section** `worktree`: `{ baseRef: 'fresh' | 'head' = 'fresh', cleanupPeriodDays: number = 30 }` (schemastery; absence-preserving union idiom per the kebab-namespace delivery memory). Registered via `installSection` in `tool-git-worktree`; consumers read through the settings thunk. The launcher cannot load the cascade (pre-build, dependency-free): it performs a documented ~30-line fail-open JSON read of the user/project/local settings files in precedence order — subset behavior, stated in the manifest.
2. **`baseRef` resolution.** `head` → literal `HEAD` (today's behavior; inside a worktree it resolves to that worktree's HEAD, matching CC). `fresh` → the remote default branch: `git symbolic-ref refs/remotes/origin/HEAD`; if the ref's reflog is older than 24h, `git fetch origin <default>` with a 5s cap, falling back to the cached ref and then to local `HEAD` when no remote exists. Creation commands take a resolved `<base>` parameter instead of the literal `HEAD` at both call sites.
3. **Locks and markers.** On EnterWorktree create and on launcher-managed session start: `git worktree lock --reason="dsh-cc session <id>"`. Release on ExitWorktree (both actions), on `/quit` removal, and at TUI dispose for the managed case. The launcher's `DSH_CC_WORKTREE` marker JSON gains a `named: boolean` field here (WS-5's auto-remove predicate consumes it — cross-PR coupling, flagged). Ownership triple-gate for the sweep: convention dir + `worktree-` branch prefix + lock-reason prefix. **Stale-lock policy (review-amended):** dsh-cc never auto-releases locks — a fresh launcher process has no trustworthy cross-process session-liveness oracle, and age-based release can unprotect a merely-quiet live session. Instead the sweep *reports* dsh-cc-prefixed locks older than the cleanup window as advisory lines (`git worktree unlock <path>` to release). Deviation from CC (which auto-releases crashed-session locks) recorded in the manifest; killed sessions in dsh-cc surface as advisory output, never silent deletion.
4. **Sweep.** In `bin/dsh-cc.js` beside the existing `git worktree prune` (:71): enumerate `git worktree list --porcelain`; candidates = under `.claude/worktrees/`, branch prefix `worktree-`, not `locked`, age > `cleanupPeriodDays`. Age is **last-commit `%ct` whenever git metadata is readable**, with directory mtime only as the unreadable-metadata fallback (mtime drifts upward on stable, actively-developed clean trees — review finding). Skip — fail-closed — when `git status --porcelain` is non-empty or unreadable, when `git rev-list @{u}..HEAD` is non-empty or upstream probing errors, or when any probe errors. Remove via `git worktree remove` and delete the branch. The sweep prints one summary line plus one advisory line per stale dsh-cc lock; it never blocks launch beyond a 10s overall cap, and it never performs network I/O (`baseRef`'s fetch is creation-path only).
5. **Reuse reset.** Launcher named-reuse path gains the CC rule: when the existing tree is clean, still on its `worktree-*` branch, and either has no own commits or its upstream is gone with every commit reachable from the resolved fresh base → `git reset --hard <fresh-base>` before handing over; otherwise continue at the old tip; any unverifiable probe → old tip (never destroy).

### WS-5 — Exit & resume semantics

**Files:** `packages/ui/tui/src/harness/worktree-exit.ts`, `driver-run-local.ts`, `resumed-cwd-guard.ts`.

1. **Auto-remove on exit.** When `/quit` detects a *managed* session whose worktree evidence is clean (zero changes, zero commits — the existing probe) **and** the session carries no user-pinned name, skip the overlay and remove silently (CC's unnamed-session rule); remove the resume anchor via the existing tombstone helper. Named sessions and dirty trees keep today's overlay.
2. **Resume identity verification.** Extend `resumedCwdGuard` with the WS-1 identity check for stored cwds that sit under a `.claude/worktrees/` convention dir: `.git` entry readable and resolving to `…/.git/worktrees/<name>` of the same repository, not a network-path spelling (exclude `//`/`\\` prefixes and macOS `/net` mounts), not an ancestor of the launch directory. Failures degrade exactly like the existing guard — notice + stay — because the true fallback-to-launch-dir needs §11.3. Distinct notices per refusal class, mirroring CC's message taxonomy.

### WS-6 — Ecosystem

**Files:** `packages/workspace/tool-git-worktree` (include-copy, path form), `packages/hooks/hooks-claude-code` (`CLAUDE_EVENTS`, `payloads.ts`, run-point seam), `packages/launcher/tui/bootstrap.mjs` + `bin/dsh-cc.js` (PR references, include-copy in plain JS), `packages/hooks/hooks-claude-code/README*.md`.

1. **`.worktreeinclude`.** Tool-side only (`EnterWorktree` creation; reviewed decision — no plain-JS launcher clone: it would be the first *semantic* duplication, a parser rather than a command string; launcher `--worktree` sessions lack include-copy, recorded as a manifest deviation). Read at the main root; `.gitignore` syntax. Matched **and** `git check-ignore`-confirmed files are copied into every created worktree (preserving relative paths). No new dependency: a minimal matcher supports the gitignore subset (comments, `!` negation, trailing `/`, `*`, `?`, `**`), plus CC's `**/`-piercing rule — a `**/foo` pattern matches inside a wholly-ignored directory only when the directory itself matches or its path's first name equals the pattern's first literal segment.
2. **`WorktreeCreate`/`WorktreeRemove` hooks.** Add both to `CLAUDE_EVENTS` with payload `{ sessionId, cwd, name, worktreePath, branch, source: 'worktree-flag' | 'enter-worktree' | 'subagent-isolation' }` (create) / `{ sessionId, cwd, worktreePath, reason: 'exit' | 'subagent-finished' | 'sweep' }` (remove). `WorktreeCreate` replaces default creation when it exits 0 with a stdout path: the path is adopted after the WS-1 identity check (hook-created dirs without git metadata are accepted **only** when no git repository contains them — CC parity). `WorktreeRemove` replaces default removal; its failure keeps the tree. The bridge's internal run-point is exposed through a small provided service instead of being re-implemented by consumers. Launcher limitation documented: pre-build `bin/dsh-cc.js` cannot run hooks; `--worktree` sessions therefore keep git-direct creation (manifest deviation).
3. **`--worktree` PR references.** Launcher flag values `#<n>`, a GitHub PR URL, or a GitLab MR URL: fetch from `origin` — `pull/<n>/head` for github.com, `merge-requests/<n>/head` for gitlab.com, first-then-second for any other host; create at `.claude/worktrees/pr-<n>` on branch `worktree-pr-<n>` with the fetched head as base. PR-named reuse never triggers the WS-4 reset (CC parity). Tool-side `EnterWorktree` stays name-only.
4. **EnterWorktree `path` form.** New optional `path` parameter: absolute or repo-relative; must resolve to an existing directory. Under the session repo's `.claude/worktrees/` → direct adoption (identity check). Anywhere else → an ask that **always** fires: the approval-seam stage is registered with a marker that "don't ask again" persistence skips, and the tool description states that only bypassPermissions skips it (CC v2.1.206 parity). Within a worktree session, `path` must stay under the same repo's `worktrees` dir (CC's from-within-a-worktree rule); `name` creation now also stays legal there per WS-1's pinned root (recorded divergence).

## 7. Capability Manifest Actions

One PR-level obligation each, same commit (validator rules I3/I4/I7 apply; regenerate via `pnpm docs:parity` and commit matrix + README block + capabilities.json):

- **WS-1:** re-scope `workspace.worktree` → split into `workspace.worktree.tools`, `workspace.worktree.launcher`; upstream summaries rewritten against the current CC surface; both start `deviation: downgrade` (baseRef/path-form/hooks pending at that point).
- **WS-2:** no manifest action beyond a deviation line on `workspace.worktree.tools` (folded into WS-1's re-scope): git writes to the shared `.git` require a sandbox escalation; the auto-allow interim was evaluated and rejected (payload lacks command identity; argv0 gate exploitable).
- **WS-3:** new entry `subagents.isolation` (`plane: preset`, cordis anchor on the task row) at `behavioral: partial` — header-cwd deviation documented (I3 forces `ux: partial` accordingly).
- **WS-4:** new `workspace.worktree.lifecycle`; the launcher's bespoke settings read is noted.
- **WS-5:** evidence on `sessions.persistence` (guard extensions) and `workspace.worktree.lifecycle`.
- **WS-6:** new `hooks.worktree-events` and `workspace.worktree.ecosystem`; the launcher hook gap recorded.

## 8. Testing Strategy

- WS-1: unit (common-dir resolution matrix incl. relative answers; neutralization argv; symlink cases) + real-git integration (repo with a malicious-looking filter driver; LFS-pointer assertion optional).
- WS-2: no implementation, hence no specs; the deviation line is validated by the manifest round-trip.
- WS-3: task-dispatch specs with fake shell (creation argv, persona append, `setSessionCwd` on the child only, end-cleanup clean vs dirty), plus a real-git integration; the same-epoch continuation race (`waitNoActivation`) governs any cold-resume test.
- WS-4: settings section specs (defaults, merge, launcher subset-reader parity table), sweep decision-table specs (locked/dirty/unpushed/young survive), baseRef resolution specs with a fake shell, reuse-reset specs.
- WS-5: worktree-exit specs (auto-remove predicate), resumed-cwd-guard specs per refusal class.
- WS-6: matcher conformance table (incl. `**/` piercing), hook bridge specs (stdout path adoption, failure keeps git path), PR-reference parse/fetch specs (fake shell), EnterWorktree-path specs (approval always fires; permission persistence cannot suppress).
- Every PR: package suites from the repo root (`node_modules/.bin/vitest run <path>`), `tsc -b tsconfig.packages.json`, `node scripts/check-spec-deps.mjs` for new cross-package test imports, file-size budget respected (extract modules rather than ratchet).

## 9. Rollout Plan

| Order | Commit | Depends on |
|---|---|---|
| C-1 | This document + WS-1 (creation hardening) | — (plan-doc date = git-added date of this file) |
| C-2 | WS-3 (subagent `isolation: worktree`) | C-1 (root pin, constructor exports) |
| C-3 | WS-4 (settings, locks, sweep, baseRef, reuse reset, marker `named`) | C-1 (creation sites) |
| C-4 | WS-5 (exit auto-remove, resume identity check) | C-3 (worktree-exit coupling; marker `named`) |
| C-5 | WS-6 (`.worktreeinclude`, hooks, PR references, path form) | C-3 (sweep hook reason), C-2 (subagent source enum) |

One PR at the end contains C-1…C-5.

WS-2 shipped no implementation (documentation-only, §6). Per user direction the remaining workstreams land as **sequential commits on this session's working branch and ship as a single PR** once all are complete (commit-per-workstream granularity keeps the diff reviewable); the dependency order above is the commit order. Executor agents implement; the orchestrator verifies diffs/specs/tsc per commit; root-cause failures route to the critic before re-planning.

## 10. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Convention triplication (tool TS ↔ launcher JS ↔ worktree-exit) drifts further | Every WS patch touches all three sites in the same PR; a follow-up generator (not in scope) could emit the launcher module from TS. |
| Launcher bespoke settings read diverges from the cascade | Single documented subset (two keys, three files, first-hit-wins), parity-table spec. |
| Sandbox escalation UX for worktree git writes (WS-2 gap) | No dsh-cc-side interim is safe (§6 WS-2); documented deviation + upstream proposal §11.1. |
| Subagent child hard-fails on sandbox-denied writes (delegated children cannot prompt) | Persona + tool description absolute-path contract; dispatch-time refusal when the worktree would fall outside the parent's sandbox root **and** the definition is isolation:worktree (surface, don't lull). |
| Sweep destroys user work | Fail-closed everywhere: any unreadable probe → keep; locks honored; branch-prefix + convention-dir + lock-reason triple gate. |
| Neutralization breaks LFS workflows | Documented CC-identical behavior; error/notices mention `git lfs pull`. |
| `git worktree lock` on ancient git | "unknown option" → no-op with a one-line warn; sweep then falls back to age+cleanliness gates only. |
| Manifest validator ordering/prefix rules (I3/I4/I7) | `pnpm docs:parity` loop per PR; tests carry cordis anchors where `plane: preset`. |

## 11. Upstream Proposals (out of scope here; harness is read-only for us)

1. **`SandboxExecutionPolicy.extraWritableRoots?: readonly string[]`** — consumed in `writableRoots()` (`sandbox/src/roots.ts`) so both the fs fence and Seatbelt inherit; per-session source folded from a session event in `SandboxPolicyService.resolve` (`sandbox-policy/src/index.ts:158-166`). dsh-cc would then grant `<mainRoot>/.git/**` for the managed-worktree session (the grant must include `objects` and refs, not just `worktrees/<name>`, or `git commit` stays denied).
2. **`SubagentStartRequest.cwd` + provider capability flag** — plumbed to `childSessionMeta` (`subagent/src/child-agent.ts:146`) so a child's header cwd, sandbox root, and bash default workdir can all be the subagent worktree; removes WS-3's deviations wholesale.
3. **`ResumeAgentOptions.meta`/cwd override** — lets dsh-cc implement CC's resume-into-launch-dir + persisted binding-clear instead of warn-and-stay (`resumed-cwd-guard.ts` already documents this seam's absence).

## 12. Open Questions

1. Default `cleanupPeriodDays`: 30 chosen absent a documented CC default — confirm against observed CC behavior later; the setting makes this cheap to change.
2. Should the launcher sweep also run under bare `dsh cc-tui` in a **non-managed** cwd? Current answer: yes, it is repository-scoped housekeeping like the existing prune.
3. A future opt-in `--sweep-release-locks` for stale dsh-cc-prefixed locks (v1 only reports them — see WS-4).

---

**References:**
- [Worktree Session Isolation](./2026-09-02-worktree-session-isolation.md) (WS1–WS4 foundation; its WS3 remains aspirational — absorbed into §11.1 here)
- [worktree-resume tombstone](./2026-09-13-worktree-resume-tombstone.md) (PR #58 baseline this program extends)
- Claude Code docs: worktrees, settings-reference, tools-reference, hooks (verified 2026-09-14)
