/**
 * Live enumeration of plugin agent providers through the root-realm
 * `ccPluginAgents` registry.
 *
 * The CC Task tool treats registered plugin agents purely as a DEFINITION
 * source: `cc-plugin-loader`'s `mountAgents` registers one `AgentProvider`
 * per plugin agent under the scoped id `` `${pluginName}:${agentType}` ``
 * (the `namespacePrefix` mechanism) and records the same ids into the
 * root-realm `ccPluginAgents` service at registration time (harness rc.5
 * removed the subagents service's provider enumeration, so that registry is
 * the authoritative snapshot). This index reads the service lazily on EVERY
 * call — plugin mounts are effect-scoped Cordis contexts that may appear (or
 * disappear) after this plugin's `apply()`, so nothing is cached.
 *
 * @module @dsh-cc/subagent-task/plugin-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'

/**
 * The loader's brand key, duplicated as a `Symbol.for` lookup instead of a
 * runtime import of `@dsh-cc/plugin-loader` (a devDependency — a runtime
 * import here would break published consumers). Kept in lockstep with
 * `PLUGIN_AGENT_PROVIDER_BRAND` in the loader; both resolve to the same
 * registry symbol.
 */
const PLUGIN_AGENT_PROVIDER_BRAND: unique symbol = Symbol.for('dsh-cc.plugin-agent-provider')

/** Whether a value was created by the loader as a plugin agent provider. */
function hasLoaderBrand(value: unknown): boolean {
  return typeof value === 'object' && value !== null
    && (value as Record<symbol, unknown>)[PLUGIN_AGENT_PROVIDER_BRAND] === true
}

/**
 * The root-realm `ccPluginAgents` service face this index consumes (duck
 * typed locally so a hermetic test can substitute it without cordis).
 */
export interface CcPluginAgentsLike {
  /** The currently registered scoped plugin-agent ids. */
  knownIds(): readonly string[]
  /** The agent definition registered under one scoped id. */
  get(id: string): AgentDefinition | undefined
}

/** Options for the index, mostly injectable seams for tests. */
export interface PluginAgentIndexOptions {
  /**
   * Override the `ccPluginAgents` service lookup (hermetic tests). Defaults
   * to `ctx.get('ccPluginAgents')`, re-read on every call.
   */
  seam?: () => CcPluginAgentsLike | undefined
}

/**
 * The structural guard for a plugin agent provider payload: a `start`
 * function, a string `name` containing `:` (the scoped `plugin:agent` id),
 * and a `definition` with a string `agentType` and `systemPrompt`. Builtin
 * providers (spawn/fork/…) carry no definition and are excluded naturally.
 *
 * The guard additionally REQUIRES the loader brand (`Symbol.for(
 * 'dsh-cc.plugin-agent-provider')`, plan §9.4): the structural shape alone is
 * an accidental protocol any foreign provider could fake, so only providers
 * the loader actually created are adopted. Used by the catalog's
 * `subagent/provider-added` listener, whose event payload is a live provider
 * (untrusted) — unlike the `ccPluginAgents` snapshot, which the loader itself
 * writes at registration time and needs no read-side guard.
 *
 * Precondition (load-bearing): the provider only carries a scoped name when
 * `mountAgents` was given a `namespacePrefix` — no prefix at mount ⇒ the
 * agent is undiscoverable: neither addressable by Task nor listed in the
 * catalog (the loader records only scoped registrations into the service).
 */
export function isPluginAgentProvider(provider: unknown): provider is {
  name: string
  start: unknown
  definition: AgentDefinition
} {
  if (!hasLoaderBrand(provider)) return false
  const candidate = provider as { name?: unknown; start?: unknown; definition?: unknown }
  if (typeof candidate.name !== 'string' || !candidate.name.includes(':')) return false
  if (typeof candidate.start !== 'function') return false
  const def = candidate.definition
  if (typeof def !== 'object' || def === null) return false
  const shape = def as { agentType?: unknown; systemPrompt?: unknown }
  return typeof shape.agentType === 'string' && typeof shape.systemPrompt === 'string'
}

/**
 * A live view over the `ccPluginAgents` registry's plugin agents. All methods
 * read the service lazily on EVERY call so effect-scoped plugin mounts that
 * appear after `apply()` are still discovered.
 */
export class PluginAgentIndex {
  private readonly ctx: Context
  private readonly seamOverride: (() => CcPluginAgentsLike | undefined) | undefined

  constructor(ctx: Context, options: PluginAgentIndexOptions = {}) {
    this.ctx = ctx
    this.seamOverride = options.seam
  }

  /** The service, re-read on every call (lazy: mounts may appear after apply). */
  private getSeam(): CcPluginAgentsLike | undefined {
    if (this.seamOverride !== undefined) return this.seamOverride()
    return this.ctx.get('ccPluginAgents') as CcPluginAgentsLike | undefined
  }

  /**
   * List every plugin agent currently registered, as `{ id, definition }`
   * pairs, from the `ccPluginAgents` snapshot. The scan is synchronous and
   * uncached; an absent service (no plugin loader mounted) reads as "no
   * plugin agents", never a crash.
   */
  list(): { id: string; definition: AgentDefinition }[] {
    const service = this.getSeam()
    if (service === undefined) return []
    const entries: { id: string; definition: AgentDefinition }[] = []
    for (const id of service.knownIds()) {
      const definition = service.get(id)
      if (definition !== undefined) entries.push({ id, definition })
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Resolve one plugin agent by its exact scoped id (`plugin:agent`).
   * Bare plugin agent names are NOT addressable — matching CC, where plugin
   * agents are addressed only by scoped id.
   */
  resolve(type: string): AgentDefinition | undefined {
    return this.list().find(entry => entry.id === type)?.definition
  }

  /** A snapshot of the currently known scoped ids (for catalog diffing). */
  knownIds(): string[] {
    return this.list().map(entry => entry.id)
  }
}
