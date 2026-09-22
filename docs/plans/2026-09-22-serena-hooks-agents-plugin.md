# Serena code-intelligence hooks via the dsh-cc-agents plugin

Status: **PR-A implemented in this PR** — PR-B (repo hooks.json serena-entry
removal) is pending a release that includes this PR. Approved design — cold
Staff-Engineer review (dsh-cc-agents:critic, 2026-09-22) returned
GO-WITH-AMENDMENTS; all amendments folded in below (rollout split into two
PRs; git-toplevel gate walk; timeouts; guard-spec pluginRoot).
Date: 2026-09-22
Scope: `packages/plugin/dsh-cc-agents` (new `hooks/` component), repo-root
`hooks.json` (serena entries removed in a follow-up PR only),
`packages/hooks/hooks-claude-code/tests` (guard spec extended), plugin and
root README pairs, `.claude-plugin/marketplace.json` description. No
bridge/loader code changes. No version bumps (versions move with repo-wide
`chore(release)` commits).

## Context

PRs #100/#101 made the repo-root `hooks.json` serena hooks actually work:
`SERENA_HOME` is pinned into the project so the remind counter persists, and a
`SessionEnd` cleanup garbage-collects per-session state. That config only
loads from the session launch cwd, so every repository that wants the serena
nudge needs its own copy — which does not scale.

The plugin hooks seam (#8/#16, production-proven by dsh-cc-shunt firing live
in dogfooding sessions) distributes `hooks/hooks.json` per enabled plugin,
independent of the repo. Plugins are opt-in per user via settings
(`enabledPlugins`, covering hooks in production: cc-shell mounts
installed∩enabled plugins), not per repo — the distribution unit we want.

Question under design: can `dsh-cc-agents` (the official, widely-enabled
agent pack) carry these hooks? Review-verified load-bearing facts: plugin
hook groups are appended after boot-config groups (merge copy-on-write,
index.ts:290-292); `${CLAUDE_PLUGIN_ROOT}` substitutes from pluginRoot
(config.ts:131-132); `CLAUDE_PROJECT_DIR` env is injected per dispatch
(run-point.ts:86-89); SessionEnd dispatches detached on session/disposed with
`session_id` in the payload (register-events.ts:280-285, payloads.ts:116).

## Decision

Yes, with conditions. The plugin hooks seam supports multi-component plugins
(shunt ships agents + hooks + skills), and `dsh-cc-agents` already reaches
every dogfooding profile. But hosting hooks in an always-on agent pack makes
them fire for users/repos **without** serena — spawning a missing binary on
every Read/Grep and nudging toward tools that do not exist. The integration
therefore MUST be gated so the hooks are silent no-ops outside serena-enabled
projects.

### What moves to the plugin (portable, serena-native)

1. `PreToolUse` matcher `^(read|grep)$|^mcp__serena__` → wrapper
   `hooks/serena-remind.mjs` (see Gate below).
2. `SessionEnd` matcherless → wrapper `hooks/serena-session-cleanup.mjs`.

Both entries carry explicit `timeout: 10` (review finding 3: a hung python
spawn would otherwise block Read/Grep dispatch for the default window).

### What stays in the repo (repo-development-specific)

- `PostToolUse` edit/write → `scripts/hooks/post-edit-diagnostics-nudge.mjs`
- PostToolUse Read|Grep|Glob → `scripts/hooks/serena-failure-watchdog.mjs advise`
- `PostToolUseFailure` ^mcp__serena__ → `... watchdog record`

These reference `${CLAUDE_PROJECT_DIR}/scripts/` and only make sense for
dsh-cc's own checkout. They remain in the repo-root `hooks.json` untouched.

## The Gate (core of the design)

Each plugin hook command is a thin plugin-shipped node wrapper, never
`serena-hooks` directly:

```
hooks/hooks.json:
  command: node "${CLAUDE_PLUGIN_ROOT}/hooks/serena-remind.mjs"
```

Wrapper logic (zero deps, exit-0 discipline mirroring watchdog scripts):

1. Read stdin once (the hook payload); parse JSON, tolerantly.
2. **Project gate (git-toplevel walk — review finding 2)**: start from the
   session project dir (`CLAUDE_PROJECT_DIR` env, else payload `cwd`, else
   process cwd) and walk ancestors until a dir containing
   `.serena/project.yml` is found, stopping at the git toplevel boundary (a
   dir containing `.git`) inclusive, the filesystem root, or `$HOME` —
   whichever comes first. `projectDir` on its own is cwd-relative, and
   sessions launched in subdirectories (or worktree subdirs) must still find
   the serena project. Continue only on a hit; the found dir becomes the
   project root for step 4.
3. **Binary gate**: continue only if `serena-hooks` resolves on `PATH`
   (plain fs scan of PATH entries, same idiom as the /doctor probe).
4. Both gates pass → spawn `serena-hooks remind --client claude-code` (resp.
   `cleanup`), piping the payload, env-extended with
   `SERENA_HOME=<projectRoot>/.serena`; relay its stdout verbatim so the CC
   `hookSpecificOutput` response reaches the bridge unchanged.
5. Any gate failure or spawn error → silent exit 0, no stdout.

`.mcp.json` was considered as an alternative/secondary signal and rejected:
the dsh-cc repo itself mounts serena without a root `.mcp.json`, while
project onboarding always yields `.serena/project.yml` (verified: repo root
has it tracked, no `.mcp.json`). Repos that use serena without onboarding
keep an escape hatch: a per-repo `hooks.json` still works (the bridge loads
launch-cwd config independently of plugin hooks).

## Rollout — two PRs (review finding 1: an availability window, not just
double-fire)

`updatePlugin` is a version-equality no-op: with no version bump in the
feature PR, installed plugin copies stay pre-hooks until the next
`chore(release)` ships and users `/plugin update`. Deleting the repo entries
in the same PR would therefore leave enabled-plugin dogfooders with **zero**
serena hooks. Hence:

**PR-A (this design)**: plugin gains `hooks/` + wrappers + tests + plugin
README section; guard spec EXTENDED (not retargeted) to also parse the
plugin's `hooks/hooks.json` and pin the same invariants there; marketplace
description; root README Serena section notes the upcoming move. Repo
`hooks.json` keeps its serena entries — dogfooding is uninterrupted.

**PR-B (after a release containing PR-A ships)**: repo `hooks.json` deletes
the two serena entries; guard spec retargets full ownership to the plugin
file and asserts the repo file has no `serena-hooks` reference (regression
lock); root README Serena section rewritten to "hooks ship with the
dsh-cc-agents plugin".

The transitional double-fire window (plugin released + repo entries still
present) is accepted between release and PR-B: both channels share the same
`SERENA_HOME` + session pickle, so bursts double-count and the deny trips
roughly twice as fast — an earlier nudge, never corruption. PR-B closes it.

## Package changes (PR-A)

- `packages/plugin/dsh-cc-agents/`
  - `hooks/hooks.json` — two entries above, each `timeout: 10`.
  - `hooks/serena-remind.mjs`, `hooks/serena-session-cleanup.mjs` — wrappers.
  - `package.json` — `files` gains `"hooks"`.
  - `README.md` / `README.zh.md` — new "Serena hooks" section: behavior,
    double-gate semantics, serena prerequisite (`uv tool install
    git+https://github.com/oraios/serena@v1.7.0` + per-repo onboarding), the
    single-channel rule (do not duplicate in repo hooks.json), and the perf
    note (review finding 6): one ~50 ms gated node spawn per Read/Grep on
    non-serena projects; opt out by disabling the plugin.
  - `tests/hooks.spec.ts` — spawnSync matrix per the shunt idiom: no
    `.serena/project.yml` anywhere up the walk → no spawn, exit 0, empty
    stdout; project present but binary absent → exit 0 (hermetic: prepend a
    tmp dir PATH); project + stub `serena-hooks` on tmp PATH → stdin proxied,
    stdout relayed, `SERENA_HOME=<projectRoot>/.serena` observed by the
    stub; subdir launch (payload cwd two levels below the project root)
    resolves via the walk. Cleanup wrapper: stub observes the same env pin.
  - `tests/package-shape.spec.ts` — extend files-list assertion to `hooks`.
- Repo root (PR-A):
  - `.claude-plugin/marketplace.json` — dsh-cc-agents description mentions
    the serena hooks.
  - `README.md` / `README.zh.md` — Serena section gains the move notice.
- `packages/hooks/hooks-claude-code/tests/tracked-hooks-json.spec.ts` —
  extended (review finding 4): parsing the plugin file passes
  `pluginRoot` (absolute path to `packages/plugin/dsh-cc-agents`) into
  `parseClaudeCodeConfig`, because its commands contain
  `${CLAUDE_PLUGIN_ROOT}`; invariant assertions run against the substituted
  commands.

No `docs/claude-code-capabilities.yaml` change: the bridging capability set
is untouched (verified by review); this is packaged content riding an
existing seam.

## Gates

`pnpm test` (affected packages), `tsc -b`, `check:capabilities`,
`check:parity`, `check:spec-deps`, `check:size`, `check:marketplace`, and —
because both README pairs change — `node scripts/check-readme.mjs --write`
re-pin **before** commit (pnpm does not pass `--write` through that chained
script). Marketplace-fixture trap (verified 2026-09-18):
`cc-plugin-manager/tests/install-dsh-cc-agents.spec.ts` materializes the
marketplace fixture via `git ls-files`, so PR-A's new plugin files MUST be
staged before that suite runs, or it fails red for reason unrelated to code.

## Risks

- **Transitional double-fire** (see Rollout): accepted, bounded by PR-B.
- **Silent regression for plugin-disabled dogfooders after PR-B**: README +
  guard spec; the repo's AGENTS.md mandates the agents plugin anyway.
- **Plugin-content update gap**: marketplace clones re-materialize only on
  version bumps via release commits; README tells users to `/plugin update`
  after release.
- **Wrapper overhead**: ~50 ms node spawn per Read/Grep on non-serena
  projects (gates exit before python); ~50 ms + ~150 ms python on serena
  projects (wrapper + remind), same order as today's direct spawn.

## Verification plan (live, post-merge)

1. Scratch repo with `.serena/project.yml`, plugin enabled: 3 consecutive
   greps → deny + nudge on call 3; session exit →
   `.serena/hook_data/<session-id>` gone.
2. Repo WITHOUT serena onboarding: `tail ~/.dsh/hooks/diagnostics.jsonl`
   shows zero spawn failures after Read/Grep bursts; no `.serena/` created.
3. Subdir launch in a serena repo: start a session from a nested directory;
   the gate walk resolves the project root and the counter persists under the
   toplevel `.serena/hook_data/`.
4. dsh-cc repo (plugin enabled, post PR-B): transcript `hook/invoked` shows
   the plugin handler ids and exactly one serena-remind dispatch per call
   (no double).
