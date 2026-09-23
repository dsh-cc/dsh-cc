/**
 * Shared pure predicates/constants for settings-cascade (extracted from
 * index.ts for the file-size budget). No behavior change.
 * @module @dsh-cc/settings-cascade/shared-guards
 */

/** Whether a value is a plain data object (not an array, null, or instance). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Whether a filesystem error simply means the file is absent. */
export function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** Whether a filesystem error is a permission denial (EACCES/EPERM). */
export function isAccessDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM'
}

/** Optimistic-retry bound for persist: how many read-check-write rounds before failing loud. */
export const MAX_PERSIST_ATTEMPTS = 5
