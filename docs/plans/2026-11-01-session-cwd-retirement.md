# PR-B Design: Retiring the session-cwd overlay and re-wiring the WS2 guard / handoff keys

Status: **Implemented — PR #319 (open, pending merge).** Three-seat blind
review converged all-GO (2026-11-01); implementation authorized by the user
in the originating instruction.
Baseline: dsh-cc @ `59e3b3cd`, harness sibling @ `31cfe2aafe` (0.2.1-rc.5).

## 1. Goal and non-goals

**Goal.** Make the harness `workingDirectory` service the single owner of the
session working directory across dsh-cc by retiring the process-local
session-cwd overlay (`SessionCwdStore`, the write-through holder, and the S10
mirror bridge), and re-wiring: the WS2 boundary guard, the handoff-store
project keys, every sync/async session-cwd reader, and every writer
(Enter/ExitWorktree, adopt paths, isolation children). This is the
migration plan's "PR-B — cwd cleanup … hard precondition: merge before any
feature touches cwd again" (`docs/plans/2026-10-30-harness-0.2.1-rc.5-migration.md:168`).

**Non-goals.**
- No change to the harness repo (read-only, standing directive).
- No change to `cwdOf` in `@dsh-cc/memory` (`packages/memory/memory/src/paths.ts:206`)
  — it reads the *bound* workspace (`header.cwd`) by design; its docstring is
  fixed to say so explicitly (F-12) so no implementer "helpfully" rewires it.
- TUI bound-project surfaces stay on `header.cwd` semantics deliberately:
  the statusline command's execution cwd
  (`packages/ui/tui/src/harness/statusline-wiring.ts:203`), the HUD branch
  probe (`driver-hud.ts:64,204`), and skill discovery for
  `skills.snapshot()` (`driver-catalog.ts:175-178`). Only the statusline
  *payload's cwd field* is rewired (D8). This is the "execution cwd vs bound
  project identity" split, recorded here as the decision (F-10).
- No new WS2 boundary semantics: same decision shape (ask unless
  `bypassPermissions`), convenience guard, not a security boundary.
- No dual-write of `worktree/entered` going forward (D4).

## 2. Verified baseline facts

### 2.1 Harness service (all source-verified; probe-verified where marked)

- `@deepseek-ai/dsh-working-directory` (`harness packages/session/working-directory`),
  cordis name `workingDirectory`, `static inject = ['fs', 'sessionProjections', 'systemPrompt']`.
- `get(session)` is **synchronous** (`src/index.ts:122-124`): projection
  read, no fs I/O; returns `defaultDirectory` (construction-time
  `process.cwd()`) when nothing is recorded — never `undefined`.
- `set(agent, path, signal?)` (`src/index.ts:163-170`): async, serialized
  per session (`src/index.ts:208-221`), canonicalizes through
  `fs.processPath` (realpath; probe-verified macOS `/var` → `/private/var`),
  appends `working-directory/change` only when the value changes
  (`src/index.ts:186-191`), and **injects a user-visible notice message**
  ("The working directory changed from X to Y", `createUserMessage` +
  `agent.inject`, `src/index.ts:185-205` — verified verbatim; already live
  since S10's write-through, not a new PR-B regression).
- Projection init is `header => header.cwd ?? null` (`src/index.ts:86`);
  `sessionProjections.stateOf(session, 'workingDirectory')` is a sync,
  undefined-able cold read (`session-projection/src/index.ts:320-328`;
  `undefined` when the key is not registered in that realm).
- Subagent manager applies child cwd on the LOCAL spawn path:
  `manager.ts:411` resolves `request.cwd` via `resolveDirectory`
  (`manager.ts:525-531`; absolute passes verbatim, relative resolves
  against `ensure(parent)`), `:443` stores it on `create.cwd`, and
  `manager.ts:892-894` `await workingDirectory.set(child, create.cwd)`
  in unpublished setup, before `agent/created` and the child's first step.
  (`manager.ts:490-499` is the EXTERNAL path — r1 anchor corrected.)
- `agent/created` is a serial event: listeners are awaited before creation
  resolves; a non-undefined return stops later listeners; a rejection fails
  creation (`core/agent/src/index.ts:552-556`,
  `runtime-types.ts:249-261`). `prepend` = `unshift`, so registration
  order matters for listener ordering (`vendor/cordis/src/events.ts:254-257`).
- `working-directory/change` is in `KNOWN_SESSION_EVENT_TYPES`
  (`core/session/src/known-event-types.ts:83`), not ignorable; 0.2.0
  readers refuse such logs (no downgrade path — already true of every
  0.2.1 session).
- `agent.ctx` is a public, used seam (`core/agent-loop/src/index.ts:654,811`);
  probe-verified that `agent.ctx.get('workingDirectory')` resolves in a real
  cordis composition with the service mounted (`packages/subagent/task/tests/zz-prb-probe.spec.ts`).

### 2.2 dsh-cc session-cwd today

Unchanged from v1 §2.2 (package anatomy: events/state/api/service-holder/
bridge/listener/index; sole mount
`packages/preset/cc/agent.shared.cordis.yml:723-724`; `{{cwd}}` registrar
`session-cwd/src/index.ts:83-90`, personas interpolate it, asserted by
`preset/cc/tests/composition.spec.ts:761`). Corrections from r1 review
(F-12): `sessionCwdStore` has ONE external import — the test
`packages/subagent/task/tests/worktree-isolation.spec.ts:24` (removed with
the rewrite); the post-edit-verify test writer sites are
`composition.spec.ts:77,152,194`; `tool-git-worktree/src/exec.ts:25-27`
`sessionCwd(exec)` reads `header.cwd` for repo search — **intentional WS-1
pinned root**, recorded, unchanged.

### 2.3 Consumer inventory (r1-corrected)

| Consumer | Use | Notes |
|---|---|---|
| `workspace/tool-git-worktree` | `updateSessionCwd` (exec.ts:37-49) from 5 sites; `readPermissionMode` (pathform.ts:17,100-103); `sessionCwd(exec)` pinned header read | writers async-able; permission fold stays sync |
| `subagent/task` worktree-isolation | `setSessionCwd(child, worktreePath)` in `subagent/start` listener (:347-357); dispatch (:406-418) passes NO cwd today; **background-start.ts cherry-picks request fields** (:324-336, :440-449), seam type (:62-72) lacks cwd | F-1 |
| `subagent/handoff-store` | `projectKeyOf(getSessionCwd(agent))` = `sha256(cwd).hex.slice(0,16)` (store.ts:34-35) | F-7 canonicalization added |
| `ui/tui` | `liveSessionCwd(agent, fallback)` (driver-live.ts:51-52, caller fallback honored); `statusline-wiring.ts:159` raw header read | F-8c, D8 |
| `interaction/permission-rules` | `workspaceOf(agent)` = `foldSessionCwd ?? header?.cwd` (session-allow-service.ts:57-59), 13 sync sites | F-5 undefined-able contract |
| `context/context-crusher` | `getSessionCwd` → projectKey (index.ts:309-319, defer/pass.ts:144,263) | callers async |
| `skill/skill-usage` | `getSessionCwdForSession` at index.ts:127-136 (user/message listener) **and rollup.ts:29,118** (session/created, before agent/created) | F-6 |
| `interaction/vwa-evidence` wiring.ts:120-126, `vwa-argument` index.ts:256-283 | sync `workspaceRoot(agent)` callbacks | unchanged call sites |
| `interaction/lsp-on-write` wiring.ts:65,83, `post-edit-verify` wiring.ts:75 | async callers | unchanged call sites |
| comment/alias-only | progress-rebuild, completion-gate, hooks-claude-code, advisor-watchdog | no code change |

## 3. Target architecture

```
                 ┌──────────────────────────────────────────────┐
                 │ harness workingDirectory service (single    │
                 │ owner): sync get / stateOf, async set        │
                 │ durable `working-directory/change` events    │
                 └──────────────▲───────────────────────────────┘
   writes: Enter/ExitWorktree + adopt → awaited service.set;       reads: facade
   isolation children → request.cwd (manager sets, awaited          (service-first,
   before first step); legacy logs → one-shot hydration              undefined-able)
   ONLY when the legacy event is NEWER (seq precedence)
```

`@dsh-cc/session-cwd` survives as a thin facade + guard + hydration owner
(D1, all three seats endorsed): no overlay, no write-through, no mirror.

## 4. Decision ledger (v2)

### D1 — Package fate: slim retain (unchanged; 3-seat endorsed)
Keep the package with four duties: sync facade accessors, WS2 guard, legacy
hydration, `{{cwd}}` registration. Delete `state.ts`, `service-holder.ts`,
`working-directory-bridge.ts`, `appendWorktreeEntered`, the `sessionCwd`
convenience object (its methods reference deleted APIs — F-8d), and the
`store` option of `BoundaryListenerConfig` (config surface shrinks to
`fsTools`).

### D2 — Facade semantics (rewritten per F-5/F-8)
Two exported resolvers in `api.ts`:

```
resolveSessionCwd(agent): string | undefined        // undefined-able
  try service := agent.ctx?.get('workingDirectory')  // try/catch — cordis
  catch → service = undefined                        // no-inject access throws
  if service:
    v := stateOf(agent.session, 'workingDirectory')  // sync, undefined-able,
    return typeof v === 'string' ? v : undefined    // via sessionProjections
  return foldSessionCwd(agent.session.snapshotEvents())
      ?? agent.session.header.cwd

getSessionCwd(agent, options?): string              // total, signature kept
  return resolveSessionCwd(agent) ?? options?.fallback ?? process.cwd()
```

- `getSessionCwdForSession` REMOVED (both consumers rewired in F-6;
  `session-only` reads go through each plugin's own ctx, see §5.7).
- `stateOf` is read via `agent.ctx.get('sessionProjections')` (also
  try/caught). Note the state semantics (critic r2): a REGISTERED
  projection whose state is `null` means "no header cwd and no events" —
  in that case `resolveSessionCwd` returns `undefined` and the legacy-fold
  fallback does NOT apply (the registered projection is authoritative; a
  null state cannot be superseded by the fold). The legacy-fold fallback
  runs only when the projection/service is ABSENT in the realm. When the
  projection is unregistered the facade falls through to the legacy fold —
  the silent `defaultDirectory` wrong-cwd mode is avoided by never calling
  the coalescing `get()` in the facade (F-5).
- The facade never throws (all cordis access guarded) — preserves the
  "resolver must not throw" contracts at `defer/pass.ts:144`,
  `tools.ts:44-50`, `wiring.ts:120-125` (F-8b).

### D3 — Writers: awaited `service.set`; user-message notice accepted (F-3)
- `updateSessionCwd(exec, path)` becomes async: resolves the service via
  `agent.ctx` (try/catch); **service unresolvable ⇒ skip silently** (test
  fakes); **`service.set` rejection ⇒ propagate to the tool result** (no
  silent divergence between tool success and session state); passes
  `exec.signal` to `set()`. Tool bodies `await` it. No
  `worktree/entered` append.
- Behavior note (accepted, documented): every changing commit injects a
  harness user message ("The working directory changed from X to Y") into
  the session — already live since S10; test snapshots updated accordingly
  (§6 item 5).
- `setSessionCwd(agent, path)` public API REMOVED (remaining callers are
  the rewired writers and one test seam, §5.7).

### D4 — Legacy log compatibility: seq-precedence hydration (rewritten per F-2)
`worktree/entered` stays registered in `KNOWN_SESSION_EVENT_TYPES` (stock
harness keeps opening old logs; load-time registration, costless). A
hydration listener replaces the bridge:

- Registered EARLY on the plugin context (the plugin mounts before agents
  exist, so plain `ctx.on('agent/created', …, { global: true })` is
  sufficient; `prepend` is not required for correctness because the body
  is order-tolerant — see below — but is used to win the earliest slot).
- Body (exact):
  ```
  on agent/created (global):
    events := session.snapshotEvents()
    legacySeq := seq of last `worktree/entered`      // undefined if none
    nativeSeq := seq of last `working-directory/change`
    if legacySeq === undefined: return               // nothing to hydrate
    if nativeSeq !== undefined && nativeSeq > legacySeq: return
                                                      // native state is newer —
                                                      // NEVER clobber it
    folded := foldSessionCwd(events)
    current := stateOf(session, 'workingDirectory')
    if typeof current === 'string' && current === folded: return
    try { await service.set(agent, folded) }
    catch (e) { logger.warn(`session-cwd: hydration failed: ${e}`) }
    return                                            // ALWAYS undefined —
                                                      // serial contract
  ```
- Awaited (not fire-and-forget): agent creation awaits serial dispatch, so
  hydration completes before any later `agent/created` listener and before
  the first step — the initialization barrier is structural (F-2b).
- Precedence is by EVENT SEQ, not value: `legacy(/A) → native(/A) →
  native(/B) → resume` must NOT reset to `/A`; symlink spellings never
  equal canonical values so value comparison is unusable (F-2a/c).
- New sessions contain no `worktree/entered` ⇒ the listener is a pure no-op
  for them.

### D5 — Handoff keys: canonicalized derivation (rewritten per F-7)
`cwdProjectKey(agent)` := `projectKeyOf(canonicalize(getSessionCwd(agent)))`
where `canonicalize(p)` = `realpathSync(p)` in try/catch, raw on failure.
Rationale: the manager canonicalizes child cwd through `set()` while the
parent keeps raw spelling (`ensure` preserves it), so raw-string hashing
splits parent and child of the SAME physical directory — a functional break
in entirely new sessions, beyond the accepted upgrade re-key. With
canonicalization, parent and child hash identically. Upgrade re-key caveat
(24h LRU retention ⇒ non-event) unchanged. `cwdProjectKey` still returns
`undefined` only for a missing agent (the facade is total and non-throwing,
F-8/F-14 — comment says so, no stronger claim).

### D6 — WS2 guard: dual-spelling containment (rewritten per F-4 + critic r2)
`boundaryDecision` root := `resolveSessionCwd(exec.agent)` (undefined ⇒
pass-through, as today). Containment canonicalizes BOTH sides: `realpathSync`
in try/catch → raw on failure, applied to the root AND to the target; the
target is inside the workspace when the (canonicalized) target is inside
either the raw root OR the canonicalized root (`isInsideWorkspace` gains
optional `canonicalRoot`; the caller resolves RELATIVE targets against the
root first (`resolve(root, target)` — never `process.cwd()`) and then
canonicalizes the target).
Rationale: after a `set()`, the service root is already realpath-canonical,
so accepting two root spellings alone does nothing — the failure mode is a
TARGET arriving in the pre-symlink spelling the user/model sees
(`/var/...` against root `/private/var/...`). Both sides must be
canonicalized for §6 item 4's pass criterion to be achievable. Same helper
is exported for permission-rules comparisons where spelling asymmetry
matters. `readPermissionMode` unchanged.

### D7 — `{{cwd}}` prompt variable (unchanged)
Stays registered in the slim package's `apply()` (`index.ts:83-90`,
WeakSet dedupe). The harness's own "Current working directory:" context
line is additive and unchanged. Do NOT add `workingDirectory` to the
plugin's static `inject` (silent-PENDING trap; the child-plugin
`ctx.inject(['workingDirectory'], …)` idiom stays for the hydration
listener's service resolution).

### D8 — TUI rewiring (scope-corrected per F-10)
- `driver-live.ts liveSessionCwd(agent, fallback)` KEEPS its signature and
  honors the caller fallback: implementation := `resolveSessionCwd(agent)
  ?? fallback` (the undefined-able resolver makes the caller fallback
  meaningful again — under v1's coalescing service read it was dead).
- Statusline payload: `statusline-wiring.ts:159` rewires from
  `header.cwd ?? cwd` to `liveSessionCwd` — payload now reports the live
  session cwd mid-worktree.
- Out of scope, recorded: the statusline command still EXECUTES under
  `header.cwd` (bound-project identity), as do the HUD branch probe and
  skill discovery — deliberate, unchanged.

### D9 — permission-rules: undefined-able workspace (rewritten per F-5/F-11)
`workspaceOf(agent)` := `resolveSessionCwd(agent)` — the SAME
`string | undefined` contract as today (fold ?? header). Consequences:
- sandbox-auto keeps its `next()` passthrough for cwd-less sessions;
  `hostFacts` keeps its explicit throw.
- Grant-root safety is BETTER than v1 claimed (r1 corrections folded): task
  -grant fingerprints hash FILE BYTES, not workspace strings
  (`task-grant-command.ts:63-81`); grant roots and match roots already
  `normalizePath`-realpath both sides (`task-grant.ts:437-450`), so a
  canonicalized `workspaceOf` still matches persisted grants for the same
  physical workspace, including across resume (grants replay from session
  logs — regression test added, §6 item 11).

### D10 — zero-call-site-change consumers (corrected per F-8a)
context-crusher, vwa-evidence, vwa-argument, lsp-on-write, post-edit-verify
keep their `getSessionCwd(exec.agent)` call sites and signatures; only the
package internals change (options/fallback semantics preserved by D2).
skill-usage is NOT in this class (§5.7).

## 5. Per-file change spec (implementation order; every file an implementer
could previously guess about is now explicit)

1. **`packages/workspace/session-cwd`** (core slice)
   - `src/state.ts`: DELETE. `src/service-holder.ts`: DELETE.
   - `src/working-directory-bridge.ts`: DELETE; replaced by
     `src/hydration.ts` exporting `installLegacyCwdHydration(ctx)` per D4
     (exact body in D4; service resolved via child-plugin
     `ctx.inject(['workingDirectory'], …)` idiom; `sessionProjections`
     resolved the same way).
   - `src/api.ts`: rewrite per D2 (`resolveSessionCwd` +
     `getSessionCwd(agent, options?)`; `getSessionCwdForSession` and
     `setSessionCwd` REMOVED).
   - `src/listener.ts`: D6 dual-spelling containment; drop
     `BoundaryListenerConfig.store`.
   - `src/events.ts`: keep registration + `foldSessionCwd`; DELETE
     `appendWorktreeEntered`.
   - `src/index.ts`: plugin face keeps {{cwd}} + guard; adds hydration
     install; drops bridge/holder/store re-exports AND the `sessionCwd`
     convenience object.
   - `package.json`: devDependencies += `@deepseek-ai/dsh-working-directory`
     (link), `@deepseek-ai/dsh-fs-local` (link),
     `@deepseek-ai/dsh-session-projection` (link) — spec-deps gate (F-9).
   - README en+zh rewrite (facade/guard/hydration; handoff re-key note).
2. **`packages/workspace/tool-git-worktree`**
   - `exec.ts`: `updateSessionCwd` per D3 (async, propagate set() failures,
     skip unresolvable service, pass exec.signal).
   - `index.ts` ×5: `await updateSessionCwd(...)`.
   - `pathform.ts`: `readPermissionMode` import unchanged;
     `sessionCwd(exec)` unchanged (WS-1 pinned root, comment added).
3. **`packages/subagent/task`** (F-1 — three mandatory edits)
   - `background-start.ts`: (a) `BackgroundRequest` gains `cwd?: string`;
     (b) the duck-typed `SubagentsLike.startActivation` request type gains
     `cwd?: string`; (c) BOTH request constructors (foreground collect
     :324-336 and background :440-449) forward
     `...(request.cwd !== undefined ? { cwd: request.cwd } : {})`.
     Capture-only fields stay unforwarded.
   - `worktree-isolation.ts`: dispatch adds `cwd: entry.worktreePath`;
     the `subagent/start` listener's `setSessionCwd` + try/catch is
     DELETED (the harness manager's awaited `set` supersedes it); the
     listener body keeps the registry bookkeeping if any remains.
   - Pin capture cwd for isolation children: `request.cwd ?? cwdOf(parent)`
     (F-12).
4. **`packages/interaction/permission-rules`** — `session-allow-service.ts`
   `workspaceOf` := `resolveSessionCwd(agent)` (undefined-able, D9).
5. **`packages/ui/tui`** — `driver-live.ts` per D8; `statusline-wiring.ts:159`
   per D8. TUI stubs have no ctx — `agent.ctx?.get` must not throw (D2
   try/catch covers; TUI fakes covered in §6).
6. **`packages/subagent/handoff-store`** — `cwdProjectKey` canonicalization
   per D5 (realpathSync try/catch); comment updated.
7. **`packages/skill/skill-usage`** (F-6 — the only new-code consumer)
   - `index.ts:127-136`: replace `getSessionCwdForSession(session)` with a
     per-call service resolution from the plugin's closure ctx (try/catch):
     `service ? stateOf-based undefined-able read : fold ?? header.cwd`;
     undefined ⇒ skip row (today's semantics preserved).
   - `rollup.ts:29,118`: `runRollup` already receives ctx — same per-call
     resolution (NEVER static inject, NEVER apply-time capture).
   - Key consistency across tool/slash/rollup paths asserted in tests.
8. **Zero-call-site-change consumers** — context-crusher, vwa-evidence,
   vwa-argument, lsp-on-write, post-edit-verify: no source change; their
   test rigs that mount session-cwd directly keep working through the
   facade (post-edit-verify writer sites :77,152,194 migrate to a
   service-backed rig per §6).
9. **Tests/docs per §6; capability/README surfaces per D12 (v1, unchanged).**

## 6. Test plan (driver → pass criterion; r1-corrected)

1. Facade, service present: real-service rig (probe rig recipe:
   `mountAgentLoopTestDependencies` + `JsonlSessionPersistence` +
   `LocalFileSystem` + `WorkingDirectory`, realpaths compared on Darwin) —
   fresh session ⇒ stateOf/header; after `await set` ⇒ canonical path;
   unregistered-projection realm ⇒ legacy-fold fallback.
2. Facade, service absent: `worktree/entered(/A)`-only log ⇒ `/A`; empty ⇒
   `header.cwd`; both undefined ⇒ `getSessionCwd` falls to caller
   fallback/process.cwd.
3. Hydration (F-2): legacy-only log ⇒ service value becomes folded path,
   one `working-directory/change`, awaited before a later `agent/created`
   listener observes cwd; MIXED log with newer native event ⇒ NO
   overwrite; second resume ⇒ no-op; vanished dir ⇒ warn, no throw,
   creation proceeds.
4. Guard (F-4): fs target inside RAW root spelling while service root is
   canonical (symlinked tmpdir) ⇒ pass-through, not ask; outside both ⇒
   ask (reason names both); `bypassPermissions` ⇒ allow; non-fs/pathless/
   agentless/undefined-root ⇒ pass-through.
5. Enter/ExitWorktree e2e: after enter, `stateOf/get` === worktree path;
   log gains `working-directory/change`, no `worktree/entered`; bash pwd in
   the worktree; transcript contains exactly one harness notice message
   per enter/exit (snapshot updated, F-3).
6. Isolation child (F-1): fake-shell spec asserts
   `continuationStarts()[0].cwd === entry.worktreePath` (service NOT
   mountable there — assertion is on the forwarded request); real-boot +
   integration specs mount the service and assert the committed child
   cwd via `realpathSync` before the child's first tool; both foreground
   and background dispatch paths covered independently.
7. Handoff (F-7): `handoff_put` in parent, `handoff_get` resolves in an
   isolation child under a symlinked tmpdir (parent raw / child canonical
   ⇒ same key).
8. `{{cwd}}`: existing composition.spec assertion stays green.
9. Statusline payload: mid-worktree payload carries the live cwd (new
   assertion); statusline command cwd remains header (regression guard).
10. skill-usage (F-6): telemetry row + rollup under service-mounted and
    service-absent rigs; skip-on-undefined preserved; tool/slash/rollup
    keys identical.
11. Resumed grant (F-11): grant persisted pre-upgrade (raw-spelling root)
    still authorizes post-upgrade under canonical workspaceOf, across
    session resume.
12. Gates: `tsc -b --force`, affected package vitest, `check:spec-deps`
    (new devDeps), four static gates, `node scripts/check-readme.mjs
    --write`, `check:size`, `pnpm run check:exports` (removed-export
    fallout enumerated: `setSessionCwd`, `getSessionCwdForSession`,
    `sessionCwdStore`, `SessionCwdStore`, `appendWorktreeEntered`,
    `installWorkingDirectoryBridge`, `hydrateWorkingDirectory`,
    `workingDirectoryService`, `writeThroughWorkingDirectory`,
    `sessionCwd` object), `smoke:profile-boot`.

## 7. Compatibility summary (unchanged from v1 plus folds)

- Old logs readable (type stays registered; seq-precedence hydration
  migrates forward exactly once and never clobbers newer native state).
- New logs: `working-directory/change` instead of `worktree/entered`.
- Handoff keys: canonicalized derivation; upgrade-boundary re-key accepted
  (24h retention); parent/child consistency fixed (F-7).
- Public API: `getSessionCwd(agent, options?)` kept;
  `resolveSessionCwd` added; the removed list in §6 item 12.

## 8. Residual risks

- R2 (unregistered-projection corners, TUI boot ordering): mitigated by the
  undefined-able stateOf facade (D2) — silent wrong-cwd mode structurally
  avoided; the fallback path is the legacy fold.
- R5 (missed consumers): r1 re-grep by three seats found exactly one
  (skill-usage rollup — folded). Implementation slice 1 re-runs the
  symbol-set grep before deleting exports.
- Probe-derived facts (session reachability, sync get, canonicalization,
  durable event) folded into §2.1; the probe spec becomes permanent test
  §6 item 1.

## 9. Review ledger

- **r1 (three blind seats, same dispatch)**: internal critic GO-WITH-CHANGES
  (10 findings), external grok GO-WITH-CHANGES (14 findings, $1.97/24t),
  external codex NO-GO (8 findings, 63.8k tokens). Overlap was high; the
  NO-GO was adjudicated as a severity-calibration delta on the same
  substance (implement-as-written test), with codex's unique BLOCKER
  (hydration clobbering a newer native cwd) accepted at blocker level.
  All findings folded as F-1..F-14 into design v2 (working ledger kept in
  the session's `.scratch/`; not committed).
- **Delta round (r2)**: each seat received only its own findings -> fold
  mapping. critic: F-4 PROBLEM (containment canonicalized only the root;
  target-side canonicalization + relative-target resolution added) and one
  wording NEW (D2 stateOf null-state semantics) — both folded and verified
  GO in a follow-up confirmation. codex: F-1..F-11 all OK, VERDICT: GO
  (22.2k tokens). grok: 13 OK + one naming PROBLEM + one NEW — both items
  were already fixed in the file before grok's read completed (byte race;
  grok's references pointed at pre-fix bytes, verified stale against the
  current file), independently confirmed by the internal seat's GO
  confirmation of the same two edits.
- **r3 micro-confirmation (grok only)**: both edits verified present and
  correct; VERDICT: GO ($0.09/3t).
- **Probe provenance**: the load-bearing runtime facts (service resolvable
  via `agent.ctx`, sync `get()`, realpath canonicalization, durable change
  event) were probe-verified live before r1 (a temporary probe spec under
  `packages/subagent/task/tests/`, to be folded into the permanent test
  plan as item 1); the `set()` user-message notice was verified verbatim
  in harness source by the orchestrator before folding.
- **Scope honesty**: r2/r3 were delta and micro-confirmation rounds, not
  full re-reviews. User sign-off: the full pipeline (design -> three-seat
  review -> implementation -> PR) was explicitly authorized in the
  originating instruction.
