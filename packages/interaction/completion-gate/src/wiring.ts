/**
 * Live wiring for the completion gate (plan
 * docs/plans/2026-10-09-runtime-verified-completion.md §3.2–§3.5): the
 * `tools/post-execute` receipt listener (§3.2) and the SYNCHRONOUS
 * `agent/turn-stopping` nudge listener (§3.3/§3.4). Both listeners share one
 * LineageRegistry instance and the same `readUserSettingsSync` read path, so
 * settings hot-toggle takes effect on the next event (§3.5).
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
import { RECEIPT_EVENT, type Receipt } from './events.ts'
import { buildReceipt } from './receipts.ts'
import { appendLedgerRow, ledgerFileFor, ledgerRowOf } from './ledger.ts'
import { LineageRegistry, type SessionLike } from './lineage.ts'
import { readUserSettingsSync, type GateSettings } from './settings.ts'
import {
  evaluateTurnStopping,
  maybeResolveOnReceipt,
  type EvalAgent,
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
  debug(message: string): void
}) {
  return ({ agent, turn }: { agent: EvalAgent; turn: number }): void => {
    try {
      const evalDeps: EvaluateDeps = {
        settings: deps.readSettings(),
        lineage: deps.lineage,
        latches: deps.latches,
        debug: deps.debug,
      }
      evaluateTurnStopping(agent, turn, evalDeps)
    } catch (error: unknown) {
      deps.debug(`completion-gate: turn-stopping handler failed: ${String(error)}`)
    }
  }
}

/** Which slice's listeners this module registers. */
export function registerListeners(ctx: Context): void {
  const lineage = new LineageRegistry()
  // Process-local nudge budget mirror (§3.4 step 3).
  const latches = new Map<string, number>()
  const debug = (message: string) => {
    try {
      ctx.logger.debug(message)
    } catch {
      // Debug sink failures are swallowed by contract.
    }
  }
  const readEnabled = () => {
    const dshHome = dshHomeOf(ctx)
    return dshHome !== undefined && readUserSettingsSync(dshHome).enabled
  }
  // Firehose observer: maintain the session registry for lift lookups (§3.2).
  ctx.on('session/event', (session: SessionLike) => {
    try {
      lineage.witness(session)
    } catch {
      // Registry hygiene must never break the firehose.
    }
  })
  ctx.on('tools/post-execute', createPostExecuteHandler({
    readEnabled,
    receiptsDir: () => {
      const dshHome = dshHomeOf(ctx)
      return dshHome === undefined ? undefined : `${dshHome}/completion-gate/receipts`
    },
    lineage,
    debug,
  }), { prepend: true })
  // Turn-stopping nudge listener (§3.3/§3.4): synchronous, shared registry,
  // same settings read path as post-execute (§3.5 hot read on BOTH paths).
  // The payload is bridged to the structural EvalAgent face (the real
  // Session.append generic is strictly narrower than the fixture face).
  const turnStopping = createTurnStoppingHandler({
    readSettings: () => {
      const dshHome = dshHomeOf(ctx)
      return dshHome === undefined
        ? { enabled: false, 'nudges-per-session': 1 }
        : readUserSettingsSync(dshHome)
    },
    lineage,
    latches,
    debug,
  })
  ctx.on('agent/turn-stopping', ((payload: { agent: unknown; turn: number }) => {
    turnStopping({ agent: payload.agent as never, turn: payload.turn })
  }) as never)
}
