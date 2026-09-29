# Dev notes

## pnpm verification on network-restricted hosts

pnpm 11.7.0 verifies package integrity against registry attestations and
re-verifies the lockfile against supply-chain policies whenever its stat
(size/mtime/inode) changes. Crucially, pnpm fetches these per-package
attestations **even under `--offline`** — each one retrying ~10s against
registry.npmjs.org — so on a host where the registry is unreachable, any
install-resolution (`pnpm install`, `pnpm install --lockfile-only`) stalls
~10s per uncached package and is effectively unavailable here. Recovery: run
`pnpm install --frozen-lockfile` once on a host with registry access (or let
CI be the authority), then the resolved tree is usable here.

(An earlier revision of this note claimed a `lockfile-verified.jsonl` refresh
script "lives in the repo history" — it does not; nothing usable was ever
committed, and the cache records' hash field is not reconstructible from the
lockfile text. Do not hand-write cache entries.)

What to do instead when a branch adds packages or changes dependency
declarations:

- **Preferred**: run `pnpm install --lockfile-only` on a host with registry
  access, or let CI's `pnpm install --frozen-lockfile` be the authority.
- **On this host**: edit `pnpm-lock.yaml` textually, then verify with the
  invariants below (they are exactly what the frozen check reads).

### Lockfile invariants (what `pnpm install --frozen-lockfile` checks)

For every workspace `packages/<group>/<pkg>/package.json`:

- Every name in `dependencies` / `devDependencies` / `optionalDependencies`
  appears in the package's `importers:` entry with `specifier:` equal to the
  package.json text:
  `workspace:^` keeps that specifier and gets `version: link:<relative path>`;
  `link:` deps keep the same `link:` text for both fields. `link:` and
  `workspace:` entries need no `packages:`/`snapshots:` rows.
- **Section purity**: the lockfile importer's `devDependencies` must NOT
  repeat a name that also appears in `dependencies` or `optionalDependencies`
  of the same package.json (pnpm de-dups; listing it twice fails with a count
  mismatch). The same rule applies to `dependencies` vs `optionalDependencies`.
- Entry order and quoting style are cosmetic; the comparison is
  order-insensitive.

## Pre-commit hook 环境与锁文件护栏

git 会向 hook 环境注入仓库绑定变量,其中 `GIT_INDEX_FILE` 在 pre-commit 中是**相对顶层目录**的 `.git/index`;子孙进程若以其他 cwd 调 git(真仓库测试、临时仓库 fixture,或 `git worktree add` 内部在 linked worktree 重跑 reset——那里 `.git` 是指针文件)会按自己的 cwd 重解析,读写错位的 index 乃至真仓库 index。`.husky/pre-commit` 因此在 gate 前 `unset` 整个 repo-pinning 变量族;脚本自带 `set -e`,直接 `sh .husky/pre-commit` 裸调用时各 gate 同样全部生效(husky 的正式提交路径本就是 `sh -e`)。

**新增任何 spawn 真 git(或其他读环境外部命令)的测试,必须在 spec 模块顶同样 strip 该变量族**(参考 `packages/workspace/tool-git-worktree/tests/integration.spec.ts` 顶部)。

锁文件卫生:pre-commit 在 gate 前后各查一次 `git diff --quiet -- pnpm-lock.yaml`(worktree vs index),任何未暂存漂移立即拦截 —— 改 workspace 依赖须 `pnpm install`(仅限获得显式授权的环境)并把 `pnpm-lock.yaml` 与 package.json 改动放进**同一 commit** stage。正常 `git commit` 不再需要 `--no-verify`:hook 全绿是提交前提而非可选项。

## Dependency declaration contract for tests

On CI, each package's `node_modules` is populated strictly from its own
declared `dependencies` / `devDependencies` / `optionalDependencies` /
`peerDependencies` (link: targets symlinked in). A test importing a harness
package (`@deepseek-ai/*`) that the package never declares fails at test time
with `ERR_MODULE_NOT_FOUND` — even when it passes locally behind a flattened
or hand-linked root `node_modules`.

`pnpm check:spec-deps` (scripts/check-spec-deps.mjs) enforces this in
presubmit and the pre-commit gate, scanning `packages/*/tests` without needing
node_modules. When it flags an import, declare the package in the importing
package's `package.json` **and** add the matching lockfile entry (see above).

## Claude Code capability manifest / parity matrix edit loop

`docs/claude-code-capabilities.yaml` is the machine-readable source of truth
for Claude Code parity status. `README.md` (between the
`<!-- parity:matrix:start/end -->` markers) and `docs/cc-parity-matrix.md` are
**generated** — never hand-edit them. The edit loop:

1. Edit the manifest YAML (status, evidence, deviations).
2. Run `pnpm docs:parity` to regenerate the README block and the matrix.
3. Commit the manifest and both regenerated files together.

`pnpm check:capabilities` (manifest invariants) and `pnpm check:parity`
(freshness, `--check` mode) run in both the pre-commit gate and presubmit;
their paired self-tests run via `pnpm test:capabilities` and as explicit
presubmit steps. Docs citing a capability must link the matrix by anchor —
`docs/cc-parity-matrix.md#cap-<id>` — never by line number, since generated
output is not line-stable. See
`docs/plans/2026-09-03-claude-code-capability-manifest.md` for the full design.

Governance: a PR that touches capability-affecting code (preset composition,
hook bridging, command mounting, settings/permissions surface, plugin loader)
must update `docs/claude-code-capabilities.yaml` in the same PR — see the
"Capability manifest (parity docs)" section in CLAUDE.md. Reviewers: the
manifest entry is where you check that a claimed status change carries evidence
(I4 anchors) and an explicit deviation; stale generated docs are CI's job,
stale claims are yours.

## Worktree local setup

- After `bash scripts/sync-local-profile.sh web`, the `cc` agent preset is
  available in any profile: the bundle patch declares it against the harness
  agent-preset registry, and the composition ships inside the
  `@dsh-cc/preset-cc` package (no preset-copy step is needed).
- Deps in a fresh worktree: run `pnpm install --frozen-lockfile` inside the
  worktree. pnpm hard-links packages from its shared global content-addressable
  store, so this is fast, needs no network, and yields a real self-contained
  node_modules (`.bin` shims included).
- Never symlink node_modules from the main checkout into a worktree (the
  removed `scripts/link-worktree-deps.sh` approach): it polluted sibling
  worktrees, missed per-package node_modules, and broke `.bin`.

## Cache hit-rate benchmark (`cache-trajectory`)

`packages/test-support/cache-trajectory` is the Item 6 benchmark: a standard
trajectory schema, a deterministic runner, a report fold, and the regression
thresholds used by the cache hit-rate suite. Hit-rate口径:
`cacheRead / (input + cacheRead)` — the harness buckets are disjoint and
`inputTokens` is uncached input only.

Three layers, ordered by flakiness risk (hard assertions only on the
deterministic layers; the rate floors are conservative soft limits):

- **L2 runner + report** (pure, always on): `runCacheTrajectory(ctx, trajectory)`
  drives `trajectories/standard.json` — long byte-stable persona (> 64-token
  cache-block granularity), one deterministic content tool, four turns, forced
  tool call on turn 1 — and folds a report
  (`schemaVersion`/trajectory/provider/model/per-request buckets/rates/thresholds/`verdict`).
  `hitRate()`, `foldRates()`, `evaluateInvariants()`, `renderReportTable()`,
  and the report zod schema are pure. Shape invariants always apply (request
  floor — never a ceiling — per-request usage, forced tool call); cache
  invariants apply only when `cacheHitsExpected`.
- **L0 keyless prefix stability**: the mock-backed e2e asserts, straight off
  the mock server's captured requests, that request N+1's messages are a
  strict prefix-extension of request N's — a broken request prefix becomes a
  deterministic failure, decoupled from provider cache behavior. Scope guard:
  append-only surface only (no compaction plugin mounted / microcompactor
  passive; a surface-rewriting scenario would need the degraded
  "prefix until the latest replace" assertion).
- **L1 with-key regression** (`tests/real-provider-cache.spec.ts`,
  `describe.skipIf(!process.env.DEEPSEEK_API_KEY)`): the standard trajectory
  against the live DeepSeek API over the minimal cc-plugin composition (token
  meter + passive microcompactor). Gates: `cacheReadTokens > 0` from request 2
  on, per-request rate ≥ 0.3, session aggregate excluding the first request
  ≥ 0.6. Both floors scale from `DSH_CACHE_E2E_MIN_HIT_RATE` (one knob, `[0,1]`).

Usage:

```sh
# unit + keyless layers (part of pnpm test)
pnpm exec vitest run packages/test-support/cache-trajectory/tests/
pnpm exec vitest run packages/bundle/cc-tui/tests/cache-trajectory.e2e.spec.ts

# with-key regression (skipped without DEEPSEEK_API_KEY)
DSH_CACHE_E2E_MIN_HIT_RATE=0.5 pnpm exec vitest run \
  packages/test-support/cache-trajectory/tests/real-provider-cache.spec.ts

# standalone calibration bin — always exits 0; verdict lives in the report
pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts --out /tmp/report.json
pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts --report-only /tmp/report.json
# keyless against a mock server (see harness dsh-llm-mock-server bin)
pnpm exec tsx packages/test-support/cache-trajectory/src/bin.ts \
  --base-url http://127.0.0.1:8000/v1 --api-key mock-key --model mock-model \
  --no-cache-expected
```

Workflow: calibrate with `--report-only`/`--out` distributions first, then
tighten the trajectory's `thresholds` (or set the env gate in CI). The full
bundle-patch composition (preset roster + TUI rows) boots only under a
deployed dsh installation — sync the bundles with `scripts/sync-local-profile.sh`, then run
the bin there; harness-side clients link this package rather than the reverse.

## Capability freshness ritual

Monthly (or per notable Claude Code release):

1. Run `pnpm report:freshness`. It lists capabilities whose newest
   `upstream.refs` retrieval is older than `baseline.freshness_threshold_days`
   ("Stale baselines") and capabilities with empty `upstream.refs` ("Backfill
   queue").
2. For each stale / backfill-queue area, re-query Context7
   (`/websites/code_claude`; resolve the library id first if needed) on the
   relevant topic and update that capability's `upstream.refs` — add or refresh
   the ref and set `retrieved` to the actual query date.
3. Run `pnpm docs:parity` so the generated matrix, README block, and
   `docs/claude-code-capabilities.json` stay in sync.
4. Open a PR titled `docs(capabilities): freshness refresh YYYY-MM`.

The monthly `parity-freshness` workflow (`.github/workflows/parity-freshness.yml`)
runs the same report with `--fail-on-stale` and fails when any baseline ages
past the threshold.
