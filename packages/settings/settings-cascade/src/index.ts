/**
 * Claude Code-style five-level settings cascade Provider for `ctx.settings`.
 * Five sources merge low-to-high — user settings, project settings, local
 * settings, flag settings, policy settings — under a plugin-default base.
 * The merged raw document feeds the user-settings seam, whose namespace
 * resolution layers schema defaults, the registrant `base`, and this user
 * layer in turn. A top-level `env` section is split out and applied in two
 * stages, holding dangerous variables until trust. Writes are write-through
 * to the user layer: they arrive here as a complete merged section and are
 * diffed back onto the user settings file, so higher-layer contributions stay
 * read-side only.
 * @module @dsh-cc/settings-cascade
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { watch as chokidarWatch } from 'chokidar'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { canonicalizeWatchPath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveLocalSettingsDir, type LocalRootDeps } from './local-root.ts'
import { mergeSettingsSection } from './merge.ts'
import { coerceEnv, type EnvSettings } from './env.ts'
import { applyOpsToSection, diffSections, writeJsonAtomic } from './persist.ts'
import { applyCcKeyAliases } from './cc-key-aliases.ts'

export { applyCcKeyAliases, CC_KEY_ALIASES } from './cc-key-aliases.ts'

export { resolveLocalSettingsDir, type LocalRootDeps, type LocalRootExec, type LocalRootExecResult } from './local-root.ts'
export { mergeValue, mergeSettingsSection, unionDenyPrecedence } from './merge.ts'
export { AutoModeSchema, AutoModeClassifierSchema, type AutoMode, type AutoModeClassifier } from './auto-mode.ts'
export { PermissionsSchema, PERMISSION_MODES, type Permissions, type PermissionMode } from './permissions.ts'
export { applyEnv, applyTrustedEnv, coerceEnv, DANGEROUS_ENV_VARS, type EnvSettings } from './env.ts'

/** All settings sources in merge order, low to high priority. */
export const SETTING_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const

/** One source in the settings cascade. */
export type SettingsSource = (typeof SETTING_SOURCES)[number]

/** Policy sub-sources in first-source-wins priority order. */
export interface CascadePolicyConfig {
  /** Hosted remote settings — the highest-priority policy source. */
  remoteSettings?: unknown
  /** System-level managed settings file. */
  systemPath?: string
  /** User-writable managed settings file. */
  userPath?: string
}

/** Plugin configuration: source file locations and switches. */
export interface Config {
  /** Launch directory: seeds the project settings path and the git probe for the local settings path. */
  projectDir?: string
  /** Harness home used for the default user settings path. */
  dshHome?: string
  /** User settings file; defaults to `settings.json` under the harness home. */
  userSettingsPath?: string
  /** Project settings file; defaults to `<project>/.claude/settings.json`. */
  projectSettingsPath?: string
  /** Local settings file; defaults to git main-checkout / toplevel `.claude/settings.local.json`. */
  localSettingsPath?: string
  /** Command-line `--settings` file; the flag layer's file half. */
  flagSettingsPath?: string
  /** Inline `--settings` content; merged over the flag file. */
  flagSettingsInline?: unknown
  /** Policy sub-sources; the first non-empty one wins. */
  policy?: CascadePolicyConfig
}

/** Fully resolved provider parameters; defaulting happens here, never inline. */
export interface ResolvedSpec {
  sources: {
    userSettings: string | undefined
    projectSettings: string | undefined
    localSettings: string | undefined
    flagSettings: string | undefined
  }
  flagSettingsInline: unknown
  policy: {
    systemPath: string | undefined
    userPath: string | undefined
    remoteSettings: unknown
  }
}

/** Whether a value is a plain data object (not an array, null, or instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Whether a filesystem error simply means the file is absent. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Whether a filesystem error is a permission denial (EACCES/EPERM). */
function isAccessDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM'
}

/** Watcher write-settle window in milliseconds (mirrors the harness file provider's default). */
const DEBOUNCE_MS = 100

/** Optimistic-retry bound for persist: how many read-check-write rounds before failing loud. */
const MAX_PERSIST_ATTEMPTS = 5

/**
 * Resolve the runtime spec from plugin config: explicit paths win, otherwise
 * the defaults derive from the harness home and the project directory. The
 * project settings stay at the launch directory, but the local settings file
 * path hoists Claude Code-style to the git main checkout root (linked
 * worktree) or git toplevel (subdirectory start) via
 * {@link resolveLocalSettingsDir} — the session cwd and git operations are
 * untouched, and explicit `localSettingsPath` never hoists.
 * @param config - raw plugin config.
 * @param deps - injectable local-root environment (tests only).
 * @returns the resolved source locations, inline flag settings, and policy sources.
 */
export function resolveSpec(config: Config, deps?: LocalRootDeps): ResolvedSpec {
  const launchDir = resolve(config.projectDir ?? process.cwd())
  const home = resolveDshHome(config.dshHome)
  return {
    sources: {
      userSettings: config.userSettingsPath ?? join(home, 'settings.json'),
      projectSettings: config.projectSettingsPath ?? join(launchDir, '.claude', 'settings.json'),
      localSettings: config.localSettingsPath
        ?? join(resolveLocalSettingsDir(launchDir, deps), '.claude', 'settings.local.json'),
      flagSettings: config.flagSettingsPath,
    },
    flagSettingsInline: config.flagSettingsInline,
    policy: {
      remoteSettings: config.policy?.remoteSettings,
      systemPath: config.policy?.systemPath,
      userPath: config.policy?.userPath,
    },
  }
}

/**
 * Claude Code-style five-level settings cascade Provider. Reads the user,
 * project, local, flag, and policy sources in low-to-high priority, deep-merges
 * them (permission arrays union with `deny` precedence), resolves policy by
 * first-source-wins, splits out the top-level `env` section, and publishes the
 * merged per-namespace document into `ctx.settings`. Writes are write-through
 * to the user layer: a merged section is persisted as a surgical leaf-delta
 * applied onto the user settings file, keeping project/local/flag/policy
 * contributions read-side only.
 */
export class SettingsCascadeProvider extends SettingsProvider {
  static Config: z<Config> = z.object({
    projectDir: z.string(),
    dshHome: z.string(),
    userSettingsPath: z.string(),
    projectSettingsPath: z.string(),
    localSettingsPath: z.string(),
    flagSettingsPath: z.string(),
    flagSettingsInline: z.any(),
    policy: z.object({
      remoteSettings: z.any(),
      systemPath: z.string(),
      userPath: z.string(),
    }),
  })

  private readonly spec: ResolvedSpec
  /** The top-level `env` section split out of the merged document, string-valued. */
  private env: EnvSettings = {}
  /**
   * Mirror of exactly what we last published to the seam via `load()`, and what
   * persist has durably stored. Invariant: shadow moves only when the seam's
   * document moves — it is updated at the end of a successful `load()` and,
   * in `persist()`, only AFTER the atomic rename resolves. Never update it in
   * a `finally` or ahead of a throw. If a file watcher is ever added, any
   * `publish(doc)` path must also update this shadow.
   */
  private shadow: Record<string, unknown> = {}
  /**
   * Single exclusive operation chain: watcher-triggered reloads and persists
   * run one at a time in queue order (settled tail), so a persist can never
   * race a reload's read-modify-publish, and a reload can never read a
   * half-committed atomic rename.
   */
  private operations: Promise<void> = Promise.resolve()
  /** Set at dispose: refuse new watcher events and let in-flight work no-op. */
  private closed = false

  /** Opaque read of {@link closed}: control flow cannot narrow it across awaits. */
  private isClosed(): boolean {
    return this.closed
  }

  constructor(ctx: Context, config: Config) {
    super(ctx)
    // Programmatic construction may bypass Schemastery normalization; resolve
    // the same defaults in one explicit step either way.
    this.spec = resolveSpec(config)
  }

  /** The cascade is now writable; writes edit the user layer. */
  get writable(): boolean {
    return true
  }

  /** Absolute path of the user-editable document (the cascade's user source). */
  override get documentPath(): string {
    const path = this.spec.sources.userSettings
    if (path === undefined) {
      throw new Error('settings-cascade: userSettings source is not configured; no user layer to edit')
    }
    return path
  }

  /**
   * Materialize the user-editable document for a native editor. The parent
   * directory is created and an absent document is seeded with an empty
   * namespace map. It intentionally does NOT call {@link SettingsProvider.publish}:
   * the cascade document is the five-layer merge, and publishing `{}` here
   * would clobber project/local/flag/policy contributions in-process (the
   * stock file provider publishes `{}` only because its document is the user
   * file one-to-one).
   * @returns the absolute local document path after materialization.
   */
  override async prepareDocument(): Promise<string> {
    const path = this.documentPath
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, '{}\n', { flag: 'wx', mode: 0o600 }).catch(error => {
      if (error?.code !== 'EEXIST') throw error
    })
    return path
  }

  /**
   * Durably persist one namespace's merged user section by editing the user
   * layer. The section (the seam's complete merged section for the namespace)
   * is diffed against the shadow of what we last published, the delta is
   * applied onto the user settings file's own section for that namespace, and
   * the file is rewritten atomically. The shadow advances only after the
   * atomic rename resolves, so an interrupted persist never desyncs it.
   * @param ns - the namespace being written.
   * @param section - the complete merged user section to store.
   */
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    // Serialize with watcher-triggered reloads on the one operation chain, and
    // retry optimistically when an external edit lands between the read and
    // the atomic rename.
    return this.enqueue(() => this.persistSection(ns, section))
  }

  /** Queue one exclusive document operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Queue a reload; a failed reload keeps the last-good document and stays only a warning. */
  private queueRefresh(): void {
    void this.enqueue(async () => {
      if (this.isClosed()) return
      try {
        this.publish(await this.load())
      } catch (error) {
        // A malformed or unreadable source must never take a live session
        // down: keep the last good document published and keep watching.
        this.ctx.logger.warn('settings-cascade: reload failed; keeping the last good document')
        this.ctx.logger.warn(error)
      }
    }).catch((error: unknown) => {
      // Only an invariant violation escaping the commit path can reject a
      // reload past the warn-and-keep guard; keep the queue alive so one
      // poisoned commit cannot silently end hot reloading forever.
      this.ctx.logger.warn('settings-cascade: reload commit failed')
      this.ctx.logger.warn(error)
    })
  }

  /**
   * Persist one namespace with optimistic concurrency: the user-file bytes
   * are re-read immediately before the atomic rename, and when an external
   * writer changed them since the read the op built on, the whole round
   * restarts from a fresh read (bounded, then loud). The shadow still moves
   * only after the write has durably succeeded.
   */
  private async persistSection(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    const path = this.documentPath
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt++) {
      const ops = diffSections(this.shadow[ns] ?? {}, section)
      if (ops.length === 0) {
        this.shadow[ns] = structuredClone(section)
        return
      }
      const before = await this.readUserText(path)
      const root = before === undefined || before.trim().length === 0 ? {} : this.parse(path, before)
      const next = applyOpsToSection(root[ns], ops)
      const updated = { ...root, [ns]: next }
      if ((await this.readUserText(path)) !== before) {
        lastError = new Error(`settings-cascade: user settings file at ${path} changed concurrently during persist`)
        continue
      }
      await writeJsonAtomic(path, updated)
      this.shadow[ns] = structuredClone(section)
      return
    }
    throw lastError ?? new Error(`settings-cascade: persist at ${path} exhausted ${MAX_PERSIST_ATTEMPTS} optimistic-retry attempts`)
  }

  /** Raw user-file text, or `undefined` when the file is absent. */
  private async readUserText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (isENOENT(error)) return undefined
      throw error
    }
  }

  /** Every concrete settings FILE path worth watching, canonicalized and deduped. */
  private async watchPaths(): Promise<string[]> {
    const paths = [
      this.spec.sources.userSettings,
      this.spec.sources.projectSettings,
      this.spec.sources.localSettings,
      this.spec.sources.flagSettings,
      this.spec.policy.systemPath,
      this.spec.policy.userPath,
    ].filter((path): path is string => path !== undefined)
    const canonical = await Promise.all(paths.map(path => canonicalizeWatchPath(path)))
    return [...new Set(canonical)]
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    // The base init loads and publishes the merged document; a parse failure
    // there is a boot failure and stays loud.
    yield* super[Service.init]()
    const watcher = chokidarWatch(await this.watchPaths(), {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: DEBOUNCE_MS,
        pollInterval: Math.max(1, Math.min(DEBOUNCE_MS, 10)),
      },
    })
    watcher.on('all', () => {
      if (this.isClosed()) return
      this.queueRefresh()
    })
    watcher.on('ready', () => {
      // The base init's load raced the watcher's own setup: a change written
      // between that read and the watcher becoming active never fires an
      // event. One reconcile at ready closes the gap.
      if (this.isClosed()) return
      this.queueRefresh()
    })
    watcher.on('error', (error) => {
      this.ctx.logger.warn('settings-cascade: watcher error')
      this.ctx.logger.warn(error)
    })
    yield async () => {
      this.closed = true
      await watcher.close()
      await this.operations
    }
  }

  /**
   * Read the merged top-level `env` section. Values are already coerced to
   * strings. Pass the result to {@link applyEnv} / {@link applyTrustedEnv} for
   * the untrusted and trusted application stages.
   * @returns the detached `env` section (empty object when none is configured).
   */
  getEnv(): EnvSettings {
    return structuredClone(this.env)
  }

  /**
   * Merge all five sources low-to-high and publish the per-namespace document,
   * splitting the top-level `env` section into {@link getEnv}. A present-but-
   * invalid source file fails load loud; absent sources contribute nothing.
   * @returns the merged document minus its top-level `env` key.
   */
  protected async load(): Promise<Record<string, unknown>> {
    // The five source resolutions are independent; read them concurrently.
    // With MULTIPLE invalid sources, serial loading surfaced the lowest layer
    // deterministically while Promise.all surfaces whichever rejects first in
    // time — both fail loud. Single-invalid behavior is unchanged.
    const [user, project, local, flag, policy] = await Promise.all([
      this.readOptional(this.spec.sources.userSettings),
      this.readOptional(this.spec.sources.projectSettings),
      this.readOptional(this.spec.sources.localSettings, true),
      this.resolveFlag(),
      this.resolvePolicy(),
    ])

    const merged = [user, project, local, flag, policy]
      .reduce<Record<string, unknown>>(
        (acc, layer) => (Object.keys(layer).length === 0
          ? acc
          : mergeSettingsSection(acc, layer)),
        {},
      )

    // CC camelCase top-level keys alias onto kebab namespaces before the env
    // split / publish, so the shadow mirrors exactly what the seam resolves.
    const { env, ...document } = applyCcKeyAliases(merged)
    this.env = this.coerceEnvSection(env)
    this.shadow = structuredClone(document)
    return document
  }

  /** Read a source file into raw settings, skipping absence and failing loud on invalidity. */
  private async readOptional(path: string | undefined, local = false): Promise<Record<string, unknown>> {
    if (path === undefined) return {}
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      // The hoisted local file may sit in a main checkout whose `.claude`
      // denies us mid-session (EACCES/EPERM); treat that as absent so a
      // cross-boundary read cannot crash boot. Other sources stay loud.
      if (isENOENT(error) || (local && isAccessDenied(error))) return {}
      throw error
    }
    return this.parse(path, text)
  }

  /** Parse one settings document, throwing loud on a non-object root or invalid JSON. */
  private parse(path: string, text: string): Record<string, unknown> {
    let root: unknown
    try {
      root = text.trim().length === 0 ? {} : JSON.parse(text)
    } catch (error) {
      throw new Error(`settings-cascade: invalid settings document at ${path}: ${(error as Error).message}`, { cause: error })
    }
    if (!isPlainObject(root)) {
      throw new TypeError(`settings-cascade: ${path} must be a JSON object of namespace sections`)
    }
    return root
  }

  /** Merge the flag file and inline content, inline last (highest within the flag layer). */
  private async resolveFlag(): Promise<Record<string, unknown>> {
    const file = await this.readOptional(this.spec.sources.flagSettings)
    if (!isPlainObject(this.spec.flagSettingsInline)) return file
    return mergeSettingsSection(file, this.spec.flagSettingsInline)
  }

  /** Resolve policy by first-source-wins: remote, then system file, then user file. */
  private async resolvePolicy(): Promise<Record<string, unknown>> {
    const { remoteSettings, systemPath, userPath } = this.spec.policy
    if (isPlainObject(remoteSettings) && Object.keys(remoteSettings).length > 0) {
      return remoteSettings
    }
    for (const path of [systemPath, userPath]) {
      if (path === undefined) continue
      const settings = await this.readOptional(path)
      if (Object.keys(settings).length > 0) return settings
    }
    return {}
  }

  /** Coerce every `env` value to its string process-environment form. */
  private coerceEnvSection(value: unknown): EnvSettings {
    if (!isPlainObject(value)) return {}
    const out: EnvSettings = {}
    for (const [name, raw] of Object.entries(value)) {
      out[name] = coerceEnv(raw)
    }
    return out
  }
}

export default SettingsCascadeProvider
