/**
 * mathlib-env provisioning behavioral tests (design §3.2 receipt discipline,
 * §4.2 environment): pin validation (sha256 required before provisioning,
 * expectedLean validated when present), local-first receipt reuse with no
 * network calls, invalid receipt = HARD ERROR (never a silent rebuild), the
 * full mocked provision path (tarball sha256 verify → mathlib lean-toolchain
 * selects the toolchain → wrapper lake project → lake exe cache get →
 * receipt), digest verification, and per-attempt build isolation (each
 * attempt gets its own wrapper-lakefile copy pointing at the immutable
 * shared env). No network anywhere: download/extract/run are injected.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  contentDigest, envStatus, prepareAttemptBuild, provision, validatePin, validateReceipt, verifyEnv,
} from '../skills/math-research/scripts/mathlib-env.mjs'
import { HEX, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

const REV = 'v4.35.0'
const PLATFORM = process.platform === 'linux' ? 'linux-x64' : 'darwin-arm64'

// A fully-filled pin whose hashes match the fabricated archives the mocked
// download writes (computed in makePin).
function makePin({ tarballSha, leanSha, expectedLean = 'leanprover/lean4:v4.35.0' }: { tarballSha: string; leanSha: string; expectedLean?: string }) {
  return {
    schemaVersion: 1,
    mathlib: { repo: 'leanprover-community/mathlib4', rev: REV, sha256: tarballSha },
    expectedLean,
    leanToolchain: {
      toolchain: 'leanprover/lean4:v4.35.0',
      platforms: {
        [PLATFORM]: { archiveUrl: 'https://example.invalid/lean.tar.zst', sha256: leanSha },
      },
    },
  }
}

interface FakeEnv { tarball: Buffer; leanArchive: Buffer; leanFiles: Record<string, string>; }
function fakeDeps(fake: FakeEnv) {
  const calls: string[] = []
  return {
    calls,
    download: async (url: string, dest: string) => {
      calls.push(`download:${url}`)
      const bytes = url.includes('/archive/refs/tags/') ? fake.tarball : fake.leanArchive
      await writeFile(dest, bytes)
      return createHash('sha256').update(bytes).digest('hex')
    },
    extract: async (_archive: string, dest: string) => {
      calls.push('extract:mathlib')
      await mkdir(dest, { recursive: true })
      // The extracted Mathlib source; its lean-toolchain selects the toolchain.
      await writeFile(join(dest, 'lean-toolchain'), 'leanprover/lean4:v4.35.0\n')
      await writeFile(join(dest, 'Mathlib.lean'), '-- umbrella\n')
    },
    extractLean: async (_archive: string, dest: string) => {
      calls.push('extract:lean')
      await mkdir(join(dest, 'bin'), { recursive: true })
      for (const [rel, content] of Object.entries(fake.leanFiles)) {
        await mkdir(join(dest, rel, '..'), { recursive: true }).catch(() => {})
        await writeFile(join(dest, rel), content)
      }
    },
    run: async (_cmd: string, args: string[], { cwd }: { cwd: string }) => {
      calls.push(`run:${args.join(' ')}`)
      if (args.join(' ') === 'exe cache get') {
        // The cache fetch materializes lake-manifest.json in the wrapper (cwd).
        await writeFile(join(cwd, 'lake-manifest.json'), '{"version":7,"packagesDir":".lake"}\n')
        return { exitCode: 0, stdout: 'Attempting to download 1 cache file\n', stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unknown command' }
    },
  }
}

async function makeSetup() {
  const root = await roots.make('mrh-mathlib-')
  const tarball = Buffer.from('fake mathlib tarball bytes')
  const leanArchive = Buffer.from('fake lean archive bytes')
  const leanFiles = { 'bin/lean': '#!/bin/sh fake lean\n', 'bin/lake': '#!/bin/sh fake lake\n', 'lib/lean/libleanshared.so': 'fake\n' }
  const pin = makePin({ tarballSha: createHash('sha256').update(tarball).digest('hex'), leanSha: createHash('sha256').update(leanArchive).digest('hex') })
  const pinPath = join(root, 'mathlib-pin.json')
  await writeFile(pinPath, JSON.stringify(pin))
  const dest = join(root, 'env', `${REV}-${PLATFORM}`)
  return { root, tarball, leanArchive, leanFiles, pin, pinPath, dest }
}

describe('mathlib-pin validation', () => {
  it('accepts the shipped pin with an empty sha256, but provisioning is config-invalid until filled (offline agents cannot know the bytes)', async () => {
    const unfilled = JSON.parse(await readFile(join(import.meta.dirname, 'fixtures', 'mathlib-pin', 'unfilled.json'), 'utf8'))
    expect(() => validatePin(unfilled)).not.toThrow()
    expect(() => validatePin(unfilled, { requireSecrets: true })).toThrowError(expect.objectContaining({ code: 'config-invalid', detail: expect.stringContaining('mathlib.sha256 is empty') }) as never)
    expect(() => validatePin({ ...unfilled, mathlib: { ...unfilled.mathlib, sha256: 'XYZ' } })).toThrowError(expect.objectContaining({ code: 'config-invalid' }) as never)
    expect(() => validatePin({ ...unfilled, expectedLean: 'lean4' })).toThrowError(expect.objectContaining({ code: 'config-invalid' }) as never)
  })
})

describe('mathlib-env provision (mocked network)', () => {
  it('provisions: tarball sha256-verified, toolchain from mathlib lean-toolchain, wrapper project, cache receipt', async () => {
    const { dest, pinPath, leanFiles, tarball } = await makeSetup()
    const deps = fakeDeps({ tarball, leanArchive: Buffer.from('fake lean archive bytes'), leanFiles })
    const result = await provision({ dest, pinPath, platform: PLATFORM }, deps)
    expect(result.status).toBe('provisioned')
    expect(result.envId).toBe(`${REV}-${PLATFORM}`)
    // Downloads: exactly the mathlib tarball + the lean archive; no source build.
    expect(deps.calls.filter(c => c.startsWith('download:'))).toHaveLength(2)
    expect(deps.calls).toContain('extract:mathlib')
    expect(deps.calls).toContain('extract:lean')
    expect(deps.calls).toContain('run:exe cache get')
    // Receipt per §4.2: { pin, leanDigest, mathlibSha256, cacheArtifactSha256, platform, provisionedAt }.
    const receipt = JSON.parse(await readFile(join(dest, 'env.receipt.json'), 'utf8'))
    const pin = JSON.parse(await readFile(pinPath, 'utf8'))
    expect(validateReceipt(receipt, pin, PLATFORM)).toEqual([])
    expect(receipt.mathlibSha256).toBe(createHash('sha256').update(tarball).digest('hex'))
    expect(receipt.leanDigest).toBe(await contentDigest(join(dest, 'lean')))
    expect(receipt.cacheArtifactSha256).toBe(createHash('sha256').update('{"version":7,"packagesDir":".lake"}\n').digest('hex'))
    // Wrapper lake project: lakefile points at the LOCAL mathlib path, toolchain file matches.
    expect(await readFile(join(dest, 'wrapper', 'lakefile.lean'), 'utf8')).toContain(join(dest, 'mathlib'))
    expect(await readFile(join(dest, 'wrapper', 'lean-toolchain'), 'utf8')).toBe('leanprover/lean4:v4.35.0\n')
  })

  it('local-first: a second provision reuses the valid receipt WITHOUT any network call', async () => {
    const { dest, pinPath, leanFiles, tarball } = await makeSetup()
    const deps = fakeDeps({ tarball, leanArchive: Buffer.from('fake lean archive bytes'), leanFiles })
    await provision({ dest, pinPath, platform: PLATFORM }, deps)
    deps.calls.length = 0
    const again = await provision({ dest, pinPath, platform: PLATFORM }, deps)
    expect(again.status).toBe('reused')
    expect(deps.calls.filter(c => c.startsWith('download:'))).toEqual([])
  })

  it('an invalid receipt is a HARD ERROR — never a silent rebuild', async () => {
    const { dest, pinPath, leanFiles, tarball } = await makeSetup()
    const deps = fakeDeps({ tarball, leanArchive: Buffer.from('fake lean archive bytes'), leanFiles })
    await provision({ dest, pinPath, platform: PLATFORM }, deps)
    const receipt = JSON.parse(await readFile(join(dest, 'env.receipt.json'), 'utf8'))
    receipt.envId = 'tampered-env-id'
    await writeFile(join(dest, 'env.receipt.json'), JSON.stringify(receipt))
    await expect(provision({ dest, pinPath, platform: PLATFORM }, deps)).rejects.toMatchObject({ code: 'receipt-invalid' })
    const status = await envStatus({ dest, pinPath, platform: PLATFORM })
    expect(status.status).toBe('invalid')
    expect(status.problems.join(';')).toContain('envId')
  })

  it('a tarball sha mismatch fails before any extraction', async () => {
    const { dest, pinPath, leanFiles, tarball } = await makeSetup()
    const deps = fakeDeps({ tarball, leanArchive: Buffer.from('fake lean archive bytes'), leanFiles })
    deps.download = async () => HEX('f') // lies about the hash
    await expect(provision({ dest, pinPath, platform: PLATFORM }, deps)).rejects.toMatchObject({ code: 'toolchain-mismatch' })
    expect(deps.calls).not.toContain('extract:lean')
  })

  it('expectedLean must match mathlib\'s own lean-toolchain when present', async () => {
    const { root, tarball, leanArchive, leanFiles } = await makeSetup()
    const pin = makePin({ tarballSha: createHash('sha256').update(tarball).digest('hex'), leanSha: createHash('sha256').update(leanArchive).digest('hex'), expectedLean: 'leanprover/lean4:v9.9.9' })
    const pinPath = join(root, 'pin-mismatch.json')
    await writeFile(pinPath, JSON.stringify(pin))
    const dest = join(root, 'env2')
    const deps = fakeDeps({ tarball, leanArchive, leanFiles })
    await expect(provision({ dest, pinPath, platform: PLATFORM }, deps)).rejects.toMatchObject({ code: 'config-invalid' })
  })

  it('a missing leanToolchain block is config-invalid, checked before the toolchain download', async () => {
    const { root, tarball, leanFiles } = await makeSetup()
    const raw = JSON.parse(await readFile(join(root, 'mathlib-pin.json'), 'utf8'))
    delete raw.leanToolchain
    const pinPath = join(root, 'pin-nolean.json')
    await writeFile(pinPath, JSON.stringify(raw))
    const deps = fakeDeps({ tarball, leanArchive: Buffer.from('fake lean archive bytes'), leanFiles })
    await expect(provision({ dest: join(root, 'env3'), pinPath, platform: PLATFORM }, deps)).rejects.toMatchObject({ code: 'config-invalid' })
    expect(deps.calls).not.toContain('extract:lean')
  })
})

describe('mathlib-env verify + status (offline)', () => {
  it('verify re-checks digests locally: clean env verifies, a tampered toolchain mismatches', async () => {
    const { dest, pinPath, leanFiles, tarball } = await makeSetup()
    const deps = fakeDeps({ tarball, leanArchive: Buffer.from('fake lean archive bytes'), leanFiles })
    await provision({ dest, pinPath, platform: PLATFORM }, deps)
    expect((await verifyEnv({ dest, pinPath, platform: PLATFORM })).status).toBe('verified')
    await writeFile(join(dest, 'lean', 'bin', 'lean'), 'tampered\n')
    const after = await verifyEnv({ dest, pinPath, platform: PLATFORM })
    expect(after.status).toBe('mismatch')
    expect(after.checks.leanDigest).toBe(false)
  })

  it('status distinguishes absent / provisioned / invalid env dirs', async () => {
    const { root, dest, pinPath, leanFiles, tarball } = await makeSetup()
    expect((await envStatus({ dest, pinPath, platform: PLATFORM })).status).toBe('absent')
    await provision({ dest, pinPath, platform: PLATFORM }, fakeDeps({ tarball, leanArchive: Buffer.from('fake lean archive bytes'), leanFiles }))
    expect((await envStatus({ dest, pinPath, platform: PLATFORM })).status).toBe('provisioned')
    const other = join(root, 'empty-env')
    await mkdir(other, { recursive: true })
    expect((await envStatus({ dest: other, pinPath, platform: PLATFORM })).status).toBe('invalid')
  })
})

describe('per-attempt build isolation (§4.2)', () => {
  it('each attempt gets its OWN wrapper-lakefile copy pointing at the shared immutable env', async () => {
    const { dest, pinPath, leanFiles, tarball } = await makeSetup()
    await provision({ dest, pinPath, platform: PLATFORM }, fakeDeps({ tarball, leanArchive: Buffer.from('fake lean archive bytes'), leanFiles }))
    const attemptA = await prepareAttemptBuild(dest, join(await roots.make('mrh-attempt-'), 'a', 'build'))
    const attemptB = await prepareAttemptBuild(dest, join(await roots.make('mrh-attempt-'), 'b', 'build'))
    const lakeA = await readFile(join(attemptA.buildDir, 'lakefile.lean'), 'utf8')
    const lakeB = await readFile(join(attemptB.buildDir, 'lakefile.lean'), 'utf8')
    // Same immutable env target (absolute mathlib path)…
    expect(lakeA).toContain(join(dest, 'mathlib'))
    expect(lakeB).toContain(join(dest, 'mathlib'))
    // …compiled in two different build dirs; the env's own wrapper is untouched.
    expect(attemptA.buildDir).not.toBe(attemptB.buildDir)
    expect((await stat(join(attemptA.buildDir, 'lean-toolchain'))).isFile()).toBe(true)
    expect((await stat(join(attemptB.buildDir, 'lean-toolchain'))).isFile()).toBe(true)
    // Nothing is written back into the env: its wrapper directory is read input.
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(join(dest, 'wrapper'))).sort()).toEqual(['lake-manifest.json', 'lakefile.lean', 'lean-toolchain'])
  })

  it('a missing wrapper project is a tooling error, not silence', async () => {
    const { root } = await makeSetup()
    await expect(prepareAttemptBuild(join(root, 'no-such-env'), join(root, 'b', 'build'))).rejects.toMatchObject({ code: 'toolchain-missing' })
  })
})
