/**
 * Mount a Claude Code plugin's sub-agent definitions.
 *
 * Loads `AgentDefinition`s from the plugin's standard `agents/` directory and
 * any inline manifest `agents` paths via the claude-code-agents loader, then
 * registers each as a named subagent provider backing `context: fork`. The
 * provider is a thin forwarder: `start` resolves a named execution backend on
 * the subagent seam (default `fork`) and delegates, overlaying the agent's
 * system prompt, model, and tool restriction. Registration is effect-scoped so
 * unmounting the plugin removes every agent.
 *
 * @module
 */

import { join, resolve } from 'node:path'
import { loadAgentsDir } from '@dsh-cc/claude-code-agents'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { toAgentOptions } from '@dsh-cc/model-aliases'
import type { CcPluginManifest } from './types.ts'
import { ComponentTally } from './seams.ts'

/**
 * Resolve a frontmatter `model` into a dsh `{provider, model, reasoningEffort?}`
 * route at spawn time. Returns `undefined` meaning "no override" (the child
 * inherits the parent's route). When the function is absent, providers keep the
 * historical byte-identical behavior of overlaying the literal model id. The
 * optional fields admit explicit `undefined` (per-field inheritance), matching
 * the `ResolvedRoute` shape from `@dsh-cc/model-aliases`.
 */
export type ResolveModel = (model: string | undefined) => {
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly reasoningEffort?: string | undefined
} | undefined

/** The subagent seam: a named-provider registry with a backend resolver. */
export interface SubagentsSeam {
  /**
   * Register a named execution provider.
   * @param provider - the provider to register.
   * @returns the exact disposer that removes the provider.
   */
  registerProvider(provider: unknown): () => void
  /** Look up a provider by name, for backend resolution at `start`. */
  getProvider(name: string): unknown | undefined
}

/** The execution backend a CC agent provider forwards to. */
export interface SubagentBackend {
  /** Start a one-shot child run against a delegation request. */
  start(request: unknown): Promise<unknown>
}

/** A thin forwarder provider: overlays an AgentDefinition and delegates. Exported for the cc-shell bundle's base-agent glue. */
export class AgentProvider implements SubagentBackend {
  private readonly backendName = 'fork'

  constructor(
    private readonly agentDefinition: AgentDefinition,
    private readonly resolve: (name: string) => SubagentBackend | undefined,
    private readonly resolveModel?: ResolveModel,
    private readonly registeredName?: string,
  ) {}

  /** Register-time provider name; `start` forwards to the backend. */
  get name(): string {
    return this.registeredName ?? this.agentDefinition.agentType
  }

  /** The agent definition this provider overlays — unchanged, bare `agentType`. */
  get definition(): AgentDefinition {
    return this.agentDefinition
  }

  /** The start-time features this agent's definition requires. */
  get capabilities(): { outputSchema: boolean; depthLimit: boolean; toolFilter: boolean; persona: boolean } {
    return {
      outputSchema: false,
      depthLimit: false,
      toolFilter: this.agentDefinition.toolRestriction !== undefined,
      persona: this.agentDefinition.permissionMode !== undefined || this.agentDefinition.isolation !== undefined,
    }
  }

  /** Whether the child sees the parent's completed-turn prefix. */
  get inheritsParentContext(): boolean {
    return true
  }

  /**
   * Delegate a delegation request to the resolved backend, overlaying the
   * agent's system prompt, model, and tool restriction.
   * @param request - the delegating request forwarded from the seam.
   * @returns the backend's run handle.
   * @throws when no backend is resolvable (execution depends on the host).
   */
  async start(request: unknown): Promise<unknown> {
    const backend = this.resolve(this.backendName)
    if (backend === undefined) {
      throw new Error(`cc-plugin-loader: no "${this.backendName}" subagent backend is registered to run agent "${this.agentDefinition.agentType}"`)
    }
    const delegation = request as Record<string, unknown>
    const modelOverride = this.resolveModelOverride()
    return backend.start({
      ...delegation,
      prompt: this.agentDefinition.systemPrompt,
      ...modelOverride !== undefined
        ? { agentOptions: { ...delegation['agentOptions'] as object, ...modelOverride } }
        : {},
      ...this.agentDefinition.toolRestriction !== undefined ? { toolFilter: this.agentDefinition.toolRestriction } : {},
    })
  }

  /**
   * Compute the `agentOptions` model override for one spawn.
   *
   * With no resolver injected this is byte-identical to the historical
   * behaviour: overlay the literal frontmatter `model` id. With a resolver
   * injected, the resolver's return is honored directly — a route overlays its
   * defined fields (per-field inheritance preserved by dropping `undefined`),
   * and `undefined` means "no override", so `inherit`/unconfigured-builtin
   * resolve to inheriting the parent route rather than re-overlaying the
   * literal model.
   * @returns the model/provider override, or `undefined` for no override.
   */
  private resolveModelOverride(): Record<string, string> | undefined {
    const model = this.agentDefinition.model
    const resolver = this.resolveModel
    if (resolver === undefined) {
      return model !== undefined ? { model } : undefined
    }
    if (model === undefined) return undefined
    return toAgentOptions(resolver(model))
  }
}

/** Agents live under this directory in a plugin root, when present. */
export const STANDARD_AGENTS_DIR = 'agents'

/**
 * Build a scoped seam-registration name for one agent type.
 *
 * The prefix is sanitized (colons and whitespace stripped so it never carries
 * its own separator); an `agentType` that already contains a `:` is used
 * verbatim, defensively against future subdirectory nesting that legitimately
 * carries colons.
 * @param prefix - the plugin manifest-name prefix.
 * @param agentType - the bare (or already-nested) agent type.
 * @returns `` `${prefix}:${agentType}` ``, or the verbatim `agentType`.
 */
export function scopedType(prefix: string, agentType: string): string {
  const clean = prefix.replace(/[:\s]/g, '')
  return agentType.includes(':') ? agentType : `${clean}:${agentType}`
}

/** Options for mounting one plugin's agents. */
export interface MountAgentsOptions {
  /** The plugin root directory; standard `agents/` resolves against it. */
  readonly pluginRoot: string
  /** The parsed manifest, whose `agents` paths add extra agent files. */
  readonly manifest: CcPluginManifest
  /** The subagent seam (probed; `undefined` to skip agents). */
  readonly subagents: SubagentsSeam | undefined
  /** Optional plugin manifest-name prefix applied to each agent type. */
  readonly namespacePrefix?: string
  /** Optional spawn-time model resolver threaded into every provider. */
  readonly resolveModel?: ResolveModel
}

/**
 * Load and register a plugin's sub-agent definitions.
 * @param options - plugin root, manifest, and the subagent seam.
 * @returns mounted disposers and per-component counts.
 */
export async function mountAgents(options: MountAgentsOptions): Promise<{ disposers: (() => void)[]; tally: ComponentTally }> {
  const tally = new ComponentTally('agents')
  const disposers: (() => void)[] = []
  if (options.subagents === undefined) {
    tally.addSkipped('subagent seam "subagents" is not mounted')
    return { disposers, tally }
  }
  const definitions = await loadAgentDefinitions(options.pluginRoot, options.manifest)
  if (definitions.length === 0) {
    tally.addSkipped('plugin ships no agents directory or manifest agents paths')
    return { disposers, tally }
  }
  const subagents = options.subagents
  const prefix = options.namespacePrefix
  for (const definition of definitions) {
    const provider = new AgentProvider(
      definition,
      name => subagents.getProvider(name) as SubagentBackend | undefined,
      options.resolveModel,
      ...prefix !== undefined ? [scopedType(prefix, definition.agentType)] : [],
    )
    disposers.push(subagents.registerProvider(provider))
    tally.addLoaded()
  }
  return { disposers, tally }
}

/** Load agent definitions from the standard `agents/` dir and manifest paths. */
async function loadAgentDefinitions(pluginRoot: string, manifest: CcPluginManifest): Promise<AgentDefinition[]> {
  const dirs: string[] = [join(pluginRoot, STANDARD_AGENTS_DIR)]
  const extra = manifest.agents.map((path) => {
    const resolved = resolve(pluginRoot, path)
    // An inline path may name one `.md`/`.json` file; load its parent dir.
    return /\.(md|json)$/.test(resolved) ? dirname(resolved) : resolved
  })
  dirs.push(...extra)
  const byName = new Map<string, AgentDefinition>()
  for (const dir of dirs) {
    for (const agent of await loadAgentsDir(dir, 'project')) {
      byName.set(agent.agentType, agent)
    }
  }
  return Array.from(byName.values())
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '.' : path.slice(0, index)
}
