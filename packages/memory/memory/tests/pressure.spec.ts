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

describe('markPressureForced concurrency (issue #335 Face A)', () => {
  it('preserves a newer concurrent arm instead of clobbering it back to the captured value', async () => {
    const fs = await setup({ [FILE]: '2000\n0\n' })
    await markPressureForced(fs, DIR, 1000, 5000)
    expect(fs.backingText(FILE)).toBe('2000\n5000\n')
  })

  it('keeps the captured arm when the current marker is older', async () => {
    const fs = await setup({ [FILE]: '500\n0\n' })
    await markPressureForced(fs, DIR, 1000, 5000)
    expect(fs.backingText(FILE)).toBe('1000\n5000\n')
  })

  it('does not resurrect an arm another dream already served (tombstoned marker stays 0)', async () => {
    const fs = await setup({ [FILE]: '0\n4000\n' })
    await markPressureForced(fs, DIR, 1000, 5000)
    expect(fs.backingText(FILE)).toBe('0\n5000\n')
  })

  it('falls back to the captured arm when the marker is unreadable', async () => {
    const fs = await setup({ [FILE]: '100\n0\n' })
    vi.spyOn(fs, 'readText').mockRejectedValue(new Error('disk gone'))
    await markPressureForced(fs, DIR, 100, 5000)
    expect(fs.backingText(FILE)).toBe('100\n5000\n')
  })

  it('falls back to the captured arm when the marker content is corrupt', async () => {
    const fs = await setup({ [FILE]: 'garbage' })
    await markPressureForced(fs, DIR, 100, 5000)
    expect(fs.backingText(FILE)).toBe('100\n5000\n')
  })
})

describe('armPressure monotone arming (issue #335)', () => {
  it('stamps strictly above the previous armedAt when now is not newer', async () => {
    const fs = await setup({ [FILE]: '100\n200\n' })
    await armPressure(fs, DIR, 50)
    expect(fs.backingText(FILE)).toBe('101\n200\n')
  })

  it('stamps now when it is strictly newer than the previous armedAt', async () => {
    const fs = await setup({ [FILE]: '100\n200\n' })
    await armPressure(fs, DIR, 300)
    expect(fs.backingText(FILE)).toBe('300\n200\n')
  })
})

describe('clearPressure conditional tombstone (issue #335 Face B)', () => {
  it('keeps an arm newer than the one the dream served, advancing lastForcedAt', async () => {
    const fs = await setup({ [FILE]: '2000\n0\n' })
    await clearPressure(fs, DIR, 9000, undefined, 1000)
    expect(fs.backingText(FILE)).toBe('2000\n9000\n')
  })

  it('tombstones when the current arm is not newer than the served one', async () => {
    const fs = await setup({ [FILE]: '100\n0\n' })
    await clearPressure(fs, DIR, 9000, undefined, 1000)
    expect(fs.backingText(FILE)).toBe('0\n9000\n')
  })

  it('tombstones an equal armedAt (no aliasing: equal means already served)', async () => {
    const fs = await setup({ [FILE]: '1000\n0\n' })
    await clearPressure(fs, DIR, 9000, undefined, 1000)
    expect(fs.backingText(FILE)).toBe('0\n9000\n')
  })

  it('leaves existing bytes untouched when the marker is unreadable', async () => {
    const fs = await setup({ [FILE]: '2000\n0\n' })
    vi.spyOn(fs, 'readText').mockRejectedValue(new Error('disk gone'))
    await clearPressure(fs, DIR, 9000, undefined, 1000)
    expect(fs.backingText(FILE)).toBe('2000\n0\n')
  })

  it('leaves existing bytes untouched when the marker content is corrupt', async () => {
    const fs = await setup({ [FILE]: 'garbage' })
    await clearPressure(fs, DIR, 9000, undefined, 1000)
    expect(fs.backingText(FILE)).toBe('garbage')
  })

  it('is a no-op when the marker is absent', async () => {
    const fs = await setup()
    await clearPressure(fs, DIR, 9000, undefined, 1000)
    expect(fs.backingText(FILE)).toBeUndefined()
  })
})
