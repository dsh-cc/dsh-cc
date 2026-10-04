/**
 * Human-facing `/agents` command: list, inspect, and stop continuable
 * background agents (plan docs/plans/2026-09-05-continuable-background-ux.md
 * §3.2). Mounted INSIDE the `cc-services` realm (the pin store is
 * realm-interior, F8); the read-only snapshot is ALSO published to the root
 * realm as `ccAgents` so the TUI local-slash path — a host-plane sibling that
 * cannot resolve realm-interior mounts — consumes the SAME snapshot
 * (ccPlugins root-publication pattern).
 * @module @dsh-cc/command-agents
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { helpable } from '@dsh-cc/command-usage'
import type { ChildEntryLike } from './snapshot.ts'
import {
  buildAgentsSnapshot,
  parseAgentsInput,
  renderAgentDetail,
  renderAgentsList,
  stopNotRunningCopy,
  stopReleasedCopy,
  stopRunningCopy,
  unknownAgentCopy,
  type AgentRow,
  type SnapshotServices,
} from './snapshot.ts'
import {
  ReleaseFailure,
  renderReleaseOutcome,
  runRelease,
  isReleased,
  isReleasing,
  isTombstoned,
  type ReleaseRegistryLike,
} from './release.ts'

export const name = 'command-agents'
export const inject = ['commands', 'subagents', 'agents', 'resumePinStore']

// R8 tombstone surface: re-exported so the subagent-task grace-window mount
// and tests consume the package face, not the module internals.
export { isTombstoned, clearTombstone, tombstoneReadyRow } from './release.ts'

/** Duck-typed faces of the injected services (host-plane + realm-interior). */
interface SubagentsLike {
  listChildren(parentSessionId: SessionId): Promise<readonly ChildEntryLike[]>
  listDescendants?(rootSessionId: SessionId): Promise<readonly { id: SessionId; hasChildren?: boolean }[]>
  interrupt(targetSessionId: SessionId, authority: unknown): void
  /** The release-valve seam (D1); absent → no-drain-seam gate error. */
  drainContinuableChildren?(parent: Agent, ids: SessionId[]): Promise<void>
}
interface PinStoreLike {
  read(childId: string): unknown
  pathFor(childId: string): string
}
interface AgentsRegistryLike {
  get(id: string): { status?: string } | undefined
}
interface AgentsSnapshotService {
  list(parentSessionId: string): Promise<AgentRow[]>
}

/** Adapt the injected services to the pure snapshot seam. */
function toSnapshotServices(
  subagents: SubagentsLike,
  agents: AgentsRegistryLike,
  pinStore: PinStoreLike,
): SnapshotServices {
  return {
    listChildren: async parentSessionId => await subagents.listChildren(SessionId(parentSessionId)),
    // rc.2: `hasChildren` left the catalog rows; re-derive from the
    // descendant traversal root rows when the seam exposes it.
    ...(typeof subagents.listDescendants === 'function'
      ? {
        listDescendants: async parentSessionId =>
          await subagents.listDescendants!(SessionId(parentSessionId)),
      }
      : {}),
    getAgent: id => agents.get(id),
    readPin: childId => pinStore.read(childId) as never,
    pinPath: childId => pinStore.pathFor(childId),
    isReleased: id => isReleased(id),
    isReleasing: id => isReleasing(id),
    isTombstoned: id => isTombstoned(id),
  }
}

/** Execute one parsed `/agents` invocation against the snapshot. */
async function executeAgents(
  snapshotServices: SnapshotServices,
  subagents: SubagentsLike,
  agents: AgentsRegistryLike,
  caller: Agent,
  rawInput: string,
  signal: AbortSignal,
): Promise<CommandResult> {
  const parsed = parseAgentsInput(rawInput)
  if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }
  const parentSessionId = String(caller.session.id)
  // The release branch runs BEFORE rows.find / any snapshot fast path: the
  // authoritative drain seam, not the snapshot, decides.
  if (parsed.kind === 'release') {
    try {
      const outcome = await runRelease({
        parent: caller,
        id: parsed.id,
        subagents,
        agents: agents as ReleaseRegistryLike,
        signal,
      })
      return { kind: 'success', text: renderReleaseOutcome(outcome) }
    } catch (failure) {
      if (failure instanceof ReleaseFailure) return { kind: 'error', text: failure.message }
      throw failure
    }
  }
  if (parsed.kind === 'stop') {
    const rows = await buildAgentsSnapshot(snapshotServices, parentSessionId)
    const row = rows.find(candidate => candidate.id === parsed.id)
    if (row === undefined) return { kind: 'error', text: unknownAgentCopy(parsed.id) }
    // Symmetric stop-copy gates (D3): a released Ready row and a mid-drain
    // (releasing) row must never read "stays resumable".
    if (row.residency !== 'running') {
      if (row.released === true) {
        return { kind: 'success', text: stopReleasedCopy(parsed.id) }
      }
      return { kind: 'success', text: stopNotRunningCopy(parsed.id, row.residency) }
    }
    if (snapshotServices.isReleasing?.(parsed.id) === true) {
      return { kind: 'success', text: stopReleasedCopy(parsed.id) }
    }
    subagents.interrupt(SessionId(parsed.id), { kind: 'ancestor', agent: caller })
    return { kind: 'success', text: stopRunningCopy(parsed.id) }
  }
  const rows = await buildAgentsSnapshot(snapshotServices, parentSessionId)
  if (parsed.kind === 'list') return { kind: 'success', text: renderAgentsList(rows) }
  const row = rows.find(candidate => candidate.id === parsed.id)
  if (row === undefined) return { kind: 'error', text: unknownAgentCopy(parsed.id) }
  return {
    kind: 'success',
    text: renderAgentDetail(row, snapshotServices.readPin(parsed.id), snapshotServices.pinPath(parsed.id), parentSessionId),
  }
}

/**
 * Register the `/agents` command for every composed command adapter and
 * publish the read-only `ccAgents` snapshot service on the ROOT context so
 * host-plane siblings (the TUI local-slash path) consume the same snapshot.
 * Mirrors the CcPluginsService publication: an unload effect clears the slot
 * so consumers degrade to `undefined` instead of holding a dead service.
 * @param ctx - context carrying the command registry, subagents registry,
 *   agents registry, and pin store.
 */
export function apply(ctx: Context): void {
  const subagents = ctx.get('subagents') as unknown as SubagentsLike
  const agents = ctx.get('agents') as unknown as AgentsRegistryLike
  const pinStore = ctx.get('resumePinStore') as unknown as PinStoreLike
  const snapshotServices = toSnapshotServices(subagents, agents, pinStore)

  const root = ctx.root as unknown as {
    get(key: string, optional?: boolean): unknown
    provide(key: string, value: unknown): void
    set(key: string, value: unknown): void
  }
  const snapshotService: AgentsSnapshotService = {
    list: parentSessionId => buildAgentsSnapshot(snapshotServices, parentSessionId),
  }
  // First publication provides the name; a reclaim after an unload (or a
  // stale sibling slot) takes the publication back via set — CcPlugins
  // semantics.
  if (root.get('ccAgents', false) === undefined) {
    root.provide('ccAgents', snapshotService)
  } else {
    root.set('ccAgents', snapshotService)
  }
  ctx.effect(() => () => {
    if (root.get('ccAgents', false) === snapshotService) root.set('ccAgents', undefined)
  }, 'command-agents: clear host-realm ccAgents publication on unload')

  ctx.commands.register(helpable({
    name: 'agents',
    description: 'list, inspect, stop, or release continuable background agents',
    handler: (invocation: CommandInvocation) => executeAgents(snapshotServices, subagents, agents, invocation.agent, invocation.rawInput, invocation.signal),
  }, {
    usage: ['[<id>]'],
    subcommands: [
      { word: 'detail', args: '<id>', summary: 'Show one background agent by id (the bare form lists all)' },
      { word: 'stop', args: '<id>', summary: 'Interrupt a running agent\'s current turn (the activation stays resident; "/agents release <id>" evicts it)' },
      { word: 'release', args: '<id>', summary: 'Evict an agent\'s resident activation (and resident descendants\'), freeing its capacity slot when it was running; cooperative; one-way in this session' },
    ],
  }))
}
