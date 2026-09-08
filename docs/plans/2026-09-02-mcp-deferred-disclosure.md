# MCP deferred disclosure + named-subagent `mcp__*` filter

Status: **Implemented** — PR #74 (merged 2026-09-02), with the deferred-MCP preload follow-up in PR #119 (2026-09-05).

Two sequenced changes. Phase 1 is correctness (named Task children currently drop MCP tools). Phase 2 is token cost (MCP schemas are fully eager despite `ToolSearch` existing). Fork parent-prefix inheritance and skill catalog behavior stay out of scope.

TDD is mandatory: every behavior below has a failing test before production code.

Staff-engineer cold review (approve-with-fixes) is folded in. Do not re-introduce the two traps it named: (1) deferred squat must be detected at **sync** time, (2) auto-`ToolSearch` only when the name is actually restrictable.

---

## Phase 1 — named subagent MCP `toolFilter`

**Files**
- `packages/subagent/task/src/tool.ts`
- `packages/subagent/task/tests/tool.spec.ts`
- `packages/subagent/task/README.md` (+ `README.zh.md`; re-record pairing)
- `packages/subagent/task/package.json` — add `@deepseek-ai/dsh-scope` (and `@deepseek-ai/dsh-session` if `SessionId` is needed) as **devDependencies** for the scoped-restrict helper. Do not add mcp-client.

Live names come from `ctx.tools.view(callingAgent).restrictableNames`. `view()` is marked `@internal` on `ToolRuntime` but is the only API that lists reserved+registered names (deferred MCP tools are reserved, not in `schemas()`). Duck-type it on the tools seam `registerTaskTool` already uses:

```ts
view?(scope?: unknown): { restrictableNames: ReadonlySet<string> }
```

Pass the calling agent. MCP tools register on the cc preset's standing-scope layer; `view()` without a scope only sees the global layer and would drop those names.

### `sanitizeToolFilter(filter, warn, knownNames)`

`registerTaskTool` passes `ctx.tools.view(callingAgent).restrictableNames` at **execute** time (live set, not a process snapshot).

1. **Expand** each allow/deny entry (order-preserving, deduped):
   - Bare `mcp__` (no server segment) → drop + warn (`invalid MCP wildcard`).
   - `mcp__<server>__*` or `mcp__<server>` (no third segment: after `mcp__` there is no `__`) → every `knownNames` entry with prefix `mcp__<server>__`.
   - Exact `mcp__<server>__<tool>` → keep as written (must be the **public** name, including any identity-hash suffix).
   - Anything else → keep as written.
2. **Keep** a name iff `knownNames.has(name)`. Drop others with the existing `cc-task: dropping unknown tool name ...` warning.
   - This replaces today's `LEGAL_FILTER_NAMES` closed set. Static CC names (`read`, `bash`, `ToolSearch`, `subagent`, …) survive only when they are actually reserved/registered — which they are in the cc preset, and which Phase 1 tests must stub when they assert them.
   - Delete `LEGAL_FILTER_NAMES` once unused. `CC_TO_HARNESS_TOOLS` import can go if nothing else in the file uses it.
3. **Auto-`ToolSearch`:** if the incoming filter had `allow`, and any kept allow name starts with `mcp__`, **and** `knownNames.has('ToolSearch')`, append `ToolSearch` (deduped). Do **not** fall back to a static legal-names set — that set always contains `ToolSearch` and would inject an unrestrictable name, which makes `child.tools.restrict()` throw at start.
4. **Empty allow is deny-all, loudly.** If the incoming filter **had** `allow` and sanitization left zero names, emit `{ allow: [] }` (do not omit `allow` — omitting it widens to every tool). Warn that the allow-list matched no mounted tools (include the dropped originals). Wildcard that expands to nothing (e.g. `mcp__github` when that server is not mounted) is the same case. Empty deny is still omitted.
5. A definition with no `tools`/`disallowedTools` still passes no `toolFilter` (child inherits the parent tool view).

### Tests — write these first (failing)

Existing `mount()` only registers the Task tool and reserves `subagent`/`workflow`. Any test that keeps `read`/`bash`/`mcp__*`/`ToolSearch` must `reserve` (or register a stub for) those names **before** the Task call.

Add a helper `assertRestrictable(ctx, filter)` that mints a scoped child context (same pattern as `packages/core/tool-search/tests/tool-search.spec.ts` `mintAgent` / `createScope`) and calls `scope.ctx.tools.restrict(filter)` — it must **not throw**. Use this on every newly asserted filter. The fake subagents seam never calls `restrict`; without this helper, both review blockers ship green.

Capture `ctx.logger.warn` (assign a vi.fn) for tests that assert warnings.

| # | Setup | Frontmatter | Assert |
|---|---|---|---|
| 1 | Reserve `mcp__github__create_issue`, `mcp__github__search`, `read`, `read_image`, `ToolSearch` | `tools: [Read, mcp__github__create_issue]` | allow contains `read`, `read_image`, `mcp__github__create_issue`, `ToolSearch`; does **not** contain `mcp__github__search`; `assertRestrictable` |
| 2 | Same MCP reserves + `ToolSearch` | `tools: [mcp__github]` **and** a second agent `tools: [mcp__github__*]` | both expand to the two github tools + `ToolSearch`; `assertRestrictable` |
| 3 | No tool-search name reserved; reserve one MCP tool | `tools: [mcp__github__create_issue]` | allow contains the MCP name, does **not** contain `ToolSearch`; `assertRestrictable` |
| 4 | Nothing MCP reserved | `tools: [mcp__missing__foo]` | warn; captured filter is `{ allow: [] }` (not omitted); `assertRestrictable` (deny-all is legal) |
| 5 | `tools: [Read, Task, Bash]` with those names reserved | unchanged from today | allow contains `read`, `read_image`, `subagent`, `subagent_fork`, `bash`; `assertRestrictable` |
| 6 | `tools: [Read, Tas]` with `read`/`read_image` reserved | typo still dropped | `{ allow: ['read', 'read_image'] }` |
| 7 | Reserve `mcp__github__search` | `disallowedTools: [mcp__github__search]` | deny contains that name; `assertRestrictable` |
| 8 | No `tools` key | — | start request has **no** `toolFilter` |
| 9 | Bare `mcp__` | `tools: [mcp__]` | dropped + invalid-wildcard warn; `{ allow: [] }` |

Existing tests that only inspect captured filters stay. The `Tas` case no longer documents “empty allow omits restriction” — test 4 pins the new deny-all.

### README

Document: exact `mcp__*` public names, server-level `mcp__<server>` / `mcp__<server>__*` wildcards, auto-`ToolSearch` only when the ToolSearch tool is mounted, unmounted MCP names dropped, allow-list that matches nothing → child with zero tools (warn). Exact names must match the normalized public name (hash suffix when truncated).

After README edits: `pnpm run verify-translation-pairing --write packages/subagent/task/README.md`.

---

## Phase 2 — MCP tools through `ToolSearch`

**Files**
- `packages/mcp/mcp-client/src/tools.ts` — `syncTools`, `ToolBridgeOptions`, export `DEFAULT_DEFER_TOOL_THRESHOLD = 8`
- `packages/mcp/mcp-client/src/connection.ts` — pass default threshold; expose generation size on the handle
- `packages/mcp/mcp-client/src/index.ts` — stop counting `schemas()`
- `packages/mcp/mcp-client/tests/defer.spec.ts` (new; keep `mcp-client.spec.ts` on the eager path)
- `packages/mcp/mcp-client/package.json` — `@dsh-cc/tool-search` as **devDependency only**. Production code duck-types `ctx.get('toolSearch')`. **Do not** add it as a required peer; **do not** change `inject = ['tools']`.
- `packages/mcp/mcp-client/README.md` (+ zh; re-record pairing)
- `docs/cc-parity-matrix.md` MCP / ToolSearch / Subagents rows

### `ToolBridgeOptions`

```ts
deferToolThreshold?: number  // default DEFAULT_DEFER_TOOL_THRESHOLD (8)
```

`startConnection` passes the default. No plugin Config UI in v1; tests pass the option into `syncTools` directly. Threshold `0` = always defer when `toolSearch` is present (test knob).

Defer when **all** of:
- `ctx.get('toolSearch')` is defined (duck-type `{ registerDeferred(reg): () => void }`), and
- listed tool count `>= deferToolThreshold` (count the server's `tools/list` length, **including** alwaysLoad tools; a server of 8 where 7 are alwaysLoad still defers the remaining 1).

Otherwise every listed tool is eager `ctx.tools.register` (today). No `toolSearch` service ⇒ eager even at threshold 0.

### Per-tool alwaysLoad

`tool._meta?.['anthropic/alwaysLoad'] === true` ⇒ **eager `register`**, even on an over-threshold server. Do **not** use `registerDeferred({ alwaysLoad: true })` — that would pollute the ToolSearch pool. Resource-bridge tools (`syncResources`) stay eager and are untouched.

`fingerprintTools` already `stableStringify`s the raw tool objects, so a `_meta` flip already changes the fingerprint. Do not special-case it in the hasher; **do** assert it in tests.

### `syncTools` phase 2

Keep fetch / fingerprint-skip / dispose-previous-then-publish / whole-generation rollback.

Helper `publish(definition, mode)`:
- `eager`: `ctx.tools.register(definition)` (today).
- `deferred`: **first** `if (ctx.tools.get(publicName) !== undefined)` treat as namespace squat → throw into the existing conflict handler (rollback new disposers, previous already disposed, `registrationFailure` contain/throw). Then `toolSearch.registerDeferred({ name, description, searchHint: \`${serverName} ${rawName.replaceAll('_', ' ')} ${rawName}\`, activate: () => ctx.tools.register(definition) })`. Any throw from `registerDeferred` (e.g. duplicate reserve) also rolls back.
- Squat on the eager path remains `register()` throwing duplicate, same rollback.

Disposers map still keyed by publicName; deferred disposer is the `registerDeferred` return value (unwinds reservation + activated definition together).

Fingerprint skip unchanged (same client + same fingerprint → return `previous`, no dispose, no re-registerDeferred).

**Generation swap unloads activated tools.** Dispose previous first, then publish next. Reconnect (new client) and `tools/list_changed` (same client, new fingerprint) both drop previously ToolSearch-loaded MCP tools; the model must search again. Acceptable v1. Do not preserve activation across swaps. Stale-client executors cannot survive: old deferred entries are disposed before new ones are published, and `activate` is synchronous.

Duck-type, do not import `@dsh-cc/tool-search` from `src/`.

### `countServerTools`

Do **not** count `ctx.tools.schemas()` (deferred names are invisible there). Count the live generation the supervisor already owns:

- Add `toolCount(): number` on `ConnectionHandle` = `registrations.tools.disposers.size + registrations.resources.size` (MCP tools + resource-bridge tools this server owns; prompts are skills).
- `apply`/`connect` uses `handle.toolCount()` instead of scanning schemas. Delete `countServerTools` if unused.

`/mcp` display keeps showing how many capabilities the server currently publishes, including deferred ones.

### Known limits (document, do not fix)

- Per-server count, not context-window % (CC’s ~10%) and not cross-server aggregate (3×5-tool servers all stay eager).
- Activation is process-global (`tool-search` README).
- Programmatic `ctx.tools.execute` on a reserved-but-unactivated MCP name now fails “unknown”; no in-repo caller.
- Exact frontmatter MCP names must match the public (possibly hashed) name; server-prefix wildcards sidestep most of that.

### Tests — write these first (failing) in `defer.spec.ts`

Reuse `createMockClient` / `mountRegistry` patterns from `mcp-client.spec.ts` (copy the small helpers; do not export from the spec file). Mount `ToolRuntime` + (when testing defer) `DeferredToolRegistry` from `@dsh-cc/tool-search`. Default threshold 8 so existing 1–3 tool tests stay eager.

| # | Case | Assert |
|---|---|---|
| A | Default threshold, 2 tools, toolSearch present | both `get()` defined; schemas include both MCP names; spy `registerDeferred` **never called** |
| B | `deferToolThreshold: 0` (or 1 with 2 tools), toolSearch present | schemas do **not** include `mcp__srv__greet`; `get` undefined; `view().restrictableNames` has the name; `toolSearch.search('greet')` hits; `activate` then `get` + `execute` work |
| C | Over-threshold, one tool `_meta: { 'anthropic/alwaysLoad': true }`, sibling without | alwaysLoad in schemas immediately; sibling deferred |
| D | No toolSearch plugin, `deferToolThreshold: 0` | eager register (standalone fallback) |
| E | Deferred generation, identical second sync | spy `registerDeferred` not called again; same generation object |
| F | Description change under defer | new search text; **after swap, a previously `activate`d tool is gone from schemas and is searchable again** |
| G | **Forced defer** squat: pre-`register` `mcp__srv__taken`, `deferToolThreshold: 0` | sync contains (disposers.size 0); no leftover reservation of `mcp__srv__free` in `restrictableNames`; squatter `get('mcp__srv__taken')` still defined |
| H | Duplicate raw name in list | fetch-phase reject; nothing reserved |
| I | Two `syncTools` with **different client** objects, same payload, deferred | swap happens (existing reconnect invariant); old disposer gone, new reservation present |
| J | Resource tools with toolSearch present | `list_mcp_resources` / `read_mcp_resource` still in schemas — covered by existing `capabilities.spec.ts` / `capability-connection.spec.ts`; do not regress them |

Existing eager tests in `mcp-client.spec.ts` stay green under default threshold.

---

## Phase 3 — docs

- `packages/mcp/mcp-client/README.md` (+ zh): deferral, alwaysLoad, threshold, no-toolSearch fallback, swap unloads activations. Re-record pairing.
- `packages/subagent/task/README.md` (Phase 1 already).
- `docs/cc-parity-matrix.md`: MCP deferred above per-server threshold; named Task `toolFilter` accepts `mcp__*` and server wildcards. ToolSearch row: mcp-client is now a production caller.

---

## Explicitly out of scope

- Fork inheriting parent message prefix / skill-catalog history
- Per-conversation ToolSearch memory
- Context-window % threshold
- Cross-server aggregate threshold
- Skill progressive-disclosure changes
- Plugin Config / UI for the threshold

---

## Verification (pass criteria)

```
pnpm vitest run packages/subagent/task packages/mcp/mcp-client packages/core/tool-search
```

- Existing mcp-client e2e stays green (fixture servers are small → eager path).
- `mcp-client` `inject` remains `['tools']`.
- Named agent with `tools: [Read, mcp__github__create_issue]` and a reserved/registered github tool produces a `toolFilter` that `restrict()` accepts and that includes that MCP name.
- Over-threshold MCP server with `toolSearch` mounted: model-visible schemas omit deferred MCP tools until `ToolSearch`/`activate`.
