/**
 * Idempotent settings-namespace registration helpers (design:
 * docs/plans/2026-09-16-settings-namespace-idempotence.md).
 *
 * Preset plugins register their settings namespaces against the app-level
 * shared `SettingsProvider` on every session mount. Harness `register()`
 * throws on a duplicate namespace, and during the create-before-dispose
 * overlap window around `/clear` two mounts collide, failing the whole preset
 * mount. These helpers degrade duplicates to live reads and lazily
 * re-acquire a namespace whose owning fiber died.
 *
 * @module @dsh-cc/settings-ns
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import type { SettingsNamespace, SettingsProvider, SettingsRegisterOptions } from '@deepseek-ai/dsh-settings'

/** Composition base layer and cross-field validation passed through to the provider. */
export interface SafeRegisterOptions<T> {
  /** Composition base layer passed through to the provider. */
  base?: Record<string, unknown>
  /** Cross-field validation passed through to the provider. */
  validate?: (value: T) => void
}

/** A live settings reader; `undefined` means "no namespace registered". */
export type SettingsReader<T> = () => T | undefined

/** Hooks a consumer hands to {@link installSectionSafe} (harness `SettingsSectionHooks` shape). */
export interface SectionHooks<T> {
  /**
   * Receive the active configuration source: the resolved settings value while
   * one is attached, the composition entry otherwise.
   */
  setSource(current: () => T): void
  /** Re-judge anything derived from the source after an attach or a committed change. */
  onChange(): void
  /** Reject a resolved section this consumer could not act on. */
  validate?: (value: T) => void
}

/**
 * The exact duplicate-registration message harness `SettingsProvider.register`
 * throws. Pinned coupling: upstream drift must fail loudly here (and in the
 * specs that pin it), not silently in production.
 */
export function duplicateRegistrationMessage(ns: SettingsNamespace): string {
  return `settings namespace "${ns}" is already registered`
}

function isDuplicate(error: unknown, ns: SettingsNamespace): boolean {
  return error instanceof Error && error.message === duplicateRegistrationMessage(ns)
}

/**
 * Value mirror of the cordis `FiberState` members compared against: a const
 * enum has no runtime object to import, so the numeric values are mirrored
 * (same rationale as the harness provider's own `isUnloading`).
 */
const FIBER_DISPOSED = 4
const FIBER_UNLOADING = 5

/** Whether the context's own fiber is tearing down (defensive: state unreadable → not unloading). */
function isUnloading(ctx: Context): boolean {
  try {
    const state: number = ctx.fiber.state
    return state === FIBER_UNLOADING || state === FIBER_DISPOSED
  } catch {
    return false
  }
}

function isInactive(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'INACTIVE_EFFECT'
}

/**
 * Memoized readers per settings-provider shadow, module-level. Bounds the
 * churn to one register/unregister pair per lost owner within one module
 * copy; the try/catch — not this WeakMap — is the cross-module-copy
 * protection (a different module copy means a different WeakMap key).
 */
const readers = new WeakMap<object, SettingsReader<never>>()

/**
 * Register a settings namespace idempotently and return a live reader.
 *
 * Behavior (plan §2.2):
 *
 * - No `ctx.get('settings')` provider → the reader returns `undefined` on
 *   every call (callers keep their graceful-degradation behavior).
 * - The reader is a read-through source of truth: it always resolves through
 *   `settings.get(ns)`, never a cached scope object. **Constraint:** this
 *   contract assumes an object schema (`z.object(...)`), so a legitimate
 *   resolved value is never `undefined` — `undefined` on read unambiguously
 *   means "not registered". A scalar namespace whose value can legitimately
 *   be `undefined` breaks the self-healing trigger.
 * - Lazy self-healing: when a read observes `undefined` and the setup-time
 *   context is still live, the reader attempts `settings.register` again with
   * the same schema/options and re-reads.
 * - Duplicate registration (`settings namespace "<ns>" is already registered`)
 *   degrades to the live provider read. **Value-fidelity caveat:** under dual
 *   module copies with *different* schemas, the degrade path serves the other
 *   copy's resolved value — the same trade the pre-helper guard made.
 * - Any other register error propagates, except re-acquisition on a
 *   disposed/unloading context (cordis `CordisError` code `INACTIVE_EFFECT`),
 *   which degrades to `undefined`: a stale reader must never throw into a hot
 *   read path.
 * @param ctx - the setup-time mount context; effects bind here.
 * @param ns - the settings namespace.
 * @param schema - schemastery schema resolving the namespace's value.
 * @param options - composition base and validation, passed through.
 * @returns a reader resolving the live namespace value, or `undefined`.
 */
export function registerNamespaceSafe<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  options?: SafeRegisterOptions<T>,
): SettingsReader<T> {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) return () => undefined
  const memoized = readers.get(settings)
  if (memoized !== undefined) return memoized as SettingsReader<T>
  const registerOptions = options as SettingsRegisterOptions<T> | undefined
  try {
    settings.register(ns, schema, registerOptions)
  } catch (error) {
    // A duplicate means another mount or module copy owns the namespace;
    // degrade to live reads and let self-healing retry when it disappears.
    if (!isDuplicate(error, ns)) throw error
  }
  const reader: SettingsReader<T> = () => {
    const value = settings.get(ns) as T | undefined
    if (value !== undefined) return value
    if (!isUnloading(ctx)) {
      try {
        settings.register(ns, schema, registerOptions)
      } catch (error) {
        if (!isDuplicate(error, ns) && !isInactive(error)) throw error
      }
    }
    return settings.get(ns) as T | undefined
  }
  readers.set(settings, reader as SettingsReader<never>)
  return reader
}

/**
 * Attach one optional-settings consumer idempotently, mirroring the harness
 * `SettingsProvider.installSection(owner, ns, schema, entry, hooks)` call
 * signature (plan §2.3).
 *
 * - Fresh path (namespace unregistered): delegate to `installSection`
 *   unchanged — it owns attach-time `setSource`/`onChange` wiring, the
 *   provider-loss fallback, and its own change subscription.
 * - Preflight path (namespace already owned — mount overlap or a dual module
 *   copy): do NOT call `installSection` (its internal `register` would throw,
 *   and a silent second owner would double-fire `onChange` into two live
 *   consumers). Wire the hooks directly: `setSource` reads the live
 *   `settings.get(ns)`, and reload notification comes from the provider's
 *   public `settings/updated` commit event, filtered by namespace and inert
 *   once the caller ctx is unloading. The listener unwinds with the caller
 *   mount (registered as an effect on the caller ctx).
 * - No re-registration after owner death: `settings.get(ns)` returns
 *   `undefined` once the owning registration disappears, so the consumer's
 *   existing fallback contract applies — identical to the harness's own
 *   provider-loss semantics.
 * @param ctx - the caller (consumer) context.
 * @param ns - the settings namespace.
 * @param schema - schemastery schema resolving the namespace's value.
 * @param entry - composition entry used as base and fallback value.
 * @param hooks - consumer hooks (`setSource`, `onChange`, optional `validate`).
 */
export function installSectionSafe<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SectionHooks<T>,
): void {
  const settings = ctx.get('settings') as SettingsProvider | undefined
  if (settings === undefined) {
    // No provider: serve the composition entry, matching the harness's
    // provider-loss fallback without an attach ceremony.
    hooks.setSource(() => entry)
    hooks.onChange()
    return
  }
  if (settings.get(ns) === undefined) {
    settings.installSection(ctx, ns, schema, entry, hooks as never)
    return
  }
  // Preflight: the namespace is already owned by another mount. Read live;
  // notify on commits to this namespace only; never re-register (the
  // installSection hook surface belongs to the first owner).
  hooks.setSource(() => settings.get(ns) as T)
  ctx.effect(() => {
    const listener = (eventNs: SettingsNamespace) => {
      if (eventNs !== ns || isUnloading(ctx)) return
      hooks.onChange()
    }
    // The commit event fans out on the provider's own context (Service.ctx is
    // protected in cordis, hence the cast); the disposer unwinds via the
    // effect above when the caller mount tears down.
    const dispose = (settings as unknown as { ctx: Context }).ctx.on('settings/updated', listener)
    return () => dispose()
  }, `settings-ns: settings/updated(${String(ns)})`)
  hooks.onChange()
}
