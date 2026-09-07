/**
 * Live enumeration of plugin agent providers over the `subagents` seam.
 *
 * The CC Task tool treats the seam's registered agent providers purely as a
 * DEFINITION source: `cc-plugin-loader`'s `mountAgents` registers one
 * `AgentProvider` per plugin agent under the scoped id
 * `` `${pluginName}:${agentType}` `` (the `namespacePrefix` mechanism), and
 * this index enumerates them live on every call — plugin mounts are
 * effect-scoped Cordis contexts that may appear (or disappear) after this
 * plugin's `apply()`, so nothing is cached.
 *
 * Builtin providers (`spawn`, `fork`, …) are excluded naturally: they carry
 * no `definition`.
 *
 * @module @dsh-cc/subagent-task/plugin-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import type { SubagentsLike } from './background-start.ts'

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

/** Options for the index, mostly injectable seams for tests. */
export interface PluginAgentIndexOptions {
  /**
   * Override the seam lookup (hermetic tests). Defaults to
   * `ctx.get('subagents')`, re-read on every call.
   */
  seam?: () => SubagentsLike | undefined
}

/**
 * The structural guard for a plugin agent provider: a `start` function, a
 * string `name` containing `:` (the scoped `plugin:agent` id), and a
 * `definition` with a string `agentType` and `systemPrompt`. Builtin
 * providers (spawn/fork/…) carry no definition and are excluded naturally.
 *
 * The guard additionally REQUIRES the loader brand (`Symbol.for(
 * 'dsh-cc.plugin-agent-provider')`, plan §9.4): the structural shape alone is
 * an accidental protocol any foreign provider could fake, so only providers
 * the loader actually created are adopted.
 *
 * Precondition (load-bearing): the provider only carries a scoped name when
 * `mountAgents` was given a `namespacePrefix` — no prefix at mount ⇒ the
 * agent is undiscoverable: neither addressable by Task nor listed in the
 * catalog.
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
 * A live view over the seam's plugin agent providers. All methods read the
 * seam lazily on EVERY call so effect-scoped plugin mounts that appear after
 * `apply()` are still discovered.
 */
export class PluginAgentIndex {
  private readonly ctx: Context
  private readonly seamOverride: (() => SubagentsLike | undefined) | undefined

  constructor(ctx: Context, options: PluginAgentIndexOptions = {}) {
    this.ctx = ctx
    this.seamOverride = options.seam
  }

  /** The seam, re-read on every call (lazy: mounts may appear after apply). */
  private getSeam(): SubagentsLike | undefined {
    if (this.seamOverride !== undefined) return this.seamOverride()
    return this.ctx.get('subagents') as SubagentsLike | undefined
  }

  /**
   * List every plugin agent currently registered on the seam, as
   * `{ id, definition }` pairs. The scan is synchronous and uncached.
   */
  list(): { id: string; definition: AgentDefinition }[] {
    const seam = this.getSeam()
    // The seam is duck-typed: a host (or test harness) may expose a partial
    // seam without `list` — treat that as "no plugin agents", not a crash.
    if (seam === undefined || typeof seam.list !== 'function') return []
    const entries: { id: string; definition: AgentDefinition }[] = []
    for (const name of seam.list()) {
      const provider = seam.getProvider(name)
      if (isPluginAgentProvider(provider)) {
        entries.push({ id: provider.name, definition: provider.definition })
      }
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
