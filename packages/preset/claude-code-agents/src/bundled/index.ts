/**
 * Bundled agents shipped with this compatible provider.
 *
 * A small set of read-only utility agents modeled on Claude Code's built-in
 * sub-agents (the Explore scout and a product-docs guide), authored as
 * Claude Code agent markdown and served directly from this package — no disk
 * extraction. They are provided with `source: 'bundled'`, the lowest rank of
 * the {@link AgentSource} precedence: a user-layer or project-layer
 * `.claude/agents` file of the same name shadows its bundled namesake,
 * matching Claude Code's precedence where local agents override built-ins.
 *
 * @module @dsh-cc/claude-code-agents/bundled
 */

import { parseAgentMarkdown } from '../parse.ts'
import type { AgentDefinition } from '../types.ts'
import { AGENT_MD as GUIDE_MD, name as guideName } from './dsh-cc-guide.ts'
import { AGENT_MD as EXPLORE_MD, name as exploreName } from './explore.ts'

const ENTRIES: readonly { readonly name: string; readonly md: string }[] = [
  { name: exploreName, md: EXPLORE_MD },
  { name: guideName, md: GUIDE_MD },
]

/**
 * Parse the in-package bundled agent set. A document that fails to parse
 * throws — the same loud failure a broken project agent gets, since a bundled
 * agent shipping malformed frontmatter is a package bug, not a user error.
 * @returns one definition per bundled agent, in declaration order.
 * @throws when a bundled document cannot be parsed.
 */
export function discoverBundledAgents(): AgentDefinition[] {
  return ENTRIES.map(({ name, md }) =>
    parseAgentMarkdown(`bundled:${name}/${name}.md`, md, 'bundled'))
}
