/**
 * Agent-scope predicate: moa routes the MAIN conversation only (design §3.1
 * — "subagent spawn / fork / workflow children: never overlaid; frontmatter
 * `model:` owns them").
 *
 * A spawned subagent carries its own model — the spawn path resolves the
 * agent definition's declared alias into a routes-resolved `agentOptions`
 * override (see `@dsh-cc/subagent-task`) — so classifying a child's turn
 * into a tier would stomp that declared choice. Child turns must not
 * disturb router state either: turn numbers restart at 1 per session, so
 * an unguarded child request resets the sticky-turn tracking, a child's
 * header pair can disarm the arming machine, and a child's pre-step can
 * claim a turn slot in the shared capture map or consume the root's
 * queued status row.
 *
 * Provenance signal: the harness session header stamps a coarse
 * `origin: 'subagent'` classification for sessions created as subagent
 * children (root sessions leave it absent), plus a durable
 * `delegationDepth` that is non-zero for delegated children. The compound
 * mirrors the memory-recall listener's existing guard
 * (`packages/memory/memory/src/recall.ts`) rather than inventing a new
 * one-off. `parentSession` is deliberately NOT used: plain root-session
 * forks (a live TUI feature) carry `parentSession` without either stamp.
 * The read is defensive — the payload's agent is a structural pick, and a
 * session-less or header-less agent fail-opens to "not a subagent" so the
 * root path never regresses on an early-boot shape.
 *
 * The router's per-process slots (`lastSeenTurn`, the sticky tier,
 * `lastAppliedPair`) assume exactly ONE main agent per process once every
 * child is guarded out; that assumption is documented here, not enforced.
 *
 * @module
 */

/** Whether this agent belongs to a spawned subagent session. */
export function isSubagentAgent(agent: unknown): boolean {
  try {
    const header = (agent as
      | { session?: { header?: { origin?: unknown; delegationDepth?: unknown } } }
      | undefined
      | null)?.session?.header
    if (header === undefined || header === null) return false
    if (header.origin === 'subagent') return true
    const depth = header.delegationDepth
    return typeof depth === 'number' && depth > 0
  } catch {
    return false
  }
}
