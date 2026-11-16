/**
 * Live wiring for the completion gate (plans
 * docs/plans/2026-10-09-runtime-verified-completion.md §3.2–§3.5 and
 * docs/plans/2026-11-17-completion-gate-enforce-mode.md §3.3–§3.5): the
 * `tools/post-execute` receipt listener (§3.2), the SYNCHRONOUS
 * `agent/turn-stopping` gate listener (§3.3/§3.4), and the `turn/end`
 * terminal reconciliation (§3.5) folded into the `session/event` firehose
 * observer. All listeners share one LineageRegistry instance and the same
 * `readUserSettingsSync` read path, so settings hot-toggle (including `mode`)
 * takes effect on the next event (§3.5).
 *
 * Hot-path discipline (§4): the receipt is built — and its hashes captured —
 * BEFORE `next()` is called, so the recorded contentHash is independent of
 * any downstream rewrite (CCR composes post-`next()`); the disk append is
 * detached after the decision; every failure is caught and debug-logged;
 * the decision is returned untouched. Never throws into the waterfall.
 *
 * The listener ALWAYS registers; `head` capture is gated on
 * `cc-completion-gate.enabled` at execute time (§3.5) — receipts-always-on
 * for the hashed fields.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionResult, PostToolDecision } from '@dsh-cc/tools'
import { EXHAUSTED_EVENT, RECEIPT_EVENT, UNVERIFIED_EVENT, type EnforceMarker, type Receipt } from './events.ts'
import { buildReceipt } from './receipts.ts'
import { appendLedgerRow, ledgerFileFor, ledgerRowOf } from './ledger.ts'
import { LineageRegistry, type SessionLike } from './lineage.ts'
import { DEFAULT_GATE_SETTINGS, readUserSettingsSync, type GateSettings } from './settings.ts'
import {
  computeUnmatched,
  evaluateTurnStopping,
  isTopLevelSession,
  maybeResolveOnReceipt,
  spentCycles,
  type EvalAgent,
  type EvalEvent,
  type EvalSession,
  type EnforceMirrorEntry,
  type EvaluateDeps,
} from './evaluate.ts'

/** Guarded dshHome read (advisor pattern): cordis throws on the property access itself. */
function dshHomeOf(ctx: Context): string | undefined {
  try {
    return ctx.dshHomePath?.()
  } catch {
    return undefined
  }
}

/** Injectable collaborators of the post-execute handler (tests duck-type these). */
export interface GateDeps {
  /** Whether `cc-completion-gate.enabled` is true at execute time. */
  readEnabled(): boolean
  /** Receipts directory, or undefined to skip the disk write entirely. */
  receiptsDir(): string | undefined
  /** Lineage registry (may be shared with the future nudge listener). */
  lineage: LineageRegistry
  /** Debug sink (never throws back into us). */
  debug(message: string): void
}

/**
 * Create the `tools/post-execute` handler. Observe-only: the decision from
 * `next()` is returned untouched in every path.
 */
export function createPostExecuteHandler(deps: GateDeps) {
  return async (
    exec: Readonly<ToolExecution>,
    result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    // Hash capture BEFORE next(): registration-order independence (§3.2, §5.12).
    let receipt: Receipt | undefined
    try {
      const headEnabled = safeReadEnabled(deps)
      receipt = buildReceipt(exec, result, { headEnabled })
    } catch (error: unknown) {
      deps.debug(`completion-gate: receipt build failed: ${String(error)}`)
    }
    const decision = await next()
    if (receipt !== undefined) {
      recordReceipt(deps, exec, receipt)
    }
    return decision
  }
}

function safeReadEnabled(deps: GateDeps): boolean {
  try {
    return deps.readEnabled()
  } catch {
    return false
  }
}

function recordReceipt(deps: GateDeps, exec: Readonly<ToolExecution>, receipt: Receipt): void {
  const session = exec.agent?.session as SessionLike | undefined
  // Session event (typed face) — try/catch + debug, never blocks the path (§3.2).
  if (session !== undefined) {
    try {
      ;(session as unknown as { append(type: string, data: Receipt): void }).append(RECEIPT_EVENT, receipt)
      // Resolved loop-closer (§3.4 step 4): an earlier open nudge whose claim
      // this receipt satisfies gets its `completion-gate/resolved` event.
      maybeResolveOnReceipt(session as never, receipt, deps.debug)
    } catch (error: unknown) {
      deps.debug(`completion-gate: session append failed: ${String(error)}`)
    }
  }
  // Lineage lift (child → root bucket), process-live (§3.2).
  try {
    deps.lineage.record(session, receipt)
  } catch (error: unknown) {
    deps.debug(`completion-gate: lineage record failed: ${String(error)}`)
  }
  // Detached JSONL ledger append — hash-only rows, skipped without sessionId (§3.2/§3.6).
  try {
    const dir = deps.receiptsDir()
    if (dir !== undefined && receipt.sessionId !== null) {
      appendLedgerRow(ledgerFileFor(dir, receipt.sessionId), ledgerRowOf(receipt), deps.debug)
    }
  } catch (error: unknown) {
    deps.debug(`completion-gate: ledger schedule failed: ${String(error)}`)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Harness-home path resolver, provided by @deepseek-ai/dsh-app-boot at boot. Optional in tests. */
    dshHomePath?: (...segments: string[]) => string
  }
}

/**
 * Create the `agent/turn-stopping` handler (§3.3/§3.4): SYNCHRONOUS — the
 * inject must land before the handler returns for the same-turn continuation
 * (`agent.ts:359-363`). Never throws into the loop.
 */
export function createTurnStoppingHandler(deps: {
  readSettings(): GateSettings
  lineage: LineageRegistry
  latches: Map<string, number>
  enforceMirror: Map<string, EnforceMirrorEntry>
  exhaustedTurns: Set<string>
  debug(message: string): void
}) {
  return ({ agent, turn, signal }: { agent: EvalAgent; turn: number; signal?: AbortSignal | undefined }): void => {
    try {
      // Cancellation precedence (§3.5 step 0, r2): an aborted turn gets no
      // gate inject and no exhaustion observation (memory-consolidation
      // precedent). The abandoned turn still reaches `turn/end`.
      if (signal?.aborted === true) return
      const evalDeps: EvaluateDeps = {
        settings: deps.readSettings(),
        lineage: deps.lineage,
        latches: deps.latches,
        enforceMirror: deps.enforceMirror,
        exhaustedTurns: deps.exhaustedTurns,
        debug: deps.debug,
      }
      evaluateTurnStopping(agent, turn, evalDeps)
    } catch (error: unknown) {
      deps.debug(`completion-gate: turn-stopping handler failed: ${String(error)}`)
    }
  }
}

/** Structural minimum of the `session/event` firehose session face (§3.5). */
export interface FirehoseSession {
  header?: {
    id?: unknown
    origin?: unknown
    delegationDepth?: unknown
    parentSession?: unknown
  }
  snapshotEvents(): readonly EvalEvent[]
  append?(type: string, data: unknown): void
}

/** Structural minimum of one `session/event` firehose payload. */
export interface FirehoseEvent {
  type: string
  data?: any
  seq?: number
}

/** Collaborators of the `turn/end` reconciliation (§3.5). */
export interface ReconcileDeps {
  readSettings(): GateSettings
  lineage: LineageRegistry
  enforceMirror: Map<string, EnforceMirrorEntry>
  exhaustedTurns: Set<string>
  debug(message: string): void
}

/**
 * Create the `turn/end` terminal reconciliation (§3.5): synchronous compute,
 * DEFERRED append. `turn/end` is appended in the `finally` of the harness
 * turn loop for every exit path (completed, error, aborted), which makes this
 * the reliable terminal point — the `enforce-exhausted` observation says
 * nothing about whether the turn ended, because other listeners may still
 * continue it (§3.7). Never throws into the firehose.
 */
export function createTurnEndReconciler(deps: ReconcileDeps) {
  return (session: FirehoseSession, event: FirehoseEvent): void => {
    try {
      if (event.type !== 'turn/end') return
      if (!isTopLevelSession(session as EvalSession)) return
      const turn = event.data?.turn
      if (typeof turn !== 'number') return
      const sessionId = typeof session.header?.id === 'string' ? session.header.id : undefined
      if (sessionId === undefined) return
      const key = `${sessionId}:${turn}`
      try {
        reconcileTurnEnd(session, sessionId, turn, key, deps)
      } finally {
        // Bounded (§3.3 step 2): the turn is finalized here, so the
        // append-failure backstop entry is dropped once reconciliation ran.
        deps.exhaustedTurns.delete(key)
      }
    } catch (error: unknown) {
      deps.debug(`completion-gate: turn/end reconciliation failed: ${String(error)}`)
    }
  }
}

/**
 * One terminal reconciliation (§3.5): exhaustion condition first (it must not
 * depend on the exhausted append having succeeded), then the SHARED evidence
 * computation (fail-opens ⇒ no marker), then the deferred idempotent append.
 */
function reconcileTurnEnd(
  session: FirehoseSession,
  sessionId: string,
  turn: number,
  key: string,
  deps: ReconcileDeps,
): void {
  const settings = deps.readSettings()
  const events = session.snapshotEvents()
  const exhaustedEvent = events.find(event => event.type === EXHAUSTED_EVENT && event.data?.turn === turn)
  const computed = computeUnmatched(session as EvalSession, turn, { lineage: deps.lineage }, true)
  if (computed.action === 'skip') return

  // Exhaustion (§3.5 step 1), append-failure independent: the durable
  // observation, the process-local backstop set, or the recomputed window
  // budget in force at turn/end.
  const exhausted = exhaustedEvent !== undefined
    || deps.exhaustedTurns.has(key)
    || (settings.mode === 'enforce'
      && spentCycles(
        events,
        sessionId,
        { startIndex: computed.startIndex, startOrdinal: computed.startOrdinal },
        deps.enforceMirror,
      ) >= settings['enforce-max-cycles'])
  if (!exhausted) return
  // Retraction / newly satisfied claims ⇒ the turn ended verified: no marker.
  if (computed.unmatched.length === 0) return

  const payload: EnforceMarker = {
    turn,
    claims: computed.unmatched.map(claim => claim.id),
    assistantTextHash: computed.assistantTextHash,
  }
  const mirrorEntry = deps.enforceMirror.get(sessionId)
  const lastInjectFailed = exhaustedEvent?.data?.lastInjectFailed === true
    || (mirrorEntry !== undefined
      && mirrorEntry.windowOrdinal === computed.startOrdinal
      && mirrorEntry.lastInjectFailed === true)
  if (lastInjectFailed) payload.lastInjectFailed = true

  // DEFERRED (§3.5 step 3, r2 P0): a synchronous `session.append` from inside
  // a `session/event` observer throws the reentry guard during the
  // publication window (progress-rebuild delivery.ts precedent). The
  // idempotence re-check runs INSIDE the microtask; an append failure there
  // is the documented audit gap (§3.6).
  queueMicrotask(() => {
    try {
      const fresh = session.snapshotEvents()
      if (fresh.some(event => event.type === UNVERIFIED_EVENT && event.data?.turn === turn)) return
      session.append?.(UNVERIFIED_EVENT, payload)
    } catch (error: unknown) {
      deps.debug(`completion-gate: unverified append failed: ${String(error)}`)
    }
  })
}

/** Which slice's listeners this module registers. */
export function registerListeners(ctx: Context): void {
  const lineage = new LineageRegistry()
  // Process-local nudge budget mirror (§3.4 step 3).
  const latches = new Map<string, number>()
  // Process-local enforce cycle mirror + exhaustion backstop (§3.3 steps 1-2):
  // allocated ONCE per mount, beside `latches`, never inside a handler.
  const enforceMirror = new Map<string, EnforceMirrorEntry>()
  const exhaustedTurns = new Set<string>()
  const debug = (message: string) => {
    try {
      ctx.logger.debug(message)
    } catch {
      // Debug sink failures are swallowed by contract.
    }
  }
  // Hot read on BOTH paths (§3.5): the raw user file, re-read per event.
  const readSettings = (): GateSettings => {
    const dshHome = dshHomeOf(ctx)
    return dshHome === undefined
      ? DEFAULT_GATE_SETTINGS
      : readUserSettingsSync(dshHome)
  }
  const readEnabled = () => {
    const dshHome = dshHomeOf(ctx)
    return dshHome !== undefined && readUserSettingsSync(dshHome).enabled
  }
  const reconcileTurnEnd = createTurnEndReconciler({
    readSettings,
    lineage,
    enforceMirror,
    exhaustedTurns,
    debug,
  })
  // Firehose observer: maintain the session registry for lift lookups (§3.2)
  // and run the `turn/end` terminal reconciliation (§3.5).
  ctx.on('session/event', ((session: FirehoseSession, event: FirehoseEvent) => {
    try {
      lineage.witness(session)
    } catch {
      // Registry hygiene must never break the firehose.
    }
    reconcileTurnEnd(session, event)
  }) as never)
  ctx.on('tools/post-execute', createPostExecuteHandler({
    readEnabled,
    receiptsDir: () => {
      const dshHome = dshHomeOf(ctx)
      return dshHome === undefined ? undefined : `${dshHome}/completion-gate/receipts`
    },
    lineage,
    debug,
  }), { prepend: true })
  // Turn-stopping gate listener (§3.3/§3.4): synchronous, shared registry,
  // same settings read path as post-execute (§3.5 hot read on BOTH paths).
  // The payload is bridged to the structural EvalAgent face (the real
  // Session.append generic is strictly narrower than the fixture face), and
  // the dispatch signal is threaded through for the abort check (§3.5 step 0).
  const turnStopping = createTurnStoppingHandler({
    readSettings,
    lineage,
    latches,
    enforceMirror,
    exhaustedTurns,
    debug,
  })
  ctx.on('agent/turn-stopping', ((payload: { agent: unknown; turn: number; signal?: AbortSignal }) => {
    turnStopping({ agent: payload.agent as never, turn: payload.turn, signal: payload.signal })
  }) as never)
}
