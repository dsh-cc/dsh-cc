/**
 * Per-workspace discovery of Claude Code `.claude/agents` definitions.
 *
 * The host process serves many workspaces at once, so discovery is keyed by
 * the session's cwd (`cwdOf(agent)`) rather than the process cwd — a web host
 * started from `~/.dsh` must still see `my-repo/.claude/agents`. Results are
 * cached per root for the process lifetime: the registry does not watch the
 * filesystem (v1), so editing an agent file takes effect on the next session
 * for a workspace whose cache entry has not yet been created, and on process
 * restart otherwise.
 *
 * @module @dsh-cc/subagent-task/registry
 */

import { loadClaudeCodeAgents } from '@dsh-cc/claude-code-agents'
import type { AgentDefinition } from '@dsh-cc/claude-code-agents'

/** Options for the registry, mostly injectable seams for tests. */
export interface AgentRegistryOptions {
  /** Override the user `.claude/agents` layer (hermetic tests). */
  userDir?: string
}

/**
 * A process-level cache of discovered agent definitions keyed by workspace
 * root. Discovery runs lazily on first use of a root; the cached promise is
 * shared so concurrent pre-steps for the same workspace scan once.
 */
export class AgentRegistry {
  private readonly cache = new Map<string, Promise<ReadonlyMap<string, AgentDefinition>>>()

  constructor(private readonly options: AgentRegistryOptions = {}) {}

  /**
   * Ensure the definitions for one workspace root are loaded (once).
   * @param root - the session workspace (the project layer root).
   * @returns the merged definition map (project shadows user), or an empty map.
   */
  ensure(root: string): Promise<ReadonlyMap<string, AgentDefinition>> {
    let pending = this.cache.get(root)
    if (pending === undefined) {
      pending = loadClaudeCodeAgents(root, {
        ...this.options.userDir !== undefined ? { userDir: this.options.userDir } : {},
      }).then(defs => {
        const map = new Map<string, AgentDefinition>()
        for (const def of defs) map.set(def.agentType, def)
        return map
      })
      this.cache.set(root, pending)
    }
    return pending
  }

  /**
   * List every definition visible from one workspace root.
   * @param root - the session workspace.
   * @returns definitions sorted by name (project entries shadow user ones).
   */
  async list(root: string): Promise<readonly AgentDefinition[]> {
    const map = await this.ensure(root)
    return [...map.values()].sort((a, b) => a.agentType.localeCompare(b.agentType))
  }

  /**
   * Resolve one definition by its frontmatter `name`.
   * @param root - the session workspace.
   * @param type - the requested `subagent_type`.
   * @returns the definition, or undefined when the type is unknown here.
   */
  async resolve(root: string, type: string): Promise<AgentDefinition | undefined> {
    const map = await this.ensure(root)
    return map.get(type)
  }
}
