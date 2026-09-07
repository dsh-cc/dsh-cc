/**
 * On-disk state types for Claude Code plugin management, byte-shape parity
 * with the real CLI (v2.1.236): `known_marketplaces.json`, v2
 * `installed_plugins.json`, and the per-scope settings file shapes.
 *
 * @module @dsh-cc/plugin-manager/types
 */

export type Scope = 'user' | 'project' | 'local'

export type MarketplaceSource =
  | { source: 'directory'; path: string }
  | { source: 'github'; repo: string }
  | { source: 'git'; url: string }

/** The kind tag of a marketplace source: `directory`, `github`, or `git`. */
export type MarketplaceSourceKind = MarketplaceSource['source']

/** One entry of `known_marketplaces.json`, keyed by marketplace name. */
export interface KnownMarketplaceEntry {
  source: MarketplaceSource
  installLocation: string
  lastUpdated: string
  autoUpdate?: boolean
}

/** Parsed shape of `<claudeHome>/plugins/known_marketplaces.json` (defaults to `{}`). */
export type KnownMarketplacesFile = Record<string, KnownMarketplaceEntry>

/** The `extraKnownMarketplaces` declaration inside a scope settings file. */
export type ExtraKnownMarketplaces = Record<string, { source: MarketplaceSource }>

/** `enabledPlugins` map inside a scope settings file: plugin id → boolean. */
export type EnabledPlugins = Record<string, boolean>

/** One install entry (one per scope) inside `installed_plugins.json`. */
export interface InstallEntry {
  scope: Scope
  installPath: string
  version: string
  installedAt: string
  lastUpdated: string
  gitCommitSha?: string
  projectPath?: string
}

/** Parsed shape of `<claudeHome>/plugins/installed_plugins.json` (defaults to `{version:2, plugins:{}}`). */
export interface InstalledPluginsFile {
  version: 2
  plugins: Record<string, InstallEntry[]>
}

/** Loose shape of a scope settings file as the manager touches it. */
export interface ScopeSettingsFile {
  enabledPlugins?: EnabledPlugins
  extraKnownMarketplaces?: ExtraKnownMarketplaces
  [key: string]: unknown
}
