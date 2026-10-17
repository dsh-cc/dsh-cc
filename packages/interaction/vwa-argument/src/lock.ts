/**
 * Project write lock (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §14.2): exclusive-create lock recording `{pid, startedAt, nonce}` (the
 * per-process nonce stands in for a bootId), ≤2 s wait then LOCK_BUSY,
 * reclaim only after the holder process is confirmed dead — never by
 * timeout alone.
 *
 * Split out of store.ts for the repo file-size cap.
 *
 * @module @dsh-cc/vwa-argument/lock
 */

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { stableJson } from './schema.ts'
import { fail, type Fail } from './store.ts'

interface LockBody {
  pid: number
  startedAt: string
  nonce: string
}

const LOCK_WAIT_MS = 2000

/** One nonce per process stands in for the bootId (§14.2). */
const processNonce = randomUUID()

/** True when the pid is a live process (reclaim evidence). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether another process holds this project's write lock (for reporting). */
export function lockHeld(dir: string): boolean {
  const lockPath = join(dir, 'locks', 'write.lock')
  try {
    const body = JSON.parse(readFileSync(lockPath, 'utf8')) as LockBody
    return pidAlive(body.pid)
  } catch {
    return false
  }
}

/** Acquire the exclusive-create lock; ≤2 s wait; dead-holder reclaim (§14.2). */
export function acquireLock(dir: string): Fail | undefined {
  const lockPath = join(dir, 'locks', 'write.lock')
  mkdirSync(dirname(lockPath), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        const body: LockBody = { pid: process.pid, startedAt: new Date().toISOString(), nonce: processNonce }
        writeSync(fd, stableJson(body))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return undefined
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return fail('STORE_IO_FAILED', `lock create failed: ${String(error)}`, true)
      }
    }
    let existing: LockBody | undefined
    try {
      existing = JSON.parse(readFileSync(lockPath, 'utf8')) as LockBody
    } catch {
      existing = undefined
    }
    // Dead holder → reclaim (never by timeout alone, §14.2).
    if (existing !== undefined && !pidAlive(existing.pid)) {
      try {
        unlinkSync(lockPath)
      } catch { /* raced; retry */ }
      continue
    }
    // Same-process holder (own nonce) → immediate self-deadlock report.
    if (existing !== undefined && existing.pid === process.pid && existing.nonce === processNonce) {
      return fail('LOCK_BUSY', 'another transaction in this process holds the write lock', true)
    }
    if (Date.now() >= deadline) {
      return fail('LOCK_BUSY', 'project write lock held', true)
    }
    const spinEnd = Date.now() + 50
    while (Date.now() < spinEnd) { /* bounded spin; test processes only */ }
  }
}

/** Best-effort release (unlink the lock file). */
export function releaseLock(dir: string): void {
  try {
    unlinkSync(join(dir, 'locks', 'write.lock'))
  } catch { /* already gone */ }
}
