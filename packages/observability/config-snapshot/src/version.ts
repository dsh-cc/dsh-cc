/**
 * Own-version reader for the config-snapshot sidecar. Copied from
 * `@dsh-cc/command-version` (`interaction/command-version/src/version.ts`) per
 * the design doc §3.5 (a): cross-package import is excluded by the repo's
 * `check:deep-imports` gate — deliberate duplication. The copy reads THIS
 * package's `package.json`, correct because workspace packages share the
 * release-train version. The fallback constant is rewritten in lockstep by
 * `scripts/release.mjs` (§5 item 7).
 *
 * @module @dsh-cc/config-snapshot/version
 */

import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Compile-time fallback when `package.json` cannot be located in a bundled deploy. */
export const FALLBACK_VERSION = '0.9.0-rc.3'

/**
 * Read this package's own version from its `package.json`, falling back to the
 * compile-time constant when the file cannot be located in a bundled deploy.
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
