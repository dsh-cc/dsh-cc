/**
 * Claude Code-compatible `permissions` field schema, exported as a standalone
 * value so the permission-rule engine (B2) and the settings cascade share one
 * definition of the settings.json `permissions` shape.
 * @module @dsh-cc/settings-cascade/permissions
 */

import z from '@deepseek-ai/schemastery'

/** A single permission rule — a tool-scoped match string, e.g. `Bash(npm run *)`. */
export const PermissionRuleSchema: z<string> = z.string()

/** `defaultMode` values — the default permission mode when a tool needs access. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/** The settings.json `permissions` section, matching Claude Code's schema. */
export interface Permissions {
  /** Tool operations allowed without prompting. */
  allow?: string[]
  /** Tool operations always blocked. */
  deny?: string[]
  /** Tool operations that always prompt for confirmation. */
  ask?: string[]
  /** Default permission mode when a tool needs access. */
  defaultMode?: PermissionMode
  /** `'disable'` turns off the ability to bypass permission prompts. */
  disableBypassPermissionsMode?: 'disable'
  /** Additional directories included in the permission scope. */
  additionalDirectories?: string[]
  /** Protected file wildcard patterns — file writes to them are high risk. */
  protectedFiles?: string[]
  /** Raw dangerous-command regex sources for the risk classifier. */
  dangerousPatterns?: string[]
}

/**
 * Schemastery schema for the `permissions` section. Unknown fields pass
 * through unmodified, matching Claude Code's passthrough behavior.
 */
export const PermissionsSchema: z<Permissions> = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
  ask: z.array(z.string()),
  defaultMode: z.union(PERMISSION_MODES),
  disableBypassPermissionsMode: z.union(['disable']),
  additionalDirectories: z.array(z.string()),
  protectedFiles: z.array(z.string()),
  dangerousPatterns: z.array(z.string()),
})
