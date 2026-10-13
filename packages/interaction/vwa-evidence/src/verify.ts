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

import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ClaimStatus } from './receipt.ts'
import type { SourceSpec } from './marker.ts'

/** Corpus whitelist, frozen (§4.2): `docs/` prefix ∪ `*.md` ∪ `*.mdx` under the workspace. */
export function isWhitelistedRel(relPosix: string): boolean {
  return relPosix.startsWith('docs/') || /\.mdx?$/.test(relPosix)
}

export interface VerifyOptions {
  /** Filesystem surface, injectable for tests (defaults to node:fs/promises). */
  readLines?: (path: string) => Promise<string[]>
}

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

/**
 * One source spec against one workspace root. The whitelist applies to the
 * REALPATH of the target: a `ws:../x.md`-style path whose realpath escapes
 * the workspace realpath is out-of-bounds (§4.2).
 */
export async function verifySpec(
  spec: SourceSpec,
  workspaceRoot: string,
  opts: VerifyOptions = {},
): Promise<VerifyOutcome> {
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
  if (spec.lineStart < 1 || spec.lineEnd < spec.lineStart || spec.lineEnd > lines.length) {
    return {
      status: 'invalid-marker',
      detail: `line range L${spec.lineStart}-L${spec.lineEnd} does not exist in ${rel} (${lines.length} lines)`,
    }
  }
  return { status: 'marked-ok' }
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
