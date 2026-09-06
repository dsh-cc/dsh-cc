/**
 * Team memory: an opt-in shared per-project memory directory layered on the
 * private memdir. Provides the team path resolution, the dual-directory
 * (private + team) merged prompt, and a seam-native read/write path validation
 * chain so a relative key cannot escape the team directory.
 *
 * Security model (three hard prerequisites, all enforced before any read or
 * write):
 * 1. **Key sanitization** — a pure string pass (`sanitizePathKey`) run before
 *    any filesystem operation rejects null bytes, URL-encoded traversal, NFKC
 *    normalization differences, backslashes, and absolute keys.
 * 2. **Seam-native validation chain** — for the sanitized key: `fs.lstat`
 *    rejects a final-segment symlink, then `fs.resolve` + `fs.contains`
 *    enforce prefix containment against the resolved team root.
 * 3. **Containment on every access** — reads and writes go through the chain,
 *    so a symlinked intermediate component that points outside is caught by
 *    the resolve + contains step.
 *
 * Residual gap (documented): this closes per-access traversal, but a
 * mutate-between-check TOCTOU window on *intermediate* components is not fully
 * closed — only the final segment is lstat-checked, and the resolve/contains
 * check and the read are not atomic. Do not enable `teamEnabled` in multi-tenant
 * or untrusted-writer deployments.
 * @module @dsh-cc/memory/team
 */

import { join } from 'node:path'
import type { FileSystem, FsTarget } from '@deepseek-ai/dsh-fs'

/** Error thrown when a team-memory key/path fails security validation. */
export class TeamMemoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TeamMemoryError'
  }
}

/** Default subdirectory of the memory home holding team memory. */
export const TEAM_MEMORY_DIR = 'team'

/**
 * The team memory entrypoint filename, matching the private entrypoint.
 * Each directory (private and team) keeps its own MEMORY.md index.
 */
export const TEAM_ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * Sanitize a relative path key by rejecting dangerous patterns, mirroring the
 * Claude Code `sanitizePathKey` semantics. Pure string — run this before any
 * filesystem operation. Returns the sanitized key unchanged or throws
 * {@link TeamMemoryError}. Rejects:
 * - null bytes (can truncate paths in C-based syscalls)
 * - URL-encoded traversal (`%2e%2e%2f` → `../`)
 * - NFKC normalization that collapses to `..` / separators (fullwidth `．．／`)
 * - backslashes (Windows separator used as a traversal vector)
 * - absolute paths
 * @param key - the relative path key under the team directory.
 * @returns the sanitized key (unchanged).
 */
export function sanitizePathKey(key: string): string {
  if (key.length === 0) {
    throw new TeamMemoryError('Empty path key')
  }
  // Null bytes can truncate paths in C-based syscalls.
  if (key.includes('\0')) {
    throw new TeamMemoryError(`Null byte in path key: "${key}"`)
  }
  // URL-encoded traversals (e.g. %2e%2e%2f = ../).
  let decoded: string
  try {
    decoded = decodeURIComponent(key)
  } catch {
    // Malformed percent-encoding (e.g. %ZZ, lone %) — not valid URL-encoding,
    // so no URL-encoded traversal is possible.
    decoded = key
  }
  if (decoded !== key && (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\'))) {
    throw new TeamMemoryError(`URL-encoded traversal in path key: "${key}"`)
  }
  // Unicode normalization attacks: fullwidth ．．／ normalize to ASCII ../ under
  // NFKC. Reject for defense-in-depth even though a literal-fs backend treats
  // these as bytes, not separators.
  const normalized = key.normalize('NFKC')
  if (
    normalized !== key &&
    (normalized.includes('..') ||
      normalized.includes('/') ||
      normalized.includes('\\') ||
      normalized.includes('\0'))
  ) {
    throw new TeamMemoryError(`Unicode-normalized traversal in path key: "${key}"`)
  }
  // Reject backslashes (Windows path separator used as a traversal vector).
  if (key.includes('\\')) {
    throw new TeamMemoryError(`Backslash in path key: "${key}"`)
  }
  // Reject absolute paths.
  if (key.startsWith('/')) {
    throw new TeamMemoryError(`Absolute path key: "${key}"`)
  }
  return key
}

/**
 * Resolve the team memory directory for one workspace. Team memory is shared
 * by all users of THE PROJECT, so it lives inside the workspace's private
 * memory directory: `<workspaceDir>/team`. (Before per-workspace isolation it
 * sat at the global `<memoryHome>/team`; that directory is now inert.)
 * @param workspaceDir - the workspace's private memory directory.
 * @returns the team directory path (`<workspaceDir>/team`).
 */
export function resolveTeamMemoryRoot(workspaceDir: string): string {
  return join(workspaceDir, TEAM_MEMORY_DIR)
}

/**
 * The seam-native team path validation chain. For a relative key under a team
 * directory, enforce, in order:
 * 1. `sanitizePathKey` — pure-string rejection (no fs access).
 * 2. `fs.lstat` — reject a final-segment symlink before following it.
 * 3. `fs.resolve` of both the team root and the candidate, then `fs.contains`
 *    — reject when the resolved candidate escapes the resolved team root.
 *
 * Throws {@link TeamMemoryError} when any step fails. A missing file is not an
 * error here: the resolve+contains step still spans the nearest existing
 * ancestor (realpath), so a missing child under an escaping symlinked ancestor
 * is still caught.
 * @param fs - the contiguous filesystem seam.
 * @param teamDir - the resolved team directory path.
 * @param relativeKey - the sanitizable relative key to validate.
 * @returns the resolved, contained {@link FsTarget} for the candidate.
 */
export async function validateTeamMemKey(
  fs: FileSystem,
  teamDir: string,
  relativeKey: string,
): Promise<FsTarget> {
  sanitizePathKey(relativeKey)
  const fullPath = join(teamDir, relativeKey)

  // Step 2: reject a final-segment symlink.
  const pathInfo = await fs.lstat(fullPath)
  if (pathInfo !== undefined && pathInfo.type === 'symlink') {
    throw new TeamMemoryError(`Symlink at final path segment: "${relativeKey}"`)
  }

  // Step 3: resolve + prefix containment.
  const candidate = await fs.resolve(fullPath)
  const teamRoot = await fs.resolve(teamDir)
  if (!fs.contains(teamRoot, candidate)) {
    throw new TeamMemoryError(`Path escapes team memory directory: "${relativeKey}"`)
  }
  return candidate
}

/**
 * Validate and read a team memory file body, or `undefined` when the file is
 * absent. The read only proceeds when {@link validateTeamMemKey} passes, so a
 * traversal or symlink-escape key never reaches the read.
 * @param fs - the contiguous filesystem seam.
 * @param teamDir - the resolved team directory path.
 * @param relativeKey - the sanitizable relative key to read.
 * @param signal - optional cancellation.
 * @returns the file body, or `undefined` if absent.
 */
export async function readTeamMemFile(
  fs: FileSystem,
  teamDir: string,
  relativeKey: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const target = await validateTeamMemKey(fs, teamDir, relativeKey)
  try {
    return await fs.readText(target, signal)
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && 'code' in error
    && ((error as { code?: string }).code === 'FS_NOT_FOUND'
      || (error as { code?: string }).code === 'ENOENT')
}
