# Exit Resume Tip — print session id and resume command on exit

Status: implemented (critic-reviewed design; see commits below)
Date: 2026-09-11
Owner branch: worktree-exit-resume-message

## 1. Problem and goal

CLI tools such as claude-code / kimi-code show the current session id and how
to resume it from the command line when an interactive session exits. (Claude
Code's documented behavior: after exit the session transcript is retained and
`claude --resume <session-id>` restores it; the id surfaces in the picker and
in error messages — see code.claude.com/docs/en/sessions and /en/errors.)

dsh-cc already has the full resume pipeline, but exiting today is a silent
black box: the user leaves without learning the session id or how to get back.
This design closes that last gap: after the TUI exits (`/quit` or the Ctrl+C
signal), print a resume tip to normal terminal output (alternate screen already
torn down).

### CC behavior baseline (verified via context7)

- Exiting locks the session and retains the transcript; `claude --resume <id>`
  resolves across directories (current directory and git worktrees first, then
  a machine-wide match if exactly one transcript matches).
- Resume failure prints `Run claude --resume <session-id> to retry`.
- Headless (`-p`) sessions are excluded from the picker but can still be
  resumed directly by id.

## 2. Current state (verified anchors)

The dsh-cc resume pipeline already exists end to end; this feature is purely a
presentation-layer addition:

| Capability | Status | Anchor |
|---|---|---|
| `--resume <id>` / `--continue` / `-c` CLI interception | exists; strips flags and forwards via env `DSH_CC_RESUME_SESSION` / `DSH_CC_CONTINUE` | `packages/launcher/tui/bootstrap.mjs:38-83` |
| harness resume API | `ctx.agents.resume({ resumeSessionId, setup, agentOptions })` | `driver.ts:144`, `driver-sessions.ts:239` |
| `/resume` picker (session switcher) | exists | `driver-sessions.ts` `openSessionSwitcher` / `switchSession`; `slash.ts:9` |
| per-project session index | `$DSH_HOME/tui/projects/<projectKey>/sessions.txt` (one id per line, best-effort) | `project-sessions.ts:10-11` |
| last-session marker (for `--continue`) | `$DSH_HOME/tui/projects/<projectKey>/resume.txt` | `resume-target.ts:42-45` |
| transcript storage | `<sessionsRoot>/<projectDir>/<sessionId>/session.jsonl[.zstd]` (harness `session-persistence-jsonl`) | format.ts `sessionDir:222` |
| session id source | primary agent `agent.session.id` (`SessionId`; fresh sessions get `tui-<uuid>`) | `driver.ts:151` |
| exit path | `plugin.ts shutdown()`: `root.stopForExit()` (leaves alternate screen, replays chrome) → `driver.dispose()` → `process.exit(0)`; `/quit` and Ctrl+C share it | `plugin.ts:65-82`, `root.ts:390-406` |
| exit-time output | **nothing prints today** (only the boot-side whale banner exists) | `boot-banner.ts` |

Conclusion: **zero harness changes** (the harness repo is read-only by
directive anyway) — a thin print layer inside `packages/ui/tui`.

## 3. Design

### 3.1 Output content and format

After `stopForExit()` and before `process.exit(0)`, write to stdout:

```
Session saved: tui-9f3a1c2e-…
Resume with:   dsh-cc --resume tui-9f3a1c2e-…    (or: dsh-cc -c for latest)
```

- A single formatter function produces the lines; muted styling via the
  existing theme key `muted` / `sgr('2')` (`theme.ts:109`), each line closed
  by a reset — pi-tui's AnsiCodeTracker carries active SGR across lines, a
  trap already hit in an earlier feature.
- **The command name is derived from the `process.argv[1]` basename**
  (`dsh-cc` / `dsh` both work); fall back to `"dsh-cc"` if derivation fails.
  Never hardcode a `claude`-style command.
- Do not print the transcript path (long, leaks home layout); only the id and
  the command.
- Short id prefix? **No** — CC resumes by full id, and we have no uniqueness
  index service; truncation would make `--resume` ambiguous. Print the full id.

### 3.2 New module and wiring

- New file `packages/ui/tui/src/exit-tip.ts` (driver.ts sits at 497/500 —
  the binding constraint; root.ts at 406 is under cap; never grow driver.ts):
  - `formatExitTip(sessionId: string, binName: string): string[]` (pure, testable)
  - `printExitTip(opts: { sessionId?: string }): void` — reads the session id,
    checks the env kill switch, writes to `process.stdout`.
- **Id access (review finding)**: the Driver public surface does not expose a
  session id today (`rt` is a closure local inside driver sections). Add a
  **live getter** `get currentSessionId(): string | undefined` to the driver
  return object (`driver.ts` ~line 419) and the `Driver` type
  (`state/driver-types.ts`). It must be live, not a boot snapshot —
  `switchSession` rebinds `current.agent` in place (`driver-sessions.ts:262`).
  ~6 lines, still within the line budget.
- Wiring point: `plugin.ts shutdown()`. Read `driver.currentSessionId` at
  shutdown entry (before `driver.dispose()`); emit the output after the
  existing try/catch around `stopForExit` — i.e. **outside the try/catch, so a
  teardown throw does not swallow the tip** — and before `process.exit(0)`.
  This ordering guarantees the tip lands in normal-screen scrollback, not
  inside the alternate screen.

### 3.3 Trigger surface and guards

| Scenario | Behavior |
|---|---|
| `/quit` normal exit | print |
| Ctrl+C / SIGTERM (`acquireTerminal.onSignal` → shutdown) | print (shared path, free) |
| driver never created an agent (early boot failure, exit during onboarding) | no print (missing `sessionId` → silent skip) |
| session was itself resumed | print (same id; idempotent, no side effects) |
| headless / non-interactive | n/a (cc-tui is TUI-only; no `-p` channel) |
| subagent sessions | no print (only the primary agent's session id) |
| Kill switch | env `DSH_CC_DISABLE_EXIT_TIP=1` (follows the `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` precedent; if settings support is ever needed, go through `settings-cascade` kebab namespace — out of scope here) |

The print itself is **read-only**: it does not write `resume.txt` (the marker
is maintained during the run by `writeResumeTarget`) and does not touch the
`sessions.txt` index (same reason). Keep the exit path as side-effect-free as
possible — a print failure (EPIPE etc.) must not change the exit code; wrap in
a try/catch and swallow.

### 3.4 Relationship to `--continue`

The `resume.txt` marker already lets `dsh-cc -c` restore the project's most
recent session, so the tip offers both paths: the exact id
(`--resume <id>`) and the shortcut (`-c`). Cross-directory resume: dsh-cc
resolves per `projectKey` (sha256 of repo root, worktrees collapse onto the
main repo root) and does not do CC-style machine-wide scanning — the tip prints
a command guaranteed to work in the current project, and does not promise
cross-project resolution.

### 3.5 Docs/gate coordination (mandatory in the same commit)

- `docs/claude-code-capabilities.yaml`: this changes a user-visible behavior on
  the CC-compatible surface; per the manifest rules amend the existing
  `sessions.persistence` entry (evidence anchor to the new module) and run
  `pnpm docs:parity` to regenerate the matrix + README block — mind validator
  rules I3/I4/I7 (id lexicographic order, evidence shape).
- README (if a CLI chapter lists `--resume`/`-c`): no new flag, but a sentence
  "the exit tip shows the resume command" can be added.

### 3.6 Test plan

1. **Unit**: `formatExitTip` snapshots (id present, long id, binName fallback).
2. **Unit**: `printExitTip` — kill switch, missing sessionId, EPIPE swallowed
   without throwing (mock `process.stdout.write` to throw EPIPE, assert no
   rejection).
3. **Unit (ordering)**: `shutdown` is an unexported closure, so spy on
   `printExitTip`'s collaborators instead — e.g. a fake root with a throwing
   `stopForExit` and a stdout spy, asserting the tip still prints after the
   throw, and that the write happens after `stopForExit` was called.
4. **Behavioral verification (manual smoke)**: run `dsh cc-tui` in a real
   terminal, `/quit`, visually confirm the two tip lines in scrollback with no
   stray SGR; same for `Ctrl+C`; then actually run the printed
   `--resume <id>` command and confirm the session restores.

### 3.7 Implementation order (one PR)

1. `exit-tip.ts` + unit tests;
2. `currentSessionId` live getter on the Driver + `plugin.ts` shutdown wiring;
3. capabilities.yaml + `pnpm docs:parity`;
4. unit tests for ordering + manual smoke.

Estimated net addition <150 lines; no harness changes, no settings, no new
CLI flag.

## 4. Slice 2 (added post-review): resumed-cwd guard

### 4.1 Gap vs Claude Code

CC's documented behavior ([worktrees]):
resuming a session returns Claude Code to its associated worktree; CC
**verifies the worktree is still a valid checkout before re-entering**, and
if the directory was deleted (or the session was forked) it resumes in the
current launch directory.

dsh-cc facts (verified):
- `--resume <id>` resolves globally (JSONL backend scans every project dir
  under the sessions root, unique id wins) and the resumed session adopts its
  **stored header cwd** — the original worktree.
- Harness `ResumeAgentOptions` exposes only `resumeSessionId`, `agentOptions`,
  `setup` — **no cwd/meta override**, so CC's fallback-to-launch-dir cannot be
  replicated in-process (harness is read-only; upstream-proposal territory).
- The live cwd accessor already exists: `liveSessionCwd(agent, fallback)`
  (`driver-live.ts:52`) folds the session-cwd plugin's `worktree/entered` event
  over `agent.session.header.cwd`.

### 4.2 Chosen behavior

Detect the dead-cwd case and surface a prominent notice, keeping the resumed
transcript (losing history by falling back to a fresh session is strictly
worse than warning):

- New module `packages/ui/tui/src/harness/resumed-cwd-guard.ts` (driver.ts
  sits at 499/500 — the guard logic lives outside it):
  - `resumedCwdGuard(agent, launchCwd): { missingCwd: string } | undefined` —
    resolve `liveSessionCwd(agent, launchCwd)`; when that directory no longer
    exists (`existsSync`), return it.
  - `warnIfResumedCwdMissing(agent, launchCwd, showNotice): void` — wraps the
    guard and emits the notice through the same `showNotice` channel the boot
    resume path already uses.
- Wiring (both resume sites):
  1. boot resume success (`driver.ts`, right after `resumed = true`) — via the
     existing `showNotice` channel already in scope there (+1 call line;
     absorb by compressing the 4-line catch-block comment above it to 2);
  2. `/resume` picker switch — after `bindSession(newHandle)`
     (`driver-sessions.ts:250`) so the notice reflects the bound agent.
     `showNotice` is NOT in the driver-sessions ctx scope (review finding):
     the picker uses the file's existing `upsertRow` status-row idiom
     (`driver-sessions.ts:246`) instead — zero driver.ts change.
- Notice text (Chinese, matching the existing driver notices): session
  original dir missing, file tools may fail, suggest `/clear` or restart in
  the right directory.
- No state change beyond the notice: the session stays resumed; the user
  decides. No fallback, no marker writes, no fresh-session degrade.

### 4.3 TDD plan (spec first, then implementation)

1. Write `resumed-cwd-guard.spec.ts` first, covering:
   - existing session cwd (a real temp dir) → guard returns `undefined`, no
     notice;
   - missing session cwd (a path under a deleted temp dir) → guard returns it,
     notice emitted with the path;
   - `liveSessionCwd` fold is respected: a `worktree/entered` event overrides
     the header cwd (fake-agent idiom from
     `packages/session/session-cwd/tests/api.spec.ts:12-23` — real
     `Session.create`, duck-typed `{ session: { id, snapshotEvents, append,
     header } }` cast `as unknown as Agent`);
   - launch-dir fallback: header cwd absent → guard uses launch cwd.
2. Implementation until green; then wiring at both resume sites (driver.ts
   stays ≤500: absorb the +1 call line by compressing a nearby comment, as
   done in slice 1).
3. Existing suites stay green; capabilities manifest gains the guard evidence
   on the `sessions.resume` entry (validator rules I3/I4/I7), parity artifacts
   regenerated.

### 4.4 Non-goals (slice 2)

- No CC-parity fallback to the launch directory (impossible without a harness
  `resume({meta})` override — upstream proposal, not a fork).
- No exit-tip line for a dead cwd (the resume-time notice is the actionable
  moment; exit-time repetition is noise).
- No proactive scan of `sessions.txt` entries for dead cwds (picker list
  stays as-is).

[worktrees]: https://code.claude.com/docs/en/worktrees

## 5. Explicit non-goals

- No machine-wide cross-project session id resolution (CC has a dedicated
  index service; we do not — that would be a harness upstream proposal,
  separate effort).
- No transcript disk path in the tip; no subagent/background agent id listing
  (the `/agents` panel already covers that).
- No exit-reason or statistics summary (a farewell banner is a separate effort
  if ever wanted).
- No settings key (the env kill switch suffices; route through
  settings-cascade only if a real need appears).
