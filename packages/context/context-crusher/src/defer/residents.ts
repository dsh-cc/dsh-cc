/**
 * Deferred-resident bookkeeping: the in-memory per-session table, the
 * append-only per-session JSONL ledger (`<dshHome>/ccr/defer/<sessionId>.jsonl`),
 * and resume-by-fingerprint rebuild (design §3.1/§3.5).
 *
 * Rows carry NO session id — the store hash is the identity, which matches
 * the store's own keying rule and keeps rows meaningful across resume/fork.
 * Ledger failures are swallowed per the CCR ledger precedent: durability is
 * best-effort, correctness never depends on it.
 *
 * @module @dsh-cc/context-crusher/defer/residents
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { CrusherStore } from '../store.ts'
import { joinTextBlocks } from './counter.ts'

/** One resident: stored immediately, sent unmodified, swapped after residency. */
export interface ResidentEntry {
  readonly hash: string
  /** Sole locator — the surface event is resolved by callId at pre-step time. */
  readonly callId: ToolCallId
  /** Counted main-loop sends that included the full text (first-chunk rule). */
  sentCount: number
  /** tokensBefore − tokensAfter, measured at store time. */
  readonly tokensSaved: number
  /** Epoch ms when the resident was recorded (sweep reference). */
  readonly createdAt: number
}

/** Row recording that the original was stored and the result sent unmodified. */
export interface DeferResidentRow {
  readonly ts: string
  readonly type: 'resident'
  readonly hash: string
  readonly callId: string
  readonly tokensSaved: number
  readonly createdAt: number
}

/** Gate inputs at decision time, recorded with every swap row for the dogfood study. */
export interface DeferGateFacts {
  readonly sentCount: number
  readonly suffixTokens?: number
  readonly projectedSavings?: number
  readonly margin?: number
  readonly remainingRequestsEstimate?: number
  readonly urgencyOverride?: boolean
}

/** Row recording a swap decision: applied, stale drop, age sweep, or dry-run intent. */
export interface DeferSwapRow {
  readonly ts: string
  readonly type: 'swap'
  readonly hash: string
  readonly callId: string
  readonly outcome: 'applied' | 'stale' | 'abandoned' | 'dry-run'
  /** §3.6: dry-run intent rows carry `applied: false`. */
  readonly applied: boolean
  readonly gate?: DeferGateFacts
}

export type DeferLedgerRow = DeferResidentRow | DeferSwapRow

/** Append-only per-session defer ledger; never throws. */
export class DeferLedger {
  constructor(private readonly filePath: string) {}

  /** Append one row; never throws (best-effort observability). */
  async append(row: DeferLedgerRow): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await appendFile(this.filePath, `${JSON.stringify(row)}\n`, 'utf8')
    } catch {
      // Best-effort observability; never surface into the agent loop.
    }
  }
}

/** Read every ledger row; absent/corrupt files degrade to an empty list. */
export async function readDeferLedger(filePath: string): Promise<DeferLedgerRow[]> {
  let body: string
  try {
    body = await readFile(filePath, 'utf8')
  } catch {
    return []
  }
  const rows: DeferLedgerRow[] = []
  for (const line of body.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      rows.push(JSON.parse(line) as DeferLedgerRow)
    } catch {
      // Skip a torn tail line; the ledger is append-only and best-effort.
    }
  }
  return rows
}

/**
 * Replay ledger rows into resident candidates: resident rows add, swap rows
 * with a committed outcome (applied/stale/abandoned) remove, dry-run intent
 * rows leave the resident in place (nothing was applied). Candidates always
 * resume at `sentCount: 0` (§3.5: deliberately conservative).
 */
export function foldDeferRows(rows: readonly DeferLedgerRow[]): Map<string, ResidentEntry> {
  const out = new Map<string, ResidentEntry>()
  for (const row of rows) {
    if (row.type === 'resident') {
      out.set(row.hash, {
        hash: row.hash,
        callId: ToolCallId(row.callId),
        sentCount: 0,
        tokensSaved: row.tokensSaved,
        createdAt: row.createdAt,
      })
    } else if (row.outcome !== 'dry-run') {
      out.delete(row.hash)
    }
  }
  return out
}

export interface RebuildDeps {
  readonly rows: readonly DeferLedgerRow[]
  readonly store: CrusherStore
  readonly projectKey: string
  readonly session: Session
}

/**
 * Rebuild residents after a restart by FINGERPRINT MATCH against the live
 * surface (§3.5): for each recorded hash the stored full text is searched
 * among current `tool/result` events (by callId, then byte-equality); found
 * → resume at `sentCount: 0`; not found → drop.
 */
export async function rebuildResidents(deps: RebuildDeps): Promise<Map<string, ResidentEntry>> {
  const out = new Map<string, ResidentEntry>()
  for (const candidate of foldDeferRows(deps.rows).values()) {
    const stored = await deps.store.get(deps.projectKey, candidate.hash)
    if (!stored.ok) continue
    for (const seq of deps.session.surface.nodes) {
      const event = deps.session.eventAt(seq)
      if (event?.type !== 'tool/result') continue
      const message = event.data.message
      if (String(message.source.callId) !== String(candidate.callId)) continue
      const block = message.content[0]
      if (block?.type !== 'tool-result') continue
      if (joinTextBlocks(block.content) === stored.text) {
        out.set(candidate.hash, candidate)
        break
      }
    }
  }
  return out
}

/** Latest `todo_write` snapshot counts for the remaining-requests estimate. */
export interface TodoCounts {
  readonly completed: number
  readonly pending: number
}

const TODO_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

/**
 * Parse the `todos` array out of `todo_write` arguments (observe-only; the
 * same argument shape the compaction cost gate reads).
 */
export function parseTodoCounts(args: unknown): TodoCounts | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const todos = (args as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return undefined
  let completed = 0
  let pending = 0
  for (const todo of todos) {
    if (typeof todo !== 'object' || todo === null) return undefined
    const item = todo as { content?: unknown; status?: unknown }
    if (typeof item.content !== 'string' || typeof item.status !== 'string'
      || !TODO_STATUSES.includes(item.status)) return undefined
    if (item.status === 'completed') completed += 1
    else pending += 1
  }
  return { completed, pending }
}

/** Per-session defer state (in memory only; never ledgered). */
export interface DeferSessionState {
  /** Resume rebuild ran (or was attempted) for this session. */
  loaded: boolean
  readonly residents: Map<string, ResidentEntry>
  /** Main-loop first-chunk requests observed for this session. */
  streamRequestCount: number
  /** Latest `todo_write` snapshot counts (cold start: zeroes). */
  todoCompleted: number
  todoPending: number
}

/**
 * In-memory per-session resident table. The map key IS the owning session id
 * the stream listener's sessionId guard checks against (§3.2).
 */
export class ResidentTable {
  private readonly states = new Map<string, DeferSessionState>()

  get(sessionId: string): DeferSessionState | undefined {
    return this.states.get(sessionId)
  }

  ensure(sessionId: string): DeferSessionState {
    let state = this.states.get(sessionId)
    if (state === undefined) {
      state = { loaded: false, residents: new Map(), streamRequestCount: 0, todoCompleted: 0, todoPending: 0 }
      this.states.set(sessionId, state)
    }
    return state
  }

  delete(sessionId: string): void {
    this.states.delete(sessionId)
  }

  /** Every session id currently holding defer state (stream-listener guard). */
  sessionIds(): Set<string> {
    return new Set(this.states.keys())
  }

  /**
   * `remainingRequestsEstimate` per the compaction cost-gate doc: observed
   * requests-per-step × pending todo steps, floored at 1. With no todo
   * snapshot ever seen the estimate is 1 — conservative against swapping.
   */
  remainingRequestsEstimate(state: DeferSessionState): number {
    const requestsPerStep = Math.max(1, state.streamRequestCount / Math.max(state.todoCompleted, 1))
    return Math.max(1, requestsPerStep * state.todoPending)
  }
}
