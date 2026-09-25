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

/** `permissions.autoMode.classifier` — the plugin-local hand-mirror of the shared AutoModeClassifierSchema. */
export interface AutoModeClassifierSettings {
  /** Master switch for the LLM risk classifier stage (default `false`). */
  enabled?: boolean
  /**
   * Explicit model route used for classification. When set, it WINS over
   * `backend` verbatim (including `gauge`); when unset, the route policy
   * picks `gauge` when armed (backend `'auto'` + a configured System One
   * gauge alias) and `'haiku'` otherwise. No schema default — absence is
   * preserved and the policy helper decides (default `'haiku'`).
   */
  route?: string
  /**
   * Backend selection when `route` is unset (default `'haiku'` at
   * consumption): `'haiku'` always uses the chat classifier; `'auto'` arms
   * the gauge System One lane when the gauge alias is configured with the
   * systemone protocol.
   */
  backend?: 'haiku' | 'auto'
  /**
   * System One gauge allow-gate threshold, 0–1 (only consulted by the
   * System One adapter; the consumption default lives in the adapter's
   * constant). Absence-preserving.
   */
  gaugeAllowThreshold?: number
  /**
   * Fix B: fold user-originated allow evidence (settings rules + session
   * grants) into the gauge verdict question. Absence-preserving; the gauge
   * stage consumes a default of `true` (`false` is the kill switch).
   */
  gaugeAllowEvidence?: boolean
  /** Per-call timeout in milliseconds (default `8000`). */
  timeoutMs?: number
  /** Verdict cache size in entries (default `256`). */
  cacheMaxEntries?: number
  /**
   * D13 reconsider pass (default FALSE, absence-preserving): a non-failure
   * `ask` verdict earns ONE reconsider call; only ask→allow is possible.
   */
  secondPass?: boolean
  /**
   * D10/S5 full-text audit (default FALSE, absence-preserving): when true,
   * `permission/classifier` audit events carry the raw rendered input
   * (≤8192 chars by construction) in addition to the digest.
   */
  auditFullText?: boolean
}

/** `permissions.autoMode.probe` — the plugin-local hand-mirror of the shared AutoModeProbe schema (S7/W3). */
export interface AutoModeProbeSettings {
  /** Master switch for the input-layer PI probe (default `true`). */
  enabled?: boolean
  /**
   * Explicit model route used for the probe. When set, it WINS over
   * `backend` verbatim (including `gauge`); when unset, the route policy
   * picks `gauge` when armed (backend `'auto'` + a configured System One
   * gauge alias) and `'haiku'` otherwise. No schema default — absence is
   * preserved and the policy helper decides (default `'haiku'`).
   */
  route?: string
  /**
   * Backend selection when `route` is unset (default `'haiku'` at
   * consumption): `'haiku'` always uses the chat probe lane; `'auto'` arms
   * the gauge System One lane when the gauge alias is configured with the
   * systemone protocol.
   */
  backend?: 'haiku' | 'auto'
  /** Per-call timeout in milliseconds (default `5000`). */
  timeoutMs?: number
  /** Scan-set override (exact tool names or trailing-`*` prefix patterns); replaces the default set entirely. */
  toolPatterns?: string[]
}

/** `permissions.autoMode` — the plugin-local hand-mirror of the shared AutoModeSchema. */
export interface AutoModeSettings {
  /**
   * Soft-deny hints evaluated by the classifier, in CC's snake_case spelling.
   * `$defaults` expansion happens at consumption time — the schema never
   * expands it.
   */
  soft_deny?: string[]
  /**
   * Unconditional hard-deny prose (S4/D4): a classifier `deny` must cite one
   * of these EXACTLY or it downgrades to `ask`. In CC's snake_case spelling;
   * `$defaults` expansion happens at consumption time.
   */
  hard_deny?: string[]
  /**
   * Allow-exception prose evaluated after the soft-deny rules (S2), in CC's
   * snake_case spelling. `$defaults` expansion happens at consumption time —
   * the schema never expands it.
   */
  allow?: string[]
  /**
   * Environment trust-boundary prose (S2): what the classifier treats as
   * in-scope. `$defaults` expansion happens at consumption time.
   */
  environment?: string[]
  /**
   * Suspend EVERY bash and PowerShell allow rule (whole-tool and content)
   * in `auto` mode — the hard override on the otherwise best-effort
   * suspension list (design doc D1/R5). Absent ⇒ `false`.
   */
  classifyAllShell?: boolean
  /** LLM risk classifier configuration; absent when the section omits it. */
  classifier?: AutoModeClassifierSettings
  /** Input-layer PI-probe configuration (S7); absent when the section omits it. */
  probe?: AutoModeProbeSettings
}

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
  /** Raw medium-risk regex sources replacing the curated MEDIUM tier. */
  mediumPatterns?: string[]
  /**
   * Raw critical-bash regex sources APPENDED after the built-in curated
   * critical tier (append-only, never replacing) and mounted as bypass-immune
   * deny rules. Invalid regex sources are skipped with a debug log.
   */
  criticalDeny?: string[]
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

/**
 * The standard read-only tool set, applied when {@link Config.readOnlyTools}
 * is omitted.
 *
 * `structured_output` is classified read-only because both registrars of the
 * name are validate-and-echo report channels with zero side effects: the
 * in-process driver's child-scoped schema tool validates the arguments
 * against the declared output schema and captures the value, and this repo's
 * `tool-structured-output` global variant validates and echoes — every
 * consequential use of the reported data carries its own validation and
 * write path. Without the classification, auto mode routes these report
 * calls to the LLM risk classifier, whose `ask` verdict rejects
 * deterministically in headless children (`approvalPolicy: 'never'`).
 *
 * Caveat: a deployment that sets `permissions.readOnlyTools` explicitly
 * REPLACES this default wholesale — it must re-list `structured_output`
 * itself (same caveat class as {@link DEFAULT_FILE_EDIT_TOOLS}).
 */
export const DEFAULT_READ_ONLY_TOOLS = ['read', 'glob', 'grep', 'search', 'web_fetch', 'web_search', 'structured_output']

/** The classifier sub-object schema: defaults apply only when the object is present. */
const autoModeClassifierSchema = z.object({
  enabled: z.boolean().default(false),
  // Absence-preserving: an unset `route` defers to `backend` at consumption
  // (the `'haiku'` schema default was removed — pickClassifierRouteName).
  route: z.union([z.string(), z.const(undefined)]),
  // Absence-preserving enum union; consumption default `'haiku'`.
  backend: z.union(['haiku', 'auto'] as const),
  // Absence-preserving (gauge allow-gate; the adapter owns the default).
  gaugeAllowThreshold: z.union([z.number(), z.const(undefined)]),
  // Absence-preserving (gauge evidence fold; the stage owns the `true` default).
  gaugeAllowEvidence: z.union([z.boolean(), z.const(undefined)]),
  timeoutMs: z.number().default(8000),
  cacheMaxEntries: z.number().default(256),
})

/** The probe sub-object schema: defaults apply only when the object is present. */
const autoModeProbeSchema = z.object({
  enabled: z.boolean().default(true),
  // Absence-preserving: an unset `route` defers to `backend` at consumption
  // (the `'haiku'` schema default was removed — pickGaugeRouteName).
  route: z.union([z.string(), z.const(undefined)]),
  // Absence-preserving enum union; consumption default `'haiku'`.
  backend: z.union(['haiku', 'auto'] as const),
  timeoutMs: z.number().default(5000),
  // Union with `undefined` keeps an absent `toolPatterns` key absent.
  toolPatterns: z.union([z.array(z.string()), z.const(undefined)]),
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
    mediumPatterns: z.array(z.string()),
    criticalDeny: z.array(z.string()).default([]),
    // Union with `undefined` keeps an absent `autoMode` key absent — no
    // defaults materialized, the classifier stays disarmed (mirrors the
    // shared AutoModeSchema union-with-undefined idiom).
    autoMode: z.union([
      z.object({
        soft_deny: z.union([z.array(z.string()), z.const(undefined)]),
        allow: z.union([z.array(z.string()), z.const(undefined)]),
        environment: z.union([z.array(z.string()), z.const(undefined)]),
        classifyAllShell: z.union([z.boolean(), z.const(undefined)]),
        classifier: z.union([autoModeClassifierSchema, z.const(undefined)]),
        probe: z.union([autoModeProbeSchema, z.const(undefined)]),
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
