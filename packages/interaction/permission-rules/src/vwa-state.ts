/**
 * §3.7 hardening of a pre-existing hole: `.dsh/vwa/**` is authoritative VWA
 * state (adjudications.json, signatures.json, revisions/, evaluations/ …) and
 * a plain Edit/Write of it would let the agent forge human adjudication. The
 * default is ASK — not deny, so a human can still approve a legitimate
 * one-off — with exactly two carve-outs (§3.3):
 *
 * - `.dsh/vwa/batches/**` — the physical batch scratch subtree (§3.2's
 *   writePaths exclusion), matched on the RESOLVED path so a batches symlink
 *   cannot launder an authoritative subtree into exempt scratch;
 * - draft FILES — `.dsh/vwa/<projectId>/drafts/<name>.md` (§3.2
 *   `DRAFT_FILE_RE`), the agent's editing surface. A drafts path that is not a
 *   draft file (nested, non-`.md`, wrong project shape) stays authoritative
 *   state, and the exemption is keyed on `realpath(target)` relativized to the
 *   canonical state root, so a draft-file symlink to `adjudications.json` asks.
 *
 * The VWA tools write through fs directly and are unaffected.
 *
 * @module @dsh-cc/permission-rules/vwa-state
 */

import { join, resolve } from 'node:path'
import { isPathWithin, normalizePath } from './task-grant.ts'
import { VWA_STATE_ROOT, isVwaBatchPath, isVwaDraftPath, relativeToStateRoot } from './vwa-paths.ts'

/** The ask reason surfaced for an unexempted VWA state write. */
export const VWA_STATE_ASK_REASON =
  'writes under .dsh/vwa are authoritative VWA state (use the VWA tools); only .dsh/vwa/batches/** and .dsh/vwa/<projectId>/drafts/** are writable directly'

/** The canonical state root of one workspace root (`realpath(.dsh/vwa)`). */
export function vwaStateRootOf(normalizedRoot: string): string {
  return normalizePath(join(normalizedRoot, VWA_STATE_ROOT))
}

/**
 * The workspace-relative POSIX form of a target inside the state tree, or
 * `undefined` when it is not state at all. Anchored on the canonical state
 * root, so an aliased `.dsh/vwa` still classifies its members (§3.4).
 * @param normalizedTarget - the canonical (realpath-normalized) absolute target.
 * @param normalizedRoot - the canonical workspace root.
 */
export function relativeStatePath(normalizedTarget: string, normalizedRoot: string): string | undefined {
  return relativeToStateRoot(normalizedTarget, vwaStateRootOf(normalizedRoot))
}

/** Shared canonical-path boundary for grant matching and the approval guard. */
export function isCanonicalVwaStateWrite(normalizedTarget: string, normalizedRoot: string): boolean {
  const stateRoot = vwaStateRootOf(normalizedRoot)
  if (!isPathWithin(stateRoot, normalizedTarget)) return false
  const rel = relativeToStateRoot(normalizedTarget, stateRoot)
  // Containment already held, so an unrelativizable path is state, not scratch.
  if (rel === undefined) return true
  return !isVwaBatchPath(rel) && !isVwaDraftPath(rel)
}

/**
 * Whether a file-write target lands in authoritative VWA state.
 * @param target - the call's `file_path` / `notebook_path` (absolute or root-relative).
 * @param root - the session workspace root (no root ⇒ nothing to scope to).
 * @returns true when the write needs approval.
 */
export function isVwaStateWrite(target: string, root: string | undefined): boolean {
  if (root === undefined || root === '') return false
  const normalized = normalizePath(resolve(root, target))
  return isCanonicalVwaStateWrite(normalized, normalizePath(root))
}
