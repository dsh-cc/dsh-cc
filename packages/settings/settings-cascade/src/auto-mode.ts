/**
 * Claude Code-compatible `autoMode` schema — the settings surface for the LLM
 * risk classifier (design doc §4.5). The delivery route is the `autoMode` key
 * INSIDE the existing `permissions` namespace (`permissions.autoMode`), not a
 * root-level key: top-level settings namespaces must be kebab-case upstream,
 * so Claude Code's root `autoMode` location is a documented deviation (the
 * cascade registers no root `autoMode` namespace). Exported as a standalone
 * value so the settings cascade and the permission-rules plugin (which
 * hand-mirrors the shape) share one definition of the section.
 * @module @dsh-cc/settings-cascade/auto-mode
 */

import z from '@deepseek-ai/schemastery'

/** `autoMode.classifier` — only defaults apply when the object itself is present. */
export interface AutoModeClassifier {
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
   * consumption): `'haiku'` always uses the chat classifier, even when a
   * gauge alias is fully configured; `'auto'` arms the gauge System One
   * lane when the gauge alias is configured with the systemone protocol.
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
   * `permission/classifier` and `permission/probe` audit events carry the
   * raw rendered input (≤8192 chars by construction) in addition to the
   * digest. Off by default: the input may contain command text, including
   * secrets the agent was about to run.
   */
  auditFullText?: boolean
}

/**
 * `autoMode.probe` — the input-layer prompt-injection probe (S7). Only
 * defaults apply when the object itself is present.
 */
export interface AutoModeProbe {
  /** Master switch for the probe (default `true`). */
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
  /**
   * Scan-set override (S7/W3): exact tool names or trailing-`*` prefix
   * patterns; REPLACES the default scan set entirely.
   */
  toolPatterns?: string[]
}

/** The `autoMode` section (delivered as `permissions.autoMode`). */
export interface AutoMode {
  /**
   * Soft-deny hints evaluated by the classifier, in CC's snake_case spelling.
   * `$defaults` expansion happens at consumption time in the classifier
   * module — the schema never expands it, so merging never sees the expansion.
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
   * the schema never expands it, so merging never sees the expansion.
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
   * suspension list. Absent ⇒ `false` (absence-preserving).
   */
  classifyAllShell?: boolean
  /** LLM risk classifier configuration; absent when the section omits it. */
  classifier?: AutoModeClassifier
  /** Input-layer PI-probe configuration (S7); absent when the section omits it. */
  probe?: AutoModeProbe
}

/**
 * Schemastery schema for `autoMode.probe` (S7/W3). Same absence-preserving
 * union idiom as the classifier sub-schema.
 */
export const AutoModeProbeSchema: z<AutoModeProbe> = z.object({
  enabled: z.boolean().default(true),
  // Absence-preserving: an unset `route` defers to `backend` at consumption
  // (the `'haiku'` schema default was removed — pickGaugeRouteName).
  route: z.union([z.string(), z.const(undefined)]),
  // Absence-preserving enum union; consumption default `'haiku'` (PR-C).
  backend: z.union(['haiku', 'auto'] as const),
  timeoutMs: z.number().default(5000),
  // Union with `undefined` keeps an absent `toolPatterns` key absent
  // (permissive array, no default).
  toolPatterns: z.union([z.array(z.string()), z.const(undefined)]),
}) as z<AutoModeProbe>

/**
 * Schemastery schema for `autoMode.classifier`. Defaults apply only when the
 * object itself is present (the parent uses a union-with-`undefined` so an
 * absent key stays absent instead of materializing defaults).
 */
export const AutoModeClassifierSchema: z<AutoModeClassifier> = z.object({
  enabled: z.boolean().default(false),
  // Absence-preserving: an unset `route` defers to `backend` at consumption
  // (the `'haiku'` schema default was removed — pickClassifierRouteName).
  route: z.union([z.string(), z.const(undefined)]),
  // Absence-preserving enum union; consumption default `'haiku'`.
  backend: z.union(['haiku', 'auto'] as const),
  // Absence-preserving (gauge allow-gate; adapter owns the default).
  gaugeAllowThreshold: z.union([z.number(), z.const(undefined)]),
  // Absence-preserving (gauge evidence fold; the stage owns the `true` default).
  gaugeAllowEvidence: z.union([z.boolean(), z.const(undefined)]),
  timeoutMs: z.number().default(8000),
  cacheMaxEntries: z.number().default(256),
  // Union with `undefined` keeps an absent `secondPass` key absent (default
  // false at consumption — D13, absence-preserving).
  secondPass: z.union([z.boolean(), z.const(undefined)]),
  // Same absence-preserving idiom (S5/D10 full-text audit — default false).
  auditFullText: z.union([z.boolean(), z.const(undefined)]),
}) as z<AutoModeClassifier>

/**
 * Schemastery schema for the `autoMode` section body. Unknown fields pass
 * through unmodified, matching {@link PermissionsSchema}. Sub-keys stay
 * absent when absent from every settings layer.
 */
const AutoModeSectionSchema = z.object({
  // Union with `undefined` keeps an absent `soft_deny` key absent — no empty
  // array is materialized (permissive array, no default).
  soft_deny: z.union([z.array(z.string()), z.const(undefined)]),
  // Same absence-preserving idiom as `soft_deny` (S4 hard-deny slot).
  hard_deny: z.union([z.array(z.string()), z.const(undefined)]),
  // Same absence-preserving idiom as `soft_deny` (S2 slots).
  allow: z.union([z.array(z.string()), z.const(undefined)]),
  environment: z.union([z.array(z.string()), z.const(undefined)]),
  // Union with `undefined` keeps an absent `classifyAllShell` key absent.
  classifyAllShell: z.union([z.boolean(), z.const(undefined)]),
  // Union with `undefined` keeps an absent `classifier` key absent; a present
  // object resolves through AutoModeClassifierSchema (defaults apply there).
  classifier: z.union([AutoModeClassifierSchema, z.const(undefined)]),
  // Union with `undefined` keeps an absent `probe` key absent (S7).
  probe: z.union([AutoModeProbeSchema, z.const(undefined)]),
})

/**
 * Schemastery schema for the `autoMode` section. The section itself stays
 * `undefined` when absent from every settings layer — the classifier remains
 * disarmed.
 */
export const AutoModeSchema: z<AutoMode | undefined> = z.union([
  AutoModeSectionSchema,
  z.const(undefined),
]) as z<AutoMode | undefined>
