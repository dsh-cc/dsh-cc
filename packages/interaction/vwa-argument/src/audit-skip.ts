/**
 * Feature 4 §5.2 explicit audit skip: ONE predicate shared by the report,
 * continue, feasibility and batch-completion call sites.
 *
 * A skip declaration lives on the admission request record (`skipAudit`), bound
 * to one artifact binding by `artifactHash` + `entityVersion` (excluded from
 * every identity hash). It takes effect when the most recent admission for
 * that artifact whose record carries the SAME binding declared the skip, and
 * no complete audit run (extract + align in one run, matching artifactHash)
 * exists AFTER the declaration. A later complete audit or a later non-skip
 * admission flips it back.
 *
 * @module @dsh-cc/vwa-argument/audit-skip
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from './schema.ts'
import { ReviewRunStore } from './review-run-store.ts'
import type { Hash, Id, ProjectSnapshot } from './types.ts'

/** Who declared the skip in effect (the admission runId rendered to readers). */
export interface AuditSkip {
  runId: Id
}

type Request = NonNullable<ReturnType<ReviewRunStore['readRequest']>>
type Record = ReturnType<ReviewRunStore['readRecords']>[number]

function runIds(root: string, projectId: Id): string[] {
  try {
    return readdirSync(join(root, '.dsh', 'vwa', projectId, 'review-runs'))
  } catch {
    return []
  }
}

function requestOrder(request: Request): string {
  return `${request.startedAt}\u0000${request.runId}`
}

/** `{artifactHash, entityVersion}` of the current binding of one artifact. */
export function artifactBinding(
  snapshot: ProjectSnapshot,
  artifact: { id: Id; text: string },
): { artifactHash: Hash; entityVersion: number | undefined } {
  const bound = snapshot.artifacts.find((candidate) => candidate.id === artifact.id)
  return { artifactHash: sha256Hex(artifact.text), entityVersion: bound?.entityVersion }
}

/**
 * §5.2: the skip in effect for this artifact binding, or undefined. Reads the
 * durable request records (admission order = startedAt, tie-broken by runId)
 * and the persisted review records (complete = extract + align in one run).
 */
export function auditSkipInEffect(
  root: string,
  projectId: Id,
  artifactId: Id,
  artifactHash: Hash,
  entityVersion: number | undefined,
): AuditSkip | undefined {
  const store = new ReviewRunStore(root, projectId)
  const requests = runIds(root, projectId).flatMap((runId) => {
    const request = store.readRequest(runId)
    return request ? [request] : []
  })
  const declarations = requests
    .filter(
      (request) =>
        request.artifactId === artifactId &&
        request.artifactHash === artifactHash &&
        request.entityVersion === entityVersion,
    )
    .sort((a, b) => requestOrder(a).localeCompare(requestOrder(b)))
  const declaration = declarations.at(-1)
  if (declaration === undefined || declaration.skipAudit !== true) return undefined
  const declaredAt = requestOrder(declaration)
  const complete = new Map<Id, Record[]>()
  for (const runId of runIds(root, projectId)) {
    const records = store.readRecords(runId)
    if (records.some((record) => record.stage === 'extract' && record.artifactHash === artifactHash) &&
        records.some((record) => record.stage === 'align' && record.artifactHash === artifactHash))
      complete.set(runId, records)
  }
  for (const runId of complete.keys()) {
    const request = store.readRequest(runId)
    if (request !== undefined && requestOrder(request) > declaredAt) return undefined
  }
  return { runId: declaration.runId }
}

/** Convenience wrapper for call sites that hold the snapshot + bound artifact text. */
export function auditSkipForArtifact(
  root: string,
  snapshot: ProjectSnapshot,
  artifact?: { id: Id; text: string },
): AuditSkip | undefined {
  if (artifact === undefined) return undefined
  const { artifactHash, entityVersion } = artifactBinding(snapshot, artifact)
  return auditSkipInEffect(root, snapshot.projectId, artifact.id, artifactHash, entityVersion)
}
