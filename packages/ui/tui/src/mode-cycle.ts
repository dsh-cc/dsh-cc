/**
 * Pure Shift+Tab cycle over CC permission-rule modes. Browser-safe and
 * harness-free so the cycle cannot drift from the `/permissions` list.
 * @module @dsh-cc/tui/mode-cycle
 */

import {
  PERMISSION_COMMAND_MODES,
  type PermissionCommandMode,
} from '@dsh-cc/command-permissions'

export { PERMISSION_COMMAND_MODES, type PermissionCommandMode }

/** Cycle order matches `/permissions` advertisement. */
export const PERMISSION_CYCLE: readonly PermissionCommandMode[] = PERMISSION_COMMAND_MODES

/**
 * Advance one step in the CC permission-mode cycle.
 * @param current - the mode currently in force.
 * @param bypassDisabled - when true, `bypassPermissions` is skipped.
 * @returns the next mode (wraps to the first).
 */
export function nextPermissionMode(
  current: string,
  bypassDisabled = false,
): PermissionCommandMode {
  const list = bypassDisabled
    ? PERMISSION_CYCLE.filter(mode => mode !== 'bypassPermissions')
    : PERMISSION_CYCLE
  const index = list.indexOf(current as PermissionCommandMode)
  if (index === -1) return list[0] ?? 'default'
  return list[(index + 1) % list.length] ?? 'default'
}

/**
 * Whether `mode` is one of the advertised CC permission modes.
 * @param mode - untrusted user input.
 */
export function isPermissionMode(mode: string): mode is PermissionCommandMode {
  return (PERMISSION_CYCLE as readonly string[]).includes(mode)
}
