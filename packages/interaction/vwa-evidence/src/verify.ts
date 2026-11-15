/**
 * Mechanical read-back verification (design
 * docs/plans/2026-10-12-verifiable-workspace-agent.md §4.2).
 *
 * A marker is `marked-ok` iff its sourceId parses to a whitelisted,
 * in-bounds `ws:` path AND the file exists AND the line range exists.
 * Status mapping over the four pinned statuses (§4.1):
 * - no markers present                     -> `unmarked`
 * - marker present but unparseable         -> `invalid-marker`
 * - path escapes the workspace / whitelist -> `out-of-bounds`
 * - in-bounds but file or line range absent -> `invalid-marker` with detail
 *   (the marker itself is well-formed; its source does not verify)
 * Semantic consistency is the judge tier's job and never enters the
 * mechanical score (§4.4).
 *
 * @module @dsh-cc/vwa-evidence/verify
 */

import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ClaimStatus } from './receipt.ts'
import type { SourceSpec } from './marker.ts'

/** Corpus whitelist, frozen (§4.2): `docs/` prefix ∪ `*.md` ∪ `*.mdx` under
 * the workspace — EXCLUDING the runtime's own output tree `.dsh/**` (D22:
 * the report output being rescanned as evidence would create a
 * self-referential evidence loop). */
export function isWhitelistedRel(relPosix: string): boolean {
  if (relPosix === '.dsh' || relPosix.startsWith('.dsh/')) return false
  return relPosix.startsWith('docs/') || /\.mdx?$/.test(relPosix)
}

/** One registered project source, as the `gr:` verifier reads it (§5.2). */
export interface GrSource {
  sourceId: string
  /** Workspace-relative POSIX path captured at registration; absent ⇒ not gr-citable. */
  corpusPath?: string
  /** Workspace-relative POSIX snapshot path recorded on the source (§8.1). */
  snapshotPath: string
  snapshotHash: string
}

/**
 * The ACTIVE project's source registry (§5.4), supplied by the vwa-argument
 * service through the structural provider seam (this package never imports it).
 */
export interface GrProjectSources {
  projectId: string
  sources: GrSource[]
}

export interface VerifyOptions {
  /** Filesystem surface, injectable for tests (defaults to node:fs/promises). */
  readLines?: (path: string) => Promise<string[]>
  /**
   * §5.4 project resolution for `gr:` specs only: the active project's source
   * registry. Absent, or resolving to undefined ⇒ fail closed with
   * `no active VWA project for gr: citation`.
   */
  projectSources?: () => Promise<GrProjectSources | undefined>
  /** Snapshot byte surface, injectable for tests (defaults to node:fs/promises). */
  readSnapshotBytes?: (path: string) => Promise<Buffer | undefined>
}

/** The exact §5.2/§5.3 invalid-marker reasons for a `gr:` citation (fail closed). */
export const GR_REASONS = {
  noProject: 'no active VWA project for gr: citation',
  notFound: 'gr: source not found in the active project',
  noCorpusPath: 'source has no recorded corpus path (re-register)',
  nonCorpus: 'source corpus path is outside the citable corpus',
  escapes: 'snapshot path escapes',
  tampered: 'snapshot hash mismatch (tampered)',
} as const

export interface VerifyOutcome {
  status: ClaimStatus
  /** Human-readable failure rationale; required for every non-ok outcome. */
  detail?: string
}

async function defaultReadLines(path: string): Promise<string[]> {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(path, 'utf8')
  return text.split('\n')
}

/** Line range exists: 1-based, inclusive, and line <a> through <b> are real lines. */
function lineRangeOutcome(lines: readonly string[], spec: SourceSpec, label: string): VerifyOutcome {
  if (spec.lineStart < 1 || spec.lineEnd < spec.lineStart || spec.lineEnd > lines.length) {
    return {
      status: 'invalid-marker',
      detail: `line range L${spec.lineStart}-L${spec.lineEnd} does not exist in ${label} (${lines.length} lines)`,
    }
  }
  return { status: 'marked-ok' }
}

async function defaultReadSnapshotBytes(path: string): Promise<Buffer | undefined> {
  return readFile(path).catch(() => undefined)
}

/**
 * One `gr:` spec (design §5.2/§5.3, fail closed): resolve the source in the
 * ACTIVE project, require a corpus-class registered path, confine the frozen
 * snapshot to the project state tree, verify its raw-byte hash, then bounds
 * check the line range against the SNAPSHOT text — the quote source is never
 * the live file and never model-supplied.
 */
async function verifyGrSpec(
  spec: SourceSpec,
  workspaceRoot: string,
  opts: VerifyOptions,
): Promise<VerifyOutcome> {
  const project = opts.projectSources === undefined
    ? undefined
    : await opts.projectSources().catch(() => undefined)
  if (project === undefined) return { status: 'invalid-marker', detail: GR_REASONS.noProject }
  const source = project.sources.find((candidate) => candidate.sourceId === spec.sourceId.slice(3))
  if (source === undefined) return { status: 'invalid-marker', detail: GR_REASONS.notFound }
  // §5.2: gr-citable ⇔ isWhitelistedRel(corpusPath), applied to the registered
  // ORIGINAL path — never to the snapshot copy, and never weakening the predicate.
  if (source.corpusPath === undefined || source.corpusPath.length === 0) {
    return { status: 'invalid-marker', detail: GR_REASONS.noCorpusPath }
  }
  if (!isWhitelistedRel(source.corpusPath)) return { status: 'invalid-marker', detail: GR_REASONS.nonCorpus }
  // `snapshotPath` is WORKSPACE-relative (§5.3), so it resolves against the
  // workspace root; the canonical project sources dir is the confining root.
  const sourcesReal = await realpath(join(workspaceRoot, '.dsh', 'vwa', project.projectId, 'sources')).catch(
    () => undefined,
  )
  if (sourcesReal === undefined) {
    return { status: 'invalid-marker', detail: `snapshot file is missing: ${source.snapshotPath}` }
  }
  const snapshotReal = await realpath(resolve(workspaceRoot, ...source.snapshotPath.split('/'))).catch(() => undefined)
  if (snapshotReal === undefined) {
    return { status: 'invalid-marker', detail: `snapshot file is missing: ${source.snapshotPath}` }
  }
  const inside = relative(sourcesReal, snapshotReal)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    return { status: 'invalid-marker', detail: GR_REASONS.escapes }
  }
  const readBytes = opts.readSnapshotBytes ?? defaultReadSnapshotBytes
  const bytes = await readBytes(snapshotReal).catch(() => undefined)
  if (bytes === undefined) {
    return { status: 'invalid-marker', detail: `snapshot file is unreadable: ${source.snapshotPath}` }
  }
  if (createHash('sha256').update(bytes).digest('hex') !== source.snapshotHash) {
    return { status: 'invalid-marker', detail: GR_REASONS.tampered }
  }
  const text = bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    return { status: 'invalid-marker', detail: `snapshot is not valid UTF-8: ${source.snapshotPath}` }
  }
  return lineRangeOutcome(text.split('\n'), spec, `gr:${source.sourceId}`)
}

/**
 * One source spec against one workspace root. The whitelist applies to the
 * REALPATH of the target: a `ws:../x.md`-style path whose realpath escapes
 * the workspace realpath is out-of-bounds (§4.2). A `gr:` spec takes the
 * snapshot-citation branch above and never touches the whitelist's live-file
 * path.
 */
export async function verifySpec(
  spec: SourceSpec,
  workspaceRoot: string,
  opts: VerifyOptions = {},
): Promise<VerifyOutcome> {
  if (spec.sourceId.startsWith('gr:')) return verifyGrSpec(spec, workspaceRoot, opts)
  const readLines = opts.readLines ?? defaultReadLines
  const rel = spec.sourceId.slice(3) // strip the `ws:` vocabulary prefix
  if (rel.length === 0 || isAbsolute(rel) || rel.includes('\\') || rel.split('/').includes('..')) {
    return { status: 'out-of-bounds', detail: `sourceId not a relative in-workspace path: ${spec.sourceId}` }
  }
  if (!isWhitelistedRel(rel)) {
    return { status: 'out-of-bounds', detail: `target outside the frozen whitelist (docs/**, *.md, *.mdx): ${rel}` }
  }
  const rootReal = await realpath(workspaceRoot).catch(() => workspaceRoot)
  const target = join(workspaceRoot, ...rel.split('/'))
  const targetReal = await realpath(target).catch(() => undefined)
  if (targetReal === undefined) {
    return { status: 'invalid-marker', detail: `source file does not exist: ${rel}` }
  }
  const relReal = relative(rootReal, targetReal)
  if (relReal === '' || relReal.startsWith('..') || isAbsolute(relReal) || relReal.includes(sep + '..')) {
    return { status: 'out-of-bounds', detail: `realpath escapes the workspace: ${rel}` }
  }
  if (!isWhitelistedRel(relReal.split(sep).join('/'))) {
    return { status: 'out-of-bounds', detail: `realpath outside the frozen whitelist: ${relReal}` }
  }
  const lines = await readLines(targetReal).catch(() => undefined)
  if (lines === undefined) {
    return { status: 'invalid-marker', detail: `source file unreadable: ${rel}` }
  }
  // Line range exists: 1-based, inclusive, and line <a> through <b> are real lines.
  return lineRangeOutcome(lines, spec, rel)
}

/**
 * Verify one claim's marker list: every spec of every parsed marker must
 * pass; the first failure's status wins. A claim with no markers is
 * `unmarked`; any unparsed marker is `invalid-marker`.
 */
export async function verifyClaim(
  specsPerMarker: SourceSpec[][],
  parsedFlags: boolean[],
  workspaceRoot: string,
  opts: VerifyOptions = {},
): Promise<VerifyOutcome> {
  if (parsedFlags.length === 0) {
    return { status: 'unmarked' }
  }
  if (parsedFlags.some(p => !p)) {
    return { status: 'invalid-marker', detail: 'malformed marker syntax' }
  }
  if (specsPerMarker.length === 0) {
    return { status: 'unmarked' }
  }
  for (const specs of specsPerMarker) {
    for (const spec of specs) {
      const outcome = await verifySpec(spec, workspaceRoot, opts)
      if (outcome.status !== 'marked-ok') return outcome
    }
  }
  return { status: 'marked-ok' }
}
