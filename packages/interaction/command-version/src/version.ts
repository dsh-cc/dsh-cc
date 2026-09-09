/**
 * Pure `/version` logic. Reads this package's own `package.json` version at
 * runtime (deterministic, no network), falling back to a compile-time constant
 * when the file cannot be located in a bundled deploy. The renderer appends a
 * harness version line only when the host surfaces one.
 * @module @dsh-cc/command-version/version
 */

import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Compile-time fallback, kept in sync with package.json `version`. */
export const FALLBACK_VERSION = '0.6.0'

/** A shared harness version reported by the host, or `undefined` when unknown. */
export type HarnessVersion = string | undefined

/**
 * Read this package's own version from its `package.json`. Resolution walks
 * up from the compiled module directory; a missing/unreadable file (bundled
 * deploy without package.json) returns the fallback constant rather than
 * throwing, keeping `/version` total and offline-safe.
 * @returns the package version string.
 */
export async function readOwnVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const root = join(here, '..')
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
  } catch {
    // Fall through to the constant.
  }
  return FALLBACK_VERSION
}

/**
 * Render the `/version` report.
 * @param own - this bundle's version.
 * @param harness - a host-surfaced harness version, or `undefined`.
 * @returns the multi-line version report.
 */
export function formatVersion(own: string, harness: HarnessVersion): string {
  const lines = [`@dsh-cc/plugins ${own}`]
  if (harness !== undefined && harness.length > 0) lines.push(`harness ${harness}`)
  return lines.join('\n')
}
