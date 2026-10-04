/**
 * Static classification of an agent definition onto the ephemeral (one-shot)
 * lane, per the approved design §3.1. Pure: reads the tool allow list only
 * (post-`translateToolNames`, pre-`sanitizeToolFilter`) and never nets deny
 * lists — misclassifying a writer as ephemeral loses recoverability, so any
 * doubt resolves persistent.
 *
 * The `ephemeral` frontmatter field overrides in both directions when set;
 * when absent, classification derives from the allow list: ephemeral iff
 * every allow entry whitelist-matches.
 *
 * @module @dsh-cc/claude-code-agents/ephemeral-classifier
 */

import type { AgentDefinition } from './types.ts'

/** Exact stored tool vocabulary that may run one-shot (§3.1). */
const EPHEMERAL_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'mcp__serena__find_symbol',
  'mcp__serena__find_referencing_symbols',
  'mcp__serena__get_symbols_overview',
])

/** Serena MCP tools on the whitelist; their names may carry a hash suffix. */
const SERENA_MCP_TOOLS = [
  'mcp__serena__find_symbol',
  'mcp__serena__find_referencing_symbols',
  'mcp__serena__get_symbols_overview',
] as const

/**
 * Classify a definition as ephemeral (one-shot, no catalog residue).
 * @param definition - the parsed agent definition.
 * @returns `true` when the definition may dispatch through the one-shot lane.
 */
export function classifyEphemeral(definition: AgentDefinition): boolean {
  const override = definition.ephemeral
  if (override !== undefined) return override
  const allow = definition.toolRestriction?.allow
  if (allow === undefined || allow.length === 0) return false
  return allow.every(matchesWhitelist)
}

/**
 * Whether one stored tool name is on the ephemeral whitelist. Serena MCP
 * entries match by prefix so a future hash-suffixed public name still hits;
 * everything else is exact.
 */
function matchesWhitelist(name: string): boolean {
  if (EPHEMERAL_TOOL_WHITELIST.has(name)) return true
  return SERENA_MCP_TOOLS.some(tool => name.startsWith(`${tool}#`) || name.startsWith(`${tool}_`))
}
