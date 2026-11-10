/**
 * Plugin-config shape and runtime-spec resolution for the settings cascade:
 * explicit paths win, otherwise defaults derive from the harness home and
 * the project directory. Extracted from the provider module so each stays
 * within the file-size budget; the public surface is re-exported unchanged
 * from the package root.
 * @module @dsh-cc/settings-cascade/spec
 */

import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { resolveLocalSettingsDir, type LocalRootDeps } from './local-root.ts'

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
