import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { FALLBACK_VERSION, readOwnVersion } from '@dsh-cc/version-info'

const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }

describe('readOwnVersion', () => {
  it('reads this package\'s manifest version', async () => {
    expect(await readOwnVersion()).toBe(manifest.version)
  })

  it('prefers the manifest over an explicit fallback', async () => {
    // The fallback only speaks when the file is unreadable; a readable manifest
    // wins even when a caller passes its own constant.
    expect(await readOwnVersion('9.9.9-unreachable')).toBe(manifest.version)
  })
})

describe('FALLBACK_VERSION', () => {
  it('is the release-train version the release script rewrites', () => {
    // Drift tripwire: scripts/release.mjs patches this single constant, so it
    // must equal the package version a release tags. It is the only copy left
    // (the previous per-package copies are gone).
    expect(FALLBACK_VERSION).toBe(manifest.version)
  })
})
