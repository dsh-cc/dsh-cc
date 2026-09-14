# Dev-Build Version Stamp + Auto-Restore on Launcher Update

Date: 2026-09-13. Status: plan, critic-approved, implemented (three cold review rounds. Round 1, base design: GO-WITH-AMENDMENTS — "prefer the stamp's version" and "stamp inside the synced scope dir" adopted; "inline the stamper into the sync script" declined.
Round 2, auto-restore amendment: GO-WITH-AMENDMENTS — all three blocking findings adopted: pair the trigger against the *launcher observed at sync time*, never trust pnpm to heal same-version directories (set-aside rename instead), and clean up the unmarked cc preset copy on restore. Round 3, implementation diff review: CHANGES-REQUIRED with one blocking finding — crash recovery raced a live restore because it ran before lock acquisition; fixed by taking the lock first, regression-tested, plus the trivial nits (profile name derived from profileDir, PATH probe dead code, stamp write hardened to best-effort).
All adopted inline). Trigger: local dev builds have no published version
number, so there is no way to tell from the running profile which tree
produced them — and returning to the store edition must not require manual
cleanup.

## 1. Problem

The daily development loop is `pnpm run build` followed by
`bash scripts/sync-local-profile.sh [profile]`, which mirrors the repo's
`@dsh-cc/*` packages as flat copies into
`$DSH_HOME/profiles/<profile>/node_modules/@dsh-cc/`. These builds never get a
version number — that only happens when `scripts/release.mjs` rewrites the
manifests and CI publishes a tag. Two gaps follow:

1. `dsh-cc --version` prints the same bare `0.6.3` whether the profile boots
   the published bundles or last night's local sync. It should say "dev build"
   and name the source commit.
2. Once the user `npm install -g`s a newer launcher, the profile keeps booting
   the dev copies until somebody deletes them by hand. Updating the launcher
   should return the profile to the store-published bundles automatically.

A published npm install must keep printing the bare `x.y.z` it prints today,
byte-identically, and must never touch dev state on an unchanged launcher.

## 2. Facts that shape the design

Launcher side (this repo, verified by reading):

- `packages/launcher/tui/bin/dsh-cc.js` answers `--version`/`-V` by printing
  `ownVersion`, read from its own `package.json`. The same `ownVersion` feeds
  `bootstrapCommand()` — the first-boot `dsh plugin add <name>@<version>`
  install pins — so it must remain a clean publishable semver and cannot
  absorb dev metadata.
- The `dsh-cc` shim on PATH is the npm-installed `@dsh-cc/cli` launcher. The
  sync script rewrites the profile's plugin code only; the executing launcher
  binary is almost always the published one. Therefore the version truth
  cannot live in the launcher's own files — it must live with the synced code
  and be read across.
- `sync-local-profile.sh` owns `<profile>/node_modules/@dsh-cc/` exclusively:
  it rsyncs every package there and prunes stale package *directories* (the
  prune glob matches `*/` only, so a plain file survives).
- Nothing in the repo parses `dsh-cc --version` output (the launcher's
  version-gate parses `dsh --version`, a different binary), so extending the
  format is free. It must stay one line.
- CI never runs the sync script, and the stamp is written under `$DSH_HOME`,
  not the repo — no `.gitignore` entry, no publish-leak surface, no
  interaction with `release.mjs`'s tag==version gate.
- In-repo law (`2026-09-05-startup-boot-first-frame.md` W2): no per-launch
  subprocess probes (~60 ms each). Small file reads were never the issue; the
  design below adds exactly one sub-millisecond read to the launch path.

Harness side (sibling checkout, verified by exploration subagent):

- `dsh plugin --profile <p> add <name>@<version>` is a thin pnpm forwarder
  with cwd = profile dir: pnpm rewrites the `dependencies` entry and
  re-materializes `node_modules` per normal semantics. There is no dsh-side
  short-circuit for already-registered bundles; `reconcilePlugins` only
  maintains the `dsh.profile.bundles` list by scanning installed packages for
  `dsh.bundle` markers.
- Boot **never** reconciles, auto-upgrades, or garbage-collects: the bundles
  list is resolved to directories and fails loud if unresolvable. Undeclared
  node_modules entries are left alone forever.
- The published bundles are **not** self-contained: `bundle-shell` depends on
  `@dsh-cc/claude-code-agents`, `plugin-loader`, `plugin-manager`,
  `mcp-client`, `mcp-config`, `model-aliases`, `session-title-provider`;
  `bundle-tui` on `@dsh-cc/tui`; `bundle-permissions` on `settings-cascade`,
  `permission-rules`, `command-permissions`. The store dependency graph
  materializes many `@dsh-cc/*` packages into the same scope dir the dev sync
  writes to; names overlap (`@dsh-cc/tui` exists both as a dev copy and as a
  store graph member).
- pnpm's hoisted linker can treat a pre-existing directory whose
  name+`package.json` version match the wanted spec as already installed — it
  trusts presence, not content. Equal version does **not** mean equal content
  (dirty trees, hand-edited profile copies, downgrades). "Just
  `plugin add` and let pnpm heal in place" is therefore not safe on its own.
- pnpm 11's default 24 h `minimum-release-age` can hide a bundle published
  minutes ago, so restore right after a fresh dsh-cc release can transiently
  fail; the failure path must be survivable and self-retrying.
- The cc preset copy at `$DSH_HOME/.agent-presets/cc` is refreshed by
  `ensurePackagedPreset` (packages/ui/tui packaged-preset) **only** when it
  carries a valid `.dsh-cc-managed.json` marker; an unmarked copy (written by
  `scripts/sync-cc-preset.sh` during dev syncs, for a profile that never booted
  store bundles) returns `conflict` and lingers forever.

## 3. Design

Three working parts: a stamp generator hooked into the sync script, a
dev-aware `--version` branch, and an auto-restore step on launcher launch.

### 3.1 `scripts/stamp-build-info.mjs` (new)

Plain, dependency-free Node in the style of the other repo scripts. Usage:

```
node scripts/stamp-build-info.mjs <output-path>
```

It resolves the repo root from its own location and best-effort collects:

| field             | source                                                              |
| ----------------- | ------------------------------------------------------------------- |
| `channel`         | constant `'dev'` (written only by the sync flow)                    |
| `version`         | `packages/launcher/tui/package.json` `version` of the *synced tree* |
| `launcherVersion` | the on-PATH `dsh-cc` launcher's own `package.json` version          |
| `commit`          | `git rev-parse --short=12 HEAD`                                     |
| `branch`          | `git rev-parse --abbrev-ref HEAD` (may be `HEAD` if detached)       |
| `dirty`           | `git status --porcelain` non-empty (untracked counts)               |
| `syncedAt`        | ISO-8601 timestamp                                                  |
| `syncedFrom`      | repo root path (runtime data, never committed)                      |

`launcherVersion` is captured by scanning `PATH` entries for a `dsh-cc` file,
`realpathSync`-ing it, and reading `../package.json` — **not** by running
`dsh-cc --version`, whose output is itself stamp-aware (and which would spawn
the launcher from inside the sync script for no reason). Every probe (git and
launcher alike) is individually wrapped: any failure yields a `null` field and
the script still exits 0. A profile sync must never fail because metadata was
unavailable; the worst case is a `--version` that says `-dev+unknown` and a
restore trigger that conservatively stays silent (§3.4).

Write is atomic: `writeFileSync(out + '.tmp')` then `renameSync` onto `out`.
Same-directory rename is atomic on POSIX.

### 3.2 Hook in `scripts/sync-local-profile.sh`

One line, placed immediately after the final `echo "synced ..."` (after all
copies, the stale-prune, and dependency materialization, before the
`missing_lib` exit check and the preset sync):

```sh
node "$repo_root/scripts/stamp-build-info.mjs" "$dest/dsh-cc-build.json"
```

`$dest` is `<profile>/node_modules/@dsh-cc`, so the stamp lands at
`<profile>/node_modules/@dsh-cc/dsh-cc-build.json` — inside the namespace the
script already owns: it survives the `*/`-only prune glob, is rewritten by
every sync, and cannot be mistaken for dsh-managed profile state. The stamp is
per-profile, matching sync's per-profile nature.

### 3.3 Launcher: `--version`

Two exports in `packages/launcher/tui/bootstrap.mjs`, both dependency-free and
unit-testable like the existing helpers:

```js
// Missing, unreadable, or malformed stamp (JSON.parse throws) -> null.
// Fails open to release display.
export function readBuildInfo(stampPath)

// info?.channel === 'dev' -> '<version>-dev+<commit>[.dirty]', preferring
// the stamp's own version over the launcher's; anything else -> bare version.
export function formatVersionLabel(version, info)
```

`formatVersionLabel` prefers `info.version`: the commit in the stamp
identifies the synced tree, so the semver prefix should describe that same
tree (a 0.6.3 launcher driving a profile synced from a 0.7.0 tree should print
`0.7.0-dev+<commit>`). When launcher and tree agree — the normal case — the
output is identical either way.

In `bin/dsh-cc.js` the `--version`/`-V` early-exit moves below the cheap
`home`/`profileDir` const computations (pure path joins, zero cost) and prints
`formatVersionLabel(ownVersion, readBuildInfo(stampPath))`. `ownVersion`
itself stays the plain manifest version and keeps feeding `bootstrapCommand`
untouched.

### 3.4 Automatic restore to store bundles on launcher update

The requirement collapses to detecting "the launcher changed since this
profile was last synced toward it" and then reconverging the profile to the
fresh-bootstrap state. Both halves reuse what already exists.

**Trigger** — one small sync read on every launch, plus a pure decision fn:

```js
// bootstrap.mjs
export function devStoreRestoreDecision(info, ownVersion) {
  if (info?.channel !== 'dev') return null
  const seen = info.launcherVersion
  if (typeof seen !== 'string' || seen.length === 0) return null // unknown pairing
  if (seen === ownVersion) return null                           // launcher unchanged since sync
  return { from: seen, to: ownVersion }
}
```

Pairing against `launcherVersion` (the launcher observed *at sync time*), not
against the tree's `version`, is the load-bearing choice (review round 2,
finding 1): a launcher unchanged since the last sync proves the dev loop is
active, even when the tree's manifest version diverges from it (developing on
a lagging or leading branch). Triggering on `stamp.version !== ownVersion`
instead would wipe that dev loop on every single launch. Conversely, `null`
`launcherVersion` (dsh-cc not on PATH when sync ran) means the pairing is
unknown, and destroying dev state on uncertainty is worse than skipping — the
manual note in §5 covers that corner.

**Action** — move the dev state aside atomically, re-materialize from the
registry, commit or roll back. All filesystem moves are same-directory
renames; `<scope>` is `<profile>/node_modules/@dsh-cc`, `<backup>` is
`<profile>/node_modules/@dsh-cc.__dev-restore-backup`, and the lock is
`<profile>/node_modules/.dsh-cc-restore.lock` (a sibling of `<scope>` so it
survives the rename). Hosted as `runStoreRestore(profileDir, ownVersion,
{spawnSyncImpl, log, now})` in `bootstrap.mjs` with the spawn injectable —
unit-tested against real tmp profile dirs:

1. *Lock*: `openSync(lock, 'wx')`. `EEXIST` with an mtime younger than ten
   minutes → another launch is mid-restore; skip restore entirely and launch
   as is. Stale lock → unlink and retry once.
2. *Crash recovery* — only ever with the lock held: if `<backup>` exists and
   `<scope>` does not, a previous restore died mid-flight —
   `renameSync(<backup> → <scope>)` to recover the dev state, then proceed.
   Recovering without the lock would race a live holder mid-`plugin add`, and
   the holder's success path would then delete the stamp out of the recovered
   dev scope (round 3, finding 1).
3. *Set aside*: `renameSync(<scope> → <backup>)`. Never delete in place and
   "trust pnpm to heal": pnpm's linker may accept a same-version directory
   whose content is not the registry's (equal version ≠ equal content), which
   would silently keep dev bits alive *as* store packages — the worst outcome
   this feature exists to prevent (round 2, finding 2).
4. *Re-materialize*: `spawnSync('dsh', ['plugin', '--profile', PROFILE,
   'add', ...BUNDLES.map(n => `${n}@${ownVersion}`)], {stdio: 'inherit', env:
   sanitized})`. Deliberately the same command surface as `bootstrapCommand`
   (no `--save-exact`), so a restored profile converges exactly to the
   fresh-bootstrap state: `dependencies` entries (re)created, the full store
   graph materialized from the registry. The spawn uses the same
   `sanitizeInheritedEnv`-scrubbed environment as the main launch.
5. *Success* (`status === 0`, no spawn error): `rmSync(<backup>,
   {recursive, force})`, delete the stamp, preset cleanup (below), one stderr
   notice — `dsh-cc: launcher updated 0.6.3 → 0.6.4; restored store bundles
   in profile "tui" (re-run scripts/sync-local-profile.sh to resume a dev
   build)`.
6. *Failure* (offline, registry error, `minimum-release-age` window, dsh
   missing): `rmSync(<scope>, {recursive, force})` (drops pnpm's partials),
   `renameSync(<backup> → <scope>)`, keep the stamp, one stderr warning that
   restore will retry on the next launch (mentioning that right after a
   dsh-cc release, npm/pnpm's minimum-release-age window may still hide the
   new bundles). Then continue launching on the rolled-back dev state:
   booting yesterday's dev build beats a bricked profile.
7. *Unlock*: remove the lock on every exit path.

*Preset cleanup* (success path only; round 2, finding 3): if
`$DSH_HOME/.agent-presets/cc` exists and its `.dsh-cc-managed.json` marker is
missing, unparseable, or names an `owner` other than `'@dsh-cc/tui'`, delete
the directory — an unmarked copy is by construction a dev-sync artifact
(written by `scripts/sync-cc-preset.sh`), and `ensurePackagedPreset`'s
`conflict` branch would otherwise keep it forever. The next store boot
reinstalls the store composition through the normal ensure path. Marked
copies are store-owned and self-refresh on revision change; they are never
touched. The directory is per-user and shared across profiles: a sibling
profile mid-dev-loop reasserts its copy on its next sync, so the transient is
bounded by the dev loop's own cadence.

*Placement in `bin/dsh-cc.js`*: after the first-boot bootstrap block (a fresh
profile has no stamp, so the two paths can never both fire) and before the
final `dsh` spawn. Cold-start accounting: the normal path pays one
`readFileSync` + `JSON.parse` on a sub-kilobyte file (microseconds, no
subprocess — W2 compliant); the restore spawn runs at most once per launcher
version change per profile.

### 3.5 Output contract

| situation                    | `dsh-cc --version` prints         |
| ---------------------------- | --------------------------------- |
| published install / no stamp | `0.6.3` (unchanged)               |
| dev sync, clean tree         | `0.6.3-dev+abc1234def56`          |
| dev sync, uncommitted state  | `0.6.3-dev+abc1234def56.dirty`    |
| dev sync, git unavailable    | `0.6.3-dev+unknown`               |

One line, exit 0, semver-valid (`-dev` prerelease plus build metadata).
`branch`, `syncedAt`, and `syncedFrom` stay in the JSON for forensics but out
of the printed line — branch names are not semver-metadata-safe (`/`, `_`).

## 4. Alternatives rejected

- **npm lifecycle (`postinstall` in `@dsh-cc/cli`)**: global installs under
  sudo run lifecycle scripts as root — they would touch the wrong `$HOME` or
  leave root-owned files in the user's profile; `--ignore-scripts` and
  pnpm/yarn/bun global installs skip or sandbox them; npm cannot enumerate
  profiles. First-launch-of-the-new-launcher detection is permission-correct
  and installer-agnostic.
- **Trigger on `stamp.version !== ownVersion`**: wipes the dev loop of anyone
  developing on a tree whose manifest version differs from the installed
  launcher, on every launch (round 2, finding 1 — the original draft's bug).
- **Delete the stamp only, leave the dev copies**: that is lying in the other
  direction — `--version` would say release while the profile still boots dev
  code.
- **`plugin add` and trust pnpm to heal in place**: pnpm may accept a
  same-version directory whose content diverges (hand-edits, dirty trees,
  launcher downgrades); the set-aside rename in §3.4 removes the class
  entirely while keeping offline survivability.
- **Build-time stamp inside `@dsh-cc/cli`'s package root**: invisible in
  practice — the executed bin is the npm-installed launcher, not the synced
  copy. Stamping what isn't executed answers nothing.
- **Stamp at `pnpm run build` time**: a build without a sync changes nothing
  that runs; the marker would claim freshness the profile doesn't have.
- **Runtime `git rev-parse` probe from the launcher**: post-sync there is no
  `.git` — the profile holds flat copies precisely so it can't realpath back
  into the repo (cordis duplication; see the sync script header).
- **Mutating `package.json` `version` to `x.y.z-dev+sha`**: dirties tracked
  files on every build, risks committing a dev version, and breaks
  `scripts/release.mjs`'s tag==version gate.

## 5. Edge cases and accepted risks

- **Developing on a different version line than the installed launcher**:
  safe by construction — pairing tracks the launcher observed at sync time.
  Upgrading the launcher mid-loop costs exactly one restore; the next sync
  re-enters dev mode and re-pairs against the new launcher.
- **Launcher downgrade**: the trigger is direction-agnostic; the profile
  converges to the now-installed older store version.
- **`dsh-cc` not on PATH at sync time**: `launcherVersion` is `null`, restore
  never auto-fires, and the original manual fallback applies:
  `rm $DSH_HOME/profiles/<profile>/node_modules/@dsh-cc/dsh-cc-build.json`
  plus re-adding the store bundles. Corner-case only.
- **Restore raced by a second launch**: the lockfile's loser launches the
  as-is state. A lock orphaned by a kill goes stale after ten minutes and is
  taken over.
- **Restore killed mid-flight**: next launch finds `<backup>` without
  `<scope>` and rolls back before retrying (§3.4 step 1).
- **Fresh release younger than pnpm's minimum-release-age window**: restore
  fails, keeps the dev state, and retries on each subsequent launch until the
  window passes; the warning text names the window and the
  `minimumReleaseAge=0` knob.
- **Hand-edits inside top-level materialized deps** (outside the `@dsh-cc`
  scope) survive a restore if their version matches the store graph's —
  registry content is immutable at a version, so this requires deliberate
  in-profile editing during debugging. Accepted and documented; the scope dir
  is the protected surface.
- **Inert leftovers**: none. The set-aside backup takes the whole scope dir —
  in-closure packages are re-materialized by pnpm, out-of-closure dev
  artifacts (e.g. the synced `@dsh-cc/cli` copy, which nothing in the store
  graph imports) disappear with the backup.
- **Garbage stamp**: `readBuildInfo` catches parse failures → both `--version`
  and the restore decision fail open to bare-version/no-op.
- **Harness drift**: today's dsh performs no boot-time reconciliation that
  could disturb the stamp or the scope dir (verified in the sibling harness
  checkout at review time). Re-verify when upgrading the pinned harness
  version.

## 6. Implementation checklist

1. `scripts/stamp-build-info.mjs` — new, per §3.1 (~50 lines), including the
   PATH-based `launcherVersion` probe.
2. `scripts/sync-local-profile.sh` — one hook line per §3.2.
3. `packages/launcher/tui/bootstrap.mjs` — `readBuildInfo`,
   `formatVersionLabel`, `devStoreRestoreDecision`, and `runStoreRestore`
   per §3.3–3.4 (spawn injectable).
4. `packages/launcher/tui/bin/dsh-cc.js` — reorder the `--version` branch
   below `profileDir`; invoke restore after the bootstrap block.
5. `packages/launcher/tui/tests/build-info.spec.ts` (vitest):
   - `formatVersionLabel`: no info → bare; dev clean →
     `0.6.3-dev+abc123`; dirty → `.dirty` suffix; `commit: null` →
     `-dev+unknown`; missing `channel` → bare (future channels fail safe);
     divergent `stamp.version` (0.7.0 stamp vs 0.6.3 launcher) → stamp's
     version wins.
   - `readBuildInfo`: missing file → null; malformed JSON → null; valid →
     parsed.
6. `packages/launcher/tui/tests/store-restore.spec.ts` (vitest, real tmp
   profile dirs, injected `spawnSyncImpl`):
   - decision matrix: no stamp / `channel≠'dev'` / `launcherVersion` null /
     equal / mismatch → null,null,null,null,plan.
   - success: backup removed, stamp removed, notice emitted; unmarked
     `.agent-presets/cc` removed, marked copy preserved.
   - failure: scope restored from backup byte-identical, stamp kept, warning
     emitted, launch continues.
   - lock: young `EEXIST` → skip; stale → takeover.
   - crash recovery: `<backup>` present + `<scope>` missing → rolled back
     before retrying.
   - `--version`-only invocation never reaches restore (exit before it).
7. README local-development section, where it documents the sync flow: one
   note that `--version` reports dev builds and their source commit, and that
   updating the launcher returns the profile to the store edition.

No changes to: any `package.json`, `.gitignore`, `scripts/release.mjs`, CI
workflows, or `docs/claude-code-capabilities.yaml` (the launcher is not in the
gated package families).

## 7. Verification

Unit: `pnpm vitest run packages/launcher/tui` — both new specs green, plus the
existing `bootstrap.spec.ts` / `version-gate.spec.ts` undisturbed.

End-to-end, against the real dev loop:

```sh
pnpm run build
bash scripts/sync-local-profile.sh tui     # or web — match the profile you launch
cat "$DSH_HOME/profiles/tui/node_modules/@dsh-cc/dsh-cc-build.json"
dsh-cc --version                           # expect 0.6.3-dev+<sha>[.dirty]
echo scratch >> README.md                  # dirty the tree
bash scripts/sync-local-profile.sh tui
dsh-cc --version                           # expect the .dirty suffix
```

Restore paths:

- *Success* (needs registry access to the published versions): install the
  previous launcher release globally, sync a dev build (records that
  `launcherVersion`), `npm install -g @dsh-cc/cli@latest`, run `dsh-cc` —
  expect the notice, the stamp gone, and the scope dir re-materialized at the
  new store versions (`node -p "require('$DSH_HOME/profiles/tui/node_modules/@dsh-cc/bundle-tui/package.json').version"`).
- *Failure*: point the spawned pnpm at a dead registry
  (`npm_config_registry=http://127.0.0.1:9`), repeat — expect the warning,
  the dev state rolled back byte-identically, `--version` still showing the
  dev label, and a normal boot.
- *No-op*: an unchanged launcher across syncs never restores (no spawn — the
  unit-layer lock/decision tests are the proof; observable as zero delay and
  no output on ordinary dev launches).

First-boot regression check: with a scratch `$DSH_HOME`, confirm
`bootstrapCommand` still emits `plugin add @dsh-cc/...@0.6.3` (plain semver)
and that a fresh profile with no stamp skips restore entirely.

Publish-safety check: `npm pack --dry-run` in `packages/launcher/tui` shows
the same file list as before (the stamp can never be inside the package), and
`node scripts/release.mjs --dry-run <next>` is unaffected.

## 8. Optional phase 2 (separate PR)

The in-session `/version` command (`packages/interaction/command-version`)
could append a `dev build <commit>[-dirty]` line when the stamp exists in its
profile, reusing the same JSON. That package family is capability-manifest
gated, so that PR must also update `docs/claude-code-capabilities.yaml` and
commit the regenerated parity docs. Kept out of scope here so phase 1 stays
manifest-free.
