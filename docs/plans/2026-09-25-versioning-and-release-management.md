# Versioning, branching, and release management for dsh-cc

**Status:** **Proposed** — design only; this PR is docs-only. Implementation is split into PR-0 … PR-10 (§13). No workflow, script, manifest, tag, or npm dist-tag is changed by this document.
**Date:** 2026-09-25
**Branch:** `docs/versioning-release-plan` (based on `origin/main` eb6aeb9).
**Supersedes:** the harness-anchor policy of `docs/plans/2026-09-12-harness-0.1.5-rc1-compatibility.md` §1 ("anchor to the dsh meta-package `latest`" — now: anchor *each* dsh-cc channel to the same-named dsh channel) and the "Open-range policy" of `docs/plans/2026-09-08-harness-0.1.2-rc1-compat.md:363-370` (peer floors are now generated from pins, §10). `docs/release.md` remains the operator runbook; each implementation PR updates the sections it changes.

All anchors below were verified against `origin/main` eb6aeb9 on 2026-09-25. Registry and upstream data were captured on 2026-09-25 at 20:09 SGT (Appendix B).

Normative words: **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

---

## 1. Summary

dsh-cc ships two npm channels (`latest` and `next`), but it verifies both of them against one harness build: `deepseek-harness` 0.1.5-rc.1. That build is neither of the versions users get from `@deepseek-ai/dsh` today (`latest` = 0.1.5-rc.3, `next` = 0.1.7-rc.2). This plan does four things:

1. **Pair the channels.** dsh-cc `latest` MUST be verified against dsh `latest`. dsh-cc `next` MUST be verified against dsh `next`. The pairing is recorded in a new pins file, `.github/harness-pins.json` (§8), which becomes the single source of truth for CI, publish, peer ranges, and the launcher's version gate.
2. **Run CI against both pins.** CI runs one matrix leg per served channel (§9). Publishing is gated on the legs that are marked required. Moving pins is automated by a watcher that opens PRs; it never merges or publishes (§11).
3. **Keep one trunk until it can't serve both.** `main` serves both channels. A long-lived maintenance branch `release/X.Y.x` exists only for (a) an urgent hotfix to `latest`, or (b) a *harness split*: the two dsh lines become API-incompatible and no single commit can pass both legs. Exact triggers, procedures, and retirement rules are in §7.
4. **Make channel versions monotonic.** A new `next` MUST be greater than the current `next`, and a new `latest` MUST be greater than the current `latest`. This is enforced in the release-decision script, in `release.mjs`, and as a hard gate in `publish.yml` (§6.6). This also fixes the defect behind the open PR #144, which would move `next` backwards from 0.8.1-rc.1 to 0.8.0-rc.4.

## 2. Goals and non-goals

### Goals

- G-1. Every published dsh-cc version states which dsh version(s) it was verified against, and the dsh-cc channel it lands on matches the dsh channel it was verified against.
- G-2. A developer can take any release situation (routine rc, stable, hotfix, upstream move, split, rollback) and execute it from §12 without further decisions.
- G-3. A dist-tag never moves backwards through an automated path.
- G-4. Every irreversible or user-visible action has an explicit human gate (§12.9).
- G-5. Upstream dist-tag moves are detected within 4 hours and turned into a reviewable PR.

### Non-goals

- Tracking the upstream `alpha` channel. dsh-cc publishes no `alpha` channel. Peer ranges do not admit dsh alphas (Appendix A).
- Reaching 1.0.0 or changing the major version. While dsh-cc is 0.x, breaking changes bump the minor version (§6.2).
- Versioning `@deepseek-ai/cordis` or `@deepseek-ai/schemastery` peers. They are versioned independently of dsh (cordis `latest` = 4.0.4), and the sync tooling MUST NOT touch them (§10.3).
- Making peer ranges enforce anything at install time. They are advisory (§4.1 F-6). The guarantees come from CI pins and the launcher floor.
- Replacing the daily RC ladder cadence. The weekly schedule, the SGT week, and the "one stable per week" rule stay as they are.

## 3. Glossary

| Term | Meaning in this document |
|---|---|
| **dsh / harness** | `@deepseek-ai/dsh`, the host CLI built from `deepseek-ai/deepseek-harness`. Its sub-packages (`@deepseek-ai/dsh-*`) are published in lockstep with the meta package (for example, `@deepseek-ai/dsh-agent@0.1.7-rc.2` exists). |
| **dsh-cc** | This repo. It publishes 85 non-private `@dsh-cc/*` packages. Users install `@dsh-cc/cli` (the launcher). |
| **dist-tag** | An npm pointer from a tag name to one version (`npm view <pkg> dist-tags`). |
| **channel** | A dist-tag that users install from: `latest` (the default for `npm i <pkg>`) or `next` (`npm i <pkg>@next`). |
| **pairing** | The rule that dsh-cc channel C is verified against dsh channel C. |
| **pin** | One entry in `.github/harness-pins.json`: a dsh version plus the exact commit SHA of its `dsh-v<version>` tag in the source repository. |
| **leg** | One CI matrix job that builds the harness at a pin and runs dsh-cc's harness-dependent gates. Leg names are `presubmit (latest)` and `presubmit (next)`. |
| **required / informational leg** | A required leg blocks merges (through the ruleset) and publishes (through `publish.yml`). An informational leg runs and is reported but blocks nothing. |
| **serves** | The set of channels a branch publishes to. It is declared in that branch's pins file. |
| **trunk mode** | `main` serves `["latest","next"]`. This is the default. |
| **split mode** | `main` serves `["next"]` and a maintenance branch serves `["latest"]` (§7.6). |
| **release line** | A bare `X.Y.Z` that rc's and a stable share, for example line `0.8.1` → `0.8.1-rc.1`, `0.8.1-rc.2`, `0.8.1`. |
| **lockstep** | All non-private packages and the root `package.json` carry the same version. This is enforced by `scripts/check-release-version.mjs`. |
| **release PR branch** | A short-lived `release/vX.Y.Z[-rc.N]` branch that carries only the version bump commit. |
| **maintenance branch** | A long-lived `release/X.Y.x` branch that publishes stable patch releases of line `X.Y` to `latest`. |
| **topic branch** | Any feature, fix, docs, or chore branch that targets `main` or a maintenance branch through a PR. |
| **effective next** | `max(upstream latest, upstream next)` by semver. If upstream `next` is older than upstream `latest`, `next` is treated as equal to `latest`. |
| **build channel** | The pin that the `publish` job itself builds and tests against (§9.5). |
| **release owner** | The person configured as the required reviewer of the `npm-publish` environment (PR-0 configures the GitHub user `jianxx`). This person makes every decision marked "release owner". |

## 4. Current state and gaps

### 4.1 Facts (verified)

| # | Fact | Evidence |
|---|---|---|
| F-1 | CI verifies against **one** harness commit, `1ef9c1fa…` ("0.1.5-rc.1 release commit"), checked out from the fork `dsh-cc/deepseek-harness`. `publish.yml` derives the same pin by grepping `presubmit.yml`. | `.github/workflows/presubmit.yml:47`, `:70-74`; `.github/workflows/publish.yml:72-78` |
| F-2 | The same pin was in force for v0.7.1, v0.8.0-rc.3, and v0.8.1-rc.1. | `gh api repos/dsh-cc/dsh-cc/contents/.github/workflows/presubmit.yml?ref=<tag>` |
| F-3 | The dist-tag is derived from the tag's shape only: prerelease → `next`, otherwise `latest`. | `publish.yml:181-186`, `:231`; `docs/release.md:69-73` |
| F-4 | Publish pipeline: `daily-release.yml` opens a `release/v*` PR on weekdays at 08:00 SGT. After a human merges it, `release-tag.yml` tags the merge commit and dispatches `publish.yml`, which publishes every non-private package. | `daily-release.yml:30`, `:165-199`; `release-tag.yml:33-37`, `:85`, `:146`; `publish-packages.mjs:94-101` |
| F-5 | 77 of 85 publishable packages declare `@deepseek-ai/dsh-*` as **peerDependencies**, all `>=0.1.5-rc.1` (368 occurrences). No package has a runtime `dependencies` entry on `@deepseek-ai/*`. devDependencies are `link:../../../../deepseek-harness/...`, and every one of the 1360 `@deepseek-ai` lockfile entries resolves to `link:`. | manifest scan; `pnpm-lock.yaml` |
| F-6 | Peers are advisory: profiles install with `autoInstallPeers: false` and resolve `@deepseek-ai/*` to the host dsh. | `docs/plans/2026-09-08-harness-0.1.2-rc1-compat.md:343-351` |
| F-7 | The launcher installs bundles at **its own exact version** (`@dsh-cc/bundle-*@<cli version>`). A dist-tag therefore only matters when users install `@dsh-cc/cli`. | `packages/launcher/tui/bootstrap.mjs:11-15`, `:142-145` |
| F-8 | The launcher floor is `MIN_DSH_VERSION = '0.1.5-rc.1'`. It is checked only on the bootstrap path, using a hand-rolled ordering that does **not** apply node-semver's prerelease rule, so 0.1.7-rc.2 and even `0.1.6-alpha.2` pass. | `bootstrap.mjs:518-527`, `:553-592`; `packages/launcher/tui/tests/version-gate.spec.ts:47-60` |
| F-9 | `check:publish` checks peer ranges against the sibling harness version. It rejects any range that contains whitespace, so `\|\|` ranges are unsupported. | `scripts/check-publish-manifests.mjs:15-19`, `:113-118`, `:182-190`, `:296-319` |
| F-10 | `/doctor` and `/version` display the harness version but do not judge it. | `packages/interaction/command-doctor/src/checks/env.ts:34-49` |
| F-11 | The published artifacts embed no harness code: type-only `@deepseek-ai/*` imports are erased. Which pin a build ran against affects verification only, not the bytes published. | `packages/interaction/command-permissions/tsdown.config.ts:5-11` |
| F-12 | The `main` ruleset ("PRs & conventional commits", id 22367074) has deletion, non-fast-forward, pull_request (0 approvals), and linear-history rules. It has **no required status checks**. | `gh api repos/dsh-cc/dsh-cc/rules/branches/main` |
| F-13 | The `npm-publish` environment has **no protection rules** and no deployment policy, even though `docs/release.md:132` says publishing needs human approval. | `gh api repos/dsh-cc/dsh-cc/environments` |
| F-14 | Release-tooling self-tests (`daily-release-decide.test.mjs`, `release.test.mjs`, `check-publish-manifests.test.mjs`) run neither in CI nor under vitest. | `presubmit.yml:122,213,217` (only three other `.test.mjs`); `vitest.config.ts:94` |

### 4.2 Gaps

- **G1 — No channel pairing.** Both channels are verified only against 0.1.5-rc.1. The dsh-cc@latest (0.7.1) + dsh@latest (0.1.5-rc.3) pairing has never been tested, and neither has the dsh-cc@next (0.8.1-rc.1) + dsh@next (0.1.7-rc.2) pairing.
- **G2 — Peer range rejects dsh next.** Under node-semver 7.8.5, `>=0.1.5-rc.1` does not admit `0.1.7-rc.2` (Appendix A). The range is advisory, but it misstates compatibility.
- **G3 — Monotonicity is not enforced.** `nextLineVersion` derives the line from the last stable only (`scripts/daily-release-decide.mjs:179`) and discards an rc on any other line (`:181-185`). v0.8.1-rc.1 exists on line 0.8.1, but the ladder computed line 0.8.0 and opened PR #144 ("chore(release): v0.8.0-rc.4"). Merging it would publish 0.8.0-rc.4 with `--tag next` and move `next` backwards. Nothing in `publish.yml` would stop it.
- **G4 — Fork without tags.** `dsh-cc/deepseek-harness` has one ref (`master` = `ddefc45`, the upstream `dsh-v0.1.6-alpha.2` commit, last pushed 2026-09-18) and no tags. Upstream `deepseek-ai/deepseek-harness` is public and carries every `dsh-v*` tag.
- **G5 — Bot PRs get no CI.** PRs opened with `GITHUB_TOKEN` trigger no workflows. PR #144 reports "no checks". PR #134 got `presubmit` only because a human pushed to it.
- **G6 — Publishing is not human-gated** (F-13), and merges are not check-gated (F-12).
- **G7 — The version is taken from the branch name.** `release-tag.yml:85` derives the tag from the head branch name. PR #134 (branch `release/v0.8.0-rc.4`) was re-versioned to 0.8.1-rc.1, so the Release Tag run failed and the tag was pushed by hand (inferred from the run history: Release Tag failed at 2026-09-24 14:06 SGT, and Publish v0.8.1-rc.1 started from a tag push 4 s later).
- **G8 — dsh next is structurally incompatible with the current tree.** At `dsh-v0.1.7-rc.2`, three harness packages that dsh-cc links no longer exist: `packages/code-runtime/code-runtime` (`@deepseek-ai/dsh-code-runtime`), `packages/preset/agent-presets` (`@deepseek-ai/dsh-agent-presets`), and `packages/workflow/workflow-worker-thread` (`@deepseek-ai/dsh-workflow-worker-thread`). All three were last published at 0.1.5-rc.3 on `next`. They are used by `packages/core/tools`, `packages/core/tool-workflow`, `packages/subagent/workflow-journal`, and `packages/ui/tui`. All 67 link targets exist at `dsh-v0.1.5-rc.3`. (Checked with the GitHub trees API for both SHAs, `truncated=false`.)

## 5. Channel model

### 5.1 Pairing rules

- R-1. dsh-cc `latest` ↔ dsh `latest`. A version published to dsh-cc `latest` MUST have passed a required leg at `pins.channels.latest` on the branch it was released from.
- R-2. dsh-cc `next` ↔ dsh `next` (effective next). A version published to dsh-cc `next` MUST have run the `next` leg. Once `next` is promoted to required (§9.3), that leg MUST have passed. Before promotion the leg is informational: its result, pass or fail, MUST be stated in the GitHub Release notes (§9.6).
- R-3. **A prerelease never takes `latest`.** This is unchanged (`docs/release.md:69-73`). It applies even though upstream's own `latest` is currently a prerelease (0.1.5-rc.3): dsh-cc pairs a *stable* dsh-cc with whatever dsh `latest` is.
- R-4. The upstream `alpha` channel is not tracked.
- R-5. After a stable release from a branch that serves both channels, `next` MUST NOT point below `latest`. `publish.yml` advances `next` to the stable version when `next` < stable (§9.5).
- R-6. dsh-cc and dsh version numbers are independent. The pairing is by channel name, never by number.

### 5.2 What users get

Users install both CLIs globally. The launcher pins bundles to its own version (F-7).

| Command | Today (2026-09-25) | Target, trunk mode | Target, split mode |
|---|---|---|---|
| `npm i -g @dsh-cc/cli` | 0.7.1, verified against dsh **0.1.5-rc.1** (not against dsh `latest` 0.1.5-rc.3) | Newest stable from `main`, verified against `pins.latest` (required) and `pins.next` (required after promotion, informational before) | Newest stable from `release/X.Y.x`, verified against that branch's `pins.latest` |
| `npm i -g @dsh-cc/cli@next` | 0.8.1-rc.1, verified against dsh **0.1.5-rc.1** (never against dsh `next` 0.1.7-rc.2) | Newest rc from `main`, or the newest stable if that is higher (R-5), verified as above | Newest rc from `main`, verified against `main`'s `pins.next` only |
| `npm i -g @deepseek-ai/dsh` / `@next` | 0.1.5-rc.3 / 0.1.7-rc.2 | unchanged (upstream) | unchanged (upstream) |

The supported install commands are exactly these two pairs:

```sh
npm install -g @deepseek-ai/dsh @dsh-cc/cli            # latest ↔ latest
npm install -g @deepseek-ai/dsh@next @dsh-cc/cli@next  # next ↔ next
```

Mixed pairs are unsupported. The launcher still enforces only the floor (§10.4). The optional `/doctor` warning (§10.6) flags mixed pairs.

## 6. Versioning rules

### 6.1 Semver and lockstep

- V-1. Versions are SemVer 2.0: `X.Y.Z` or `X.Y.Z-rc.N` (N ≥ 1). dsh-cc publishes no other prerelease identifiers.
- V-2. Every release writes the same version to the root `package.json`, every non-private `packages/<group>/<pkg>/package.json`, every `.claude-plugin/plugin.json` of a non-private package, and `FALLBACK_VERSION` in `packages/interaction/command-version/src/version.ts:14`. Only `scripts/release.mjs` performs these writes. A human MUST NOT edit a version by hand, including on a `release/v*` branch (G7).
- V-3. Internal dependencies stay `workspace:^`, which publishes as `^<version>`. On 0.x a caret locks the minor (`^0.8.1-rc.1` = `>=0.8.1-rc.1 <0.9.0-0`), so a maintenance line never resolves another line's packages. §14 records the risk once 1.0 exists.

### 6.2 Choosing the release line on `main`

The ladder computes `line` as the maximum, by `X.Y.Z` comparison, of three candidates:

1. `base` = `nextLineVersion(lastStable, bump, hasFeat)`, unchanged (`daily-release-decide.mjs:111-126`). `bump=auto` gives a minor bump if any commit subject on `main` since `lastStable` matches `^feat(?:\(|!|:)` (`:281`), and a patch bump otherwise. A workflow dispatch MAY force `patch` or `minor`.
2. `openRcLine` = the line of the highest `vX.Y.Z-rc.N` tag merged into `main` whose `X.Y.Z` is greater than `lastStable`. This is the #144 fix. Today it yields 0.8.1.
3. `maintFloor` = `X.(Y+1).0` of `lastStable`, but only if (a) the remote has a branch `release/X.Y.x` for `lastStable`'s `X.Y`, or (b) `main`'s pins file does not serve `latest`. This keeps `main` off a line that a maintenance branch owns.

Breaking changes (`feat!`, `BREAKING CHANGE:`) bump the minor version while dsh-cc is 0.x.

### 6.3 Release candidates

- V-4. The first rc on a line is `-rc.1`. Each later rc on that line is the highest existing `-rc.N` plus 1. Rc numbers are never reused. Gaps are allowed (a tag that exists but was never published still consumes its number).
- V-5. The ladder proposes the next rc when `main` has commits after the latest rc on the line (`rc_bump`), or `-rc.1` when the line has no rc yet (`first_rc`).
- V-6. Rc's are published only from `main`. Maintenance branches never publish rc's (§7.6.4).

### 6.4 Stable releases

- V-7. A stable `X.Y.Z` is proposed when the latest rc on line `X.Y.Z` has no commits after it (`stabilize`). The stable's content is identical to that rc except for the version fields.
- V-8. Stable releases from `main` are allowed only when `main` serves `latest`. In split mode the ladder MUST NOT propose `stabilize`. It returns `action=skip reason=split_no_stabilize` when there is nothing new to rc.
- V-9. At most one stable from `main` per Asia/Singapore Mon–Sun week (unchanged). Maintenance tags do not count, because the ladder lists only tags merged into `main` (`daily-release-decide.mjs:212-219`).

### 6.5 Maintenance releases

- V-10. On `release/X.Y.x` the only allowed version is `X.Y.P` where P is one more than the highest existing `vX.Y.*` stable tag. Maintenance releases are stable-only and go to `latest`.

### 6.6 Monotonicity

**Invariant M.** Let `cur(C)` be the current `@dsh-cc/cli` dist-tag of channel C. A publish of version V to C MUST satisfy `V ≥ cur(C)` (equality is a rerun), and V MUST be a stable version when C = `latest`. The only exception is the rollback runbook (§12.7), which uses `--allow-downgrade` behind the `npm-publish` approval.

Enforcement, in order of execution:

1. **`scripts/daily-release-decide.mjs` (proposal time).**
   - Add `openRcLine` and `maintFloor` to the line computation (§6.2).
   - Move `highestRcOnLine` into the pure `decide()` so that it runs on the final `line`.
   - Add the split-mode rule (V-8).
   - After computing `version`, assert that it is greater than every tag in `input.tags` of the same kind: rc vs. all rc tags, stable vs. all stable tags. If it is not, throw `monotonic_violation: <version> <= <tag>`, which fails the job loudly.
   - New `gatherInputFromGit` inputs: `maintenanceBranches` (from `git ls-remote --heads origin 'refs/heads/release/*.x'`) and `servesLatest` (from `.github/harness-pins.json`).
2. **New `scripts/check-channel-monotonic.mjs <tag|version> [--channel latest|next] [--package @dsh-cc/cli] [--allow-downgrade]`.**
   - It runs `npm view <package> dist-tags --json`.
   - The channel defaults from the version shape (prerelease → `next`).
   - Exit codes: 0 when V ≥ current or the tag is absent; 1 on a violation, or when a prerelease targets `latest`; 2 on a registry error (callers fail closed).
   - It compares with the exported `compareVersions` from `scripts/check-publish-manifests.mjs:74-97`.
3. **`scripts/release.mjs` (local and daily-release).** Before writing anything, it runs step 2 for the target version. A `--offline` flag skips this with a printed warning, for tests only.
4. **`publish.yml` `plan` job (hard gate).** Runs step 2 against the tag before any publish (§9.5).

Worked example (today's state):

- Inputs: `lastStable=v0.7.1`, feats present, highest rc above stable is `v0.8.1-rc.1`, and `main` has commits after it.
- `base=0.8.0`, `openRcLine=0.8.1`, so `line=0.8.1`.
- Proposal: `0.8.1-rc.2`, not `0.8.0-rc.4`.

## 7. Branching model

### 7.1 Branch types

| Pattern | Kind | Lifetime | Created by | Merges into | Protected |
|---|---|---|---|---|---|
| `main` | trunk | permanent | — | — | yes (§7.7) |
| `<type>/<slug>` or `worktree-<slug>` | topic | until merged | any developer | `main` or `release/X.Y.x` | no |
| `release/vX.Y.Z[-rc.N]` | release PR branch | until merged/closed | `daily-release.yml` (bot) or a human following §12.3 | `main` (rc/stable) or `release/X.Y.x` (patch) | no |
| `harness-bump/<base-slug>` | bot branch | until merged/closed | `harness-watch.yml` | the base it names | no |
| `release/X.Y.x` | maintenance | until retired (§7.6.6) | release owner only | — | yes |

`<type>` is one of `feat`, `fix`, `docs`, `chore`, `refactor`, `perf`, `test`, `ci`, `build`. `<base-slug>` is the base branch with `/` replaced by `-` (`main`, `release-0.8.x`). The prefixes `release/` and `harness-bump/` are reserved: humans MUST NOT create branches under them except as §12 prescribes. The two `release/` forms can't collide: a release PR branch always starts with `release/v`, and a maintenance branch always ends with `.x`.

### 7.2 `main`

- It is the only branch that develops features and the only source of rc's.
- It is always releasable to every channel it serves. The required legs MUST be green on every merge commit (the ruleset enforces this after PR-2, §7.7).
- In trunk mode it serves `["latest","next"]`. In split mode it serves `["next"]` (§7.6).
- It is changed only through PRs. Merges are squash or rebase (linear history, F-12).

### 7.3 Topic branches and PR conventions

- A PR title MUST be a valid Conventional Commit header (`type(scope)!: subject`). Squash merges use it as the commit subject, and the ladder reads subjects to choose minor vs. patch (§6.2). A user-visible capability MUST use `feat`; a bug fix MUST use `fix`.
- Topic branches SHOULD be rebased on their base before merge. The ruleset does not require branches to be up to date (§7.7), so a stale-but-green PR may merge; the post-merge `push` run on the base is the backstop.
- Fixes MUST land on `main` first ("main-first"). The only exception is a bug that does not exist on `main`: the fix then targets the maintenance branch directly, and the PR description MUST say why.

### 7.4 Release PR branches (`release/v*`)

- Created by `daily-release.yml` (§12.1). This is unchanged, except that after PR-3 it dispatches `presubmit.yml` on the branch (G5) and runs `check-channel-monotonic.mjs` before opening the PR.
- They contain exactly one commit, `chore(release): vX.Y.Z[-rc.N]`, produced by `release.mjs`.
- The version in the branch name MUST equal the version in the commit (V-2, G7). To release a different version, close the PR and produce a new one. Never edit it.
- On merge, `release-tag.yml` tags the merge commit with the branch-derived tag and dispatches `publish.yml` with `--ref <base branch>` (§9.7).

### 7.5 Bot branches (`harness-bump/*`)

These are owned by `harness-watch.yml` (§11). Humans MAY push adaptation commits to them. Once a human commit is present, the watcher stops force-pushing that branch.

### 7.6 Maintenance branches (`release/X.Y.x`)

#### 7.6.1 When a maintenance branch is created

No maintenance branch exists by default. The release owner creates one when, and only when, one of these triggers holds.

**T1 — hotfix to `latest`.** A fix must reach `latest` users, and path H1 (release it from `main`, §12.3) is unavailable because at least one of these is true:
- (a) a stable from `main` was already published this SGT week;
- (b) `main` has unreleased `feat` commits since the last stable that the release owner does not want on `latest` yet;
- (c) a required leg is red on `main`;
- (d) the release owner requires the fix on `latest` within 24 hours.

**T2 — harness split.** A PR that is necessary to make `presubmit (next)` green on `main` makes `presubmit (latest)` red, and it cannot be restructured to keep both green. The typical cause is a harness package that dsh-cc must import existing at only one pin (G8). The PR author states this in the PR description, with links to both leg results. The release owner confirms by applying the label `harness-split` to that PR. **No split happens without that label.**

**Precondition for both triggers:** the maintenance branch is cut from the newest stable tag that contains `.github/harness-pins.json`, meaning a stable released after PR-4. Older tags (including v0.7.1) predate the channel-aware tooling. For them, a hotfix MUST use H1.

#### 7.6.2 Creation procedure (release owner)

Let `vX.Y.Z` be the newest stable tag on `main`. For T2, first complete step S1 of §12.5, which produces a fresh stable.

```sh
git fetch origin --tags
git push origin "vX.Y.Z^{commit}:refs/heads/release/X.Y.x"
```

Then open a PR against `release/X.Y.x` from a branch `chore/X.Y.x-serve-latest`:

```sh
git switch -c chore/X.Y.x-serve-latest origin/release/X.Y.x
node scripts/harness-pins.mjs set-serves latest   # serves ["latest"], required ["latest"], drops channels.next
node scripts/harness-pins.mjs sync
git commit -am "chore(release): X.Y.x serves latest only"
git push -u origin chore/X.Y.x-serve-latest
gh pr create --base release/X.Y.x --title "chore(release): X.Y.x serves latest only" --body "Maintenance bootstrap per docs/plans/2026-09-25-versioning-and-release-management.md §7.6.2"
```

The branch is in service once this PR merges.

#### 7.6.3 What may land on a maintenance branch

**Allowed:**
- `fix:` commits: backports (§7.6.5) and maintenance-only fixes (§7.3).
- `chore(harness):` pin bumps that stay on the same dsh release line (§11.2).
- `ci:` and `chore:` backports of release tooling, needed only to keep the branch releasable.
- Release PRs `release/vX.Y.P` (V-10).

**Forbidden:** `feat:` commits, refactors, dependency upgrades other than security fixes, and any hand edit of versions.

#### 7.6.4 Releasing from a maintenance branch (patch to `latest`)

Maintenance releases are manual. `daily-release.yml` runs on `main` only. See §12.3, path H2, for the exact commands.

#### 7.6.5 Backport procedure

```sh
git fetch origin
git switch -c fix/X.Y.x-<slug> origin/release/X.Y.x
git cherry-pick -x <sha-on-main>          # one commit per original PR; resolve conflicts by hand
git push -u origin fix/X.Y.x-<slug>
gh pr create --base release/X.Y.x \
  --title "fix(<scope>): <subject> [backport X.Y.x]" \
  --body "Backport of #<PR> (<sha-on-main>)."
```

The `-x` trailer is mandatory: it records provenance for the release notes. A backport PR MUST pass `presubmit (latest)` on the maintenance branch.

#### 7.6.6 Retirement

A maintenance branch is retired when a stable from `main` whose line is higher takes `latest`. This happens after reunification (§12.6) or after an H1 release following a T1 branch. Procedure:

1. The release owner adds the branch to the ruleset "Retired maintenance branches" (update-restricted, §7.7). It is kept, not deleted; tags preserve its history either way.
2. `harness-watch.yml` ignores retired branches. It lists only `release/*.x` branches whose `.github/harness-pins.json` serves `latest` and whose name is not in `.github/retired-branches.txt`, a one-name-per-line file maintained on `main` in the same PR as step 1.

At most one maintenance branch is in service at any time. If a second trigger fires while one is active, it reuses the active branch when the lines match. Otherwise the release owner MUST retire the old branch first.

#### 7.6.7 Diagrams

The branch lifecycle in trunk mode, with a T1 hotfix branch (versions are illustrative):

```mermaid
gitGraph
  commit id: "feat: A"
  commit id: "release v0.9.0" tag: "v0.9.0"
  branch release/0.9.x
  checkout main
  commit id: "feat: B"
  commit id: "fix: C"
  commit id: "release v0.10.0-rc.1" tag: "v0.10.0-rc.1"
  checkout release/0.9.x
  cherry-pick id: "fix: C"
  commit id: "release v0.9.1" tag: "v0.9.1"
  checkout main
  commit id: "release v0.10.0" tag: "v0.10.0"
```

`v0.9.1` goes to `latest`. `v0.10.0-rc.1` goes to `next`. When `v0.10.0` takes `latest`, `release/0.9.x` is retired.

How to choose the path when a fix must reach `latest`, or when the `next` leg can't go green:

```mermaid
flowchart TD
  A["Need: fix on latest, or next leg cannot go green"] --> B{"Which?"}
  B -->|"fix on latest"| C{"Any of T1 a-d true?"}
  C -->|"no"| H1["H1: land on main, release rc then stable from main"]
  C -->|"yes"| D{"Newest stable tag has .github/harness-pins.json?"}
  D -->|"no"| H1
  D -->|"yes"| H2["H2: cut or reuse release/X.Y.x, backport, patch release"]
  B -->|"next leg red"| E{"Adaptation PR keeps latest leg green?"}
  E -->|"yes"| P["Merge; promote next to required per section 12.8"]
  E -->|"no, and label harness-split applied"| S["Split per section 12.5"]
  E -->|"no label yet"| W["Next stays informational; release owner decides within 10 business days"]
```

### 7.7 Branch protection (release owner applies; repository admin rights needed)

| Target | Ruleset | Rules | Required status checks |
|---|---|---|---|
| `main` (`~DEFAULT_BRANCH`) | existing "PRs & conventional commits" (22367074) | keep deletion, non_fast_forward, pull_request (0 approvals), required_linear_history; **add** required_status_checks with "require branches to be up to date" **off** | trunk, before promotion: `presubmit (latest)`. After promotion: `presubmit (latest)`, `presubmit (next)`. Split: `presubmit (next)` |
| `release/*.x` | **new** "Maintenance branches", include `refs/heads/release/*.x` | creation (repository-admin bypass only), deletion, non_fast_forward, pull_request (0 approvals), required_linear_history, required_status_checks | `presubmit (latest)` |
| retired `release/X.Y.x` | **new** "Retired maintenance branches", include each retired branch by name | update (restrict updates), deletion | — |
| `release/v*`, `harness-bump/*`, topic branches | none | — | — (bots force-push the first two) |

The required-check set on `main` MUST change **before** merging a PR that changes `main`'s served channels. Otherwise the PR waits forever for a check that its own matrix no longer produces (§12.5 S4).

## 8. Harness pins

### 8.1 Source repository (decision)

CI checks out **upstream `deepseek-ai/deepseek-harness`** at a pinned SHA. It stops using the fork.

- Upstream is public and carries every `dsh-v*` tag. The fork has no tags and lags upstream (G4).
- Pinning by full SHA makes the checkout content-addressed, so upstream force-pushes cannot change what is tested.
- The fork is a manual-sync liability (`presubmit.yml:28-34` notes that deleting, privatizing, or GC'ing it breaks CI).
- **Fallback:** if upstream becomes unavailable, change `sourceRepository` to `dsh-cc/deepseek-harness` after pushing the needed tags there (`git push <fork> refs/tags/dsh-v<ver>`). It is a one-field change.

### 8.2 Schema: `.github/harness-pins.json`

Initial content after PR-1, with no behavior change. It uses the upstream tag commit of 0.1.5-rc.1. That commit is tree-identical to today's `1ef9c1fa`: GitHub compare reports it one commit ahead with zero changed files.

```json
{
  "schemaVersion": 1,
  "npmPackage": "@deepseek-ai/dsh",
  "sourceRepository": "deepseek-ai/deepseek-harness",
  "tagPrefix": "dsh-v",
  "serves": ["latest"],
  "required": ["latest"],
  "channels": {
    "latest": { "version": "0.1.5-rc.1", "sha": "183f08e9c6dde7e36cd2318eaee70b0da08fb35e" }
  }
}
```

Content after PR-6 (latest bump) and PR-8 (add `next`, informational):

```json
{
  "schemaVersion": 1,
  "npmPackage": "@deepseek-ai/dsh",
  "sourceRepository": "deepseek-ai/deepseek-harness",
  "tagPrefix": "dsh-v",
  "serves": ["latest", "next"],
  "required": ["latest"],
  "channels": {
    "latest": { "version": "0.1.5-rc.3", "sha": "a4c74a91e06b00fe0b0937bde982170c526cc842" },
    "next":   { "version": "0.1.7-rc.2", "sha": "477b4f420553e8a52c2fbccc464d7561b239c443" }
  }
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | Always `1`. |
| `npmPackage` | The upstream meta package whose dist-tags are tracked. Always `@deepseek-ai/dsh`. |
| `sourceRepository` | `owner/repo` checked out by CI. |
| `tagPrefix` | Upstream tag = `tagPrefix + version`. Always `dsh-v`. |
| `serves` | Channels this branch publishes to. |
| `required` | Channels whose legs block merges (via the ruleset) and publishes (via `publish.yml`). They also define the peer range and the launcher floor (§10). |
| `channels.<c>.version` | The dsh version of the pin. It MUST equal upstream `npm view @deepseek-ai/dsh dist-tags.<c>` (effective next for `next`) whenever the watcher has no pending PR. |
| `channels.<c>.sha` | The full 40-hex commit that `refs/tags/dsh-v<version>` resolves to (peeled if the tag is annotated). |

### 8.3 Validation (`node scripts/harness-pins.mjs validate`, offline; runs in presubmit, pre-commit, and publish)

1. `schemaVersion === 1`, `npmPackage === "@deepseek-ai/dsh"`, `tagPrefix === "dsh-v"`, and `sourceRepository` matches `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
2. `serves` is exactly one of `["latest","next"]`, `["latest"]`, or `["next"]`.
3. The keys of `channels` equal the set in `serves`.
4. Every `version` matches `^\d+\.\d+\.\d+(-rc\.\d+)?$`. Stable or rc only: alpha pins are rejected (R-4).
5. Every `sha` matches `^[0-9a-f]{40}$`.
6. If both channels are present, `compareVersions(next.version, latest.version) >= 0`.
7. `required` is a non-empty subset of `serves`. If `latest` ∈ `serves`, then `latest` ∈ `required`. If `serves` is `["next"]`, then `required` is `["next"]`.

**Remote verification** (`node scripts/harness-pins.mjs verify-remote`, network; runs in the presubmit `plan` job and in `harness-watch.yml`). For each channel:
- `git ls-remote --tags https://github.com/<sourceRepository>.git "refs/tags/dsh-v<version>" "refs/tags/dsh-v<version>^{}"` returns the recorded `sha` (the `^{}` line wins when present);
- `curl -fsSL https://raw.githubusercontent.com/<sourceRepository>/<sha>/package.json` has `"version": "<version>"`;
- `npm view @deepseek-ai/dsh@<version> version` succeeds.

Any mismatch exits 1.

### 8.4 `scripts/harness-pins.mjs` CLI (new, dependency-free Node ≥ 22)

| Subcommand | Effect |
|---|---|
| `validate` | §8.3 offline checks. |
| `verify-remote` | §8.3 remote checks. |
| `get <channel> <version\|sha>` / `get-source` | Print one value. |
| `matrix` | Print `GITHUB_OUTPUT` lines `serves=<json>`, `required=<json>`, `informational=<json>` (compact JSON arrays; informational = serves − required). |
| `peer-range` / `min-version` / `channel-hint` | Print the generated values (§10.1, §10.4). |
| `bump --channel <c> --version <v> [--sha <s>]` | Set a pin. If `--sha` is omitted, resolve it via `git ls-remote` as in §8.3. Then run `validate`. |
| `set-serves latest\|next\|latest,next` | Set `serves`. Reset `required` to the minimum valid set (`latest` if served, else `next`). Drop or add `channels` entries; an added entry copies the other channel's pin until `bump` sets it. |
| `set-required latest\|next\|latest,next` | Set `required`, then validate. |
| `publish-plan --tag vV` | Print `dist_tag`, `build_channel`, `others_required`, `others_informational`, `advance_next` for `publish.yml` (§9.5). Exit 1 if the tag's channel is not in `serves`. |
| `sync` | Rewrite the generated files (§10.3). |
| `check` | Run `validate`, then run `sync` in memory; exit 1 if any file would change (drift gate). |

The pure functions `peerRange(pins)`, `minVersion(pins)`, `channelHint(pins)`, and `validate(pins)` are exported for tests and for `version-gate.spec.ts`. Tests live in `scripts/harness-pins.test.mjs`, a self-running `node:assert` harness like `scripts/daily-release-decide.test.mjs`.

## 9. CI

### 9.1 Shared building blocks (PR-2)

- **`.github/actions/harness-setup/action.yml`** (composite). Inputs: `channel` (required), `save-cache` (`'true'|'false'`, default `'false'`). Steps:
  1. Resolve the pin (`node dsh-cc/scripts/harness-pins.mjs get <channel> sha` and `get-source`) into step outputs.
  2. `actions/checkout@v4` of `<source>` at `<sha>` into `deepseek-harness`.
  3. `pnpm/action-setup@v4` with 11.7.0. `actions/setup-node@v4` with Node 22 and a pnpm cache over both lockfiles.
  4. `actions/cache/restore@v4` with key `harness-lib-<sha>` and today's fixed-depth paths (`presubmit.yml:155-162`).
  5. `pnpm install --frozen-lockfile` in `deepseek-harness`. On a cache miss, run `pnpm run build:lib && pnpm run build:native-system`, then `actions/cache/save@v4` when `save-cache == 'true'`.
  6. `pnpm install --frozen-lockfile` in `dsh-cc` with `HUSKY=0`.
- **`.github/actions/dsh-cc-gates/action.yml`** (composite). Runs, in the `dsh-cc` directory: `node scripts/check-publish-manifests.mjs`, `pnpm typecheck`, `pnpm run bundle:client`, `pnpm check:exports`, `pnpm test`, `pnpm check:subagent-paste`.

Cache keys stay `harness-lib-<sha>`, so each pin has its own entry. Two entries at about 64 MB each fit the repository cache budget.

### 9.2 `presubmit.yml` (PR-2)

```yaml
on:
  pull_request:
    branches: [main, 'release/*.x']
  push:
    branches: [main, 'release/*.x']
  workflow_dispatch: {}          # lets bots attach checks to their PR branches (G5)

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      serves: ${{ steps.m.outputs.serves }}
    steps:
      - uses: actions/checkout@v4
      - run: node scripts/harness-pins.mjs validate && node scripts/harness-pins.mjs verify-remote
      - id: m
        run: node scripts/harness-pins.mjs matrix >> "$GITHUB_OUTPUT"
  presubmit:
    needs: plan
    name: presubmit (${{ matrix.channel }})
    runs-on: ubuntu-latest
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        channel: ${{ fromJSON(needs.plan.outputs.serves) }}
    steps:
      # checkout dsh-cc into ./dsh-cc (fetch-depth: 0), then every existing
      # static step, then:
      - uses: ./dsh-cc/.github/actions/harness-setup
        with: { channel: '${{ matrix.channel }}', save-cache: 'true' }
      # capability/parity steps (unchanged), then:
      - uses: ./dsh-cc/.github/actions/dsh-cc-gates
      # token-efficiency (continue-on-error, unchanged), plus a new step:
      - run: pnpm test:release-tooling
        working-directory: dsh-cc
```

- Remove the `DSH_HARNESS_REF` env (`presubmit.yml:44-47`).
- Add a root script `"test:release-tooling"` that runs `node scripts/daily-release-decide.test.mjs && node scripts/release.test.mjs && node scripts/check-publish-manifests.test.mjs && node scripts/harness-pins.test.mjs && node scripts/check-channel-monotonic.test.mjs` (fixes F-14).
- Add `node scripts/harness-pins.mjs check` to the static steps and to `.husky/pre-commit`, as a root script `check:harness-pins`.

### 9.3 Required vs. informational legs, promotion, and demotion

- A leg is required iff its channel is in `required` **and** the ruleset lists its check. PR-2 is followed by the ruleset change that requires `presubmit (latest)` (§7.7).
- **Promotion of `next` to required** (§12.8) happens when all of these hold:
  - (1) `presubmit (next)` passed on the last 5 consecutive `push` runs on `main` (cancelled runs don't count);
  - (2) no open `harness-bump/main` PR changes `channels.next`;
  - (3) no PR labelled `harness-split` is open.
- **Demotion** (the escape hatch): if the `next` pin moves and the `harness-bump/main` PR stays red on `next` for 5 business days, and the fix would not break `latest`, the release owner MAY demote. Run `set-required latest`, then the ruleset change. This is the only alternative to a split. If the fix *would* break `latest`, it is T2 (§7.6.1).
- **Decision timebox:** if the `next` leg has been red on `main` for 10 business days, the release owner MUST record a decision (fix, demote, or split) in the `harness-bump/main` PR.

### 9.4 Why the matrix is sufficient

The published bytes do not depend on the pin (F-11). The two legs differ only in what they verify: typecheck against, and tests run on, the harness at each pin. So a single build can be published after being verified at several pins.

### 9.5 `publish.yml` (PR-4)

Jobs, in order:

1. **`plan`**:
   - Check out the tag (`fetch-depth: 0`) and `git fetch origin main 'refs/heads/release/*:refs/remotes/origin/release/*'`.
   - Ancestry gate, replacing `publish.yml:67`. With `V=${TAG#v}` and `MM=$(echo "$V" | cut -d. -f1,2)`: the tag is OK if `git merge-base --is-ancestor "$TAG^{commit}" origin/main`. Otherwise, if V is stable, `origin/release/$MM.x` exists, and the tag is its ancestor, it is OK. Anything else fails.
   - `node scripts/check-release-version.mjs "$TAG"`.
   - `node scripts/harness-pins.mjs validate`.
   - `node scripts/harness-pins.mjs publish-plan --tag "$TAG" >> "$GITHUB_OUTPUT"`.
   - `node scripts/check-channel-monotonic.mjs "$TAG"`.
2. **`verify-others-required`** (only if `others_required != '[]'`): a matrix over it. Static checks plus `harness-setup` (restore-only) plus `dsh-cc-gates`.
3. **`verify-others-informational`** (only if `others_informational != '[]'`): the same as 2. Nothing depends on its success.
4. **`publish`**:
   - `needs: [plan, verify-others-required, verify-others-informational]`.
   - `if: always() && needs.plan.result == 'success' && (needs.verify-others-required.result == 'success' || needs.verify-others-required.result == 'skipped')`.
   - `environment: npm-publish`.
   - Runs today's full step list with `harness-setup` at `build_channel`.
   - Then `node scripts/publish-packages.mjs --tag "$DIST_TAG" --no-git-checks`, plus `--advance next` when `advance_next == 'true'`.
   - Then the GitHub Release (§9.6).

`publish-plan` rules (C = `next` for a prerelease tag, `latest` for a stable tag):

| Output | Rule |
|---|---|
| gate | exit 1 unless C ∈ `serves` (for example, a stable tag on `main` in split mode, or an rc on a maintenance branch) |
| `dist_tag` | C |
| `build_channel` | C if C ∈ `required`, else `latest` (the pre-promotion case, where rc's build against `latest`) |
| `others_required` | `required` − {`build_channel`} |
| `others_informational` | `serves` − `required` |
| `advance_next` | `true` iff C = `latest` and `next` ∈ `serves` |

`scripts/publish-packages.mjs` changes (PR-4):
- `--advance next`: after the publish loop, for every publishable package, if `npm view <name> dist-tags.next` is absent or lower than the version, run `npm dist-tag add <name>@<version> next`.
- Rerun re-tagging: in the "already on registry" branch (`publish-packages.mjs:94-98`), if `dist-tags[<tag>]` is absent or lower than the version, run `npm dist-tag add <name>@<version> <tag>`. Today a rerun never re-attaches tags, despite `docs/release.md:79`.

### 9.6 GitHub Release notes

`gh release create "$TAG" … --generate-notes --notes "<block>"` (`--notes` is prepended to the generated notes). The block has one line per served channel:

```
Verified against @deepseek-ai/dsh (deepseek-ai/deepseek-harness):
- latest 0.1.5-rc.3 @ a4c74a9 — required: success (build channel)
- next 0.1.7-rc.2 @ 477b4f4 — informational: failure
```

The result for each leg comes from `needs.<job>.result`.

### 9.7 `release-tag.yml` (PR-4)

- `on.pull_request.branches: [main, 'release/*.x']`.
- The dispatch at `:146` becomes `gh workflow run publish.yml --ref "$BASE_REF" -f tag="$TAG"`. `BASE_REF` is `github.event.pull_request.base.ref` on the PR path, or a new dispatch input `base` (default `main`) on the manual path. Publish then runs the workflow definition from the tag's own branch.
- The `npm-publish` environment deployment policy (PR-0) MUST allow branches `main` and `release/*.x`, and tags `v*`.

## 10. Peer range and runtime gate

### 10.1 Generation rule

Let L = `channels.latest.version` and N = `channels.next.version`. The rule is computed over `required` only, so peers never claim an unverified pairing:

| `required` | Peer range for every `@deepseek-ai/dsh-*` key | `MIN_DSH_VERSION` | `DSH_CHANNEL` |
|---|---|---|---|
| `["latest"]` | `>=L` | L | `latest` |
| `["next"]` (split `main`) | `>=N` | N | `next` |
| `["latest","next"]`, same `X.Y.Z` in L and N | `>=L` | L | `latest` |
| `["latest","next"]`, different `X.Y.Z` | `>=L \|\| >=N` | L | `latest` |

This rule deliberately differs from `>=L || ^<next line>-rc.0`:
- it keeps the open-ended `>=` shape used today;
- its floor is the verified pin, not `rc.0`;
- the checker then only needs to support one comparator shape joined by ` || ` (§10.5).

Truth table for today's values, L = 0.1.5-rc.3 and N = 0.1.7-rc.2 (node-semver 7.8.5; full table in Appendix A):

| host dsh | `>=0.1.5-rc.1` (today) | `>=0.1.5-rc.3 \|\| >=0.1.7-rc.2` |
|---|---|---|
| 0.1.5-rc.1 | Y | n |
| 0.1.5-rc.3 | Y | **Y** |
| 0.1.6-alpha.2 | n | n |
| 0.1.7-rc.1 | n | n |
| 0.1.7-rc.2 | **n** | **Y** |
| 0.1.7-rc.3 | n | Y |
| 0.1.7 | Y | Y |
| 0.1.8-rc.1 | n | n |

### 10.2 Semver pitfalls this rule avoids

- node-semver admits a prerelease only if some comparator shares its `X.Y.Z` tuple. `>=0.1.5-rc.1` therefore admits 0.1.7 but not 0.1.7-rc.2.
- `^0.1.5-rc.3` admits 0.1.7 and not 0.1.7-rc.2. On 0.x a caret also caps at the next minor (`<0.2.0-0`).
- `~0.1.7-rc.2` admits 0.1.7-rc.3 and 0.1.7, but not 0.1.8-rc.1.
- Any next-line rc beyond the pinned line (for example 0.1.8-rc.1) is rejected by design. The watcher moves the pin, and the regenerated range follows.

### 10.3 Files `harness-pins.mjs sync` rewrites

Exactly these files. Anything else is out of scope:

1. For every non-private `packages/<group>/<pkg>/package.json`, every `peerDependencies` key matching `^@deepseek-ai/dsh-` whose value does not start with `link:` → `peerRange(pins)`. Keys `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are left untouched. `check` fails if any non-private package has a `dependencies` entry matching `^@deepseek-ai/dsh-`, with the message "harness packages are peers; see §10.3".
2. `packages/launcher/tui/bootstrap.mjs`:
   - `export const MIN_DSH_VERSION = '<minVersion>'` (currently `:527`);
   - a new `export const DSH_CHANNEL = '<channelHint>'`.
   Each regex must match exactly once, or sync fails.
3. `pnpm-workspace.yaml` `minimumReleaseAgeExclude` (`:29-31`): every entry `@deepseek-ai/<name>@<version>` is replaced by one entry per version in `serves`, sorted.

After a sync, the author MUST run `pnpm install --frozen-lockfile`. It is expected to pass: lockfile importers record `dependencies` and `devDependencies` specifiers, not peers. If it fails, run `pnpm install` and commit `pnpm-lock.yaml` in the same PR (the `.husky/pre-commit` lockfile guard enforces this locally).

### 10.4 Launcher gate (PR-1 wiring, values move with every pin PR)

- `MIN_DSH_VERSION` is generated (above). Bootstrap-only checking is unchanged (`bootstrap.mjs:518-524`), and so is the hand-rolled ordering (F-8). It remains a floor, not a compatibility check.
- The messages use the channel:
  - `dshUnavailableMessage()` (`:116-119`) says `npm install -g @deepseek-ai/dsh`, followed by `@next` when `DSH_CHANNEL === 'next'`;
  - `belowMinimumMessage()` (`:600-603`) says `npm install -g @deepseek-ai/dsh@${DSH_CHANNEL}`.
- `packages/launcher/tui/tests/version-gate.spec.ts`:
  - replace the literal at `:48` with `expect(MIN_DSH_VERSION).toBe(minVersion(pins))`, where `pins` is read with `readFileSync('.github/harness-pins.json')` and `minVersion` is imported from `scripts/harness-pins.mjs`;
  - failing table `['0.0.1', '0.1.1-rc.2', '0.1.2']` (all permanently below any future floor);
  - passing table `[MIN_DSH_VERSION, '99.0.0']`;
  - the message test at `:64-69` asserts `MIN_DSH_VERSION` and `@deepseek-ai/dsh@${DSH_CHANNEL}`.
- `packages/launcher/tui/tests/bootstrap.spec.ts:171,197` update to the channel-aware unavailable message.

### 10.5 `check-publish-manifests.mjs` (PR-1)

- `rangeSatisfiedBy` splits the range on the exact separator ` || `. Each part MUST be one of the existing shapes (`>=`, `^`, bare). The range is satisfied if any part is. Any other whitespace still throws (`:113-118`).
- New check: every `@deepseek-ai/dsh-*` peer MUST equal `peerRange(pins)` exactly.
- The existing sibling-version check (`:296-319`) stays, but it becomes channel-aware. `dsh-cc-gates` exports `HARNESS_CHANNEL=<leg channel>`. When that channel is in `required`, a sibling-version mismatch is an error, as today. When it is informational, the mismatch is printed as a `::warning::` and the rest of the leg still runs, so an informational leg reports real typecheck and test results instead of stopping at the manifest check. Without `HARNESS_CHANNEL` (local runs), the check behaves as for a required channel.
- Tests in `scripts/check-publish-manifests.test.mjs` cover every row of Appendix A for `>=0.1.5-rc.3 || >=0.1.7-rc.2`.

### 10.6 `/doctor` pairing warning (PR-10, optional)

- `env.harness` (`command-doctor/src/checks/env.ts:34-49`) becomes `warn` when the host harness version does not satisfy the package's own `@deepseek-ai/dsh-commands` peer range.
- Evaluate it with a copy of the `||`-aware `rangeSatisfiedBy` in `packages/interaction/command-doctor/src/harness-range.ts`, whose spec reproduces Appendix A.
- Fix text: "install matching channels: `npm i -g @deepseek-ai/dsh @dsh-cc/cli` or both `@next`".
- It stays `skip` when the `harnessVersion` seam is not mounted.

## 11. Automation: `harness-watch.yml` (PR-7)

### 11.1 Workflow

```yaml
name: Harness Watch (propose)
on:
  schedule: [{ cron: "17 */4 * * *" }]      # every 4 h, off the hour
  workflow_dispatch:
    inputs:
      dry_run: { description: "Plan only; no push/PR", type: boolean, default: true }
permissions:
  contents: write        # push harness-bump/* branches
  pull-requests: write   # gh pr create / edit
  actions: write         # gh workflow run presubmit.yml (G5)
concurrency: { group: harness-watch, cancel-in-progress: false }
env:
  DRY_RUN: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run == true }}
  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
jobs:
  propose:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
        with: { ref: main, fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
      - run: node scripts/harness-watch.mjs plan > plan.json && cat plan.json >> "$GITHUB_STEP_SUMMARY"
      - run: node scripts/harness-watch.mjs apply plan.json
```

The workflow opens and updates PRs only. It MUST NOT merge, tag, publish, change dist-tags, or close PRs.

### 11.2 `plan` algorithm (`scripts/harness-watch.mjs plan`)

1. `U = npm view @deepseek-ai/dsh dist-tags --json`. `Ul = U.latest`. `En = max(U.latest, U.next)`.
2. Targets: `main`, plus the in-service maintenance branch, if any (§7.6.6).
3. For each target, read `.github/harness-pins.json` with `git show origin/<base>:.github/harness-pins.json` and compute the desired changes:
   - `main` serving `latest` → desired `latest = Ul`. `main` serving `next` → desired `next = En`.
   - `main` in split mode, when `X.Y.Z(Ul) ≥ X.Y.Z(main.next.version)` → **reunification**: `set-serves latest,next`, `latest = Ul`, `next = En`. `required` becomes `["latest"]`, plus `next` if it was required before.
   - Maintenance branch → desired `latest = Ul` iff `X.Y.Z(Ul) ≤ X.Y.Z(branch.latest.version)`. Otherwise no change: `main` handles the new line.
4. Resolve each desired version to a SHA (§8.3). If the tag is missing, emit an `::error::` and skip that target. The job fails red and retries on the next schedule.
5. Output JSON: `[{ base, head: "harness-bump/<base-slug>", ops: [...], title }]`. The title is `chore(harness): track dsh latest <L>, next <N>` (omit a channel the target does not serve; prefix `reunify: ` for reunification).

### 11.3 `apply` algorithm (idempotent)

For each planned target:

1. `git fetch origin <base> harness-bump/<slug>` (ignore a missing head branch).
2. If `origin/harness-bump/<slug>` exists and `git log origin/<base>..origin/harness-bump/<slug> --format=%ae` contains any address other than the bot's → write "human commits present; not updating" to the summary and skip.
3. `git worktree add -B harness-bump/<slug> ../wt-<slug> origin/<base>` (a separate worktree, so the running script's own checkout of `main` is never switched). Inside that worktree, run the ops (`harness-pins.mjs bump|set-serves|set-required`), then `harness-pins.mjs sync`, then `git commit -am "<title>"`. Steps 4–6 run inside that worktree; remove it with `git worktree remove --force ../wt-<slug>` when the target is done.
4. If `origin/harness-bump/<slug>` already has an identical tree (`git diff --quiet HEAD origin/harness-bump/<slug>`) → skip (no-op).
5. If `DRY_RUN=true` → print `git show --stat HEAD` and stop.
6. `git push -f origin HEAD:refs/heads/harness-bump/<slug>`.
7. `gh pr list --head harness-bump/<slug> --base <base> --state open --json number --jq '.[0].number'`. If a PR is open, `gh pr edit <n> --title "<title>" --body "<body>"`. Otherwise `gh pr create --base <base> --head harness-bump/<slug> --title "<title>" --body "<body>"`.
8. `gh workflow run presubmit.yml --ref harness-bump/<slug>`.

If a target needs no change but an open `harness-bump/<slug>` PR exists (upstream moved and then moved back), the watcher writes a warning to the summary. A human closes that PR.

The PR body lists the upstream dist-tags, the old and new pin for each channel with tag and SHA, a link to `https://github.com/<source>/compare/<old-sha>...<new-sha>`, and the review checklist: legs green, release notes of upstream read, adaptation commits (if any) retitle the PR to `fix(harness)`/`feat(harness)`.

## 12. Runbooks

### 12.1 R1 — Routine rc to `next` (trunk mode)

1. Automatic: at 08:00 SGT on weekdays, `daily-release.yml` opens `release/vX.Y.Z-rc.N` and dispatches `presubmit.yml` on it.
2. **Human (reviewer):** wait for the required `presubmit (…)` checks, then merge (squash or rebase).
3. Automatic: `release-tag.yml` tags the merge commit and dispatches `publish.yml --ref main`.
4. **Human (release owner):** approve the `npm-publish` deployment.
5. Verify: `npm view @dsh-cc/cli dist-tags` shows `next = X.Y.Z-rc.N`, and the GitHub Release lists the verified pins.

### 12.2 R2 — Promote rc to stable on `latest` (trunk mode)

1. Automatic: when the latest rc has no commits after it, the ladder proposes `release/vX.Y.Z` (V-7).
2. **Human:** merge after the required checks pass.
3. **Human (release owner):** approve `npm-publish`.
4. Verify: `latest = X.Y.Z`, and `next` is ≥ X.Y.Z (R-5, `--advance next`).

To run the ladder now instead of waiting for the schedule: `gh workflow run daily-release.yml -f bump=auto -f dry_run=false`. It proposes a stable only when the ladder would (V-7 through V-9); it never forces one.

### 12.3 R3 — Hotfix on `latest` while `main` is ahead

- **H1 (from `main`; use it when no T1 condition holds):**
  1. Land the fix on `main` via a normal `fix:` PR.
  2. Run `gh workflow run daily-release.yml -f dry_run=false` to get an rc, then follow R1.
  3. On the next weekday run (no commits after the rc), follow R2.
- **H2 (maintenance; T1 holds and the §7.6.1 precondition is met):**
  1. Cut or reuse `release/X.Y.x` (§7.6.2).
  2. Backport the fix (§7.6.5) and merge it.
  3. Release, as the release owner or a delegate:

     ```sh
     git fetch origin --tags
     git switch -C release/X.Y.x origin/release/X.Y.x
     pnpm release X.Y.P                      # V-10; release.mjs checks branch, HEAD==origin/release/X.Y.x, monotonicity
     git tag -d vX.Y.P                       # release-tag.yml creates the real tag after merge
     git push origin HEAD:refs/heads/release/vX.Y.P
     gh pr create --base release/X.Y.x --head release/vX.Y.P --title "chore(release): vX.Y.P" --body "Maintenance patch release."
     ```

  4. **Human:** merge after `presubmit (latest)` passes. Then `release-tag.yml` → `publish.yml --ref release/X.Y.x`.
  5. **Release owner:** approve `npm-publish`.
  6. Verify that `latest = X.Y.P` and that `next` is unchanged.

### 12.4 R4 — Upstream dsh dist-tag moved

1. Automatic: within 4 h, `harness-watch.yml` opens or updates `harness-bump/main` (and `harness-bump/release-X.Y-x` when §11.2 applies), with presubmit dispatched.
2. If all required legs are green: **a human merges.** The next release on each channel then carries the new pairing.
3. If a leg is red: adapt on the bot branch. Human commits freeze the branch against force-pushes. Then:
   - (a) the adaptation keeps both legs green → merge;
   - (b) only `next` is red and the fix would not break `latest` → keep working, or demote (§9.3);
   - (c) the fix breaks `latest` → apply `harness-split` and follow R5.
4. Upstream `latest` moved onto the line `main` already serves as `next` while in split mode → the PR is a reunification. Follow R6.

### 12.5 R5 — Harness split (T2)

- **S1.** If `main` has commits after the last stable and `presubmit (latest)` is green on `main`: publish a stable from `main` first (R2, dispatched now). The adaptation PR stays unmerged until S4.
- **S2.** The release owner creates `release/X.Y.x` from that stable (§7.6.2) and merges its serve-latest PR.
- **S3.** Immediately before merging S4 (so `main` is never blocked by an unadapted `next` leg for long), the release owner edits the `main` ruleset: replace the required check `presubmit (latest)` with `presubmit (next)` (§7.7).
- **S4.** On the adaptation PR, run `node scripts/harness-pins.mjs set-serves next && node scripts/harness-pins.mjs sync` and commit. This gives peers `>=N` and `MIN_DSH_VERSION = N`. Merge once `presubmit (next)` passes.
- **S5.** From now on the ladder keeps `main` on rc's of line ≥ `X.(Y+1).0` (§6.2 `maintFloor`, V-8). `latest` patches come from `release/X.Y.x` (R3 H2).

### 12.6 R6 — Reunification and retirement

1. `harness-watch.yml` opens a reunification PR on `main` (§11.2). Wait until both legs pass on it.
2. **Release owner**, immediately before the merge: set the `main` required checks to `presubmit (latest)`, plus `presubmit (next)` if the PR keeps `next` in `required` (§7.7).
3. **Human** merges the PR.
4. The next stable from `main` (R2) takes `latest`. Its version is greater than every maintenance version, because of `maintFloor`.
5. **Release owner:** retire `release/X.Y.x` (§7.6.6).

### 12.7 R7 — Bad publish / rollback

1. **Release owner decides.** Never unpublish: bundles are pinned by exact version (F-7), and npm restricts unpublish.
2. Repoint the channel to the previous good version P:

   ```sh
   gh workflow run npm-channel-admin.yml -f action=repoint -f channel=<latest|next> -f version=P -f dry_run=false
   ```

   The workflow (PR-5) uses the `npm-publish` environment, which needs **release owner approval**. It runs `node scripts/npm-channel-admin.mjs repoint --channel C --version P --allow-downgrade`. That command enumerates the non-private packages at tag `vP` and runs `npm dist-tag add <name>@P C` for each. Run it with `dry_run=true` first; that prints the commands without executing them.
3. Deprecate the bad version B:

   ```sh
   gh workflow run npm-channel-admin.yml -f action=deprecate -f version=B -f message="<reason>; use P" -f dry_run=false
   ```

   This runs `npm deprecate <name>@B "<message>"` for every package at tag `vB`. It needs the same approval.
4. Fix forward: the next release on channel C MUST be > B (tag uniqueness plus Invariant M against B's tag).
5. Users who already installed B run `npm i -g @dsh-cc/cli@<C>`. The launcher's heal path reinstalls the bundles at its own version on a version change (`bootstrap.mjs:857-861`).

### 12.8 R8 — Promote `next` to required (and demote)

1. Criteria: §9.3.
2. Open a PR with `node scripts/harness-pins.mjs set-required latest,next && node scripts/harness-pins.mjs sync` (the peers gain `|| >=N`). **Human** merges.
3. **Release owner:** add `presubmit (next)` to the `main` required checks.

Demotion is the reverse: `set-required latest`, then remove the check.

### 12.9 Human gates

| Gate | Who | Where |
|---|---|---|
| Merge any PR into `main` or `release/X.Y.x` (release, harness-bump, backport, pins changes) | reviewer with write access | GitHub PR |
| Approve every publish | release owner | `npm-publish` environment |
| Any dist-tag change outside a normal publish (repoint, deprecate) | release owner | `npm-channel-admin.yml` via `npm-publish` |
| Create a maintenance branch, apply `harness-split`, retire a branch | release owner | git / labels / rulesets |
| Change required checks (promotion, demotion, split, reunification) | release owner (admin) | ruleset 22367074 and the new rulesets |
| Configure `npm-publish` reviewers and deployment policy | release owner (admin) | repository settings (PR-0) |

## 13. Implementation plan

Each PR updates `docs/release.md` for the behavior it changes.

| PR | Scope | Files | Acceptance criteria | Depends on |
|---|---|---|---|---|
| **PR-0** (settings, no code) | Close G6 for publishing. Add the `harness-split` label | `npm-publish`: required reviewer = release owner; deployment policy = branches `main`, `release/*.x` and tags `v*`. `gh label create harness-split` | `gh api repos/dsh-cc/dsh-cc/environments` shows a `required_reviewers` rule; a dry dispatch waits for approval | — |
| **PR-1** | Pins as the source of truth, with no behavior change | new `.github/harness-pins.json` (§8.2, first block), `scripts/harness-pins.mjs`, `scripts/harness-pins.test.mjs`; `scripts/check-publish-manifests.mjs` (+test) `\|\|` support and exact-range check; `presubmit.yml`/`publish.yml` read the pin via `harness-pins.mjs get latest sha` from `deepseek-ai/deepseek-harness`; `bootstrap.mjs` gains `DSH_CHANNEL` and channel-aware messages; `version-gate.spec.ts`, `bootstrap.spec.ts`; `package.json` adds `check:harness-pins`; `.husky/pre-commit` runs it | `harness-pins.mjs check` passes; `sync` produces no diff (peers stay `>=0.1.5-rc.1`); presubmit green at the new source/SHA | — |
| **PR-2** | Matrix CI | `.github/actions/harness-setup/action.yml`, `.github/actions/dsh-cc-gates/action.yml`, `presubmit.yml` (§9.2), `package.json` `test:release-tooling` | The PR shows a `presubmit (latest)` check; `gh workflow run presubmit.yml --ref <branch>` attaches the check to that branch's PR (verify on this PR); release-tooling tests run. **Afterwards (release owner):** add `presubmit (latest)` as a required check | PR-1 |
| **PR-3** | Monotonic versions and bot CI | `scripts/daily-release-decide.mjs` (+test: #144 scenario → `0.8.1-rc.2`; a maintenance-branch floor; split no-stabilize; monotonic throw), new `scripts/check-channel-monotonic.mjs` (+test), `scripts/release.mjs` (+test: `main` or `release/X.Y.x`, HEAD==origin/<branch>, V-10, served-channel check, monotonic), `daily-release.yml` (`actions: write`, dispatch presubmit on the release branch, monotonic check before `gh pr create`) | All tests pass; a `daily-release` dry run on `main` prints `version=0.8.1-rc.2` (or the next rc at that time) | PR-2 |
| **PR-4** | Channel-aware publish | `publish.yml` (§9.5), `release-tag.yml` (§9.7), `scripts/publish-packages.mjs` (`--advance next`, rerun re-tag) | A `workflow_dispatch` of `release-tag.yml` with `dry_run=true` passes for a stable and an rc; unit tests for `publish-plan` cover every row of §9.5; the next real rc's Release shows the verified-against block | PR-3 |
| **PR-5** | Rollback tooling | `.github/workflows/npm-channel-admin.yml` (inputs `action`, `channel`, `version`, `message`, `dry_run`; environment `npm-publish`; the same token auth as publish, `publish.yml:191-200`, `:228-230`), `scripts/npm-channel-admin.mjs` (+test with a stubbed `npm`) | A dry run lists 85 `npm dist-tag add` commands for `version=0.8.1-rc.1 channel=next` | PR-4 |
| **PR-6** | First real pin move: `latest` → 0.1.5-rc.3 | `harness-pins.mjs bump --channel latest --version 0.1.5-rc.3` + `sync` (77 manifests, `bootstrap.mjs`, `pnpm-workspace.yaml`); `README.md`/`README.zh.md` lines 21–31 rewritten to the channel-pair wording of §5.2 with no version numbers ("verified dsh versions are listed in each GitHub Release") | `presubmit (latest)` green at `a4c74a9`; `check` clean | PR-2 |
| **PR-7** | Watcher | `.github/workflows/harness-watch.yml`, `scripts/harness-watch.mjs` (+test with injected dist-tags and git/gh stubs), `.github/retired-branches.txt` (empty) | A dispatch with `dry_run=true` prints a plan; a real run against a pins file edited to be stale opens exactly one PR, and a second run is a no-op | PR-2, PR-6 |
| **PR-8** | Add `next` as informational | `set-serves latest,next`, `bump --channel next --version 0.1.7-rc.2`, `sync` (peers unchanged, because `required` is still `["latest"]`) | Both legs run; `presubmit (next)` is expected **red** (G8) and is not required | PR-2, PR-4 |
| **PR-9** | Adapt to dsh next | engineering: handle the three removed harness packages (G8) | Outcome A: one commit green on both legs → R8 promotion. Outcome B: not possible → `harness-split` label → R5 (first maintenance branch `release/0.8.x` cut from the stable produced in S1) | PR-8 |
| **PR-10** (optional) | `/doctor` pairing warning | `command-doctor` `src/harness-range.ts`, `src/checks/env.ts`, specs | The spec reproduces Appendix A; `warn` on a mixed pair | PR-1 |

**Immediate recommendation (not performed by this PR):** close PR #144 without merging. Merged and published, it would move `@dsh-cc/*@next` from 0.8.1-rc.1 down to 0.8.0-rc.4 (G3). Until PR-3 lands, produce any needed rc by hand with a matching branch name: `pnpm release 0.8.1-rc.2` on `main`, then push `release/v0.8.1-rc.2`, as in `docs/release.md:42-62`. Do not re-version a bot branch (G7).

## 14. Risks

| Risk | Mitigation |
|---|---|
| Upstream deletes a tag or rewrites history | Pins are full SHAs, and `verify-remote` detects tag drift. Fallback to the fork (§8.1). |
| An upstream tooling change (pnpm version, build scripts, `lib/` layout) breaks one leg for infrastructure reasons | Treated like any red leg (R4). The composite action is the single place to fix it. |
| CI cost roughly doubles, and a cold build happens whenever a pin moves | Per-SHA caches. Informational legs never block. |
| A red informational leg adds noise to every PR | Intended visibility. The demotion and split timebox (§9.3) bounds how long it lasts. |
| `workflow_dispatch`-attached checks might not satisfy required checks on bot PRs | Verified explicitly in PR-2 and PR-3. If they don't, add a GitHub App token secret for the bot pushes; the workflows change only in the token. |
| Split mode lasts indefinitely if upstream never promotes `next` | The watcher raises reunification automatically. Maintenance branches accept only fixes and pin bumps (§7.6.3). |
| Three hand-rolled semver comparators (`check-publish-manifests.mjs`, `bootstrap.mjs`, `daily-release-decide.mjs`) drift apart | Appendix A is the shared truth table for all of them. The launcher's ordering is documented as a floor only (F-8). |
| After 1.0, `workspace:^` publishes `^1.y.z`, which would span maintenance lines | Out of scope while 0.x. Revisit before 1.0 (switch internal deps to `workspace:*`). |
| Peers are advisory | Stated as a non-goal. The guarantees come from pins, legs, and the launcher floor. |

## 15. Open questions

- **Q1.** Release owner identity. This plan assumes the GitHub user `jianxx` is the `npm-publish` reviewer and has admin rights for rulesets. Confirm, or name the person.
- **Q2.** The transition policy. Until PR-9 resolves, rc's continue to publish to `next` built against `latest`, with the `next` leg informational and disclosed in the Release notes (§9.5 `build_channel`). The alternative is to block rc publishing until dsh-cc passes on dsh next. This plan chooses to continue publishing. Confirm.
- **Q3.** Whether a `workflow_dispatch` run of `presubmit.yml` on a bot branch satisfies the required status check on that branch's PR. This is expected but unverified. It is resolved during PR-2 (§14 fallback).

---

## Appendix A — node-semver truth tables (semver 7.8.5, default options)

L = 0.1.5-rc.3, N = 0.1.7-rc.2. Y = satisfies.

| host version | `>=0.1.5-rc.1` | `>=0.1.5-rc.3 \|\| >=0.1.7-rc.2` | `>=0.1.5-rc.3` | `>=0.1.7-rc.2` | `^0.1.5-rc.3` | `^0.1.7-rc.0` |
|---|---|---|---|---|---|---|
| 0.1.5-rc.1 | Y | n | n | n | n | n |
| 0.1.5-rc.2 | Y | n | n | n | n | n |
| 0.1.5-rc.3 | Y | Y | Y | n | Y | n |
| 0.1.5-rc.4 | Y | Y | Y | n | Y | n |
| 0.1.5 | Y | Y | Y | n | Y | n |
| 0.1.6-alpha.2 | n | n | n | n | n | n |
| 0.1.6 | Y | Y | Y | n | Y | n |
| 0.1.7-alpha.2 | n | n | n | n | n | n |
| 0.1.7-rc.1 | n | n | n | n | n | Y |
| 0.1.7-rc.2 | n | Y | n | Y | n | Y |
| 0.1.7-rc.3 | n | Y | n | Y | n | Y |
| 0.1.7 | Y | Y | Y | Y | Y | Y |
| 0.1.8-rc.1 | n | n | n | n | n | n |
| 0.1.8 | Y | Y | Y | Y | Y | Y |
| 0.2.0-rc.1 | n | n | n | n | n | n |
| 0.2.0 | Y | Y | Y | Y | n | n |

Reproduce:

```sh
npm i --prefix /tmp/semv semver@7
node -e 'const s=require("/tmp/semv/node_modules/semver"); console.log(s.satisfies("0.1.7-rc.2", ">=0.1.5-rc.3 || >=0.1.7-rc.2"))'
```

## Appendix B — Upstream and dsh-cc snapshot (2026-09-25 20:09 SGT)

`npm view <pkg> dist-tags`:

| Package | latest | next | alpha |
|---|---|---|---|
| `@deepseek-ai/dsh` | 0.1.5-rc.3 | 0.1.7-rc.2 | 0.1.7-alpha.2 |
| `@dsh-cc/cli` (all `@dsh-cc/*` checked are identical) | 0.7.1 | 0.8.1-rc.1 | — |

`git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git 'dsh-v0.1.*'` (lightweight tags; each points at the release PR merge commit, and the root `package.json` version at that SHA equals the tag version):

| Tag | Commit | npm publish time (SGT) |
|---|---|---|
| `dsh-v0.1.5-rc.1` | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` (tree-identical to today's CI pin `1ef9c1fa9afbea78c5537bfc8b6d1c27d598798e`) | 2026-09-10 11:12 |
| `dsh-v0.1.5-rc.2` | `fb2c4b9e698e30edb738bca4cf0618587db7d203` | 2026-09-10 22:57 |
| `dsh-v0.1.5-rc.3` (**latest**) | `a4c74a91e06b00fe0b0937bde982170c526cc842` | 2026-09-22 13:55 |
| `dsh-v0.1.6-alpha.2` | `ddefc45fbc7f8e46dd73185e68295696d1297887` (= fork `master`) | 2026-09-17 21:52 |
| `dsh-v0.1.7-alpha.2` (alpha) | `00102833dfaee1da9f48a3a8eae9d34005a75218` | 2026-09-23 00:08 |
| `dsh-v0.1.7-rc.1` | `46a7f68b0922371ce7144b668b90e377d8e799f4` | 2026-09-23 21:44 |
| `dsh-v0.1.7-rc.2` (**next**) | `477b4f420553e8a52c2fbccc464d7561b239c443` | 2026-09-24 22:18 |

dsh-cc publish times (SGT): 0.7.1 at 2026-09-14 16:31; 0.8.1-rc.1 at 2026-09-24 14:19.

## Appendix C — Evidence commands

```sh
npm view @deepseek-ai/dsh dist-tags --json
npm view @dsh-cc/cli dist-tags --json
npm view @dsh-cc/bundle-shell@0.8.1-rc.1 peerDependencies --json
git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git 'dsh-v0.1.*'
git ls-remote https://github.com/dsh-cc/deepseek-harness.git
gh api repos/deepseek-ai/deepseek-harness/compare/1ef9c1fa9afbea78c5537bfc8b6d1c27d598798e...183f08e9c6dde7e36cd2318eaee70b0da08fb35e --jq '{ahead_by, files: (.files | length)}'
gh api "repos/deepseek-ai/deepseek-harness/git/trees/477b4f420553e8a52c2fbccc464d7561b239c443?recursive=1" --jq '.tree[].path' | grep -Ex 'packages/(code-runtime/code-runtime|preset/agent-presets|workflow/workflow-worker-thread)/package.json'   # empty at 477b4f4, 3 lines at a4c74a9 (G8)
gh api repos/dsh-cc/dsh-cc/rules/branches/main
gh api repos/dsh-cc/dsh-cc/environments --jq '.environments[] | {name, protection_rules}'
gh pr checks 144 -R dsh-cc/dsh-cc          # "no checks reported" (G5)
gh run list -R dsh-cc/dsh-cc --workflow release-tag.yml -L 40   # 2026-09-24 06:06 UTC failure (G7)
```
