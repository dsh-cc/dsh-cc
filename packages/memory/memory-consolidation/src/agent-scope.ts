/**
 * Agent topology helpers shared by the two memory lanes (extraction and dream):
 * which workspace a memory directory resolves from, and whether an agent is
 * allowed to spawn memory work at all.
 *
 * @module @dsh-cc/memory-consolidation/agent-scope
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'

/** The agent's workspace cwd: where its memory directory is resolved from. */
export function agentCwd(agent: Agent): string {
  return agent.session.header.cwd ?? process.cwd()
}

/**
 * Whether an agent is top-level (not a delegated subagent). This is the root
 * fix for the extraction/dream recursion: a subagent's own turn-end must never
 * spawn another memory fork. Fails CLOSED — any throw from reading the depth
 * treats the agent as a child so nothing is spawned.
 * @param agent - the agent whose turn is stopping.
 * @returns whether memory work may start for it.
 */
export function isTopLevel(agent: Agent): boolean {
  try {
    return delegationDepthOf(agent) === 0
  } catch {
    return false
  }
}
