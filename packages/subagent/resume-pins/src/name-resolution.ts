/**
 * rc.5 name targeting for the harness control tools (plan §3.3, R2): at
 * rc.5 `send_message`/`interrupt_agent` address their target by the
 * model-facing NAME (`arguments.agent` — `lead`, a slash path, or a bare
 * token that falls back to Session-id semantics when no name matches), and
 * the `agent_id`/`subagent_id` argument keys are gone. The resume-pin
 * gates key pins, tombstones, and the admission lease by the child Session
 * id, so each reader resolves the argument through
 * `ctx.subagents.resolveName(sender, agent, signal)` before comparing.
 *
 * Resolution is BEST-EFFORT: the service throws when a foreign slash path
 * names no tree member (`AGENT_NAME_NOT_FOUND`), when the composition
 * lacks the sessionQuery service needed to walk catalogs, and when no
 * subagents service is mounted at all. Every helper here returns
 * `undefined` for "could not attribute the target" — a gate must NEVER
 * block a legitimate message on that evidence alone. The caller decides
 * the degradation: refusing gates (tombstone, pin admission) pass the
 * message through untouched; layers that can never refuse (the admission
 * lease; the delegation advisory) fall back to the raw token.
 *
 * @module @dsh-cc/subagent-resume-pins/name-resolution
 */

/**
 * The duck-typed slice of the subagents service the gates consult, kept
 * structural so hermetic unit rigs keep faking it without the harness
 * service class.
 */
export interface SendTargetSubagents {
  resolveName?: (caller: unknown, agent: string, signal: AbortSignal | undefined) => Promise<unknown>
  rootOf?: (caller: unknown) => { id: unknown } | undefined
  listDescendants?: (rootId: unknown, signal?: AbortSignal) => Promise<readonly { id: unknown; path?: string }[]>
}

/** Read the subagents service off a cordis Context or a literal test rig. */
function subagentsOf(ctx: unknown): SendTargetSubagents | undefined {
  return (ctx as { subagents?: SendTargetSubagents } | null | undefined)?.subagents
}

/**
 * Resolve one harness control-tool `agent` argument to the Session id the
 * service will deliver to (the same service method the tools themselves
 * call). Returns `undefined` when the sender is absent, the service or
 * method is missing, or resolution throws — the documented pass-through.
 *
 * @param ctx - gate context (cordis Context or unit-test rig).
 * @param sender - `exec.agent` of the tool execution; resolution anchors
 *   at its tree root.
 * @param agent - the raw `arguments.agent` string.
 * @param signal - `exec.signal` (forwarded to catalog reads).
 */
export async function resolveSendTarget(
  ctx: unknown,
  sender: unknown,
  agent: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (sender === undefined || sender === null) return undefined
  const service = subagentsOf(ctx)
  if (typeof service?.resolveName !== 'function') return undefined
  try {
    const resolved: unknown = await service.resolveName(sender, agent, signal)
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : undefined
  } catch {
    return undefined
  }
}

/**
 * Map every descendant id in the sender's subagent tree to the strings a
 * `list_agents` row may render for it: the durable id itself plus, when
 * every link below the root is named, the model-facing slash path (rc.5
 * renders `entry.path ?? entry.id`; harness list-agents.ts). Returns
 * `undefined` when the tree cannot be read (no service/sessionQuery, dead
 * root) — callers fall back to id-only matching.
 *
 * @param ctx - gate context (cordis Context or unit-test rig).
 * @param sender - the list_agents caller (`exec.agent`).
 * @param signal - `exec.signal` (forwarded to catalog reads).
 */
export async function renderedAgentAddresses(
  ctx: unknown,
  sender: unknown,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, readonly string[]> | undefined> {
  if (sender === undefined || sender === null) return undefined
  const service = subagentsOf(ctx)
  if (typeof service?.rootOf !== 'function' || typeof service.listDescendants !== 'function') {
    return undefined
  }
  try {
    const root = service.rootOf(sender)
    if (root === undefined) return undefined
    const entries = await service.listDescendants(root.id, signal)
    const addresses = new Map<string, readonly string[]>()
    for (const entry of entries) {
      const id = String(entry.id)
      addresses.set(id, typeof entry.path === 'string' && entry.path.length > 0 ? [id, entry.path] : [id])
    }
    return addresses
  } catch {
    return undefined
  }
}
