/**
 * Deferred tool registration and the model-facing ToolSearch tool that loads
 * heavy tools on demand.
 *
 * A tool that is expensive to load or token-heavy in the prompt can register
 * DEFERRED: it contributes name + description + search hint to a registry the
 * model can search, but its real definition stays out of the model-visible
 * schema and prompt until the model asks for it. The ToolSearch tool ranks the
 * deferred set against a query and, on a hit, runs the deferred registration's
 * activation callback — which performs the real `ctx.tools.register()`. Because
 * registration is an effect, the tool becomes visible to the NEXT assembly and
 * lives exactly as long as its owning plugin fiber.
 *
 * The design generalizes the `shouldDefer`/ToolSearch mechanism (and the MCP
 * `anthropic/alwaysLoad` escape hatch) into the harness's effect-based registry
 * model: {@link DeferredToolRegistry.registerDeferred} is itself an effect, and
 * {@link registry.activate} gate the load behind the calling scope's tool
 * restriction, so a deferred tool a scope denies is never loaded for it.
 *
 * The ToolSearch tool itself is registered LAZILY: while no searchable
 * (non-alwaysLoad) deferred entry exists, only its name is reserved — an empty
 * pool makes the tool useless, and its "tools are hidden, search to load them"
 * description actively misleads models into believing they lack capabilities
 * they actually hold. The first deferred registration brings ToolSearch into
 * the model-visible set; it then stays (hysteresis) so the assembled tool
 * order never shifts mid-session.
 * @module @dsh-cc/tool-search
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { NamedEntries, ScopedLayers, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@dsh-cc/tools'
import type { ToolResultView, ToolCallView } from '@dsh-cc/tools'
// Type-only: brings the `ctx.tools` Context merge into this program.
import type {} from '@dsh-cc/tools'
import { DiscoveryCache } from './discovery-cache.ts'
import { createDiscoveryRuntime } from './discovery-runtime.ts'
import type { DiscoveryEvaluation, DiscoveryRuntime } from './discovery-runtime.ts'
import type { DiscoveryHostFace } from './discovery-contract.ts'
import { DEFAULT_DISCOVERY_SETTINGS, createWarnOnce, registerDiscoverySettings } from './discovery-settings.ts'
import type { DiscoverySettingsReader } from './discovery-settings.ts'
import type { DeferredEntry } from './discovery.ts'
import { scoreStored } from './search-scoring.ts'
import { composeSearchMessage } from './search-message.ts'

/** The model-facing ToolSearch tool name. */
export const TOOL_SEARCH_NAME = 'ToolSearch'

/** A deferred registration: capability metadata before its heavy definition loads. */
export interface DeferredToolRegistration {
  /** The eventual registered tool name, unique within one deferred registry layer. */
  readonly name: string
  /** The model-facing description, shown in the ToolSearch result and later the tool schema. */
  readonly description: string
  /** A short capability phrase for keyword matching; prefer terms not in the name. */
  readonly searchHint?: string
  /**
   * Escape hatch that never defers: `true` activates the tool immediately at
   * registration, generalizing MCP's `_meta['anthropic/alwaysLoad']`. An
   * `alwaysLoad` tool is registered and model-visible from the start and is
   * never a ToolSearch candidate.
   */
  readonly alwaysLoad?: boolean
  /**
   * Perform the real registration. Called at most once (the first admitting
   * ToolSearch hit, or immediately for an {@link DeferredToolRegistration.alwaysLoad}
   * tool). Must register a definition on `ctx.tools` and return that exact
   * disposer, so the tool unloads with the deferred entry.
   */
  readonly activate: () => () => void
}

/** One ranked deferred-tool match returned by a ToolSearch query. */
export interface DeferredSearchHit {
  /** The deferred tool name. */
  readonly name: string
  /** The deferred tool description. */
  readonly description: string
  /** The deferred tool's optional search hint. */
  readonly searchHint?: string
}

/** Result of attempting to load one deferred tool for a scope. */
export type DeferredActivationResult =
  | { readonly status: 'loaded'; readonly name: string }
  | { readonly status: 'already-loaded'; readonly name: string }
  | { readonly status: 'denied'; readonly name: string; readonly reason: string }
  | { readonly status: 'unknown'; readonly name: string }

/** One scope's aggregate deferred-tool registration. */
class DeferredLayer implements ScopeLayer {
  readonly tools = new NamedEntries<StoredDeferred>(
    name => new Error(`tool "${name}" is already registered as deferred in this scope`),
  )

  isEmpty(): boolean {
    return this.tools.isEmpty()
  }
}

/** A deferred registration plus its mutable load lifecycle state. */
interface StoredDeferred {
  readonly reg: DeferredToolRegistration
  readonly alwaysLoad: boolean
  activated: boolean
  disposer: (() => void) | undefined
}

/**
 * Deferred tool registry and the ToolSearch tool.
 *
 * Deferred registrations are host-plane effects: they land in the calling
 * context's scope layer and unwind with it. The tool itself (registered on the
 * `tools` row) lets a model search the deferred set and load a hit — gated by
 * the calling agent's tool restriction, so a deferred tool a scope denies is
 * never loaded for it.
 */
export class DeferredToolRegistry extends Service {
  static inject = ['tools']

  private readonly layers = new ScopedLayers(
    () => new DeferredLayer(),
    // Deferred-set changes are not model-visible (deferred tools never enter
    // the prompt); actual activations fire `tools/change` through `register()`.
    () => {},
  )

  /** Non-alwaysLoad deferred entries registered on this registry instance. */
  private searchableCount = 0

  /** Disposer for the lazily-registered ToolSearch tool, once visible. */
  private toolDisposer: (() => void) | undefined

  /** Live `cc-tool-discovery` reader; `undefined` from it means "do not judge". */
  private readonly readDiscoverySettings: DiscoverySettingsReader

  /** The asynchronous S1-05 judgment (see `discovery-runtime.ts`). */
  private readonly discovery: DiscoveryRuntime

  constructor(ctx: Context) {
    super(ctx, 'toolSearch')
    // The ToolSearch tool itself is never deferred: it is the load path, so it
    // must be visible once a searchable pool exists. But it is also pointless
    // — and its description actively misleading — while the pool is empty, so
    // only the name is reserved here (keeping it restrictable); the real
    // registration happens on the first non-alwaysLoad deferred entry.
    ctx.tools.reserve(TOOL_SEARCH_NAME)
    // S1-05: the settings namespace registers lazily (absent settings plane ⇒
    // defaults ⇒ `mode: off`) and the async judgment hangs off this service, so
    // `search()` and the tool signature stay synchronous.
    const reporter = createWarnOnce((message) => {
      try {
        ctx.logger.warn(message)
      } catch {
        // An absent logger must not break a search.
      }
    })
    this.readDiscoverySettings = registerDiscoverySettings(ctx, reporter)
    this.discovery = createDiscoveryRuntime<ScopeKey | undefined>({
      readSettings: () => this.readDiscoverySettings(),
      snapshotEntries: (query, scope) => this.discoveryEntries(query, scope),
      host: ctx as unknown as DiscoveryHostFace,
      cache: new DiscoveryCache({ maxEntries: DEFAULT_DISCOVERY_SETTINGS.cacheEntries, ttlMs: DEFAULT_DISCOVERY_SETTINGS.cacheTtlMs }),
    })
  }

  /**
   * Register a deferred capability. The name+description (+hint) are searchable
   * but invisible until activated; an {@link DeferredToolRegistration.alwaysLoad}
   * tool activates immediately for everyone. Registration is an effect: the
   * returned disposer removes the deferred entry and, if it was activated, its
   * real `ctx.tools` registration together.
   * @param reg - the deferred descriptor and activation callback.
   * @returns the exact disposer that reclaims both the deferred entry and any loaded tool.
   */
  registerDeferred(reg: DeferredToolRegistration): () => void {
    const stored: StoredDeferred = {
      reg,
      alwaysLoad: reg.alwaysLoad === true,
      activated: false,
      disposer: undefined,
    }
    const unwind = this.layers.effect(
      this.ctx,
      (layer) => {
        const undo = layer.tools.insert(reg.name, stored)
        if (stored.alwaysLoad) this.activateStore(stored)
        return () => {
          undo()
          this.deactivateStore(stored)
        }
      },
      { label: 'toolSearch.registerDeferred()' },
    )
    // Reserve the name in the tools registry so a scoped restriction can gate
    // it before its definition loads (restrict only names known capabilities).
    const reserve = this.ctx.tools.reserve(reg.name)
    // Lazy registration of the ToolSearch tool itself: the first non-alwaysLoad
    // deferred entry brings the search tool into the model-visible set (0→1).
    // It stays registered once added (hysteresis — never torn down on 1→0, so
    // the assembled tool order never shifts mid-session), and unloads with the
    // service context like any other registration.
    let disposed = false
    if (!stored.alwaysLoad) {
      this.searchableCount += 1
      // Guard on the disposer, not the count: with hysteresis the count can
      // return to 0 while the registration stands, and re-registering would
      // throw on the duplicate name.
      if (this.toolDisposer === undefined) this.toolDisposer = this.ctx.tools.register(this.toolDefinition())
    }
    return () => {
      if (disposed) return
      disposed = true
      unwind()
      reserve()
      if (!stored.alwaysLoad) this.searchableCount -= 1
    }
  }

  /**
   * Rank the deferred, not-yet-loaded tools against a query, searching the scope
   * chain the caller lives in. Returns the top `maxResults` accessible
   * candidates in descending relevance. This is the pure matching step; loading
   * (and its restriction gate) happens in {@link DeferredToolRegistry.activate}.
   * @param query - free-text keyword query.
   * @param maxResults - how many hits to return (default 5).
   * @param scope - the calling scope whose deferred set (and its ancestors') is
   *   searched; defaults to this registry's own scope ([`scopeOf`]) on the
   *   service context, which is global for a global registry.
   * @returns ranked, scored matches that are still deferred.
   */
  search(query: string, maxResults: number = 5, scope?: ScopeKey): DeferredSearchHit[] {
    const candidates: Array<{ stored: StoredDeferred; score: number }> = []
    for (const stored of this.allDeferred(scope)) {
      if (stored.alwaysLoad || stored.activated) continue
      const score = scoreStored(stored, query)
      if (score > 0) candidates.push({ stored, score })
    }
    candidates.sort((a, b) => b.score - a.score || a.stored.reg.name.localeCompare(b.stored.reg.name))
    return candidates.slice(0, maxResults).map(({ stored }) => ({
      name: stored.reg.name,
      description: stored.reg.description,
      ...stored.reg.searchHint !== undefined ? { searchHint: stored.reg.searchHint } : {},
    }))
  }

  /**
   * Load one deferred tool for a scope, idempotently. A hit that the scope's
   * tool restriction denies is NOT loaded (guard semantics take priority over
   * ToolSearch, so the loading gate is not an end-run around `restrict()`); an
   * already-loaded or `alwaysLoad` tool reports `already-loaded` without
   * re-registering; an absent name reports `unknown`.
   * @param name - the deferred tool name.
   * @param scope - the calling agent scope whose restriction gates the load.
   * @returns the load outcome for the model-facing result.
   */
  activate(name: string, scope?: ScopeKey): DeferredActivationResult {
    const stored = this.allDeferred(scope).find(candidate => candidate.reg.name === name)
    if (stored === undefined) {
      return { status: 'unknown', name }
    }
    if (stored.alwaysLoad || stored.activated) {
      return { status: 'already-loaded', name }
    }
    if (!this.ctx.tools.isAdmitted(name, scope)) {
      return { status: 'denied', name, reason: `"${name}" is restricted for this agent; loading it would be refused` }
    }
    this.activateStore(stored)
    return { status: 'loaded', name }
  }

  /**
   * Every deferred entry in scope order (global then the scope chain nearest
   * last) for the calling scope. A caller with no explicit scope searches the
   * registry's own scope: a global registry resolves to the global layer
   * (`scopeOf(this.ctx)` is `undefined` on an unscoped service context), while
   * a registry hosted under a scoped preset backs a child scope so its deferred
   * set — and its ancestors' — stays visible to it.
   */
  private allDeferred(scope?: ScopeKey): StoredDeferred[] {
    const key = scope ?? scopeOf(this.ctx) ?? undefined
    return [...this.layers.merge(key, layer => layer.tools).values()]
  }

  /** Non-alwaysLoad deferred entries visible to a scope: total and not-yet-activated. */
  private poolStats(scope?: ScopeKey): { total: number; searchable: number } {
    let total = 0
    let searchable = 0
    for (const stored of this.allDeferred(scope)) {
      if (stored.alwaysLoad) continue
      total += 1
      if (!stored.activated) searchable += 1
    }
    return { total, searchable }
  }

  /** Run the entry's activation callback once and retain its disposer. */
  private activateStore(stored: StoredDeferred): void {
    if (stored.activated) return
    // The callback performs `ctx.tools.register(...)` and returns that exact
    // disposer, so unloading the deferred entry also unregisters the tool.
    stored.disposer = stored.reg.activate()
    stored.activated = true
  }

  /** Tear down an activated tool's real registration, if any. */
  private deactivateStore(stored: StoredDeferred): void {
    if (stored.activated) {
      stored.disposer?.()
      stored.disposer = undefined
      stored.activated = false
    }
  }

  /**
   * Read-only snapshot of every deferred entry a scope can see, as S1-05 step 3
   * consumes it: registry metadata plus the live permission verdict and score.
   */
  private discoveryEntries(query: string, scope?: ScopeKey): DeferredEntry[] {
    return this.allDeferred(scope).map(stored => ({
      name: stored.reg.name,
      description: stored.reg.description,
      ...stored.reg.searchHint !== undefined ? { searchHint: stored.reg.searchHint } : {},
      alwaysLoad: stored.alwaysLoad,
      activated: stored.activated,
      admitted: this.ctx.tools.isAdmitted(stored.reg.name, scope),
      lexicalScore: scoreStored(stored, query),
    }))
  }

  /**
   * Run one ToolSearch call: lexical baseline, discovery judgment, activation.
   * Every non-`selected` outcome (`mode: off`, any fallback, shadow) executes the
   * original lexical path, so an unconfigured deployment is byte-identical.
   */
  private async runSearch(
    query: string,
    maxResults: number,
    hits: readonly DeferredSearchHit[],
    exec: { agent?: ScopeKey | undefined; signal: AbortSignal },
  ) {
    const scope = exec.agent
    const evaluation: DiscoveryEvaluation = await this.discovery.evaluate({
      query,
      maxResults,
      actor: scope,
      scope,
      signal: exec.signal,
      lexicalNames: hits.map(hit => hit.name),
    })
    // Cancellation activates nothing and is never backfilled with lexical hits.
    if (evaluation.kind === 'cancelled') {
      return { query, message: `ToolSearch "${query}" was cancelled; nothing was loaded.`, results: [] }
    }
    const names = evaluation.kind === 'selected' ? evaluation.names : hits.map(hit => hit.name)
    // Descriptions come from the lexical hits when present (that is exactly
    // what the pre-S1-05 path rendered) and from the live entries otherwise.
    const described = new Map(hits.map(hit => [hit.name, hit.description]))
    for (const stored of this.allDeferred(scope)) described.set(stored.reg.name, described.get(stored.reg.name) ?? stored.reg.description)
    const results = names.map((name) => {
      const outcome = this.activate(name, scope)
      return {
        name: outcome.name,
        description: described.get(name) ?? '',
        status: outcome.status,
        ...outcome.status === 'denied' ? { reason: outcome.reason } : {},
      }
    })
    const { total, searchable } = this.poolStats(scope)
    return { query, message: composeSearchMessage(query, results, total, searchable), results }
  }

  /** The model-facing ToolSearch tool, registered once at construction. */
  private toolDefinition() {
    return defineTool({
      name: TOOL_SEARCH_NAME,
      description: 'Search for deferred tools that are NOT currently loaded, then load the ones you need by their name. '
        + 'Deferred tools are capabilities (e.g. filesystem, shell, or web tools) omitted from your function list to save prompt '
        + 'space. Search with the capability you need; loading a tool makes it available to call exactly like any tool defined at '
        + 'the top of the prompt. Loading is idempotent: loading an already-available tool is a harmless no-op. If a search returns '
        + 'nothing, the capability may already be available — call it directly.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'The capability or tool to find, as keywords (e.g. "read file", "edit", "bash").',
        },
        max_results: {
          type: 'number',
          description: 'How many matching deferred tools to evaluate (default 5).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            message: { type: 'string', required: true },
            results: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  status: {
                    type: 'string',
                    required: true,
                    enum: ['loaded', 'already-loaded', 'unknown', 'denied'],
                  },
                  reason: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.message,
        }],
      },
      // Arrow bodies keep `this` bound to the registry service; the schema
      // narrows args to match the parameter spec (`query` required, `max_results`
      // optional).
      execute: async (args, exec) => {
        const scope = exec.agent
        const maxResults = args.max_results ?? 5
        const hits = this.search(args.query, maxResults, scope)
        // S1-05: the judgment needs a bound agent. Without one the runtime
        // reports `unavailable` with zero host access, and the lexical hits are
        // the whole result, exactly as before.
        return this.runSearch(args.query, maxResults, hits, exec)
      },
      presentCall: (args): ToolCallView =>
        ({ card: 'generic', title: 'Search deferred tools', kind: 'search', rawInput: args.query }),
      presentResult: (_args, result): ToolResultView =>
        ({ card: 'generic', title: 'Tool search', content: result.content }),
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolSearch: DeferredToolRegistry
  }
}

export default DeferredToolRegistry
