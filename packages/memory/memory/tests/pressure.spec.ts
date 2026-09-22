import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FakeMemoryFs } from './helpers.ts'
import { PRESSURE_FILE, readPressure, armPressure, markPressureForced, clearPressure } from '../src/pressure.ts'

/**
 * The consolidation-pressure marker: parse/format round-trips, tombstone
 * semantics, arm preserving `lastForcedAt`, and the byte-exact writer
 * outputs over the in-memory fs seam.
 */

const DIR = '/mem/projects/repo'

async function setup(seed: Record<string, string> = {}) {
  const ctx = new Context()
  const fs = new FakeMemoryFs(ctx)
  for (const [path, content] of Object.entries(seed)) fs.seed(path, content)
  return fs
}

const FILE = `${DIR}/${PRESSURE_FILE}`

describe('readPressure', () => {
  it('returns zeros when the marker is absent', async () => {
    const fs = await setup()
    await expect(readPressure(fs, DIR)).resolves.toEqual({ armedAt: 0, lastForcedAt: 0 })
  })

  it('round-trips an armed marker', async () => {
    const fs = await setup({ [FILE]: '100\n200\n' })
    await expect(readPressure(fs, DIR)).resolves.toEqual({ armedAt: 100, lastForcedAt: 200 })
  })

  it('treats corrupt content as absent (zeros)', async () => {
    for (const content of ['garbage', '', 'abc\ndef', '\n\n']) {
      const fs = await setup({ [FILE]: content })
      await expect(readPressure(fs, DIR)).resolves.toEqual({ armedAt: 0, lastForcedAt: 0 })
    }
  })
})

describe('armPressure', () => {
  it('writes the armed format and reports success', async () => {
    const fs = await setup()
    await expect(armPressure(fs, DIR, 1000)).resolves.toBe(true)
    expect(fs.backingText(FILE)).toBe('1000\n0\n')
  })

  it('preserves a previous lastForcedAt across a fresh arm', async () => {
    const fs = await setup({ [FILE]: '100\n200\n' })
    await armPressure(fs, DIR, 3000)
    expect(fs.backingText(FILE)).toBe('3000\n200\n')
  })

  it('reports false and writes nothing when the fs write throws', async () => {
    const fs = await setup()
    vi.spyOn(fs, 'writeText').mockRejectedValue(new Error('disk gone'))
    await expect(armPressure(fs, DIR, 1000)).resolves.toBe(false)
  })
})

describe('markPressureForced / clearPressure', () => {
  it('stamps lastForcedAt while keeping armedAt, byte-exact', async () => {
    const fs = await setup({ [FILE]: '100\n0\n' })
    await markPressureForced(fs, DIR, 100, 5000)
    expect(fs.backingText(FILE)).toBe('100\n5000\n')
  })

  it('clearPressure writes the tombstone keeping lastForcedAt', async () => {
    const fs = await setup({ [FILE]: '100\n5000\n' })
    await clearPressure(fs, DIR, 9000)
    expect(fs.backingText(FILE)).toBe('0\n9000\n')
    await expect(readPressure(fs, DIR)).resolves.toEqual({ armedAt: 0, lastForcedAt: 9000 })
  })

  it('swallows fs failures in both writers', async () => {
    const fs = await setup()
    vi.spyOn(fs, 'writeText').mockRejectedValue(new Error('disk gone'))
    await expect(markPressureForced(fs, DIR, 1, 2)).resolves.toBeUndefined()
    await expect(clearPressure(fs, DIR, 2)).resolves.toBeUndefined()
  })
})
