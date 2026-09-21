/**
 * JSONL ledger for cost-gate decisions: `<dshHome>/compaction-cost-gate/<projectKey>.jsonl`.
 * Append-only, fire-and-forget (the arming/action paths never await on it),
 * error-swallowing into the injected sink (cache-health ledger discipline).
 * @module @dsh-cc/compaction-cost-gate/ledger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'

/** One ledger row (one JSON object per jsonl line). */
export interface LedgerRow {
  /** ISO timestamp of the observation. */
  readonly ts: string
  /** Root session the row belongs to. */
  readonly sessionId: string
  /**
   * Row kind: `gate` (an idle evaluation with both sides of the inequality),
   * `compacted`, `skipped:<class>` (expected busy/cancelled/cooldown), or
   * `compaction-unavailable`.
   */
  readonly kind: string
  /** Mode in effect at evaluation time. */
  readonly mode: 'dry-run' | 'on'
  /** Σ estimateMessage over message-carrying surface nodes at the boundary. */
  readonly contextTokens?: number
  readonly projectedSavedInput?: number
  readonly rewriteCost?: number
  readonly debtTokens?: number
  readonly pendingSteps?: number
  readonly requestsPerStep?: number
  readonly shrink?: number
  readonly margin?: number
  /** Whether the gate passed (undefined for rows without a gate decision). */
  readonly pass?: boolean
  /** Window-pressure override in effect for this evaluation. */
  readonly windowPressureOverride?: boolean
  readonly provider?: string
  readonly model?: string
  /** Free-text reason for skip/failure rows. */
  readonly reason?: string
}

/** Error sink (the plugin passes a warn-logger); never throws. */
export type LedgerErrorSink = (error: unknown) => void

/** projectKey = 8-hex sha256 of the session cwd (cache-health idiom). */
export function projectKeyOf(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 8)
}

/**
 * Append-only ledger store. One instance per mounted plugin; `root` is
 * `dshHomePath('compaction-cost-gate')`.
 */
export class CostGateLedger {
  /** Per-file write chain: serializes appends so rows keep decision order (still floating). */
  private readonly pending = new Map<string, Promise<void>>()

  constructor(
    readonly root: string,
    private readonly onError: LedgerErrorSink = () => {},
  ) {}

  /** Ledger file path for one project. */
  pathFor(projectKey: string): string {
    return join(this.root, `${projectKey}.jsonl`)
  }

  /** Await all outstanding appends (test/diagnostic seam; never used on event paths). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending.values()])
  }

  /** Append one row as a FLOATING promise chained per file (call order preserved). Never await on an event path. */
  append(projectKey: string, row: LedgerRow): void {
    const file = this.pathFor(projectKey)
    const write = async (): Promise<void> => {
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8')
    }
    const prev = this.pending.get(file) ?? Promise.resolve()
    const next = prev.then(write, write)
    this.pending.set(file, next)
    next.catch((error) => {
      try {
        this.onError(error)
      } catch {
        // sink failure must never propagate
      }
    })
  }
}
