/**
 * Store-level deterministic tests (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §22.1): CAS concurrency
 * (D08), crash injection at every rename point (D09), recovery candidates,
 * idempotency (D07), and the source-modified mechanical check (D10).
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/store.ts'
import { CONTRACT, expectFail, initWorkspace, makeWorkspace, seedSource, uuid } from './helpers.ts'
import { rawSha256, verifySnapshot } from '../src/sources.ts'

afterEach(() => {
  // tmpdirs under os.tmpdir() are cleaned by the OS; nothing to do here.
})

describe('layout and HEAD (§14.1)', () => {
  it('init creates HEAD, workspace nonce, and an empty graph at revision 1', () => {
    const made = initWorkspace()
    expect(existsSync(join(made.root, '.dsh', 'vwa', made.projectId, 'HEAD.json'))).toBe(true)
    expect(existsSync(join(made.root, '.dsh', 'vwa', made.projectId, 'locks'))).toBe(true)
    expect(made.store.workspaceIdentity()).toMatch(/^[0-9a-f]{64}$/)
    const head = made.store.readHead()
    expect(head.ok).toBe(true)
    if (!head.ok) return
    expect(head.data.head.revision).toBe(1)
    expect(head.data.snapshot.sources).toHaveLength(0)
  })

  it('init refuses an existing project', () => {
    const made = initWorkspace()
    expectFail(made.store.init(CONTRACT), 'SCHEMA_INVALID', 'already exists')
  })

  it('readHead verifies the revision envelope hash', () => {
    const made = initWorkspace()
    const headPath = join(made.root, '.dsh', 'vwa', made.projectId, 'HEAD.json')
    const head = JSON.parse(readFileSync(headPath, 'utf8')) as { revisionPath: string; graphHash: string }
    const revisionPath = join(made.root, '.dsh', 'vwa', made.projectId, head.revisionPath)
    const envelope = JSON.parse(readFileSync(revisionPath, 'utf8')) as { snapshot: unknown; graphHash: string }
    expect(envelope.graphHash).toBe(head.graphHash)
    // Tamper with the snapshot inside the envelope → HEAD no longer verifies.
    ;(envelope.snapshot as { contract: { question: string } }).contract.question = 'tampered'
    writeFileSync(revisionPath, JSON.stringify(envelope))
    expectFail(made.store.readHead(), 'STORE_CORRUPT')
  })
})

describe('CAS transactions (§14.2)', () => {
  it('commits increment revision, persist parentGraphHash chain, and write the operation record', () => {
    const made = initWorkspace()
    const first = made.store.withTransaction({
      expectedRevision: 1, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => { snapshot.claims.push({ id: `cl_${uuid()}`, entityVersion: 1, createdAt: 't', updatedAt: 't' } as never); return { result: 'one' } },
    })
    expect(first.ok).toBe(true)
    const second = made.store.withTransaction({
      expectedRevision: 2, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => { snapshot.claims.push({ id: `cl_${uuid()}`, entityVersion: 1, createdAt: 't', updatedAt: 't' } as never); return { result: 'two' } },
    })
    expect(second.ok).toBe(true)
    const head = made.store.readHead()
    expect(head.ok).toBe(true)
    if (!head.ok) return
    expect(head.data.head.revision).toBe(3)
    const dir = join(made.root, '.dsh', 'vwa', made.projectId, 'revisions')
    const files = readdirSync(dir)
    expect(files.length).toBe(3)
  })

  it('rejects a stale expectedRevision without touching HEAD (D08 sequential CAS)', () => {
    const made = initWorkspace()
    // Commit once so HEAD is at 2; a writer armed with the old revision conflicts.
    made.store.withTransaction({
      expectedRevision: 1, requestId: uuid(), payloadHash: uuid(),
      applyFn: () => ({ result: 'first' }),
    })
    expectFail(
      made.store.withTransaction({
        expectedRevision: 1, requestId: uuid(), payloadHash: uuid(),
        applyFn: () => ({ result: 'stale' }),
      }),
      'REVISION_CONFLICT',
    )
    const head = made.store.readHead()
    expect(head.ok).toBe(true)
    if (head.ok) expect(head.data.head.revision).toBe(2)
  })

  it('concurrent writers: one succeeds, the other reports LOCK_BUSY (D08)', () => {
    const made = initWorkspace()
    // A live foreign process holds the lock (dead-holder reclaim must not fire).
    const holder = spawn('node', ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' })
    writeFileSync(join(made.root, '.dsh', 'vwa', made.projectId, 'locks', 'write.lock'),
      JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString(), nonce: 'foreign' }))
    const started = Date.now()
    const result = made.store.withTransaction({
      expectedRevision: 1, requestId: uuid(), payloadHash: uuid(),
      applyFn: () => ({ result: 'x' }),
    })
    expectFail(result, 'LOCK_BUSY')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    holder.kill()
    rmSync(join(made.root, '.dsh', 'vwa', made.projectId, 'locks', 'write.lock'))
  })
})

describe('idempotency (§10.1, D07)', () => {
  it('same requestId + same payload replays the committed result', () => {
    const made = initWorkspace()
    const requestId = uuid()
    const payloadHash = uuid()
    const first = made.store.withTransaction({
      expectedRevision: 1, requestId, payloadHash,
      applyFn: (snapshot) => { snapshot.claims.push({ id: `cl_${uuid()}`, entityVersion: 1, createdAt: 't', updatedAt: 't' } as never); return { result: 'first' } },
    })
    expect(first.ok).toBe(true)
    const replay = made.store.withTransaction({
      expectedRevision: 1, requestId, payloadHash,
      applyFn: () => ({ result: 'first' }),
    })
    expect(replay.ok).toBe(true)
    if (replay.ok) {
      expect(replay.revision).toBe(2) // the committed revision, not a new one
      expect(replay.data).toBe('first')
    }
    const head = made.store.readHead()
    if (head.ok) expect(head.data.head.revision).toBe(2) // no extra revision
  })

  it('same requestId + different payload reports IDEMPOTENCY_CONFLICT', () => {
    const made = initWorkspace()
    const requestId = uuid()
    made.store.withTransaction({
      expectedRevision: 1, requestId, payloadHash: 'hash-a',
      applyFn: () => ({ result: 'first' }),
    })
    expectFail(
      made.store.withTransaction({
        expectedRevision: 2, requestId, payloadHash: 'hash-b',
        applyFn: () => ({ result: 'second' }),
      }),
      'IDEMPOTENCY_CONFLICT',
    )
  })
})

describe('crash injection (D09)', () => {
  it('HEAD stays the complete old version when a crash hits any rename point; retry completes', () => {
    const requestId = uuid()
    const payloadHash = uuid()
    const apply = (snapshot: { claims: unknown[] }) => {
      snapshot.claims.push({ id: `cl_${uuid()}`, entityVersion: 1, createdAt: 't', updatedAt: 't' })
      return { result: 'ok' }
    }
    for (let crashAfter = 1; crashAfter <= 3; crashAfter += 1) {
      const made = initWorkspace()
      const crashing = new ProjectStore(made.root, made.projectId, { crashAfter })
      expect(() => crashing.withTransaction({ expectedRevision: 1, requestId, payloadHash, applyFn: apply }))
        .toThrow(/simulated crash/)
      // After "restart": HEAD is either the complete old or the complete new
      // version. Ops 1–2 crash before the HEAD replace → old; op 3 crashes
      // just after the HEAD rename → the complete new version.
      const fresh = new ProjectStore(made.root, made.projectId)
      const head = fresh.readHead()
      expect(head.ok).toBe(true)
      if (!head.ok) continue
      const committedNew = crashAfter >= 3
      expect(head.data.head.revision).toBe(committedNew ? 2 : 1)
      if (committedNew) {
        expect(head.data.head.operationId).toBe(requestId)
        continue
      }
      // A prepared-but-uncommitted operation re-runs to completion.
      const retried = fresh.withTransaction({ expectedRevision: 1, requestId, payloadHash, applyFn: apply })
      expect(retried.ok).toBe(true)
      const after = fresh.readHead()
      if (after.ok) expect(after.data.head.operationId).toBe(requestId)
    }
  })

  it('a crash during HEAD replace never leaves a mixed graph (read-back consistency)', () => {
    const made = initWorkspace()
    made.store.withTransaction({
      expectedRevision: 1, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => { snapshot.claims.push({ id: `cl_${uuid()}`, entityVersion: 1, createdAt: 't', updatedAt: 't' } as never); return { result: 1 } },
    })
    const crashing = new ProjectStore(made.root, made.projectId, { crashAfter: 3 })
    expect(() => crashing.withTransaction({
      expectedRevision: 2, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => { snapshot.claims.push({ id: `cl_${uuid()}`, entityVersion: 1, createdAt: 't', updatedAt: 't' } as never); return { result: 2 } },
    })).toThrow(/simulated crash/)
    const fresh = new ProjectStore(made.root, made.projectId)
    const head = fresh.readHead()
    expect(head.ok).toBe(true)
    if (head.ok) {
      // HEAD points at a self-consistent revision: hash matches its snapshot.
      const revisionPath = join(made.root, '.dsh', 'vwa', made.projectId, head.data.head.revisionPath)
      const envelope = JSON.parse(readFileSync(revisionPath, 'utf8')) as { graphHash: string }
      expect(envelope.graphHash).toBe(head.data.head.graphHash)
    }
  })
})

describe('recovery (§14.2)', () => {
  it('corrupt HEAD yields STORE_CORRUPT with verifiable candidates; repair adopts one', () => {
    const made = initWorkspace()
    made.store.withTransaction({
      expectedRevision: 1, requestId: uuid(), payloadHash: uuid(),
      applyFn: (snapshot) => { snapshot.claims.push({ id: `cl_${uuid()}`, entityVersion: 1, createdAt: 't', updatedAt: 't' } as never); return { result: 2 } },
    })
    const headPath = join(made.root, '.dsh', 'vwa', made.projectId, 'HEAD.json')
    writeFileSync(headPath, '{not json')
    const corrupt = new ProjectStore(made.root, made.projectId)
    const failure = expectFail(corrupt.readHead(), 'STORE_CORRUPT')
    const candidates = (failure.details as { candidates: { revision: number; revisionPath: string }[] }).candidates
    expect(candidates.map((candidate) => candidate.revision)).toEqual([2, 1])
    // Never silently adopted: HEAD is still invalid until explicit repair.
    expectFail(corrupt.readHead(), 'STORE_CORRUPT')
    const repaired = corrupt.repair(candidates[0].revisionPath)
    expect(repaired.ok).toBe(true)
    const head = corrupt.readHead()
    if (head.ok) expect(head.data.head.revision).toBe(2)
  })

  it('tampered revisions are not offered as recovery candidates', () => {
    const made = initWorkspace()
    const revisionsDir = join(made.root, '.dsh', 'vwa', made.projectId, 'revisions')
    const files = readdirSync(revisionsDir)
    const envelope = JSON.parse(readFileSync(join(revisionsDir, files[0]), 'utf8')) as { snapshot: { contract: { question: string } } }
    envelope.snapshot.contract.question = 'forged'
    writeFileSync(join(revisionsDir, files[0]), JSON.stringify(envelope))
    const corrupt = new ProjectStore(made.root, made.projectId)
    const failure = expectFail(corrupt.readHead(), 'STORE_CORRUPT')
    expect((failure.details as { candidates: unknown[] }).candidates).toHaveLength(0)
  })

  it('cleans orphan temp files older than 24h, never committed history', () => {
    const made = initWorkspace()
    const orphan = join(made.root, '.dsh', 'vwa', made.projectId, 'revisions', 'orphan.tmp')
    writeFileSync(orphan, 'partial')
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    utimesSync(orphan, old, old)
    const fresh = join(made.root, '.dsh', 'vwa', made.projectId, 'fresh.tmp')
    writeFileSync(fresh, 'partial')
    const cleaned = made.store.recoverOrphans()
    expect(cleaned).toContain(orphan)
    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(made.store.readHead().ok).toBe(true)
  })
})

describe('source snapshot currency (D10, §15)', () => {
  it('an externally modified snapshot file is a mechanical failure, not staleness', () => {
    const made = initWorkspace()
    const text = 'original bytes'
    const source = seedSource(made.store, text)
    const before = rawSha256(Buffer.from(text, 'utf8'))
    expect(source.snapshotHash).toBe(before)
    writeFileSync(join(made.store.snapshotDir, `${source.id}.md`), 'tampered bytes', 'utf8')
    const verdict = verifySnapshot(made.store, source)
    expect(verdict.ok).toBe(false)
    expect(verdict.code).toBe('STORE_CORRUPT')
  })
})
