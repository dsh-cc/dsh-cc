/**
 * Deferred-mode orchestration (design §3): the `llm/stream` first-chunk
 * counter, the `agent/pre-step` swap pass, resume-by-fingerprint, and the
 * per-session ledger plumbing. Extracted from the crusher service to keep
 * `index.ts` inside the file-size budget; the crusher wires one instance
 * and forwards its post-execute hooks.
 *
 * @module @dsh-cc/context-crusher/defer/pass
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: the `ctx.tokenMeter` Context merge for the declared injection.
import type {} from '@deepseek-ai/dsh-token-meter'
import type { ToolExecution } from '@dsh-cc/tools'
import { getSessionCwd } from '@dsh-cc/session-cwd'
import { buildMarker } from '../marker.ts'
import { route } from '../router.ts'
import { shortHash } from '../store.ts'
import type { CrusherStore } from '../store.ts'
import type { ResolvedConfig } from '../types.ts'
import { shouldCountRequest, toolResultFingerprints, wrapStreamWithCounting } from './counter.ts'
import {
  DeferLedger,
  ResidentTable,
  parseTodoCounts,
  readDeferLedger,
  rebuildResidents,
} from './residents.ts'
import type { DeferGateFacts, DeferSwapRow, ResidentEntry } from './residents.ts'
import { attemptSwap } from './swap.ts'

/** dsh-home path resolver (see the crusher's `dshHomePath` seam). */
type HomeFn = (...segments: string[]) => string

export interface DeferralDeps {
  readonly ctx: Context
  readonly store: () => CrusherStore | undefined
  readonly home: () => HomeFn | undefined
  readonly effectiveConfig: () => ResolvedConfig
}

/**
 * Owns all deferred-externalization state and listeners. Every failure
 * degrades to a log line: observation must never break a request or a turn.
 */
export class Deferral {
  private readonly table = new ResidentTable()
  private readonly ledgers = new Map<string, DeferLedger>()

  constructor(private readonly deps: DeferralDeps) {}

  /**
   * Deferred-mode seams (design §3): an `llm/stream` first-chunk counter
   * (`{ global: true, prepend: true }` — the crusher runs in its own realm),
   * an `agent/pre-step` swap pass, and state cleanup on session disposal.
   */
  registerListeners(): void {
    const { ctx } = this.deps
    ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
      wrapStreamWithCounting(options, next(), (opts) => this.observeStreamFirstChunk(opts)),
    { global: true, prepend: true })
    ctx.on('agent/pre-step', async (
      { agent, signal }: { agent: Agent; signal: AbortSignal },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision> => {
      try {
        await this.preStepPass(agent, signal)
      } catch (error: unknown) {
        // Never break the turn over observability/compaction bookkeeping.
        ctx.logger.warn(`context-crusher: deferred pre-step pass failed: ${String(error)}`)
      }
      return next()
    })
    ctx.on('session/disposed', (session: Session): void => {
      this.table.delete(String(session.id))
    })
  }

  /**
   * First-chunk send counter (§3.2): one send per resident whose stored full
   * text fingerprint appears in the outbound prompt. Main-loop purpose
   * allowlist + owning-session guard live in {@link shouldCountRequest}.
   */
  private observeStreamFirstChunk(options: GenerateOptions): void {
    try {
      if (!shouldCountRequest(options, this.table.sessionIds())) return
      const state = this.table.get(String(options.sessionId))
      if (state === undefined) return
      state.streamRequestCount += 1
      const fingerprints = toolResultFingerprints(options.messages)
      for (const entry of state.residents.values()) {
        if (fingerprints.has(entry.hash)) entry.sentCount += 1
      }
    } catch (error: unknown) {
      this.deps.ctx.logger.warn(`context-crusher: deferred send counting failed: ${String(error)}`)
    }
  }

  /**
   * One pre-step pass (§3.3): sweep aged residents, then evaluate every
   * entry whose sent count crossed the residency threshold in one
   * non-awaiting critical section per entry. No timers exist — eligibility
   * is recomputed at this boundary. A failing entry never aborts the others
   * (microcompact failure ordering).
   */
  private async preStepPass(agent: Agent, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const cfg = this.deps.effectiveConfig()
    const store = this.deps.store()
    const home = this.deps.home()
    if (!cfg.enabled || cfg.deferRequests <= 0 || store === undefined || home === undefined) return
    const session = agent.session
    const sessionId = String(session.id)
    await this.ensureLoaded(sessionId, agent)
    const state = this.table.get(sessionId)
    if (state === undefined || state.residents.size === 0) return
    const ledger = this.ledgerFor(sessionId)
    const pendingRows: Promise<void>[] = []
    const swapRow = (entry: ResidentEntry, outcome: DeferSwapRow['outcome'], applied: boolean, gate?: DeferGateFacts): void => {
      const row = ledger?.append({
        ts: new Date().toISOString(),
        type: 'swap',
        hash: entry.hash,
        callId: String(entry.callId),
        outcome,
        applied,
        ...(gate === undefined ? {} : { gate }),
      })
      if (row !== undefined) pendingRows.push(row)
    }
    const now = Date.now()
    // Age sweep first: decks of stale residents cannot accumulate unboundedly.
    for (const entry of [...state.residents.values()]) {
      if (now - entry.createdAt > cfg.deferMaxAgeMs) {
        state.residents.delete(entry.hash)
        swapRow(entry, 'abandoned', false, { sentCount: entry.sentCount })
      }
    }
    let projectKey: string
    try {
      projectKey = shortHash(getSessionCwd(agent))
    } catch {
      return
    }
    // Window-pressure inputs are resolved once per pass and only when the
    // override key is set (measure is O(surface)); without a window source
    // the override stays inactive.
    let sessionTokens: number | undefined
    let contextWindow: number | undefined
    if (cfg.deferUrgencyTokens !== undefined) {
      sessionTokens = this.deps.ctx.tokenMeter.measure(session).totalTokens
      contextWindow = this.contextWindowOf(session)
    }
    for (const entry of [...state.residents.values()]) {
      // Deviation flagged in review: doc §3.3 says `sentCount > residency`,
      // but the title/§5 ("send twice, swap on the third request") and the
      // approved test plan require `>=` — implemented as `>=`.
      if (entry.sentCount < cfg.deferRequests) continue
      try {
        // All I/O happens BEFORE the synchronous critical section.
        const stored = await store.get(projectKey, entry.hash)
        const candidate = stored.ok ? route(stored.text) : null
        if (!stored.ok || candidate === null) {
          state.residents.delete(entry.hash)
          swapRow(entry, 'stale', false, { sentCount: entry.sentCount })
          continue
        }
        const tokensBefore = this.estimate(stored.text)
        const tokensAfter = this.estimate(candidate.text)
        const stubText = `${candidate.text}\n${buildMarker(tokensBefore, tokensAfter, entry.hash)}`
        // ↓ synchronous critical section (staleness re-check + two appends,
        // no yields — an in-flight request cannot interleave with a swap).
        const result = attemptSwap({
          session,
          entry,
          fullText: stored.text,
          stubText,
          apply: cfg.mode === 'on',
          margin: cfg.deferMargin,
          remainingRequestsEstimate: this.table.remainingRequestsEstimate(state),
          ...(cfg.deferUrgencyTokens !== undefined ? { urgencyTokens: cfg.deferUrgencyTokens } : {}),
          ...(sessionTokens !== undefined ? { sessionTokens } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          estimateMessage: (message: Message) => this.deps.ctx.tokenMeter.estimateMessage(message),
        })
        if (result.outcome === 'applied') {
          state.residents.delete(entry.hash)
          swapRow(entry, 'applied', true, result.gate)
        } else if (result.outcome === 'stale') {
          state.residents.delete(entry.hash)
          swapRow(entry, 'stale', false, { sentCount: entry.sentCount })
        } else if (result.outcome === 'dry-run') {
          // §3.6: intent row carries applied:false; the entry stays resident.
          swapRow(entry, 'dry-run', false, result.gate)
        }
        // gate-failed: the entry stays resident; re-evaluation is cheap and
        // happens at every pre-step.
      } catch (error: unknown) {
        this.deps.ctx.logger.warn(`context-crusher: deferred swap failed for ${entry.hash}: ${String(error)}`)
      }
    }
    // Ledger rows are best-effort but awaited here so the pass is durable
    // before the turn's request fires (still never throws — DeferLedger
    // swallows I/O errors internally).
    await Promise.all(pendingRows)
  }

  /** Record one resident entry (post-execute, deferral applies). */
  async recordResident(exec: ToolExecution, hash: string, tokensSaved: number): Promise<void> {
    const agent = exec.agent
    const home = this.deps.home()
    if (agent === undefined || home === undefined) return
    const sessionId = String(agent.session.id)
    const entry: ResidentEntry = {
      hash,
      callId: exec.callId,
      sentCount: 0,
      tokensSaved,
      createdAt: Date.now(),
    }
    this.table.ensure(sessionId).residents.set(hash, entry)
    await this.ledgerFor(sessionId)?.append({
      ts: new Date().toISOString(),
      type: 'resident',
      hash,
      callId: String(exec.callId),
      tokensSaved,
      createdAt: entry.createdAt,
    })
  }

  /** Latest `todo_write` snapshot → the remaining-requests estimate inputs. */
  observeTodoSnapshot(exec: ToolExecution): void {
    if (exec.agent === undefined) return
    const counts = parseTodoCounts(exec.arguments)
    if (counts === undefined) return
    const state = this.table.ensure(String(exec.agent.session.id))
    state.todoCompleted = counts.completed
    state.todoPending = counts.pending
  }

  /**
   * Resume rebuild (§3.5), once per session: replay the per-session ledger
   * and re-adopt entries whose stored text fingerprints the live surface.
   * Session-id keying alone would strand residents across resume/fork, so
   * the fingerprint — not the row — is the identity.
   */
  private async ensureLoaded(sessionId: string, agent: Agent): Promise<void> {
    const state = this.table.ensure(sessionId)
    const store = this.deps.store()
    const home = this.deps.home()
    if (state.loaded || store === undefined || home === undefined) return
    state.loaded = true
    try {
      const rows = await readDeferLedger(home('ccr', 'defer', `${sessionId}.jsonl`))
      if (rows.length === 0) return
      const rebuilt = await rebuildResidents({
        rows,
        store,
        projectKey: shortHash(getSessionCwd(agent)),
        session: agent.session,
      })
      for (const [hash, entry] of rebuilt) state.residents.set(hash, entry)
    } catch (error: unknown) {
      this.deps.ctx.logger.warn(`context-crusher: deferred resume rebuild failed: ${String(error)}`)
    }
  }

  /** Per-session defer ledger (constructed lazily; all writes never throw). */
  private ledgerFor(sessionId: string): DeferLedger | undefined {
    const home = this.deps.home()
    if (home === undefined) return undefined
    let ledger = this.ledgers.get(sessionId)
    if (ledger === undefined) {
      ledger = new DeferLedger(home('ccr', 'defer', `${sessionId}.jsonl`))
      this.ledgers.set(sessionId, ledger)
    }
    return ledger
  }

  /** Routed model context window via the token-meter pressure projection; absent = no window source. */
  private contextWindowOf(session: Session): number | undefined {
    try {
      const projections = this.deps.ctx.get('sessionProjections') as
        { stateOf(s: Session, key: string): unknown } | undefined
      const state = projections?.stateOf(session, 'contextPressure') as { contextWindow?: unknown } | undefined
      return typeof state?.contextWindow === 'number' && state.contextWindow > 0
        ? state.contextWindow
        : undefined
    } catch {
      return undefined
    }
  }

  /** Token-based sizing, same estimator as the crusher's gates and markers. */
  private estimate(text: string): number {
    return this.deps.ctx.tokenMeter.estimateMessage({
      role: 'tool',
      content: [{ type: 'text', text }],
    } as unknown as Message)
  }
}
