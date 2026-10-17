/**
 * Source snapshot capture and registration (design
 * docs/plans/2026-10-16-vwa-evidence-argument.md §5 Source, §10.3
 * evidence.register).
 *
 * `CaptureRegistry` is the in-session projection of trusted tool events:
 * whitelist `web_fetch`/`read` capture the pre-truncation tool-result body;
 * a same-session `write`/`edit` producing byte-identical bytes upgrades a
 * file source to `tool-event`, otherwise `unverified` — never guessed.
 *
 * Snapshots are exact copied bytes under `docs/vwa-sources/<projectId>/`:
 * no added frontmatter, no changed line numbers (§14.1).
 *
 * @module @dsh-cc/vwa-argument/sources
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, resolve, sep } from 'node:path'
import { sha256Hex, stableJson, authorDefValidator, ajvErrors } from './schema.ts'
import type { ProjectSnapshot, Source } from './types.ts'
import { VwaFail, fail, type ProjectStore, type Result, type StagedFile } from './store.ts'
import { validateEvidenceAgainstSnapshot } from './graph.ts'

/** One trusted capture/write event observed by the host wiring. */
export interface CaptureEvent {
  tool: 'web_fetch' | 'read' | 'write' | 'edit'
  /** Absolute path of the file the event touched. */
  path: string
  /** Pre-truncation body bytes of the tool result (the byte source, §10.3). */
  bytes: Buffer
  at: string
}

/** Trusted capture whitelist (§10.3) — `web_fetch`/`read` only. */
export const CAPTURE_WHITELIST: ReadonlySet<CaptureEvent['tool']> = new Set(['web_fetch', 'read'])

const UPGRADE_TOOLS: ReadonlySet<CaptureEvent['tool']> = new Set(['write', 'edit'])

/** In-session registry of trusted capture events (per §10.3 projection rules). */
export class CaptureRegistry {
  private readonly events: CaptureEvent[] = []

  /** @param maxEvents - retention cap; the oldest events are dropped first. */
  constructor(private readonly maxEvents: number = Number.POSITIVE_INFINITY) {}

  /** Record one host-observed tool event (the wiring calls this from the tool pipeline). */
  record(event: CaptureEvent): void {
    this.events.push(event)
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents)
  }

  /** Latest trusted capture whose body bytes equal these, at any path/URL, recorded before `before`. */
  private captureOfBytes(bytes: Buffer, before: number): CaptureEvent | undefined {
    for (let i = before - 1; i >= 0; i -= 1) {
      const event = this.events[i]
      if (event !== undefined && event.bytes.equals(bytes) && this.trusted(i)) return event
    }
    return undefined
  }

  /**
   * D23: a whitelist capture is TRUSTED only when no earlier same-session
   * write/edit produced the same bytes — reading back model-authored bytes
   * (write → read) is an echo, not an acquisition.
   */
  private trusted(index: number): boolean {
    const event = this.events[index]
    if (event === undefined || !CAPTURE_WHITELIST.has(event.tool)) return false
    for (let j = 0; j < index; j += 1) {
      const earlier = this.events[j]
      if (earlier !== undefined && UPGRADE_TOOLS.has(earlier.tool) && earlier.bytes.equals(event.bytes)) return false
    }
    return true
  }

  /** Latest trusted capture of a path with these exact bytes, newest first. */
  private matching(path: string, bytes: Buffer): CaptureEvent | undefined {
    const absolute = resolve(path)
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const event = this.events[i]
      if (event === undefined) continue
      if (event.path === absolute && event.bytes.equals(bytes) && this.trusted(i)) return event
    }
    return undefined
  }

  /**
   * Acquisition projection (§10.3): a verified whitelist capture of these
   * exact bytes → tool-event; a same-session write/edit byte-identical to a
   * capture body → tool-event (upgrade rule); otherwise unverified — never
   * guessed.
   */
  classify(path: string, bytes: Buffer): { kind: 'tool-event' | 'user-file' | 'unverified'; capturedAt: string; eventRef?: string } {
    const absolute = resolve(path)
    const eventRefOf = (source: string): string =>
      `${source}:${sha256Hex(stableJson({ path: absolute, size: bytes.length }))}`
    const capture = this.matching(absolute, bytes)
    if (capture !== undefined) {
      return { kind: 'tool-event', capturedAt: capture.at, eventRef: eventRefOf(capture.tool) }
    }
    // Upgrade rule (§10.3): a same-session write/edit of THIS path whose bytes
    // equal a whitelist capture body — the capture may come from any path or
    // URL (a web_fetch body saved to a file is the canonical case).
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      const event = this.events[i]
      if (event === undefined) continue
      if (!UPGRADE_TOOLS.has(event.tool) || event.path !== absolute || !event.bytes.equals(bytes)) continue
      const source = this.captureOfBytes(bytes, i)
      if (source !== undefined) {
        return {
          kind: 'tool-event', capturedAt: event.at,
          eventRef: eventRefOf(`${source.tool}->${event.tool}`),
        }
      }
    }
    return { kind: 'unverified', capturedAt: new Date().toISOString() }
  }

  /** Whether a whitelist capture of this exact body exists (D23 guard input). */
  hasCaptureOf(path: string, bytes: Buffer): boolean {
    return this.matching(path, bytes) !== undefined
  }
}

/** Tool input body for evidence.register (§10.3): system/snapshot fields removed. */
export interface RegisterSourceInput {
  path: string
  metadata: {
    title: string
    creators: string[]
    publication: string
    originalLocator: string
    edition: string
    language: string
    origin: Source['origin']
    material: Source['material']
    lineage?: { relation: Source['lineage']['relation']; parentSourceIds: string[]; note?: string }
    authenticity?: 'unverified' | 'documented' | 'questioned'
    authenticityBasisEvidenceIds?: string[]
  }
  excerpts: {
    clientKey: string
    span: { start: number; end: number }
    contextSpan?: { start: number; end: number }
    originalLocation: string
    transformation: 'none' | 'translation' | 'transcription' | 'extraction'
    transformationNote: string
  }[]
}

/** Registered-source result (§10.3). */
export interface RegisterOutcome {
  sourceId: string
  evidenceIds: { clientKey: string; evidenceId: string }[]
  snapshotPath: string
  snapshotHash: string
  duplicated: boolean
}

const MAX_SOURCE_BYTES = 8 * 1024 * 1024

/**
 * Validate the path (§10.3): realpath regular file inside root, ≤8 MiB,
 * valid UTF-8, no NUL/unpaired surrogates; stat before and after read, hash
 * re-read before commit (INPUT_CHANGED on mismatch). Sources must never live
 * under the runtime's own output trees (`.dsh/vwa`, `docs/vwa-sources`,
 * `docs/vwa-reports`) — the report output being rescanned as evidence would
 * create a self-referential evidence loop (D22).
 */
export function readSourceBytes(root: string, path: string): { bytes: Buffer; text: string; hash: string } {
  if (!isAbsolute(path)) throw new VwaFail(fail('PATH_OUT_OF_BOUNDS', 'path must be absolute'))
  const relative = path.replace(/\\/g, '/').replace(/^\//, '').split('/')
  if (relative[0] === '.dsh' && relative[1] === 'vwa'
    || (relative[0] === 'docs' && (relative[1] === 'vwa-sources' || relative[1] === 'vwa-reports'))) {
    throw new VwaFail(fail('PATH_OUT_OF_BOUNDS', `path is inside the runtime output tree and cannot be a source (D22): ${path}`))
  }
  let resolved: string
  try {
    const resolvedRoot = realpathSync(root)
    resolved = realpathSync(path)
    if (!resolved.startsWith(resolvedRoot + sep) && resolved !== resolvedRoot) {
      throw new VwaFail(fail('PATH_OUT_OF_BOUNDS', `path escapes the workspace root: ${path}`))
    }
    const statBefore = statSync(resolved)
    if (!statBefore.isFile()) throw new VwaFail(fail('PATH_OUT_OF_BOUNDS', 'path is not a regular file'))
    if (statBefore.size > MAX_SOURCE_BYTES) throw new VwaFail(fail('LIMIT_EXCEEDED', 'source exceeds 8 MiB'))
    const bytes = readFileSync(resolved)
    const statAfter = statSync(resolved)
    if (statAfter.mtimeMs !== statBefore.mtimeMs || statAfter.size !== statBefore.size) {
      throw new VwaFail(fail('INPUT_CHANGED', 'source file changed during read', true))
    }
    if (bytes.includes(0)) throw new VwaFail(fail('INVALID_ENCODING', 'binary input (NUL byte) is rejected'))
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw new VwaFail(fail('INVALID_ENCODING', 'input is not valid UTF-8'))
    }
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
      throw new VwaFail(fail('INVALID_ENCODING', 'unpaired UTF-16 surrogates are rejected'))
    }
    return { bytes, text, hash: rawSha256(bytes) }
  } catch (error: unknown) {
    if (error instanceof VwaFail) throw error
    throw new VwaFail(fail('PATH_OUT_OF_BOUNDS', `cannot read source path: ${String(error)}`))
  }
}

/** Raw-byte SHA-256 (§4: over the original bytes, no line-ending/Unicode normalization). */
export function rawSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Lineage cluster: undirected connected components over parentSourceIds (§5.1). */
export function lineageClusterOf(sourceId: string, sources: ProjectSnapshot['sources']): Set<string> {
  const adjacency = new Map<string, Set<string>>()
  for (const source of sources) {
    for (const parentId of source.lineage.parentSourceIds) {
      push(adjacency, source.id, parentId)
      push(adjacency, parentId, source.id)
    }
  }
  const cluster = new Set<string>([sourceId])
  const queue = [sourceId]
  while (queue.length > 0) {
    const current = queue.pop() as string
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!cluster.has(neighbor)) {
        cluster.add(neighbor)
        queue.push(neighbor)
      }
    }
  }
  return cluster
}

function push(map: Map<string, Set<string>>, a: string, b: string): void {
  const set = map.get(a) ?? new Set<string>()
  set.add(b)
  map.set(a, set)
}

/**
 * Build the in-transaction apply function for `evidence.register` (§10.3):
 * validate path/encoding, complete the metadata explicitly, dedup by hash +
 * completed metadata (excluding capturedAt), capture an exact-byte snapshot,
 * and create evidence excerpts in the same transaction (the quote is read
 * by the runtime from the span, never passed in).
 */
export function registerSourceApply(
  store: ProjectStore,
  captures: CaptureRegistry,
  input: RegisterSourceInput,
): (snapshot: ProjectSnapshot) => { result: RegisterOutcome; files: StagedFile[] } {
  return (snapshot: ProjectSnapshot) => {
    const read = readSourceBytes(storeRootOf(store), input.path)
    const reread = readSourceBytes(storeRootOf(store), input.path)
    if (reread.hash !== read.hash) throw new VwaFail(fail('INPUT_CHANGED', 'source changed between reads', true))
    const snapshotHash = read.hash

    // Completed metadata (§10.3): lineage/authenticity wrapped explicitly, no Ajv defaults.
    const metadata = {
      title: input.metadata.title,
      creators: input.metadata.creators,
      publication: input.metadata.publication,
      originalLocator: input.metadata.originalLocator,
      edition: input.metadata.edition,
      language: input.metadata.language,
      origin: input.metadata.origin,
      material: input.metadata.material,
      lineage: {
        relation: input.metadata.lineage?.relation ?? ('unknown' as const),
        parentSourceIds: input.metadata.lineage?.parentSourceIds ?? [],
        note: input.metadata.lineage?.note ?? 'source relation not yet verified',
      },
      authenticity: input.metadata.authenticity ?? ('unverified' as const),
      authenticityBasisEvidenceIds: input.metadata.authenticityBasisEvidenceIds ?? [],
    }
    if (metadata.authenticity === 'documented' && metadata.authenticityBasisEvidenceIds.length === 0) {
      throw new VwaFail(fail('SCHEMA_INVALID', 'documented authenticity requires non-empty authenticityBasisEvidenceIds'))
    }
    for (const parentId of metadata.lineage.parentSourceIds) {
      if (!snapshot.sources.some((source) => source.id === parentId)) {
        throw new VwaFail(fail('REFERENCE_INVALID', `lineage references unknown source ${parentId}`))
      }
    }

    // Dedup by hash + completed metadata, excluding the runtime capturedAt (§10.3).
    const dedupKey = sha256Hex(stableJson({ hash: read.hash, metadata }))
    const existing = snapshot.sources.find((source) => sourceDedupKey(source) === dedupKey)
    const sourceId = existing?.id ?? `src_${crypto.randomUUID()}`
    const acquisition = captures.classify(input.path, read.bytes)

    // Snapshot: exact copied bytes, no added headings (§14.1).
    const snapshotPath = ['docs', 'vwa-sources', store.projectId, `${sourceId}.md`].join('/')
    const absoluteSnapshot = resolve(store.snapshotDir, `${sourceId}.md`)
    const files: StagedFile[] = [{ path: absoluteSnapshot, bytes: read.bytes }]

    // Evidence excerpts in the same transaction; quote from the runtime (§10.3).
    const evidenceIds: { clientKey: string; evidenceId: string }[] = []
    const now = new Date().toISOString()
    for (const excerpt of input.excerpts) {
      const evidenceId = `ev_${crypto.randomUUID()}`
      evidenceIds.push({ clientKey: excerpt.clientKey, evidenceId })
      const evidence = {
        id: evidenceId, entityVersion: 1, createdAt: now, updatedAt: now,
        sourceId, sourceSnapshotHash: snapshotHash,
        span: excerpt.span,
        quote: read.text.slice(excerpt.span.start, excerpt.span.end),
        contextSpan: excerpt.contextSpan ?? excerpt.span,
        originalLocation: excerpt.originalLocation,
        transformation: excerpt.transformation,
        transformationNote: excerpt.transformationNote,
      }
      validateEvidenceAgainstSnapshot(evidence, read.text)
      snapshot.evidence.push(evidence)
    }

    const source: Source = {
      id: sourceId,
      entityVersion: existing !== undefined ? existing.entityVersion : 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      snapshotPath, snapshotHash, acquisition, ...metadata,
    }
    const validateSource = authorDefValidator('Source')
    if (!validateSource(source)) {
      throw new VwaFail(fail('SCHEMA_INVALID', `Source schema violation: ${ajvErrors(validateSource)}`))
    }
    if (existing !== undefined) {
      snapshot.sources = snapshot.sources.filter((candidate) => candidate.id !== existing.id)
    }
    snapshot.sources.push(source)
    return {
      result: { sourceId, evidenceIds, snapshotPath, snapshotHash, duplicated: existing !== undefined },
      files,
    }
  }
}

const crypto = { randomUUID }

function storeRootOf(store: ProjectStore): string {
  return resolve(store.snapshotDir, '..', '..', '..')
}

/** Dedup key of a stored Source: snapshot hash + author metadata, minus capturedAt (§10.3). */
function sourceDedupKey(source: Source): string {
  const metadata = {
    title: source.title, creators: source.creators, publication: source.publication,
    originalLocator: source.originalLocator, edition: source.edition, language: source.language,
    origin: source.origin, material: source.material, lineage: source.lineage,
    authenticity: source.authenticity, authenticityBasisEvidenceIds: source.authenticityBasisEvidenceIds,
  }
  return sha256Hex(stableJson({ hash: source.snapshotHash, metadata }))
}

/**
 * Mechanical currency check (§15): a source snapshot must never change; an
 * externally modified snapshot file is a mechanical failure, not staleness.
 */
export function verifySnapshot(store: ProjectStore, source: { snapshotPath: string; snapshotHash: string }): Result<{ hash: string }> {
  const relative = source.snapshotPath.split('/').pop() ?? ''
  try {
    const bytes = readFileSync(resolve(store.snapshotDir, relative))
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      return fail('INVALID_ENCODING', 'snapshot is no longer valid UTF-8')
    }
    const hash = rawSha256(bytes)
    if (hash !== source.snapshotHash) {
      return fail('STORE_CORRUPT', `snapshot ${source.snapshotPath} was modified outside the store`, false)
    }
    return { ok: true, projectId: store.projectId, revision: 0, data: { hash } }
  } catch (error: unknown) {
    return fail('NOT_FOUND', `cannot read snapshot: ${String(error)}`)
  }
}
