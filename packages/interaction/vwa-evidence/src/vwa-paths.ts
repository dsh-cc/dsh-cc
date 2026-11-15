/**
 * VWA draft-path predicates for the evidence layer (design
 * `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §3.1/§3.2).
 *
 * This is a deliberate RESTATEMENT of the owner module in `permission-rules`:
 * `vwa-evidence` must not depend on `permission-rules` (that would invert the
 * layering — the rules engine sits above the evidence substrate). The shared
 * contract is the fixture corpus both packages assert in their own tests:
 * `packages/interaction/permission-rules/tests/fixtures/vwa-draft-paths.json`.
 * Change either matcher only together with that file.
 *
 * @module @dsh-cc/vwa-evidence/vwa-paths
 */

/** The workspace-relative VWA state root (`<workspace>/.dsh/vwa`). */
export const VWA_STATE_ROOT = '.dsh/vwa'

/** The batch scratch subtree — the one state tree that needs no draft file. */
export const VWA_BATCH_ROOT = '.dsh/vwa/batches'

/** Author-chosen draft name: 1..64 chars, no leading `.`/`-`/space. */
const DRAFT_NAME_PATTERN = '[a-z0-9][a-z0-9._-]{0,63}'

/** `prj_` + a hyphenated lowercase-hex uuid. */
const PROJECT_ID_PATTERN = 'prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** The one project-id parser every state path shares (§3.2). */
export const PROJECT_ID_RE = new RegExp(`^${PROJECT_ID_PATTERN}$`)

/** A draft **file**: `.dsh/vwa/<projectId>/drafts/<name>.md`. */
export const DRAFT_FILE_RE = new RegExp(`^\\.dsh/vwa/${PROJECT_ID_PATTERN}/drafts/${DRAFT_NAME_PATTERN}\\.md$`)

/** A draft **prefix** (grant `writePaths`): `.dsh/vwa/<projectId>/drafts(/**)?`. */
export const DRAFT_PREFIX_RE = new RegExp(`^\\.dsh/vwa/${PROJECT_ID_PATTERN}/drafts(/.*)?$`)

/** Whether a workspace-relative POSIX path is a draft FILE. */
export function isVwaDraftPath(relPosix: string): boolean {
  return DRAFT_FILE_RE.test(relPosix)
}

/** Whether a workspace-relative POSIX path is a drafts prefix. */
export function isVwaDraftPrefix(relPosix: string): boolean {
  return DRAFT_PREFIX_RE.test(relPosix)
}

/** The `prj_` project segment of a draft FILE path, or `undefined` (§5.4). */
export function vwaProjectIdOfDraft(relPosix: string): string | undefined {
  if (!DRAFT_FILE_RE.test(relPosix)) return undefined
  // .dsh / vwa / <projectId> / drafts / <name>.md
  return relPosix.split('/')[2]
}

/** Whether a workspace-relative path is the physical batches subtree. */
export function isVwaBatchPath(relPosix: string): boolean {
  return relPosix === VWA_BATCH_ROOT || relPosix.startsWith(`${VWA_BATCH_ROOT}/`)
}
