/**
 * Pure `/version` logic. The own-version read and its compile-time fallback
 * live in `@dsh-cc/version-info` (one owner, one rewrite target for
 * `scripts/release.mjs`); this module keeps the `/version`-specific renderer and
 * re-exports the shared surface so existing importers stay untouched.
 * @module @dsh-cc/command-version/version
 */

import { FALLBACK_VERSION, readOwnVersion } from '@dsh-cc/version-info'

export { FALLBACK_VERSION, readOwnVersion }

/** A shared harness version reported by the host, or `undefined` when unknown. */
export type HarnessVersion = string | undefined

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
