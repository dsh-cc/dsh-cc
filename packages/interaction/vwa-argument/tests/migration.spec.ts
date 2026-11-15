/**
 * `schemaVersion 1 → 2` migration (`/vwa repair <projectId> --migrate`, design
 * `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §8.2/§8.3, §6.3,
 * §13): the v1 write gate + its single migration exception, hash-verified
 * all-or-nothing snapshot staging, path rewrite, the new v2 directories, the
 * retirement of review records and adjudications, and the legacy trees that
 * stay untouched.
 *
 * The fixture builds a genuine PRE-migration project on disk (HEAD.json +
 * `revisions/1-<hash>.json` envelope + `docs/vwa-sources/<pid>/` snapshots),
 * because `store.init` now mints `schemaVersion: 2` (§8.3) and can no longer
 * produce a v1 project.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../src/store.ts'
import { executeVwa, parseVwaArgs } from '../src/commands.ts'
import { migrateProject, RETIRED_REASON } from '../src/migrate.ts'
import { rawSha256 } from '../src/sources.ts'
import { readReviewRecords } from '../src/report.ts'
import { ReviewRunStore } from '../src/review-run-store.ts'
import { sha256Hex, stableJson, validateProjectSnapshot } from '../src/schema.ts'
import { projectDraftsDir, projectReportsDir, projectRendersDir, projectRetiredDir, projectSourcesDir, sourceSnapshotPath } from '../src/paths.ts'
import { CONTRACT, expectFail } from './helpers.ts'
import type { AdjudicationRecord, ProjectSnapshot, ReviewRecord, Source } from '../src/types.ts'

const NOW = '2026-10-16T00:00:00.000Z'
const HASH = 'a'.repeat(64)

/** One legacy source record + the exact bytes of its `docs/vwa-sources/` snapshot. */
function legacySource(root: string, projectId: string, text: string): Source {
  const sourceId = `src_${randomUUID()}`
  const legacyPath = `docs/vwa-sources/${projectId}/${sourceId}.md`
  const absolute = join(root, ...legacyPath.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, text, 'utf8')
  return {
    id: sourceId,
    entityVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    snapshotPath: legacyPath,
    snapshotHash: rawSha256(Buffer.from(text, 'utf8')),
    acquisition: { kind: 'unverified', capturedAt: NOW },
    title: 'A legacy source',
    creators: [],
    publication: 'unknown',
    originalLocator: 'loc',
    edition: 'unknown',
    language: 'en',
    origin: 'external',
    material: 'primary',
    lineage: { relation: 'unknown', parentSourceIds: [], note: 'n' },
    authenticity: 'unverified',
    authenticityBasisEvidenceIds: [],
  }
}

/** Write the `HEAD.json` + revision envelope pair for a snapshot (v1 project on disk). */
function writeRevision(root: string, snapshot: ProjectSnapshot, parentGraphHash = '', operationId = 'init'): void {
  const projectDir = join(root, '.dsh', 'vwa', snapshot.projectId)
  const graphHash = sha256Hex(stableJson(snapshot))
  const fileName = `${snapshot.revision}-${graphHash}.json`
  writeFileSync(
    join(projectDir, 'revisions', fileName),
    stableJson({
      schemaVersion: 1,
      projectId: snapshot.projectId,
      revision: snapshot.revision,
      graphHash,
      parentGraphHash,
      operationId,
      snapshot,
    }),
    'utf8',
  )
  writeFileSync(
    join(projectDir, 'HEAD.json'),
    stableJson({
      schemaVersion: 1,
      projectId: snapshot.projectId,
      revision: snapshot.revision,
      graphHash,
      revisionPath: `revisions/${fileName}`,
      operationId,
    }),
    'utf8',
  )
}

interface LegacyEnv {
  root: string
  projectId: string
  store: ProjectStore
  snapshot: ProjectSnapshot
  sources: Source[]
  graphHash: string
}

/** A pre-migration (`schemaVersion: 1`) project: legacy snapshots on disk, no v2 directories. */
function legacyProject(texts: string[] = ['Legacy paragraph one.\n', 'Legacy paragraph two.\n']): LegacyEnv {
  const root = mkdtempSync(join(tmpdir(), 'vwa-migrate-'))
  const projectId = `prj_${randomUUID()}`
  const projectDir = join(root, '.dsh', 'vwa', projectId)
  for (const dir of ['revisions', 'operations', 'locks']) mkdirSync(join(projectDir, dir), { recursive: true })
  writeFileSync(
    join(projectDir, 'workspace.json'),
    stableJson({ schemaVersion: 1, projectId, workspaceIdentity: HASH }),
    'utf8',
  )
  const sources = texts.map((text) => legacySource(root, projectId, text))
  const snapshot: ProjectSnapshot = {
    schemaVersion: 1,
    projectId,
    revision: 1,
    workspaceIdentity: HASH,
    contract: CONTRACT,
    sources,
    evidence: [],
    claims: [],
    groups: [],
    arguments: [],
    issues: [],
    searches: [],
    artifacts: [],
  }
  writeRevision(root, snapshot)
  return { root, projectId, store: new ProjectStore(root, projectId), snapshot, sources, graphHash: sha256Hex(stableJson(snapshot)) }
}

function reviewRecord(runId: string): ReviewRecord {
  return {
    runId,
    stage: 'claims',
    targetRefs: [],
    dependencyDigest: 'c'.repeat(64),
    contractHash: 'd'.repeat(64),
    policyHash: 'e'.repeat(64),
    reviewerConfigHash: 'f'.repeat(64),
    promptHash: '1'.repeat(64),
    inputHash: '2'.repeat(64),
    status: 'completed',
    inputTokens: 0,
    outputTokens: 0,
    startedAt: NOW,
    endedAt: NOW,
  }
}

function adjudication(): AdjudicationRecord {
  return {
    adjudicationId: `adj_${randomUUID()}`,
    findingId: `finding_${randomUUID()}`,
    decision: 'accept',
    reason: 'the disagreement is genuine',
    signer: 'user',
    ts: NOW,
    dependencyDigest: '3'.repeat(64),
    overrides: {
      ruleId: 'AUDIT-01',
      targetId: `cl_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
    },
  }
}

/** Seed two completed review records in one run plus one persisted adjudication. */
function seedReviewState(env: LegacyEnv): { runId: string; adjudicationsPath: string } {
  const runs = new ReviewRunStore(env.root, env.projectId)
  const runId = `run_${randomUUID()}`
  runs.initRun(runId)
  runs.writeRecord(runId, reviewRecord(runId))
  runs.writeRecord(runId, reviewRecord(runId))
  const adjudicationsPath = join(env.root, '.dsh', 'vwa', env.projectId, 'adjudications.json')
  writeFileSync(adjudicationsPath, stableJson({ adjudications: [adjudication()] }), 'utf8')
  return { runId, adjudicationsPath }
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

describe('§8.3 --migrate: hash-verified staging and the v2 snapshot', () => {
  it('stages the exact bytes at .dsh/vwa/<pid>/sources and rewrites every snapshotPath', () => {
    const env = legacyProject()
    const legacyBytes = env.sources.map((source) => readFileSync(join(env.root, ...source.snapshotPath.split('/'))))

    const migrated = migrateProject(env.store)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.data.stagedSources).toBe(2)
    expect(migrated.revision).toBe(2)

    const head = env.store.readHead()
    expect(head.ok).toBe(true)
    if (!head.ok) return
    expect(head.data.snapshot.schemaVersion).toBe(2)
    expect(head.data.head.revision).toBe(2)
    expect(validateProjectSnapshot(head.data.snapshot)).toBe(true)

    // Parent chain intact: revision 2 names revision 1's graph hash as its parent.
    const envelope = readJson(join(env.root, '.dsh', 'vwa', env.projectId, 'revisions', `2-${head.data.head.graphHash}.json`))
    expect(envelope.parentGraphHash).toBe(env.graphHash)

    for (const [index, source] of head.data.snapshot.sources.entries()) {
      expect(source.snapshotPath).toBe(sourceSnapshotPath(env.projectId, source.id))
      const staged = readFileSync(join(env.root, ...source.snapshotPath.split('/')))
      expect(staged.equals(legacyBytes[index]!)).toBe(true)
      expect(rawSha256(staged)).toBe(source.snapshotHash)
    }
  })

  it('creates drafts/, reports/, renders/ and retired/', () => {
    const env = legacyProject()
    expect(migrateProject(env.store).ok).toBe(true)
    for (const dir of [
      projectDraftsDir(env.root, env.projectId),
      projectReportsDir(env.root, env.projectId),
      projectRendersDir(env.root, env.projectId),
      projectRetiredDir(env.root, env.projectId),
      projectSourcesDir(env.root, env.projectId),
    ]) {
      expect(existsSync(dir)).toBe(true)
    }
  })

  it('leaves the legacy docs/vwa-sources/<pid>/ tree untouched', () => {
    const env = legacyProject()
    const before = env.sources.map((source) => readFileSync(join(env.root, ...source.snapshotPath.split('/')), 'utf8'))
    expect(migrateProject(env.store).ok).toBe(true)
    for (const [index, source] of env.sources.entries()) {
      const legacyAbsolute = join(env.root, ...source.snapshotPath.split('/'))
      expect(existsSync(legacyAbsolute)).toBe(true)
      expect(readFileSync(legacyAbsolute, 'utf8')).toBe(before[index])
    }
  })

  it('leaves corpusPath absent: a legacy snapshot tree holds copies, never the corpus (§5.2)', () => {
    const env = legacyProject()
    const migrated = migrateProject(env.store)
    expect(migrated.ok).toBe(true)
    const head = env.store.readHead()
    if (!head.ok) throw new Error(head.message)
    for (const source of head.data.snapshot.sources) {
      expect((source as { corpusPath?: string }).corpusPath).toBeUndefined()
    }
    // The field itself is accepted by the v2 schema when a later registration records one.
    const withCorpus = structuredClone(head.data.snapshot)
    withCorpus.sources[0] = { ...withCorpus.sources[0]!, corpusPath: 'corpus/letters/1921.md' } as Source
    expect(validateProjectSnapshot(withCorpus)).toBe(true)
  })
})

describe('§6.3/§8.3 --migrate: retirement of review records and adjudications', () => {
  it('moves every review record and adjudication into retired/ with the migration header', () => {
    const env = legacyProject()
    const { runId } = seedReviewState(env)

    const migrated = migrateProject(env.store)
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.data.retiredReviews).toBe(2)
    expect(migrated.data.retiredAdjudications).toBe(1)

    const retiredRoot = projectRetiredDir(env.root, env.projectId)
    const retiredRunDir = join(retiredRoot, 'reviews', runId)
    const retiredRecords = readdirSync(retiredRunDir).filter((file) => file.endsWith('.json'))
    expect(retiredRecords).toHaveLength(2)
    for (const file of retiredRecords) {
      const retired = readJson(join(retiredRunDir, file))
      expect(retired.retiredReason).toBe(RETIRED_REASON)
      expect(retired.retiredReason).toBe('state-tree-migration')
      expect(typeof retired.record).toBe('object')
    }
    const retiredAdjudications = readJson(join(retiredRoot, 'adjudications.json'))
    expect(retiredAdjudications.retiredReason).toBe('state-tree-migration')
    expect((retiredAdjudications.adjudications as AdjudicationRecord[])).toHaveLength(1)
  })

  it('removes the records from the active set so delivery can only read not-run', () => {
    const env = legacyProject()
    const { runId, adjudicationsPath } = seedReviewState(env)
    expect(readReviewRecords(env.root, env.projectId)).toHaveLength(2)

    expect(migrateProject(env.store).ok).toBe(true)

    expect(readReviewRecords(env.root, env.projectId)).toHaveLength(0)
    expect(readdirSync(new ReviewRunStore(env.root, env.projectId).runDir(runId)).includes('records')).toBe(true)
    expect(readdirSync(new ReviewRunStore(env.root, env.projectId).runDir(runId) + '/records')).toHaveLength(0)
    expect(readJson(adjudicationsPath).adjudications).toEqual([])
  })

  it('refuses a project that is already at schemaVersion 2', () => {
    const env = legacyProject()
    expect(migrateProject(env.store).ok).toBe(true)
    expectFail(migrateProject(env.store), 'SCHEMA_INVALID', 'already at schemaVersion 2')
  })
})

describe('§8.3 --migrate: all-or-nothing on a missing or corrupt snapshot', () => {
  it('fails on a tampered snapshot without touching HEAD, retirement or the staged tree', () => {
    const env = legacyProject()
    const { adjudicationsPath } = seedReviewState(env)
    const tampered = env.sources[1]!
    writeFileSync(join(env.root, ...tampered.snapshotPath.split('/')), 'tampered bytes\n', 'utf8')

    expectFail(migrateProject(env.store), 'STORE_CORRUPT', 'hash mismatch')

    const head = env.store.readHead()
    if (!head.ok) throw new Error(head.message)
    expect(head.data.head.revision).toBe(1)
    expect(head.data.snapshot.schemaVersion).toBe(1)
    expect(readReviewRecords(env.root, env.projectId)).toHaveLength(2)
    expect(readJson(adjudicationsPath).adjudications).toHaveLength(1)
    expect(existsSync(join(projectRetiredDir(env.root, env.projectId), 'adjudications.json'))).toBe(false)
    for (const source of env.sources) {
      expect(existsSync(join(projectSourcesDir(env.root, env.projectId), `${source.id}.md`))).toBe(false)
    }
  })

  it('fails on a snapshot that is missing entirely', () => {
    const env = legacyProject()
    const missing = env.sources[0]!
    rmSync(join(env.root, ...missing.snapshotPath.split('/')))

    expectFail(migrateProject(env.store), 'NOT_FOUND', 'is missing')
    const head = env.store.readHead()
    if (!head.ok) throw new Error(head.message)
    expect(head.data.snapshot.schemaVersion).toBe(1)
  })
})

describe('§8.3 write gate: v1 projects are read-only except --migrate', () => {
  it('rejects an ordinary write to a schemaVersion 1 snapshot with the migration remedy', () => {
    const env = legacyProject()
    const applied = env.store.withTransaction<void>({
      expectedRevision: 1,
      requestId: `write-${randomUUID()}`,
      payloadHash: randomUUID(),
      applyFn: () => ({ result: undefined }),
    })
    const failure = expectFail(applied, 'SCHEMA_INVALID', '--migrate')
    expect(failure.message).toContain('schemaVersion 1')
  })

  it('accepts the same write once the project is migrated', () => {
    const env = legacyProject()
    expect(migrateProject(env.store).ok).toBe(true)
    const applied = env.store.withTransaction<number>({
      expectedRevision: 2,
      requestId: `write-${randomUUID()}`,
      payloadHash: randomUUID(),
      applyFn: () => ({ result: 7 }),
    })
    expect(applied.ok).toBe(true)
    if (applied.ok) expect(applied.data).toBe(7)
  })
})

describe('/vwa repair <projectId> --migrate (closed grammar, §8.3)', () => {
  it('accepts exactly one repair flag', () => {
    expect(parseVwaArgs('repair prj_x --migrate').ok).toBe(true)
    const parsed = parseVwaArgs('repair prj_x --migrate')
    if (parsed.ok) expect(parsed.rest).toEqual(['prj_x', '--migrate'])
    expect(parseVwaArgs('repair prj_x --bogus').ok).toBe(false)
    expect(parseVwaArgs('repair prj_x').ok).toBe(true)
  })

  it('reports the retirement counts and that the project needs re-review', async () => {
    const env = legacyProject()
    seedReviewState(env)
    const result = await executeVwa({ workspaceRoot: () => env.root }, undefined, {
      sub: 'repair',
      rest: [env.projectId, '--migrate'],
    })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('schemaVersion 2')
    expect(result.text).toContain('retired 2 review record(s) and 1 adjudication(s)')
    expect(result.text).toContain('not-run')
  })

  it('reports a failed migration without touching HEAD', async () => {
    const env = legacyProject()
    rmSync(join(env.root, ...env.sources[0]!.snapshotPath.split('/')))
    const result = await executeVwa({ workspaceRoot: () => env.root }, undefined, {
      sub: 'repair',
      rest: [env.projectId, '--migrate'],
    })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('NOT_FOUND')
    if (result.kind === 'error') expect(result.text).toContain('nothing was migrated')
  })
})
