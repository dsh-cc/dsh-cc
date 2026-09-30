/**
 * Abstract settings service for the vendored user-settings seam: providers
 * implement raw-document storage (`load`/`persist`) and push external changes
 * through {@link SettingsProvider.publish}; the base class owns namespace
 * registration, resolution, validation, change detection, and the
 * `settings/updated` commit event.
 *
 * Vendored verbatim from harness `@deepseek-ai/dsh-settings` @ pin
 * `1ef9c1fa9a` (0.1.5-rc.1), index.ts:333-855; one deliberate addition: the
 * no-op `configure()` facade (Q3 step 4 / G16). Private commit/event helpers
 * were lifted verbatim into `./events.ts` (semantics unchanged) for the
 * 500-line gate.
 *
 * @module @dsh-cc/settings-provider/provider
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SettingsNamespace, SettingsUpdateSource } from './types.ts'
import { parseSettingsNamespace } from './namespace.ts'
import type { SettingsNamespaceInput } from './namespace.ts'
import { redactSecrets } from './redact.ts'
import { resolveValue } from './contract.ts'
import {
  SettingsConflictError,
  applyPathOp,
  cloneJsonShaped,
  isPlainObject,
  isUnloading,
  mergeLayers,
} from './contract.ts'
import type { SettingsDescribeOptions, SettingsDescriptor, SettingsRegisterOptions, SettingsScope, SettingsSectionHooks } from './contract.ts'
import type { SettingsPathOp } from './contract.ts'
import { bumpRevision, commit } from './events.ts'
import type { CommitDeps, SettingsRegistration, SettingsWatcher } from './events.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    settings: SettingsProvider
  }
}

/**
 * One-shot debug flag for the {@link SettingsProvider.configure} facade: the
 * semantic-gap note is logged once per process, not once per caller boot.
 */
let configureNoted = false

export abstract class SettingsProvider extends Service {
  private readonly registrations = new Map<SettingsNamespace, SettingsRegistration>()
  /** Latest published raw document; empty until the provider's first publish. */
  private document: Record<string, unknown> = {}
  /** Per-namespace write chains; settled tails, so a failure never poisons the queue. */
  private readonly writeQueues = new Map<SettingsNamespace, Promise<unknown>>()
  /** In-flight watcher invocation segments, drained by the dispose teardown. */
  private readonly pendingTails = new Set<Promise<void>>()
  /** Set at service dispose: refuse new writes while queued ones drain. */
  private stopped = false

  /** Opaque read of {@link stopped}: control flow cannot narrow it across awaits. */
  private isStopped(): boolean {
    return this.stopped
  }

  constructor(ctx: Context) {
    super(ctx, 'settings')
  }

  /**
   * Load the provider's document once and publish it before the service
   * becomes injectable, and register the write-drain teardown. Providers with
   * their own init (watchers, connections) delegate here first via
   * `yield* super[Service.init]()`; their disposers then run before the drain.
   */
  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield async () => {
      // Teardown: refuse new writes and new watcher starts, then wait until
      // every queued write chain and every started watcher invocation settles
      // so disposal completes only once storage and observers are quiescent.
      // Invocations queued but not yet started skip via the stopped check.
      this.stopped = true
      await Promise.allSettled([...this.writeQueues.values(), ...this.pendingTails])
    }
    this.publish(await this.load())
  }

  /** Whether {@link update} may persist through this provider. */
  abstract readonly writable: boolean

  /**
   * Absolute path of the provider's user-editable document, when its storage
   * is one local file. Configuration surfaces use this only as availability
   * metadata; the guarded open operation resolves the path again Host-side.
   * Non-file providers leave it undefined and expose no open-document affordance.
   * @returns the absolute local document path, or undefined for non-file storage.
   */
  get documentPath(): string | undefined {
    return undefined
  }

  /**
   * Prepare the provider's user-editable document for a native editor. File
   * providers may materialize an absent document before returning its path;
   * non-file providers return undefined.
   * @returns the absolute local document path, or undefined for non-file storage.
   */
  prepareDocument(): Promise<string | undefined> {
    return Promise.resolve(this.documentPath)
  }

  /**
   * Read the provider's current raw document (namespace to raw section).
   * @returns the detached raw document.
   */
  protected abstract load(): Promise<Record<string, unknown>>

  /**
   * Durably store one namespace's merged user section.
   * @param ns - the namespace being written.
   * @param section - the complete merged user section to store.
   */
  protected abstract persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void>

  /**
   * NO-OP COMPATIBILITY FACADE (Q3 step 4 / G16 — the one deliberate addition
   * to the vendored surface). Signature-compatible with the rc.2 harness
   * `SettingsForms.configure(presentation, owner)` so the harness base rows
   * that call `ctx.settings.configure({ auto }, fiber)` at boot
   * (`agent-default-model`, `permission-presets`, `agent-preset-registry`)
   * mount unchanged. INTENTIONAL SEMANTIC GAP: dsh-cc settings are the Claude
   * Code JSON cascade, not rc.2 profile-patch forms — there are no
   * auto-generated form pages, so a "presentation policy" has nothing to
   * attach to. The facade accepts and ignores both arguments, returns a
   * disposer, and logs once at debug. A harness surface needing the fuller
   * `SettingsForms` API is a flagged integration item (plan Q3 step 6).
   * @param presentation - rc.2 presentation policy; accepted and ignored.
   * @param owner - fiber the policy would belong to; accepted and ignored.
   * @returns a disposer (no-op), matching the rc.2 return shape.
   */
  configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void {
    void owner
    if (!configureNoted) {
      configureNoted = true
      this.ctx.logger.debug(
        'settings: configure({ auto: %s }) is a no-op — dsh-cc settings are the CC JSON cascade, not profile-patch forms',
        String(presentation?.auto ?? true),
      )
    }
    return () => undefined
  }

  /**
   * Register a namespace schema and receive its owner scope. The registration
   * is an effect on the calling plugin's fiber: disposing that fiber removes
   * the namespace and its observers. An invalid stored section fails the
   * registration itself — the earliest point where the schema can judge it.
   * @param ns - unique namespace; duplicate registration fails loud.
   * @param schema - schemastery schema resolving this namespace's value.
   * @param options - composition `base` layer and effect timing.
   * @returns the owner scope for reads, observation, and updates.
   * @throws {TypeError} when `ns` is not a lowercase hyphenated identifier.
   */
  register<const Namespace extends string, T>(
    ns: Namespace & SettingsNamespaceInput<Namespace>,
    schema: z<T>,
    options?: SettingsRegisterOptions<T>,
  ): SettingsScope<T> {
    const parsedNs = parseSettingsNamespace(ns)
    if (this.registrations.has(parsedNs)) {
      throw new Error(`settings namespace "${parsedNs}" is already registered`)
    }
    const registration: SettingsRegistration = {
      ns: parsedNs,
      schema: schema as z<unknown>,
      base: options?.base,
      applies: options?.applies ?? 'live',
      ...options?.validate === undefined
        ? {}
        : { validate: options.validate as (value: unknown) => void },
      resolved: deepFreeze(resolveValue(schema, options?.base, this.section(parsedNs), options?.validate)),
      revision: 0,
      watchers: new Set(),
    }
    this.ctx.effect(() => {
      this.registrations.set(parsedNs, registration)
      // TODO(settings-registration-quiescence): Deactivate every watcher and await
      // its tail on disposal so callbacks cannot outlive the registrant fiber.
      return () => this.registrations.delete(parsedNs)
    }, `settings.register(${JSON.stringify(String(parsedNs))})`)
    return {
      get: () => registration.resolved as T,
      watch: (callback) => {
        const watcher: SettingsWatcher = { callback: callback, tail: Promise.resolve(), active: true }
        registration.watchers.add(watcher)
        return () => {
          watcher.active = false
          registration.watchers.delete(watcher)
        }
      },
      update: patch => this.update(parsedNs, patch),
      replace: section => this.replace(parsedNs, section),
    }
  }

  /**
   * Attach one optional-settings consumer to this provider. The consumer
   * registers its composition entry as the base layer while this provider is
   * present, then falls back to that entry if the provider detaches.
   * @param owner - consumer context whose unload suppresses fallback work.
   * @param ns - consumer-owned settings namespace.
   * @param schema - schema resolving the namespace.
   * @param entry - composition entry used as the base and fallback value.
   * @param hooks - source sink, change notification, and optional validation.
   * @throws {TypeError} when `ns` is not a lowercase hyphenated identifier.
   */
  installSection<const Namespace extends string, T>(
    owner: Context,
    ns: Namespace & SettingsNamespaceInput<Namespace>,
    schema: z<T>,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ): void {
    const scope = this.register<Namespace, T>(ns, schema, {
      base: entry,
      ...hooks.validate === undefined ? {} : { validate: hooks.validate },
    })
    hooks.setSource(() => scope.get())
    this.ctx.effect(() => () => {
      // Losing the provider leaves the consumer running; unloading the
      // consumer does not, so only the former needs fallback work.
      if (isUnloading(owner)) return
      hooks.setSource(() => entry)
      hooks.onChange()
    })
    hooks.onChange()
    scope.watch(() => {
      if (isUnloading(owner)) return
      hooks.onChange()
    })
  }

  /**
   * Describe every registered namespace for configuration surfaces, including
   * the composition `base` and raw user layers so a form can mark which fields
   * the user overrode (presence in `user`) and what a reset returns to.
   * @param options - redaction switch; wire surfaces must redact.
   * @returns one descriptor per registered namespace, in registration order.
   */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[] {
    return [...this.registrations.values()].map((registration) => {
      let user: Record<string, unknown> | undefined
      try {
        user = this.section(registration.ns)
      } catch {
        // A malformed stored section already warned at publish and kept the
        // last good resolved value; only that malformed shape can throw here,
        // and describing it as "no user layer" keeps this read total.
        user = undefined
      }
      const base = registration.base === undefined ? undefined : structuredClone(registration.base)
      const detachedUser = user === undefined ? undefined : structuredClone(user)
      const descriptor: SettingsDescriptor = {
        ns: registration.ns,
        schema: registration.schema.toJSON(),
        value: registration.resolved,
        revision: registration.revision,
        ...base === undefined ? {} : { base },
        ...detachedUser === undefined ? {} : { user: detachedUser },
        applies: registration.applies,
      }
      if (options?.redactSecrets !== true) return descriptor
      const schema = registration.schema as z<never>
      const redacted = redactSecrets(schema, registration.resolved)
      return {
        ...descriptor,
        value: redacted.value,
        ...base === undefined ? {} : { base: redactSecrets(schema, base).value },
        ...detachedUser === undefined ? {} : { user: redactSecrets(schema, detachedUser).value },
        secrets: redacted.secrets,
      }
    })
  }

  /**
   * Read one registered namespace's resolved value.
   * @param ns - the namespace to read.
   * @returns the resolved value, or `undefined` while unregistered.
   * @throws {TypeError} when `ns` is not a lowercase hyphenated identifier.
   */
  get<const Namespace extends string>(ns: Namespace & SettingsNamespaceInput<Namespace>): unknown {
    return this.registrations.get(parseSettingsNamespace(ns))?.resolved
  }

  /**
   * Merge a patch into one registered namespace's user layer, validate the
   * resolved candidate, persist through the provider, then commit and emit.
   * A validation failure rejects before anything is persisted. Writes to one
   * namespace are serialized: concurrent updates apply in call order, each
   * merging over the previous write's committed section.
   * @param ns - the registered namespace to update.
   * @param patch - plain-object patch over the user section.
   * @param expectedRevision - the descriptor `revision` the caller read; a
   *   namespace that moved past it rejects with {@link SettingsConflictError}.
   * @throws {TypeError} when `ns` is not a lowercase hyphenated identifier.
   */
  async update<const Namespace extends string>(
    ns: Namespace & SettingsNamespaceInput<Namespace>,
    patch: object,
    expectedRevision?: number,
  ): Promise<void> {
    return this.write(parseSettingsNamespace(ns), patch, 'merge', expectedRevision)
  }

  /**
   * Replace one registered namespace's user section wholesale, validate,
   * persist, then commit and emit. Keys absent from `section` fall back to the
   * composition `base` and schema defaults — this is the removal/reset path a
   * merge-only patch cannot express (`replace({})` re-inherits everything).
   * @param ns - the registered namespace to replace.
   * @param section - the complete next user section.
   * @param expectedRevision - the descriptor `revision` the caller read; a
   *   namespace that moved past it rejects with {@link SettingsConflictError}.
   * @throws {TypeError} when `ns` is not a lowercase hyphenated identifier.
   */
  async replace<const Namespace extends string>(
    ns: Namespace & SettingsNamespaceInput<Namespace>,
    section: object,
    expectedRevision?: number,
  ): Promise<void> {
    return this.write(parseSettingsNamespace(ns), section, 'replace', expectedRevision)
  }

  /**
   * Apply path-addressed edits to one registered namespace's user section,
   * validate, persist, then commit and emit. The ops are applied to the
   * section as it stands when the write reaches the front of the queue, so a
   * caller never has to restate fields it did not touch — and, crucially,
   * cannot delete fields it never saw. This is the write path for any caller
   * holding a redacted view; `replace` remains the wholesale reset.
   * @param ns - the registered namespace to edit.
   * @param ops - ordered path edits; later ops observe earlier ones.
   * @param expectedRevision - the descriptor `revision` the caller read; a
   *   namespace that moved past it rejects with {@link SettingsConflictError}.
   * @throws {TypeError} when `ns` is not a lowercase hyphenated identifier.
   */
  async mutate<const Namespace extends string>(
    ns: Namespace & SettingsNamespaceInput<Namespace>,
    ops: readonly SettingsPathOp[],
    expectedRevision?: number,
  ): Promise<void> {
    const parsedNs = parseSettingsNamespace(ns)
    if (!Array.isArray(ops)) throw new TypeError(`settings mutate for "${parsedNs}" must be an array of path ops`)
    for (const op of ops) {
      if (!isPlainObject(op) || (op['op'] !== 'set' && op['op'] !== 'unset')) {
        throw new TypeError(`settings mutate for "${parsedNs}" ops must be {op:'set'|'unset', path}`)
      }
      if (!Array.isArray(op['path']) || (op['path'] as unknown[]).some(part => typeof part !== 'string')) {
        throw new TypeError(`settings mutate for "${parsedNs}" op paths must be arrays of strings`)
      }
    }
    return this.write(parsedNs, ops, 'mutate', expectedRevision)
  }

  /** Validate a write, then queue it on the namespace's serialized write chain. */
  private write(
    ns: SettingsNamespace,
    input: object,
    mode: 'merge' | 'replace' | 'mutate',
    expectedRevision?: number,
  ): Promise<void> {
    const verb = mode === 'merge' ? 'update' : mode === 'replace' ? 'replace' : 'mutate'
    const registration = this.registrations.get(ns)
    if (registration === undefined) {
      throw new Error(`settings namespace "${ns}" is not registered`)
    }
    if (this.isStopped()) {
      throw new Error(`settings service is disposed: "${ns}" cannot be written`)
    }
    if (!this.writable) {
      throw new Error(`settings provider is read-only: "${ns}" cannot be updated in-process`)
    }
    // A mutate's ops array is wrapped so one JSON-shape walk covers both
    // shapes; merge/replace carry the section itself.
    let payload: Record<string, unknown>
    if (mode === 'mutate') {
      payload = { ops: input }
    } else {
      if (!isPlainObject(input)) throw new TypeError(`settings ${verb} for "${ns}" must be a plain object`)
      payload = input
    }
    // Snapshot at call time: the queue must never read a caller-owned object
    // the caller may keep mutating while the write waits its turn. The same
    // walk rejects values that JSON cannot preserve (see cloneJsonShaped).
    const snapshot = cloneJsonShaped(payload, (label, path) =>
      new TypeError(`settings ${verb} for "${ns}" must contain only JSON-compatible data (found ${label} at ${path})`))
    const previous = this.writeQueues.get(ns) ?? Promise.resolve()
    // Chain past a failed predecessor: one rejected write must not poison the
    // namespace queue for every later caller.
    const run = previous.catch(() => undefined).then(async () => {
      if (this.isStopped()) {
        throw new Error(`settings service was disposed before the queued "${ns}" ${verb} ran`)
      }
      if (this.registrations.get(ns) !== registration) {
        throw new Error(`settings namespace "${ns}" registration was disposed before the queued ${verb} ran`)
      }
      // Every mode derives from the section as it stands NOW, at the front of
      // the queue — never from whatever the caller last saw.
      const current = this.section(ns) ?? {}
      // The revision check belongs HERE, not at call time: the queue orders
      // writes but cannot tell a fresh writer from one holding a snapshot
      // that a predecessor already superseded.
      if (expectedRevision !== undefined && expectedRevision !== registration.revision) {
        throw new SettingsConflictError(ns, expectedRevision, registration.revision)
      }
      const section = mode === 'merge'
        ? mergeLayers(current, snapshot) as Record<string, unknown>
        : mode === 'replace'
          ? snapshot
          : (snapshot['ops'] as SettingsPathOp[]).reduce(applyPathOp, current)
      const next = deepFreeze(resolveValue(registration.schema, registration.base, section, registration.validate))
      await this.persist(ns, section)
      // The write reached storage either way; the cache must say so. Commit
      // only when this registration is still the namespace owner — a fiber
      // disposed (or replaced) mid-persist must not receive the notification.
      this.document[ns] = section
      // TODO(settings-replacement-resync): Re-resolve any replacement registration
      // from this persisted section so an old in-flight write cannot leave it stale.
      if (this.registrations.get(ns) === registration && !this.isStopped()) {
        bumpRevision(this.commitDeps(), registration, current, section)
        commit(this.commitDeps(), registration, next, 'update')
      }
    })
    this.writeQueues.set(ns, run)
    return run
  }

  /**
   * Provider hook: commit a complete raw document observed in storage. Each
   * registered namespace re-resolves; an invalid section keeps that
   * namespace's last good value and warns, other namespaces still commit.
   * @param doc - the detached raw document (unregistered sections preserved).
   * @param source - change origin; defaults to `provider`.
   */
  protected publish(doc: Record<string, unknown>, source: SettingsUpdateSource = 'provider'): void {
    // Read every raw section BEFORE swapping the document, so the revision
    // bump below compares what was stored with what now is — an external edit
    // moves the revision exactly like an in-process write.
    const before = new Map<SettingsNamespace, unknown>()
    for (const registration of this.registrations.values()) {
      try {
        before.set(registration.ns, this.section(registration.ns))
      } catch {
        // A malformed stored section is not a readable "before"; treating it
        // as absent still bumps against any well-formed replacement.
        before.set(registration.ns, undefined)
      }
    }
    this.document = doc
    for (const registration of this.registrations.values()) {
      let next: unknown
      try {
        next = deepFreeze(resolveValue(registration.schema, registration.base, this.section(registration.ns), registration.validate))
      } catch (error) {
        this.ctx.logger.warn('settings: keeping last good "%s" after invalid stored section', registration.ns)
        this.ctx.logger.warn(error)
        continue
      }
      bumpRevision(this.commitDeps(), registration, before.get(registration.ns), this.section(registration.ns))
      commit(this.commitDeps(), registration, next, source)
    }
  }

  /** Read one namespace's raw user section, rejecting non-object sections. */
  private section(ns: SettingsNamespace): Record<string, unknown> | undefined {
    const section = this.document[ns]
    if (section === undefined) return undefined
    if (!isPlainObject(section)) {
      throw new TypeError(`settings section "${ns}" must be an object of keys`)
    }
    return section
  }

  /** The commit machinery's view of this provider's private state. */
  private commitDeps(): CommitDeps {
    return { ctx: this.ctx, isStopped: () => this.isStopped(), pendingTails: this.pendingTails }
  }
}

export default SettingsProvider
