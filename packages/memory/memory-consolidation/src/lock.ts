/**
 * Memory consolidation lock and last-consolidated timestamp.
 *
 * The `ctx.fs` seam exposes no mtime, so the lock file's body carries the
 * holder PID and the last-consolidated epoch rather than the file mtime (the
 * reference uses mtime as the timestamp). A holder is stale and reclaimable
 * once its stored timestamp passes {@link LOCK_STALE_MS}.
 * @module @dsh-cc/memory-consolidation/lock
 */

import { join } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'
import type { MemoryWritePolicy } from '@dsh-cc/memory'

/** Lock filename inside the memory directory. */
export const LOCK_FILE = '.consolidation-lock'

/** A holder is stale past this even if it is still alive (also guards PID reuse). */
export const LOCK_STALE_MS = 60 * 60 * 1000

/** Content of the lock file: `<pid>\n<lastConsolidatedAtMs>\n`. */
const format = (pid: number, at: number): string => `${pid}\n${at}\n`

function parse(content: string): { pid: number | undefined; at: number } {
  const [pidRaw, atRaw] = content.trim().split('\n')
  const pid = pidRaw !== undefined && Number.isFinite(Number(pidRaw)) ? Number(pidRaw) : undefined
  const at = atRaw !== undefined && Number.isFinite(Number(atRaw)) ? Number(atRaw) : 0
  return { pid, at }
}

/** Resolve the lock target and whether it exists. */
async function lockTarget(fs: FileSystem, dir: string): Promise<{ target: FsTarget; absent: boolean }> {
  const target = await fs.resolve(join(dir, LOCK_FILE))
  const info = await fs.stat(target)
  return { target, absent: info === undefined }
}

/**
 * Read the last consolidated epoch, 0 when no lock file exists.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the lock.
 * @returns the epoch ms of the last consolidation, or 0.
 */
export async function readLastConsolidatedAt(fs: FileSystem, dir: string): Promise<number> {
  const { target, absent } = await lockTarget(fs, dir)
  if (absent) return 0
  try {
    return parse(await fs.readText(target)).at
  } catch {
    return 0
  }
}

/**
 * Acquire the consolidation lock. Returns the PRIOR consolidated epoch (for
 * rollback), or `null` when a non-stale holder blocks acquisition.
 *
 * On success the lock is written with this process's PID and `now` as the
 * consolidated epoch. A stale holder (older than {@link LOCK_STALE_MS}) is
 * reclaimed; a crash mid-consolidation leaves a stale file the next process
 * reclaims. The prior epoch is captured before the write so a caller can roll
 * back to the exact pre-acquire state.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the lock.
 * @param pid - this process's id.
 * @param now - the current epoch used as the new consolidated timestamp.
 * @param policy - per-call sandbox policy for the lock write; required when the
 *   memory directory sits outside the caller's sandbox writable roots.
 * @returns the pre-acquire epoch (0 when none) to roll back on failure, or `null` when blocked.
 */
export async function tryAcquireLock(
  fs: FileSystem,
  dir: string,
  pid: number,
  now: number,
  policy?: MemoryWritePolicy,
): Promise<number | null> {
  const { target, absent } = await lockTarget(fs, dir)
  let priorAt = 0
  if (!absent) {
    try {
      const { at } = parse(await fs.readText(target))
      priorAt = at
      if (at > 0 && now - at < LOCK_STALE_MS) {
        // A recently stamped lock is held; the stale window reclaims crashed holders.
        return null
      }
    } catch {
      // Unreadable or malformed lock: reclaim below, treating it as empty.
    }
  }
  await fs.writeText(target, format(pid, now), undefined, undefined, policy)
  // Read the lock back once to verify we own it. If the content is not EXACTLY
  // ours, a cross-process writer interleaved between our read and write and we
  // lost the race. This narrows the TOCTOU window to a sub-millisecond
  // symmetric-collision; the residual race is accepted (the stale-window
  // reclaim handles crashes, and the worst case is a redundant MEMORY.md
  // rewrite bounded by minHours). A read-back THROW is treated as a
  // verify-failure too (conservative).
  let owned = false
  try {
    owned = (await fs.readText(target)) === format(pid, now)
  } catch {
    owned = false
  }
  if (!owned) return null
  return priorAt
}

/**
 * Roll the lock back to `priorAt` after a failed or killed consolidation.
 * A `priorAt` of 0 encodes the no-file state (the next read returns 0) with
 * the holder PID cleared. Best-effort: failures are swallowed so the caller's
 * teardown does not throw.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the lock.
 * @param priorAt - the pre-acquire consolidated epoch to restore.
 * @param policy - per-call sandbox policy for the lock write (see tryAcquireLock).
 */
export async function rollbackLock(fs: FileSystem, dir: string, priorAt: number, policy?: MemoryWritePolicy): Promise<void> {
  const target = await fs.resolve(join(dir, LOCK_FILE)).catch(() => undefined)
  if (target === undefined) return
  await fs.writeText(target, format(0, priorAt), undefined, undefined, policy).catch(() => {})
}
