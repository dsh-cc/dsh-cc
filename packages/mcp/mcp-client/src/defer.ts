/**
 * Optional ToolSearch deferral for MCP listed tools.
 *
 * Duck-typed so `src/` never imports `@dsh-cc/tool-search` — the
 * package is a test-only devDependency; production stays pluggable.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@dsh-cc/tools'

/**
 * Listed-tool count above which a server's deferrable tools register deferred
 * (searchable via ToolSearch, invisible until activated) rather than eagerly.
 */
export const DEFAULT_DEFER_TOOL_THRESHOLD = 8

/** The optional `ctx.toolSearch` seam this bridge defers through. */
export interface ToolSearchSeam {
  registerDeferred(reg: {
    name: string
    description: string
    searchHint?: string
    activate: () => () => void
  }): () => void
}

/** Resolve the optional toolSearch seam, or undefined when not mounted. */
export function toolSearchSeam(ctx: Context): ToolSearchSeam | undefined {
  const seam = ctx.get('toolSearch') as ToolSearchSeam | undefined
  if (seam === undefined || typeof seam.registerDeferred !== 'function') return undefined
  return seam
}

/**
 * Publish one listed tool: deferred through ToolSearch, or eager
 * `ctx.tools.register`. Deferred publishing detects a live foreign
 * registration up front because `reserve` cannot see one.
 */
export function publishListedTool(
  ctx: Context,
  opts: { serverName: string },
  publicName: string,
  entry: { definition: ToolDefinition; rawName: string; alwaysLoad: boolean },
  seam: ToolSearchSeam | undefined,
  deferServer: boolean,
): () => void {
  if (deferServer && !entry.alwaysLoad) {
    if (ctx.tools.get(publicName) !== undefined) {
      throw new Error(`mcp-client(${opts.serverName}): tool name "${publicName}" is already registered`)
    }
    return seam!.registerDeferred({
      name: publicName,
      description: entry.definition.description,
      searchHint: `${opts.serverName} ${entry.rawName.replaceAll('_', ' ')} ${entry.rawName}`,
      activate: () => ctx.tools.register(entry.definition),
    })
  }
  return ctx.tools.register(entry.definition)
}
