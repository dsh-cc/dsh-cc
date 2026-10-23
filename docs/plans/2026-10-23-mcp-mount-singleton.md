---
date: 2026-10-23
status: design — blind review in progress
---

# MCP mount singleton: collapse the per-preset standing mounts into a host-level registry

## Background

With both `preset-cc` and `preset-vwa` declared in `packages/bundle/cc-tui/cordis.patch.yml` (order 5 / order 6), the harness agent-preset-registry **standing-mounts each preset eagerly** (`activate(record)` → `mountPreset(scope.ctx, id, plugins)`, harness `packages/preset/agent-preset-registry`). Both preset trees include the shared body `packages/preset/cc/agent.shared.cordis.yml` — and therefore the entire `cc-services` group with its `cc-shell-glue` row — **twice in the same runtime**.

## Root cause (live-verified 2026-10-23)

The `mcp-client` plugin reserves its `serverName` against a **process-global** set keyed by `ctx.root`:

```ts
// packages/mcp/mcp-client/src/index.ts
ctx.effect(() => {
  let names = activeServerNames.get(ctx.root)
  // …
  if (names.has(config.serverName)) throw new Error(
    `mcp-client: serverName "${config.serverName}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`
  )
})
```

The first standing mount (cc) registers all three servers (`context7`, `serena`, `sequential_thinking`) and spawns their processes. The second standing mount (vwa) fails the reservation check for every server — the glue's per-server `try/catch` logs a `logger.warn` and swallows it (`packages/bundle/cc-shell/src/index.ts:219-221`). Because `cc-shell-glue` also provides the `mcpConnections` registry from its own `cc-mcp-connections` child fiber **inside the preset isolate realm**, the vwa tree ends up with its own **empty** registry instance, and `/mcp` (mounted from the same vwa tree) reads that empty registry.

This is the same "shared row in a preset body must be register-if-absent" class that the workflow-journal `DUPLICATE_PROVIDER` fix already solved (`agent-preset-composition-mechanics` memory, P1a `583721ba`). The MCP row was the remaining un-guarded one.

### Why the two trees diverge

- **cc-mode** session binds the cc standing tree → sees the **populated** registry.
- **vwa-mode** session binds the vwa standing tree → sees the **empty** registry.

The user-visible symptom: `mcp__*` tools disappear in vwa sessions; `/mcp` prints `No MCP servers are registered.` even though the processes are running under the cc tree.

### Why existing tests miss it

All existing composition / integration tests mount **one** preset tree (`preset-cc` only). There is no dual-preset composition test. `packages/mcp/mcp-client/tests/defer-startup-connect.spec.ts` and `packages/bundle/cc-shell/tests/mcp-seam.integration.spec.ts` both operate under a single `McpConnectionsService`.

## Design goals

1. **One `mcpConnections` registry per runtime, visible from every preset tree.** A vwa session must see the same registry and tools as a cc session.
2. **One set of MCP server processes per runtime.** No duplicate spawn on a second preset standing mount.
3. **No behavioral change for single-preset deployments.** cc-mode boot today already works; the fix must be a no-op there.
4. **Keep plugin-declared `mcpServers` working** — plugin mounts that go through the plugin-mcp seam must also land in the singleton registry.
5. **Fail-open for the second mount.** If a second preset tree asks to mount an already-mounted server, it must become a no-op (idempotent), never an error, never a second process.

## Architecture: root-realm singleton registry + idempotent root mount

The `ccPluginManager` service already demonstrates the idiom in this codebase: publish a session-level service from the **root realm** via `ctx.root.provide`, with register-if-absent against the root store, and a fiber-scoped cleanup that only clears the publication on the last owner. We extend that idiom to the MCP registry and the per-server mcp-client fibers.

### A. Root-realm singleton registry

In `packages/bundle/cc-shell/src/index.ts`, replace the per-tree child-fiber registry:

```ts
// before
if (ctx.get('mcpConnections') === undefined) {
  await ctx.plugin({
    name: 'cc-mcp-connections',
    apply(c: Context) {
      new CcMcpClient.McpConnectionsService(c)
    },
  })
}

// after
const mcpConnections = ensureMcpConnections(ctx.root)
```

`ensureMcpConnections` (new helper, exported from `@dsh-cc/bundle-shell`) uses the same register-if-absent pattern as `CcPluginManagerService`:

```ts
// F4 + Grok blocker 1: Service constructor self-provides; no extra root.provide.
// Grok delta fold #1: the helper must be async — the child fiber must be ACTIVE
// before any mcp-client mounts, otherwise mcp-client's `ctx.get('mcpConnections')
// ?? new McpConnectionsService(ctx)` (index.ts:235-238) self-provides from the
// preset fiber and trips leakedServices once the isolate key is removed.
export async function ensureMcpConnections(root: Context): Promise<McpConnectionsService> {
  const key = root[Context.isolate]['mcpConnections']
  const existing = key === undefined ? undefined : root.reflect.store[key]
  if (existing !== undefined) return existing.value as McpConnectionsService
  let mounted: McpConnectionsService | undefined
  await root.plugin({
    name: 'cc-mcp-connections',
    apply(c: Context) {
      mounted = new McpConnectionsService(c)
    },
  })
  return mounted!
}
```

> **F4 (critic) + Grok blocker 1 + Grok delta fold #1 — combined fix:** the Service constructor self-provides on its fiber, so the helper constructs it inside an awaited `root.plugin` child fiber; no extra `root.provide`. The helper is **async** and must be awaited **before** `plugins.mountAll()` and **before** any `mcp-client` mount — otherwise the `mcp-client` lazy fallback (`index.ts:235-238`) self-provides from the preset fiber into the root isolate key, which trips `leakedServices` once `mcpConnections` is no longer isolated. The store-access idiom (`root[Context.isolate][key]` + `root.reflect.store[key]` + `.value`) matches `ccPluginManager.ts:56-57` and `ccPlugins.ts:131-132`.

The helper **does not** hold an ownership link to any preset fiber — it lives on the root fiber. Because the service is now root-published, we **remove `mcpConnections: true` from the `cc-services` isolate map** in `packages/preset/cc/agent.shared.cordis.yml`. The roster comment already documents this exact trade-off: "`ccPlugins` is deliberately NOT isolated: the glue publishes it into the ROOT realm from the root fiber … isolating the name here would shadow that publication." The same reasoning now applies to `mcpConnections`.

> **Crossing the isolate boundary is safe.** Cordis service lookup climbs the fiber parent chain until it hits an isolate-key mismatch. A non-isolated root service is visible from inside every isolate group. `ccPlugins` proves this in production today.

> **F5 from critic — files that must change in lockstep with the isolate map removal:** `packages/preset/cc/tests/composition.spec.ts:233-240` (isolate-map `toEqual` assertion), `packages/bundle/cc-shell/tests/leaked-services.spec.ts:18-28` (`CC_SERVICES_ISOLATE` list), and the roster comment block in `agent.shared.cordis.yml:328-336` that currently claims "without mcpConnections isolated here it would break the preset" — that comment becomes false and must be rewritten. `packages/bundle/cc-shell/README.md:12` and the corresponding `:439`/`:450` comment anchors in the roster file need the same treatment.

### B. Idempotent per-server root mount

The `cc-shell-glue` `.mcp.json` mount loop becomes:

```ts
for (const file of files) {
  if (!existsSync(file)) continue
  try {
    const body = JSON.parse(readFileSync(file, 'utf8')) as McpConfigFile
    const registrations = buildRegistrations(body, { env: process.env, deferStartupConnect: true })
    for (const server of registrations) {
      try {
        // idempotent per serverName: second preset tree becomes a no-op
        await mountMcpServerOnce(ctx.root, CcMcpClient, server)
        deferredNames.push(server.serverName)   // ← F4/Grok blocker 4: keep this
        results.push(`mcp server ${server.serverName} mounted from ${file}`)
      } catch (error) {
        ctx.logger.warn(`cc-shell-glue: failed to mount MCP server ${server.serverName} from ${file}: ${String(error)}`)
      }
    }
  } catch (error) {
    ctx.logger.warn(`cc-shell-glue: failed to mount MCP config ${file}: ${String(error)}`)
  }
}
```

> **Grok blocker 4 + F4 (critic):** the per-server `try/catch` must be **kept** (a bad server must not skip the rest of the file) and `deferredNames.push(...)` must stay so §D's pending notice still fires. The original draft dropped both.

`mountMcpServerOnce` (new helper, exported) wraps `ctx.plugin` with a root-keyed in-flight map:

```ts
const mountedMcpServers = new WeakMap<Context, Map<string, Promise<void>>>()

export async function mountMcpServerOnce(
  root: Context,
  plugin: unknown,      // CcMcpClient module
  config: unknown,      // one registration from buildRegistrations
): Promise<void> {
  let perRoot = mountedMcpServers.get(root)
  if (perRoot === undefined) {
    perRoot = new Map()
    mountedMcpServers.set(root, perRoot)
  }
  const name = (config as { serverName: string }).serverName
  const inFlight = perRoot.get(name)
  if (inFlight !== undefined) return inFlight
  const p = root.plugin(plugin, config)
  perRoot.set(name, p)
  // Grok blocker 2: ctx.plugin returns a Fiber (PromiseLike) with no .catch —
  // use Promise.resolve to get a real Promise before attaching the rejection handler.
  Promise.resolve(p).catch(() => perRoot.delete(name)) // clear on failure so a retry can re-attempt
  await p
}
```

Note: `mountedMcpServers` lives at module scope in `@dsh-cc/bundle-shell`, keyed by the root context, so it is shared across both preset standing mounts (same process, same root). The `perRoot.delete(name)` on failure keeps the door open for a future reconnect, matching the "fail-open for the second mount" goal.

### B′. ToolSearch deferral — **hoisted to root** (user-approved)

The root-mounted `mcp-client` fibers register their tools into the **root** `tools` service. Because the fiber is a child of root, it **cannot see the isolated `toolSearch` seam** (which lives in the `cc-services` isolate group). To preserve the deferral semantics (serena's 16 tools stay hidden until ToolSearch activation), we **hoist `toolSearch` to root** alongside `mcpConnections`:

- **Remove `toolSearch: true` from the `cc-services` isolate map** in `packages/preset/cc/agent.shared.cordis.yml`.
- The `tool-search` plugin row in the same group stays in place (it provides the seam), but its publication now lands on the root realm because the isolate key is gone. The plugin's own row does not change; the removal of the isolate key is sufficient.

With `toolSearch` visible from root, `mcp-client`'s `defer.ts` can resolve it and defer servers with ≥8 tools (e.g. serena) exactly as before — but now the deferral state is **shared across both preset trees** (one runtime, one activation state), which is the correct semantic for runtime resources.

### B″. The second preset tree still registers its own glue — just not the servers

The `cc-shell-glue` row still mounts in both trees (it owns the per-tree command mounting, plugin loading, etc.). Only the **`.mcp.json` server mounting** becomes a root singleton. The glue's `deferredNames` array and its per-tree `results` log entries are unchanged; the second tree's loop simply no-ops on the already-mounted server names (the `await mountMcpServerOnce` returns the shared in-flight promise, and the `deferredNames.push` still records the name so the notice logic works).

### C. Plugin seam keeps its own mount (unchanged today), with a boot-order caveat

**Why not route the seam through `mountMcpServerOnce`:** the seam's contract is a **synchronous disposer** returned from `registerServer` (`mcpSeam.ts:64-105`), plus a dispose-settle ledger that serializes same-name re-registration when a plugin is unloaded and re-mounted (`ccPlugins.rescan()`, `/reload-plugins`). A blind `await mountMcpServerOnce(ctx.root, …)` would (a) drop the dispose channel, leaking the server process on plugin unload, and (b) make the ledger's "dispose-settle before re-attach" invariant impossible to keep because the helper's success entries are never cleaned.

The seam keeps its existing `ctx.plugin(CcMcpClient, …)` path **unchanged**, including its disposer and ledger.

**Boot-order caveat (Grok delta NEW):** the glue's call order is `plugins.mountAll()` (which drives the seam) **before** the `.mcp.json` loop (`index.ts:169` vs `index.ts:209`). A naive pre-flight `registry.entries().some(e => e.name === serverName)` at plugin-attach time will therefore **miss** config servers on the first tree (they haven't been registered yet) and **hit** them on the second tree. The collision is still caught correctly by the `serverName` reservation + the seam's own ledger; the pre-flight is only needed for the second tree's plugin servers and for post-boot `/reload-plugins`. The comment in the seam must state this explicitly; optionally it may also consult `mountedMcpServers` to catch in-flight config mounts.

No other change to the seam. The seam's servers and the config servers share the same **root registry** via §A, so `/mcp` sees the union of both.

### C′. Disposal contract of the singleton mount (F2 from critic)

`mountMcpServerOnce` does **not** own the mounted fibers' lifetime — the root fiber does. The helper only tracks the *in-flight mount Promise* so a second preset tree does not double-mount. When the root fiber eventually tears down (process exit), cordis disposes the root children, and each `mcp-client` fiber's own effect disposer releases its `serverName` reservation and disconnects. There is intentionally no per-preset "release" channel: `.mcp.json` servers are runtime-scoped, not preset-scoped.

If a future caller needs to *unload* a config-mounted server (e.g. a future `/mcp unload`), the helper must be extended with a refcounted `{ ready, release }` API. That is out of scope for this fix; the current design intentionally keeps the `.mcp.json` path runtime-scoped and non-unloadable, matching the existing behavior (the `.mcp.json` path has no unload hook today either).

### D. One notice per runtime, not per tree

Each preset tree currently registers its own `agent/created` one-shot listener with a tree-local `fired` closure (`index.ts:243-260`). Because both trees mount the glue, the first agent creation would fire **two** listeners, inject the "MCP: still connecting — …" notice twice, and mount `mcpReadyNotice` twice.

The notice is runtime-scoped, so we hoist it to the root: a root-keyed `WeakSet` (or a boolean on the shared registry) marks "notice already fired for this process". The glue's `agent/created` handler checks the shared mark before injecting:

```ts
// inside the glue's agent/created handler
const registry = ctx.get('mcpConnections') as McpConnectionsService | undefined
if (registry === undefined || noticeFired.has(registry)) return
noticeFired.add(registry) // one per process, shared across preset trees
// … rest unchanged: pending filter reads registry.entries(), inject, mountMcpReadyNotice …
```

`noticeFired` is a module-scope `WeakSet<McpConnectionsService>` in `@dsh-cc/bundle-shell`. Because both trees share the same registry instance (§A), the second tree's handler sees the mark and no-ops. The `deferredNames` array stays tree-local (each tree records what *it* tried to mount), but the shared notice only fires once.

### E. No changes to `mcp-client` itself

The `serverName` reservation in `mcp-client` is correct: two live instances with the same name in one scope would be a real collision. We simply prevent the second preset tree from ever calling it, via the singleton mount helper.

### F. Dual-preset composition test — must go in a **real-boot** spec, not `composition.spec.ts`

`packages/preset/cc/tests/composition.spec.ts` only parses YAML and asserts row ordering — it cannot compose plugins. The dual-preset assertion must live in a spec that actually boots the composition (e.g. `packages/preset/cc/tests/vwa-lane2.real-boot.spec.ts` or a new `dual-preset.boot.spec.ts` in the same package).

The test composes both `preset-cc` and `preset-vwa` against the shared body (via include) and asserts:

1. `ctx.get('mcpConnections')` is defined in both trees' scopes and returns the **same instance**.
2. A single `.mcp.json` with one `stdio` server mounts exactly **one** `mcp-client` fiber under the root (the second tree's mount is a no-op).
3. `mcpConnections.entries()` is non-empty after boot.
4. The vwa tree's `/mcp` command (mounted via the shared body's `command-mcp` row) lists the same entries as the cc tree.

> **Grok major:** `composition.spec.ts` is the wrong place — it parses YAML only. The assertion must boot the composition.

## Out of scope

- The plugin-mcp seam's gating / `ClaudeOnlySource` notices (existing behavior, unchanged).
- The `mcpLoadClaudeFiles` config knob (unchanged).
- Harness `dsh-agent-preset-registry` behavior (upstream-owned, unchanged).

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Root-published registry survives a preset retirement | The registry is intentionally runtime-scoped (root fiber), not preset-scoped. Preset retirement does not tear down the MCP servers. |
| Second preset tree tries to mount while the first is still `connecting` | `mountMcpServerOnce` reuses the in-flight promise — the second mount awaits the same connection. |
| A server name is re-used by a different config later | `mountMcpServerOnce` does not re-mount an already-mounted name; the first registration wins. This matches the existing serverName guard semantics. |
| `mcpConnections` is no longer isolated | The roster comment and the `ccPlugins` precedent make this safe; the service is a runtime singleton, not per-preset state. |
| Root-mounted tools bypass per-preset `toolSearch` deferral | **User-approved hoist** (§B′): `toolSearch` is removed from the isolate map alongside `mcpConnections`, so the root-mounted `mcp-client` can see it. Deferral semantics preserved; activation state is shared across trees. |
| `ensureMcpConnections` must be awaited before `plugins.mountAll()` | **Fixed in §A** (Grok delta fold #1): the helper is `async`; the call site awaits it before any mcp-client mount, preventing the lazy fallback from self-providing into the root isolate key and tripping `leakedServices`. |
| Plugin seam pre-flight can't distinguish config vs plugin at boot | **Documented in §C** (Grok delta NEW): the boot order is `plugins.mountAll()` before the `.mcp.json` loop, so the pre-flight only fires for second-tree plugin servers and `/reload-plugins`. The `serverName` reservation still catches first-tree collisions. |
| Per-server `try/catch` lost in the new loop | **Fixed in §B** (Grok blocker 4): the loop keeps the inner `try/catch` and the `deferredNames.push`. |
| Double "still connecting" notice | **Fixed in §D** (critic F3): a shared `WeakSet` on the registry dedupes the notice across trees. |
| Plugin seam disposer contract broken | **Fixed in §C** (critic F1 + grok blocker 3): the seam keeps its own `ctx.plugin` mount and disposer; only a pre-flight collision check is added. |

## Verification

- New composition test with dual-preset mount (see §F).
- Existing single-preset tests (`defer-startup-connect.spec.ts`, `mcp-seam.integration.spec.ts`) continue to pass unchanged.
- Manual dogfood: boot the `tui` profile in **vwa mode** in a worktree, run `/mcp`, confirm the registry lists the three servers and `mcp__serena__*` tools are present.

## Status

**Design — user-approved after round-2 blind review.** Critic GO-WITH-CHANGES (8 findings, all folded); grok GO-WITH-CHANGES (4 blockers + 2 majors, all folded; delta round: 4 folds OK, 2 PROBLEM re-folded, 2 NEW documented). User confirmed the two architecture forks: (1) root singleton + isolate key removal for `mcpConnections`, (2) **hoist `toolSearch` to root** to preserve deferral semantics. Ready for implementation.
