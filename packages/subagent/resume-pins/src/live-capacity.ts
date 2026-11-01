/**
 * Admission serialization for continuation dispatch (`send_message`).
 *
 * As of the rc.5 subagent runtime the harness capacity pool
 * (`maxActiveSubagents`, configured to 25 in the cc bundle) is the ONLY
 * capacity valve — for fresh activations AND for cold-resumed continuations
 * alike (a follow-up to an already-resident child takes no slot). The dsh-cc
 * running-count refusal that used to gate continuations is deleted; a
 * cold resume that would overshoot simply lets the harness throw
 * ACTIVATION_LIMIT_REACHED downstream.
 *
 * What remains here: the per-parent admission lease that serializes
 * continuation acceptance with spawn dispatch, and the single refusal
 * literal kept byte-identical to the spawn lane's so the remedy copy cannot
 * drift (a test pins equality).
 */

import { acquireAdmission, type AdmissionLease } from './admission.ts'

/** The tree-wide resident-activation cap; mirrors the spawn lane. */
export const MAX_LIVE_CONTINUABLE_CHILDREN = 25

/**
 * The one runtime refusal literal (D4 in the spawn lane). Byte-identical to
 * `LIVE_CAPACITY_REFUSAL` in `@dsh-cc/subagent-task`; pinned by test.
 */
export const LIVE_CAPACITY_REFUSAL = `parent has ${MAX_LIVE_CONTINUABLE_CHILDREN} resident subagents in its activation `
  + 'tree (limit reached): the harness counts every resident activation in the tree — '
  + 'running children, idle parents waiting on child settlement, and cold-resumed '
  + 'children all hold slots; send_message follow-ups to an already-resident child do '
  + 'not. Free a slot with release_agent on a listed child (or /agents release <id> '
  + 'interactively), dispose children you no longer resume, or let running children settle'

export interface CapacityServices {
  get?(name: string, strict?: boolean): unknown
}

/** A successful admission owns the lease until the delivery settles. */
export type ContinuationAdmission =
  | { readonly admitted: true; readonly release: AdmissionLease }
  | { readonly admitted: false; readonly reason: string }

/**
 * Acquire at tools/execute, after approval. Keeps the per-parent lease
 * through message acceptance (not the child's epoch): a cold resume spends a
 * pool slot inside that window, and a running target may settle while
 * delivery waits. Child-to-parent reports keep their exemption. The capacity
 * DECISION belongs to the harness pool — no dsh-cc-side counting here
 * anymore.
 */
export async function admitContinuation(
  _services: CapacityServices,
  parent: { id?: unknown; session?: { header?: { parentSession?: unknown } } } | undefined,
  targetId: string,
  signal: AbortSignal,
): Promise<ContinuationAdmission> {
  signal.throwIfAborted()
  const reportingTo = parent?.session?.header?.parentSession
  if (parent?.id === undefined || (reportingTo !== undefined && String(reportingTo) === targetId)) {
    return { admitted: true, release: () => undefined }
  }
  const lease = await acquireAdmission(String(parent.id), signal)
  return { admitted: true, release: lease }
}
