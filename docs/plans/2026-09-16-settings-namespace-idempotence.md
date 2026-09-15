# Idempotent Settings-Namespace Registration: a Shared Guard for Per-Session Preset Mounts

**Status:** **Implemented** — critic cold review 2026-09-16 incorporated (B1, M2,
M3, M4 incorporated pre-implementation; M1's `INACTIVE_EFFECT` class covered by
defensive catch + `isUnloading` pre-check). Implementation notes beyond the plan:
the reader serves a register-returned scope only after a re-acquisition **in the
same read call** — the resume-pins spec fixture boots a provider whose
provider-level `get` is disconnected from its `register` (pinned in
`settings-ns/tests/unit.spec.ts`), while the integration spec pins that a stale
reader from a disposed mount never serves the previous scope's frozen value.
**Date:** 2026-09-16
**Worktree:** `.claude/worktrees/side-queries` (branch `worktree-settings-ns-idempotence`)

## 1. Problem

`/clear` (and `/resume` to another session, same path) fails with:

```
Start failed: agent-presets: preset "cc" failed to mount:
settings namespace "cc-context-compression" is already registered
  (…and four more: model-aliases, subagents-resume, cc-handoff, cc-reasoning-fold)
```

### Root cause chain (verified in code)

1. `startFreshSession` (`packages/ui/tui/src/harness/driver-sessions.ts`) creates the
   new agent handle **before** disposing the old one — a deliberate property from
   PR #89 (a failed create must leave the old session intact). The two agents are
   briefly both live.
2. Harness `agent-presets` mounts the cc preset **under each agent's scope
   context** — a second session mounts the same composition a second time.
3. Preset plugins register their settings namespaces against the **app-level shared
   `SettingsProvider`**. Harness `settings.register()` throws on a duplicate
   namespace; the mount audit rejects root-realm *services* but cannot see
   settings registrations, so this process-global side effect is invisible to it.
4. During the overlap window the packages that call `settings.register()`
   **unguarded** collide, the group fails, and the whole preset mount fails.

The same collision class already bit at first boot under dereferenced profile
installs (dual module copies of `settings.ts`, each with its own WeakMap) — that was
PR #79, which added a try/catch guard to `tool-use-summary` only. This design
extracts the #79 guard into a shared, self-healing helper and migrates every preset
registrant to it — including the eighth registrant the first draft missed:
`permission-rules`, whose `installSection` call internally reaches the same throwing
`register()` (critic finding B1).

### Known tradeoff in the #79 guard that this design removes

The #79 fallback reader is `() => settings.get(ns)`. If the first registrant's fiber
later disposes (exactly what happens when the old agent is torn down after `/clear`),
`settings.get(ns)` returns `undefined` and the new session silently loses the user's
settings overlay for the rest of its lifetime. The shared helper below closes this
hole with lazy re-acquisition.

## 2. Design

### 2.1 New package: `@dsh-cc/settings-ns`

Location `packages/settings/settings-ns/`, version `0.7.1`, publishable,
README trio, same package shape as `@dsh-cc/side-query`. Dependencies: peer
`@deepseek-ai/cordis` + `@deepseek-ai/dsh-settings` (floor `>=0.1.5-rc.1`);
devDependencies link the harness local copies via the established
`link:../../../../deepseek-harness/...` idiom.

Two public exports: `registerNamespaceSafe` (plain registrations) and
`installSectionSafe` (the `installSection` seam used by `permission-rules`).

```ts
export interface SafeRegisterOptions<T> {
  /** Composition base layer passed through to the provider. */
  base?: Record<string, unknown>
  /** Cross-field validation passed through to the provider. */
  validate?: (value: T) => void
}

export type SettingsReader<T> = () => T | undefined

export function registerNamespaceSafe<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  options?: SafeRegisterOptions<T>,
): SettingsReader<T>
```

### 2.2 `registerNamespaceSafe` semantics

Ownership model (corrected per critic M2 — cordis service shadowing): the provider
reference the helper captures is a **per-caller-context shadow**; effects created
through it bind to the **setup-time mount's context**, deterministically — not to
"whoever reads". Consequences:

- Re-acquisition always runs through the setup-time ctx and is only possible
  while that ctx is live. There is no random-fiber churn scenario.
- A dead mount's stale reader can never re-acquire — it must degrade, not throw
  (M1 below).

Behavior:

- **No settings provider mounted** → reader returns `undefined` on every call
  (callers keep their existing graceful-degradation behavior).
- **Read-through source of truth**: the reader always resolves through
  `settings.get(ns)`, never through a cached scope object — a disposed owner's
  scope returns a stale frozen `resolved`, while `settings.get(ns)` returns
  `undefined` the moment the registration is gone. All migrated namespaces use
  object schemas (`z.object(...)` — verified for all sites), so a legitimate
  resolved value is never `undefined`; the helper documents this constraint.
- **Lazy self-healing re-acquisition**: when a read observes `undefined` and the
  setup-time ctx is still live, the reader attempts `settings.register(ns,
  schema, options)` again and re-reads. Bounded churn: one register/unregister
  pair per lost owner.
- **Inactive-ctx tolerance (critic M1)**: re-acquisition on a disposed/unloading
  ctx throws `CordisError('INACTIVE_EFFECT')`. The reader catches this class of
  failure (checked before re-acquiring via the harness `isUnloading` pattern,
  and defensively around the register call) and returns `undefined` — the same
  degradation as the no-provider case. A stale reader must never throw into a
  hot read path.
- **Duplicate-registration tolerance**: a `register()` throw matching the exact
  harness message `settings namespace "<ns>" is already registered` (pinned
  string, noted as harness coupling) means another mount owns the namespace —
  the reader serves `settings.get(ns)` for this read and retries acquisition on
  the next read that observes `undefined`. Any other error propagates. Value
  fidelity caveat (critic m3): under dual module copies with *different*
  schemas, the degrade path serves the other copy's resolved value — same as
  the #79 status quo, documented in the helper docstring.
- **Per-shadow memoization**: a module-level WeakMap keyed by the settings
  shadow avoids pointless re-register churn within one module copy. The
  try/catch — not the WeakMap — is the cross-module-copy protection (a
  different shadow means a different WeakMap key).
- **Read-only contract**: the helper returns a reader only. Consumers that need
  write/watch keep calling the provider directly (all migrators verified
  read-only; executor re-verifies per site during migration).

### 2.3 `installSectionSafe` semantics (permission-rules, critic B1)

`permission-rules` (`packages/interaction/permission-rules/src/index.ts`) calls
`sctx.settings.installSection(ctx, ns, schema, entry, hooks)` per-agent mount;
harness `installSection` internally calls the throwing `register()`, so once the
other sites are guarded this becomes the next `/clear` failure. A wrapper in the
same package:

1. **Pre-flight**: if `settings.get(ns)` is not `undefined` (namespace already
   owned — either the overlap window or a dual module copy), do NOT call
   `installSection`. Instead wire the consumer's hooks directly:
   `hooks.setSource(() => settings.get(ns))` plus reload notification through the
   provider's public `settings/updated` event (committed values fan out as
   `(ns, next, prev, source)`; harness `settings/src/index.ts` commit), filtered
   by namespace and guarded by the consumer's `isUnloading` idiom. Register the
   event listener as an effect on the caller ctx so it unwinds with the mount.
2. **Fresh path**: call `installSection` unchanged (it already handles its own
   attach-time `onChange` and provider-loss fallback).
3. When the owning registration later disappears (owner disposed after `/clear`),
   `settings.get(ns)` returns `undefined` → the consumer's existing fallback
   contract applies (Config rules only), matching the harness's own
   provider-loss semantics. `installSectionSafe` does not attempt re-registration
   (the `installSection` hook surface — setSource/onChange/validate — belongs to
   the first owner; a silent second owner would double-fire `onChange` into two
   live consumers. Accept the degradation: permissions fall back to Config +
   schema defaults, same as today's provider-loss path).

### 2.4 Migration (eight registrants)

Each package keeps its public `registerSettings`/`apply` signature and its
reader/defaults-merging behavior (including the `reasoning-fold` convention of
returning a `undefined` reader when no provider is mounted — critic m2); only the
registration internals switch to the shared helpers. Options are re-verified
against each site's code during migration, not taken from this table (critic M3).

| Package | Site | Helper | Register options |
| --- | --- | --- | --- |
| `@dsh-cc/context-crusher` | `src/settings.ts` `registerSettings` | `registerNamespaceSafe` | `validate` only (base stays in the reader closure) |
| `@dsh-cc/model-aliases` | `src/service.ts` `apply` | `registerNamespaceSafe` | `validate` |
| `@dsh-cc/reasoning-fold` | `src/settings.ts` `registerProbeSetting` | `registerNamespaceSafe` | — |
| `@dsh-cc/handoff-store` | `src/settings.ts` `registerSettings` | `registerNamespaceSafe` | — |
| `@dsh-cc/resume-pins` | `src/plugin.ts` inline registration | `registerNamespaceSafe` | — |
| `@dsh-cc/prompt-suggest` | `src/settings.ts` `registerSettings` | `registerNamespaceSafe` | — |
| `@dsh-cc/tool-use-summary` | `src/settings.ts` `registerTusSettings` | `registerNamespaceSafe` | — (replaces the vendored #79 guard; its `?copy2` spec stays as integration proof) |
| `@dsh-cc/permission-rules` | `src/index.ts` `installSection` call | `installSectionSafe` | n/a |

`compaction-micro` delegates to `registerTusSettings` — covered via
tool-use-summary, no separate site (critic m5).

Dependency direction: each migrator gains `@dsh-cc/settings-ns` in
**dependencies** (`workspace:^`) — the #77 lesson: preset-row packages must be
provided by the launcher closure, and `dependencies` (not `peerDependencies`)
is the precedent that guarantees it.

### 2.5 Explicitly out of scope

- Changing `startFreshSession`/`switchSession` ordering (dispose-before-create
  would sacrifice PR #89's failed-create-keeps-old-session property).
- Harness-side changes (per-agent preset mount reuse, registration visibility
  in the mount audit, `installSection` growing its own duplicate tolerance) —
  upstream proposals only; the harness repo is read-only by directive.
- Migrating non-preset registrants (settings-cascade's own consumers) — their
  lifetimes do not overlap.

## 3. Test plan (TDD)

Tests are written first and must fail against the un-migrated code.

### 3.1 `settings-ns` unit specs (fake providers)

1. **no provider** — reader returns `undefined`, `register` never called.
2. **first registration** — fake provider records the call; reader returns the
   provider's resolved value.
3. **duplicate registration** — second `registerNamespaceSafe` (fresh module
   state via `?copy2`) does not throw; reader reads the existing registration.
4. **owner disposal self-healing** — after the provider drops the registration,
   the next reader call re-registers and returns the fresh value.
5. **error pass-through** — a non-duplicate `register` throw propagates.
6. **options pass-through** — `base`/`validate` reach the provider.
7. **installSectionSafe fresh path** — delegates to the provider's
   `installSection` with identical arguments.
8. **installSectionSafe pre-flight** — namespace already registered → no
   `installSection` call; `setSource` and the `settings/updated` event path are
   wired; listener unregisters with the caller ctx.

### 3.2 Real-cordis integration specs (critic M4 — fake providers cannot see
fiber binding or shadowing)

Using the harness `FileSettingsProvider` (or an in-memory
`SettingsProvider` subclass) with **real cordis contexts** and the harness
`agent-presets/tests/settings.spec.ts` `harness()` idiom:

1. **double mount, shared provider** — two live plugin mounts registering the
   same namespace: the second does not throw; both readers observe the same
   value.
2. **owner disposal, live survivor** — dispose the first mount's fiber; the
   second mount's reader (live ctx) re-acquires on next read and observes the
   user-layer value — not defaults.
3. **stale reader degrades, never throws** — hold a reader from the disposed
   mount; reads return `undefined` (no `INACTIVE_EFFECT` escape).
4. **permission-rules double mount** — the `installSectionSafe` wrapper under a
   real provider: second mount falls to the event-wired path and still reloads
   on a settings write to the namespace.

A tui-level `/clear` end-to-end regression would be ideal but requires a full
agent boot in-test; the double-mount integration specs above cover the failure
mechanism (create-before-dispose × shared provider). The final manual check is
a real `/clear` in a booted session before merge.

### 3.3 Per-migrator regression specs

Per package, using its existing fake-provider idiom: run the registration path
**twice against the same provider** — the second must not throw, and both
readers observe the same value. Existing package specs stay green unchanged
(public behavior preserved).

### 3.4 Integration proof

- `smoke:profile-boot` on the migrated tree (the #77/#79 class catcher).
- Full presubmit battery: `tsc -b`, `check:spec-deps`, `check:readme` (new
  package trio), `check:publish`, capability/parity gates (update
  `docs/claude-code-capabilities.yaml` only if a documented surface changes —
  expected: no entry changes; the gate decides), preset composition specs.
- Manual `/clear` in a booted cc-tui session on the migrated tree.

## 4. Risks

- **Re-acquisition only from a live setup-time ctx** (M2): a stale reader
  degrades to `undefined` (defaults) rather than throwing — strictly better
  than both the bare registration (throws) and #79 (stale frozen value served
  from a dead scope object).
- **`settings.get(ns)` as liveness signal** relies on object-schema namespaces
  (resolved never legitimately `undefined`) — asserted by per-package specs;
  the helper documents the constraint.
- **`installSectionSafe` degradation**: after the owning session dies,
  permission settings fall back to Config + schema defaults until the next
  mount re-registers — identical to the harness's own provider-loss contract
  for this consumer.
- **Harness coupling**: the exact duplicate-registration message and the
  `settings/updated` event name are pinned in specs so upstream drift fails
  loudly in CI, not silently in production.
- **New npm package** — release machinery auto-includes it (directory walk);
  only +1 package against the npm new-package quota; README trio and lockfile
  registration are the known toil.

## 5. Delivery

Single PR on `worktree-settings-ns-idempotence`, commit-per-slice:
1. new package + its specs;
2. eight migrations, each with its regression spec;
3. real-cordis integration specs;
4. docs (this file status true-up) + gates pass. No version bumps (0.7.1 line,
   release machinery owns bumps).
