/**
 * Spawn-time pre-activation of allow-listed deferred MCP tools for a Task
 * child. A definition frontmatter naming an explicit deferred MCP tool
 * (`mcp__<server>__<tool>`) leaves the child with a reserved-but-unregistered
 * name; this module activates each such name through the duck-typed
 * `ctx.toolSearch` seam BEFORE the child starts, so the tool is registered —
 * process-globally — by the time the child's first tool assembly runs.
 *
 * Duck-typed so `src/` never imports `@dsh-cc/tool-search` — the
 * package is a test-only devDependency; production stays pluggable (mirrors
 * `packages/mcp/mcp-client/src/defer.ts`).
 *
 * @module @dsh-cc/subagent-task/preload-tools
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRestriction } from '@dsh-cc/claude-code-agents'

/** The MCP public-name prefix every bridged MCP tool carries on `ctx.tools`. */
const MCP_PUBLIC_PREFIX = 'mcp__'

/** The structural subset of the `ctx.toolSearch` seam this module needs. */
export interface ToolSearchActivateSeam {
  activate(name: string, scope?: unknown): {
    status: 'loaded' | 'already-loaded' | 'denied' | 'unknown'
    name: string
    reason?: string
  }
}

/** A structural view of the tools registry used to skip registered names. */
interface ToolsView {
  get(name: string): unknown
}

/** The outcome of one preload pass: what loaded and what did not (with why). */
export interface PreloadSummary {
  preloaded: string[]
  notices: string[]
}

/**
 * Decide whether a RAW allow entry is a wildcard form (`mcp__<server>` bare,
 * `mcp__<anything>__*` postfix, or the bare `mcp__`). Wildcards are
 * restrict-only: their expansions are preloaded by name, never via this
 * module (the expansion set is the sanitize step's business).
 */
function isWildcardEntry(name: string): boolean {
  if (!name.startsWith(MCP_PUBLIC_PREFIX)) return false
  const rest = name.slice(MCP_PUBLIC_PREFIX.length)
  return rest.length === 0 || rest.endsWith('__*') || !rest.includes('__')
}

/**
 * Pre-activate the explicit deferred MCP names a definition's `tools:` allows.
 *
 * Selection rule: iterate the RAW allow entries. An entry is a candidate iff
 * it is an explicit exact name (not a wildcard form) that survived into the
 * SANITIZED allow list, is not excluded by the sanitized deny list, and is not
 * already registered (a registered name is eager — activation is pointless).
 * Each candidate is activated for the CALLING agent scope; `loaded` and
 * `already-loaded` are silent successes, `denied`/`unknown` collect a notice
 * and warn. No-op when there is no raw allow list, no calling agent, no
 * sanitized allow list, or (single warn) no toolSearch seam.
 */
export function preloadDeferredFilterTools(opts: {
  /** The definition's RAW toolRestriction (undefined → no-op). */
  raw?: ToolRestriction | undefined
  /** The SANITIZED toolFilter the child will actually receive. */
  sanitized?: ToolRestriction | undefined
  /** The duck-typed `ctx.toolSearch` seam (undefined → single warn + no-op). */
  toolSearch?: ToolSearchActivateSeam | undefined
  /** The calling agent (`exec.agent`, undefined → no-op). */
  agent?: Agent | undefined
  /** The duck-typed tools view (`ctx.tools`) used to skip registered names. */
  tools?: ToolsView | undefined
  /** The warn sink (the context logger). */
  warn: (message: string) => void
}): PreloadSummary {
  const { raw, sanitized, toolSearch, agent, tools, warn } = opts
  if (raw?.allow === undefined || raw.allow.length === 0) return { preloaded: [], notices: [] }
  if (agent === undefined) return { preloaded: [], notices: [] }
  if (toolSearch === undefined) {
    warn(
      'cc-task: no toolSearch service is mounted, so deferred MCP tools named explicitly in a '
      + 'subagent toolFilter cannot be pre-activated at spawn; they stay searchable-only',
    )
    return { preloaded: [], notices: [] }
  }
  const sanitizedAllow = sanitized?.allow
  if (sanitizedAllow === undefined) return { preloaded: [], notices: [] }
  const sanitizedDeny = sanitized?.deny
  const preloaded: string[] = []
  const notices: string[] = []
  for (const name of raw.allow) {
    // Deferred tools live on the toolSearch registry, which in this
    // composition only ever holds MCP tools; a non-MCP harness name (read,
    // bash, reserved rows) can never be a deferred entry, and probing it
    // would only farm spurious "unknown" notices.
    if (!name.startsWith(MCP_PUBLIC_PREFIX)) continue
    if (isWildcardEntry(name)) continue
    if (!sanitizedAllow.includes(name)) continue
    if (sanitizedDeny !== undefined && sanitizedDeny.includes(name)) continue
    if (tools !== undefined && tools.get(name) !== undefined) continue
    const outcome = toolSearch.activate(name, agent)
    if (outcome.status === 'loaded' || outcome.status === 'already-loaded') {
      preloaded.push(name)
      continue
    }
    const reason = outcome.status === 'unknown'
      ? 'unknown to the toolSearch registry'
      : outcome.reason?.replace(/^"[^"]*" is /, '')
    const notice = reason !== undefined ? `${name} (${reason})` : `${name}`
    notices.push(notice)
    warn(`cc-task: could not pre-activate deferred tool "${name}" for a subagent: ${notice}`)
  }
  return { preloaded, notices }
}

/**
 * Render the preload summary as the Task result-text lines. Empty string when
 * nothing happened (nothing preloaded and no notices).
 */
export function renderPreloadLines(summary: PreloadSummary): string {
  const lines: string[] = []
  if (summary.preloaded.length > 0) {
    lines.push(`Preloaded deferred tools for child: ${summary.preloaded.join(', ')}`)
  }
  if (summary.notices.length > 0) {
    lines.push(`Not preloaded: ${summary.notices.join(', ')}`)
  }
  return lines.join('\n')
}
