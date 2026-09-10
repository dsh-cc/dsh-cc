# Plugin MCP Seam — Wiring `mcpServers` from CC Plugins into mcp-client

Date: 2026-09-07. Status: **Implemented** — PR #8 (merged 2026-09-08). Original review record: revised — dual blind review (deep-reasoner cold
review + Codex cold review, independent) both returned REVISE; all blocking
findings folded. See §8 Review log. Two disputes settled empirically
(disposable probe spec, since deleted): cordis loading-fiber
`provide` visibility (Codex's claim confirmed: invisible) and the
rescan namespace race (0 failures in 100 tight dispose→remount cycles —
kept as defended-but-inactive, see D8).

## 1. Problem (probe-verified, 2026-09-07)

`cc-plugin-loader` ships a complete `mountMcpServers` path
(`packages/compat/cc-plugin-loader/src/mcp.ts`): it collects a plugin's inline
`mcpServers` record plus optional `mcpServersPath` `.mcp.json` file and calls
`McpSeam.registerServer(name, config)` from `seams.ts`. But the seam is
**never provided in production**: `ctx.get('mcp')` has exactly one consumer
(the loader itself) and zero providers across (a) this repo's packages,
(b) the sibling deepseek-harness checkout, (c) the published
`~/.dsh/profiles/tui/node_modules/@dsh-cc/*` dists, and (d) the installed
`@deepseek-ai/dsh` CLI tree. Cordis `ctx.get` on an unprovided key returns
`undefined`, so every plugin's mcpServers component tallies `skipped: mcp
seam "mcp" is not mounted` and mounts nothing. No shipped plugin declares
mcpServers, so the gap never surfaced — until it blocks shipping context7
(with `${CONTEXT7_API_KEY}` injection) through the plugin channel.

Secondary finding: `docs/claude-code-capabilities.yaml` `plugins.loader`
claims components "skills/commands/agents/hooks/**mcp**/settings" with
`behavioral: full, deviation: none` — overstated; the mcp leg is the
subject of this plan (see S5).

## 2. Existing machinery to reuse (verified by reading source)

- `packages/mcp/mcp-config/src/index.ts`
  - `buildRegistrations(body, { env, deferStartupConnect })`
    (index.ts:273) — full pipeline: parse → `normalizeServerEntry` →
    `expandConfig`/`expandEnv` (`${VAR}` and `${VAR:-default}`; **unset
    without default throws** naming the variable, index.ts:116) →
    `normalizeServerName` (collapses to the `[A-Za-z0-9_-]{1,32}` tool-prefix
    contract) → emits mcp-client `Config`s. With
    `deferStartupConnect: true` it also downgrades
    `failOnStartupError: false`.
  - Boot idiom (`packages/bundle/cc-shell/src/index.ts:166-174`):
    `buildRegistrations(body, { env: process.env, deferStartupConnect: true })`
    then `await ctx.plugin(CcMcpClient, server)` per server, per-server
    errors caught into `logger.warn`.
- `packages/mcp/mcp-client` — cordis plugin, one fiber per server;
  effect-scoped disposal disconnects and unregisters all `mcp__*` tools;
  registers per-server state into `mcpConnections` **only once a connection
  attempt is made** (`mcp-client/src/index.ts:288`) — pure config-skip never
  creates a registry entry (drives D1 wording).
- cordis `ctx.plugin()` returns a `Fiber & PromiseLike` synchronously
  (harness vendor cordis `registry.ts:313-335`); pending-fiber disposal is
  explicitly handled (`fiber.ts:279-296`). **Double-verified**: deep-reasoner
  and Codex both read the vendored source; D2's mechanism holds.
- **cordis strict-get visibility (empirically probed)**: `ctx.provide` on a
  still-LOADING fiber is invisible to `ctx.get` — including on the same ctx
  and to child plugins mounted on it (strict get filters on
  `impl.fiber.state !== ACTIVE`, vendored `reflect.ts:233-243`). The
  sanctioned workaround is the child-plugin idiom
  (`cc-shell/src/index.ts:82-95`): `await ctx.plugin({ name, apply(c) { new
  Service(c) } })` — the **await** returns only after the child fiber's
  ACTIVE transition (`_execute` settles, fiber.ts:646-673), so from that
  point on what the child provided is visible to `ctx.get` anywhere in the
  realm. (Precision fix from round-2 review: the child's apply itself runs
  while LOADING; it is the caller-side await that buys visibility.)
- `mountCcPlugin` rollback (`cc-plugin-loader/src/index.ts:140-146`) and
  per-plugin failure capture in `CcPluginsService.mountOne`
  (`ccPlugins.ts:164-168`); `rescan()` disposes then remounts
  (`ccPlugins.ts:200-218`).
- mcp-client namespace reservation `activeServerNames` throws on duplicates
  (`mcp-client/src/index.ts:44-50,217-230`) from inside the fiber's async
  apply — with `deferStartupConnect` this surfaces as an activation rejection
  at (or after) the first microtask barrier, never synchronously.
- Test fixture: `packages/mcp/mcp-client/tests/fixture-server.ts` (real
  stdio MCP server fake).

## 3. Design

### 3.1 The bridge — `packages/bundle/cc-shell/src/mcpSeam.ts` (new)

~110 lines, no new packages. Structural type import of the loader's
`McpSeam` — no runtime dependency cycle (cc-shell already depends on
`@dsh-cc/plugin-loader`).

```ts
export interface PluginMcpSeamOptions {
  /** Injectable plugin reference for tests; default: CcMcpClient. */
  plugin?: unknown
  /** Injectable env lookup for expansion tests; default: process.env. */
  env?: Record<string, string | undefined>
  /** Boot pending-notice feed: called with the normalized serverName. */
  onRegistered?: (serverName: string) => void
}
export function createPluginMcpSeam(ctx: Context, opts: PluginMcpSeamOptions = {}): McpSeam
```

`registerServer(name, rawConfig)`:

1. `buildRegistrations({ mcpServers: { [name]: rawConfig } },
   { env: opts.env ?? process.env, deferStartupConnect: true })` (D5).
2. Synchronous throw (malformed entry, unknown transport, unset `${VAR}`
   without default) → `ctx.logger.warn` naming the plugin-supplied name and
   the cause; return a no-op disposer; **never throw** (D1).
3. Pending-release ledger for namespace races (D8): a `Map<string,
   Promise<void>>` of serverName → **dispose-settle** promise (see step 6 —
   the ledger entry is written by the DISPOSER, not by attach; chaining on
   activation-settle would miss the dispose→remount hazard entirely, which
   round-2 review caught). If a same-name entry is pending, the new
   `ctx.plugin` call is deferred behind it (`pending.then(continuation)`).
   The deferred continuation carries a cancellation flag: if the step-6
   disposer was called before the chained attach fired, the flag is set and
   the continuation immediately disposes the freshly created fiber (never
   leaves a zombie server nothing owns). Entries are deleted on EVERY settle
   branch (activation, rejection, disposal) — the map holds pending-only.
4. Attach: `const fiber = ctx.plugin(opts.plugin ?? CcMcpClient, config)`;
   `Promise.resolve(fiber).then(settle, err => { warn; settle })` — the
   activation thenable is always consumed (no unhandled rejections). Note
   `Promise.resolve(fiber)` = fiber's active-settle, NOT disposal-settle;
   only step 6's ledger write captures the dispose side.
5. `opts.onRegistered?.(config.serverName)` (D6).
6. Return a disposer that: sets the chained-attach cancellation flag (step
   3) when the attach has not fired yet; writes the ledger entry
   `ledger.set(name, Promise.resolve(fiber.dispose()).catch(warn))` BEFORE
   disposing (dispose-settle chaining is the D8 fix); catches teardown
   rejections (vendored fiber.ts:476-483). The returned function stays
   synchronous `() => void`.

### 3.2 Wiring — `packages/bundle/cc-shell/src/index.ts`

Probe-confirmed rule applied: **a direct `ctx.provide('mcp', …)` inside the
glue's own apply is invisible** (the glue fiber is LOADING there). Use the
file's own child-plugin idiom, before `CcPluginsService`'s `mountAll` runs:

```ts
if (ctx.get('mcp') === undefined) {
  const seam = createPluginMcpSeam(ctx, { onRegistered: n => deferredNames.push(n) })
  await ctx.plugin({ name: 'cc-mcp-seam', apply(c: Context) { c.provide('mcp', seam) } })
}
```

- `deferredNames` hoisted above this block (currently declared at
  index.ts:140) so the boot one-shot pending notice (index.ts:188-204)
  covers plugin servers (D6).
- Add the cordis Context augmentation for the typed key, mirroring
  `ccPlugins.ts:28-38`:
  `declare module '@deepseek-ai/cordis' { interface Context { mcp: McpSeam } }`
  in `mcpSeam.ts`.

### 3.3 Mount-order fact (corrected by both reviewers)

CC plugins mount **first** (index.ts:121 `mountAll`), `.mcp.json` servers
**second** (index.ts:162-179). Therefore on a same-name collision the
**plugin** server owns the `mcp__<name>__*` namespace and the `.mcp.json`
server is the one warned-and-skipped at index.ts:172-173. We document and
pin this actual behavior (D3) — it is CC-consistent (plugin servers may
shadow project config) and requires no reordering.

### 3.4 What we deliberately do NOT change

- `cc-plugin-loader` (`mcp.ts`, `seams.ts`): interface and mount order stay.
  Known limits now documented: the mcpServers tally counts `loaded` right
  after `registerServer` returns even for D1-skipped servers (interface has
  no richer return type — follow-up, not blocking); `collectServers`
  silently swallows a corrupt `mcpServersPath` file read (`mcp.ts:77-88`) —
  worth a warn in a follow-up, out of scope here.
- mcp-client / mcp-config: no code changes.
- harness: untouched (standing directive).
- OAuth on plugin-declared servers: out of scope; the `.mcp.json` parity
  pipeline carries no oauth field.

### 3.5 Decisions (full rationale)

- **D1 — skip, never throw; observability is logger + (not) `/mcp`.**
  Synchronous config errors skip that server, warn in logs, and let the
  plugin's other components load. Corrected claim (Codex B4): a skipped
  server creates **no** `mcpConnections` entry — `/mcp` simply never lists
  it; the only attention surface is the log line, which must therefore name
  plugin, server, and cause. Async failures (unreachable server) DO appear
  in `/mcp` as registry entries with error state. An env var a user hasn't
  set must not gate a plugin's entire surface; `${CONTEXT7_API_KEY:-}` with
  an empty default is the shipped-plugin norm.
- **D2 — disposer valid while activation pending.** Confirmed by BOTH
  reviewers against vendored cordis (`fiber.ts:279-296` handles
  pending-state dispose; the returned PromiseLike is optional to await).
  Pinned by test S1.7.
- **D3 — plugins mount first; plugins win the namespace; `.mcp.json`
  duplicate is warned.** Document actual behavior (§3.3); no reordering of
  the glue. Flat `mcp__<name>__tool` names, no per-plugin prefixing (Q2):
  frontmatter `tools:` references and CC behavior both expect flat names.
- **D4 — env expansion at registration against `process.env`** (test
  injection via `opts.env`). Rescan re-expands current env — intended. No
  config values (post-expansion, possibly secrets) ever reach logs or the
  tally; only names.
- **D5 — `deferStartupConnect` for plugin servers** — boot-time win and
  rescan non-blocking; `failOnStartupError` downgrade rides along.
- **D6 — boot pending notice covers plugin servers** via `onRegistered`;
  rescan-time registrations skip the one-shot notice; `/mcp` shows them.
- **D7 — no OAuth / custom timeouts for plugin config v1.**
- **D8 — seam-side pending-release ledger** (folds reviewers' B2/B3, shaped
  by round-2 review): the ledger keys on **dispose-settle** promises written
  by the disposer itself (§3.1 steps 3+6), not on activation settle — a
  remount after an ACTIVE fiber's disposal otherwise sees no pending entry
  and re-races the async `_unload` release. Deferred attaches carry a
  cancellation flag their disposer sets, so dispose-before-attach never
  leaks an owned-by-nobody fiber. Even though 100× empirical probing showed
  the race inactive under current cordis ordering, the ledger removes the
  reliance on fiber-barrier scheduling subtleties and makes S3's remount
  assertion deterministic rather than timing-lucky.
- **D9 — injectable `opts.plugin`** (folds deep-reasoner B3): S1 fakes the
  mcp-client plugin entirely; duplicate-namespace tests must await one
  microtask tick before asserting (reservation lives behind the fiber
  barrier).

### 3.6 Shipped-plugin consequence (context7)

Once the seam exists a plugin may write:

```jsonc
"mcpServers": {
  "context7": { "command": "npx",
    "args": ["-y", "@upstash/context7-mcp", "--api-key", "${CONTEXT7_API_KEY:-}"] }
}
```

`${VAR:-}` with an empty default is **mandatory** for optional secrets
(D1 + expandEnv throw-on-unset). This plan does NOT add context7 to
`dsh-cc-agents` — it unblocks it; that manifest change is a follow-up.
Serena stays host-side — unchanged verdict.

## 4. TDD implementation slices (fast-worker)

Gates per slice: `pnpm --filter <pkg> test` (or root vitest filter) green;
final: `pnpm check:capabilities && pnpm docs:parity` + full presubmit.

- **S1 — seam unit tests** `packages/bundle/cc-shell/tests/mcp-seam.spec.ts`
  with `opts.plugin` faked to a config-capturing stub; `opts.env` injected:
  1. valid stdio entry → fake client receives normalized+expanded config
     with `deferStartupConnect: true`, `failOnStartupError: false`,
     normalized serverName (`me.server` → `me-server`);
  2. `${VAR}` / `${VAR:-default}` expansion honor the injected env;
  3. unset `${VAR}` without default → warn names the variable; no plugin
     instance; disposer no-op; **no `mcpConnections` entry fabricated**;
  4. malformed entry (no command) → warn + skip, never throws;
  5. duplicate serverName while activation pending → second attach is
     chained behind the first fiber's settle promise (D8), activation
     rejection logged, no unhandled rejection (await one tick before
     asserting); **and** calling the second registration's disposer BEFORE
     its chained attach fires sets the cancellation flag, so the later
     attach disposes its fiber immediately — no zombie;
  6. disposer called before activation settles → fiber disposed, no leaked
     tools, no unhandled rejection; disposer teardown rejection is caught
     and logged; a name re-registered AFTER a dispose chains behind the
     dispose-settle promise (D8), not behind activation-settle;
  7. `onRegistered` called with the normalized name.
- **S2 — integration with real mcp-client + fixture-server**
  (`tests/mcp-seam.integration.spec.ts`): register fixture stdio server →
  `mcp__probe__*` tool on `ctx.tools` and an `mcpConnections` entry;
  dispose → tool unregistered; dispose→re-register same name succeeds
  (ledger path exercised).
- **S3 — end-to-end through the real loader**: tmp probe plugin
  (inline `mcpServers` AND a `mcpServersPath` file case), `mountCcPlugin`
  against a ctx carrying the real seam → mcpServers tally `loaded`, tool
  mounted; `rescan()` disposes and remounts the same name cleanly.
- **S4 — wiring in cc-shell/src/index.ts** (child-plugin provide,
  augmentation, `deferredNames` hoist, onRegistered feed) + a boot-composition
  test asserting `ctx.get('mcp')` IS observable from a mounted CC plugin
  probe (regression-pins the visibility rule that the first design got
  wrong) + plugin pending names appear in the deferred notice.
- **S5 — docs**: `docs/claude-code-capabilities.yaml` `plugins.loader`:
  keep the mcp component claim but attach honest notes (seam added by
  cc-shell glue; tally counts register-time loads, config-skip surfaces
  only in logs) + evidence rows (`mcpSeam.ts`, S1/S3 specs) + the
  plan reference; regenerate with `pnpm docs:parity`; README touch-ups
  (`packages/compat/cc-plugin-loader/README(.zh).md` host-wiring status;
  cc-shell README mount list if present). Commit message states the
  pre-existing overstatement was discovered by the 2026-09-07 probe and
  corrected here.

## 5. Risks

- **Fixture realism**: S2/S3's fake server is stdio-only; a real `npx`
  server is covered only by the post-merge runtime proof (install a probe
  plugin in a live session; skipped `${UNSET_VAR}` server → plugin mounts,
  warn in logs, `/mcp` absent; fixture-name server → ready).
- **Ledger edge**: two plugins racing the SAME name at near-boot — ledger
  serializes registration order deterministically by call order; acceptable.
- **Tally honesty** (review advisory, deferred): loader mcpServers tally
  counts skips as loaded. Documented in S5; a richer `registerServer`
  return is a follow-up against the seam interface.

## 6. Post-merge verification

Real dsh session: install a minimal probe plugin; `/plugin` shows
mcpServers loaded (not skipped); `/mcp` shows the server; a
`${PROBE_UNSET}` server yields plugin-mounted-but-server-skipped with a
named-variable log warning; `/reload-plugins` remounts cleanly (no
duplicate-namespace errors).

## 7. Open questions — resolved by review

- Q1 → D1 (skip; tally honesty documented, richer return deferred).
- Q2 → D3 (plugins win collision; flat names, no prefixing).
- Q3 → glue-realm child-plugin provide is sufficient (verified mechanism);
  cross-realm need, if any ever appears, follows the existing root-realm
  publication pattern in `ccPlugins.ts:96-104`.

## 8. Review log

- **deep-reasoner (Opus), cold, verdict REVISE.** Blocking: (1) D3 mount
  order inverted in draft (plugins actually mount FIRST) — folded as §3.3/D3;
  (2) rescan namespace-release race possible; S3 timing-lucky — folded as
  D8 ledger; (3) S1 missing the injectable-plugin point + duplicate test
  needs a tick — folded as D9/S1.5. Advisory folded: Context augmentation
  (§3.2), dispose-path `.catch` (§3.1 step 6), manifest/honesty notes (S5).
  Verified-good: `ctx.plugin` sync Fiber return, pending-fiber dispose
  semantics, `buildRegistrations` behaviors.
- **Codex (GPT peer), cold, verdict REVISE** (companion runtime failed
  mid-task; the review was completed in-channel by the rescuing agent).
  Blocking: (1) `ctx.provide` on the loading glue fiber invisible —
  **confirmed empirically** and folded as the §3.2 child-plugin idiom;
  (2) D3 inversion (independent catch) — folded; (3) rescan dispose race —
  folded as D8; (4) D1's "/mcp shows error" false (skipped registers
  nothing) — folded as D1 wording + S1.3 assertion. D2 independently
  verified correct. Q1/Q2/Q3 answers on both sides converged.
- **deep-reasoner round 2 (Opus), verdict APPROVE-WITH-CHANGES.**
  Round-1 blockings all CLOSED; the provide-visibility empirical result
  conceded with mechanism (strict get filters on fiber state !== ACTIVE,
  vendored `reflect.ts:233-243`). Two NEW blockings, both folded:
  (a) the D8 ledger originally chained on activation-settle, which misses
  the dispose→remount hazard it exists for — §3.1 now writes the ledger
  entry from the DISPOSER (dispose-settle chaining);
  (b) the chained-attach path leaked a disposer contract (zombie fiber when
  disposing before the deferred attach fires) — §3.1 step 3 adds the
  cancellation-flag protocol, S1.5/1.6 assert it. Advisory folded: §2
  mechanism precision (caller-side await buys ACTIVE, not the child's
  apply); ledger entries deleted on every settle branch; S4's unmodified
  `ctx.get('mcp') === undefined` guard noted as sharing a pre-existing
  stale-UNLOADING hazard with the other glue blocks (accepted, consistent).
