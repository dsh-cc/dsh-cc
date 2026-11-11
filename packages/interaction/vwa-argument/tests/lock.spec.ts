/**
 * Lock-path regressions (design docs/plans/2026-11-02-vwa-torn-lock-recovery.md
 * §5, issue #307): staged-link acquisition, torn/unparseable reclaim, the
 * read/parse split, staging hygiene, and the full-buffer write loop.
 *
 * `vi.mock('node:fs', { spy: true })` (below) makes the builtins
 * mock-able while still calling through, so `writeSync`/`linkSync` can be
 * intercepted for one call and restored.
 */

import * as fs from 'node:fs'
import { fork, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { acquireLock, lockHeld, releaseLock } from '../src/lock.ts'

vi.mock('node:fs', { spy: true })

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'vwa-lock-'))
}

function lockDirOf(dir: string): string {
  return join(dir, 'locks')
}

function lockPathOf(dir: string): string {
  return join(lockDirOf(dir), 'write.lock')
}

function plant(dir: string, text: string): string {
  mkdirSync(lockDirOf(dir), { recursive: true })
  writeFileSync(lockPathOf(dir), text)
  return lockPathOf(dir)
}

function bodyOf(dir: string): { pid: number; startedAt: string; nonce: string } {
  return JSON.parse(readFileSync(lockPathOf(dir), 'utf8')) as { pid: number; startedAt: string; nonce: string }
}

function validBody(pid: number): string {
  return JSON.stringify({ pid, startedAt: new Date().toISOString(), nonce: 'foreign' })
}

/** A live foreign process, reaped by the caller (or the returned `kill`). */
function liveForeign(): { pid: number; kill: () => void } {
  const child = spawn('node', ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  return { pid: child.pid!, kill: () => child.kill() }
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/**
 * Path map so a `tsx` child resolves the package's workspace imports from
 * `src/` (the same aliases the package's vitest config applies), keeping the
 * cross-process test independent of a built `lib/`.
 */
function childTsconfig(dir: string): string {
  const self = (path: string): string => join(REPO_ROOT, path)
  const path = join(dir, 'tsconfig.json')
  writeFileSync(path, JSON.stringify({
    compilerOptions: {
      paths: {
        '@dsh-cc/vwa-evidence': [self('packages/interaction/vwa-evidence/src/index.ts')],
        '@dsh-cc/sidecar-io': [self('packages/observability/sidecar-io/src/index.ts')],
        '@dsh-cc/settings/ns': [self('packages/settings/settings/src/ns/src/index.ts')],
        '@dsh-cc/settings': [self('packages/settings/settings/src/src/index.ts')],
        '@dsh-cc/session-cwd': [self('packages/workspace/session-cwd/src/index.ts')],
      },
    },
  }))
  return path
}

/** A pid that is certainly dead: a spawned child that has already exited. */async function deadPid(): Promise<number> {
  const child = spawn('node', ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid!
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return pid
}

describe('staged link acquisition (#307 §3.1)', () => {
  it('reclaims a torn (non-JSON) lock instead of bricking on LOCK_BUSY', () => {
    const dir = workspace()
    try {
      plant(dir, '{"pid": 1234, "startedAt": "torn')
      const started = Date.now()
      expect(acquireLock(dir)).toBeUndefined()
      // Full reclaim path, not deadline expiry (the brick took 2 s every time).
      expect(Date.now() - started).toBeLessThan(1900)
      expect(bodyOf(dir).pid).toBe(process.pid)
    } finally {
      releaseLock(dir)
    }
  })

  it('reclaims a zero-byte lock', () => {
    const dir = workspace()
    try {
      plant(dir, '')
      expect(acquireLock(dir)).toBeUndefined()
      expect(bodyOf(dir).pid).toBe(process.pid)
    } finally {
      releaseLock(dir)
    }
  })

  it('reclaims a wrong-shape-but-parseable body ({}) as a dead holder', () => {
    const dir = workspace()
    try {
      plant(dir, '{}')
      expect(acquireLock(dir)).toBeUndefined()
      expect(bodyOf(dir).pid).toBe(process.pid)
    } finally {
      releaseLock(dir)
    }
  })

  it('still blocks on a live foreign holder: LOCK_BUSY retryable after the 2 s wait', () => {
    const dir = workspace()
    const holder = liveForeign()
    try {
      plant(dir, validBody(holder.pid))
      const started = Date.now()
      const refusal = acquireLock(dir)
      expect(refusal).toMatchObject({ ok: false, code: 'LOCK_BUSY', retryable: true })
      expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
      expect(bodyOf(dir).pid).toBe(holder.pid) // the live lock was never unlinked
      expect(lockHeld(dir)).toBe(true)
    } finally {
      holder.kill()
      releaseLock(dir)
    }
  })

  it('reclaims a dead holder', async () => {
    const dir = workspace()
    try {
      plant(dir, validBody(await deadPid()))
      expect(acquireLock(dir)).toBeUndefined()
      expect(bodyOf(dir).pid).toBe(process.pid)
    } finally {
      releaseLock(dir)
    }
  })

  it('reports self-deadlock without waiting when this process holds the lock', () => {
    const dir = workspace()
    try {
      expect(acquireLock(dir)).toBeUndefined()
      const started = Date.now()
      const refusal = acquireLock(dir)
      expect(refusal).toMatchObject({ ok: false, code: 'LOCK_BUSY', retryable: true })
      expect(refusal?.message).toContain('another transaction in this process')
      expect(Date.now() - started).toBeLessThan(1000)
    } finally {
      releaseLock(dir)
    }
  })

  it('publishes a complete body naming this process', () => {
    const dir = workspace()
    try {
      expect(acquireLock(dir)).toBeUndefined()
      const body = bodyOf(dir)
      expect(body.pid).toBe(process.pid)
      expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false)
      expect(typeof body.nonce).toBe('string')
    } finally {
      releaseLock(dir)
    }
  })

  it('reaps dead-pid staging, keeps live-pid staging, and still acquires', async () => {
    const dir = workspace()
    const holder = liveForeign()
    const dead = await deadPid()
    try {
      mkdirSync(lockDirOf(dir), { recursive: true })
      const deadStaging = join(lockDirOf(dir), `write.lock.${dead}.n.u1.tmp`)
      const liveStaging = join(lockDirOf(dir), `write.lock.${holder.pid}.n.u2.tmp`)
      writeFileSync(deadStaging, 'partial')
      writeFileSync(liveStaging, 'partial')
      expect(acquireLock(dir)).toBeUndefined()
      expect(fs.existsSync(deadStaging)).toBe(false)
      expect(fs.existsSync(liveStaging)).toBe(true)
    } finally {
      holder.kill()
      releaseLock(dir)
    }
  })

  it('loops on a short writeSync instead of publishing a torn body', async () => {
    const dir = workspace()
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    const write = vi.mocked(fs.writeSync)
    try {
      // A genuine 3-byte write: the helper must loop for the remainder.
      write.mockImplementationOnce(((fd: number, bytes: Buffer, offset: number) =>
        actual.writeSync(fd, bytes, offset, 3)) as never)
      expect(acquireLock(dir)).toBeUndefined()
      expect(write.mock.calls.length).toBeGreaterThan(1)
      const body = bodyOf(dir)
      expect(body.pid).toBe(process.pid)
      expect(typeof body.nonce).toBe('string')
    } finally {
      write.mockRestore()
      releaseLock(dir)
    }
  })

  it('retries immediately when the holder released between our EEXIST and our read', () => {
    const dir = workspace()
    const link = vi.mocked(fs.linkSync)
    const lockPath = plant(dir, validBody(liveForeign().pid))
    try {
      // The holder releases just after our link fails: read sees ENOENT.
      link.mockImplementationOnce(() => {
        rmSync(lockPath)
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' })
      })
      const started = Date.now()
      expect(acquireLock(dir)).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(1000)
      expect(bodyOf(dir).pid).toBe(process.pid)
    } finally {
      link.mockRestore()
      releaseLock(dir)
    }
  })

  it('admits exactly one of two live acquirers on an empty dir', async () => {
    const dir = workspace()
    // Real acquisition code, one process each (same pattern as the
    // review-cycle cross-process test). The child resolves the package's
    // workspace imports from src/ via this generated path map, so the test
    // needs no built lib/.
    const children = [0, 1].map(() => fork(
      fileURLToPath(new URL('./fixtures/lock-acquirer.ts', import.meta.url)),
      [dir],
      {
        execArgv: ['--import=tsx'],
        env: { ...process.env, TSX_TSCONFIG_PATH: childTsconfig(dir) },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    ))
    try {
      const outcomes = await Promise.all(children.map((child) => new Promise<{ code: number | null; stderr: string }>(
        (resolve, reject) => {
          let stderr = ''
          child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
          child.once('error', reject)
          child.once('exit', (code) => resolve({ code, stderr }))
        },
      )))
      // Exactly one winner; the loser reports LOCK_BUSY (§5 case 11).
      const report = JSON.stringify(outcomes)
      expect(outcomes.filter((outcome) => outcome.code === 0), report).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.code !== 0), report).toHaveLength(1)
    } finally {
      children.forEach((child) => child.kill())
      releaseLock(dir)
    }
  }, 15_000)

  it('release removes the lock and leaves foreign staging alone', () => {
    const dir = workspace()
    mkdirSync(lockDirOf(dir), { recursive: true })
    // An unparseable pid segment is never reaped (§3.3) — pure bystander.
    const foreignStaging = join(lockDirOf(dir), 'write.lock.foreign.u0.tmp')
    writeFileSync(foreignStaging, 'partial')
    expect(acquireLock(dir)).toBeUndefined()
    releaseLock(dir)
    expect(fs.existsSync(lockPathOf(dir))).toBe(false)
    expect(readdirSync(lockDirOf(dir))).toContain('write.lock.foreign.u0.tmp')
  })
})

describe('lockHeld reporting', () => {
  it('is false without a lock and true for a live holder', () => {
    const dir = workspace()
    expect(lockHeld(dir)).toBe(false)
    try {
      expect(acquireLock(dir)).toBeUndefined()
      expect(lockHeld(dir)).toBe(true)
    } finally {
      releaseLock(dir)
    }
  })
})
