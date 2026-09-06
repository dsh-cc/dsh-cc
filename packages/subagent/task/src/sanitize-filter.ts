/**
 * Sanitize a Task child's tool restriction against the live restrictable-name
 * set: MCP wildcards expand, unknown names drop, an emptied allow-list is
 * deny-all, and ToolSearch is auto-injected when the child holds MCP names.
 *
 * @module @dsh-cc/subagent-task/sanitize-filter
 */

import type { ToolRestriction } from '@dsh-cc/claude-code-agents'

/**
 * The MCP public-name prefix every bridged MCP tool carries on `ctx.tools`.
 */
const MCP_PUBLIC_PREFIX = 'mcp__'

/**
 * Expand one raw filter entry into the concrete names it asks for.
 *
 * - Anything not MCP-qualified passes through untouched (it is then gated by
 *   the `knownNames` check).
 * - A bare `mcp__` (no server segment) is dropped with a loud warning — it
 *   can never name a mounted tool.
 * - `mcp__<server>` (no third segment) and `mcp__<server>__*` expand to every
 *   known MCP tool of that server (`mcp__<server>__` prefix), so frontmatter
 *   survives servers publishing new tools without a hash-suffix dance.
 * - An exact `mcp__<server>__<tool>` passes through as written (the caller
 *   must use the public name, including any identity-hash suffix).
 */
function expandFilterName(
  rawName: string,
  knownNames: ReadonlySet<string>,
  warn: (m: string) => void,
): readonly string[] {
  if (!rawName.startsWith(MCP_PUBLIC_PREFIX)) return [rawName]
  const rest = rawName.slice(MCP_PUBLIC_PREFIX.length)
  if (rest.length === 0) {
    warn('cc-task: invalid MCP wildcard "mcp__" in a subagent toolFilter — expected mcp__<server> or mcp__<server>__<tool>')
    return []
  }
  const server = rest.endsWith('__*')
    ? rest.slice(0, -'__*'.length)
    : rest.includes('__')
      ? undefined
      : rest
  if (server === undefined) return [rawName]
  if (server.length === 0) {
    warn(`cc-task: invalid MCP wildcard "${rawName}" in a subagent toolFilter — expected mcp__<server> or mcp__<server>__<tool>`)
    return []
  }
  return [...knownNames].filter(name => name.startsWith(`${MCP_PUBLIC_PREFIX}${server}__`))
}

/**
 * Sanitize a definition's tool restriction against the LIVE set of names the
 * tools registry knows (registered or reserved — `ctx.tools.view(callingAgent)
 * .restrictableNames`, read at execute time so deferred MCP reservations on
 * the standing-scope layer are included).
 *
 * Rules:
 * - A name survives only when the registry knows it. Everything else is
 *   dropped with a warning; there is no static legal-names set, so mounted
 *   MCP tools and any future registered row are accepted without code churn.
 * - If the filter carried an `allow` list and any kept allow name is an MCP
 *   tool while `ToolSearch` is itself restrictable, `ToolSearch` is appended
 *   (deduped): the child otherwise holds MCP names with no load path.
 * - If the filter carried an `allow` list and sanitization left nothing, the
 *   result is `{ allow: [] }` — omitting `allow` would WIDEN the child to
 *   every tool, so an emptied allow-list is pinned as deny-all, loudly.
 */
export function sanitizeToolFilter(
  filter: ToolRestriction,
  warn: (m: string) => void,
  knownNames: ReadonlySet<string>,
): ToolRestriction {
  const clean = (names: readonly string[]): string[] => {
    const out: string[] = []
    for (const rawName of names) {
      for (const expanded of expandFilterName(rawName, knownNames, warn)) {
        if (knownNames.has(expanded)) {
          if (!out.includes(expanded)) out.push(expanded)
        } else {
          warn(`cc-task: dropping unknown tool name "${expanded}" from a subagent toolFilter`)
        }
      }
    }
    return out
  }
  const hadAllow = filter.allow !== undefined
  const allow = filter.allow !== undefined ? clean(filter.allow) : undefined
  const deny = filter.deny !== undefined ? clean(filter.deny) : undefined
  if (hadAllow && allow !== undefined && allow.length > 0 && allow.some(name => name.startsWith(MCP_PUBLIC_PREFIX))
    && knownNames.has('ToolSearch') && !allow.includes('ToolSearch')) {
    allow.push('ToolSearch')
  }
  if (hadAllow && (allow === undefined || allow.length === 0)) {
    warn(
      'cc-task: a subagent toolFilter allow-list matched no mounted tools '
      + `(originals: ${(filter.allow ?? []).join(', ')}); the child will run with zero tools`,
    )
  }
  return {
    ...(hadAllow ? { allow: allow ?? [] } : {}),
    ...(deny !== undefined && deny.length > 0 ? { deny } : {}),
  }
}
