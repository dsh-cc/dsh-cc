# Package README trio completion + docs gate

Status: approved (critic cold-review, 3 major findings incorporated)
Date: 2026-09-10

## Goal

Every workspace package carries the bilingual doc trio — `README.md` +
`README.zh.md` + `README.i18n.yaml` — and a repo gate (`pnpm check:readme`)
enforces presence and en/zh pairing freshness in both presubmit CI and the
local pre-commit hook.

## Findings (verified 2026-09-10, this worktree)

- 65 workspace packages (`pnpm-workspace.yaml` glob `packages/*/*`).
- 36 packages already have a tracked `README.i18n.yaml` carried over from
  the pre-migration repo (critic-verified against `git hash-object`:
  records are stale — at minimum 33/36 en hashes mismatch, most zh too).
  They were never validated locally because the tooling was never ported.
  W4 re-pins all 36 in place; the PR body discloses this rewrite.
  (My initial inventory searched only for the `.yml` spelling and missed
  them; the real record extension is `.yaml`.)
- 11 packages have no README at all: `bundle/cc-permissions`,
  `compaction/compaction-basic-cc`, `core/tool-append-order`,
  `interaction/command-compact`, `interaction/command-config`,
  `interaction/command-diff`, `interaction/command-init`,
  `interaction/command-permissions`, `interaction/command-release-notes`,
  `test-support/agent-loop-mock`, `test-support/cache-trajectory`.
- 8 packages have en-only README and need zh: `bundle/cc-tui`,
  `interaction/command-agents`, `launcher/tui`, `plugin/dsh-cc-agents`,
  `plugin/dsh-cc-shunt`, `subagent/resume-pins`, `ui/tui`,
  `workspace/session-cwd`.
- Known drift: `settings/settings-cascade/README.zh.md` misses the en
  README's camelCase-alias bullet (PR #4 leftover).
- The trio convention predates this PR: deleted
  `packages/web/fetch-http/README.i18n.yaml` (removed in #17) recorded git
  blob hashes of both sides "`pnpm run verify-translation-pairing --write`"
  style; the tooling and `docs/i18n/README.md` it referenced were never
  ported to this repo. This plan rebuilds the tooling.
- Wiring points: root `package.json` scripts (`check:*` family, e.g.
  `check:spec-deps`); `.github/workflows/presubmit.yml` static lane runs
  gates pre-install in order spec-deps → identity → publish → size →
  tui-boundary → deep-imports → vendor-purity; `.husky/pre-commit` mirrors
  the same static gates in the same order (header comment demands 1:1).
- `packages/ui/pi-tui` is a vendored upstream copy — never modified
  (check:vendor-purity precedent; #130 reverted a lapse).
- `git hash-object` is available in both husky pre-commit env (hook unsets
  GIT_* vars up front) and CI checkout.

## Decisions

1. **Record file name: `README.i18n.yaml`** (not `.yml`): the historical
   file and all docs/plans references use `.yaml`. Deviation from the
   original request phrasing is deliberate; `.yaml` is the established
   repo spelling.
2. **Gate semantics** — `scripts/check-readme.mjs` (pure static, node
   stdlib + `git hash-object` only, exits 1 with one diagnostic per
   violation):
   - presence: every `packages/*/*/` package dir has all three files;
   - record shape: `README.i18n.yaml` has exactly keys `README.md` and
     `README.zh.md`, values are 40-hex sha1;
   - freshness: recorded hash == `git hash-object` of current file
     (enforces zh/en pair movement together; re-record workflow below);
   - exemption: hard-coded map `EXEMPTIONS` whose values pin the exempted
     package's existing upstream README blob hash; sole entry
     `packages/ui/pi-tui` → pinned sha1 of its current `README.md`
     ("vendored upstream copy — modified upstream only; documented
     upstream"). Check mode also fails if a pinned exempted README.md
     drifts from its pin; `--write` never touches exempted packages.
     Every violation diagnostic prints the exact re-record command
     (`pnpm check:readme --write`).
3. **`--write` mode** (`pnpm check:readme --write`, no other args):
   validate-then-write, atomic: first validate ALL non-exempt packages,
   exit 1 without writing anything if any pair is incomplete; only when
   all pairs are complete does it write every `README.i18n.yaml`
   unconditionally (fresh bytes, LF endings). Used for bootstrap and for
   re-recording after editing either side. The generated header comment
   documents the convention and names THIS repo's real command
   (`pnpm check:readme --write`) — the historical header references an
   unported `verify-translation-pairing` command and is not reused.
4. **Self-test** `scripts/check-readme.test.mjs`: node:test fixtures under
   a tmp dir (mirrors `check-publish-manifests.test.mjs` idiom); covered
   cases: trio present pass, missing zh fail, missing record fail, stale
   hash fail, record with extra/missing key fails shape, exemption with
   matching hash passes + exemption with drifted hash fails, `--write`
   round-trip, `--write` atomicity (one incomplete pair → nothing
   written).
5. **Wiring** (landed in the LAST commit, after docs are complete — gate
   must be green the moment it exists because husky pre-commit runs all
   gates on every commit):
   - root `package.json`: `"check:readme": "node scripts/check-readme.mjs"`;
   - `presubmit.yml` static lane: step "Package README trio (check:readme)"
     after "Publishable manifest invariants", plus "Package README trio
     self-test" right after it (stdlib node:test, no install needed);
   - `publish.yml` static lane (same gate family lives there too —
     critic finding): step "Package README trio (check:readme)" after
     "Publishable manifest invariants (check:publish)";
   - `.husky/pre-commit`: `pnpm check:readme` in the static block after
     `pnpm check:publish`;
6. **`docs/i18n/README.md`** resurrected: states the trio convention, the
   re-record workflow (`pnpm check:readme --write`, commit record together
   with README edits), the exemption policy and its hash-pin mechanics,
   and the bootstrap semantics (record = last confirmed state; does not
   prove the two sides' content is semantically in sync; the 36 pre-existing
   records were all stale and are re-pinned by this PR). Documents two
   format constraints: records are sha1 git blob hashes (40-hex), and
   hashes hash working-tree bytes — a CRLF checkout would diverge from
   CI (repo has no `.gitattributes`; contributors on LF platforms only).
7. **No capability-manifest change**: docs and repo tooling do not alter the
   Claude-Code-compatible surface; `docs:parity` untouched.
8. **README authoring standard** (for new/translated files): mirror the
   exemplar pair `packages/interaction/command-usage/README.{md,zh.md}` —
   H1 package name, `English | [中文](README.zh.md)` switch line, short
   pitch paragraph, Usage/API/Limits sections as warranted; zh is a
   structural 1:1 mirror (same sections, translated headings) so the hash
   pairing stays meaningful. Ground content in the package's own
   `package.json` description and `src/` entry; do not invent API.

## Work items

- W1 (executor): `scripts/check-readme.mjs` + `scripts/check-readme.test.mjs`
  + `docs/i18n/README.md`, per Decisions 2–6. Verification: self-test green.
- W2 (executor): full en+zh pairs for the 11 README-less packages.
- W3 (executor): zh translations for the 8 en-only packages + the
  settings-cascade zh camelCase-alias bullet fix.
- W4 (orchestrator): `pnpm install --frozen-lockfile` (worktree lacks
  node_modules; husky hook requires it), then
  `node scripts/check-readme.mjs --write` to land all 64 records
  (36 re-pinned stale + 28 new); verify `git status` before staging.
- W5 (orchestrator): wiring edits (package.json / presubmit.yml /
  .husky/pre-commit) per Decision 5.
- W6 (orchestrator): full local gates via the real husky run at commit
  time; `pnpm check:readme` green; spot-read 3 generated READMEs.

## Commit plan (explicit-path `git add` only; never `-A`)

1. check-readme script + self-test + docs/i18n/README.md (gate code only,
   not wired).
2. W2's 11 README pairs.
3. W3's 8 zh translations + settings-cascade fix.
4. W4 bootstrap records + W5 wiring (gate goes live green).

## Verification

- `node scripts/check-readme.test.mjs` exit 0.
- `node scripts/check-readme.mjs` exit 0 at PR head; negative probe:
  delete one zh file → gate reports exactly that package.
- Husky pre-commit passes end-to-end on the final commit (full presubmit
  mirror incl. typecheck + vitest; known flakes: coverage-config 5s
  timeout under load — rerun; `check:exports` failures in a fresh
  worktree pre-date this change).
- CI presubmit green on the PR.

## Risks / notes

- Bootstrap re-pins all 36 pre-existing records (every one stale since the
  pre-migration import) and adds 28 new; the PR body discloses this
  rewrite. Semantic audit of the 45 existing pairs is out of scope
  (stated in PR body and docs/i18n/README.md); records prove pinning, not
  translation content. Known settings-cascade gap is fixed here.
- Husky gate hashes the working tree, not the index: forgetting to stage
  a re-recorded `README.i18n.yaml` passes locally and fails CI. Mitigated
  by diagnostics that print the exact command + post-commit `git status`
  verification in W4; PR-head presubmit is the backstop.
- Future README edits require `--write` re-record — that is the intended
  enforcement; merge conflicts in `README.i18n.yaml` are possible when two
  PRs touch the same pair (same class as check:parity generated files).
- Worktree ops: `pnpm install --frozen-lockfile` before first commit;
  commit messages via uniquely-named workspace scratch files, `head -1`
  verify + delete before staging.
