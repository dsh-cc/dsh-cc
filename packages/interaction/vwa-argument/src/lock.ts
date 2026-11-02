/**
 * Project write lock (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §14.2): exclusive lock recording `{pid, startedAt, nonce}` (the per-process
 * nonce stands in for a bootId), ≤2 s wait then LOCK_BUSY, reclaim only after
 * the holder process is confirmed dead — never by timeout alone.
 *
 * Acquisition is a staged `link()` (design
 * docs/plans/2026-11-02-vwa-torn-lock-recovery.md §3.1, issue #307): the body
 * is written in full to a per-attempt staging file (`write.lock.<pid>.
 * <nonce>.<uuid>.tmp`), fsynced, and only then promoted with
 * `linkSync(staging, write.lock)` — atomic AND exclusive, since link fails
 * with EEXIST iff the target exists. A crash before the link leaves only
 * inert staging (reaped by `reapStaleStaging`); a crash after it leaves a
 * complete, fsynced body. No reachable state has a torn `write.lock`.
 * Unparseable leftovers from pre-#307 binaries are reclaimed after one grace
 * re-read (§3.2b) — that reclaim carries the known non-atomic-reclaim TOCTOU
 * tracked as issue #311, unchanged in kind from the dead-holder reclaim.
 *
 * Split out of store.ts for the repo file-size cap.
 *
 * @module @dsh-cc/vwa-argument/lock
 */

import * as fs from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { stableJson } from './schema.ts'
import { fail, type Fail } from './store.ts'

interface LockBody {
  pid: number
  startedAt: string
  nonce: string
}

const LOCK_WAIT_MS = 2000
const LOCK_FILE = 'write.lock'

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

/** Best-effort unlink; a missing or racing file is never an error here. */
function bestEffortUnlink(path: string): void {
  try {
    fs.unlinkSync(path)
  } catch { /* already gone or raced */ }
}

/** Bounded busy-wait (no async while holding/contending a lock, §14.2). */
function spin(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* bounded spin; test processes only */ }
}

/**
 * Write every byte (§3.1 fold P1-2): a single `writeSync` may short-write and
 * publish a torn body, so advance by the returned count until the buffer is
 * spent. A 0/null count for a nonempty buffer is impossible per POSIX and is
 * treated as an I/O failure.
 */
function writeAllSync(fd: number, bytes: Buffer): void {
  let written = 0
  while (written < bytes.length) {
    const count = fs.writeSync(fd, bytes, written)
    if (count <= 0) throw new Error(`short write: ${count} of ${bytes.length} bytes at offset ${written}`)
    written += count
  }
}

/** Staging path; the UUID makes each attempt collision-free (§3.1 fold P1-4). */
function stagingPath(lockDir: string): string {
  return join(lockDir, `${LOCK_FILE}.${process.pid}.${processNonce}.${randomUUID()}.tmp`)
}

/**
 * Best-effort staging reap (§3.3): crashed processes leave `write.lock.*.tmp`
 * files behind. Only entries whose pid segment parses and is dead (and is not
 * ours) are removed — pid reuse can then only retain garbage, never delete a
 * live process's staging. The glob must require the trailing dot: a bare
 * `startsWith('write.lock')` would match the lock itself.
 */
function reapStaleStaging(lockDir: string): void {
  let entries: string[]
  try {
    entries = fs.readdirSync(lockDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${LOCK_FILE}.`) || !entry.endsWith('.tmp')) continue
    const pidText = entry.slice(LOCK_FILE.length + 1).split('.')[0] ?? ''
    if (!/^\d+$/.test(pidText)) continue // unparseable pid stays (harmless, rare)
    const pid = Number(pidText)
    if (pid === process.pid || pidAlive(pid)) continue
    bestEffortUnlink(join(lockDir, entry))
  }
}

/** Read + parse split (§3.2): a read error is never "unowned" evidence. */
type LockRead =
  | { kind: 'body'; body: LockBody }
  | { kind: 'missing' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'torn' }

function readLock(lockPath: string): LockRead {
  let text: string
  try {
    text = fs.readFileSync(lockPath, 'utf8')
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable', message: String(error) }
  }
  try {
    return { kind: 'body', body: JSON.parse(text) as LockBody }
  } catch {
    return { kind: 'torn' }
  }
}

/**
 * Classify a parseable body (§3.2.4): dead holder → reclaim; own pid+nonce →
 * self-deadlock report; wrong shape (`{}`) behaves as a dead holder; live
 * foreign holder → wait to the deadline, else spin.
 */
function classify(body: LockBody, lockPath: string, deadline: number): Fail | undefined {
  // A parseable non-object (`null`) carries no holder pid either.
  if (body === null || typeof body !== 'object' || !pidAlive(body.pid)) {
    // Dead-holder reclaim, unchanged (never by timeout alone). Known defect
    // carried: this read→decide→unlink is not atomic (reclaim TOCTOU), tracked
    // as issue #311 and modeled-atomic as E-8 in specs/tla/vwa-review-cycle.
    bestEffortUnlink(lockPath)
    return undefined
  }
  if (body.pid === process.pid && body.nonce === processNonce) {
    return fail('LOCK_BUSY', 'another transaction in this process holds the write lock', true)
  }
  if (Date.now() >= deadline) return fail('LOCK_BUSY', 'project write lock held', true)
  spin(50)
  return undefined
}

/**
 * One contention inspection after our `link` saw EEXIST (§3.2): returns a
 * refusal, or undefined meaning "retry the promote loop".
 */
function inspectContention(lockPath: string, deadline: number): Fail | undefined {
  const read = readLock(lockPath)
  if (read.kind === 'missing') return undefined // holder released between link and read
  if (read.kind === 'unreadable') return fail('STORE_IO_FAILED', `lock read failed: ${read.message}`, true)
  if (read.kind !== 'torn') return classify(read.body, lockPath, deadline)
  // Torn/empty body (§3.2b): only a pre-#307 binary can publish one. Give the
  // (possibly live, mid-write) old writer one bounded grace window, re-reading
  // with the same split, then reclaim the leftover.
  spin(50)
  const again = readLock(lockPath)
  if (again.kind === 'missing') return undefined
  if (again.kind === 'unreadable') return fail('STORE_IO_FAILED', `lock read failed: ${again.message}`, true)
  if (again.kind !== 'torn') return classify(again.body, lockPath, deadline)
  bestEffortUnlink(lockPath)
  return undefined
}

/** Whether another process holds this project's write lock (for reporting). */
export function lockHeld(dir: string): boolean {
  const lockPath = join(dir, 'locks', LOCK_FILE)
  try {
    const body = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockBody
    return pidAlive(body.pid)
  } catch {
    return false
  }
}

/** Acquire the exclusive lock; ≤2 s wait; staged link + dead-holder reclaim (§14.2, #307). */
export function acquireLock(dir: string): Fail | undefined {
  const lockDir = join(dir, 'locks')
  const lockPath = join(lockDir, LOCK_FILE)
  fs.mkdirSync(lockDir, { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  reapStaleStaging(lockDir)
  for (;;) {
    const staging = stagingPath(lockDir)
    let fd: number
    try {
      fd = fs.openSync(staging, 'wx')
    } catch (error: unknown) {
      // A collision on our own fresh UUID name: retry with a new attempt.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      return fail('STORE_IO_FAILED', `lock create failed: ${String(error)}`, true)
    }
    try {
      const body: LockBody = { pid: process.pid, startedAt: new Date().toISOString(), nonce: processNonce }
      writeAllSync(fd, Buffer.from(stableJson(body), 'utf8'))
      fs.fsyncSync(fd)
    } catch (error: unknown) {
      bestEffortUnlink(staging)
      return fail('STORE_IO_FAILED', `lock publish failed: ${String(error)}`, true)
    } finally {
      fs.closeSync(fd)
    }
    try {
      // Atomic exclusive promote: EEXIST iff the lock already exists.
      fs.linkSync(staging, lockPath)
    } catch (error: unknown) {
      bestEffortUnlink(staging)
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return fail('STORE_IO_FAILED', `lock promote failed: ${String(error)}`, true)
      }
      const refused = inspectContention(lockPath, deadline)
      if (refused !== undefined) return refused
      continue
    }
    // The lock survives as its own hard link; the staging name is now extra.
    bestEffortUnlink(staging)
    return undefined
  }
}

/** Best-effort release (unlink the lock file). */
export function releaseLock(dir: string): void {
  bestEffortUnlink(join(dir, 'locks', LOCK_FILE))
}
