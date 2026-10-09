/**
 * Process-live delegation lineage (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §3.2 "Lineage lift"):
 * a session-id → Session registry fed by the `session/event` firehose, a
 * lazily-learned `parents` map (`header.parentSession`, memoized per session),
 * and per-root lift buckets of claim-relevant child evidence. Walks are
 * depth-bounded (≤8) and cycle-guarded. `stampedOrdinal` counts genuine
 * `user/message` events in the ROOT session's CURRENT snapshot view — the
 * ONE counting procedure shared with the evaluate-side window start (§3.3),
 * so stamps and window ordinals can never drift.
 *
 * @module @dsh-cc/completion-gate/lineage
 */

/** The delegation tool ids whose receipts can indicate delegated work (§5.13). */
export const DELEGATION_TOOL_IDS: readonly string[] = ['subagent_fork', 'workflow', 'ralph']

/** Max parent-chain depth (§3.2). */
export const MAX_LINEAGE_DEPTH = 8

/** One lifted child-receipt entry pushed onto the root's bucket. */
export interface LiftEntry {
  tool: string
  head?: string
  stampedOrdinal: number
}

/** Structural minimum of the Session face used here (duck-typed in tests). */
export interface SessionLike {
  header?: { id?: unknown; parentSession?: unknown }
  snapshotEvents(): readonly unknown[]
}

/** Structural minimum of a receipt the lift needs (claim-relevant fields only). */
export interface ReceiptLiftInput {
  sessionId: string | null
  tool: string
  head?: string
}

/**
 * Count genuine `user/message` events (§3.3 predicate: `data.source` absent,
 * or `data.source.kind === 'user'`). Exported — the evaluate side reuses this
 * exact function for the window-start ordinal (§3.2 anti-drift pin).
 */
export function countGenuineUserMessages(events: readonly unknown[]): number {
  let count = 0
  for (const event of events) {
    const e = event as { type?: unknown; data?: { source?: { kind?: unknown } } }
    if (e.type !== 'user/message') continue
    const source = e.data?.source
    if (source === undefined || source === null || source.kind === 'user') count += 1
  }
  return count
}

/** Walk to the lineage root: depth-bounded and cycle-guarded (§3.2). */
export function walkRoot(sessionId: string, parents: ReadonlyMap<string, string>, maxDepth: number = MAX_LINEAGE_DEPTH): string {
  let current = sessionId
  const visited = new Set<string>([current])
  for (let depth = 0; depth < maxDepth; depth++) {
    const parent = parents.get(current)
    if (parent === undefined) break
    if (visited.has(parent)) break // cycle guard
    visited.add(parent)
    current = parent
  }
  return current
}

/**
 * Degraded-horizon rule (§3.4): when the window contains ≥1 delegation
 * receipt but NO child session was witnessed in-process, the evidence horizon
 * is degraded — skip nudging (the claim's proof may live in an unwitnessed
 * child, e.g. right after `/resume` reboots the process-live map).
 */
export function horizonDegraded(
  windowReceipts: readonly { tool: string }[],
  witnessedChildren: number,
): boolean {
  return witnessedChildren === 0
    && windowReceipts.some(receipt => DELEGATION_TOOL_IDS.includes(receipt.tool))
}

/** Process-live lineage registry. */
export class LineageRegistry {
  /** sessionId → parentSessionId, learned lazily at record time (§3.2). */
  readonly parents = new Map<string, string>()
  /** rootSessionId → lifted child receipts. */
  readonly lifts = new Map<string, LiftEntry[]>()
  private readonly sessions = new Map<string, WeakRef<SessionLike>>()

  /** Register a live session from the `session/event` firehose. */
  witness(session: SessionLike): void {
    const id = this.idOf(session)
    if (id === undefined) return
    this.sessions.set(id, new WeakRef(session))
    this.learnParent(id, session)
  }

  /** Live session lookup (deref may already be collected). */
  lookup(sessionId: string): SessionLike | undefined {
    return this.sessions.get(sessionId)?.deref()
  }

  /**
   * Record one receipt's lineage: learn the parent lazily, and when the
   * receipt's session walks to a DIFFERENT root, push a lift entry onto the
   * root's bucket with the root's CURRENT genuine-user ordinal (§3.2).
   */
  record(session: SessionLike | undefined, receipt: ReceiptLiftInput): void {
    const sessionId = receipt.sessionId
    if (sessionId === null) return
    if (session !== undefined) {
      this.sessions.set(sessionId, new WeakRef(session))
      this.learnParent(sessionId, session)
    }
    const root = walkRoot(sessionId, this.parents)
    if (root === sessionId) return
    const rootSession = this.lookup(root)
    const stampedOrdinal = rootSession === undefined ? 0 : countGenuineUserMessages(rootSession.snapshotEvents())
    const bucket = this.lifts.get(root)
    const entry: LiftEntry = { tool: receipt.tool, stampedOrdinal }
    if (receipt.head !== undefined) entry.head = receipt.head
    if (bucket === undefined) this.lifts.set(root, [entry])
    else bucket.push(entry)
  }

  /** Lifted child receipts for a root session id. */
  liftsFor(rootSessionId: string): readonly LiftEntry[] {
    return this.lifts.get(rootSessionId) ?? []
  }

  /** Number of distinct witnessed child sessions of one session id. */
  witnessedChildren(sessionId: string): number {
    let count = 0
    for (const [child, parent] of this.parents) {
      if (parent === sessionId || walkRoot(child, this.parents) === sessionId) count += 1
    }
    return count
  }

  private idOf(session: SessionLike): string | undefined {
    const id = session.header?.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }

  private learnParent(sessionId: string, session: SessionLike): void {
    if (this.parents.has(sessionId)) return
    const parent = session.header?.parentSession
    if (typeof parent === 'string' && parent.length > 0) this.parents.set(sessionId, parent)
  }
}
