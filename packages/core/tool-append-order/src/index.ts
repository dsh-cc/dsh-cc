/**
 * Cache-stable tool ordering over the `system-prompt/assemble` waterfall.
 *
 * DeepSeek's context cache keys on the request prefix, so the position of a
 * tool schema in the assembled `tools` array decides whether activating one
 * more tool preserves or invalidates the cached prefix. The harness orders
 * tools lexicographically at assembly (`orderTools`), which means a ToolSearch
 * activation (or an MCP registration) whose name sorts mid-alphabet shifts
 * every later tool and breaks the prefix after the first inserted position.
 *
 * This plugin is the authoritative last word on order per scope: it remembers
 * the tool-name sequence it last emitted for the scope, keeps the tools that
 * still exist at their remembered positions, and appends the newly appeared
 * ones lexicographically at the tail. The first assembly of a scope passes the
 * harness baseline through untouched (and records it), so the steady state is
 * "append-only": activations extend the tool list instead of shifting it.
 * Scope-less global assemblies pass through — there is no scope to key a
 * sequence by, and the preset's standing scope never receives them anyway.
 *
 * cordis waterfall composition gives the outermost (earliest-registered)
 * listener the final say, so this listener registers with `prepend` to be
 * outermost regardless of roster position; the preset row itself stays last
 * (the composition drift gate expects cc rows at the bottom). The Item 6 L0
 * prefix-stability e2e is the long-term sentinel for that contract.
 * @module @dsh-cc/tool-append-order
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
// Type-only: brings the `system-prompt/assemble` Context event merge into this
// program so `ctx.on` below type-checks.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'

export const name = 'tool-append-order'

/** One model-visible tool schema in an assembled prompt. */
type ToolSchema = PromptAssembly['tools'][number]

/**
 * Reorder `incoming` so the remembered sequence survives in place and new
 * tools append lexicographically at the tail. A name in `previous` that no
 * longer appears is dropped; a duplicate name in `incoming` keeps its first
 * schema.
 * @param previous - the tool names this plugin last emitted for the scope.
 * @param incoming - the harness-assembled tools (lexicographic baseline).
 * @returns the stabilized tool array.
 */
function appendStable(previous: readonly string[], incoming: ToolSchema[]): ToolSchema[] {
  const unconsumed = new Map<string, ToolSchema>()
  for (const tool of incoming) {
    if (!unconsumed.has(tool.name)) unconsumed.set(tool.name, tool)
  }
  const ordered: ToolSchema[] = []
  for (const name of previous) {
    const tool = unconsumed.get(name)
    if (tool !== undefined) {
      ordered.push(tool)
      unconsumed.delete(name)
    }
  }
  const appended = [...unconsumed.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return [...ordered, ...appended]
}

export function apply(ctx: Context): void {
  const lastEmitted = new WeakMap<ScopeKey, readonly string[]>()
  // cordis waterfall composes outermost-FIRST and the outermost listener's
  // return value is authoritative (vendor/cordis/src/events.ts:225-243), so
  // this listener must be the OUTERMOST assemble listener: only then is the
  // order it emits the order that reaches the wire (and the sequence memory
  // below records the emitted order, not a pre-transform one). Registration
  // order decides that, hence `prepend` — the roster row may stay last.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next()
    const scope = context.scope
    // Global assemblies have no scope to key a sequence by: pass through.
    if (scope === undefined) return result
    const previous = lastEmitted.get(scope)
    const ordered = previous === undefined ? result.tools : appendStable(previous, result.tools)
    lastEmitted.set(scope, ordered.map(tool => tool.name))
    // Baseline passthrough returns the assembly untouched (same reference);
    // only a reordered result is rewritten.
    return ordered === result.tools ? result : { ...result, tools: ordered }
  }, { prepend: true })
}
