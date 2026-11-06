/**
 * Memory consolidation lock and last-consolidated timestamp.
 *
 * The `ctx.fs` seam exposes no mtime, so the lock file's body carries the
 * holder PID and the last-consolidated epoch rather than the file mtime (the
 * reference uses mtime as the timestamp). A holder is stale and reclaimable
 * once its stored timestamp passes {@link LOCK_STALE_MS}.
 *
 * Issue #336: a SUCCESSFUL consolidation RELEASES the lock by clearing the
 * holder PID while keeping the acquisition epoch — the epoch doubles as the
 * consolidated timestamp that the periodic time gate reads. A released lock
 * (holder PID 0) is free regardless of its epoch, so a completed dream no
 * longer fences the next window for the remainder of {@link LOCK_STALE_MS}.
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

// Position-preserving parse (issue #336 fix): a blank or whitespace holder
// line stays on line 1 and cannot shift the epoch into the holder field the
// way a whole-content trim() did — a blank holder is an UNKNOWN holder
// (blocks while the epoch is fresh), and a malformed epoch (at = 0) with a
// recorded holder is reclaimed at once.
function parse(content: string): { pid: number | undefined; at: number } {
  const [pidRaw, atRaw] = content.split('\n')
  const pid = pidRaw !== undefined && pidRaw.trim() !== '' && Number.isFinite(Number(pidRaw)) ? Number(pidRaw) : undefined
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
 * rollback), or `null` when a live holder blocks acquisition.
 *
 * On success the lock is written with this process's PID and `now` as the
 * consolidated epoch. A leaked holder (older than {@link LOCK_STALE_MS}) is
 * reclaimed; a crash mid-consolidation leaves a stale file the next process
 * reclaims. A RELEASED lock (holder PID 0) is free regardless of its epoch —
 * the epoch it keeps is the last consolidated timestamp, not a hold. The prior
 * epoch is captured before the write so a caller can roll back to the exact
 * pre-acquire state (the write-back is verified by a read).
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
      const { pid: holder, at } = parse(await fs.readText(target))
      priorAt = at
      // Issue #336: a RELEASED lock (holder PID 0) is free regardless of its
      // epoch — a completed dream keeps the epoch (it is lastConsolidatedAt,
      // which the periodic time gate still reads) but no holder. Only a
      // recorded holder blocks acquisition, until the stale window reclaims
      // it (a crash or PID reuse). A malformed holder line (undefined) is
      // treated as an unknown holder and keeps blocking while fresh; a
      // malformed EPOCH (at = 0) with a recorded holder is reclaimed at
      // once — the guard needs a positive epoch to block.
      if (holder !== 0 && at > 0 && now - at < LOCK_STALE_MS) {
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
 * Release the lock after a SUCCESSFUL consolidation (issue #336): the holder
 * PID is cleared while the acquisition epoch is kept — the epoch doubles as
 * lastConsolidatedAt and the periodic time gate still reads it. The write is
 * guarded by a read-verify: if the file no longer carries exactly this
 * holder+epoch (a stale-window reclaimer took it mid-dream), the release is
 * skipped — the current holder owns the file. Best-effort: failures are
 * swallowed so the caller's teardown does not throw.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the lock.
 * @param pid - the process id that acquired the lock.
 * @param at - the acquisition epoch the lock was stamped with.
 * @param policy - per-call sandbox policy for the lock write (see tryAcquireLock).
 */
export async function releaseLock(
  fs: FileSystem,
  dir: string,
  pid: number,
  at: number,
  policy?: MemoryWritePolicy,
): Promise<void> {
  const target = await fs.resolve(join(dir, LOCK_FILE)).catch(() => undefined)
  if (target === undefined) return
  try {
    if ((await fs.readText(target)) !== format(pid, at)) return
  } catch {
    return
  }
  await fs.writeText(target, format(0, at), undefined, undefined, policy).catch(() => {})
}

/**
 * Roll the lock back to `priorAt` after a failed or killed consolidation.
 * A `priorAt` of 0 encodes the no-file state (the next read returns 0) with
 * the holder PID cleared. The write carries the same guarded read-verify as
 * `releaseLock` (issue #336): it runs only when the file still holds exactly
 * `pid`/`at` — a stale-window reclaimer that took the lock mid-dream owns it,
 * and a rollback that clobbered it would free a lock under a live dreamer
 * (holder 0 is free by definition). Best-effort: failures are swallowed so
 * the caller's teardown does not throw.
 * @param fs - the filesystem seam.
 * @param dir - the memory directory holding the lock.
 * @param pid - the process id that acquired the lock.
 * @param at - the acquisition epoch the lock was stamped with.
 * @param priorAt - the pre-acquire consolidated epoch to restore.
 * @param policy - per-call sandbox policy for the lock write (see tryAcquireLock).
 */
export async function rollbackLock(fs: FileSystem, dir: string, pid: number, at: number, priorAt: number, policy?: MemoryWritePolicy): Promise<void> {
  const target = await fs.resolve(join(dir, LOCK_FILE)).catch(() => undefined)
  if (target === undefined) return
  try {
    if ((await fs.readText(target)) !== format(pid, at)) return
  } catch {
    return
  }
  await fs.writeText(target, format(0, priorAt), undefined, undefined, policy).catch(() => {})
}
