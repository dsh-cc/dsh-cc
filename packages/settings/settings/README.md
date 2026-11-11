# @dsh-cc/settings

English | [中文](README.zh.md)

The settings layer in one package, three entry points:

| Entry point | What it is |
|---|---|
| `@dsh-cc/settings` | The vendored `SettingsProvider` contract (harness 0.1.5-rc.1 seam) with a no-op `configure()` facade. |
| `@dsh-cc/settings/ns` | Idempotent namespace registration on top of that provider: `registerNamespaceSafe`, `installSectionSafe`, `readUserSection`. |
| `@dsh-cc/settings/cascade` | The Claude Code settings cascade: layer merge, env split, hot reload, persist. |

The three were separate packages (`settings-provider`, `settings-ns`,
`settings-cascade`) with a strictly linear dependency chain — ns and cascade
both existed only to build on the provider, and nothing else could consume one
without the other. They are now one package with three entry points; the
subpath names are the only thing consumers had to change.

`@dsh-cc/settings/cascade` also carries the two narrower entries consumers
import instead of the whole cascade: `./cascade/local-root` (which settings
directory a project resolves to) and `./cascade/permissions`.

## Provider surface

`SettingsProvider` is the vendored contract, decoupled from the harness
settings package so dsh-cc can evolve it. `configure(presentation, owner)` is
an intentional no-op facade (dsh-cc settings are the CC JSON cascade, not
rc.2 profile-patch forms), accepted so upstream callers mount unchanged.

A namespace is registered per provider instance — `get(ns)` is `undefined`
until then, `update(ns, …)` throws. `register()` throws
`settings namespace "<ns>" is already registered` on a duplicate; that message
has exactly one author, `duplicateRegistrationMessage`, and the matcher
`isDuplicateRegistration` is the function used by both the throw site and
`@dsh-cc/settings/ns`.

## Namespace surface (`./ns`)

Preset plugins register their settings namespaces against the app-level shared
provider on every session mount; harness `register()` throws on a duplicate
namespace, and during the create-before-dispose overlap window around `/clear`
two mounts collide and the whole preset mount fails. This entry provides two
helpers — `registerNamespaceSafe` and `installSectionSafe` — that degrade
duplicates to live reads and lazily re-acquire a namespace whose owning fiber
died.

Contracts:

- **Deferral.** With no provider yet (its async init settles during the mount
  sweep), registration is deferred to the provider's injectable arrival rather
  than degrading to undefined reads forever.
- **Duplicate tolerance.** A duplicate `register()` throw degrades to the live
  provider read. Value-fidelity caveat: under dual module copies with different
  schemas, the degrade path serves the other copy's resolved value.
- **Re-acquisition.** When the owning fiber dies the namespace is re-registered
  on the next read; the previous owner's frozen scope is never served.
- **Unloading.** A fiber mid-unload (`INACTIVE_EFFECT`) yields `undefined`
  instead of a throw.

## Cascade surface (`./cascade`)

Layered resolution (managed → user → project → local → env), the CC key
aliasing whitelist, hot reload with last-good-document retention, and
persistence with conflict detection (`SettingsConflictError` on a stale
revision).
