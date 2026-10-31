/** Status-driven settlement for a cancelled ACP prompt (harness 0.2.1-rc.5). */

/** The inflight fields the status rule reads. */
export interface CancellationState {
  readonly messageQueued: boolean
  readonly admissionController: { readonly signal: AbortSignal }
}

/**
 * Settle a cancelled prompt when the agent reports idle.
 * @param inflight - the active prompt state.
 * @param status - the emitted agent status.
 * @param settle - completes the prompt once quiescent.
 */
export function settleCancelledOnStatus(
  inflight: CancellationState,
  status: string,
  settle: () => void,
): void {
  if (!inflight.messageQueued || !inflight.admissionController.signal.aborted) return
  if (status === 'idle') settle()
}

/** The inflight fields the error rule reads and writes. */
export interface ErrorState extends CancellationState {
  agentError?: Error | undefined
}

/**
 * Record an interval failure and settle once quiescent.
 * @param inflight - the active prompt state.
 * @param message - already-rendered failure text.
 * @param settle - completes the prompt once quiescent.
 */
export function noteAgentError(inflight: ErrorState, message: string, settle: () => void): void {
  if (!inflight.messageQueued) return
  // A later committed turn/end supersedes this live failure; failed turn
  // start/end appends have no terminal record and keep the failure observable.
  inflight.agentError = new Error(message)
  settle()
}
