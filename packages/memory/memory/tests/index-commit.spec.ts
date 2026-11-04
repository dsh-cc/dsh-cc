import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { FakeMemoryFs } from './helpers.ts'
import {
  MemoryIndexConflictError,
  carveEntrypointRoom,
  commitMemoryWrites,
  mergeIndexContent,
  pointerAdditions,
  readIndexStrict,
} from '../src/index-commit.ts'
import { ENTRYPOINT_NAME, MAX_ENTRYPOINT_BYTES, MAX_ENTRYPOINT_LINES } from '../src/truncate.ts'

/**
 * The optimistic index commit protocol: read-then-verify-and-rebase around the
 * single `MEMORY.md` write, plus the pure merge/carve helpers the write-back
 * pipeline composes. Everything here runs on a deterministic in-memory fs —
 * no sleeps, no timers; interleavings are scripted through `writeText` hooks.
 */

describe('mergeIndexContent / pointerAdditions (pure)', () => {
  const base = '- [a](a.md) — model a\n'

  it('appends a pointer present only in the durable index', () => {
    const current = `${base}- [b](b.md) — b\n`
    expect(mergeIndexContent(base, current, base)).toBe(`${base}- [b](b.md) — b\n`)
    expect(pointerAdditions(current, base, base)).toEqual(['- [b](b.md) — b'])
  })

  it('skips an addition the model could already see (baseline-present = model deletion honored)', () => {
    const current = `${base}- [b](b.md) — b\n`
    expect(mergeIndexContent(base, current, current)).toBe(base)
    expect(pointerAdditions(current, base, current)).toEqual([])
  })

  it('keeps the base line on a same-target conflict (base wins)', () => {
    const modelBase = '- [a](a.md) — model description\n'
    const current = '- [a](a.md) — concurrent description\n- [b](b.md) — b\n'
    const baseline = '- [a](a.md) — concurrent description\n'
    expect(mergeIndexContent(modelBase, current, baseline)).toBe(
      '- [a](a.md) — model description\n- [b](b.md) — b\n',
    )
  })

  it('ignores non-pointer lines and multi-link lines use their first target', () => {
    const current = [
      base.trimEnd(),
      'just prose, no links here',
      '- [first](first.md) — x [second](second.md) — y',
    ].join('\n')
    // base already contains first.md, so the multi-link line is skipped even
    // though its SECOND target is absent.
    const withFirst = `${base}- [first](first.md) — x\n`
    expect(pointerAdditions(current, withFirst, withFirst)).toEqual([])
    // Against an empty base, the pointer lines qualify (first target absent);
    // the prose line is not a pointer line and is never appended.
    expect(mergeIndexContent('', current, '')).toBe(
      `${base.trimEnd()}\n- [first](first.md) — x [second](second.md) — y\n`,
    )
  })

  it('first duplicate target in current wins, later duplicates are skipped', () => {
    const current = `${base}- [b](b.md) — first\n- [b](b.md) — second\n`
    expect(pointerAdditions(current, base, base)).toEqual(['- [b](b.md) — first'])
    const merged = mergeIndexContent(base, current, base)
    expect(merged).toContain('— first')
    expect(merged).not.toContain('— second')
  })

  it('keeps additions in current order and terminates with a newline', () => {
    const current = `${base}- [c](c.md) — c\n- [b](b.md) — b\n`
    const merged = mergeIndexContent(base, current, base)
    expect(merged).toBe(`${base}- [c](c.md) — c\n- [b](b.md) — b\n`)
    expect(merged.endsWith('\n')).toBe(true)
  })

  it('an empty or whitespace-only base keeps just the additions, newline-terminated', () => {
    const current = '- [b](b.md) — b\n'
    expect(mergeIndexContent('', current, '')).toBe('- [b](b.md) — b\n')
    expect(mergeIndexContent('   \n', current, '')).toBe('- [b](b.md) — b\n')
  })

  it('returns the base unchanged when nothing qualifies', () => {
    expect(mergeIndexContent(base, base, base)).toBe(base)
  })
})

describe('carveEntrypointRoom (pure)', () => {
  const line = (i: number): string => `- [topic-${i}](topic-${i}.md) — entry ${i}`

  it('passes an under-cap merged document through unchanged', () => {
    const merged = '- [a](a.md) — a\n'
    expect(carveEntrypointRoom(merged, '- [a](a.md) — a\n', [])).toBe(merged)
  })

  it('drops model tail lines until the line budget fits the additions', () => {
    const model = Array.from({ length: 205 }, (_, i) => line(i)).join('\n')
    const additions = ['- [new-one](new-one.md) — n1', '- [new-two](new-two.md) — n2']
    const merged = `${model.trimEnd()}\n${additions.join('\n')}\n`
    const result = carveEntrypointRoom(merged, model, additions)
    const expectedModel = Array.from({ length: 198 }, (_, i) => line(i)).join('\n')
    expect(result).toBe(`${expectedModel}\n${additions.join('\n')}\n`)
    expect(result.trim().split('\n').length).toBe(MAX_ENTRYPOINT_LINES)
  })

  it('drops model tail lines until the BYTE budget fits the additions', () => {
    const modelLine = (i: number): string => `L${i}:`.padEnd(3000, 'x')
    const model = Array.from({ length: 10 }, (_, i) => modelLine(i)).join('\n')
    const addition = '- [new](new.md) — fresh addition'
    const merged = `${model.trimEnd()}\n${addition}\n`
    expect(Buffer.byteLength(merged.trim(), 'utf8')).toBeGreaterThan(MAX_ENTRYPOINT_BYTES)

    const result = carveEntrypointRoom(merged, model, [addition])
    expect(Buffer.byteLength(result.trim(), 'utf8')).toBeLessThanOrEqual(MAX_ENTRYPOINT_BYTES)
    expect(result).toContain(addition)
    // 8 full 3000-byte lines + the addition line is the largest fitting tail.
    expect(result.trim().split('\n').length).toBe(9)
    expect(result).toContain('L0:')
    expect(result).not.toContain('L9:')
  })

  it('throws when the additions alone exceed the line cap', () => {
    const model = Array.from({ length: 205 }, (_, i) => line(i)).join('\n')
    const additions = Array.from({ length: MAX_ENTRYPOINT_LINES + 1 }, (_, i) => line(i))
    const merged = `${model.trimEnd()}\n${additions.join('\n')}\n`
    expect(() => carveEntrypointRoom(merged, model, additions)).toThrow()
  })

  it('throws when the additions alone exceed the byte cap', () => {
    const model = 'L0:'.padEnd(3000, 'x')
    const addition = `- [huge](huge.md) — ${'x'.repeat(MAX_ENTRYPOINT_BYTES)}`
    const merged = `${model}\n${addition}\n`
    expect(() => carveEntrypointRoom(merged, model, [addition])).toThrow()
  })
})

interface FakeSetup {
  fs: FakeMemoryFs
  dir: string
  index: () => string | undefined
}

const DIR = '/mem'

async function fakeFs(seed: Record<string, string> = {}): Promise<FakeSetup> {
  const ctx = new Context()
  await ctx.plugin(FakeMemoryFs)
  const fs = ctx.fs as unknown as FakeMemoryFs
  for (const [path, content] of Object.entries(seed)) fs.seed(path, content)
  return {
    fs,
    dir: DIR,
    index: () => fs.backingText(`${DIR}/${ENTRYPOINT_NAME}`),
  }
}

/** Append `line` after the trimmed `fresh` index, newline-terminated. */
function appendPointer(fresh: string, line: string): string {
  const trimmed = fresh.trimEnd()
  return trimmed.length > 0 ? `${trimmed}\n${line}\n` : `${line}\n`
}

/** Idempotent pointer ensure: skip when the target is already present. */
function ensurePointer(fresh: string, line: string, target: string): string {
  return fresh.includes(target) ? fresh : appendPointer(fresh, line)
}

describe('readIndexStrict', () => {
  it('returns empty content when MEMORY.md is absent', async () => {
    const { fs, dir } = await fakeFs()
    await expect(readIndexStrict(fs, dir)).resolves.toBe('')
  })

  it('returns the index content verbatim when present', async () => {
    const { fs, dir } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: '- [a](a.md) — a\n' })
    await expect(readIndexStrict(fs, dir)).resolves.toBe('- [a](a.md) — a\n')
  })

  it('propagates a read failure instead of treating it as empty content', async () => {
    const { fs, dir } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: '- [a](a.md) — a\n' })
    vi.spyOn(fs, 'readText').mockRejectedValue(new Error('unreadable index'))
    await expect(readIndexStrict(fs, dir)).rejects.toThrow('unreadable index')
  })
})

describe('commitMemoryWrites', () => {
  it('commits a single index write and returns the writer metadata', async () => {
    const { fs, dir, index } = await fakeFs()
    const line = '- [a](a.md) — a'
    const result = await commitMemoryWrites(fs, dir, async (fresh) => ({
      writes: [{ path: ENTRYPOINT_NAME, content: appendPointer(fresh, line) }],
      meta: { tag: 'attempt-meta' },
    }))
    expect(result.written).toEqual([ENTRYPOINT_NAME])
    expect(result.meta).toEqual({ tag: 'attempt-meta' })
    expect(index()).toBe(`${line}\n`)
  })

  it('rebases when a foreign commit lands between the fresh read and the pre-write verify', async () => {
    const { fs, dir, index } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: '- [base](base.md) — b\n' })
    const seenFresh: string[] = []
    let calls = 0
    const result = await commitMemoryWrites(fs, dir, async (fresh) => {
      calls++
      seenFresh.push(fresh)
      if (calls === 1) {
        // A foreign writer commits mid-build, i.e. after our fresh read and
        // before our pre-write verify.
        const target = await fs.resolve(`${dir}/${ENTRYPOINT_NAME}`)
        await fs.writeText(target, '- [base](base.md) — b\n- [foreign](foreign.md) — f\n')
      }
      return {
        writes: [{ path: ENTRYPOINT_NAME, content: appendPointer(fresh, '- [ours](ours.md) — o') }],
        meta: calls,
      }
    })
    expect(calls).toBe(2)
    expect(seenFresh[1]).toContain('[foreign](foreign.md)')
    expect(result.meta).toBe(2)
    expect(index()).toContain('[foreign](foreign.md)')
    expect(index()).toContain('[ours](ours.md)')
  })

  it('case (a): two writers from one snapshot — the survivor rebases and both pointers are durable', async () => {
    const S = '- [base](base.md) — b\n'
    const { fs, dir, index } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: S })
    const aLine = '- [a](a.md) — a'
    const bLine = '- [b](b.md) — b'
    let bFirstBuild = true
    let aResult: { written: string[] } | undefined

    const bResult = await commitMemoryWrites(fs, dir, async (fresh) => {
      if (bFirstBuild) {
        bFirstBuild = false
        // Writer A commits from the SAME snapshot S while B is building.
        aResult = await commitMemoryWrites(fs, dir, async (aFresh) => ({
          writes: [{ path: ENTRYPOINT_NAME, content: appendPointer(aFresh, aLine) }],
          meta: 'a',
        }))
      }
      return { writes: [{ path: ENTRYPOINT_NAME, content: appendPointer(fresh, bLine) }], meta: 'b' }
    })

    expect(aResult?.written).toEqual([ENTRYPOINT_NAME])
    expect(bResult.meta).toBe('b')
    expect(index()).toContain('[a](a.md)')
    expect(index()).toContain('[b](b.md)')
  })

  it('case (b): a commit inside the single-write window loses its pointer (documented residual)', async () => {
    const S = '- [base](base.md) — b\n'
    const { fs, dir, index } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: S })
    const aLine = '- [a](a.md) — a'
    const bLine = '- [b](b.md) — b'
    const original = fs.writeText.bind(fs)
    let armed = false
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve })
    vi.spyOn(fs, 'writeText').mockImplementation(async (target: FsTarget, content: string, expected?: FsWriteIntent) => {
      if (armed && String(target.targetKey).endsWith(`/${ENTRYPOINT_NAME}`)) {
        armed = false
        // Paused AFTER B's pre-write verify, BEFORE its index write lands.
        reached()
        await gate
      }
      return original(target, content, expected)
    })

    armed = true
    const bPromise = commitMemoryWrites(fs, dir, async (fresh) => ({
      writes: [{ path: ENTRYPOINT_NAME, content: appendPointer(fresh, bLine) }],
      meta: 'b',
    }))
    await reachedPromise
    // Writer A runs entirely inside B's read-verify/write window.
    const aResult = await commitMemoryWrites(fs, dir, async (fresh) => ({
      writes: [{ path: ENTRYPOINT_NAME, content: appendPointer(fresh, aLine) }],
      meta: 'a',
    }))
    release()
    const bResult = await bPromise

    expect(aResult.meta).toBe('a')
    expect(bResult.meta).toBe('b')
    // B wrote last from the stale snapshot: the durable index is B's own
    // rewrite of S, so A's pointer is lost and B's is durable.
    expect(index()).toBe(`${S}${bLine}\n`)
    expect(index()).not.toContain('[a](a.md)')
  })

  it('rebases when a foreign write lands between the index write and the read-back', async () => {
    const S = '- [base](base.md) — b\n'
    const { fs, dir, index } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: S })
    const ourLine = '- [ours](ours.md) — o'
    const foreignLine = '- [foreign](foreign.md) — f'
    const original = fs.writeText.bind(fs)
    let indexWrites = 0
    vi.spyOn(fs, 'writeText').mockImplementation(async (target: FsTarget, content: string, expected?: FsWriteIntent) => {
      const outcome = await original(target, content, expected)
      if (String(target.targetKey).endsWith(`/${ENTRYPOINT_NAME}`)) {
        indexWrites++
        if (indexWrites === 1) {
          const now = fs.backingText(`${dir}/${ENTRYPOINT_NAME}`) ?? ''
          fs.seed(`${dir}/${ENTRYPOINT_NAME}`, appendPointer(now, foreignLine))
        }
      }
      return outcome
    })

    const result = await commitMemoryWrites(fs, dir, async (fresh) => ({
      writes: [{ path: ENTRYPOINT_NAME, content: ensurePointer(fresh, ourLine, '](ours.md)') }],
      meta: 'rebase',
    }))

    expect(result.meta).toBe('rebase')
    expect(index()).toContain('](ours.md)')
    expect(index()).toContain('](foreign.md)')
  })

  it('a batch without MEMORY.md is a single-pass topic write with exactly one index read', async () => {
    const { fs, dir } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: '- [base](base.md) — b\n' })
    const readSpy = vi.spyOn(fs, 'readText')
    const result = await commitMemoryWrites(fs, dir, async () => ({
      writes: [{ path: 'topic.md', content: 'topic body\n' }],
      meta: 'topic-only',
    }))
    expect(result.written).toEqual(['topic.md'])
    expect(fs.backingText(`${dir}/topic.md`)).toBe('topic body\n')
    expect(readSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects a batch with more than one MEMORY.md write', async () => {
    const { fs, dir } = await fakeFs()
    await expect(commitMemoryWrites(fs, dir, async () => ({
      writes: [
        { path: ENTRYPOINT_NAME, content: 'one\n' },
        { path: ENTRYPOINT_NAME, content: 'two\n' },
      ],
      meta: undefined,
    }))).rejects.toThrow(/at most one/)
  })

  it('exhausts attempts and throws MemoryIndexConflictError; the last foreign write wins', async () => {
    const S = '- [base](base.md) — b\n'
    const foreign = '- [foreign](foreign.md) — f\n'
    const { fs, dir, index } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: S })
    const original = fs.writeText.bind(fs)
    vi.spyOn(fs, 'writeText').mockImplementation(async (target: FsTarget, content: string, expected?: FsWriteIntent) => {
      const outcome = await original(target, content, expected)
      if (String(target.targetKey).endsWith(`/${ENTRYPOINT_NAME}`)) {
        // A scripted foreign writer clobbers the index after EVERY attempt.
        fs.seed(`${dir}/${ENTRYPOINT_NAME}`, foreign)
      }
      return outcome
    })

    let error: unknown
    try {
      await commitMemoryWrites(fs, dir, async (fresh) => ({
        writes: [{ path: ENTRYPOINT_NAME, content: appendPointer(fresh, '- [ours](ours.md) — o') }],
        meta: 'ours',
      }), 3)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(MemoryIndexConflictError)
    expect((error as MemoryIndexConflictError).attempts).toBe(3)
    expect(index()).toBe(foreign)
  })

  it('propagates a build throw immediately with no retry', async () => {
    const { fs, dir } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: '- [base](base.md) — b\n' })
    let calls = 0
    await expect(commitMemoryWrites(fs, dir, async () => {
      calls++
      throw new Error('validation rejected the batch')
    })).rejects.toThrow('validation rejected the batch')
    expect(calls).toBe(1)
  })

  it('an unreadable index fails the attempt instead of being treated as empty', async () => {
    const { fs, dir } = await fakeFs({ [`${DIR}/${ENTRYPOINT_NAME}`]: '- [base](base.md) — b\n' })
    vi.spyOn(fs, 'readText').mockRejectedValue(new Error('index read exploded'))
    let buildCalls = 0
    await expect(commitMemoryWrites(fs, dir, async (fresh) => {
      buildCalls++
      return { writes: [{ path: ENTRYPOINT_NAME, content: appendPointer(fresh, '- [a](a.md) — a') }], meta: undefined }
    })).rejects.toThrow('index read exploded')
    expect(buildCalls).toBe(0)
  })

  it('rejects an invalid attempts value with RangeError', async () => {
    const { fs, dir } = await fakeFs()
    for (const attempts of [0, -1, 1.5]) {
      await expect(commitMemoryWrites(fs, dir, async () => ({ writes: [], meta: undefined }), attempts))
        .rejects.toBeInstanceOf(RangeError)
    }
  })
})
