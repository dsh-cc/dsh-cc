/**
 * Plugin-mount registry for the cc-shell glue plugin.
 *
 * Tracks every Claude Code plugin directory the glue mounts (keyed by plugin
 * root) and exposes a `ccPlugins` service so host plugins — slash commands such
 * as `/plugin`, `/reload-plugins`, `/mcp` — can enumerate what is mounted and
 * rescan the on-disk discovery roots live. Rescan disposes all tracked mounts
 * in reverse mount order (the innermost/last-mounted tear down first) and then
 * re-runs the same best-effort discovery the glue performs at activation,
 * collecting per-plugin failures without aborting the rest.
 *
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import {
  discoverCcPluginRoots,
  mountCcPlugin,
  type CcPluginCommandInfo,
  type DiscoveredCcPlugin,
  type MountedPluginCommand,
  type PluginLoadReport,
  type ResolveModel,
} from '@dsh-cc/plugin-loader'

export type { CcPluginCommandInfo } from '@dsh-cc/plugin-loader'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted Claude Code plugin registry, when cc-shell-glue is composed. */
    ccPlugins: CcPluginsService
  }

  interface Events {
    /** The mounted plugin set or its command table changed (mount/rescan). */
    'ccPlugins/change'(): void
  }
}

/** Constructor options for the plugin-mount registry. */
export interface CcPluginsServiceOptions {
  /**
   * Explicit discovery roots. `undefined` uses installed ∩ enabled; `[]` or
   * `null` disables discovery; a non-empty list flattens those dirs.
   */
  readonly pluginDirs?: readonly string[] | null
  /** Spawn-time model resolver threaded into every mounted agent. */
  readonly resolveModel?: ResolveModel
  /** Claude config home; defaults to `$CLAUDE_CONFIG_DIR` / `~/.claude`. When
   * only `claudeHome` is set (no `dshHome`), the loader keeps legacy
   * single-root behavior: that directory is both the read and the write root. */
  readonly claudeHome?: string
  /** dsh state home (`$DSH_HOME` / `~/.dsh`): the write root for dsh-managed
   * plugin state, merged per key over the Claude home (dsh wins). */
  readonly dshHome?: string
  /** Workspace used for project/local `enabledPlugins`; defaults to `process.cwd()`. */
  readonly cwd?: string
}

/** A tracked plugin mount's public summary. */
export interface CcPluginSummary {
  /** The plugin's manifest name. */
  name: string
  /** The plugin root directory holding `plugin.json`. */
  root: string
  /** Per-component load outcome. */
  components: PluginLoadReport['components']
}

/** One failure (or dispose error) surfaced from a rescan, keyed by plugin root. */
export interface CcPluginRescanError {
  /** The plugin root that failed to mount (or whose mount failed to dispose). */
  root: string
  /** The manifest name, when a mount was disposed and the manifest was known. */
  name?: string
  /** The error message. */
  error: string
}

/** A result of running one plugin command through the local channel. */
export type CcPluginCommandRunResult = { ok: true } | { ok: false; reason: string }

/** Live per-root mount bookkeeping. */
interface TrackedMount {
  root: string
  name: string
  dispose(): void
  report: PluginLoadReport
}

type MountResult = { ok: true } | { ok: false; error: string }

/**
 * The `ccPlugins` service: enumerate and rescan the mounted Claude Code plugins.
 *
 * Publication is deliberately host-realm: the CC preset mounts cc-shell-glue
 * inside the `cc-services` isolate realm (`packages/preset/cc/agent.cordis.yml`),
 * and a realm-scoped `Service.provide` stores the implementation under a
 * realm-private key — invisible to host-plane sibling bundles (the TUI driver
 * catalog/run seams, `/help`) whose contexts resolve `ccPlugins` against the
 * root realm. The preset invariant also rejects a preset fiber publishing a
 * service into the root realm, so the sanctioned shape (the invariant's own
 * "move to the host composition") is used instead: the instance is provided
 * from the ROOT fiber via `ctx.root.provide`, making it resolvable by every
 * context (`ctx.get` and property access alike). The registry is process-global
 * discovery (cwd, `~/.claude`), so one root-realm instance is the intended
 * shape. The glue fiber keeps the lifecycle: an effect on it clears the
 * publication when cc-shell-glue unloads, so consumers degrade to `undefined`
 * instead of holding a dead registry; a later remount takes the slot back.
 */
export class CcPluginsService {
  /** Live mounts keyed by plugin root directory. */
  private readonly mounts = new Map<string, TrackedMount>()

  /** Live plugin commands keyed by their colon display name (`plugin:command`). */
  private readonly commandTable = new Map<string, MountedPluginCommand>()

  /** The context this registry is mounted on (the glue plugin's context). */
  public readonly ctx: Context

  constructor(
    ctx: Context,
    private readonly options: CcPluginsServiceOptions = {},
  ) {
    this.ctx = ctx
    const root = ctx.root
    const rootKey = root[Context.isolate]['ccPlugins']
    const existing = rootKey === undefined ? undefined : root.reflect.store[rootKey]
    if (existing === undefined) {
      root.provide('ccPlugins', this)
    } else if (existing.value !== this) {
      // Take the publication back after an unload cleared it (or adopt a
      // stale slot from an unloaded sibling instance).
      root.set('ccPlugins', this)
    }
    ctx.fiber.effect(() => () => {
      if (root.get('ccPlugins', false) === this) root.set('ccPlugins', undefined)
    }, 'ccPlugins: clear host-realm publication on unload')
  }

  /** Recompute discovery from the stored options (so rescan re-reads the cascade). */
  private discover(): DiscoveredCcPlugin[] {
    return discoverCcPluginRoots({
      ...this.options.pluginDirs !== undefined ? { pluginDirs: this.options.pluginDirs } : {},
      ...this.options.claudeHome !== undefined ? { claudeHome: this.options.claudeHome } : {},
      ...this.options.dshHome !== undefined ? { dshHome: this.options.dshHome } : {},
      ...this.options.cwd !== undefined ? { cwd: this.options.cwd } : {},
      log: this.ctx.logger,
    })
  }

  /** Mount one plugin root and track it; never throws (failures are logged). */
  private async mountOne(plugin: DiscoveredCcPlugin): Promise<MountResult> {
    try {
      const mounted = await mountCcPlugin(this.ctx, {
        root: plugin.root,
        nameHint: plugin.nameHint,
        ...this.options.resolveModel !== undefined ? { resolveModel: this.options.resolveModel } : {},
      })
      this.mounts.set(plugin.root, {
        root: plugin.root,
        name: mounted.report.name,
        dispose: mounted.dispose,
        report: mounted.report,
      })
      for (const command of mounted.commands) {
        this.commandTable.set(command.info.name, command)
      }
      return { ok: true }
    } catch (error) {
      const message = String(error)
      this.ctx.logger.warn(`cc-shell-glue: failed to mount CC plugin at ${plugin.root}: ${message}`)
      return { ok: false, error: message }
    }
  }

  /**
   * Discover and mount every configured plugin root. Returns per-plugin
   * failures without halting the remaining roots.
   */
  async mountAll(): Promise<CcPluginRescanError[]> {
    const errors: CcPluginRescanError[] = []
    for (const plugin of this.discover()) {
      const result = await this.mountOne(plugin)
      if (!result.ok) errors.push({ root: plugin.root, error: result.error })
    }
    this.ctx.emit('ccPlugins/change')
    return errors
  }

  /** Enumerate the currently mounted plugins. */
  list(): CcPluginSummary[] {
    return Array.from(this.mounts.values()).map(mount => ({
      name: mount.name,
      root: mount.root,
      components: mount.report.components,
    }))
  }

  /**
   * Dispose all tracked mounts in reverse mount order, then re-run discovery
   * and mount from the same roots. Individual failures are collected and the
   * remaining plugins still mount. The command table is rebuilt wholesale and
   * a `ccPlugins/change` event fires when the rescan settles.
   */
  async rescan(): Promise<CcPluginRescanError[]> {
    const errors: CcPluginRescanError[] = []
    const tracked = Array.from(this.mounts.values()).reverse()
    this.mounts.clear()
    this.commandTable.clear()
    for (const mount of tracked) {
      try {
        mount.dispose()
      } catch (error) {
        errors.push({ root: mount.root, name: mount.name, error: String(error) })
      }
    }
    for (const plugin of this.discover()) {
      const result = await this.mountOne(plugin)
      if (!result.ok) errors.push({ root: plugin.root, error: result.error })
    }
    this.ctx.emit('ccPlugins/change')
    return errors
  }

  /** Enumerate the mounted plugin commands (colon display names). */
  listPluginCommands(): readonly CcPluginCommandInfo[] {
    return Array.from(this.commandTable.values(), command => command.info)
  }

  /**
   * Run one plugin command by its colon display name: render the command body
   * with the raw input substituted for `$ARGUMENTS` and dispatch it as a user
   * prompt on the given agent. This is the local channel for the
   * `plugin:command` form, which never reaches the harness command registry.
   */
  async runPluginCommand(
    name: string,
    input: { agent: unknown; rawInput: string },
  ): Promise<CcPluginCommandRunResult> {
    const command = this.commandTable.get(name)
    if (command === undefined) return { ok: false, reason: `unknown plugin command "${name}"` }
    const result = await command.run(input as { agent: { followup(message: unknown): unknown }; rawInput: string })
    if (result.kind === 'success') return { ok: true }
    return { ok: false, reason: result.text }
  }
}
