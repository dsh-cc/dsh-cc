/**
 * Mutation-lease pins (design
 * docs/plans/2026-11-02-systemone-04-memory-extraction-gate.md §"The repo write
 * lease and its relation to dream" and the test table): one owner per canonical
 * dir, a strict FIFO queue, parallel progress across different dirs, a cancelled
 * waiter that leaves no trace behind, and a dream-style `tryAcquire` conflict
 * that returns before the disk lock is ever touched.
 *
 * These are lease-level pins only: dream's wiring (tryAcquire → disk lock →
 * rollback) belongs to the coordinator slice.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOCK_FILE } from '../src/lock.ts'
import { acquireMemoryMutationLease, tryAcquireMemoryMutationLease } from '../src/mutation-lease.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-lease-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** Let every already-settled promise callback run. */
const flush = (): Promise<void> => new Promise<void>((resolveFlush) => setTimeout(resolveFlush, 0))

describe('acquireMemoryMutationLease', () => {
  it('grants two acquires on the same dir in FIFO order', async () => {
    const dir = join(root, 'memory-a')
    const first = await acquireMemoryMutationLease(dir, new AbortController().signal)
    const granted: string[] = []
    const second = acquireMemoryMutationLease(dir, new AbortController().signal).then((release) => {
      granted.push('second')
      return release
    })
    const third = acquireMemoryMutationLease(dir, new AbortController().signal).then((release) => {
      granted.push('third')
      return release
    })
    await flush()
    // Holding the slot keeps both waiters queued.
    expect(granted).toEqual([])
    expect(tryAcquireMemoryMutationLease(dir)).toBeUndefined()

    first()
    const releaseSecond = await second
    expect(granted).toEqual(['second'])
    releaseSecond()
    const releaseThird = await third
    expect(granted).toEqual(['second', 'third'])
    releaseThird()
  })

  it('runs different dirs in parallel', async () => {
    const heldA = await acquireMemoryMutationLease(join(root, 'dir-a'), new AbortController().signal)
    // No release of `dir-a` has happened: the second dir must not wait for it.
    const heldB = await acquireMemoryMutationLease(join(root, 'dir-b'), new AbortController().signal)
    expect(typeof heldB).toBe('function')
    expect(tryAcquireMemoryMutationLease(join(root, 'dir-b'))).toBeUndefined()
    heldA()
    heldB()
  })

  it('removes a cancelled waiter from the queue so the next waiter is granted', async () => {
    const dir = join(root, 'memory-c')
    const held = await acquireMemoryMutationLease(dir, new AbortController().signal)
    const controller = new AbortController()
    const cancelled = acquireMemoryMutationLease(dir, controller.signal)
    const granted: string[] = []
    const survivor = acquireMemoryMutationLease(dir, new AbortController().signal).then((release) => {
      granted.push('survivor')
      return release
    })
    await flush()

    const reason = new Error('dispose')
    controller.abort(reason)
    await expect(cancelled).rejects.toBe(reason)

    held()
    const releaseSurvivor = await survivor
    expect(granted).toEqual(['survivor'])
    releaseSurvivor()
  })

  it('rejects an already-aborted wait without occupying the slot', async () => {
    const dir = join(root, 'memory-d')
    const controller = new AbortController()
    controller.abort()
    await expect(acquireMemoryMutationLease(dir, controller.signal)).rejects.toBeDefined()
    // Nothing was queued and nothing was owned: the slot is free.
    const release = tryAcquireMemoryMutationLease(dir)
    expect(typeof release).toBe('function')
    release!()
  })

  it('release is idempotent (a double release cannot double-grant)', async () => {
    const dir = join(root, 'memory-e')
    const release = await acquireMemoryMutationLease(dir, new AbortController().signal)
    const granted: string[] = []
    const waiter = acquireMemoryMutationLease(dir, new AbortController().signal).then((next) => {
      granted.push('waiter')
      return next
    })
    release()
    release()
    const releaseWaiter = await waiter
    await flush()
    expect(granted).toEqual(['waiter'])
    releaseWaiter()
  })
})

describe('tryAcquireMemoryMutationLease', () => {
  it('a dream-style conflict returns undefined and takes no disk lock', async () => {
    // A real directory, so "no disk lock" is observable on the filesystem.
    const dir = join(root, 'memory-f')
    mkdirSync(dir)
    const held = await acquireMemoryMutationLease(dir, new AbortController().signal)

    const conflicted = tryAcquireMemoryMutationLease(dir)
    expect(conflicted).toBeUndefined()
    // The conflict path exits before the original disk lock: nothing was written.
    expect(readdirSync(dir)).toEqual([])
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false)

    held()
    const after = tryAcquireMemoryMutationLease(dir)
    expect(typeof after).toBe('function')
    after!()
  })

  it('granting an unowned slot synchronously and releasing frees it', () => {
    const dir = join(root, 'memory-g')
    const release = tryAcquireMemoryMutationLease(dir)
    expect(typeof release).toBe('function')
    expect(tryAcquireMemoryMutationLease(dir)).toBeUndefined()
    release!()
    const again = tryAcquireMemoryMutationLease(dir)
    expect(typeof again).toBe('function')
    again!()
  })
})
