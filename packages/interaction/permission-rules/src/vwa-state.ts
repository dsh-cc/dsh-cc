/**
 * §3.7 hardening of a pre-existing hole: `.dsh/vwa/**` is authoritative VWA
 * state (adjudications.json, signatures.json, revisions/, evaluations/ …) and
 * a plain Edit/Write of it would let the agent forge human adjudication. The
 * default is ASK — not deny, so a human can still approve a legitimate
 * one-off — with exactly `.dsh/vwa/batches/**` exempt (§3.2's writePaths
 * exclusion). `current-project.json` is included (not exempt).
 *
 * The VWA tools write through fs directly and are unaffected.
 *
 * @module @dsh-cc/permission-rules/vwa-state
 */

import { join, resolve } from 'node:path'
import { isPathWithin, normalizePath, VWA_BATCH_ROOT, VWA_STATE_ROOT } from './task-grant.ts'

/** The ask reason surfaced for an unexempted VWA state write. */
export const VWA_STATE_ASK_REASON =
  'writes under .dsh/vwa are authoritative VWA state (use the VWA tools); only .dsh/vwa/batches/** is writable directly'

/**
 * Whether a file-write target lands in authoritative VWA state.
 * @param target - the call's `file_path` / `notebook_path` (absolute or root-relative).
 * @param root - the session workspace root (no root ⇒ nothing to scope to).
 * @returns true when the write needs approval.
 */
export function isVwaStateWrite(target: string, root: string | undefined): boolean {
  if (root === undefined || root === '') return false
  const normalized = normalizePath(resolve(root, target))
  const stateRoot = normalizePath(join(root, VWA_STATE_ROOT))
  if (!isPathWithin(stateRoot, normalized)) return false
  const batchRoot = normalizePath(join(root, VWA_BATCH_ROOT))
  return !isPathWithin(batchRoot, normalized)
}
