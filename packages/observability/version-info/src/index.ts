/**
 * Single owner of the "read my own `package.json` version" idiom.
 *
 * Three packages each carried a byte-identical copy (a deliberate duplication,
 * because `check:deep-imports` forbids cross-package `src/` imports), and
 * `scripts/release.mjs` had to rewrite every copy's `FALLBACK_VERSION` in
 * lockstep. One copy was already four releases stale. This package is the
 * recorded home; consumers re-export from here and the release script rewrites
 * exactly one constant.
 *
 * Every package in this workspace shares the release-train version, so reading
 * THIS package's manifest answers the same question for all callers.
 *
 * @module @dsh-cc/version-info
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Compile-time fallback, kept in sync with this package's `package.json` version. */
export const FALLBACK_VERSION = '0.9.4'

/**
 * Read the release-train version from this package's own `package.json`.
 *
 * Resolution walks up from the compiled module directory; a missing or
 * unreadable file (a bundled deploy without `package.json`) returns the
 * fallback constant rather than throwing, so version reporting stays total and
 * offline-safe.
 *
 * @param fallback - value returned when the manifest cannot be read; defaults
 *   to {@link FALLBACK_VERSION}. Callers pass their own constant only when they
 *   must keep a package-specific fallback.
 * @returns the package version string.
 */
export async function readOwnVersion(fallback: string = FALLBACK_VERSION): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const root = join(here, '..')
    const raw = await readFile(join(root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.length > 0) return parsed.version
  } catch {
    // Fall through to the constant.
  }
  return fallback
}
