/**
 * Cancellation/status settlement for one in-flight ACP prompt (harness
 * 0.2.1-rc.5 shapes: cancellationDone + cancelStartedIdle + agent/status).
 *
 * These are upstream rc.5's inline session.ts forms (onAgentError,
 * onAgentStatus, cancelPrompt, and the quiescence loop in
 * settleAfterQuiescence) extracted verbatim into module functions so
 * session.ts stays inside its 558-line size budget. Comments preserved from
 * upstream explain the sequencing; the helpers hold no CC behavior delta.
 *
 * @module @dsh-cc/acp/cancellation-status
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** The inflight slice the settlement helpers read and mutate. */
export interface InflightSettlement {
  messageQueued: boolean
  agentError: Error | undefined
  admissionController: AbortController
  cancellationDone: PromiseWithResolvers<void>
  cancelStartedIdle: boolean
}

/** Subagent descendant observation without depending on the subagent package. */
export interface SubagentWaiter {
  waitForChildren(parent: Agent): Promise<boolean>
}

/**
 * Correlate an Agent interval failure with the active ACP prompt (upstream
 * rc.5 onAgentError body).
 * @param inflight - the admitted prompt record.
 * @param message - already-rendered failure chain.
 * @param settle - starts settlement once quiescent.
 */
export function noteAgentError(inflight: InflightSettlement, message: string, settle: () => void): void {
  if (!inflight.messageQueued) return
  // A later committed turn/end supersedes this live failure. Failed turn
  // start/end appends have no terminal record and keep the failure observable.
  inflight.agentError = new Error(message)
  settle()
}

/**
 * Complete cancelled activity without following a later root driver (upstream
 * rc.5 onAgentStatus body).
 * @param inflight - the admitted prompt record.
 * @param status - the emitted transition, which may precede a reentrant wake.
 * @param outputTail - every update queued before this transition.
 */
export function settleCancelledOnStatus(
  inflight: InflightSettlement,
  status: string,
  outputTail: Promise<void>,
): void {
  if (!inflight.messageQueued || !inflight.admissionController.signal.aborted) return
  // Maintenance remains publicly idle; its next running transition belongs
  // to work released after the maintenance task finished.
  if (status === 'idle' || inflight.cancelStartedIdle) inflight.cancellationDone.resolve(outputTail)
}

/**
 * Abort one admitted prompt, cancel any queued drive, and arm the idle
 * fallback (upstream rc.5 cancelPrompt body).
 * @param agent - the session's exact top-level Agent.
 * @param inflight - the admitted prompt record.
 * @param detail - cancellation detail for the abort reason.
 * @param settle - starts settlement once quiescent.
 * @param outputTail - reads every update queued before the cancel.
 */
export function requestPromptCancellation(
  agent: Agent,
  inflight: InflightSettlement,
  detail: string,
  settle: () => void,
  outputTail: () => Promise<void>,
): void {
  const firstCancellation = !inflight.admissionController.signal.aborted
  if (firstCancellation) inflight.cancelStartedIdle = agent.status === 'idle'
  inflight.admissionController.abort(new Error(detail))
  settle()
  if (!inflight.messageQueued) {
    inflight.cancellationDone.resolve()
    return
  }
  agent.cancel({ kind: 'user' })
  if (firstCancellation) {
    const done = inflight.cancellationDone
    // Plugin disposal can detach status observers before this activity retires.
    void agent.whenIdle().then(() => { done.resolve(outputTail()) }, done.reject)
  }
}

/**
 * Wait out the root driver, observed descendants, and queued updates
 * (upstream rc.5 settleAfterQuiescence loop).
 * @param agent - the session's exact top-level Agent.
 * @param subagents - the descendant observer, when the service is composed.
 * @param inflight - the admitted prompt record.
 * @param outputTail - reads every update queued before the read.
 */
export async function awaitQuiescence(
  agent: Agent,
  subagents: SubagentWaiter | undefined,
  inflight: InflightSettlement,
  outputTail: () => Promise<void>,
): Promise<void> {
  const cancelled = inflight.cancellationDone.promise
  const isCancelled = (): boolean => inflight.admissionController.signal.aborted
  const idleAt = (seq: Session['seq']): boolean => agent.status === 'idle' && agent.session.seq === seq
  while (true) {
    await Promise.race([agent.whenIdle(), cancelled])
    if (isCancelled()) break
    const idleSeq = agent.session.seq
    const children = await Promise.race([subagents?.waitForChildren(agent), cancelled])
    if (isCancelled()) break
    if (children || !idleAt(idleSeq)) continue
    await outputTail()
    if (isCancelled() || idleAt(idleSeq)) break
  }
  if (isCancelled()) await cancelled
}
