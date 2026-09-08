# Startup Latency: Boot-to-First-Frame

Status: **Implemented** — PR #121 (merged 2026-09-05). Approved for implementation (cold-reviewed 2026-09-05; revisions folded in).
Scope: dsh-cc repo only. The harness repo (`deepseek-harness`) is untouched —
its items are upstream proposals (appendix), not work items here.

## Evidence

Measured on this machine (Node v22.23.2, harness CLI 0.1.1-rc.2, warm caches,
n=5 after one discarded warm-up; harness scripts retained under the untracked
`.scratch-start-prof/`):

- Boot to first TUI frame (marker `dsh cc-mode`,
  `packages/ui/tui/src/components/root.ts:78`): **median 7.09 s**, min 5.50,
  max 10.14.
- Main-process JS is busy only ~1.41 s of that (node internals 557 ms,
  `@deepseek-ai/*` 241 ms, `@dsh-cc/*` 60 ms). **~86 % of wall time is waiting
  on spawned subprocesses.**
- Child-process timeline: git probes ~0.7 s; `npx -y @upstash/context7-mcp`
  spawned at 1.26 s; serena (python) at 2.59 s; `npx -y sequential-thinking`
  at 7.63 s — spawned and handshake-awaited **strictly serially** before the
  first frame. Each `npx` child burns ~1.2 s of CPU inside npm/arborist.

Root-cause chain: `packages/bundle/cc-shell/src/index.ts:143–159` mounts each
`.mcp.json` server via a serial `await ctx.plugin(CcMcpClient, server)`;
`packages/mcp/mcp-client/src/index.ts:277` then blocks plugin activation on
the initialize handshake **and** tool discovery. The mount runs inside the CC
preset's `cc-shell-glue` (`packages/preset/cc/agent.cordis.yml:334`), which is
mounted under `ctx.agents.create/resume`
(`packages/ui/tui/src/harness/driver.ts:142–159`), which `createDriver` awaits,
which `mountTui` awaits (`packages/ui/tui/src/plugin.ts:29`) before
`root.tui.start()` renders the first frame (`plugin.ts:93`).

## Work items

### W1 (P0): non-blocking initial MCP connect

**Change.** `packages/mcp/mcp-client` gains an optional config field
`deferStartupConnect: boolean` (default `false`) on all three transports
(stdio / streamable-http / sse — schema at `src/index.ts:144–176`). When true,
`apply()` returns right after namespace reservation and
`registry.register(...)`; the initial `connect()` runs un-awaited, and its
settle continuation updates the registry (`report`, `setToolCount`,
`setToolBreakdown`, `src/index.ts:243–249`) exactly as today. When
`failOnStartupError` is true, deferral is silently ignored and the **entire**
startup-options path stays blocking — that flag also flips the initial sync's
`registrationFailure` to `'throw'` (`src/connection.ts:187–189`), so a partial
deferral would produce a fiber rollback nobody awaits.

**cc-shell side.** `packages/bundle/cc-shell/src/index.ts` passes
`deferStartupConnect: true` for every server it mounts from `.mcp.json`
(`buildRegistrations` already emits `failOnStartupError` unset → schema
default `false`, so deferral is eligible). No `Promise.all` needed:
`startConnection` spawns the child synchronously (`connection.ts:382–427`), so
deferred serial mounts overlap the handshakes anyway.

**Spec requirements (review-mandated):**

1. The settle continuation MUST guard against disposal: if the effect teardown
   already ran (`disposeConnection` + `registry.unregister`,
   `index.ts:265–270`) before `handle.ready` settles, the continuation must not
   write into the unregistered service. Track a `disposed` flag / compare the
   live handle; late outcomes are dropped silently.
2. The kicked-off connect MUST be `void connect().catch(err =>
   ctx.logger.warn(...))` — an unhandled rejection kills the Node process.
3. Error-state tests must account for the reconnect loop
   (`scheduleReconnect`, `connection.ts:282–318`): `error` is not terminal, a
   timer flips the state back to `connecting`. Pin `reconnect.enabled=false`
   in the "failing server stays error" test, or assert the observed sequence
   (`error` seen, then retry `connecting` seen) — never assert a stable
   terminal `error`.
4. Post-activation tool registration is the real behavior change (not
   `ctx.effect` in the abstract): `ctx.tools.register` inside `syncTools` must
   work after the fiber has activated. Precedent already exists —
   `tools/list_changed` handlers and every reconnect re-sync do exactly this
   (`connection.ts:351–380`). Pin it with a test at the **agent-mount** level
   (closest to the real wiring): mount a deferred server under an agent, let
   activation complete, then let the fake server finish its handshake and
   assert the tools are visible and callable.
5. First-prompt visibility window: prompts submitted in the first ~1–2 s will
   not see `mcp__*` tools, and the deferred-disclosure plan
   (`docs/plans/2026-09-02-mcp-deferred-disclosure.md`, Phase 1
   `toolFilter` sanitization) permanently drops unknown `mcp__*` names for a
   subagent spawned inside the window. Make the window visible: when
   cc-shell-glue finishes mounting and at least one deferred server is not yet
   `ready`, register a one-shot `agent/session-start` hook (same pattern as the
   gating notice, `cc-shell/src/index.ts:165–175`) that emits a notice listing
   the still-`connecting` servers. Fires once per process; suppressed when
   everything settled in time.
6. Run `pnpm check:capabilities` early — if the MCP bridge is snapshotted by
   the capability evidence, update evidence in the same commit.

**Tests (TDD, write first).** Deferred apply resolves before a scripted slow
fake server completes its handshake (state `connecting`, no tools); after
ready: state `ready`, `mcp__<name>__*` tools visible and callable; failing
server under defer: apply resolves, `error` observed, warn logged, no throw
(reconnect pinned off); `defer=false` unchanged, including
`failOnStartupError=true` fiber rejection; dispose during `connecting` leaves
no zombie child, unregisters cleanly, and performs **no** late registry
writes; HMR remount with the same `serverName` works.

### W2 (P1): drop the launcher's `dsh --version` probe

`packages/launcher/tui/bin/dsh-cc.js:22–27` spends one extra Node cold start
(~60 ms) probing `dsh --version` before spawning the real child. Delete it;
the guidance message must instead fire on **every** missing-`dsh` path:

- the final `spawn('dsh', …)` — attach an explicit `child.on('error')`
  handler (ENOENT prints the guidance, exit 1);
- the first-run bootstrap-install `spawnSync('dsh', add)` path
  (`dsh-cc.js:31–39`) — spawn error yields `installed.status === null` and
  today exits silently; it must print the same guidance.

Extract `dshUnavailableMessage()` into `packages/launcher/tui/bootstrap.mjs`
(pure, spec-covered). New spec spawns the bin with a `dsh`-free `PATH` and
asserts exit code + message on both paths.

### W3 (P1): warm the spawned child's module loading via `NODE_COMPILE_CACHE`

Before the final spawn, default `NODE_COMPILE_CACHE` to
`$DSH_HOME/.cache/node-compile-cache` where `$DSH_HOME` uses the same fallback
as `dsh-cc.js:29` (`process.env.DSH_HOME || ~/.dsh`); a user-set value always
wins. Propagation through `spawn` env inheritance makes the harness child's
~500 ms of module-compile/internals reusable across boots. Pure helper
`spawnEnv(env, dshHome)` in `bootstrap.mjs` + spec (defaults, user-wins,
DSH_HOME fallback). Node's cache dir is version-partitioned; no growth guard.

### W4 (P1): stop blocking the first frame on `seedDefaultModel`

`packages/ui/tui/src/harness/driver.ts:225` awaits
`agent.seedDefaultModel()` (settings read + deployment default resolution)
before building the root component. Change to fire-early / await-late:

1. Kick the seed promise immediately after `createAgentSection`
   (driver.ts:193); do not await it before `buildRoot`.
2. Thread a `waitForModel(): Promise<void>` seam into the queue/submit path
   (driver-queue owns `submit` and currently has no handle on the seed
   promise — plumb it through) so a turn never dispatches with an unresolved
   model. First verify where the harness agent reads `selection.current` at
   turn start (`installModelSelection`, driver.ts:101) and await in
   `queue.submit` **before enqueue**, not merely before acknowledge. Cover the
   `/effort` path (driver-run-local.ts:207–209) the same way.
3. Gate the "No model configured" boot notice (driver.ts:250–255) on the seed
   having settled — emit it from the seed's continuation, not eagerly, or slow
   boots spuriously show it.
4. Banner model label (driver.ts:242–244): emit as today with the
   `'default model'` fallback, then upsert the same row when the seed settles
   (existing `upsertRow` machinery).
5. Make the in-flight seed idempotent (shared promise) and document the
   `switchSession` reset race (driver-sessions.ts:280 calls
   `seedDefaultModel(true)`): a boot seed that already passed its early-return
   may set `selection.current` after a reset meant "unset". Boot case is
   benign (same value); spec a comment, not locking.
6. driver.ts is at 499/500 lines (`scripts/check-file-size.mjs`) — all new
   logic lands in `driver-agent.ts` (308 lines) or the queue section;
   driver.ts must not grow.

Tests: submit-during-seed-window never dispatches with an undefined model
(awaited); no-model notice appears only when the settled seed found none;
banner row updates on settle; existing seed specs still pass.

### W5 (dropped at review): `ensurePackagedPreset` fast-path

Already O(1) when unchanged: `packaged-preset.ts:104–109` short-circuits to
`status: 'current'` on a marker-revision match — the proposed mtime fast-path
already exists as the revision marker. Recorded here so nobody re-investigates.

### W6 (P2, optional filler): parallelize the settings-cascade reads

`packages/settings/settings-cascade/src/index.ts:259–264` — `load()` awaits
five independent reads serially; make them `Promise.all`. Merge order
(user→project→local→flag→policy, index.ts:266–272) and the constructor-time
local-settings git probe (index.ts:122–140) are untouched. One behavioral
nuance to comment + pin: with **multiple invalid** files, serial loading
surfaces the lowest layer deterministically while `Promise.all` surfaces
whichever rejects first in time — message content can differ, both are loud.
Single-invalid behavior is unchanged. Concurrency test uses `vi.spyOn` on
`fs/promises.readFile` with controllable deferreds asserting ≥2 calls in
flight — no wall-clock assertions. Expected win is single-digit ms; lands only
because it is nearly free.

### W7 (P2, gated): bundling `@dsh-cc/*` runtime packages

Attempt **only if**, after W1–W4+W6 land, a fresh `--cpu-prof` re-measure
still shows ≥ 300 ms of module-load cost attributable to `@dsh-cc/*` lib
files. `@dsh-cc/*` self time is currently ~60 ms of 1.41 s busy and W3 already
attacks the internals bucket, so the expected outcome is "record the
measurement, close as not-worth-it". If the gate triggers: esbuild
single-file `lib/` per boot-path package, keeping `exports` targets intact;
must pass `check:exports`, `check:publish`, spec aliases, and
`smoke:profile-boot`.

## Verification

Order: W1 → **measurement checkpoint** (re-run the retained pty harness; the
git-probe ~0.7 s and remaining compose work are otherwise unattributed — if
the post-W1 median stalls near ~3 s, say so in the PR instead of letting scope
creep toward the harness repo) → W2 → W3 → W4 → W6 → W7 gate.

Per landing: `pnpm typecheck`, `pnpm test`, `pnpm check:capabilities`,
`pnpm check:parity` (regenerate docs if the surface changed),
`pnpm check:exports`, `pnpm check:spec-deps`, `pnpm check:size`,
`pnpm check:deep-imports`, `pnpm check:tui-boundary`.

Final: `pnpm smoke:profile-boot`; re-measure boot-to-first-frame n=5 with the
retained scripts (`.scratch-start-prof/`); publish before/after medians in the
PR. Target: ≤ ~2.5 s median warm (baseline 7.09 s). No number, no claim.

## Operational notes for the implementer

- Work happens on branch `worktree-start-optimization` in this worktree;
  never on `main`. The harness repo is read-only.
- Commit via `git commit -F <file>` with a freshly written, uniquely named
  message file, and verify `head -1` before committing (stale `/tmp` message
  files have caused a real wrong-message commit).
- PR body via `gh pr create --body-file` — heredoc backticks get eaten by the
  shell. PR title/description in idiomatic English.
- `.scratch-start-prof/` is untracked; never `git add` it.

## Appendix: upstream proposals (deepseek-harness, NOT implemented here)

1. Cache `healProfilesModuleFallback`'s dependency-closure BFS by app-manifest
   hash (it re-reads hundreds of package.jsons + re-stats ~264 symlinks every
   boot when already healed).
2. Dirty-check the unconditional per-boot profile-root-config rewrite
   (`prepareProfile`).
3. Default `NODE_COMPILE_CACHE` inside the harness bin so non-`dsh-cc`
   launchers benefit too.
