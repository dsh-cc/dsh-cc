# @dsh-cc/settings-ns

English | [中文](README.zh.md)

**Idempotent settings-namespace registration** for per-session preset mounts (design: docs/plans/2026-09-16-settings-namespace-idempotence.md). Preset plugins register their settings namespaces against the app-level shared `SettingsProvider` on every session mount; harness `register()` throws on a duplicate namespace, and during the create-before-dispose overlap window around `/clear` two mounts collide and the whole preset mount fails. This package provides two helpers — `registerNamespaceSafe` and `installSectionSafe` — that degrade duplicates to live reads and lazily re-acquire a namespace whose owning fiber died.

## API

```ts
export interface SafeRegisterOptions<T> {
  base?: Record<string, unknown>    // composition base layer passed through
  validate?: (value: T) => void     // cross-field validation passed through
}

export type SettingsReader<T> = () => T | undefined

export function registerNamespaceSafe<T>(ctx: Context, ns: SettingsNamespace, schema: z<T>, options?: SafeRegisterOptions<T>): SettingsReader<T>

export interface SectionHooks<T> { setSource; onChange; validate? }
export function installSectionSafe<T>(ctx: Context, ns: SettingsNamespace, schema: z<T>, entry: T, hooks: SectionHooks<T>): void
```

## Semantics

- **No provider → `undefined`.** Without `ctx.get('settings')` the reader returns `undefined` on every call; callers keep their graceful-degradation behavior.
- **Read-through source of truth.** The reader always resolves through `settings.get(ns)`, never a cached scope object, so a disposed owner cannot serve a stale frozen value. Assumes an object schema (`z.object(...)`): a legitimate resolved value is never `undefined`, which is what makes the self-healing trigger unambiguous.
- **Lazy self-healing.** When a read observes `undefined` and the setup-time context is still live, the reader re-registers with the same schema/options and re-reads — one register/unregister pair per lost owner.
- **Duplicate tolerance.** A `register()` throw matching `settings namespace "<ns>" is already registered` (pinned constant, spec-pinned against harness drift) degrades to the live provider read. Value-fidelity caveat: under dual module copies with different schemas, the degrade path serves the other copy's resolved value.
- **Stale readers never throw.** Re-acquisition on a disposed/unloading context (cordis `CordisError` code `INACTIVE_EFFECT`) degrades to `undefined` instead of throwing into a hot read path. Other register errors propagate.
- **`installSectionSafe` preflight.** If the namespace is already owned, the harness `installSection` is *not* called: the hooks are wired directly (`setSource` reads live `settings.get(ns)`; reloads come from the provider's public `settings/updated` commit event, filtered by namespace, inert once the caller ctx is unloading, unwound with the caller mount). The fresh path delegates unchanged. No re-registration after owner death — the consumer's existing fallback contract applies, identical to the harness's own provider-loss semantics.
- Read-only contract: the helpers return readers/wire hooks only; consumers needing write/watch keep calling the provider directly.

## Shape

Library package: no preset row, no capability-manifest entry. Consumed by the preset-row registrants with `workspace:^` in `dependencies` (launcher-closure guarantee), with the harness `@deepseek-ai/cordis` + `@deepseek-ai/dsh-settings` as peers.
