/**
 * The snapshot row (§3.4) and the normative consumer row-selection rule.
 * @see docs/plans/2026-10-09-session-config-snapshot-event.md §3.4
 * @module @dsh-cc/config-snapshot/row
 */

/** Row schema version; bump on any field-shape change. */
export const SCHEMA_VERSION = 1

/** One plugin install entry inside a snapshot row (§3.5 (d)). */
export interface SnapshotPluginRow {
  /** Record key, including the marketplace suffix (`name@marketplace`). */
  readonly id: string
  readonly scope: 'user' | 'project' | 'local'
  readonly version: string
  /** Basename of the entry's `installPath` — the only location hint (privacy: no absolute paths). */
  readonly installPathBasename: string
  /** The manager's C9 effective enablement at capture time. */
  readonly enabled: boolean
  /** Marks the installation the runtime loader would pick (exactly one per enabled id). */
  readonly loaderSelected?: true
}

/** A sidecar snapshot row. Row identity is (file, `seq`). */
export interface SnapshotRow {
  readonly schemaVersion: typeof SCHEMA_VERSION
  /** Raw session id — the consumer join key; the filename is its encoded form. */
  readonly sessionId: string
  /** Per-file monotonic row counter, assigned by the write queue (the row identity). */
  readonly seq: number
  /** Per plugin activation: `${process.pid}-${Date.now()}-${activationCount}`. */
  readonly bootId: string
  /** Capture-INITIATION time, epoch ms (advisory; config fields are read async afterward). */
  readonly appendedAt: number
  /** dsh-cc version, never null (§3.5 (a)). */
  readonly dshCc: string
  /** Harness version, normalized from the host seam, or `null` when not surfaced (§3.5 (b)). */
  readonly harness: string | null
  /** Process default preset id (§3.5 (c)); per-session overrides live in the transcript. */
  readonly preset: { readonly id: string | null }
  /** Visible install inventory, sorted by id then scope (§3.5 (d)). */
  readonly plugins: readonly SnapshotPluginRow[]
  /** Sanitized fixed reason code, e.g. `plugins-state-corrupt` (never raw error text). */
  readonly note?: string
  /** session.header discriminators (root vs subagent partitioning from the snapshot alone). */
  readonly delegationDepth: number | null
  readonly parentSession: string | null
  readonly origin: string | null
}

/**
 * Normative consumer row-selection rule (§3.4): the row with the greatest
 * `appendedAt` ≤ `eventTime`; same-millisecond ties broken by `seq` (later
 * file order wins). No qualifying row ⇒ `null` (UNKNOWN) — deliberately no
 * fallback to the earliest row.
 */
export function selectRow(rows: readonly SnapshotRow[], eventTime: number): SnapshotRow | null {
  let best: SnapshotRow | null = null
  for (const row of rows) {
    if (row.appendedAt > eventTime) continue
    if (
      best === null
      || row.appendedAt > best.appendedAt
      || (row.appendedAt === best.appendedAt && row.seq > best.seq)
    ) {
      best = row
    }
  }
  return best
}
