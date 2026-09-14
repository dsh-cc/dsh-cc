/**
 * Resume-time worktree identity verification (WS-5 item 2 of
 * docs/plans/2026-09-14-cc-worktree-parity.md): a stored session cwd under a
 * `.claude/worktrees/` convention directory is verified to still be a linked
 * worktree of the SAME repository before the TUI follows it. The git-identity
 * checks reuse the WS-1 adoption gate (`adoptionRefusal` in tool-git-worktree);
 * the resume-specific additions are the network-path refusal, the
 * ancestor-of-launch-dir refusal, and the symlink refusal.
 *
 * Everything is fail-open: infrastructure errors degrade to `unverified`,
 * which the guard surfaces as a notice and stays in the launch directory —
 * the true fallback (resume into the launch dir + clear the binding) needs
 * the upstream `resume({ meta })` seam (plan §11.3).
 *
 * @module @dsh-cc/tui/harness/worktree-identity
 */

import { lstatSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { adoptionRefusal } from '@dsh-cc/tool-git-worktree'

/** Outcome of verifying a stored cwd before following it on resume. */
export type WorktreeIdentityVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'unverified' }

/** Convention-directory marker every launcher/EnterWorktree tree sits under. */
const CONVENTION_MARKER = `${sep}.claude${sep}worktrees${sep}`

/**
 * Verify a stored cwd. Non-convention cwds (the main checkout, arbitrary
 * directories) pass after the plain existence check — only worktree-shaped
 * cwds get the identity treatment.
 */
export function worktreeIdentityVerdict(cwd: string, launchCwd: string): WorktreeIdentityVerdict {
  let dir: string
  try {
    dir = resolve(cwd)
  } catch {
    return { kind: 'unverified' }
  }
  // Network-path spellings are never ours: UNC prefixes and macOS /net mounts.
  // Checked before any fs access so a hung mount cannot stall the guard.
  if (dir.startsWith('//') || dir.startsWith('\\\\') || dir === '/net' || dir.startsWith('/net/')) {
    return { kind: 'refused', reason: 'its path is a network mount' }
  }
  try {
    if (lstatSync(dir).isSymbolicLink()) {
      return { kind: 'refused', reason: `its path is a symlink (${dir})` }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'unverified' }
  }
  const at = dir.indexOf(CONVENTION_MARKER)
  if (at <= 0) return { kind: 'ok' }
  const mainRoot = dir.slice(0, at)
  // The worktree must not contain the launch directory (adoptionRefusal's
  // contains-main-checkout gate, resampled against where the TUI runs).
  const rel = relative(dir, resolve(launchCwd))
  if (rel === '' || !rel.startsWith(`..${sep}`)) {
    return { kind: 'refused', reason: 'it contains the launch directory' }
  }
  // WS-1 adoption gate: .git entry shape + registration under
  // `<mainRoot>/.git/worktrees/` (plain clones, core.worktree redirects and
  // foreign registrations refuse). Unreadable metadata degrades to
  // `unverified` — CC's could-not-verify class, retryable.
  const refusal = adoptionRefusal(dir, mainRoot)
  if (refusal === null) return { kind: 'ok' }
  if (refusal.includes('unreadable')) return { kind: 'unverified' }
  return { kind: 'refused', reason: refusal }
}
