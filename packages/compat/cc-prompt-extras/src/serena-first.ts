/**
 * Serena-first prompt steering for the CC preset.
 *
 * When a serena MCP server is connected, the session carries ~30
 * `mcp__serena__*` symbol tools that answer code questions without loading
 * whole files; the upstream `tool:read` / `tool:grep` guidance sections say
 * nothing about them. This plugin contributes two disjoint pieces:
 *
 * - A registered section `serena-first` (order 105, just after the upstream
 *   tool guidance band at 100–104) whose dynamic provider renders the policy
 *   paragraph while serena is ready and `''` otherwise (empty renders are
 *   dropped at render time). It is *registered*, never inserted at assemble
 *   time — nothing in the repo inserts a brand-new section into
 *   `assembly.sections` on the waterfall.
 * - A `system-prompt/assemble` waterfall listener registered with
 *   `{ prepend: true }` (cordis composes outermost-first and the outermost
 *   return value is authoritative) that replace-not-mutate appends one
 *   sentence each to the existing `tool:read` and `tool:grep` sections while
 *   serena is ready. `tool:write` / `tool:edit` / `tool:glob` are never
 *   rewritten: serena has no path-discovery equivalent, and edits keep the
 *   fs-observation-policy read-before-write gating.
 *
 * Detection is registry-only and live: a duck-typed `mcpConnections` entry
 * (the service mcp-client always provides; the same seam `command-doctor`
 * duck-types) with `state: 'ready'` and `toolCount > 0`, re-evaluated on
 * every assembly, so a mid-session disconnect stops the steering on the next
 * turn. Scope-less assemblies pass through — there is no per-scope keying
 * possible (mirrors `tool-append-order`).
 * @module @dsh-cc/serena-first
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { AssembledSection, AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'

export const name = 'serena-first'
export const inject = ['systemPrompt'] as const

/** Plugin config. */
export interface Config {
  /** Master switch; `false` renders nothing (default true). */
  enabled?: boolean
  /**
   * MCP server name; drives both detection and every emitted
   * `mcp__<serverName>__*` tool name (default 'serena').
   */
  serverName?: string
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  serverName: z.string().default('serena'),
})

/** Duck-typed `mcpConnections` entry face used here (mirrors command-doctor). */
interface McpEntry {
  readonly name: string
  readonly state: string
  readonly toolCount?: number
}

/** The sentence appended to the upstream `tool:read` section while active (leading space is deliberate). */
const READ_APPEND: Record<string, string> = {
  'tool:read': ' When serena tools are available, prefer {prefix}find_symbol and {prefix}get_symbols_overview for code questions — they navigate by symbol instead of loading whole files; use read when you need exact line-numbered content (verifying an edit site, non-code files, paths outside the serena project root).',
  'tool:grep': ' For identifier lookups, {prefix}find_referencing_symbols is usually sharper than grepping raw text.',
}

/** The registered policy section text while active. */
function policyText(serverName: string): string {
  const prefix = `mcp__${serverName}__`
  return [
    `A serena MCP server is connected. Prefer its symbol tools for code questions:`,
    `\`${prefix}find_symbol\` to locate symbols,`,
    `\`${prefix}find_referencing_symbols\` for reference lists,`,
    `\`${prefix}get_symbols_overview\` for a file's outline, and`,
    `\`${prefix}search_for_pattern\` for pattern search with symbol context.`,
    'These tools may be deferred: if they are not in your tool set yet, call `tool_search` first (for example with the query `serena find_symbol`) to activate them.',
    'An empty serena result is not proof of absence — confirm with one cheap grep or read before concluding.',
    'After two serena tool errors in this session, stop retrying serena and use the built-in read/grep/edit tools.',
    'Serena only reaches files under its project root (the session launch directory); use the built-in tools for anything outside it.',
  ].join(' ')
}

/**
 * Whether serena steering is active right now: enabled, and the configured
 * registry entry is ready with at least one tool. Registry-only: when
 * mcp-client is not mounted there are no `mcp__*` tools at all.
 */
function isActive(ctx: Context, config: Config): boolean {
  if (config.enabled !== true) return false
  const serverName = config.serverName ?? 'serena'
  const connections = ctx.get('mcpConnections') as { entries(): McpEntry[] } | undefined
  if (connections?.entries === undefined) return false
  const entry = connections.entries().find(candidate => candidate.name === serverName)
  if (entry === undefined) return false
  return entry.state === 'ready' && (entry.toolCount ?? 0) > 0
}

/**
 * Register the serena-first section and the assemble waterfall listener.
 * @param ctx - context exposing the systemPrompt service (and, in real
 *   deployments, the `mcpConnections` registry).
 * @param config - `enabled` (default true) and `serverName` (default 'serena').
 */
export function apply(ctx: Context, config: Config): void {
  const enabled = config.enabled ?? true
  const serverName = config.serverName ?? 'serena'
  const resolved: Config = { enabled, serverName }
  const prefix = `mcp__${serverName}__`

  // Contribution A: registered policy section, empty render while inactive.
  ctx.systemPrompt.section({
    name: 'serena-first',
    order: 105,
    text: (): string => (isActive(ctx, resolved) ? policyText(serverName) : ''),
  })

  // Contribution B: rewrite the texts of existing fs sections, replace-not-mutate.
  ctx.on('system-prompt/assemble', async (_assembly, context: AssembleContext, next) => {
    const result = await next()
    // Scope-less assemblies pass through: no per-scope keying is possible
    // (mirrors tool-append-order).
    if (context.scope === undefined) return result
    if (!isActive(ctx, resolved)) return result
    let changed = false
    const sections: AssembledSection[] = result.sections.map((section) => {
      const append = READ_APPEND[section.name]
      if (append === undefined) return section
      changed = true
      return { ...section, text: section.text + append.replaceAll('{prefix}', prefix) }
    })
    // Missing target sections (deployments without the fs tools) skip silently.
    return changed ? { ...result, sections } : result
  }, { prepend: true })
}
