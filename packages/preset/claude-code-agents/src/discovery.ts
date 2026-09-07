/**
 * Discover Claude Code agent definition files across the bundled, user, and
 * project layers and load each into an {@link AgentDefinition}.
 *
 * The project layer is the nearest `.claude/agents` directory found by walking
 * up from the project root (a `.claude` directory at any ancestor defines the
 * project scope, exactly as Claude Code resolves it). The user layer is the
 * author's own `~/.claude/agents`. A definition is keyed by its file basename;
 * the layers shadow by rank — bundled (in-package, always present) is lowest,
 * the user layer shadows bundled, and the project layer SHADOWS the user layer
 * on a name collision (nearest wins), mirroring how a project-level agent
 * overrides a user-level one and either overrides a built-in.
 *
 * Every file that looks like an agent (a `.md` or `.json` in either directory)
 * is loaded, and a file that fails to parse raises — discovery is intentionally
 * loud rather than silent, so a broken agent is fixed, not forgotten. Unknown
 * files in the same directory are skipped.
 *
 * @module @dsh-cc/claude-code-agents/discovery
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { discoverBundledAgents } from './bundled/index.ts'
import { parseAgentJson, parseAgentMarkdown } from './parse.ts'
import type { AgentDefinition, AgentSource } from './types.ts'

/** The Claude Code agents directory name inside `.claude`. */
export const AGENTS_DIR = 'agents'

/** The `.claude` directory name beneath a project or the user home. */
export const CLAUDE_DIR = '.claude'

/** The supported agent-definition file suffixes, saturated or `.md`. */
const MARKDOWN_SUFFIX = '.md'
const JSON_SUFFIX = '.json'

/**
 * Resolve the nearest `.claude/agents` directory by walking upward from
 * `start`, or the user `.claude/agents` when given as the user source.
 * @param start - the directory to begin the upward walk from.
 * @returns the resolved agent directory path, or `undefined` when no ancestor
 *   owns a `.claude/agents` directory.
 */
export async function findProjectAgentsDir(start: string): Promise<string | undefined> {
  let current = start
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = join(current, CLAUDE_DIR, AGENTS_DIR)
    if (await isDirectory(candidate)) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Whether `path` names an existing directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Read and parse every agent file in one `.claude/agents` directory.
 * @param dir - the `.claude/agents` directory to scan.
 * @param source - the layer the directory belongs to.
 * @returns one agent per `.md`/`.json` file, ordered by filename (`.md` then
 *   `.json`, each alphabetical).
 * @throws when a file exists but cannot be read or parsed.
 */
export async function loadAgentsDir(dir: string, source: AgentSource): Promise<AgentDefinition[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // An absent or unreadable directory supplies no agents; the caller decides
    // whether that is an error (a configured project layer usually is not).
    return []
  }
  const names = entries
    .filter(name => name.endsWith(MARKDOWN_SUFFIX) || name.endsWith(JSON_SUFFIX))
    .sort()
  const agents: AgentDefinition[] = []
  for (const name of names) {
    const path = join(dir, name)
    const text = await readFile(path, 'utf8')
    agents.push(name.endsWith(JSON_SUFFIX)
      ? parseAgentJson(path, text, source)
      : parseAgentMarkdown(path, text, source))
  }
  return agents
}

/**
 * Load every agent definition visible from a project root: the project layer
 * (nearest `.claude/agents` walking up) shadowing the user layer
 * (`~/.claude/agents`), both shadowing the bundled in-package agents. A file
 * that fails to parse throws; the caller keeps the project root and user home
 * that produced a failure.
 * @param projectRoot - the project directory to resolve the project layer from.
 * @param userDir - the user `.claude/agents` directory; `undefined` to skip the
 *   user layer (used by callers that pass an explicit home).
 * @returns the merged agent list, project shadowing user shadowing bundled.
 * @throws when a discovered agent file cannot be parsed.
 */
export async function discoverAgents(
  projectRoot: string,
  userDir?: string,
): Promise<AgentDefinition[]> {
  const projectDir = await findProjectAgentsDir(projectRoot)
  const project = projectDir === undefined ? [] : await loadAgentsDir(projectDir, 'project')
  const user = userDir === undefined ? [] : await loadAgentsDir(userDir, 'user')

  const byName = new Map<string, AgentDefinition>()
  for (const agent of discoverBundledAgents()) byName.set(agent.agentType, agent)
  for (const agent of user) {
    if (skipColonAgent(agent)) continue
    byName.set(agent.agentType, agent)
  }
  for (const agent of project) {
    if (skipColonAgent(agent)) continue
    byName.set(agent.agentType, agent)
  }
  return Array.from(byName.values())
}

/**
 * File-registry colon guard: a workspace file definition whose `agentType`
 * contains `:` is warned and skipped, so it can never occupy or shadow the
 * plugin scoped-id namespace (`plugin:agent`). This guard lives ONLY in the
 * discovery path — never in the shared parse layer (`loadAgentsDir`), which
 * the plugin loader also uses and whose subdirectory agentTypes legitimately
 * carry `:`.
 */
function skipColonAgent(agent: AgentDefinition): boolean {
  if (!agent.agentType.includes(':')) return false
  console.warn(`claude-code-agents: skipping agent "${agent.agentType}" from ${agent.baseDir}: agent file names must be bare (a colon agent type would shadow plugin scoped ids)`)
  return true
}
