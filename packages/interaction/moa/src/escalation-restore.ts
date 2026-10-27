import { MOA_ESCALATION_KIND, type EscalationBookkeeping } from './state.ts'

type Escalation = { fromTier: number; toTier: number }

/** The typed `moa-escalation` followup source that opens a retry round. */
export type OpeningSource = { originSeq: number } & Escalation

/**
 * F-3: every durable `moa-escalation` followup of one origin, read from the
 * agent's session log (the opening's own record is always included, so the
 * result is non-empty when the opening has not yet been appended). A chain's escalations are strictly increasing, so the
 * `(fromTier, toTier)` pair identifies one escalation.
 */
export function durableEscalations(
  agent: unknown,
  opening: OpeningSource,
): Escalation[] {
  const out: Escalation[] = []
  const session = (agent as { session?: { snapshotEvents?: () => readonly unknown[] } } | undefined)?.session
  const events = (session?.snapshotEvents?.() ?? []) as {
    seq?: number
    type?: string
    data?: { source?: { kind?: string; originSeq?: unknown; fromTier?: unknown; toTier?: unknown } }
  }[]
  for (const event of events) {
    const source = event.data?.source
    if (event.type !== 'user/message' || source?.kind !== MOA_ESCALATION_KIND || source.originSeq !== opening.originSeq) continue
    if (typeof source.fromTier !== 'number' || typeof source.toTier !== 'number') {
      throw new Error(`malformed escalation record for origin ${opening.originSeq}`)
    }
    out.push({ fromTier: source.fromTier, toTier: source.toTier })
  }
  // The opening itself is one of the escalations: add it unless the log already holds it.
  if (!out.some((e) => e.fromTier === opening.fromTier && e.toTier === opening.toTier)) {
    out.push({ fromTier: opening.fromTier, toTier: opening.toTier })
  }
  return out
}

/**
 * F-3: restore the escalation floor of `opening`'s origin from the durable
 * session log when the in-memory entry is missing or lower than the record
 * (crash/resume between escalation dispatch and the retry round). Never fails
 * open: a malformed record is refused loudly and the caller serves the live
 * selection explicitly.
 * @returns the restored floor; undefined after a warn (live selection served).
 */
export function restoreEscalationFloor(
  bookkeeping: EscalationBookkeeping,
  agent: unknown,
  opening: OpeningSource,
  warn: (message: string) => void,
): number | undefined {
  const recorded = bookkeeping.floorFor(opening.originSeq)
  if (recorded !== undefined && recorded >= opening.toTier) return recorded
  try {
    bookkeeping.restoreFromEscalations(opening.originSeq, durableEscalations(agent, opening))
    return bookkeeping.floorFor(opening.originSeq)
  } catch (error) {
    warn(`moa: cannot restore the escalation floor for origin ${opening.originSeq} (${error instanceof Error ? error.message : String(error)}); serving the live selection`)
    return undefined
  }
}
