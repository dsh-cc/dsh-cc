/**
 * Canonical VWA draft-path predicates (design
 * `docs/plans/2026-11-15-vwa-autonomous-render-pipeline.md` §3.1/§3.2).
 *
 * The v2 state tree is `<workspace>/.dsh/vwa/<projectId>/` and the agent's new
 * editing surface is `drafts/<name>.md` beside it. `projectId` is a variable
 * segment, so a fixed-prefix containment test cannot express the drafts
 * exemption: one project parser plus two predicates do.
 *
 * - {@link isVwaDraftPath} — a draft **file** (the write exemption, §3.3).
 * - {@link isVwaDraftPrefix} — a grant **writePath** prefix (§3.2: grant
 *   `writePaths` are prefixes, so the file shape alone cannot validate them).
 *
 * Every predicate takes a **workspace-relative POSIX path**. The absolute
 * call sites (`vwa-state.ts`, `task-grant-match.ts`, `task-grant-service.ts`)
 * resolve the target first (`normalizePath`) and then relativize it with
 * {@link relativeToStateRoot}, so a symlink can never claim the exemption for
 * its lexical name — only for its physical destination.
 *
 * `vwa-evidence` restates these shapes in its own module (it must not depend
 * on `permission-rules`, which would invert the layering). Both packages load
 * one shared fixture corpus —
 * `packages/interaction/permission-rules/tests/fixtures/vwa-draft-paths.json`
 * — and assert identical verdicts. The fixture is the contract.
 *
 * @module @dsh-cc/permission-rules/vwa-paths
 */

/** The workspace-relative VWA state root (`<workspace>/.dsh/vwa`). */
export const VWA_STATE_ROOT = '.dsh/vwa'

/** The only VWA state subtree that needs no draft file (batch scratch space). */
export const VWA_BATCH_ROOT = '.dsh/vwa/batches'

/** Author-chosen draft name: 1..64 chars, leading `.`/`-`/space never legal. */
const DRAFT_NAME_PATTERN = '[a-z0-9][a-z0-9._-]{0,63}'

/** `prj_` + a hyphenated lowercase-hex uuid — what `prj_${randomUUID()}` mints. */
const PROJECT_ID_PATTERN = 'prj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** The one project-id parser every state path shares (§3.2). */
export const PROJECT_ID_RE = new RegExp(`^${PROJECT_ID_PATTERN}$`)

/** A draft **file**: `.dsh/vwa/<projectId>/drafts/<name>.md`. */
export const DRAFT_FILE_RE = new RegExp(`^\\.dsh/vwa/${PROJECT_ID_PATTERN}/drafts/${DRAFT_NAME_PATTERN}\\.md$`)

/** A draft **prefix** (grant `writePaths`): `.dsh/vwa/<projectId>/drafts(/**)?`. */
export const DRAFT_PREFIX_RE = new RegExp(`^\\.dsh/vwa/${PROJECT_ID_PATTERN}/drafts(/.*)?$`)

/** Whether a workspace-relative POSIX path is a draft FILE (`.dsh/vwa/<pid>/drafts/<name>.md`). */
export function isVwaDraftPath(relPosix: string): boolean {
  return DRAFT_FILE_RE.test(relPosix)
}

/**
 * Whether a root-relative path is a drafts prefix — the drafts directory of a
 * well-formed project or anything below it. This is the shape a grant
 * `writePath` takes; a draft file is a member of its project's prefix.
 */
export function isVwaDraftPrefix(relPosix: string): boolean {
  return DRAFT_PREFIX_RE.test(relPosix)
}

/**
 * The `prj_` project segment of a draft FILE path, or `undefined` when the
 * path is not one. Never read from `current-project.json` (§5.4).
 */
export function vwaProjectIdOfDraft(relPosix: string): string | undefined {
  if (!DRAFT_FILE_RE.test(relPosix)) return undefined
  // .dsh / vwa / <projectId> / drafts / <name>.md
  return relPosix.split('/')[2]
}

/** Whether a root-relative path is the state root itself or anywhere under it. */
export function isVwaStatePath(relPosix: string): boolean {
  return relPosix === VWA_STATE_ROOT || relPosix.startsWith(`${VWA_STATE_ROOT}/`)
}

/** Whether a root-relative path is the physical batches subtree (or the root of it). */
export function isVwaBatchPath(relPosix: string): boolean {
  return relPosix === VWA_BATCH_ROOT || relPosix.startsWith(`${VWA_BATCH_ROOT}/`)
}

/**
 * Relativize an absolute, already-realpath-normalized target onto the
 * canonical state root, producing the workspace-relative POSIX form the
 * predicates above take.
 *
 * The second argument is the **canonical** state root — `normalizePath(join(
 * workspaceRoot, VWA_STATE_ROOT))`, i.e. `realpath(.dsh/vwa)` — not the
 * lexical `.dsh/vwa` join: when `.dsh/vwa` is a symlink to a workspace
 * directory, the resolved target names the destination, and only the resolved
 * root can classify it (§3.4). A target outside the state root yields
 * `undefined` (the write is not VWA state at all).
 * @param absoluteRealpath - the canonical absolute target (`normalizePath`).
 * @param canonicalStateRoot - `normalizePath(join(root, VWA_STATE_ROOT))`.
 * @returns `.dsh/vwa[/…]` or `undefined` when the target is outside it.
 */
export function relativeToStateRoot(absoluteRealpath: string, canonicalStateRoot: string): string | undefined {
  const target = absoluteRealpath.replace(/\\/g, '/')
  const root = canonicalStateRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  if (target === root) return VWA_STATE_ROOT
  if (!target.startsWith(`${root}/`)) return undefined
  return `${VWA_STATE_ROOT}/${target.slice(root.length + 1)}`
}
