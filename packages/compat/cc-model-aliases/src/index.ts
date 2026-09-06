/**
 * Claude Code-compatible model alias resolution for the DeepSeek Harness.
 *
 * Two consumption shapes:
 * - **Service** (`ccModelRoutes`): the plugin entry (`apply`) owns the
 *   `model-aliases` settings namespace registration and provides a spawn-time
 *   resolver over it; consumers `ctx.get('ccModelRoutes')` lazily.
 * - **Pure helpers**: `mergeAliasMaps` / `createModelResolver` for embedding
 *   the resolution semantics without mounting the service.
 *
 * See the README for configuration, merge, and fallback semantics.
 *
 * @module @dsh-cc/model-aliases
 */

export { BUILTIN_ALIASES, CC_ALIASES, LANE_ALIASES, LANE_PEERS, mergeAliasMaps, createModelResolver, createModelInspector, type ModelResolver } from './resolver.ts'
export { toAgentOptions, toOneShotRoute, type OneShotParentRoute } from './agentOptions.ts'
export { overlayStampedEffort, stampedEffortOf } from './effort.ts'
export {
  ConfigAliasSchema,
  ConfigAliasesSchema,
  SettingsAliasSchema,
  SettingsAliasesSchema,
  type ConfigAliasEntry,
  type SettingsAliasEntry,
} from './schema.ts'
export type { AliasTarget, DetailedRoute, ResolvedRoute, AliasInspectKind, AliasInspectVia, AliasInspection } from './types.ts'
export { apply as applyRoutes, name as routesPluginName, MODEL_ALIASES_NAMESPACE, resolveAlias, resolveDetailedAlias, type ModelRoutes } from './service.ts'
export { apply, name } from './service.ts'
