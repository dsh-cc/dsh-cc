# Retiring the session-cwd overlay and re-wiring the WS2 guard / handoff keys

Status: **Design complete** — three-seat blind review converged GO (2026-11-01);
implementation in progress (this PR).

Follow-up to the harness 0.2.1-rc.5 migration
(`2026-10-30-harness-0.2.1-rc.5-migration.md` §PR-B): "retire `session-cwd`
overlay, re-wire WS2 guard + handoff keys, re-plumb worktree cwd; hard
precondition: merge before any feature touches cwd again".

## 1. Goal and non-goals

**Goal.** Make the harness `workingDirectory` service the single owner of the
session working directory across dsh-cc by retiring the process-local
session-cwd overlay (`SessionCwdStore`, the write-through holder, and the S10
mirror bridge), and re-wiring: the WS2 boundary guard, the handoff-store
project keys, every sync/async session-cwd reader, and every writer
(Enter/ExitWorktree, adopt paths, isolation children).

**Non-goals.**
- No change to the harness repo (read-only, standing directive).
- No change to `cwdOf` in `@dsh-cc/memory` (`packages/memory/memory/src/paths.ts:206`)
  — it reads the *bound* workspace (`header.cwd`) by design; its docstring is
  fixed to say so explicitly so no implementer "helpfully" rewires it.
- TUI bound-project surfaces stay on `header.cwd` semantics deliberately:
  the statusline command's execution cwd
  (`packages/ui/tui/src/harness/statusline-wiring.ts:203`), the HUD branch
  probe (`driver-hud.ts:64,204`), and skill discovery for
  `skills.snapshot()` (`driver-catalog.ts:175-178`). Only the statusline
  *payload's cwd field* is rewired (D8). This is the "execution cwd vs bound
  project identity" split, recorded as the decision.
- No new WS2 boundary semantics: same decision shape (ask unless
  `bypassPermissions`), convenience guard, not a security boundary.
- No dual-write of `worktree/entered` going forward (D4).

## 2. Verified baseline facts

### 2.1 Harness service (source-verified; probe-verified where marked)

- `@deepseek-ai/dsh-working-directory` (`harness packages/session/working-directory`),
  cordis name `workingDirectory`, `static inject = ['fs', 'sessionProjections', 'systemPrompt']`.
- `get(session)` is **synchronous** (`src/index.ts:122-124`): projection
  read, no fs I/O; returns `defaultDirectory` (construction-time
  `process.cwd()`) when nothing is recorded — never `undefined`.
- `set(agent, path, signal?)` (`src/index.ts:163-170`): async, serialized
  per session (`src/index.ts:208-221`), canonicalizes through
  `fs.processPath` (realpath; probe-verified macOS `/var` → `/private/var`),
  appends `working-directory/change` only when the value changes
  (`src/index.ts:186-191`), and injects a user-visible notice message
  ("The working directory changed from X to Y", `createUserMessage` +
  `agent.inject`, `src/index.ts:185-205` — verified verbatim; already live
  since S10's write-through, not a new regression).
- Projection init is `header => header.cwd ?? null` (`src/index.ts:86`);
  `sessionProjections.stateOf(session, 'workingDirectory')` is a sync,
  undefined-able cold read (`session-projection/src/index.ts:320-328`;
  `undefined` when the key is not registered in that realm).
- Subagent manager applies child cwd on the LOCAL spawn path:
  `manager.ts:411` resolves `request.cwd` via `resolveDirectory`
  (`manager.ts:525-531`; absolute passes verbatim, relative resolves
  against `ensure(parent)`), `:443` stores it on `create.cwd`, and
  `manager.ts:892-894` `await workingDirectory.set(child, create.cwd)` in
  unpublished setup, before `agent/created` and the child's first step.
  (`manager.ts:490-499` is the EXTERNAL path.)
- `agent/created` is a serial event: listeners are awaited before creation
  resolves; a non-undefined return stops later listeners; a rejection fails
  creation (`core/agent/src/index.ts:552-556`,
  `runtime-types.ts:249-261`). `prepend` = `unshift`, so registration order
  matters (`vendor/cordis/src/events.ts:254-257`).
- `working-directory/change` is in `KNOWN_SESSION_EVENT_TYPES`
  (`core/session/src/known-event-types.ts:83`), not ignorable; 0.2.0
  readers refuse such logs (no downgrade path — already true of every
  0.2.1 session).
- `agent.ctx` is a public seam (`core/agent-loop/src/index.ts:654,811`);
  probe-verified that `agent.ctx.get('workingDirectory')` resolves in a
  real cordis composition with the service mounted, that sync `get`
  equals `header.cwd` for a fresh session, and that a committed `set` is
  immediately observable through the sync read.

### 2.2 dsh-cc session-cwd today

Package anatomy (6 src files): `events.ts` (registers `worktree/entered` in
`KNOWN_SESSION_EVENT_TYPES` at load; last-wins fold; append writer),
`state.ts` (process-local overlay — RETIRED), `api.ts`
(overlay→fold→header→fallback resolution chain), `service-holder.ts` (S10
write-through — RETIRED), `working-directory-bridge.ts` (S10 mirror/hydrate —
RETIRED), `listener.ts` (WS2 pre-execute guard + `readPermissionMode`),
`index.ts` (plugin face; `{{cwd}}` registrar `index.ts:83-90`, asserted by
`preset/cc/tests/composition.spec.ts:761`). Sole composition mount:
`packages/preset/cc/agent.shared.cordis.yml:723-724`.

Inventory corrections recorded during review: `sessionCwdStore` has ONE
external import — the test `packages/subagent/task/tests/worktree-isolation.spec.ts:24`
(removed with the rewrite); the post-edit-verify test writer sites are
`composition.spec.ts:77,152,194`; `tool-git-worktree/src/exec.ts:25-27`
`sessionCwd(exec)` reads `header.cwd` for repo search — intentional WS-1
pinned root, unchanged.

### 2.3 Consumer inventory

| Consumer | Use | Notes |
|---|---|---|
| `workspace/tool-git-worktree` | `updateSessionCwd` (exec.ts:37-49) from 5 sites; `readPermissionMode`; pinned header read | writers async-able |
| `subagent/task` worktree-isolation | `subagent/start` listener `setSessionCwd` (:347-357); dispatch passes NO cwd; background-start cherry-picks request fields (:324-336, :440-449); seam type (:62-72) lacks cwd | F-1 |
| `subagent/handoff-store` | `projectKeyOf(getSessionCwd(agent))` (store.ts:34-35) | F-7 |
| `ui/tui` | `liveSessionCwd(agent, fallback)` (driver-live.ts:51-52); `statusline-wiring.ts:159` raw header read | D8 |
| `interaction/permission-rules` | `workspaceOf(agent)` = fold ?? header (session-allow-service.ts:57-59), 13 sync sites | F-5 |
| `context/context-crusher` | projectKey via `getSessionCwd` (index.ts:309-319, defer/pass.ts:144,263) | callers async |
| `skill/skill-usage` | `getSessionCwdForSession` at index.ts:127-136 and rollup.ts:29,118 (session/created) | F-6 |
| `interaction/vwa-evidence` wiring.ts:120-126, `vwa-argument` index.ts:256-283 | sync `workspaceRoot(agent)` callbacks | unchanged |
| `interaction/lsp-on-write` wiring.ts:65,83, `post-edit-verify` wiring.ts:75 | async callers | unchanged |
| comment/alias-only | progress-rebuild, completion-gate, hooks-claude-code, advisor-watchdog | no change |

## 3. Target architecture

```
                 ┌──────────────────────────────────────────────┐
                 │ harness workingDirectory service (single    │
                 │ owner): sync get / stateOf, async set        │
                 │ durable `working-directory/change` events    │
                 └──────────────▲───────────────────────────────┘
   writes: Enter/ExitWorktree + adopt → awaited service.set;       reads: facade
   isolation children → request.cwd (manager sets, awaited          (service-first,
   before first step); legacy logs → one-shot hydration            undefined-able)
   ONLY when the legacy event is NEWER (seq precedence)
```

`@dsh-cc/session-cwd` survives as a thin facade + guard + hydration owner:
no overlay, no write-through, no mirror.

## 4. Decision ledger

### D1 — Package fate: slim retain
Four duties: sync facade accessors, WS2 guard, legacy hydration, `{{cwd}}`
registration. Delete `state.ts`, `service-holder.ts`,
`working-directory-bridge.ts`, `appendWorktreeEntered`, the `sessionCwd`
convenience object, and `BoundaryListenerConfig.store`.

### D2 — Facade semantics
```
resolveSessionCwd(agent): string | undefined        // undefined-able
  try service := agent.ctx?.get('workingDirectory')  // try/catch — cordis
  catch → service = undefined                        // no-inject access throws
  if service:
    v := stateOf(agent.session, 'workingDirectory')  // via sessionProjections
    return typeof v === 'string' ? v : undefined
  return foldSessionCwd(agent.session.snapshotEvents())
      ?? agent.session.header.cwd

getSessionCwd(agent, options?): string              // total, signature kept
  return resolveSessionCwd(agent) ?? options?.fallback ?? process.cwd()
```
State semantics: a REGISTERED projection whose state is `null` means "no
header cwd and no events" — `resolveSessionCwd` returns `undefined` and the
legacy-fold fallback does NOT apply (the registered projection is
authoritative). The fold fallback runs only when the projection/service is
absent in the realm. The facade never throws (all cordis access guarded).
`getSessionCwdForSession` and `setSessionCwd` are REMOVED.

### D3 — Writers: awaited `service.set`; notice accepted
`updateSessionCwd(exec, path)` becomes async: resolves the service via
`agent.ctx` (try/catch); service unresolvable ⇒ skip silently (test fakes);
`service.set` rejection ⇒ propagate to the tool result (no silent
divergence); passes `exec.signal`. Tool bodies `await` it. No
`worktree/entered` append. The per-change harness user message ("The
working directory changed from X to Y") is accepted and documented —
already live since S10.

### D4 — Legacy log compatibility: seq-precedence hydration
`worktree/entered` stays registered in `KNOWN_SESSION_EVENT_TYPES` (stock
harness keeps opening old logs). Hydration listener body:
```
on agent/created (global):
  events := session.snapshotEvents()
  legacySeq := seq of last `worktree/entered`
  nativeSeq := seq of last `working-directory/change`
  if legacySeq === undefined: return
  if nativeSeq !== undefined && nativeSeq > legacySeq: return   // never clobber
  folded := foldSessionCwd(events)
  current := stateOf(session, 'workingDirectory')
  if typeof current === 'string' && current === folded: return
  try { await service.set(agent, folded) }
  catch (e) { logger.warn(`session-cwd: hydration failed: ${e}`) }
  return                                // ALWAYS undefined — serial contract
```
Awaited (agent creation awaits serial dispatch ⇒ structural initialization
barrier before later listeners and the first step). Precedence is by EVENT
SEQ, not value: `legacy(/A) → native(/A) → native(/B) → resume` must not
reset to `/A`; symlink spellings never equal canonical values. New sessions
contain no `worktree/entered` ⇒ pure no-op.

### D5 — Handoff keys: canonicalized derivation
`cwdProjectKey(agent)` := `projectKeyOf(canonicalize(getSessionCwd(agent)))`
where `canonicalize(p)` = `realpathSync(p)` in try/catch, raw on failure.
Rationale: the manager canonicalizes child cwd through `set()` while the
parent keeps raw spelling, so raw-string hashing splits parent and child of
the SAME physical directory — a functional break in entirely new sessions.
Upgrade re-key caveat (24h LRU retention ⇒ non-event) accepted.

### D6 — WS2 guard: dual-spelling containment
`boundaryDecision` root := `resolveSessionCwd(exec.agent)` (undefined ⇒
pass-through, as today). Containment canonicalizes BOTH sides: `realpathSync`
in try/catch → raw on failure, applied to the root AND to the target; the
caller resolves RELATIVE targets against the root first
(`resolve(root, target)` — never `process.cwd()`) and then canonicalizes;
the target is inside the workspace when the canonicalized target is inside
either the raw root OR the canonicalized root. `readPermissionMode`
unchanged.

### D7 — `{{cwd}}` prompt variable
Stays registered in the slim plugin's `apply()`. The plugin's static
`inject` stays empty (silent-PENDING trap); the child-plugin
`ctx.inject(['workingDirectory'], …)` idiom serves the hydration listener.

### D8 — TUI rewiring
`liveSessionCwd(agent, fallback)` keeps its signature, implemented as
`resolveSessionCwd(agent) ?? fallback`. Statusline payload
(`statusline-wiring.ts:159`) rewires to `liveSessionCwd`. Statusline command
execution cwd, HUD branch probe, skill discovery stay bound-project.

### D9 — permission-rules: undefined-able workspace
`workspaceOf(agent)` := `resolveSessionCwd(agent)` — same `string |
undefined` contract as today; sandbox-auto keeps its `next()` passthrough;
`hostFacts` keeps its explicit throw. Grant-root safety holds: fingerprints
hash file bytes (`task-grant-command.ts:63-81`); grant/match roots already
`normalizePath`-realpath (`task-grant.ts:437-450`); grants replay across
resume (regression test added).

## 5. Per-file change spec (implementation order)

1. **`packages/workspace/session-cwd`** (core slice): DELETE `state.ts` /
   `service-holder.ts` / `working-directory-bridge.ts`; new
   `src/hydration.ts` per D4; rewrite `api.ts` per D2; `listener.ts` per
   D6 (drop `store` config); `events.ts` keeps registration + fold, drops
   the append writer; `index.ts` keeps face, adds hydration, drops
   bridge/holder/store re-exports and the `sessionCwd` object;
   `package.json` devDependencies += `@deepseek-ai/dsh-working-directory`,
   `@deepseek-ai/dsh-fs-local`, `@deepseek-ai/dsh-session-projection`
   (link:); README en+zh rewrite.
2. **`packages/workspace/tool-git-worktree`**: `exec.ts` async
   `updateSessionCwd` per D3; 5 call sites `await`; pinned-root comment.
3. **`packages/subagent/task`** (F-1, three mandatory edits):
   `background-start.ts` — `BackgroundRequest.cwd?: string`; widen the
   duck-typed `SubagentsLike.startActivation` request type with `cwd?`;
   forward `...(request.cwd !== undefined ? { cwd: request.cwd } : {})`
   in BOTH request constructors (:324-336, :440-449). `worktree-isolation.ts`:
   dispatch adds `cwd: entry.worktreePath`; the `subagent/start` adoption
   listener is deleted; pin capture uses `request.cwd ?? cwdOf(parent)`.
4. **`packages/interaction/permission-rules`**: `workspaceOf` :=
   `resolveSessionCwd(agent)`.
5. **`packages/ui/tui`**: `driver-live.ts` per D8; `statusline-wiring.ts:159`
   per D8.
6. **`packages/subagent/handoff-store`**: `cwdProjectKey` canonicalization
   per D5.
7. **`packages/skill/skill-usage`**: both sites (`index.ts:127-136`,
   `rollup.ts:29,118`) resolve the service per-call via closure ctx in
   try/catch; undefined ⇒ skip row; no static inject, no apply-time capture.
8. **Zero-call-site-change consumers**: context-crusher, vwa-evidence,
   vwa-argument, lsp-on-write, post-edit-verify (test rigs updated).
9. **Docs**: capability yaml entry text, `pnpm docs:parity`, README trio.

## 6. Test plan

1. Facade (service present): real-service rig; fresh ⇒ header cwd; after
   `set` ⇒ canonical path; unregistered-projection realm ⇒ fold fallback.
2. Facade (service absent): `worktree/entered(/A)`-only ⇒ `/A`; empty ⇒
   header; both undefined ⇒ caller fallback.
3. Hydration: legacy-only ⇒ hydrated + one event; MIXED log with newer
   native ⇒ NO overwrite; second resume ⇒ no-op; vanished dir ⇒ warn, no
   throw; later creation listener observes hydrated cwd.
4. Guard: symlink-spelled target inside canonical root ⇒ pass-through;
   outside both ⇒ ask; `bypassPermissions` ⇒ allow; non-fs/pathless/
   agentless/undefined-root ⇒ pass-through.
5. Enter/ExitWorktree e2e: service value === worktree path; log gains
   `working-directory/change`, no `worktree/entered`; bash pwd in worktree;
   exactly one harness notice per enter/exit.
6. Isolation child: fake-shell spec asserts `continuationStarts()[0].cwd
   === entry.worktreePath`; real-boot/integration assert committed child
   cwd via `realpathSync` before first tool; foreground and background
   paths covered independently.
7. Handoff: parent `handoff_put`, child `handoff_get` resolves under a
   symlinked tmpdir (same key).
8. `{{cwd}}`: existing composition assertion stays green.
9. Statusline payload carries live cwd mid-worktree; command cwd stays
   header.
10. skill-usage: telemetry + rollup under service-mounted and -absent rigs;
    skip-on-undefined preserved; keys consistent.
11. Resumed grant: pre-upgrade raw-spelling root still authorizes
    post-upgrade canonical workspaceOf across resume.
12. Gates: `tsc -b --force`, affected vitest, `check:spec-deps`, four
    static gates, `check-readme --write`, `check:size`, `check:exports`
    (removed exports enumerated: `setSessionCwd`, `getSessionCwdForSession`,
    `sessionCwdStore`, `SessionCwdStore`, `appendWorktreeEntered`,
    `installWorkingDirectoryBridge`, `hydrateWorkingDirectory`,
    `workingDirectoryService`, `writeThroughWorkingDirectory`, `sessionCwd`
    object), `smoke:profile-boot`.

## 7. Compatibility summary

Old logs readable (registration kept; seq-precedence hydration migrates
exactly once, never clobbers newer native state). New logs carry
`working-directory/change` instead of `worktree/entered`. Handoff keys
canonicalized (upgrade-boundary re-key accepted; parent/child consistency
fixed). `getSessionCwd(agent, options?)` kept; `resolveSessionCwd` added.

## 8. Review ledger (three-seat blind review, 2026-11-01)

- **Round 1 (full)**: internal critic GO-WITH-CHANGES (10 findings);
  external reviewer A (grok) GO-WITH-CHANGES (14 findings, $1.97/24 turns);
  external reviewer B (codex) NO-GO (8 findings, 63.8k tokens). The NO-GO
  was adjudicated as a severity-calibration delta on the same substance
  (three seats overlapped on the forwarding seam and the hydration
  listener); codex's unique blocker (hydration clobbering a newer native
  cwd) passed the implement-as-written test and was folded at blocker
  level. 14 folds (F-1..F-14), ledger in the working notes.
- **Round 2 (delta)**: critic GWC with one PROBLEM (containment fix
  canonicalized only the root — target side added) + one wording NEW;
  both folded. Reviewer A GWC with one naming defect + one
  relative-target defect; both folded. Reviewer B GO (all folds OK).
- **Round 3 (micro-confirm)**: critic GO; reviewer A GO ($0.13/5 turns).
  Reviewer B's GO predates two mechanical wording fixes (disclosed: they
  do not change its folded substance).
- Provenance: all load-bearing harness-side claims source-anchored and
  live-probed by the orchestrator (service reachability from `agent.ctx`,
  sync `get`, realpath canonicalization, durable event, `commit()` notice
  text read verbatim).
