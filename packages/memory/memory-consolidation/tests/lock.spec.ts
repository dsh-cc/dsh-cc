import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion, type FsDirEntry, type FsEditRequest, type FsEditOutcome, type FsInfo, type FsPathInfo, type FsTarget, type FsWriteIntent, type FsWriteOutcome } from '@deepseek-ai/dsh-fs'
import { LOCK_STALE_MS, readLastConsolidatedAt, releaseLock, rollbackLock, tryAcquireLock } from '../src/lock.ts'

/** Minimal in-memory FileSystem for lock tests. */
class FakeFs extends FileSystem {
  constructor(ctx: Context, private backing: Map<string, string> = new Map()) {
    super(ctx)
  }

  override async resolve(path: string): Promise<FsTarget> {
    return { targetKey: FsTargetKey(path), displayPath: path }
  }
  override processPath(t: FsTarget): string { return String(t.targetKey) }
  override fileUrl(t: FsTarget): string { return `file://${String(t.targetKey)}` }
  override contains(p: FsTarget, c: FsTarget): boolean { return String(c.targetKey).startsWith(String(p.targetKey)) }
  override async stat(t: FsTarget): Promise<FsInfo | undefined> {
    const c = this.backing.get(String(t.targetKey))
    return c === undefined ? undefined : { version: FsVersion('v1'), type: 'file', size: c.length }
  }
  override async lstat(p: string): Promise<FsPathInfo | undefined> {
    const c = this.backing.get(p)
    return c === undefined ? undefined : { version: FsVersion('v1'), type: 'file' }
  }
  override async readText(t: FsTarget): Promise<string> {
    const c = this.backing.get(String(t.targetKey))
    if (c === undefined) throw new FsError('not found', 'FS_NOT_FOUND')
    return c
  }
  override async streamText(t: FsTarget): Promise<AsyncIterable<string>> {
    const c = await this.readText(t)
    return (async function* () { yield c })()
  }
  override async readBytes(t: FsTarget, _s: AbortSignal | undefined, max: number): Promise<Uint8Array> {
    const b = new TextEncoder().encode(await this.readText(t))
    if (b.length > max) throw new FsError('too large', 'FS_TOO_LARGE')
    return b
  }
  override async listDir(t: FsTarget): Promise<FsDirEntry[]> {
    const root = String(t.targetKey)
    const out: FsDirEntry[] = []
    for (const key of this.backing.keys()) {
      if (key.startsWith(`${root}/`) && !key.slice(root.length + 1).includes('/')) {
        out.push({ name: key.slice(root.length + 1), type: 'file', target: { targetKey: FsTargetKey(key), displayPath: key } })
      }
    }
    return out
  }
  override async writeText(t: FsTarget, content: string, _e?: FsWriteIntent): Promise<FsWriteOutcome> {
    const before = this.backing.get(String(t.targetKey)) ?? null
    this.backing.set(String(t.targetKey), content)
    return { operation: before !== null ? 'update' : 'create', version: FsVersion('v2'), before, after: content }
  }
  override async editText(t: FsTarget, e: FsEditRequest): Promise<FsEditOutcome> {
    const c = this.backing.get(String(t.targetKey)) ?? ''
    const after = c.split(e.oldString).join(e.newString)
    this.backing.set(String(t.targetKey), after)
    return { version: FsVersion('v3'), before: c, after }
  }
  seed(path: string, content: string): void { this.backing.set(path, content) }
}

async function makeFs(): Promise<FakeFs> {
  const ctx = new Context()
  await ctx.plugin(FakeFs)
  return ctx.fs as FakeFs
}

/** A fake whose read-back always reports a different holder than the one we write. */
class MismatchFs extends FakeFs {
  override async readText(t: FsTarget): Promise<string> {
    return `999999\n0\n`
  }
}

const dir = '/mem'
const lockPath = `${dir}/.consolidation-lock`
const now = 2_000_000

describe('readLastConsolidatedAt', () => {
  it('returns 0 when absent', async () => {
    const fs = await makeFs()
    expect(await readLastConsolidatedAt(fs, dir)).toBe(0)
  })

  it('reads the stored consolidated epoch once set', async () => {
    const fs = await makeFs()
    await tryAcquireLock(fs, dir, 42, now)
    expect(await readLastConsolidatedAt(fs, dir)).toBe(now)
  })
})

describe('tryAcquireLock', () => {
  it('acquires with no prior lock and returns 0', async () => {
    const fs = await makeFs()
    expect(await tryAcquireLock(fs, dir, 1, now)).toBe(0)
  })

  it('returns the prior epoch when reclaiming a stale holder', async () => {
    const fs = await makeFs()
    await tryAcquireLock(fs, dir, 1, now - 20 * LOCK_STALE_MS)
    expect(await tryAcquireLock(fs, dir, 2, now)).toBe(now - 20 * LOCK_STALE_MS)
  })

  it('blocks while a fresh holder is present', async () => {
    const fs = await makeFs()
    await tryAcquireLock(fs, dir, 1, now)
    expect(await tryAcquireLock(fs, dir, 2, now + 1000)).toBeNull()
  })

  it('returns null when the write-verify read-back does not match (race lost)', async () => {
    const mo = new Context()
    await mo.plugin(MismatchFs)
    const fs = mo.fs as MismatchFs
    expect(await tryAcquireLock(fs, dir, 123, now)).toBeNull()
  })

  it('returns null when the write-verify read-back throws', async () => {
    class ThrowingReadFs extends FakeFs {
      override async readText(): Promise<string> { throw new Error('io gone') }
    }
    const ctx = new Context()
    await ctx.plugin(ThrowingReadFs)
    const fs = ctx.fs as ThrowingReadFs
    expect(await tryAcquireLock(fs, dir, 123, now)).toBeNull()
  })

  it('acquires a RELEASED lock (holder 0) within the stale window and returns the kept epoch as priorAt', async () => {
    const fs = await makeFs()
    const keptAt = now - 1000
    fs.seed(lockPath, `0\n${keptAt}\n`)
    expect(keptAt).toBeGreaterThan(now - LOCK_STALE_MS)
    expect(await tryAcquireLock(fs, dir, 5, now)).toBe(keptAt)
    expect(fs.backing.get(lockPath)).toBe(`5\n${now}\n`)
  })

  it('blocks on a blank holder line with a fresh epoch (unknown holder)', async () => {
    const fs = await makeFs()
    fs.seed(lockPath, `\n${now}\n`)
    expect(await tryAcquireLock(fs, dir, 5, now + 1)).toBeNull()
    expect(fs.backing.get(lockPath)).toBe(`\n${now}\n`)
  })

  it('blocks on a whitespace-only holder line with a fresh epoch (unknown holder)', async () => {
    const fs = await makeFs()
    fs.seed(lockPath, `   \n${now}\n`)
    expect(await tryAcquireLock(fs, dir, 5, now + 1)).toBeNull()
    expect(fs.backing.get(lockPath)).toBe(`   \n${now}\n`)
  })

  it('reclaims a malformed epoch (at = 0) with a recorded holder at once', async () => {
    const fs = await makeFs()
    fs.seed(lockPath, '42\nbad\n')
    expect(await tryAcquireLock(fs, dir, 5, now)).toBe(0)
    expect(fs.backing.get(lockPath)).toBe(`5\n${now}\n`)
  })
})

describe('releaseLock', () => {
  it('rewrites the holder+epoch to EXACTLY the released form (holder 0, epoch kept)', async () => {
    const fs = await makeFs()
    expect(await tryAcquireLock(fs, dir, 42, now)).toBe(0)
    expect(fs.backing.get(lockPath)).toBe(`42\n${now}\n`)
    await releaseLock(fs, dir, 42, now)
    expect(fs.backing.get(lockPath)).toBe(`0\n${now}\n`)
  })

  it('is a no-op when the content differs (a reclaimer owns the file)', async () => {
    const fs = await makeFs()
    fs.seed(lockPath, `7\n${now + 500}\n`)
    await releaseLock(fs, dir, 42, now)
    expect(fs.backing.get(lockPath)).toBe(`7\n${now + 500}\n`)
  })

  it('is a no-op when the read throws', async () => {
    class ThrowingReadFs extends FakeFs {
      override async readText(): Promise<string> { throw new Error('io gone') }
    }
    const ctx = new Context()
    await ctx.plugin(ThrowingReadFs)
    const fs = ctx.fs as ThrowingReadFs
    fs.seed(lockPath, `42\n${now}\n`)
    await releaseLock(fs, dir, 42, now)
    expect(fs.backing.get(lockPath)).toBe(`42\n${now}\n`)
  })

  it('leaves a NEWER same-PID acquisition untouched (old callback cannot free it)', async () => {
    const fs = await makeFs()
    const newAt = now + LOCK_STALE_MS + 1000
    expect(await tryAcquireLock(fs, dir, 5, now)).toBe(0)
    // A stale-window reacquire by the SAME pid stamps a new epoch.
    expect(await tryAcquireLock(fs, dir, 5, newAt)).toBe(now)
    // The old callback still carrying the old epoch must not touch the new lock.
    await releaseLock(fs, dir, 5, now)
    expect(fs.backing.get(lockPath)).toBe(`5\n${newAt}\n`)
  })

  it('swallows a write failure and leaves the lock untouched', async () => {
    class ThrowingWriteFs extends FakeFs {
      override async writeText(): Promise<FsWriteOutcome> { throw new Error('write gone') }
    }
    const ctx = new Context()
    await ctx.plugin(ThrowingWriteFs)
    const fs = ctx.fs as ThrowingWriteFs
    fs.seed(lockPath, `42\n${now}\n`)
    await expect(releaseLock(fs, dir, 42, now)).resolves.toBeUndefined()
    expect(fs.backing.get(lockPath)).toBe(`42\n${now}\n`)
  })
})

describe('rollbackLock', () => {
  it('restores the prior epoch on rollback after acquisition', async () => {
    const fs = await makeFs()
    const prior = await tryAcquireLock(fs, dir, 1, now)
    expect(prior).not.toBeNull()
    await rollbackLock(fs, dir, 1, now, prior as number)
    expect(fs.backing.get(lockPath)).toBe(`0\n${prior}\n`)
    expect(await readLastConsolidatedAt(fs, dir)).toBe(prior)
  })

  it('re-opens the time gate (returns 0) when rolling back a no-prior acquisition', async () => {
    const fs = await makeFs()
    const prior = await tryAcquireLock(fs, dir, 1, now)
    expect(prior).toBe(0)
    await rollbackLock(fs, dir, 1, now, prior as number)
    expect(fs.backing.get(lockPath)).toBe('0\n0\n')
    expect(await readLastConsolidatedAt(fs, dir)).toBe(0)
  })

  it('rolls a held lock back to the prior epoch and an in-window acquire returns that epoch', async () => {
    const fs = await makeFs()
    const priorAt = now - 5 * 60_000
    fs.seed(lockPath, `42\n${now}\n`)
    await rollbackLock(fs, dir, 42, now, priorAt)
    expect(fs.backing.get(lockPath)).toBe(`0\n${priorAt}\n`)
    expect(await tryAcquireLock(fs, dir, 43, now + 1000)).toBe(priorAt)
  })

  it('leaves a foreign holder untouched when the content does not match', async () => {
    const fs = await makeFs()
    fs.seed(lockPath, `7\n${now + 500}\n`)
    await rollbackLock(fs, dir, 42, now, now - 5 * 60_000)
    expect(fs.backing.get(lockPath)).toBe(`7\n${now + 500}\n`)
  })

  it('leaves a NEWER same-PID acquisition untouched (old callback cannot free it)', async () => {
    const fs = await makeFs()
    const newAt = now + LOCK_STALE_MS + 1000
    expect(await tryAcquireLock(fs, dir, 5, now)).toBe(0)
    expect(await tryAcquireLock(fs, dir, 5, newAt)).toBe(now)
    await rollbackLock(fs, dir, 5, now, 0)
    expect(fs.backing.get(lockPath)).toBe(`5\n${newAt}\n`)
  })

  it('swallows a write failure and leaves the lock untouched', async () => {
    class ThrowingWriteFs extends FakeFs {
      override async writeText(): Promise<FsWriteOutcome> { throw new Error('write gone') }
    }
    const ctx = new Context()
    await ctx.plugin(ThrowingWriteFs)
    const fs = ctx.fs as ThrowingWriteFs
    fs.seed(lockPath, `42\n${now}\n`)
    await expect(rollbackLock(fs, dir, 42, now, 1)).resolves.toBeUndefined()
    expect(fs.backing.get(lockPath)).toBe(`42\n${now}\n`)
  })
})

describe('lock lifecycle', () => {
  it('a killed consolidation leaves the lock stale and reclaimable after the stale window', async () => {
    const fs = await makeFs()
    await tryAcquireLock(fs, dir, 7, now)
    // Fresh holder blocks.
    expect(await tryAcquireLock(fs, dir, 8, now + 1)).toBeNull()
    // After the stale window the holder is reclaimed.
    expect(await tryAcquireLock(fs, dir, 9, now + LOCK_STALE_MS + 1)).not.toBeNull()
  })
})
