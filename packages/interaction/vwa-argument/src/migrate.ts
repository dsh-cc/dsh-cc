/**
 * `schemaVersion 1 → 2` migration — `/vwa repair <projectId> --migrate`
 * (design `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §8.3,
 * retirement rules §6.3).
 *
 * A v1 project is READ-ONLY ({@link schemaWriteGate}): its `Source.snapshotPath`
 * values name the legacy `docs/vwa-sources/<projectId>/` tree, and because
 * sources participate in dependency hashing, every task identity changes once
 * the paths move. Pretense is worse than the truth, so migration CANNOT keep
 * review currency and does not try: review records and adjudications are moved
 * into `retired/` with a `retired-reason: 'state-tree-migration'` header and
 * the project must be re-reviewed (delivery reads `not-run` until then).
 *
 * The migration itself, in order (§8.3):
 * 1. verify every source snapshot exists and hashes to its recorded
 *    `snapshotHash` — all-or-nothing, so a missing/corrupt snapshot fails the
 *    whole operation before anything is written;
 * 2. stage those exact bytes at `.dsh/vwa/<projectId>/sources/`;
 * 3. rewrite `snapshotPath`, set `schemaVersion: 2` and create `drafts/`,
 *    `reports/`, `renders/`, `retired/`;
 * 4. retire review records + adjudications (§6.3);
 * 5. commit as a normal revision (parent chain intact, history keeps the old
 *    paths; `recoverOrphans` deliberately not extended, the `--migrate`
 *    transaction is a normal one).
 *
 * `corpusPath` is set only where derivable. It is NOT derivable for a v1
 * `Source`: registration never persisted the original workspace path, and the
 * legacy tree holds snapshot copies, not corpus files (§5.2). Legacy sources
 * therefore migrate with no `corpusPath` and stay not `gr:`-citable until they
 * are re-registered.
 *
 * The legacy `docs/vwa-sources/<projectId>/` trees are left in place: they are
 * immutable history and their removal is the user's call. No id rewriting, no
 * in-place conversion of legacy trees.
 *
 * @module @dsh-cc/vwa-argument/migrate
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fail, type ProjectStore, type Result, type StagedFile } from './store.ts'
import { rawSha256 } from './sources.ts'
import { sha256Hex, stableJson } from './schema.ts'
import {
  projectDraftsDir,
  projectRendersDir,
  projectReportsDir,
  projectRetiredDir,
  projectSourcesDir,
  projectStateDir,
  resolveRecordedPath,
  sourceSnapshotAbsolute,
  sourceSnapshotPath,
} from './paths.ts'

/** The `retired-reason` header every retired record carries (§6.3). */
export const RETIRED_REASON = 'state-tree-migration'

/** What §8.3 step 4 reports back to the operator. */
export interface MigrationReport {
  /** Review records moved into `retired/reviews/`. */
  retiredReviews: number
  /** Adjudications moved into `retired/adjudications.json`. */
  retiredAdjudications: number
  /** Source snapshots staged at the v2 `sources/` location. */
  stagedSources: number
}

/** Staged retired copies plus the active files they replace. */
interface RetirementPlan {
  files: StagedFile[]
  /** Active record files removed once the revision committed. */
  remove: string[]
  count: number
}

/** Read one JSON file, `undefined` when absent or unparseable (never throws). */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Retired-file envelope: the record plus the migration header (§6.3). */
function retiredEnvelope(retiredAt: string, body: Record<string, unknown>): Buffer {
  return Buffer.from(stableJson({ retiredReason: RETIRED_REASON, retiredAt, ...body }), 'utf8')
}

/**
 * §8.3 step 4 / §6.3: copy every review record of the project into
 * `retired/reviews/<runId>/<fileName>` and mark the originals for removal.
 * Records whose file cannot be parsed are not records (`readRecords` already
 * skips them) and stay where they are.
 */
function planReviewRetirement(stateDir: string, retiredDir: string, retiredAt: string): RetirementPlan {
  const runsDir = join(stateDir, 'review-runs')
  const plan: RetirementPlan = { files: [], remove: [], count: 0 }
  if (!existsSync(runsDir)) return plan
  for (const runId of readdirSync(runsDir).sort()) {
    const recordsDir = join(runsDir, runId, 'records')
    if (!existsSync(recordsDir)) continue
    for (const file of readdirSync(recordsDir).sort()) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue
      const absolute = join(recordsDir, file)
      const stored = readJsonFile(absolute) as { recordHash?: unknown; record?: unknown } | undefined
      if (stored === undefined || stored.record === undefined) continue
      plan.files.push({
        path: join(retiredDir, 'reviews', runId, file),
        bytes: retiredEnvelope(retiredAt, { recordHash: stored.recordHash ?? null, record: stored.record }),
      })
      plan.remove.push(absolute)
      plan.count += 1
    }
  }
  return plan
}

/**
 * §8.3 step 4 / §6.3: move the persisted adjudication ledger into
 * `retired/adjudications.json`, leaving an empty active ledger behind.
 */
function planAdjudicationRetirement(
  stateDir: string,
  retiredDir: string,
  retiredAt: string,
): RetirementPlan & { activePath: string } {
  const activePath = join(stateDir, 'adjudications.json')
  const plan: RetirementPlan & { activePath: string } = { files: [], remove: [], count: 0, activePath }
  const stored = readJsonFile(activePath) as { adjudications?: unknown } | undefined
  const adjudications = Array.isArray(stored?.adjudications) ? stored.adjudications : []
  if (adjudications.length === 0) return plan
  plan.files.push({
    path: join(retiredDir, 'adjudications.json'),
    bytes: retiredEnvelope(retiredAt, { adjudications }),
  })
  plan.count = adjudications.length
  return plan
}

/**
 * Run the v1 → v2 migration on one project. All-or-nothing: nothing is
 * written unless every source snapshot verified against its recorded hash.
 */
export function migrateProject(store: ProjectStore): Result<MigrationReport> {
  const head = store.readHead()
  if (!head.ok) return head
  const { snapshot } = head.data
  if (snapshot.schemaVersion !== 1) {
    return fail(
      'SCHEMA_INVALID',
      `project ${store.projectId} is already at schemaVersion ${snapshot.schemaVersion}; nothing to migrate`,
    )
  }

  // 1. Verify every source snapshot exists and hashes to its recorded hash;
  // 2. keep those exact bytes for the staging step below.
  const staged: StagedFile[] = []
  for (const source of snapshot.sources) {
    let bytes: Buffer
    try {
      bytes = readFileSync(resolveRecordedPath(store.root, source.snapshotPath))
    } catch {
      return fail(
        'NOT_FOUND',
        `source ${source.id} snapshot ${source.snapshotPath} is missing; nothing was migrated`,
      )
    }
    const hash = rawSha256(bytes)
    if (hash !== source.snapshotHash) {
      return fail(
        'STORE_CORRUPT',
        `source ${source.id} snapshot ${source.snapshotPath} hash mismatch (recorded ${source.snapshotHash.slice(0, 12)}…, found ${hash.slice(0, 12)}…); nothing was migrated`,
      )
    }
    staged.push({ path: sourceSnapshotAbsolute(store.root, store.projectId, source.id), bytes })
  }

  // 4. Plan the retirement of review records + adjudications (§6.3); its files
  // are staged in the same commit as the snapshot bytes.
  const retiredAt = new Date().toISOString()
  const stateDir = projectStateDir(store.root, store.projectId)
  const retiredDir = projectRetiredDir(store.root, store.projectId)
  const reviews = planReviewRetirement(stateDir, retiredDir, retiredAt)
  const adjudications = planAdjudicationRetirement(stateDir, retiredDir, retiredAt)

  // 3. Create the v2 directories the staged files need.
  for (const dir of [
    projectDraftsDir(store.root, store.projectId),
    projectSourcesDir(store.root, store.projectId),
    projectReportsDir(store.root, store.projectId),
    projectRendersDir(store.root, store.projectId),
    retiredDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  for (const file of [...reviews.files, ...adjudications.files]) mkdirSync(dirname(file.path), { recursive: true })

  const report: MigrationReport = {
    retiredReviews: reviews.count,
    retiredAdjudications: adjudications.count,
    stagedSources: staged.length,
  }
  const payload = {
    migration: RETIRED_REASON,
    from: snapshot.schemaVersion,
    to: 2,
    sources: snapshot.sources.map((source) => source.id).sort(),
    retiredReviews: report.retiredReviews,
    retiredAdjudications: report.retiredAdjudications,
  }
  // 5. A normal revision: parent chain intact, the operation id is the request id.
  const migrated = store.migrate<MigrationReport>({
    expectedRevision: head.data.head.revision,
    requestId: `migrate-${store.projectId}-${head.data.head.revision}`,
    payloadHash: sha256Hex(stableJson(payload)),
    applyFn: (working) => {
      working.schemaVersion = 2
      for (const source of working.sources) {
        // `corpusPath` stays absent: a v1 record never captured a workspace
        // path and the legacy tree holds snapshot copies, not corpus files
        // (§5.2) — nothing is derivable, so nothing is claimed.
        source.snapshotPath = sourceSnapshotPath(store.projectId, source.id)
      }
      return { result: report, files: [...staged, ...reviews.files, ...adjudications.files] }
    },
  })
  if (!migrated.ok) return migrated

  // The active set is cleared only once the v2 revision is HEAD (a crash before
  // the commit leaves the records active and the graph still at v1).
  for (const path of reviews.remove) {
    try {
      rmSync(path)
    } catch {
      // A record that cannot be removed is inert: `readRecords` hashes files.
    }
  }
  if (adjudications.count > 0) {
    writeFileSync(adjudications.activePath, stableJson({ adjudications: [] }), 'utf8')
  }
  return migrated
}
