/**
 * Load Claude Code's `.claude/agents` sub-agent definitions as dsh agent
 * presets: a pure, filesystem-backed translation that discovers the user and
 * project layers, parses and validates every `.md`/`.json` agent file, and
 * returns one {@link AgentDefinition} per agent — ready to be mounted by a
 * preset row or subagent driver.
 *
 * The loader is deliberately integration-free on purpose it is CLI-domain pure:
 * it produces typed definitions and leaves their consumption (scoped tool
 * restriction, request rewriting, permission selection) to the caller, so the
 * model-facing parts can be reused by a Claude Code plugin loader elsewhere
 * without dragging in the harness runtime.
 *
 * @module @dsh-cc/claude-code-agents
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { discoverAgents } from './discovery.ts'
import type { AgentDefinition } from './types.ts'

/** Options controlling where the loader discovers agent definitions from. */
export interface LoadOptions {
  /**
   * The user `.claude/agents` directory. Defaults to the OS home's
   * `.claude/agents`; passing your own makes the loader hermetic in tests and
   * lets a harness with a non-default home point it at the right layer.
   */
  readonly userDir?: string
}

/**
 * Load every Claude Code agent definition visible from a project root.
 *
 * The project layer is the nearest `.claude/agents` directory found by walking
 * up from `root`; it shadows the user layer on a name collision. A discovered
 * agent file that fails to parse throws with its path, so a broken agent is
 * reported, not skipped.
 * @param root - the project directory the project layer resolves from.
 * @param options - explicit user-layer override.
 * @returns the merged agent definitions, project shadowing user.
 * @throws when a discovered agent file cannot be read or parsed.
 */
export async function loadClaudeCodeAgents(
  root: string,
  options: LoadOptions = {},
): Promise<AgentDefinition[]> {
  const userDir = options.userDir ?? join(homedir(), '.claude', 'agents')
  return await discoverAgents(root, userDir)
}

export * from './types.ts'
export { discoverBundledAgents } from './bundled/index.ts'
export { loadAgentsDir, findProjectAgentsDir, discoverAgents, AGENTS_DIR, CLAUDE_DIR } from './discovery.ts'
export { parseAgentMarkdown, parseAgentJson, splitFrontmatter } from './parse.ts'
export type { ParsedMarkdown } from './parse.ts'
export { resolveToolRestriction, normalizeModel } from './restrict.ts'
