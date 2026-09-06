/**
 * Claude Code-style settings migration plugin. On mount it runs every registered
 * migration whose version exceeds the recorded `migrationVersion`, mirroring CC's
 * run-at-startup behavior. A failed batch never takes down the host: the error is
 * logged as a warning and the recorded version is retained so the next mount
 * re-attempts the survivors. The mechanism itself — `defineMigration`,
 * `runMigrations`, `readMigrationState` — is exported for direct invocation.
 *
 * This batch ships no real migrations: cc/dsh has no legacy format to migrate yet.
 * The first concrete migration will land with the first settings-shape change.
 * @module @dsh-cc/settings-migrations
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { listMigrations, runMigrations, type MigrateOptions } from './migrate.ts'

export {
  DEFAULT_STATE_FILENAME,
  defineMigration,
  listMigrations,
  readMigrationState,
  runMigrations,
  type MigrateOptions,
  type Migration,
  type MigrationContext,
  type MigrationState,
} from './migrate.ts'

/** Cordis plugin id. */
export const name = 'settings-migrations'

/** Plugin configuration: file locations and the auto-run switch. */
export interface Config {
  /** Harness home used to derive the default settings/state paths. */
  dshHome?: string
  /** `settings.json` path override (defaults to `<home>/settings.json`). */
  settingsPath?: string
  /** Migration state path override (defaults to `<home>/migrations.json`). */
  statePath?: string
  /** Run pending migrations on mount. Defaults to true (CC runs at startup). */
  autoRunOnMount?: boolean
}

/** Runtime config schema (all fields optional). */
export const Config: z<Config> = z.object({
  dshHome: z.string(),
  settingsPath: z.string(),
  statePath: z.string(),
  autoRunOnMount: z.boolean(),
})

/**
 * Mount the migration runner. With `autoRunOnMount` (the default) pending
 * registered migrations run against the resolved settings/state paths; a failure
 * warms but never crashes the host and retains the recorded version.
 * @param ctx - the plug context.
 * @param config - plugin configuration.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (config.autoRunOnMount === false) return
  const options: MigrateOptions = {}
  if (config.dshHome !== undefined) options.home = config.dshHome
  if (config.settingsPath !== undefined) options.settingsPath = config.settingsPath
  if (config.statePath !== undefined) options.statePath = config.statePath
  try {
    const state = await runMigrations(listMigrations(), options)
    ctx.logger.info(`settings-migrations: at migrationVersion ${state.migrationVersion}`)
  } catch (error) {
    // A failed batch must never take down the host: warn and retain the version.
    ctx.logger.warn(`settings-migrations: batch failed, version retained: ${String(error)}`)
  }
}
