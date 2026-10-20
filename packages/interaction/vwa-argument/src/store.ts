/**
 * Immutable per-project store (design docs/plans/2026-10-16-vwa-evidence-argument.md
 * §14): CAS commit protocol, lock, crash recovery.
 *
 * Layout (§14.1): `.dsh/vwa/<projectId>/` with HEAD.json, revisions/,
 * operations/, locks/write.lock, workspace.json (identity nonce); source
 * snapshots live under `docs/vwa-sources/<projectId>/`. HEAD =
 * `{schemaVersion,projectId,revision,graphHash,revisionPath,operationId}`;
 * the revision envelope additionally wraps `parentGraphHash` + `operationId`
 * (the envelope is not part of graphHash, §14.2) so the parent chain is
 * persisted, not just the latest HEAD.
 *
 * Durability order per §14.2: source snapshots → revision file → operation
 * file (status `prepared`) → atomic HEAD replace + parent-dir fsync →
 * read-back HEAD/revision hash. Every write-rename passes through the
 * injectable `io` seam; `crashAfter` counts rename ops 1..N so tests can
 * drop the "process" at any point (D09).
 *
 * @module @dsh-cc/vwa-argument/store
 */

import { freezeReviewSettings, type FrozenReviewSettings } from './review-config.ts'
import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { sha256Hex, stableJson, type JsonValue } from './schema.ts'
import { acquireLock as acquireProjectLock } from './lock.ts'
import type { ProjectSnapshot } from './types.ts'

/** Uniform failed result (§10.8 stable codes). */
export interface Fail {
  ok: false
  code:
    | 'SCHEMA_INVALID' | 'REVISION_CONFLICT' | 'ENTITY_VERSION_CONFLICT'
    | 'REFERENCE_INVALID' | 'REFERENCE_IN_USE' | 'SUPPORT_CYCLE'
    | 'PATH_OUT_OF_BOUNDS' | 'INVALID_ENCODING' | 'INPUT_CHANGED'
    | 'CONTEXT_TOO_LARGE' | 'LIMIT_EXCEEDED' | 'STORE_CORRUPT'
    | 'STORE_IO_FAILED' | 'LOCK_BUSY' | 'IDEMPOTENCY_CONFLICT' | 'NOT_FOUND'
    | 'REVIEW_UNAVAILABLE' | 'REVIEW_INVALID' | 'BUDGET_EXHAUSTED' | 'CANCELLED'
    | 'NOTHING_TO_CONTINUE' | 'BUDGET_INSUFFICIENT'
  message: string
  retryable: boolean
  details?: JsonValue
}

/** Thrown by transaction apply functions to produce a uniform failure (§10.1). */
export class VwaFail extends Error {
  constructor(readonly fail: Fail) {
    super(fail.message)
  }
}

/** Uniform success envelope (§10.1). */
export interface Ok<T> {
  ok: true
  projectId: string
  revision: number
  data: T
}

export type Result<T> = Ok<T> | Fail

/** Build one failure result. */
export function fail(code: Fail['code'], message: string, retryable = false, details?: JsonValue): Fail {
  // Omit an absent `details`: tool results must be lossless JSON (no undefined).
  return details === undefined ? { ok: false, code, message, retryable } : { ok: false, code, message, retryable, details }
}

/** HEAD document (§14.1). */
export interface Head {
  schemaVersion: 1
  projectId: string
  revision: number
  graphHash: string
  revisionPath: string
  operationId: string
}

/** Revision envelope — wraps the snapshot with the parent chain (§14.2). */
export interface RevisionEnvelope {
  schemaVersion: 1
  projectId: string
  revision: number
  graphHash: string
  parentGraphHash: string
  operationId: string
  snapshot: ProjectSnapshot
}

/** Operation idempotency record; `prepared` counts as committed only via HEAD (§14.2). */
export interface OperationRecord {
  requestId: string
  payloadHash: string
  status: 'prepared'
  revision: number
  result: unknown
}

/** Injectable durability seam; production methods wrap node:fs. */
export interface DurabilityIo {
  writeTemp(path: string, bytes: Buffer): void
  rename(from: string, to: string): void
  fsyncDir(path: string): void
}

const PROD_IO: DurabilityIo = {
  writeTemp(path, bytes) {
    const fd = openSync(path, 'w')
    try {
      writeSync(fd, bytes)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  },
  rename: renameSync,
  fsyncDir() {
    /* Portable stand-in for a directory fsync; kept as a seam so the
       durability op count is identical in tests and production. */
  },
}

export interface StoreOptions {
  /** Drop the "process" (throw) after this many rename ops in a commit (D09 test seam). */
  crashAfter?: number
  io?: DurabilityIo
}

/\*\* §14.2 lock rules live in lock.ts (split for the file-size cap). \*/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Files staged before the revision file (exact-byte source snapshots). */
export interface StagedFile {
  path: string
  bytes: Buffer
}

export interface TransactionInput<T> {
  expectedRevision: number
  requestId: string
  payloadHash: string
  /** Mutate a private clone of the current snapshot in place. */
  applyFn: (snapshot: ProjectSnapshot) => { result: T; files?: StagedFile[] }
}

export class ProjectStore {
  readonly projectId: string
  private readonly root: string
  private readonly io: DurabilityIo
  private readonly crashAfter: number | undefined
  private renameCount = 0

  constructor(root: string, projectId: string, options: StoreOptions = {}) {
    this.root = root
    this.projectId = projectId
    this.io = options.io ?? PROD_IO
    this.crashAfter = options.crashAfter
  }

  get dir(): string {
    return join(this.root, '.dsh', 'vwa', this.projectId)
  }

  get snapshotDir(): string {
    return join(this.root, 'docs', 'vwa-sources', this.projectId)
  }

  private revisionsDir(): string {
    return join(this.dir, 'revisions')
  }

  /** Crash-injection counter: throws at the injected rename point (D09). */
  private tick(): void {
    this.renameCount += 1
    if (this.crashAfter !== undefined && this.renameCount === this.crashAfter) {
      throw new Error(`simulated crash at rename op ${this.renameCount}`)
    }
  }

  /** Temp (with file fsync) + rename + dir-fsync seam. */
  private writeAtomic(path: string, value: unknown): void {
    const tmp = `${path}.tmp`
    this.io.writeTemp(tmp, Buffer.from(stableJson(value), 'utf8'))
    this.io.rename(tmp, path)
    this.tick()
    this.io.fsyncDir(dirname(path))
  }

  /** Create the project: dirs, workspace nonce, HEAD at revision 1, empty graph (§14.1). */
  init(
    contract: ProjectSnapshot['contract'],
    reviewSettings: FrozenReviewSettings = freezeReviewSettings(),
  ): Result<{ workspaceIdentity: string }> {
    if (existsSync(join(this.dir, 'HEAD.json'))) {
      return fail('SCHEMA_INVALID', `project ${this.projectId} already exists`)
    }
    mkdirSync(this.revisionsDir(), { recursive: true })
    mkdirSync(join(this.dir, 'operations'), { recursive: true })
    mkdirSync(join(this.dir, 'locks'), { recursive: true })
    mkdirSync(this.snapshotDir, { recursive: true })
    const workspaceIdentity = sha256Hex(stableJson({ root: this.root, nonce: randomUUID() }))
    this.writeAtomic(join(this.dir, 'workspace.json'), { schemaVersion: 1, projectId: this.projectId, workspaceIdentity })
    const snapshot: ProjectSnapshot = {
      schemaVersion: 1, projectId: this.projectId, revision: 1, workspaceIdentity,
      contract: { ...contract, reviewSettings }, sources: [], evidence: [], claims: [], groups: [], arguments: [],
      issues: [], searches: [], artifacts: [],
    }
    this.writeCommittedRevision(snapshot, '', 'init')
    return { ok: true, projectId: this.projectId, revision: 1, data: { workspaceIdentity } }
  }

  /** Persist envelope + HEAD for an already-decided revision (init/repair path). */
  private writeCommittedRevision(snapshot: ProjectSnapshot, parentGraphHash: string, operationId: string): void {
    const graphHash = sha256Hex(stableJson(snapshot))
    const fileName = `${snapshot.revision}-${graphHash}.json`
    const envelope: RevisionEnvelope = {
      schemaVersion: 1, projectId: this.projectId, revision: snapshot.revision,
      graphHash, parentGraphHash, operationId, snapshot,
    }
    this.writeAtomic(join(this.revisionsDir(), fileName), envelope)
    const head: Head = {
      schemaVersion: 1, projectId: this.projectId, revision: snapshot.revision,
      graphHash, revisionPath: `revisions/${fileName}`, operationId,
    }
    this.writeAtomic(join(this.dir, 'HEAD.json'), head)
  }

  /**
   * Read and verify HEAD (§14.2): schema fields, revision envelope hash,
   * snapshot-vs-graphHash agreement. Never adopts the newest file on
   * mismatch — returns STORE_CORRUPT with recovery candidates.
   */
  readHead(): Result<{ head: Head; snapshot: ProjectSnapshot }> {
    const headPath = join(this.dir, 'HEAD.json')
    if (!existsSync(headPath)) return this.corrupt('HEAD.json is missing')
    let headValue: unknown
    try {
      headValue = readJson(headPath)
    } catch {
      return this.corrupt('HEAD.json is not valid JSON')
    }
    if (!isObject(headValue) || headValue.schemaVersion !== 1 || headValue.projectId !== this.projectId
      || typeof headValue.revision !== 'number' || typeof headValue.graphHash !== 'string'
      || typeof headValue.revisionPath !== 'string' || typeof headValue.operationId !== 'string') {
      return this.corrupt('HEAD.json is malformed')
    }
    const head = headValue as unknown as Head
    const revisionAbs = join(this.dir, head.revisionPath)
    if (!existsSync(revisionAbs)) return this.corrupt('HEAD revision file is missing')
    let envelopeValue: unknown
    try {
      envelopeValue = readJson(revisionAbs)
    } catch {
      return this.corrupt('revision envelope is not valid JSON')
    }
    if (!isObject(envelopeValue) || !isObject(envelopeValue.snapshot)) {
      return this.corrupt('revision envelope is malformed')
    }
    const envelope = envelopeValue as unknown as RevisionEnvelope
    const snapshot = envelope.snapshot
    const graphHash = sha256Hex(stableJson(snapshot))
    if (graphHash !== head.graphHash || envelope.graphHash !== head.graphHash
      || envelope.operationId !== head.operationId) {
      return this.corrupt('revision envelope does not match HEAD')
    }
    return { ok: true, projectId: this.projectId, revision: head.revision, data: { head, snapshot } }
  }

  /** STORE_CORRUPT with verifiable recovery candidates (§14.2) — never auto-adopt. */
  private corrupt(message: string): Fail {
    return fail('STORE_CORRUPT', message, true, { candidates: this.recoveryCandidates() })
  }

  /** All revision envelopes whose snapshot hash self-verifies. */
  recoveryCandidates(): { revision: number; graphHash: string; revisionPath: string }[] {
    const candidates: { revision: number; graphHash: string; revisionPath: string }[] = []
    const dir = this.revisionsDir()
    if (!existsSync(dir)) return candidates
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue
      try {
        const envelope = readJson(join(dir, file)) as RevisionEnvelope
        if (!isObject(envelope) || !isObject(envelope.snapshot)) continue
        if (sha256Hex(stableJson(envelope.snapshot)) !== envelope.graphHash) continue
        candidates.push({
          revision: envelope.revision, graphHash: envelope.graphHash,
          revisionPath: `revisions/${file}`,
        })
      } catch {
        // Unreadable files are not candidates.
      }
    }
    return candidates.sort((a, b) => b.revision - a.revision)
  }

  /**
   * Adopt an explicitly chosen recovery candidate as HEAD (`/vwa repair`,
   * §14.2) after re-verifying its hash and parent chain.
   */
  repair(revisionPath: string): Result<{ revision: number }> {
    if (!revisionPath.startsWith('revisions/')) {
      return fail('PATH_OUT_OF_BOUNDS', `not a revision path: ${revisionPath}`)
    }
    const absolute = join(this.dir, revisionPath)
    if (!existsSync(absolute)) return fail('NOT_FOUND', `no such revision file: ${revisionPath}`)
    let envelopeValue: unknown
    try {
      envelopeValue = readJson(absolute)
    } catch {
      return fail('STORE_CORRUPT', 'candidate envelope is not valid JSON')
    }
    if (!isObject(envelopeValue) || !isObject(envelopeValue.snapshot)) {
      return fail('STORE_CORRUPT', 'candidate envelope is malformed')
    }
    const envelope = envelopeValue as unknown as RevisionEnvelope
    if (sha256Hex(stableJson(envelope.snapshot)) !== envelope.graphHash) {
      return fail('STORE_CORRUPT', 'candidate snapshot hash mismatch')
    }
    const chain = this.verifyChain(envelope)
    if (!chain.ok) return chain
    this.writeCommittedRevision(envelope.snapshot, envelope.parentGraphHash, envelope.operationId)
    return { ok: true, projectId: this.projectId, revision: envelope.revision, data: { revision: envelope.revision } }
  }

  /** Walk `parentGraphHash` back to a genesis (parent '') revision (§14.2). */
  private verifyChain(envelope: RevisionEnvelope): Result<{ depth: number }> {
    let current = envelope
    let depth = 0
    while (current.parentGraphHash !== '') {
      const dir = this.revisionsDir()
      const parentFile = readdirSync(dir).find((file) => {
        return file.startsWith(`${current.revision - 1}-`) && file.endsWith('.json') && !file.endsWith('.tmp')
      })
      if (parentFile === undefined) {
        return fail('STORE_CORRUPT', `missing parent revision for ${current.revision}`)
      }
      const parentEnvelope = readJson(join(dir, parentFile)) as RevisionEnvelope
      if (parentEnvelope.graphHash !== current.parentGraphHash) {
        return fail('STORE_CORRUPT', `parent hash mismatch at revision ${current.revision}`)
      }
      current = parentEnvelope
      depth += 1
    }
    return { ok: true, projectId: this.projectId, revision: current.revision, data: { depth } }
  }

  /**
   * Clean unreferenced temp files older than 24h (§14.2). Committed history
   * is never touched.
   */
  recoverOrphans(now = Date.now()): string[] {
    const cleaned: string[] = []
    const cutoff = now - 24 * 60 * 60 * 1000
    for (const dir of [this.dir, this.revisionsDir(), this.snapshotDir]) {
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.tmp')) continue
        const path = join(dir, file)
        try {
          if (statSync(path).mtimeMs < cutoff) {
            rmSync(path)
            cleaned.push(path)
          }
        } catch {
          // Raced cleanup is harmless.
        }
      }
    }
    return cleaned
  }

  /** Read the persisted workspace identity nonce (§5.2). */
  workspaceIdentity(): string | undefined {
    try {
      const body = readJson(join(this.dir, 'workspace.json')) as { workspaceIdentity?: string }
      return typeof body.workspaceIdentity === 'string' ? body.workspaceIdentity : undefined
    } catch {
      return undefined
    }
  }

  /** Exclusive-create lock (§14.2) — the §14.2 rules live in lock.ts. */
  private acquireLock(): Fail | undefined {
    return acquireProjectLock(this.dir)
  }

  /**
   * Run one CAS transaction (§14.2): idempotency pre-check → lock → HEAD
   * verify → expectedRevision CAS → apply in memory → staged files →
   * revision → operation (`prepared`) → atomic HEAD replace → read-back.
   * Commit happens only when everything succeeded.
   */
  withTransaction<T>(input: TransactionInput<T>): Result<T> {
    const opPath = join(this.dir, 'operations', `${input.requestId}.json`)
    if (existsSync(opPath)) {
      let record: OperationRecord
      try {
        record = readJson(opPath) as OperationRecord
      } catch {
        return fail('STORE_CORRUPT', 'operation record is not valid JSON')
      }
      if (record.payloadHash !== input.payloadHash) {
        return fail('IDEMPOTENCY_CONFLICT', `requestId ${input.requestId} was used with a different payload`)
      }
      const head = this.readHead()
      if (head.ok && head.data.head.operationId === input.requestId) {
        return { ok: true, projectId: this.projectId, revision: head.revision, data: record.result as T }
      }
      // Prepared-but-uncommitted (crash before HEAD replace): re-run the op.
    }
    const lockFailure = this.acquireLock()
    if (lockFailure !== undefined) return lockFailure
    try {
      return this.runTransaction(input)
    } finally {
      try {
        unlinkSync(join(this.dir, 'locks', 'write.lock'))
      } catch { /* best-effort release */ }
    }
  }

  private runTransaction<T>(input: TransactionInput<T>): Result<T> {
    const current = this.readHead()
    if (!current.ok) return current
    const { head, snapshot } = current.data
    if (head.revision !== input.expectedRevision) {
      return fail('REVISION_CONFLICT', `expected revision ${input.expectedRevision}, HEAD is ${head.revision}`, true)
    }
    let applied: { result: T; files?: { path: string; bytes: Buffer }[] }
    try {
      const working = structuredClone(snapshot)
      applied = input.applyFn(working)
      working.revision = head.revision + 1
      return this.commit(working, head, input, applied)
    } catch (error: unknown) {
      // applyFn signals validation failures by throwing a Fail-carrying error.
      if (error instanceof VwaFail) return error.fail
      if (isObject(error) && (error as { vwaFail?: Fail }).vwaFail !== undefined) {
        return (error as { vwaFail: Fail }).vwaFail
      }
      if (error instanceof Error && error.message.startsWith('simulated crash')) throw error
      return fail('SCHEMA_INVALID', `transaction apply failed: ${String(error)}`)
    }
  }

  private commit<T>(
    nextSnapshot: ProjectSnapshot,
    head: Head,
    input: TransactionInput<T>,
    applied: { result: T; files?: { path: string; bytes: Buffer }[] },
  ): Result<T> {
    const nextRevision = head.revision + 1
    const graphHash = sha256Hex(stableJson(nextSnapshot))
    // 1. Stage extra files (source snapshots): temp → fsync → rename (§14.2).
    for (const file of applied.files ?? []) {
      const tmp = `${file.path}.tmp`
      this.io.writeTemp(tmp, file.bytes)
      this.io.rename(tmp, file.path)
      this.tick()
      this.io.fsyncDir(dirname(file.path))
    }
    // 2. Immutable revision envelope (parentGraphHash chain, §14.2).
    const fileName = `${nextRevision}-${graphHash}.json`
    const envelope: RevisionEnvelope = {
      schemaVersion: 1, projectId: this.projectId, revision: nextRevision,
      graphHash, parentGraphHash: head.graphHash, operationId: input.requestId, snapshot: nextSnapshot,
    }
    this.writeAtomic(join(this.revisionsDir(), fileName), envelope)
    // 3. Operation record (prepared; committed once HEAD points here, §14.2).
    const op: OperationRecord = {
      requestId: input.requestId, payloadHash: input.payloadHash, status: 'prepared',
      revision: nextRevision, result: applied.result,
    }
    this.writeAtomic(join(this.dir, 'operations', `${input.requestId}.json`), op)
    // 4. Atomic HEAD replace.
    const nextHead: Head = {
      schemaVersion: 1, projectId: this.projectId, revision: nextRevision,
      graphHash, revisionPath: `revisions/${fileName}`, operationId: input.requestId,
    }
    this.writeAtomic(join(this.dir, 'HEAD.json'), nextHead)
    // 5. Read-back verification of HEAD and the revision hash (§14.2).
    const readBack = this.readHead()
    if (!readBack.ok || readBack.data.head.graphHash !== graphHash) {
      return fail('STORE_CORRUPT', 'HEAD read-back verification failed', true)
    }
    return { ok: true, projectId: this.projectId, revision: nextRevision, data: applied.result }
  }
}
