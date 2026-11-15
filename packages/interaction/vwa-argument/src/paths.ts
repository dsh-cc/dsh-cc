/**
 * Argument-layer path constants (design
 * `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §3.1/§8.1).
 *
 * Every VWA project path is relative to the **session workspace root**, not
 * the harness home: `<workspace>/.dsh/vwa/<projectId>/{drafts,sources,
 * reports,renders,retired,...}`. This module owns the argument-layer copies of
 * those constants; the draft-path predicates stay owned by `permission-rules`
 * (with the `vwa-evidence` restatement), whose `VWA_STATE_ROOT` and
 * `PROJECT_ID_RE` are re-exported here rather than duplicated (§8.1: no new
 * package, no inverted dependency).
 *
 * `Source.snapshotPath` is **stored data** and stays workspace-relative POSIX
 * (`.dsh/vwa/<projectId>/sources/<sourceId>.md`). Reads honor whatever value a
 * record carries — pre-migration v1 records still name
 * `docs/vwa-sources/<projectId>/<sourceId>.md` and keep resolving there until
 * the `--migrate` slice rewrites them (§8.1/§8.3); the legacy trees are never
 * written or removed by this layer.
 *
 * @module @dsh-cc/vwa-argument/paths
 */

import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PROJECT_ID_RE, VWA_STATE_ROOT } from '@dsh-cc/vwa-evidence'

export { PROJECT_ID_RE, VWA_STATE_ROOT }

/** Legacy v1 source-snapshot tree — read-only immutable history (§8.1). */
export const LEGACY_SOURCES_ROOT = 'docs/vwa-sources'

/** Legacy v1 report tree — read-only immutable history (§8.1). */
export const LEGACY_REPORTS_ROOT = 'docs/vwa-reports'

/** `src_<uuid>`, the id `sources.register` mints for a new source (sources.ts). */
const SOURCE_ID_PATTERN = 'src_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** `<sourceId>.md`, the only file name a source snapshot may take. */
const SOURCE_SNAPSHOT_FILE_RE = new RegExp(`^(${SOURCE_ID_PATTERN})\\.md$`)

/** Split a workspace-relative POSIX path into path segments (`''` for the root). */
function segmentsOf(relPosix: string): string[] {
  return relPosix.split('/').filter((segment) => segment !== '')
}

/** Whether an absolute (realpath-normalized) path is `tree` itself or inside it. */
export function isWithin(target: string, tree: string): boolean {
  const normalizedTarget = target.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedTree = tree.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalizedTarget === normalizedTree || normalizedTarget.startsWith(`${normalizedTree}/`)
}

/** Absolute VWA state root of a workspace: `<root>/.dsh/vwa` (§3.1). */
export function stateRoot(root: string): string {
  return join(root, ...segmentsOf(VWA_STATE_ROOT))
}

/**
 * Canonical VWA state root — `realpath(.dsh/vwa)` with a **lexical** fallback
 * for a tree that does not exist yet (§3.4). Classifying a resolved target
 * against the lexical join misses when `.dsh/vwa` is a symlink into the
 * workspace, so every containment test compares against this form.
 */
export function canonicalStateRoot(root: string): string {
  const lexical = stateRoot(root)
  try {
    return realpathSync(lexical)
  } catch {
    return lexical
  }
}

/** Canonical (or, for a not-yet-created tree, lexical) absolute path of a workspace-relative tree (§3.4). */
export function canonicalTree(root: string, relPosix: string): string {
  const lexical = resolve(root, ...segmentsOf(relPosix))
  try {
    return realpathSync(lexical)
  } catch {
    return lexical
  }
}

/**
 * The workspace trees a source may never be read from (D22): the VWA state
 * tree and the legacy output trees, each in canonical-or-lexical form (§3.4),
 * so a symlinked `.dsh/vwa` is classified by its destination. Reading a
 * snapshot or a report back as evidence would close a self-referential loop.
 */
export function runtimeOutputTrees(root: string): string[] {
  return [VWA_STATE_ROOT, LEGACY_SOURCES_ROOT, LEGACY_REPORTS_ROOT].map((rel) => canonicalTree(root, rel))
}

/** Whether an absolute (realpath-normalized) path lives under any D22 output tree (§3.4). */
export function isRuntimeOutputPath(root: string, absoluteRealpath: string): boolean {
  return runtimeOutputTrees(root).some((tree) => isWithin(absoluteRealpath, tree))
}

/** Absolute per-project state dir: `<root>/.dsh/vwa/<projectId>`. */
export function projectStateDir(root: string, projectId: string): string {
  return join(stateRoot(root), projectId)
}

/** Absolute per-project draft dir: `<root>/.dsh/vwa/<projectId>/drafts` (§3.1). */
export function projectDraftsDir(root: string, projectId: string): string {
  return join(projectStateDir(root, projectId), 'drafts')
}

/** Absolute per-project source-snapshot dir: `<root>/.dsh/vwa/<projectId>/sources` (§8.1). */
export function projectSourcesDir(root: string, projectId: string): string {
  return join(projectStateDir(root, projectId), 'sources')
}

/** Absolute per-project report dir: `<root>/.dsh/vwa/<projectId>/reports` (§8.1). */
export function projectReportsDir(root: string, projectId: string): string {
  return join(projectStateDir(root, projectId), 'reports')
}

/** Absolute per-project render-intent dir: `<root>/.dsh/vwa/<projectId>/renders` (§3.1). */
export function projectRendersDir(root: string, projectId: string): string {
  return join(projectStateDir(root, projectId), 'renders')
}

/** Absolute per-project retired dir: `<root>/.dsh/vwa/<projectId>/retired` (§3.1/§8.3). */
export function projectRetiredDir(root: string, projectId: string): string {
  return join(projectStateDir(root, projectId), 'retired')
}

/** The workspace-relative POSIX value `Source.snapshotPath` takes for a new source (§8.1). */
export function sourceSnapshotPath(projectId: string, sourceId: string): string {
  return `${VWA_STATE_ROOT}/${projectId}/sources/${sourceId}.md`
}

/** Absolute location of a new source snapshot (§8.1). */
export function sourceSnapshotAbsolute(root: string, projectId: string, sourceId: string): string {
  return join(projectSourcesDir(root, projectId), `${sourceId}.md`)
}

/**
 * Parse a workspace-relative snapshot path in the **v2** shape
 * (`.dsh/vwa/<projectId>/sources/<sourceId>.md`) into its parts. Legacy v1
 * paths (`docs/vwa-sources/…`) deliberately do not parse: they are read
 * verbatim through {@link resolveRecordedPath}, never interpreted.
 */
export function parseSourceSnapshotPath(
  relPosix: string,
): { projectId: string; sourceId: string } | undefined {
  const segments = segmentsOf(relPosix)
  if (segments.length !== 5) return undefined
  const [dsh, vwa, projectId, sources, file] = segments as [string, string, string, string, string]
  if (dsh !== '.dsh' || vwa !== 'vwa' || sources !== 'sources') return undefined
  if (!PROJECT_ID_RE.test(projectId)) return undefined
  const match = SOURCE_SNAPSHOT_FILE_RE.exec(file)
  if (match === null) return undefined
  return { projectId, sourceId: match[1]! }
}

/**
 * Resolve a **recorded** workspace-relative path (v2 or legacy v1) against the
 * workspace root. `snapshotPath` is stored data, so reads honor the value in
 * the record instead of recomputing it (§8.1).
 */
export function resolveRecordedPath(root: string, relPosix: string): string {
  return resolve(root, ...segmentsOf(relPosix))
}

/** Workspace-relative POSIX report path: `.dsh/vwa/<projectId>/reports/<artifactId>.review.{md,json}` (§8.1). */
export function reviewReportPath(projectId: string, artifactId: string, format: 'markdown' | 'json'): string {
  return `${VWA_STATE_ROOT}/${projectId}/reports/${artifactId}.review.${format === 'json' ? 'json' : 'md'}`
}
