# P3: migrate the resume marker to projectKey (design)

Status: **Implemented** — PR #67 (merged 2026-09-01). Original review record: deep-reasoner approve-with-changes — F1–F5 folded into this draft; F6/F7 recorded as implementation constraints (see §6).
Prerequisite: P0–P2 landed on main (PR #65 — `resolveProject`, `projects/<key>/` buckets, and the sidecar index already exist).

## 1. Background and problem

The current (post-P0–P2) resume marker mechanism:

- **Location**: `$DSH_HOME/tui/resume-<sha256(resolve(cwd))[:16]>.txt`, bucketed by **exact cwd**.
- **Writers**: the TUI `packages/ui/tui/src/resume-target.ts` (`writeResumeTarget` / `clearResumeTarget` / `readResumeTarget` / `resumeMarkerFile`), called from:
  - `driver-agent.ts` `persistResumeTarget()`: resume self-healing + written after the first real prompt, keyed by `rt.cwd` (boot cwd).
  - `driver.ts` boot: on resume failure (stale marker), `clearResumeTarget({ cwd })`.
  - `driver.ts` sessions ctx: `writeResumeTarget(id, { cwd })`, also keyed by boot cwd.
- **Reader**: the launcher `bin/dsh-cc.js` — only when `DSH_CC_RESUME_SESSION` is undefined does it read `resumeMarkerPath(home, spawnCwd ?? process.cwd())` and set it as env for the plugin. The hash scheme is **duplicated** in `bootstrap.mjs` (`resumeMarkerName`, JS) and `resume-target.ts` (TS); comments require the two sides to stay in sync.
- **Env tri-state**: `DSH_CC_RESUME_SESSION` non-empty = resume that id; `''` = explicitly fresh (`--new` / new worktree); undefined = the launcher already checked the marker and found none.

Problems:

1. The marker is bucketed by exact cwd — a repo's worktrees and the main checkout do not share the "last session", contradicting the project model established by P0–P2 (worktrees belong to the same project).
2. The hash scheme exists twice, TS and JS, kept in sync only by comments.
3. The marker is written keyed by boot cwd rather than the live session's project — a session that switched in from a different project (Ctrl+A all scope) writes into the wrong bucket.
4. Marker-reading logic lives in the launcher (no TS, no git probe capability), so project resolution is impossible there.

## 2. Design overview

**Move marker reading down into the TUI, change the key to projectKey, and slim the launcher down to pure flag translation.**

### 2.1 New marker location and scheme

- Path: `$DSH_HOME/tui/projects/<projectKey>/resume.txt` (same bucket directory as P1 history and P2 `sessions.txt`).
- `projectKey` comes from the existing `resolveProject(cwd)` (git common-dir probe; linked worktree → main checkout root; non-git → `resolve(cwd)`).
- Inside `resume-target.ts`, memoize `resolveProject` at module level keyed by the `resolve(cwd)` string (at most one git probe per cwd per process).

### 2.2 resume-target.ts API (options shape is `{ home?, cwd?, legacyCwd? }`)

| Function | New behavior |
|---|---|
| `resumeMarkerFile(options)` | Returns the **new** project path (exported, so tests pin the scheme) |
| `legacyResumeMarkerFile(options)` | Returns the old `resume-<hash>.txt` path (exported, for the transition + tests) |
| `writeResumeTarget(id, options)` | **Idempotent**: skip if the new marker already equals the id (dedupe looks only at the new marker, not legacy — F4 decision). Otherwise write the new marker (key = `resolveProject(options.cwd)`); **also dual-write the legacy marker**, keyed to the exact-cwd bucket of `options.legacyCwd ?? options.cwd` (F3 decision: the driver passes `legacyCwd: <boot cwd>`, keeping the legacy bucket symmetric with the old launcher's read point — the launch cwd; annotate the comment as transition-only, removal milestone in §2.8) |
| `readResumeTarget(options)` | Read both new + legacy; **first filter out empty files (treat as nonexistent), then compare `statSync().mtimeMs` — the newer wins, ties go to the new marker** (F7 pins the order); returns id \| undefined |
| `clearResumeTarget(options)` | Write `''` to both files (best-effort, same semantics as today; the legacy side's key is likewise `legacyCwd ?? cwd`) |

In non-git directories, `projectKey == sha256(resolve(cwd))[:16]` — the same value as the legacy key but a different path (`projects/<key>/resume.txt` vs `resume-<key>.txt`), so dual-read/dual-write still holds with no conflict.

### 2.3 TUI boot (plugin.ts + index.ts + driver.ts + cordis.patch.yml)

**F1① fix (blocking)**: `packages/ui/tui/src/plugin.ts:32-34` currently drops `sessionId === ''` before entering `createDriver` (`undefined || length === 0 ? {} : …`), so the explicit fresh sentinel of `--new` never reaches the driver. This PR changes it to **pass `''` through untouched** (`sessionId === undefined ? omit : pass sessionId`), making case 2 below actually reachable; the driver side correspondingly treats `''` and `undefined` differently (`config.sessionId ?? random` does not fire for `''`, so an explicit branch is required).

DriverConfig (declared in the `Config` interface + Schema in `packages/ui/tui/src/index.ts`, and forwarded field-by-field from `plugin.ts` to `createDriver` — **both files must change, or the new config never reaches the driver**, F2) gains two optional fields:

```ts
autoResume?: boolean        // allow reading the project marker at boot
continueRequested?: boolean // -c/--continue, only affects the "no resumable session" notice
```

`tui config` in `cordis.patch.yml` gains (the `!!js` expressions evaluate to `undefined`/no-throw when the env is unset; verified feasible in the host's eval dialect; after implementation run `dsh --dump-config` once as a smoke check):

```yaml
autoResume: !!js process.env.DSH_CC_AUTO_RESUME === '1'
continueRequested: !!js process.env.DSH_CC_CONTINUE === '1'
```

Boot session-resolution precedence (driver.ts):

1. `config.sessionId` non-empty → resume that id (explicit `--resume`, unchanged).
2. `config.sessionId === ''` → fresh (explicit `--new` / new worktree; **do not read the marker**).
3. `config.sessionId === undefined && config.autoResume === true` → `readResumeTarget({ cwd })`:
   - Hit → take the existing resume path (including stale self-healing: after failure, `clearResumeTarget` now clears both).
   - Miss and `continueRequested` → `showNotice('No resumable previous session — use /resume to pick one manually')`.
4. Otherwise → fresh.

`autoResume` defaults to false — plain `dsh --profile tui` (without the launcher) has **zero behavior change** vs the existing test suite (it never reads or writes the real `~/.dsh`; grep-verified that all 26 driver specs isolate DSH_HOME, so regression risk is contained).

### 2.4 Marker write-key fix (also fixes a P2 leftover deviation + F3/F4 decisions)

- `driver.ts` sessions ctx: `writeResumeTarget: (id) => writeResumeTarget(id, { cwd: current.agent.session.header.cwd ?? cwd, legacyCwd: cwd })` — the new marker lands in the **session's own** project bucket (a session switched in from another project no longer writes the wrong bucket); the legacy dual-write lands in the **boot cwd** bucket (F3: symmetric with the old launcher's read point `spawnCwd ?? process.cwd()`, fully compatible for the common path — restarting in the same directory; the legacy-bucket skew for cross-directory sessions is a known edge, see the §2.7 matrix footnote).
- `driver-agent.ts` `persistResumeTarget`: likewise switch to the live `current.agent.session.header.cwd ?? rt.cwd` + `legacyCwd: rt.cwd`; **remove the existing read-compare-dedupe** (the `readResumeTarget(...) === id` pre-check); dedupe moves into `writeResumeTarget` and compares only the **new marker** (F4: a dual-read can return the legacy side's stale id, making the skip-write semantics undefined; once sunk, it is unambiguous).
- `driver.ts` boot stale self-healing's `clearResumeTarget({ cwd })` stays as-is (cwd is the boot cwd, and the dual clear covers the legacy same-bucket case).

### 2.5 Launcher (bin/dsh-cc.js + bootstrap.mjs)

**bin/dsh-cc.js**:

- Remove the marker-read block (currently lines 122–131) and the `resumeMarkerPath`, `continueHint` imports.
- **F1② fix (blocking)**: at entry (before parsing any flag), **unconditionally** remove the inherited `DSH_CC_RESUME_SESSION`, `DSH_CC_AUTO_RESUME`, `DSH_CC_CONTINUE` from `env0` — the parent TUI process's environment carries the launcher-set `DSH_CC_AUTO_RESUME=1`, and running `dsh-cc --new`/`--worktree` from within the TUI inherits it, punching through the autoResume gate (`--new` is ignored and it auto-resumes). After the entry scrub, these three variables are re-derived only by bin/interceptResume from this invocation's argv; the existing `delete env0.DSH_CC_RESUME_SESSION` in the `--worktree` branch becomes redundant — delete it.
- When `DSH_CC_RESUME_SESSION` is undefined, no longer set it — whether to resume is decided by the TUI itself based on `DSH_CC_AUTO_RESUME`.

**bootstrap.mjs**:

- `interceptResume`: after resolving the precedence, if `nextEnv.DSH_CC_RESUME_SESSION === undefined`, set `nextEnv.DSH_CC_AUTO_RESUME = '1'` ("explicit flags suppress marker resume" is encoded in this one pure function, testable). `-c`/`--continue` additionally sets `nextEnv.DSH_CC_CONTINUE = '1'`.
- Remove the `resumeMarkerName`, `resumeMarkerPath`, `continueHint` exports and the now-unused `createHash` import.
- Worktree-flow semantics unchanged (implementation code tweaked slightly): creating a new worktree still sets `DSH_CC_RESUME_SESSION=''` (= explicitly fresh, skip the marker); reusing an existing worktree → env undefined + AUTO_RESUME=1 → the TUI reads the project marker → resumes that project's most recent session (matches the project model).

**launcher/tui/README.md**: update the env-contract documentation (marker read/write fully owned by the TUI; semantics of `DSH_CC_AUTO_RESUME` / `DSH_CC_CONTINUE`).

### 2.6 Semantics change of `-c/--continue`

Today `-c` = "resume from the marker; if none, print a stderr hint". After P3, bare `dsh-cc` already resumes from the project marker by default, so `-c` degenerates into syntax sugar whose only observable difference is the "no resumable session" notice — it moves from a one-line stderr in the launcher to a TUI notice (the launcher can no longer know whether the marker exists; that is the direct cost of sinking the read). `-c` continues to be accepted and stripped from the forwarded args; behavior is compatible.

### 2.7 Compatibility matrix

| launcher | TUI plugin | Result |
|---|---|---|
| new | new | project marker takes effect, correct |
| old | new | the old launcher reads the legacy marker; the new TUI dual-writes legacy (key = the writing process's boot cwd, symmetric with the old launcher's read point) → the common path (same-directory restart) works. Known edge: a session resumed across directories (header.cwd ≠ boot cwd) leaves the legacy bucket at the boot cwd rather than the session cwd, so restarting the old launcher in the session's original directory reads a stale value — a minor skew of a transient mixed-version state, accepted (F3 decision) |
| new | old | the old TUI gets no env → loses auto-resume; `/resume` manual still works. **Accepted degradation**: at profile install the plugin version is locked to the launcher (`bootstrapCommand` uses `ownVersion`); only "upgrade the launcher npm package without reinstalling the profile" hits this; README + release note explain it, recovery = reinstall the profile or use `/resume` |
| old | old | unchanged |

**Rollback**: revert this PR → the old launcher reads the legacy marker, and the new TUI has been dual-writing legacy all along → seamless.

### 2.8 Lifecycle of leftover legacy markers

Do not proactively delete old files. The dual-read guarantees old files are respected (newer mtime wins); the dual-write guarantees old launchers keep working; `clearResumeTarget` clears both. Note (F5 factual correction): `--new` only sets the env sentinel and **does not clear any marker on disk**; the TUI also has no `/new` command (the comment at `resume-target.ts:53` is stale — correct it in the rewrite). The old marker is overwritten by the dual-write after the new session's first real prompt.

**Removal milestone for the legacy dual-write**: completed — the cwd-bucketed dual-write/read was removed after 0.4.0 (cleanup PR; repo is past 0.6.x). Only the project-keyed marker remains.

## 3. Affected files

| File | Change |
|---|---|
| `packages/ui/tui/src/resume-target.ts` | new scheme + dual-read/dual-write/dual-clear + `legacyCwd` + idempotent write; correct the module-header comment and the stale jsdoc of `clearResumeTarget` ("`/new`") in the same pass |
| `packages/ui/tui/src/project.ts` | add a shared memo to `resolveProject` (keyed by `resolve(cwd)`) + a `__clearProjectCache()` test hook (F6) |
| `packages/ui/tui/src/index.ts` | `Config` interface + Schema + `autoResume?`, `continueRequested?` (F2) |
| `packages/ui/tui/src/plugin.ts` | pass `sessionId` `''` through (F1①); forward `autoResume`/`continueRequested` field-by-field (F2) |
| `packages/ui/tui/src/harness/driver.ts` | boot autoResume/continue state machine (explicit branch for `''`); sessions ctx `writeResumeTarget` key fix (header.cwd + legacyCwd=boot cwd) |
| `packages/ui/tui/src/harness/driver-agent.ts` | `persistResumeTarget` key fix (live session cwd); remove the pre-check dedupe (sink into writeResumeTarget, F4) |
| `packages/bundle/cc-tui/cordis.patch.yml` | +`autoResume`, `continueRequested` |
| `packages/launcher/tui/bootstrap.mjs` | `interceptResume` new env contract; add the pure function `sanitizeInheritedEnv(env)` (deletes the three inherited variables, testable); remove `resumeMarkerName`/`resumeMarkerPath`/`continueHint` and the `createHash` import |
| `packages/launcher/tui/bin/dsh-cc.js` | call `sanitizeInheritedEnv` at entry; remove the marker-read block and hint calls; remove the redundant env delete in the `--worktree` branch |
| `packages/launcher/tui/README.md` | env-contract documentation (including direct `dsh --profile tui` and env-leak protection notes) |
| `packages/ui/tui/tests/resume-target.spec.ts` | rewrite (new scheme + dual-read mtime + dual-write + dual-clear + worktree shared bucket + idempotent dedupe) |
| `packages/ui/tui/tests/project.spec.ts` | +memo behavior and `__clearProjectCache` cases (distinct cwds, to avoid cross-case pollution within one worker) |
| `packages/ui/tui/tests/driver-resume-marker.spec.ts` | extend (autoResume gating, `''` explicit fresh, stale dual-clear self-healing, key fix) |
| `packages/launcher/tui/tests/bootstrap.spec.ts` | update the interceptResume contract; +`sanitizeInheritedEnv` cases; remove continueHint cases |
| `packages/launcher/tui/tests/worktree.spec.ts` | remove the `resumeMarkerName`/`resumeMarkerPath` pinning cases |

pi-tui is untouched. `packages/interaction/command-resume` is untouched (P4 scope).

## 4. Test plan (TDD: write failing tests first, then implement)

### 4.1 resume-target.spec.ts (rewrite) + project.spec.ts (add cases)

- New marker path = `projects/<sha256(resolve(repoRoot))[:16]>/resume.txt` (real git repo tmpdir + worktree shared bucket: the repo root and a linked worktree resolve to the same path).
- Non-git directory: key == `sha256(resolve(cwd))[:16]`, landing at `projects/<key>/resume.txt`.
- Dual-read (order pinned: blank-filter → mtimeMs → ties to the new marker): only legacy has a value → return legacy; both sides have values → newer mtime wins; identical mtimes → the new marker wins; "newer but empty" legacy + an older non-empty new marker → return the new marker's value; both absent/both empty → undefined.
- Dual-write: after write, the new and legacy files have identical content; when `legacyCwd` differs from `cwd` (cross-directory session), legacy lands in the `legacyCwd` bucket and the new marker in the project bucket of `cwd`.
- Idempotent (F4): when the new marker already equals the id, write is a no-op (file mtime unchanged, even if the legacy side holds an old id); dual-write only when it differs.
- Dual-clear: after clear, both files are empty and `read` returns undefined.
- project.ts memo: repeated calls with the same cwd probe only once (inject a counting exec); after `__clearProjectCache()` it probes again. All git-fixture cases use distinct cwds (to guard against memo pollution within one worker).
- `home` injection isolates all file IO.

### 4.2 driver-resume-marker.spec.ts (extend, DSH_HOME isolation mandatory) + plugin pass-through tests

- `sessionId === undefined` and no `autoResume` → do not read the marker (existing behavior, regression lock).
- `autoResume: true` + marker hit → boot resumes that session.
- `autoResume: true` + marker missing + `continueRequested: true` → fresh + notice.
- `sessionId === ''` + marker exists + `autoResume: true` → fresh (explicit --new takes precedence over the marker; locks the driver branch after the F1① pass-through).
- Stale marker: after resume fails, both the new and legacy markers are cleared.
- Write-key fix: boot cwd at the repo root, session header.cwd in a linked worktree → the new marker lands in the worktree's project bucket, legacy in the boot cwd bucket.
- plugin.ts pass-through (F1①/F2): `sessionId: ''` is passed to createDriver as-is (no longer dropped into undefined); `autoResume`/`continueRequested` fields are passed through. Case placement follows the plugin's existing test conventions (if there is no plugin.spec, cover it at the driver layer with a config passed directly, and add field-declaration cases at the index.ts Schema layer).

### 4.3 Launcher tests

- `bootstrap.spec.ts`: no flags → `DSH_CC_AUTO_RESUME=1` and `DSH_CC_RESUME_SESSION` not set; `--new` → `''` and AUTO_RESUME not set (explicit wins); `-c` → `DSH_CC_CONTINUE=1` + AUTO_RESUME; `--resume=x` → env=x and AUTO_RESUME not set; remove all continueHint cases.
- `sanitizeInheritedEnv` (F1②): an env containing the three inherited variables → all deleted; not containing them → unchanged; other variables unaffected.
- `worktree.spec.ts`: remove the `resumeMarkerName`/`resumeMarkerPath` cases.

### 4.4 Verification gates

- `pnpm vitest run` (tui + launcher packages all green), `tsc -b build`, `check:size`, `check:vendor-purity`.
- Manual e2e smoke (before merge): type a prompt in directory A → `dsh-cc --worktree` reuses the session → bare `dsh-cc` in A auto-resumes that project's most recent session; after `--new`, a bare start resumes the new session; `-c` with an empty marker shows the notice.

## 5. Open questions (all decided during review)

1. **Empty legacy counts as nonexistent — accepted.** The old launcher already ignores an empty marker (`marker.length > 0` before use), so the semantics are equivalent.
2. **Set a removal milestone for the legacy dual-write**: keep until the next minor (0.4.0), code comment `TODO(0.4.0)` + a tracker issue.
3. **Move the `-c` notice to a TUI notice — accepted** (a notice lands in the UI the user is looking at, better than a fleeting stderr line). Wording points to `/resume`.
4. **Env leaks — the launcher scrubs the three variables at entry (F1②) + README documentation**; no protection on the TUI side (leaks and contract-injected values are indistinguishable there).
5. **`resumeMarkerFile` semantics change — accepted** (its only in-repo consumer is its spec).

## 6. Implementation constraints (review F6/F7 + smoke items)

- **F6**: the `resolveProject` memo goes in `project.ts` (shared — the driver's existing ≥4 call sites all benefit), keyed by `resolve(cwd)`; include the `__clearProjectCache()` test hook. resume-target does not keep a private cache.
- **F7**: the dual-read order is pinned as blank-filter → `mtimeMs` comparison → ties to the new marker.
- The old jsdoc of `clearResumeTarget` (mentioning `/new`) and the module-header comment ("launcher feed it back") are corrected in the rewrite.
- After implementing, run `dsh --dump-config` (or an equivalent smoke) once to confirm the new cordis `!!js` fields parse.
- After merge: open a "remove legacy resume marker dual-write in 0.4.0" tracker issue.
