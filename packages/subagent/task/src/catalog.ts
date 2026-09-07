/**
 * The per-agent "Available subagents" system-prompt section.
 *
 * A single global section (mount once on the root context) serves every
 * agent: the text callback receives the assembling agent through
 * `AssembleContext.scope` (the agent loop passes `scope: agent`) and renders
 * that agent's workspace `.claude/agents` definitions. Because `text()` is a
 * synchronous callback it cannot `await` discovery, so the section renders
 * from a snapshot cache that a fire-and-forget `registry.ensure(cwd)` populates
 * in the background. An `system-prompt/assemble` waterfall listener
 * reconciles the placeholder in the same assembly: for a scope whose
 * snapshot has not landed it joins the in-flight discovery (bounded), stores
 * the snapshot, and re-renders the section with the same render function, so
 * the FIRST assembly already carries the real catalog and no later request
 * sees a different prefix; on timeout the placeholder ships and the
 * `system-prompt/change` path lands the catalog on a later assembly. When a
 * workspace defines no agents of its own (or there is no agent to scope to)
 * the section still lists the bundled agents, or renders an empty string when
 * there is nothing to scope to.
 *
 * @module @dsh-cc/subagent-task/catalog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'
import { cwdOf } from '@dsh-cc/memory'
import type { AgentRegistry } from './registry.ts'
import { PluginAgentIndex, isPluginAgentProvider } from './plugin-agents.ts'

/** Default order slot for the catalog section (tool guidance owns 100–199). */
export const CATALOG_SECTION_ORDER = 110

/** The section's unique name. */
export const CATALOG_SECTION_NAME = 'cc:subagent-catalog'

/**
 * How long the assemble waterfall may wait for a workspace's in-flight
 * discovery before giving up and shipping the placeholder. Bounded so a slow
 * or wedged scan delays the first request by at most this much; the
 * background `system-prompt/change` path remains the fallback.
 */
const READINESS_BUDGET_MS = 500

/**
 * Join `promise`, but reject after `ms` milliseconds either way. The loser
 * keeps running in the background (its eventual rejection is contained); the
 * caller gets a rejection to degrade on.
 */
function withinBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`readiness budget of ${ms}ms expired`)), ms)
  })
  budget.catch(() => {})
  return Promise.race([promise, budget]).finally(() => clearTimeout(timer))
}

/**
 * Extract the assembling agent from an `AssembleContext`. The agent loop
 * assembles with `scope: agent` (a runtime contract; `ScopeKey` is opaque),
 * so the scope IS the agent whenever a session drives the assembly.
 */
function agentFromScope(scope: unknown): Agent | undefined {
  if (typeof scope === 'object' && scope !== null && 'session' in scope) {
    return scope as Agent
  }
  return undefined
}

/**
 * Owner of the cached catalog section text. Holds one sorted definition list
 * per workspace root so the synchronous section provider can compose the text,
 * and fills each root's snapshot from a background `registry.ensure`.
 */
export class AgentCatalogSection {
  /** Sorted definitions per workspace root, populated once discovery lands. */
  private readonly snapshot = new Map<string, readonly AgentDefinition[]>()
  /** Roots whose background discovery has already been kicked off. */
  private readonly seen = new Set<string>()
  /**
   * The scoped ids whose providers passed the brand guard when
   * `subagent/provider-added` delivered them — so a later
   * `subagent/provider-removed` (which carries only the NAME, not the
   * provider) can be brand-checked by membership here.
   */
  private readonly brandedIds = new Set<string>()

  /**
   * Create a catalog cache holder bound to a registry.
   * @param ctx - the host context whose `system-prompt` seam and
   *   `system-prompt/change` channel drive refresh.
   * @param registry - the per-workspace definition cache to load from.
   * @param pluginIndex - the live plugin agent view (defaults to a fresh
   *   index over this context).
   */
  constructor(
    private readonly ctx: Context,
    private readonly registry: AgentRegistry,
    private readonly pluginIndex: PluginAgentIndex = new PluginAgentIndex(ctx),
  ) {}

  /** Register the catalog section plus its assemble-waterfall reconciliation.
   *
   * The seam is fetched with `ctx.get` rather than the `ctx.systemPrompt`
   * property: cordis strict mode rejects property access for services the
   * plugin never declared via `inject`, and a throw here fails the whole
   * preset mount (every session in the preset dies at creation).
   *
   * The waterfall listener removes the first-assembly placeholder jitter:
   * `systemPrompt.assemble()` runs BEFORE the agent pre-step, so the section
   * text callback cannot await discovery — but the waterfall can. After the
   * base assembly, a scope whose snapshot has not landed yet joins the
   * in-flight `registry.ensure` (bounded by {@linkcode READINESS_BUDGET_MS}),
   * stores the snapshot itself, and re-renders the section with the same
   * render function the section callback uses, so the first assembly already
   * carries the real catalog and request 2 of the first turn keeps its
   * prefix. Timeout or failure keeps the placeholder (the background
   * `system-prompt/change` path still lands it on a later assembly).
   * @returns the exact Cordis effect disposer for the section and listener. */
  start(): () => void {
    const seam = this.ctx.get('systemPrompt') as {
      section(def: { name: string; order: number; text: (context: { scope?: unknown }) => string }): () => void
    } | undefined
    const disposeSection = seam === undefined
      ? () => {}
      : seam.section({
        name: CATALOG_SECTION_NAME,
        order: CATALOG_SECTION_ORDER,
        text: (context: { scope?: unknown }): string => this.render(context.scope),
      })
    const disposeListener = this.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      const agent = agentFromScope(context.scope)
      if (agent === undefined) return result
      const root = cwdOf(agent)
      if (this.snapshot.has(root)) return result
      try {
        const defs = await withinBudget(this.registry.ensure(root), READINESS_BUDGET_MS)
        this.snapshot.set(
          root,
          [...defs.values()].sort((a, b) => a.agentType.localeCompare(b.agentType)),
        )
      } catch (error) {
        this.ctx.logger.warn(
          `subagent catalog: discovery for ${root} did not land within ${READINESS_BUDGET_MS}ms of the first assembly: ${String(error)}; keeping the placeholder`,
        )
        return result
      }
      return {
        ...result,
        sections: result.sections.map(section => section.name === CATALOG_SECTION_NAME
          ? { ...section, text: this.render(agent) }
          : section),
      }
    })
    // Event-driven plugin invalidation (plan §9.3): the seam emits
    // `subagent/provider-added` / `subagent/provider-removed` on the shared
    // cordis bus. The events are declared via module augmentation in
    // @deepseek-ai/dsh-subagent, which this package does not import — the
    // augmentation is not in its type graph, so the same cast-through-
    // `ctx.on` pattern other packages use applies (see
    // packages/ui/tui/src/harness/driver-catalog.ts). The emit fires DIRECTLY
    // from the listener — it is not mid-assembly, so no deferral is needed.
    // A changed definition re-registers as remove+add, so no fingerprinting.
    const providerAdded = 'subagent/provider-added' as Parameters<typeof this.ctx.on>[0]
    const providerRemoved = 'subagent/provider-removed' as Parameters<typeof this.ctx.on>[0]
    // Seed with providers that mounted BEFORE this listener started
    // (production mounts cc-shell-glue before subagent-task): their add
    // events already fired, but they are live in the index, so their
    // removals must still invalidate the prompt — a removal is recognized
    // only by membership in `brandedIds`.
    for (const id of this.pluginIndex.knownIds()) this.brandedIds.add(id)
    const disposeAdded = this.ctx.on(providerAdded, (provider: unknown) => {
      if (!isPluginAgentProvider(provider)) return
      this.brandedIds.add(provider.name)
      this.ctx.emit('system-prompt/change')
    })
    const disposeRemoved = this.ctx.on(providerRemoved, (name: unknown) => {
      // The removed event carries only the name; membership in `brandedIds`
      // proves the provider passed the brand guard when it was added.
      if (typeof name !== 'string' || !this.brandedIds.delete(name)) return
      this.ctx.emit('system-prompt/change')
    })
    return () => {
      disposeAdded()
      disposeRemoved()
      disposeListener()
      disposeSection()
    }
  }

  /**
   * Compose the catalog text for the agent behind an assemble scope.
   * Kicks the root's background discovery on first sight; renders from the
   * snapshot until it lands. Returns '' (section drops out) when there is no
   * agent or the snapshot holds no definitions.
   */
  private render(scope: unknown): string {
    const agent = agentFromScope(scope)
    if (agent === undefined) return ''
    const root = cwdOf(agent)
    this.ensureDefs(root)
    // Synchronous live scan, no caching: plugin mounts are effect-scoped and
    // may appear or disappear between renders. SIDE-EFFECT-FREE (plan §9.3):
    // invalidation rides the seam's lifecycle events (subscribed in `start`),
    // so render only reads current state.
    const pluginEntries = this.pluginIndex.list()
    const merged = [
      ...(this.snapshot.get(root) ?? []),
      ...pluginEntries.map(entry => ({
        // Plugin entries render under their scoped id (`plugin:agent`), with
        // the provider definition's whenToUse as the guide line. The guard is
        // definition-presence — builtin seam providers (spawn/fork/…) carry no
        // definition and are excluded naturally by the index.
        agentType: entry.id,
        whenToUse: entry.definition.whenToUse,
      } as AgentDefinition)),
    ].sort((a, b) => a.agentType.localeCompare(b.agentType))
    return renderCatalog(merged)
  }

  /**
   * Kick background discovery for one workspace root exactly once. When it
   * lands, the snapshot is populated and `system-prompt/change` fires so the
   * next assembly renders the catalog. Failures are swallowed: a missing or
   * unreadable agents directory simply leaves an empty snapshot (the section
   * stays absent, which is itself the correct "no agents" rendering).
   * @param root - the workspace root.
   */
  private ensureDefs(root: string): void {
    if (this.seen.has(root)) return
    this.seen.add(root)
    void this.registry.ensure(root).then(
      defs => {
        this.snapshot.set(
          root,
          [...defs.values()].sort((a, b) => a.agentType.localeCompare(b.agentType)),
        )
        this.ctx.emit('system-prompt/change')
      },
      () => {},
    )
  }
}

/**
 * Mount the single global catalog section.
 * @param ctx - the plug context carrying the `systemPrompt` seam.
 * @param registry - the per-workspace definition cache.
 * @param pluginIndex - the live plugin agent view (defaults to a fresh index
 *   over this context).
 * @returns the exact Cordis effect disposer, or undefined when the seam is absent.
 */
export function mountAgentCatalog(
  ctx: Context,
  registry: AgentRegistry,
  pluginIndex?: PluginAgentIndex,
): (() => void) | undefined {
  if (ctx.get('systemPrompt') === undefined) return undefined
  return new AgentCatalogSection(ctx, registry, pluginIndex).start()
}

/**
 * Compose the section text from the sorted definitions. Returns '' when empty
 * so the section contributes nothing to the prompt.
 * @param defs - the sorted definitions to list.
 * @returns the rendered catalog, or '' when no definitions are available.
 */
export function renderCatalog(defs: readonly AgentDefinition[]): string {
  if (defs.length === 0) return ''
  const lines = [
    '## Available subagents',
    '',
    ...defs.map(def => `- ${def.agentType} — ${def.whenToUse}`),
    '',
    'To delegate to one, pass its name as the `subagent_type` argument of the Task tool.',
  ]
  return lines.join('\n')
}
