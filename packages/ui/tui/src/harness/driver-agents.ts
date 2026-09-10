/**
 * /agents local-slash pipeline of the in-process protocol driver: the TUI
 * surface for continuable background agents. Consumes the SAME thin snapshot
 * as the preset /agents command — the read-only `ccAgents` service published
 * on the root realm by command-agents inside cc-services (plan §3.2 / F8
 * bridge). When the service is absent the fold degrades to a thin snapshot
 * over the process-wide event fold. Fold-derived decorations (provider, last
 * epoch stopReason, prompt excerpt — newline-normalized, ANSI-stripped,
 * unicode-truncated) are additive on the detail view: never different ids or
 * ordering.
 *
 * @module @dsh-cc/tui/harness/driver-agents
 */

import {
  buildAgentsSnapshot,
  parseAgentsInput,
  renderAgentDetail,
  renderAgentsList,
  stopNotRunningCopy,
  stopRunningCopy,
  unknownAgentCopy,
  type AgentRow,
} from '@dsh-cc/command-agents/snapshot'
import type { DriverRunLocalCtx } from './driver-ctx.ts'

/** The /agents slice of runLocal: one rendered status text per invocation. */
export interface AgentsSection {
  agentsSlash(rawInput: string): Promise<string>
}

export function createAgentsSection(rt: DriverRunLocalCtx): AgentsSection {
  // --- /agents: continuable background agents --------------------------------
  // Replaces the pre-existing flat subagent-activity renderer: the TUI
  // consumes the SAME thin snapshot as the preset /agents command — published
  // on the root realm as `ccAgents` by command-agents inside cc-services
  // (plan §3.2 / F8 bridge). When the service is absent (composition without
  // the command-agents row) the fold degrades to a thin snapshot over the
  // process-wide event fold only. Fold-derived decorations (provider, last
  // stopReason, prompt excerpt) are additive on the detail view — never
  // different ids or ordering.
  const agentsRows = async (): Promise<AgentRow[]> => {
    const parentSessionId = String(rt.current.agent.session.id)
    const snapshot = rt.ctx.get('ccAgents') as { list(parent: string): Promise<AgentRow[]> } | undefined
    if (snapshot !== undefined && typeof snapshot.list === 'function') {
      return snapshot.list(parentSessionId)
    }
    // Fold-only fallback: SubagentRunView rows mapped to thin snapshot rows.
    // Parked AND done runs stay visible (Ready group) — the fold is the only
    // history this composition has; a done one-shot still renders with its
    // last-epoch decoration.
    return buildAgentsSnapshot({
      listChildren: async () => rt.state().subagents.map(run => ({
        id: run.sessionId,
        activity: run.status === 'running' ? 'running' as const : 'inactive' as const,
        hasChildren: false,
        mode: 'continuable' as const,
      })),
      getAgent: id => rt.state().subagents.find(run => run.sessionId === id && run.status === 'running'),
      readPin: () => undefined,
      pinPath: () => '',
    }, parentSessionId)
  }

  /**
   * Read a session's event log through the live harness API: prefer
   * `ownEvents()`, fall back to `snapshotEvents()`, then to the legacy
   * `events` array (removed at the harness 0.1.2-rc.1 line — the old probe
   * read only that dead field and never saw anything).
   */
  const sessionEvents = (session: unknown): readonly unknown[] => {
    const s = session as {
      ownEvents?: () => readonly unknown[]
      snapshotEvents?: () => readonly unknown[]
      events?: readonly unknown[]
    } | undefined
    if (typeof s?.ownEvents === 'function') return s.ownEvents()
    if (typeof s?.snapshotEvents === 'function') return s.snapshotEvents()
    return s?.events ?? []
  }

  /**
   * ANSI/control-stripped, newline-normalized, unicode-aware-truncated prompt
   * excerpt from the child's first user message event, when the child agent's
   * session is reachable via `ctx.agents.get` (F7: the fold itself carries no
   * prompt).
   */
  const promptExcerptOf = (childId: string): string | undefined => {
    const child = (rt.ctx.agents as unknown as { get?: (id: string) => { session?: unknown } } | undefined)
      ?.get?.(childId)
    if (child === undefined) return undefined
    const events = sessionEvents((child as { session?: unknown }).session)
    if (events.length === 0) return undefined
    for (const event of events) {
      const record = event as { type?: string; data?: { role?: string; content?: unknown; text?: string } }
      if (record.type !== 'message' || record.data?.role !== 'user') continue
      const data = record.data
      const text = typeof data.text === 'string'
        ? data.text
        : Array.isArray(data.content)
          ? data.content
            .filter((block): block is { type: 'text'; text: string } =>
              block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
            .map(block => block.text)
            .join('')
          : ''
      if (text.length === 0) continue
      const normalized = text
        .replace(/\r\n?/g, ' ')
        .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
      const chars = Array.from(normalized)
      return (chars.length > 80 ? chars.slice(0, 80).join('') + '…' : normalized)
    }
    return undefined
  }

  /** Fold-derived additive detail lines (provider, last epoch, prompt excerpt). */
  const decoratedDetailOf = (row: AgentRow): string[] => {
    const run = rt.state().subagents.find(candidate => candidate.sessionId === row.id)
    if (run === undefined) return []
    const lines = [`  provider: ${run.provider}`]
    if (run.stopReason !== undefined) lines.push(`  last epoch: ${run.stopReason}`)
    const excerpt = promptExcerptOf(row.id)
    if (excerpt !== undefined) lines.push(`  prompt: "${excerpt}"`)
    return lines
  }

  const agentsSlash = async (rawInput: string): Promise<string> => {
    const parsed = parseAgentsInput(rawInput)
    if (parsed.kind === 'error') return parsed.text
    const rows = await agentsRows()
    if (parsed.kind === 'list') return renderAgentsList(rows)
    const row = rows.find(candidate => candidate.id === parsed.id)
    if (row === undefined) return unknownAgentCopy(parsed.id)
    if (parsed.kind === 'stop') {
      if (row.residency !== 'running') return stopNotRunningCopy(row.id, row.residency)
      const subagents = rt.ctx.get('subagents') as
        | { interrupt?: (id: unknown, authority: unknown) => void }
        | undefined
      if (typeof subagents?.interrupt !== 'function') {
        return `No interrupt path available for agent ${row.id} in this composition.`
      }
      subagents.interrupt(row.id, { kind: 'ancestor', agent: rt.current.agent })
      return stopRunningCopy(row.id)
    }
    const detail = renderAgentDetail(row, undefined, undefined, String(rt.current.agent.session.id))
    const decorated = decoratedDetailOf(row)
    return decorated.length === 0 ? detail : `${detail}\n${decorated.join('\n')}`
  }

  return { agentsSlash }
}
