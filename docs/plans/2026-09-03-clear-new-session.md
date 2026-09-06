# `/clear` / `/new` / `/reset` — New Session In-Process

**Date:** 2026-09-03
**Status:** Ready for implementation (staff review landed; two review premises corrected against source)
**Scope:** `packages/ui/tui` (TUI-local slash commands + session bind path). No new package.

---

## 1. Problem Statement

`/clear` is documented and catalogued as a TUI-local command, but it only drops transcript rows. The next prompt still rides the same agent, the same session id, and the same durable log. Users who expect Claude Code semantics — empty context, previous conversation still resumable — get a screen wipe.

Evidence:

- Catalog copy: `packages/ui/tui/src/slash.ts` (`description: 'Clear the transcript rows'`).
- Handler: `packages/ui/tui/src/harness/driver-run-local.ts` emits `clearRows` and returns.
- Reducer: `packages/ui/tui/src/store/session.ts` `clearRows` zeros `rows` (and drops `notice`) and **keeps** session title, session id, and the live agent.
- `switchSession` comments that the window title must not reset inside `clearRows` because `/clear` shares it and must keep the same session's title (`packages/ui/tui/src/harness/driver-sessions.ts`).
- There is no in-process "new session" command. Fresh sessions exist only at boot (`ctx.agents.create` in `packages/ui/tui/src/harness/driver.ts`) or via the launcher (`dsh-cc --new` / `-n`).

Claude Code (`/clear`, aliases `/reset` and `/new`) starts a new empty conversation, leaves the previous transcript on disk, and lets `/resume` restore it. Kimi Code 1.45 made `/clear` an alias of `/new` for the same reason. dsh-cc currently matches CC's **Ctrl+L** (redraw), not CC's `/clear`.

## 2. Root Cause Analysis

| Symptom | Root cause | Evidence |
|---------|------------|----------|
| Screen clears, model still sees history | `/clear` mutates TUI view-model only | `clearRows`; submit still `followup`s the live agent |
| No in-process new session | `agents.create` is boot-only; `switchSession` only `agents.resume`s | `driver.ts` create sites; `driver-sessions.ts` |
| `/new` / `/reset` missing | `LOCAL_SLASH` does not list them; unknown names fall through as prompts | `slash.ts` `parseSlash` |

dsh has no `conversation_id` distinct from `session_id`. The CC SDK `conversation_reset` event (same `session_id`, new `new_conversation_id`) has no native mapping. The honest equivalent is **create a new dsh session and bind it in the live TUI**, leaving the old session's durable log in place.

## 3. Decisions (staff review + source check)

Staff review verdict was **proceed with changes**. Two review premises were wrong against this tree and are **not** followed:

1. **Do not skip-if-virgin on `markedContent === false`.** `switchSession` sets `markedContent` to `false` even when the target has history (`driver-sessions.ts`). A `/resume` into a long session followed by `/clear` would no-op. Always create. Empty leftover sessions are acceptable; GC is a follow-up, not this PR.
2. **Permission mode is not in `createArgs`.** Boot `createArgs` is `{ sessionId, meta: { cwd, agentPreset? }, setup, agentOptions? }` (`driver.ts`). Mode is a durable `permission/mode` (or plan-mode) session event, folded by `liveMode` (`driver-live.ts`). A brand-new session is `default` until we re-apply. `/clear` must capture the live mode **before** dispose and re-apply it on the new agent.

Followed from review:

- Reuse `switchSession`'s bind path; create-before-dispose; no `conversation_id`; no harness `command-clear` package; no optional previous-session label; no Ctrl+L; no empty-session GC; no fake CC `SessionStart`/`SessionResume` `clear` source.
- Preserve the live `/model` route (MUST, not SHOULD).
- Do not add a `createFreshHandle` method on `DriverSessionsCtx`. Pass a small `createHandle` closure from `driver.ts` (the sessions module already calls `ctx.agents.resume` the same way).
- Mid-turn `/clear` must not wait for the turn to finish naturally. Cancel first, then create, then dispose (dispose already "stops the loop, awaits its exit" — `AgentHandle` in dsh-agent).

## 4. User-visible contract

| Input | Result |
|-------|--------|
| `/clear`, `/new`, `/reset` | Aliases. One handler. All three are TUI-local names and appear in the slash catalog. |
| Success | New `tui-<uuid>` session is live. Transcript is the boot banner only (no folded history). Previous session remains on disk and is listed by `/resume`. Resume marker points at the **new** id. `markedContent` is `false` until the next real user prompt (same as `--new` boot). |
| Failed create | Old session stays live; transcript unchanged; a status notice (`Start failed: …`). Marker unchanged. |
| Mid-turn | In-flight turn is cancelled (`agent.cancel({ kind: 'user' })`). No "Interrupted by user." row — the transcript is about to be replaced. Queued prompts and parked approvals/questions are drained the same way `switchSession` already drains them. |
| `/model` / effort | Live `selection.current` `{ provider, model }` is passed as `agentOptions` on create. Effort stays on the shared `selection` ref (it is not an `AgentOptions` field). Bind must **not** call `seedDefaultModel(true)` (that path is for `/resume`, which reseats from the target session). |
| Permission mode | Live mode captured before dispose; re-applied on the new agent after bind (`default` is a no-op). Includes `plan` (via the existing `applyMode` / `/plan` channel). |
| Working directory | New session `meta.cwd` is `liveSessionCwd(oldAgent, bootCwd)`, so an in-session worktree move survives `/clear`. Process cwd is unchanged. |
| Worktree / `--worktree` | Unchanged. `/clear` does not leave a worktree. |
| Double `/clear` | Two new sessions. No skip. |
| CLI `dsh-cc --new` / `-n` | Unchanged. |

Canonical catalog copy for `/clear`:

> Start a new conversation (empty context). Previous session stays resumable.

`/new` and `/reset` descriptions: `Alias of /clear`.

`/tui-help` mentions `/clear`.

## 5. Architecture

Keep it TUI-local. One new operation on the sessions section, one bind helper shared with `/resume`.

```
/clear | /new | /reset
        │
        ▼
 runLocal  ──►  startFreshSession()
                    │
                    ├─ cancel in-flight turn if busy
                    ├─ capture live mode + live cwd + live {provider,model}
                    ├─ drain overlays / queue (same as switchSession)
                    ├─ ctx.agents.create(new tui-uuid)     // create-first
                    │     on throw: notice, return
                    ├─ bindSession(newHandle)              // shared with switchSession
                    │     dispose old, rebind current, banner, foldHistory,
                    │     HUD/todos/branch, catalog, marker, markedContent=false
                    └─ reapply captured mode if not default
```

`clearRows` stays. Bind still uses it. It is **not** the `/clear` command.

### 5.1 `bindSession` (extract from `switchSession`)

Today `switchSession` after a successful `resume`:

1. Dispose old handle, assign `rt.current`.
2. `rebindHistory`, `refreshCatalog`, `recordProjectSession`.
3. `seedDefaultModel(true)` — **resume only**. Runs **after** `bindSession` rebinds `rt.current` to the target (the reseed reads `current.agent`, so the rebind must land first) and before the boot banner is written. The fresh-session path does not reseed.
4. `writeResumeTarget(newId)`, `setMarkedContent(false)`.
5. `setSessionTitle(clearRows(state), undefined)`, boot banner, `foldHistory`.
6. `setPermissionMode(liveMode(newAgent, 'default'))`.
7. `clearTurn` + `setBusy` from new agent status; `seedHud` / `seedTodos` / optional `setTurnActive`; `refreshBranch`.

Extract steps 1–2 and 4–7 as `bindSession(newHandle)`. `switchSession` keeps the same-id no-op, overlay drain, resume-first, and calls `bindSession(newHandle, { reseedModel: true })` — the reseed happens inside bind, after the rebind. `startFreshSession` calls `bindSession` **without** reseeding the model.

Failed create/resume never reaches `bindSession` (create/resume-first), so the old handle stays.

### 5.2 `startFreshSession`

Lives in `createSessionsSection` (`driver-sessions.ts`).

```
async startFreshSession():
  if rt.state().busy or current.agent.status === 'running':
    current.agent.cancel({ kind: 'user' })
  const capturedMode = liveMode(current.agent, state.permissionMode)
  const liveCwd = liveSessionCwd(current.agent, rt.cwd)
  const route = selection.current
  drain overlays (existing spliceAll / setApproval / setQuestion /
                  setModelPicker / closeTodoPanel / clearQueue / setBusy false)
  let newHandle
  try:
    newHandle = await rt.createHandle(SessionId(`tui-${randomUUID()}`), {
      cwd: liveCwd,
      agentOptions: route?.provider && route?.model
        ? { provider: route.provider, model: route.model }
        : rt.agentOptions,
    })
  catch (error):
    emit upsertRow status "Start failed: …"   // same pattern as "Resume failed"
    return
  await bindSession(newHandle)
  if capturedMode !== 'default':
    await rt.reapplyMode(capturedMode)        // MUST return modeWrites, not void
```

`createHandle` is a closure from `createDriver`. Shape:

```
createHandle(id, extras: { cwd: string; agentOptions?: { provider: string; model: string } }): Promise<AgentHandle>
```

Implementation (in `driver.ts`, next to existing `createArgs`). **Do not spread a string preset.** Mirror boot's conditional (`driver.ts:107`):

```
ctx.agents.create({
  sessionId: id,
  meta: {
    cwd: extras.cwd,
    ...composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset },
  },
  setup: withSelection,
  ...(extras.agentOptions ?? boot agentOptions),
})
```

If `driver.ts` would exceed 500 lines, do **not** add comments on this lambda. Fall back: call `ctx.agents.create` inside the sessions module and pass `agentPreset` as one optional string field on `DriverSessionsCtx`.

`reapplyMode` is **not** `applyMode` itself (`applyMode` returns `void`). Wire:

```
reapplyMode = (mode) => { modeSection.applyMode(mode); return modeSection.modeWrites }
```

`plan` goes through `/plan`; other modes through `permissionRules.setMode`. Skip when captured is `default`.

`DriverSessionsCtx` also needs `liveSessionCwd` (or the sessions module imports `liveSessionCwd` from `driver-live.ts` — prefer the import; it is a free function). Import `randomUUID` in `driver-sessions.ts`. Failed create uses `upsertRow` (already on the section via `emit`), not `showNotice`.

### 5.3 Slash catalog

`LOCAL_SLASH` and `LOCAL_COMMANDS` both gain `new` and `reset`. `parseSlash` already lowercases the name, so `/Clear` still matches.

`runLocal`:

```
if (name === 'clear' || name === 'new' || name === 'reset') {
  await rt.startFreshSession()
  return
}
```

`DriverRunLocalCtx` gains `startFreshSession(): Promise<void>` (the only new run-local seam).

### 5.4 Hooks / session-start

A real `agents.create` emits `agent/session-start` with source `startup`. Setup hooks therefore re-run. That is **intentional**: dsh has no `clear` source, and faking one is worse than re-running idempotent setup.

Parity note (not a code change in `hooks-claude-code`): CC `SessionStart` sources include `clear`; dsh `/clear` looks like a brand-new session (`startup`) to hooks. The existing README line that `resume/clear/compact` sources do not fire stays true — we still do not emit `clear`.

### 5.5 What we are not building

- `conversation_id` / SDK `conversation_reset`.
- Optional label for the previous session (user can `/rename` first).
- Empty-session GC or picker hiding.
- Ctrl+L / Cmd+K screen redraw.
- A `command-clear` package in `packages/interaction`.
- Changing CLI `--new` / auto-resume.
- Changing `/branch` (still fork-without-switch).

## 6. Files

| File | Change |
|------|--------|
| `packages/ui/tui/src/slash.ts` | Add `new`/`reset`; rewrite `/clear` description |
| `packages/ui/tui/src/harness/driver-sessions.ts` | Extract `bindSession`; add `startFreshSession`; export it on the section |
| `packages/ui/tui/src/harness/driver-ctx.ts` | `DriverSessionsCtx`: `createHandle`, `reapplyMode`. `DriverRunLocalCtx`: `startFreshSession` |
| `packages/ui/tui/src/harness/driver.ts` | Wire `createHandle` + `reapplyMode`; pass `startFreshSession` into run-local |
| `packages/ui/tui/src/harness/driver-run-local.ts` | `/clear` `/new` `/reset` → `startFreshSession`; tui-help mentions `/clear` |
| `packages/ui/tui/src/store/session.ts` | `clearRows` comment: bind/switch helper, not local `/clear` |
| `packages/ui/tui/tests/slash.spec.ts` | Catalog names + parseSlash for the aliases |
| `packages/ui/tui/tests/driver-config.spec.ts` | Local-only catalog list includes `new` and `reset` |
| `packages/ui/tui/tests/driver-clear.spec.ts` | **New.** Behavioral matrix (see §7) |
| `packages/ui/tui/tests/transcript.spec.ts` | Rename the `clearRows` case so it does not claim `/clear` |
| `docs/cc-parity-matrix.md` | `/clear` is TUI-local new-session, not "excluded host-owned" |

Line budget is 500. `driver-sessions.ts` is ~360; extraction plus `startFreshSession` must stay ≤500. `driver.ts` is 485 — keep the `createHandle` lambda thin; if it would breach, inline `ctx.agents.create` in the sessions module and pass `agentPreset` as one string field instead.

Do not grow `driver-session.spec.ts`. New cases go in `driver-clear.spec.ts`. **Adapt** `makeSwitchableCtx` — do not copy it verbatim. Today's `create: async () => makeHandle(createSession)` ignores args and always returns id `s-a`, which cannot express a new-session create. The clear fixture must: record `create` args, mint a unique id per successful create, and support failure injection. Still spy `resume`/`dispose`. No shared test-util package.

## 7. Testing strategy (TDD)

Write `driver-clear.spec.ts` first (red), then the production path (green). Observable pass/fail, not implementation details beyond the `create`/`dispose` spies the existing switch tests already use.

**Catalog / parse (existing files):**

- `LOCAL_COMMANDS` names include `clear`, `new`, `reset`.
- `parseSlash('/new')` and `parseSlash('/reset')` are `{ kind: 'local', name }`.
- Local-only `listCommands()` sorted list includes both aliases.
- `/clear` description talks about a new conversation / empty context, not "transcript rows".

**`driver-clear.spec.ts` (createDriver + submit):**

1. `/clear` calls `agents.create` (not `resume`), disposes the old handle, live session id changes, transcript is banner-only (old user rows gone).
2. `/new` and `/reset` take the same path (one parameterized case or three one-liners sharing a helper).
3. After `/clear`, `/resume <oldId>` restores the old user rows (durable previous session).
4. Failed `create` keeps the old handle, appends a `Start failed` notice, does not dispose, does not rewrite the resume marker.
5. Parked approval / question / model picker / queue drain on success (mirror the existing `switchSession` overlay test).
6. Resume marker after success is the **new** id (`readResumeTarget({ cwd })`).
7. When `selection.current` is `{ provider, model }`, `create` is called with those `agentOptions`.
8. Mid-turn: agent `cancel` is invoked with `{ kind: 'user' }` before create; no "Interrupted by user." row survives in the new transcript.
9. Non-default permission mode: `permissionRules.setMode` is called on the **new** agent after bind (fixture mounts a `setMode` spy). `default` does not call `setMode`.
10. `create` `meta.cwd` is the live session cwd when the fake agent header has a cwd distinct from `config.cwd`.
11. Double `/clear` creates twice (no skip).
12. Captured mode `'plan'` → the commands registry receives `/plan` (NOT `permissionRules.setMode('plan')`, which never fires for plan).
13. No live `selection.current` + boot `config.provider/model` set → `create` receives those boot `agentOptions`.

Out of scope for this PR's tests: CLI `--new`; hooks `startup` emit (harness behavior, not TUI).

## 8. Implementation order

TDD, one green slice at a time. fast-worker executes; do not "implement then sprinkle tests".

1. Catalog/parse tests red → `slash.ts` aliases + descriptions green.
2. `driver-config.spec.ts` catalog list red → green with the same `slash.ts` change.
3. `driver-clear.spec.ts` cases 1–4, 6, 11 red → `startFreshSession` + `runLocal` dispatch + `createHandle` wiring green (`bindSession` extracted as needed).
4. Cases 5, 7–10, 12–13 red → drain, model `agentOptions`, cancel, `reapplyMode` (including plan), live cwd, boot-agentOptions fallback green.
5. Comment / tui-help / parity-matrix / `clearRows` comment.
6. `pnpm` test for `@dsh-cc/tui` (worktree: `scripts/link-worktree-deps.sh` first; vitest via the worktree `.verify` config if `node_modules/.vite-temp` is EPERM). `pnpm check:size` must stay green.

## 9. Success criteria

- `/clear` (and `/new`, `/reset`) start an empty-context session in-process. The next user prompt does not include prior turns.
- The previous session is reachable via `/resume <id>` and the `/resume` picker.
- A failed create is a no-op on the live session besides a notice.
- Live model and non-default permission mode survive `/clear`.
- `dsh-cc --new` behavior is unchanged.
- No new over-budget source file; no new package.

## 10. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| `driver.ts` / `driver-sessions.ts` breach the 500-line budget | `driver.ts` has ~6 lines of headroom. No JSDoc on the `createHandle` lambda. First `check:size` failure → fallback: `ctx.agents.create` inside the sessions module, pass `agentPreset` as one optional string field |
| Empty sessions clutter `/resume` | Accepted; do not filter in this PR. File a follow-up only if it is noisy in real use |
| Setup hooks re-run on every `/clear` | Documented divergence; bundled setup is expected to be idempotent |
| `dispose()` waits on loop exit | Cancel first so the in-flight turn aborts instead of running to completion |
| `seedDefaultModel(true)` would drop effort | Fresh-session bind skips that reset; `/resume` keeps it |

## 11. Open questions

None blocking. Deferred on purpose:

- Hide or GC empty `tui-*` sessions in the `/resume` picker.
- Optional previous-session label (CC's optional `/clear` argument).
- Ctrl+L screen redraw distinct from `/clear`.
- Emitting a CC-shaped `SessionStart` `clear` source (would need a harness emit point).
