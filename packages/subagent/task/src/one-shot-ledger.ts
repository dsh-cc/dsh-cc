/**
 * Process-level one-shot subagent ledger (memory-recall hardening follow-ups
 * W2a, `docs/plans/2026-09-09-memory-recall-hardening-followups.md` §2 W2):
 * one shared `subagent/start` + `subagent/end` listener pair (mirroring
 * `epoch-collector.ts` wiring) folds every run the process observes into
 * rows keyed by runId.
 *
 * Pairing is BY RUN ID, never by child id: a cold-resumed child gets a new
 * runId and must not satisfy a stale watcher (epoch-collector's documented
 * lesson). Parentage resolves from the child's session header
 * `parentSession` via the `agents` seam (`ctx.agents.get(id)`), the same
 * probe the TUI driver uses; unresolvable parentage is kept but treated as
 * unscoped and never injected into any session's context.
 *
 * Internal (infra-fork) classification prefers the child's session
 * descriptor metadata — the `subagent/descriptor` event's `label` — falling
 * back to nothing (a child with no descriptor label is never internal on
 * label grounds). {@link INTERNAL_LABELS} lists the production labels that
 * must always classify as internal; a completeness test pins it.
 *
 * Rows prune by TTL both after ending AND while active (a crashed child may
 * never emit `end`); an `end` arriving after its row was pruned is a no-op.
 *
 * @module @dsh-cc/subagent-task/one-shot-ledger
 */

/** Production labels that mark a child as internal dsh-cc infrastructure. */
export const INTERNAL_LABELS: readonly string[] = [
  // packages/memory/memory/src/recall.ts (the recall selector)
  'memory-recall',
  // packages/memory/memory-consolidation/src/index.ts (startMemoryJob call sites)
  'extract-memories',
  'memory-consolidation',
  // packages/hooks/hooks-claude-code/src/dispatch.ts (CC hook bridge forks)
  'hook-prompt',
  'hook-agent',
]

/** One observed subagent run. */
export interface OneShotLedgerRow {
  /** Unique identity shared by the paired start/end events. */
  runId: string
  /** The child agent's (session) id. */
  id: string
  /** Provider name snapshot from the events. */
  provider: string
  /** Creation label from the child's session descriptor, when enumerable. */
  label?: string
  /** Parent session id resolved from the child's session header, when resolvable. */
  parentId?: string
  /** Wall-clock ms when the start event arrived. */
  startedAt: number
  /** Wall-clock ms when the paired end event arrived. */
  endedAt?: number
  /** Terminal stop reason from the end event. */
  stopReason?: string
  /** True when the child is internal dsh-cc infrastructure (descriptor label ∈ {@link INTERNAL_LABELS}). */
  internal: boolean
  /** Descriptor mode snapshot when enumerable (`one-shot` / `continuable`). */
  mode?: string
}

/** Duck-typed `ctx.agents` accessor for child-session parentage probes. */
export interface LedgerAgents {
  get?(id: string): {
    session?: {
      id?: unknown
      header?: { parentSession?: unknown }
      events?: readonly { type?: string; data?: { label?: unknown; mode?: unknown } }[]
    }
  } | undefined
}

/** Duck-typed event bus (cordis `ctx.on`) the lifecycle events arrive on. */
export interface LedgerEventBus {
  on(event: string, listener: (info: Record<string, unknown>) => void): (() => void) | void
}

export interface OneShotLedgerDeps {
  /** The bus the shared listener pair subscribes to. */
  bus: LedgerEventBus
  /** The live agent registry (`ctx.agents`) used for parentage/label probes. */
  agents?: LedgerAgents
  /** Wall clock; defaults to `Date.now`. */
  now?: () => number
  /** How long an ended row stays queryable. Default 5 minutes. */
  endedTtlMs?: number
  /** How long a never-ended (active) row stays queryable. Default 60 minutes. */
  activeTtlMs?: number
}

export const DEFAULT_ENDED_TTL_MS = 5 * 60_000
export const DEFAULT_ACTIVE_TTL_MS = 60 * 60_000

function resolveDescriptor(child: NonNullable<ReturnType<LedgerAgents['get']>> | undefined): {
  label?: string
  mode?: string
} {
  const event = child?.session?.events?.find(e => e.type === 'subagent/descriptor')
  if (event === undefined) return {}
  return {
    ...event.data?.label !== undefined ? { label: String(event.data.label) } : {},
    ...event.data?.mode !== undefined ? { mode: String(event.data.mode) } : {},
  }
}

function resolveParentId(child: NonNullable<ReturnType<LedgerAgents['get']>> | undefined): string | undefined {
  const parent = child?.session?.header?.parentSession
  return parent === undefined || parent === null || parent === '' ? undefined : String(parent)
}

/**
 * Create the ledger and attach its shared `subagent/start` / `subagent/end`
 * listener pair to the bus (mirrors `epoch-collector`'s shared-watcher
 * wiring). The returned handle prunes lazily on every read.
 */
export function createOneShotLedger(deps: OneShotLedgerDeps): {
  rows(): readonly OneShotLedgerRow[]
  activeFor(parentId: string): readonly OneShotLedgerRow[]
  dispose(): void
} {
  const now = deps.now ?? Date.now
  const endedTtlMs = deps.endedTtlMs ?? DEFAULT_ENDED_TTL_MS
  const activeTtlMs = deps.activeTtlMs ?? DEFAULT_ACTIVE_TTL_MS
  // Rows the ledger keeps, keyed by runId (one row per epoch).
  const rowsByRunId = new Map<string, OneShotLedgerRow>()
  const offStart = deps.bus.on('subagent/start', info => {
    const id = String(info.id)
    const child = deps.agents?.get?.(id)
    const descriptor = resolveDescriptor(child)
    const label = descriptor.label
    rowsByRunId.set(String(info.runId), {
      runId: String(info.runId),
      id,
      provider: String(info.provider),
      ...label !== undefined ? { label } : {},
      ...resolveParentId(child) !== undefined ? { parentId: resolveParentId(child) } : {},
      startedAt: now(),
      internal: label !== undefined && INTERNAL_LABELS.includes(label),
      ...descriptor.mode !== undefined ? { mode: descriptor.mode } : {},
    })
  })
  const offEnd = deps.bus.on('subagent/end', info => {
    const runId = String(info.runId)
    const row = rowsByRunId.get(runId)
    if (row === undefined) return // pruned or never started: a no-op
    row.endedAt = now()
    row.stopReason = String(info.stopReason)
  })
  const prune = (): void => {
    const t = now()
    for (const [runId, row] of rowsByRunId) {
      if (row.endedAt !== undefined ? t - row.endedAt > endedTtlMs : t - row.startedAt > activeTtlMs) {
        rowsByRunId.delete(runId)
      }
    }
  }
  return {
    rows(): readonly OneShotLedgerRow[] {
      prune()
      return [...rowsByRunId.values()]
    },
    activeFor(parentId: string): readonly OneShotLedgerRow[] {
      prune()
      return [...rowsByRunId.values()].filter(row =>
        row.parentId === parentId && row.endedAt === undefined
        // Unresolvable parentage is never scoped to any session.
        && row.parentId !== undefined)
    },
    dispose(): void {
      offStart?.()
      offEnd?.()
    },
  }
}
