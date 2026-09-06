/**
 * Claude Code-style settings migration mechanism. `defineMigration()` registers a
 * versioned, named migration; `runMigrations()` applies every registered migration
 * whose version exceeds the recorded `migrationVersion`, in ascending order, against
 * an atomically-written `settings.json`.
 *
 * The whole batch succeeds only when every pending migration completes: a single
 * throw keeps the old recorded version and leaves the settings document untouched,
 * so the next run re-attempts the failing survivors. A guard returning `false`
 * skips a migration without blocking version advancement (mirroring Claude Code).
 * Migrations MUST be idempotent — see the README for the contract.
 * @module @dsh-cc/settings-migrations
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** A migration mutates the raw settings document in place via `ctx.settings`. */
export interface MigrationContext {
  /** The mutable raw settings document shared across the running batch. */
  settings: Record<string, unknown>
}

/** One versioned, named migration in the Claude Code style. */
export interface Migration {
  /** Monotonic version; migrations run in ascending version order. */
  version: number
  /** Human-readable name, surfaced in logs and errors. */
  name: string
  /** Optional self-guard; a `false` return skips the migration without blocking the batch. */
  guard?(ctx: MigrationContext): boolean | Promise<boolean>
  /** Apply the migration by mutating `ctx.settings` (must be idempotent). */
  migrate(ctx: MigrationContext): void | Promise<void>
}

/** Recorded migration state document. */
export interface MigrationState {
  /** The highest migration version whose batch has fully applied. */
  migrationVersion: number
}

/** Options controlling the default file locations for a migration run. */
export interface MigrateOptions {
  /** Harness home used to derive the default settings/state paths. */
  home?: string
  /** `settings.json` path; defaults to `<home>/settings.json`. */
  settingsPath?: string
  /** Migration state file path; defaults to `<home>/migrations.json`. */
  statePath?: string
}

/** Default migration-state filename inside the harness home. */
export const DEFAULT_STATE_FILENAME = 'migrations.json'

/** Registry of migrations contributed via {@link defineMigration}. */
const registry: Migration[] = []

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Resolve the settings/state paths, defaulting both from the harness home. */
function resolveOptions(options: MigrateOptions = {}): Required<Pick<MigrateOptions, 'settingsPath' | 'statePath'>> {
  const home = resolveDshHome(options.home)
  return {
    settingsPath: options.settingsPath ?? join(home, 'settings.json'),
    statePath: options.statePath ?? join(home, DEFAULT_STATE_FILENAME),
  }
}

/** Read a JSON file, returning `undefined` when it is absent. */
async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
  return JSON.parse(text) as T
}

/** Read the recorded migration state; an absent file yields version 0. */
export async function readMigrationState(statePath: string): Promise<MigrationState> {
  const state = await readJson<MigrationState>(statePath)
  const version = typeof state?.migrationVersion === 'number' ? state.migrationVersion : 0
  return { migrationVersion: version }
}

/** Read the raw settings document; an absent file yields an empty object. */
async function readSettingsDocument(path: string): Promise<Record<string, unknown>> {
  const doc = await readJson<unknown>(path)
  if (doc === undefined) return {}
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new TypeError(`settings-migrations: ${path} must be a JSON object`)
  }
  return doc as Record<string, unknown>
}

/** Write a file atomically: write to a sibling temp path, then rename into place. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, path)
}

/**
 * Register a migration into the module-level registry, deduplicated by
 * `version` + `name` so re-registration is idempotent. Returns the migration.
 */
export function defineMigration(migration: Migration): Migration {
  const index = registry.findIndex(m => m.version === migration.version && m.name === migration.name)
  if (index === -1) registry.push(migration)
  else registry[index] = migration
  return migration
}

/** Snapshot of the currently registered migrations, ascending by version. */
export function listMigrations(): Migration[] {
  return [...registry].sort((a, b) => a.version - b.version)
}

/**
 * Apply every migration whose version exceeds the recorded `migrationVersion`, in
 * ascending order, against the settings document. The batch succeeds only when all
 * pending migrations complete (a guard-`false` skip counts as success and does not
 * block version advancement). On success the possibly-mutated settings document is
 * written atomically and the recorded version advances to the latest pending version.
 * A single throw aborts the batch: nothing is written and the version stays put, so
 * the next run re-attempts the failing survivors.
 * @param migrations - the migrations to consider; a snapshot of the registry when omitted.
 * @param options - optional file-location overrides.
 * @returns the recorded state after the run (unchanged when nothing was pending).
 */
export async function runMigrations(
  migrations?: readonly Migration[],
  options?: MigrateOptions,
): Promise<MigrationState> {
  const list = migrations ?? listMigrations()
  const { settingsPath, statePath } = resolveOptions(options)
  const settings = await readSettingsDocument(settingsPath)
  const state = await readMigrationState(statePath)
  const pending = list
    .filter(m => m.version > state.migrationVersion)
    .sort((a, b) => a.version - b.version)
  if (pending.length === 0) return state

  const context: MigrationContext = { settings }
  for (const migration of pending) {
    if (migration.guard !== undefined && !(await migration.guard(context))) continue
    await migration.migrate(context)
  }
  const latest = pending[pending.length - 1]!.version
  const next: MigrationState = { migrationVersion: latest }
  await writeJsonAtomic(settingsPath, settings)
  await writeJsonAtomic(statePath, next)
  return next
}
