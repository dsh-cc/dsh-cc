// Divergence: readOwnVersion pattern ported from @dsh-cc/command-version
// (packages/interaction/command-version/src/version.ts) for §5.3 branding.
/**
 * Read this package's own version from its `package.json` for ACP `agentInfo`.
 * Falls back to a compile-time constant in bundled deploys without the file.
 * @module @dsh-cc/acp/version
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Compile-time fallback, kept in sync with package.json `version`. */
export const FALLBACK_VERSION = '0.9.0-rc.3'

/**
 * Read this plugin's own version from its `package.json`.
 * @returns the package version string.
 */
export async function readOwnVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = await readFile(join(here, '..', 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
  } catch {
    // Fall through to the constant.
  }
  return FALLBACK_VERSION
}
