/**
 * Factory for the Claude Code plugin manager core: binds the state paths to
 * a `claudeHome` + `cwd` pair and exposes listing plus the enable/disable
 * mutations. Mutations serialize through a per-instance promise queue —
 * a subsequent call only starts after the previous one settles (in-process
 * lost-update protection; cross-process races are out of scope, CC does
 * not lock either).
 *
 * @module @dsh-cc/plugin-manager
 */

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GitRunner } from './git.ts'
import type { PathInputs } from './paths.ts'
import { listInstalled, type PluginListEntry } from './list.ts'
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  updateMarketplaces,
  type MarketplaceDeps,
  type AddedMarketplace,
  type MarketplaceEntry,
  type RemovedMarketplace,
  type AddMarketplaceOptions,
} from './marketplace.ts'
import { installPlugin, type InstallOptions, type InstallResult } from './install.ts'
import { uninstallPlugin, type UninstallOptions, type UninstallResult } from './uninstall.ts'
import { updatePlugin, type UpdateOptions, type UpdateResult } from './update.ts'
import { disablePlugin, enablePlugin, type ToggleResult } from './toggles.ts'

export type { Scope, MarketplaceSource, KnownMarketplaceEntry, KnownMarketplacesFile, ExtraKnownMarketplaces, EnabledPlugins, InstallEntry, InstalledPluginsFile, ScopeSettingsFile } from './types.ts'
export {
  PluginManagerError,
  malformedStateFile,
  unknownPlugin,
  ambiguousPluginName,
  pluginNotInstalled,
  ambiguousPluginScopes,
  unknownScope,
  type PluginManagerErrorCode,
} from './errors.ts'
export { parsePluginId, resolveInstalledPluginId, resolveDeclaredPluginId, readDeclaredPlugins, type DeclaredPlugin } from './resolve-id.ts'
export { installPlugin, type InstallOptions, type InstallResult } from './install.ts'
export { uninstallPlugin, type UninstallOptions, type UninstallResult } from './uninstall.ts'
export { updatePlugin, type UpdateOptions, type UpdateResult } from './update.ts'
export {
  marketplacePluginNotDeclared,
  unknownDeclaredPlugin,
  unsupportedPluginSource,
  pluginAlreadyInstalled,
  noInstallationAtScope,
  projectScopeEnabledGuard,
} from './errors.ts'
export { enablePlugin, disablePlugin, togglePlugin, type ToggleOptions, type ToggleResult } from './toggles.ts'
export { listInstalled, type PluginListEntry } from './list.ts'
export { listMarketplaces, addMarketplace, updateMarketplaces, removeMarketplace, classifySource, type MarketplaceDeps, type MarketplaceEntry, type AddedMarketplace, type RemovedMarketplace, type AddMarketplaceOptions, type ClassifiedSource } from './marketplace.ts'
export { createSystemGitRunner, gitFailure, type GitRunner, type GitRunnerOptions } from './git.ts'
export { unknownMarketplace, marketplaceConflict, invalidMarketplaceSource, marketplaceManifestMissing } from './errors.ts'

export interface CcPluginManagerOptions {
  /**
   * Compat-read (Claude) home. Defaults to `process.env.CLAUDE_CONFIG_DIR ??
   * join(homedir(), '.claude')`. Passing ONLY this keeps legacy single-root
   * behavior: the dsh home falls back to it, so reads and writes share it.
   */
  claudeHome?: string
  /**
   * dsh write home (plan §3.1). Resolution chain: explicit `dshHome` →
   * explicit `claudeHome` (legacy single-root) → `resolveDshHome()`
   * (`$DSH_HOME` → `~/.dsh`), so a no-options production caller is always
   * dual-home and never writes into the real `~/.claude`.
   */
  dshHome?: string
  /** Defaults to `process.cwd()`. */
  cwd?: string
  /** Injectable clock for future timestamped mutations. */
  now?: () => Date
  /** Injectable git runner for marketplace clones/updates (tests inject fakes). */
  runGit?: GitRunner
}

export interface ListOptions {
  /** `--enabled`: only rows with `effectiveEnabled === true`. */
  enabled?: boolean
  /** `--disabled`: only rows with `effectiveEnabled === false`. */
  disabled?: boolean
}

export interface CcPluginManager {
  list(opts?: ListOptions): Promise<PluginListEntry[]>
  enable(arg: string, opts?: { scope?: string }): Promise<ToggleResult>
  disable(arg: string, opts?: { scope?: string }): Promise<ToggleResult>
  install(arg: string, opts?: InstallOptions): Promise<InstallResult>
  uninstall(arg: string, opts?: UninstallOptions): Promise<UninstallResult>
  update(arg: string, opts?: UpdateOptions): Promise<UpdateResult>
  listMarketplaces(): Promise<MarketplaceEntry[]>
  addMarketplace(source: string, opts?: AddMarketplaceOptions): Promise<AddedMarketplace>
  updateMarketplaces(name?: string): Promise<string[]>
  removeMarketplace(name: string): Promise<RemovedMarketplace>
}

export function createCcPluginManager(options: CcPluginManagerOptions = {}): CcPluginManager {
  const claudeHome = options.claudeHome ?? process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude')
  const deps: PathInputs = {
    claudeHome,
    // Option-level resolution (plan §3.1): explicit dsh → explicit claude
    // (legacy single-root) → resolveDshHome() ($DSH_HOME → ~/.dsh).
    dshHome: options.dshHome ?? options.claudeHome ?? resolveDshHome(),
    cwd: options.cwd ?? process.cwd(),
  }
  const marketplaceDeps: MarketplaceDeps = { ...deps }
  if (options.now !== undefined) marketplaceDeps['now'] = options.now
  if (options.runGit !== undefined) marketplaceDeps['runGit'] = options.runGit

  // Per-instance promise queue: every mutation chains off the previous one
  // (`this.tail.then(run, run)` shape), so concurrent calls never interleave
  // their read-modify-write cycles.
  let tail: Promise<unknown> = Promise.resolve()

  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = tail.then(run, run)
    tail = result.catch(() => undefined)
    return result
  }

  function filterRows(rows: PluginListEntry[], opts?: ListOptions): PluginListEntry[] {
    if (opts?.enabled !== undefined) return rows.filter(row => row.effectiveEnabled === opts.enabled)
    if (opts?.disabled === true) return rows.filter(row => !row.effectiveEnabled)
    return rows
  }

  return {
    list(opts?: ListOptions): Promise<PluginListEntry[]> {
      return listInstalled(deps).then(rows => filterRows(rows, opts))
    },
    enable(arg: string, opts?: { scope?: string }): Promise<ToggleResult> {
      return enqueue(() => enablePlugin(deps, arg, opts))
    },
    disable(arg: string, opts?: { scope?: string }): Promise<ToggleResult> {
      return enqueue(() => disablePlugin(deps, arg, opts))
    },
    install(arg: string, opts?: InstallOptions): Promise<InstallResult> {
      return enqueue(() => installPlugin(marketplaceDeps, arg, opts))
    },
    uninstall(arg: string, opts?: UninstallOptions): Promise<UninstallResult> {
      return enqueue(() => uninstallPlugin(marketplaceDeps, arg, opts))
    },
    update(arg: string, opts?: UpdateOptions): Promise<UpdateResult> {
      return enqueue(() => updatePlugin(marketplaceDeps, arg, opts))
    },
    listMarketplaces(): Promise<MarketplaceEntry[]> {
      return listMarketplaces(marketplaceDeps)
    },
    addMarketplace(source: string, opts?: AddMarketplaceOptions): Promise<AddedMarketplace> {
      return enqueue(() => addMarketplace(marketplaceDeps, source, opts))
    },
    updateMarketplaces(name?: string): Promise<string[]> {
      return enqueue(() => updateMarketplaces(marketplaceDeps, name))
    },
    removeMarketplace(name: string): Promise<RemovedMarketplace> {
      return enqueue(() => removeMarketplace(marketplaceDeps, name))
    },
  }
}
