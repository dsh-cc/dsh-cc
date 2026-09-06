/**
 * Plugin-facing settings/config shapes for the permission-rule engine: the
 * local `permissions` section schema (hand-mirroring the shared cascade
 * schemas — no cross-package dependency), the Config-provided rule set, and
 * the plugin Config schema. Kept separate from the service so the plugin
 * entry stays under the file-size gate.
 *
 * @module @dsh-cc/permission-rules/settings-schema
 */

import z from '@deepseek-ai/schemastery'
import { PERMISSION_MODES, SOURCE_PRIORITY, type PermissionMode, type PermissionRuleSource } from './types.ts'
import type { AutoModeSettings } from './auto-stage.ts'

/** The settings section resolved from the settings document. */
export interface PermissionSettings {
  /** Whole-tool or content rules that allow matching calls. */
  allow?: string[]
  /** Whole-tool or content rules that deny matching calls. */
  deny?: string[]
  /** Whole-tool or content rules that route matching calls to approval. */
  ask?: string[]
  /** Default permission mode for sessions without a recorded override. */
  defaultMode?: PermissionMode
  /** `'disable'` turns off the ability to switch to `bypassPermissions`. */
  disableBypassPermissionsMode?: 'disable'
  /** Additional directories included in the permission scope (escape-check base). */
  additionalDirectories?: string[]
  /** Protected file wildcard patterns — writes to them are high risk. */
  protectedFiles?: string[]
  /** Raw dangerous-command regex sources replacing the curated defaults. */
  dangerousPatterns?: string[]
  /**
   * Optional LLM risk-classifier configuration for `auto` mode (hand-mirrors
   * the shared `AutoModeSchema`): `soft_deny` prose list plus a `classifier`
   * sub-object. Absent ⇒ the stage stays disarmed (no defaults materialized).
   */
  autoMode?: AutoModeSettings
}

/** The Config-provided rule set: strings parsed as source-`config` rules. */
export interface ConfigRules {
  /** Allow rules. */
  allow?: string[]
  /** Deny rules. */
  deny?: string[]
  /** Ask rules. */
  ask?: string[]
  /**
   * Bypass-immune deny rules (e.g. `.git` internals, shell-config paths):
   * enforced through the monotonic guard layer, never overridable by a mode
   * switch or `bypassPermissions`.
   */
  bypassImmune?: string[]
}

/** Plugin config. All optional; the schema applies the defaults shown. */
export interface Config {
  /**
   * The rule set provided directly by composition, parsed with source
   * `config`. Merged with the optional settings section by source priority
   * (settings rules win).
   */
  rules?: ConfigRules
  /** Settings namespace holding allow/deny/ask/defaultMode; defaults to `permissions`. */
  settingsNamespace?: string
  /**
   * The source label applied to settings-resolved rules; defaults to
   * `userSettings`. Lets a deployment attribute settings rules to a different
   * settings layer (project/local/…).
   */
  settingsSource?: PermissionRuleSource
  /** Default mode for sessions without an in-memory mode override; defaults to `default`. */
  defaultMode?: PermissionMode
  /** Tool name treated as the shell-command tool for content extraction; defaults to `Bash`. */
  bashToolName?: string
  /** File-edit tool names auto-allowed under `acceptEdits` mode. */
  fileEditTools?: string[]
  /** Read-only tool names auto-allowed under `plan` mode. */
  readOnlyTools?: string[]
  /**
   * Skip a whole-tool `ask` for a sandboxed (confining, non-full-access)
   * `Bash` call — allow instead. Defaults to `false`.
   */
  exemptSandboxedBashFromToolAsk?: boolean
  /** Whether `bypassPermissions` mode is disabled (falls back to `default`). */
  disableBypassPermissionsMode?: boolean
  /**
   * Whether the risk-classifier escalation stage runs inside the decision
   * flow (catastrophic commands hard-deny; protected/out-of-scope file writes
   * ask unless under `bypassPermissions`). Defaults to `true`.
   */
  classifierEnabled?: boolean
}

/** The standard file-edit tool set, applied when {@link Config.fileEditTools} is omitted. */
export const DEFAULT_FILE_EDIT_TOOLS = ['edit', 'write', 'multi_edit', 'notebook_edit', 'str_replace_editor']

/** The standard read-only tool set, applied when {@link Config.readOnlyTools} is omitted. */
export const DEFAULT_READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'search', 'web_fetch', 'web_search']

/** The classifier sub-object schema: defaults apply only when the object is present. */
const autoModeClassifierSchema = z.object({
  enabled: z.boolean().default(false),
  route: z.string().default('haiku'),
  timeoutMs: z.number().default(8000),
  cacheMaxEntries: z.number().default(256),
})

/** The shared settings schema (Config-facing and settings-provider-facing). */
export function permissionSettingsSchema(): z<PermissionSettings> {
  return z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    ask: z.array(z.string()),
    defaultMode: z.union(PERMISSION_MODES as PermissionMode[]),
    disableBypassPermissionsMode: z.union(['disable'] as const),
    additionalDirectories: z.array(z.string()),
    protectedFiles: z.array(z.string()),
    dangerousPatterns: z.array(z.string()),
    // Union with `undefined` keeps an absent `autoMode` key absent — no
    // defaults materialized, the classifier stays disarmed (mirrors the
    // shared AutoModeSchema union-with-undefined idiom).
    autoMode: z.union([
      z.object({
        soft_deny: z.union([z.array(z.string()), z.const(undefined)]),
        classifier: z.union([autoModeClassifierSchema, z.const(undefined)]),
      }),
      z.const(undefined),
    ]),
  }) as unknown as z<PermissionSettings>
}

/** The plugin Config schema (defaults applied by schemastery). */
export const ConfigSchema: z<Config> = z.object({
  rules: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
    ask: z.array(z.string()),
    bypassImmune: z.array(z.string()),
  }),
  settingsNamespace: z.string().default('permissions'),
  settingsSource: z.union(SOURCE_PRIORITY as PermissionRuleSource[]).default('userSettings'),
  defaultMode: z.union(PERMISSION_MODES as PermissionMode[]).default('default'),
  bashToolName: z.string().default('Bash'),
  fileEditTools: z.array(z.string()).default(DEFAULT_FILE_EDIT_TOOLS),
  readOnlyTools: z.array(z.string()).default(DEFAULT_READ_ONLY_TOOLS),
  exemptSandboxedBashFromToolAsk: z.boolean().default(false),
  disableBypassPermissionsMode: z.boolean().default(false),
  classifierEnabled: z.boolean().default(true),
})
