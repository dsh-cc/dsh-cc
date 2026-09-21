/**
 * Cost-gated plan-step compaction service (design
 * docs/plans/2026-09-20-cost-gated-plan-step-compaction.md §3.4–§3.6).
 *
 * Two seams: a mid-turn `tools/post-execute` listener ARMS a boundary when a
 * `todo_write` transitions a todo to completed (observe-only, decision
 * untouched); an `agent/status` idle listener runs the §3.3 cost gate for the
 * latched root session only and, on a pass in `mode: 'on'`, calls
 * `ctx.compaction.compactNow` with a preservation hint parked immediately
 * before the call and a fresh abort signal (the turn-scoped signal is dead by
 * idle). Subagent agents never arm, count, or trigger.
 *
 * The compaction engine is deliberately NOT injected (cordis strict-read
 * would kill the service where compaction is absent); it is read through the
 * guarded {@link optionalCompaction} accessor, and absence inactivates the
 * gate with one log line and one ledger row.
 *
 * @module @dsh-cc/compaction-cost-gate
 */

import type {} from '@deepseek-ai/dsh-token-meter'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import { deriveEventMessage, type Session } from '@deepseek-ai/dsh-session'
import type { PostToolDecision } from '@dsh-cc/tools'
import type { CompactionEngine, ManualCompactAgentContext } from '@deepseek-ai/dsh-compaction'
import { setCompactHint, takeCompactHint } from '@dsh-cc/compaction-basic'
import { resolvePrice } from '@dsh-cc/command-cost'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { evaluateGate } from './gate.ts'
import { CostGateLedger, projectKeyOf } from './ledger.ts'
import { registerCostGateSettings } from './settings.ts'
import { diffTodos } from './todo-diff.ts'
import {
  FAILURE_FUSE,
  type CostGateSettings,
  type SessionStats,
  type TodoItem,
} from './types.ts'

export { CostGateLedger, projectKeyOf, type LedgerRow } from './ledger.ts'
export { evaluateGate } from './gate.ts'
export { diffTodos } from './todo-diff.ts'
export { SETTINGS_NAMESPACE, registerCostGateSettings } from './settings.ts'
export * from './types.ts'

/** dshHomePath seam, read defensively (a providerless host must not crash the plugin). */
type HomeFn = (...segments: string[]) => string

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The mounted cost gate (present whenever the plugin mounts). */
    compactionCostGate?: CompactionCostGate
  }
}

function dshHomeFn(ctx: Context): HomeFn | undefined {
  try {
    return ctx.dshHomePath
  } catch {
    return undefined
  }
}

/**
 * The compaction service is optional at mount: reading an uninjected cordis
 * context property throws, so the read is guarded (never `inject`ed).
 */
function optionalCompaction(ctx: Context): CompactionEngine | undefined {
  try {
    return ctx.compaction
  } catch {
    return undefined
  }
}

/** The minimal agent surface the gate needs (structural; satisfied by the harness Agent). */
interface GateAgent {
  readonly session: Session
  readonly options: { provider?: string; model?: string }
  inject?(message: ReturnType<typeof createUserMessage>): void
}

/** Testable seams over the settings reader and clock. */
export interface CostGateDeps {
  /** Settings reader override (defaults to the live namespace reader). */
  readonly readSettings?: () => import('./types.ts').CostGateSettings
  /** Ledger override (defaults to `<dshHome>/compaction-cost-gate`). */
  readonly ledger?: CostGateLedger
  /** Clock override for cooldown tests. */
  readonly now?: () => number
}

/**
 * Cost-gated plan-step compaction service. One instance per mounted plugin;
 * state is keyed by the latched root session id and lives in memory only.
 */
export class CompactionCostGate extends Service {
  /** The token meter prices surface nodes for the gate arithmetic. */
  static inject = ['tokenMeter']

  private readonly readSettings: () => CostGateSettings
  private readonly ledger: CostGateLedger | undefined
  private readonly now: () => number
  /** Content of the todo whose completion armed the current boundary. */
  private rootLatch: string | undefined
  private readonly stats = new Map<string, SessionStats>()

  constructor(ctx: Context, deps: CostGateDeps = {}) {
    super(ctx, 'compactionCostGate')
    this.ctx = ctx
    this.readSettings = deps.readSettings ?? registerCostGateSettings(ctx)
    this.now = deps.now ?? Date.now
    const home = dshHomeFn(ctx)
    this.ledger = deps.ledger
      ?? (home === undefined
        ? undefined
        : new CostGateLedger(home('compaction-cost-gate'), (error) => {
            ctx.logger.warn(`compaction-cost-gate: ledger write failed: ${error instanceof Error ? error.message : String(error)}`)
          }))
    this.registerListeners()
  }

  /** Register the observe-only listeners (two-seam split, §3.4). */
  private registerListeners(): void {
    this.ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
      this.observeStream(options)
      return next()
    }, { global: true, prepend: true })
    this.ctx.on('tools/post-execute', async (
      exec,
      _result,
      next,
    ): Promise<PostToolDecision> => {
      this.observePostExecute(exec)
      // Observe-only: the downstream decision passes through unchanged.
      return next()
    })
    this.ctx.on('agent/status', ({ agent, status }: { agent: GateAgent; status: string }) => {
      if (status === 'idle') void this.evaluateIdle(agent)
    })
    this.ctx.on('session/disposed', (session: Session) => {
      const id = String(session.header.id)
      if (id === this.rootLatch) {
        this.rootLatch = undefined
        this.stats.delete(id)
      }
    })
  }

  /** Fresh per-root-session state (§3.2). */
  private freshStats(): SessionStats {
    return {
      boundaryArmed: false,
      streamRequestCount: 0,
      completedSteps: 0,
      lastTodoSnapshot: new Map(),
      rewriteDebt: [],
      cooldownUntil: 0,
      consecutiveFailures: 0,
      paused: false,
    }
  }

  /**
   * Latch the root session on the first main-loop observation and count
   * main-loop requests for it (auxiliary purposes never latch or count);
   * amortize rewrite debt by the requests it has since observed.
   */
  observeStream(options: GenerateOptions): void {
    if (options.purpose !== undefined || options.sessionId === undefined) return
    const id = String(options.sessionId)
    if (this.rootLatch === undefined) {
      this.rootLatch = id
      this.stats.set(id, this.freshStats())
    }
    const state = this.stats.get(id)
    if (state === undefined) return
    state.streamRequestCount += 1
    state.lastProvider = options.provider
    state.lastModel = options.model
    for (const entry of state.rewriteDebt) entry.requestsSince += 1
  }

  /**
   * Detection seam: filter `todo_write`, diff the snapshot, and arm the
   * boundary on any transition to completed — for the latched root session
   * only. Never mutates the tool decision.
   */
  observePostExecute(exec: { name: string; arguments?: unknown; agent?: { session: Session } }): void {
    if (exec.name !== 'todo_write') return
    if (this.rootLatch === undefined) return
    const agentSession = exec.agent?.session
    if (agentSession === undefined || String(agentSession.header.id) !== this.rootLatch) return
    const state = this.stats.get(this.rootLatch)
    if (state === undefined) return
    const todos = this.parseTodos(exec.arguments)
    if (todos === undefined) return
    const result = diffTodos(state.lastTodoSnapshot, todos)
    if (result.armed) {
      state.boundaryArmed = true
      state.lastCompletedTitle = result.newlyCompleted[result.newlyCompleted.length - 1] ?? ''
    }
    state.lastTodoSnapshot = new Map(result.snapshot)
    state.completedSteps = result.completedSteps
  }

  /** Action seam: evaluate the gate at idle for the latched root session only. */
  async evaluateIdle(agent: GateAgent): Promise<void> {
    const settings = this.readSettings()
    if (!settings.enabled) return // ships dark
    if (this.rootLatch === undefined) return
    if (String(agent.session.header.id) !== this.rootLatch) return
    const state = this.stats.get(this.rootLatch)
    if (state === undefined) return
    // Measure the last compaction's reduction at the next idle evaluation.
    if (state.preCompactContextTokens !== undefined && state.preCompactContextTokens > 0) {
      const current = this.contextTokens(agent.session)
      const measured = Math.max(0, (state.preCompactContextTokens - current) / state.preCompactContextTokens)
      state.lastShrink = measured
      delete state.preCompactContextTokens
    }
    if (!state.boundaryArmed) return
    state.boundaryArmed = false // disarm unconditionally: one evaluation per boundary
    if (state.paused) return
    const now = this.now()
    if (now < state.cooldownUntil) {
      this.write('skipped:cooldown', { mode: settings.mode, reason: 'cooldown active' })
      return
    }
    const engine = optionalCompaction(this.ctx)
    if (engine === undefined) {
      this.ctx.logger.warn('compaction-cost-gate: no compaction service on the host context; gate inactive')
      this.write('compaction-unavailable', { mode: settings.mode, reason: 'compaction-unavailable' })
      return
    }
    const contextTokens = this.contextTokens(agent.session)
    const pendingSteps = this.pendingSteps(state)
    const price = this.resolvePriceFor(settings, state)
    const outcome = evaluateGate({
      contextTokens,
      streamRequestCount: state.streamRequestCount,
      completedSteps: state.completedSteps,
      pendingSteps,
      ...(state.lastShrink !== undefined ? { lastShrink: state.lastShrink } : {}),
      rewriteDebt: state.rewriteDebt,
      margin: settings.margin,
      ...(price !== undefined ? { price } : {}),
      ...(settings.windowPressureTokens !== undefined
        ? { windowPressureTokens: settings.windowPressureTokens }
        : {}),
    })
    const row = {
      mode: settings.mode,
      contextTokens,
      projectedSavedInput: outcome.projectedSavedInput,
      rewriteCost: outcome.rewriteCost,
      debtTokens: outcome.debtTokens,
      pendingSteps: outcome.pendingSteps,
      requestsPerStep: outcome.requestsPerStep,
      shrink: outcome.shrink,
      margin: settings.margin,
      pass: outcome.pass,
      windowPressureOverride: outcome.windowPressureOverride,
      provider: state.lastProvider,
      model: state.lastModel,
    }
    this.write('gate', row)
    if (!outcome.pass) return
    if (settings.mode === 'dry-run') return
    await this.compactNow(engine, agent, contextTokens, settings, outcome.rewriteCost)
  }

  /**
   * Hint-then-call: the hint must survive only the instant between set and
   * consume; it is cleared on every exit path. A fresh AbortController (the
   * turn-scoped signal is dead by idle and must never be reused).
   */
  private async compactNow(
    engine: CompactionEngine,
    agent: GateAgent,
    contextTokens: number,
    settings: CostGateSettings,
    rewriteCost: number,
  ): Promise<void> {
    const state = this.stats.get(this.rootLatch ?? '')
    setCompactHint(agent, `plan-step-complete:${state?.lastCompletedTitle ?? 'todo'}`)
    try {
      const result = await engine.compactNow(
        agent as ManualCompactAgentContext,
        new AbortController().signal,
        CommandId('compaction-cost-gate'),
      )
      // Success resets the fuse and starts cooldown + debt amortization.
      if (state !== undefined) {
        state.consecutiveFailures = 0
        state.cooldownUntil = this.now() + settings.cooldownMs
        state.rewriteDebt.push({ tokens: rewriteCost, requestsSince: 0 })
        state.preCompactContextTokens = contextTokens
      }
      this.write('compacted', {
        mode: settings.mode,
        contextTokens,
        rewriteCost,
        reason: result === null ? 'no-compactable-history' : 'compacted',
      })
      this.ctx.logger.info(
        `compaction-cost-gate: compacted at plan-step boundary `
        + `(context ~${contextTokens} tokens, debt ${rewriteCost})`,
      )
    } catch (error: unknown) {
      if (error instanceof ManualCompactionError && (error.code === 'busy' || error.code === 'cancelled')) {
        // Expected classes: count toward nothing, reset nothing.
        this.write(`skipped:${error.code}`, { mode: settings.mode, reason: error.message })
        return
      }
      const code = error instanceof ManualCompactionError ? error.code : 'unexpected'
      this.write(`failed:${code}`, { mode: settings.mode, reason: error instanceof Error ? error.message : String(error) })
      if (state !== undefined) {
        state.consecutiveFailures += 1
        if (state.consecutiveFailures >= FAILURE_FUSE) {
          state.paused = true
          this.notifyPaused(agent, state.consecutiveFailures)
        }
      }
    } finally {
      // Cleared on ANY failure path (and after success) so a stale hint can
      // never ride a later turn.
      takeCompactHint(agent)
    }
  }

  /** One durable model-visible pause notice pointing at manual `/compact`. */
  private notifyPaused(agent: GateAgent, failures: number): void {
    const text = `compaction-cost-gate: failed ${failures} consecutive time(s); `
      + 'auto compaction paused for this session — run /compact manually'
    try {
      agent.inject?.(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'compaction-cost-gate' },
      }))
    } catch (error: unknown) {
      this.ctx.logger.warn(`compaction-cost-gate: failed to inject pause notice: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Resolve the optional pricing layer from the last observed provider/model. */
  private resolvePriceFor(
    settings: CostGateSettings,
    state: SessionStats,
  ): { cacheReadPerMTok: number; cacheWritePerMTok: number } | undefined {
    if (settings.modelTable === undefined || state.lastProvider === undefined || state.lastModel === undefined) {
      return undefined
    }
    const price = resolvePrice(settings.modelTable, state.lastProvider, state.lastModel)
    if (price === undefined) return undefined
    return { cacheReadPerMTok: price.cacheReadPerMTok, cacheWritePerMTok: price.cacheWritePerMTok }
  }

  /**
   * Σ estimateMessage over message-carrying surface nodes — the shadow-aware
   * accessor (`session.surface.nodes` + `eventAt`), never raw events, so
   * spans shadowed by prior compactions are not double-counted.
   */
  private contextTokens(session: Session): number {
    let total = 0
    for (const seq of [...session.surface.nodes]) {
      const event = session.eventAt(seq)
      const message = event === undefined ? null : deriveEventMessage(event)
      if (message !== undefined && message !== null) {
        total += this.ctx.tokenMeter.estimateMessage(message as never)
      }
    }
    return total
  }

  /** Non-completed todos in the latest snapshot. */
  private pendingSteps(state: SessionStats): number {
    let pending = 0
    for (const status of state.lastTodoSnapshot.values()) {
      if (status !== 'completed') pending += 1
    }
    return pending
  }

  /** Parse the todos array out of the `todo_write` tool arguments. */
  private parseTodos(arguments_: unknown): readonly TodoItem[] | undefined {
    const todos = (arguments_ as { todos?: unknown } | undefined)?.todos
    if (!Array.isArray(todos)) return undefined
    const items: TodoItem[] = []
    for (const item of todos) {
      const candidate = item as { content?: unknown; status?: unknown }
      if (typeof candidate.content !== 'string' || typeof candidate.status !== 'string') return undefined
      if (candidate.status !== 'pending' && candidate.status !== 'in_progress' && candidate.status !== 'completed') {
        return undefined
      }
      items.push({ content: candidate.content, status: candidate.status })
    }
    return todos
  }

  /** Fire-and-forget ledger append; errors are swallowed by the ledger. */
  private write(kind: string, extra: Record<string, unknown>): void {
    this.ledger?.append(projectKeyOf(process.cwd()), {
      ts: new Date().toISOString(),
      sessionId: this.rootLatch ?? '',
      kind,
      ...extra,
    } as never)
  }
}

export default CompactionCostGate
