/**
 * Configuration schemas for the CC model-alias layer.
 *
 * Two schemas exist because the two configuration layers differ in what they
 * may express. The deployment `config` layer (cc-shell `modelAliases`) cannot
 * delete an alias — values are a model id or an explicit `{provider, model}`
 * route. The settings overlay (`model-aliases` namespace) may additionally be
 * `null` for a key, which deletes a same-named config-default entry during
 * merge. Object-form targets require a non-empty `model`; `provider` is
 * optional (inherit the parent provider) but must be non-empty when present.
 * A half-written route is rejected at the service write-time validate rather
 * than surfacing as an empty-field override at spawn.
 *
 * The settings overlay is a shallow record keyed by alias name; the 5-cascade
 * layer merge inside settings is recursively deep (existing cascade
 * behaviour), so an object-form alias must be written whole or not at all
 * across layers to avoid `{provider, model}` field blending — see the package
 * README.
 *
 * @module @dsh-cc/model-aliases/schema
 */

import z from '@deepseek-ai/schemastery'
import type { AliasTarget } from './types.ts'

/** A target that only names a model id (provider inherits the parent route). */
const MODEL_ONLY = z.string().min(1)

/**
 * A target that pins an explicit route: `model` is required; `provider` is
 * optional (inherit the parent provider) but must be non-empty when present;
 * `reasoningEffort` is an optional opaque non-empty string whose legal
 * spellings belong to the target model's adapter.
 */
const EXPLICIT_ROUTE = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
})

/**
 * Schema for a deployment `config` alias value: a model id or an explicit
 * route, but never `null` (config cannot delete an alias; only the settings
 * overlay can).
 */
export const ConfigAliasSchema = z.union([MODEL_ONLY, EXPLICIT_ROUTE])

/**
 * Schema for a settings `model-aliases` value: a model id, an explicit route,
 * or `null` meaning "delete a same-named config-default entry".
 */
export const SettingsAliasSchema = z.union([MODEL_ONLY, EXPLICIT_ROUTE, z.const(null)])

/**
 * Schema for the whole config `modelAliases` record.
 */
export const ConfigAliasesSchema = z.dict(ConfigAliasSchema)

/**
 * Schema for the whole settings `model-aliases` section.
 */
export const SettingsAliasesSchema = z.dict(SettingsAliasSchema)

/** The validated shape of one config entry (modelled on the schema). */
export type ConfigAliasEntry = Exclude<AliasTarget, null>
/** The validated shape of one settings entry (may be `null` to delete). */
export type SettingsAliasEntry = AliasTarget
