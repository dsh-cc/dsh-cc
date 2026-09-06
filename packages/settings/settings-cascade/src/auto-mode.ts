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
  /** Model route used for classification (default `'haiku'`). */
  route?: string
  /** Per-call timeout in milliseconds (default `8000`). */
  timeoutMs?: number
  /** Verdict cache size in entries (default `256`). */
  cacheMaxEntries?: number
}

/** The `autoMode` section (delivered as `permissions.autoMode`). */
export interface AutoMode {
  /**
   * Soft-deny hints evaluated by the classifier, in CC's snake_case spelling.
   * `$defaults` expansion happens at consumption time in the classifier
   * module — the schema never expands it, so merging never sees the expansion.
   */
  soft_deny?: string[]
  /** LLM risk classifier configuration; absent when the section omits it. */
  classifier?: AutoModeClassifier
}

/**
 * Schemastery schema for `autoMode.classifier`. Defaults apply only when the
 * object itself is present (the parent uses a union-with-`undefined` so an
 * absent key stays absent instead of materializing defaults).
 */
export const AutoModeClassifierSchema: z<AutoModeClassifier> = z.object({
  enabled: z.boolean().default(false),
  route: z.string().default('haiku'),
  timeoutMs: z.number().default(8000),
  cacheMaxEntries: z.number().default(256),
})

/**
 * Schemastery schema for the `autoMode` section body. Unknown fields pass
 * through unmodified, matching {@link PermissionsSchema}. Sub-keys stay
 * absent when absent from every settings layer.
 */
const AutoModeSectionSchema = z.object({
  // Union with `undefined` keeps an absent `soft_deny` key absent — no empty
  // array is materialized (permissive array, no default).
  soft_deny: z.union([z.array(z.string()), z.const(undefined)]),
  // Union with `undefined` keeps an absent `classifier` key absent; a present
  // object resolves through AutoModeClassifierSchema (defaults apply there).
  classifier: z.union([AutoModeClassifierSchema, z.const(undefined)]),
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
