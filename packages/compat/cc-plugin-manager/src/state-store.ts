/**
 * JSON state-file I/O for Claude Code plugin management: typed loaders with
 * documented missing-file defaults (C10), malformed-JSON typed errors (never
 * silently rewritten), and atomic save (tmp + rename) round-tripping plain
 * objects so callers' read-modify-write preserves unknown keys and key
 * order (C11).
 *
 * @module @dsh-cc/plugin-manager/state-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { malformedStateFile } from './errors.ts'
import type { InstalledPluginsFile, KnownMarketplacesFile, ScopeSettingsFile } from './types.ts'

/**
 * Read a JSON file. Missing file → `fallback`. Malformed content → typed
 * `State file <path> is malformed JSON: <detail>`.
 */
export async function loadJsonFile<T>(file: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw malformedStateFile(file, (error as Error).message)
  }
}

/** Save atomically: 2-space + trailing newline, `<file>.tmp-<pid>` then rename, parents created. */
export async function saveJsonFileAtomic(file: string, value: unknown): Promise<void> {
  const parent = dirname(file)
  await mkdir(parent, { recursive: true })
  const tmpFile = `${file}.tmp-${process.pid}`
  await writeFile(tmpFile, JSON.stringify(value, null, 2) + '\n', 'utf8')
  await rename(tmpFile, file)
}

/** `known_marketplaces.json` — defaults to `{}` (C10). */
export async function loadKnownMarketplaces(file: string): Promise<KnownMarketplacesFile> {
  return loadJsonFile<KnownMarketplacesFile>(file, {})
}

/** `installed_plugins.json` — defaults to `{version:2, plugins:{}}` (C10). */
export async function loadInstalledPlugins(file: string): Promise<InstalledPluginsFile> {
  return loadJsonFile<InstalledPluginsFile>(file, { version: 2, plugins: {} })
}

/** A scope settings file — defaults to `{}`; unknown keys survive by round-trip (C11). */
export async function loadSettingsFile(file: string): Promise<ScopeSettingsFile> {
  return loadJsonFile<ScopeSettingsFile>(file, {})
}
