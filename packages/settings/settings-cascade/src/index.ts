/**
 * Claude Code-style five-level settings cascade Provider for `ctx.settings`.
 * Five sources merge low-to-high — user settings, project settings, local
 * settings, flag settings, policy settings — under a plugin-default base.
 * The merged raw document feeds the user-settings seam, whose namespace
 * resolution layers schema defaults, the registrant `base`, and this user
 * layer in turn. A top-level `env` section is split out and applied in two
 * stages, holding dangerous variables until trust. Writes are write-through
 * to the user layer, keeping higher-layer contributions read-side only.
 *
 * NAMESPACE DISPOSITION MATRIX (migration plan 2026-09-29 Q3 addendum,
 * closed at Slice 1b):
 * - `llm-pi-ai`, `agent-default-model` → BRIDGE WITH DATA MIGRATION: the
 *   TUI reads/writes them via this cascade's user layer; tui/provider-bridge
 *   mirrors writes into the rc.2 plugin entry configs (configEditor).
 * - `agent-loop` → REMOVED upstream (rc.2 deleted AGENT_LOOP_SETTINGS_*).
 * - `permission-presets`, `llm-deepseek`, `bash-local`/`pwsh-local`,
 *   tool-subagent model-selection, `web-search-deepseek` → REMOVED / NO
 *   BRIDGE: zero dsh-cc namespace reads/writes; the no-op configure()
 *   facade covers their boot.
 *
 * @module @dsh-cc/settings-cascade
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SettingsProvider, type SettingsNamespace } from '@dsh-cc/settings-provider'
import { resolveLocalSettingsDir, type LocalRootDeps } from './local-root.ts'
import { mergeSettingsSection } from './merge.ts'
import { reassembleTrustedAutoMode, reassembleTrustedKey, TRUSTED_SOURCE_KEYS } from './trusted-scope.ts'
import { isAccessDenied, isENOENT, isPlainObject, MAX_PERSIST_ATTEMPTS } from './shared-guards.ts'
import { coerceEnv, type EnvSettings } from './env.ts'
import { applyOpsToSection, diffSections, readUserText, writeJsonAtomic } from './persist.ts'
import { resolveWatchPaths, resolveWatchTuning, startWatchers, type WatchTuning } from './watcher.ts'
import { applyCcKeyAliases } from './cc-key-aliases.ts'
import { runUserSectionEdit, type UserSectionEdit } from './edit-user-section.ts'

export { applyCcKeyAliases, CC_KEY_ALIASES } from './cc-key-aliases.ts'
export { runUserSectionEdit, type UserSectionEdit } from './edit-user-section.ts'

export { resolveLocalSettingsDir, type LocalRootDeps, type LocalRootExec, type LocalRootExecResult } from './local-root.ts'
export { reassembleTrustedKey, TRUSTED_SOURCE_KEYS } from './trusted-scope.ts'
export { mergeValue, mergeSettingsSection, unionDenyPrecedence } from './merge.ts'
export { AutoModeSchema, AutoModeClassifierSchema, type AutoMode, type AutoModeClassifier } from './auto-mode.ts'
export { PermissionsSchema, PERMISSION_MODES, type Permissions, type PermissionMode } from './permissions.ts'
export { WorktreeSchema, WORKTREE_DEFAULTS, worktreeSettings, type Worktree, type WorktreeBaseRef } from './worktree.ts'
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
  /** Watcher write-settle tuning (chokidar `awaitWriteFinish`); defaults 100/10. */
  watch?: {
    /** How long a file must stay unchanged before its event fires. */
    stabilityThresholdMs?: number
    /** How often a settling file is polled for further changes. */
    pollIntervalMs?: number
  }
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

/**
 * Resolve the runtime spec from plugin config: explicit paths win, otherwise
 * the defaults derive from the harness home and the project directory. The
 * project settings stay at the launch directory, but the local settings file
 * path hoists Claude Code-style to the git main checkout root (linked
 * worktree) or git toplevel (subdirectory start) via
 * {@link resolveLocalSettingsDir} — the session cwd and git operations are
 * untouched, and explicit `localSettingsPath` never hoists.
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
 * Consumer-facing trusted-view seam: a provider that can reassemble one
 * top-level settings key from its TRUSTED layers only — user settings, the
 * explicit --settings flag layer, and managed/policy — skipping the project
 * and local (repo-carried) layers. Consumers duck-type the API
 * (`settings?.trustedSection?.(key)`) and fall back to the merged read when
 * the provider lacks it.
 * @see SettingsCascadeProvider.trustedSection
 */
export interface TrustedSectionReader {
  /**
   * Trusted-only reassembly of one top-level settings `key` under the
   * {@link reassembleTrustedKey} rule — `undefined` when no trusted layer
   * carries the key.
   */
  trustedSection(key: string): Record<string, unknown> | undefined
}

/**
 * Claude Code-style five-level settings cascade Provider. Reads the user,
 * project, local, flag, and policy sources in low-to-high priority, deep-merges
 * them (permission arrays union with `deny` precedence), resolves policy by
 * first-source-wins, splits out the top-level `env` section, and publishes the
 * merged per-namespace document into `ctx.settings`. Writes are write-through
 * to the user layer, keeping project/local/flag/policy contributions
 * read-side only.
 */
export class SettingsCascadeProvider extends SettingsProvider implements TrustedSectionReader {
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
    watch: z.object({
      stabilityThresholdMs: z.number(),
      pollIntervalMs: z.number(),
    }),
  })

  private readonly spec: ResolvedSpec
  /** Resolved watcher write-settle tuning (defaults mirror the file provider). */
  private readonly watch: WatchTuning
  /** The top-level `env` section split out of the merged document, string-valued. */
  private env: EnvSettings = {}
  /**
   * The trusted layers (user, flag, policy) exactly as last loaded, in merge
   * order. Retained for {@link trustedSection}: the published merged document
   * is provenance-lossy, so a trusted-only view can only be reassembled from
   * the raw layers while they are still distinguishable. Moves only when the
   * published document moves — set at the end of a successful `load()`.
   */
  private trustedLayerDocs: readonly Record<string, unknown>[] = []
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
    this.watch = resolveWatchTuning(config.watch)
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
   * layer: the merged section is diffed against the shadow of what we last
   * published, and the delta is applied onto the user settings file's own
   * section, rewritten atomically. The shadow advances only after the atomic
   * rename resolves, so an interrupted persist never desyncs it.
   * @param ns - the namespace being written.
   * @param section - the complete merged user section to store.
   */
  protected async persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    // Freeze the diff base NOW, at capture time: a queued reload may reset the
    // live shadow before the queued persistSection executes, and diffing the
    // reset shadow would re-emit keys the document already had. Serialize with
    // watcher-triggered reloads on the one operation chain.
    const current = this.shadow[ns]
    const base: Record<string, unknown> = structuredClone(isPlainObject(current) ? current : {})
    // Serialize with watcher-triggered reloads on the one operation chain, and
    // retry optimistically when an external edit lands between the read and
    // the atomic rename.
    return this.enqueue(() => this.persistSection(ns, base, section))
  }

  /** Resolves when every queued reload/persist has settled (never rejects). */
  settled(): Promise<void> {
    return this.operations
  }

  /** Queue one exclusive document operation behind every earlier one. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  /** Queue a reload; a failed reload keeps the last-good document and stays only a warning. */  private queueRefresh(): void {
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
   * Persist one namespace with optimistic concurrency: re-read the user-file
   * bytes immediately before the atomic rename; on concurrent change restart
   * from a fresh read (bounded, then loud). The diff base is the caller-frozen
   * shadow snapshot at capture time; the shadow moves only after the write
   * has durably succeeded.
   */
  private async persistSection(
    ns: SettingsNamespace,
    base: Record<string, unknown>,
    section: Record<string, unknown>,
  ): Promise<void> {
    const path = this.documentPath
    let lastError: unknown
    for (let attempt = 0; attempt < MAX_PERSIST_ATTEMPTS; attempt++) {
      const ops = diffSections(base, section)
      if (ops.length === 0) {
        this.shadow[ns] = structuredClone(section)
        return
      }
      const before = await readUserText(path)
      const root = before === undefined || before.trim().length === 0 ? {} : this.parse(path, before)
      const next = applyOpsToSection(root[ns], ops)
      const updated = { ...root, [ns]: next }
      if ((await readUserText(path)) !== before) {
        lastError = new Error(`settings-cascade: user settings file at ${path} changed concurrently during persist`)
        continue
      }
      await writeJsonAtomic(path, updated)
      this.shadow[ns] = structuredClone(section)
      return
    }
    throw lastError ?? new Error(`settings-cascade: persist at ${path} exhausted ${MAX_PERSIST_ATTEMPTS} optimistic-retry attempts`)
  }

  /**
   * Edit the RAW user file's own section for a namespace (never the merged
   * section, so higher-layer entries are not smeared in), atomically with
   * optimistic re-read retry (re-applying `edit` to the fresh root — edits
   * may be non-idempotent), then republish via `load()` so the merged view
   * and shadow stay consistent. `undefined` edit = no-op. Throws without a
   * userSettings source.
   */
  editUserSection(ns: SettingsNamespace, edit: UserSectionEdit): Promise<void> {
    return this.enqueue(() => runUserSectionEdit({
      path: this.documentPath,
      parse: (path, text) => this.parse(path, text),
      isClosed: () => this.isClosed(),
      reload: async () => { this.publish(await this.load()) },
    }, ns, edit))
  }

  /** Every concrete settings FILE path worth watching (see {@link resolveWatchPaths}). */
  private watchPaths(): Promise<{ files: string[] }> {
    return resolveWatchPaths([
      this.spec.sources.userSettings,
      this.spec.sources.projectSettings,
      this.spec.sources.localSettings,
      this.spec.sources.flagSettings,
      this.spec.policy.systemPath,
      this.spec.policy.userPath,
    ])
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    // The base init loads and publishes the merged document; a parse failure
    // there is a boot failure and stays loud.
    yield* super[Service.init]()
    const refresh = () => {
      if (this.isClosed()) return
      this.queueRefresh()
    }
    const closeWatchers = startWatchers({
      paths: await this.watchPaths(),
      tuning: this.watch,
      refresh,
      onError: (error) => {
        this.ctx.logger.warn('settings-cascade: watcher error')
        this.ctx.logger.warn(error)
      },
    })
    yield async () => {
      this.closed = true
      await closeWatchers()
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
   * Read one top-level settings `key` from the TRUSTED layers only — user
   * settings, the flag layer (file + inline), and managed/policy — skipping
   * the project and local (repo-carried) layers. Trusted values deep-merge in
   * merge order (user → flag → policy) with ordinary merge semantics, the same
   * rule as {@link reassembleTrustedKey}. `key` is deliberately NOT added to
   * {@link TRUSTED_SOURCE_KEYS}: the merged document every other consumer sees
   * keeps the full provenance-lossy merge, so this is a per-consumer view and
   * not a global trusted-scope opt-in.
   *
   * Computed from the retained raw layers (never by mutating the merged
   * document) and returned detached, so a caller cannot perturb the published
   * view. Total by contract: no load yet, a key no trusted layer carries, a
   * non-object reassembly result, or a junk layer shape all yield `undefined`.
   * @param key - the top-level settings key to reassemble.
   * @returns the trusted-only value of `key`, or `undefined`.
   */
  trustedSection(key: string): Record<string, unknown> | undefined {
    try {
      const scratch: Record<string, unknown> = {}
      reassembleTrustedKey(scratch, this.trustedLayerDocs, key)
      const value = Object.hasOwn(scratch, key) ? scratch[key] : undefined
      return isPlainObject(value) ? structuredClone(value) : undefined
    } catch {
      return undefined
    }
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

    // D12 trusted scope: reassemble the trusted-only keys from trusted layers
    // (user/flag/policy) only — see ./trusted-scope.ts.
    const trustedLayers = [user, flag, policy]
    reassembleTrustedAutoMode(merged, trustedLayers)
    for (const key of TRUSTED_SOURCE_KEYS) reassembleTrustedKey(merged, trustedLayers, key)

    // CC camelCase top-level keys alias onto kebab namespaces before the env
    // split / publish, so the shadow mirrors exactly what the seam resolves.
    const { env, ...document } = applyCcKeyAliases(merged)
    this.env = this.coerceEnvSection(env)
    this.shadow = structuredClone(document)
    // Retain the raw trusted layers for {@link trustedSection} — after the
    // alias application, so the trusted view moves only with the document.
    this.trustedLayerDocs = trustedLayers
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
