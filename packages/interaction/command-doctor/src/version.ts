/**
 * Version and Node engines helpers for `/doctor`. Reads this package's own
 * manifest (mirroring `/version`) and implements the repo's single engines
 * range without a `semver` dependency.
 * @module @dsh-cc/command-doctor/version
 */

import { readFileSync } from 'node:fs'

/** Fallback version when the manifest is unreadable. */
const FALLBACK_VERSION = '0.0.0'
/** Fallback engines range, matching this package's `package.json`. */
export const FALLBACK_ENGINES = '^22.19 || >=24'

/**
 * Read this package's manifest version, mirroring `apps/cli`'s self-version
 * read: every harness package shares `0.1.0-rc.x`, so the command package's
 * own manifest carries the harness version.
 * @returns the version string, or `0.0.0` when the manifest is unreadable.
 */
export function readVersion(): string {
  return readManifest().version ?? FALLBACK_VERSION
}

/**
 * Read this package's `engines.node` range (same manifest walk as
 * `readVersion`).
 * @returns the range string, or the known fallback when unreadable.
 */
export function readEngines(): string {
  return readManifest().engines ?? FALLBACK_ENGINES
}

/** Read the manifest fields this module cares about. */
function readManifest(): { version?: string | undefined; engines?: string | undefined } {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown; engines?: unknown }
    const version = typeof manifest.version === 'string' ? manifest.version : undefined
    const engines = typeof manifest.engines === 'object' && manifest.engines !== null
      ? (manifest.engines as { node?: unknown })
      : undefined
    return {
      version,
      engines: typeof engines?.node === 'string' ? engines.node : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * Whether a Node version satisfies this repo's only engines range,
 * `"^22.19 || >=24"`. Coarse by design: `v`-prefixed versions are accepted,
 * `22.x` requires `minor >= 19`, anything at or above 24 passes, and 23 fails.
 * @param version - a Node version string such as `22.19.0` or `v24.1.0`.
 */
export function nodeSatisfiesEngines(version: string): boolean {
  const parts = version.replace(/^v/u, '').split('.').map(part => Number(part))
  const major = parts[0] ?? NaN
  const minor = parts[1] ?? NaN
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false
  if (major === 22) return minor >= 19
  return major >= 24
}
