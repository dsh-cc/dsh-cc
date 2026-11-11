/**
 * The §3.6 admission lease and capacity-refusal copy, shared by every spawn
 * lane (`startBackground`, `collectForeground`, the ephemeral dispatch).
 *
 * As of the rc.5 subagent runtime the harness capacity pool
 * (`maxActiveSubagents`, configured to 25 in the cc bundle) is the ONLY
 * capacity valve: it counts resident activations per root-parent tree and
 * throws ACTIVATION_LIMIT_REACHED — there is no queue and no dsh-cc-side
 * running-count refusal anymore. What remains here is the F-1 atomic
 * admission lease (serialization of check+create per parent) and the single
 * refusal literal the pool's bare error is mapped onto for a user-visible
 * remedy.
 *
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  LIVE_CAPACITY_REFUSAL,
  MAX_LIVE_CONTINUABLE_CHILDREN,
  acquireAdmission,
  type AdmissionLease,
} from '@dsh-cc/subagent-resume-pins'

// The tree-wide resident-activation cap (UX plan §3.6) and the single runtime
// refusal literal (D4) now live in `@dsh-cc/subagent-resume-pins`; both are
// re-exported here so the spawn lane and `send_message` continuations cannot
// drift, and this module keeps its existing import surface.
export { MAX_LIVE_CONTINUABLE_CHILDREN, LIVE_CAPACITY_REFUSAL }

/**
 * Map the harness pool's bare ACTIVATION_LIMIT_REACHED throw onto the D4
 * refusal literal (which names the release_agent remedy); anything else
 * returns `undefined` so the caller rethrows it unchanged.
 */
export function capacityErrorRefusal(error: unknown): Error | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  const message = String((error as { message?: unknown }).message ?? error)
  if (code === 'ACTIVATION_LIMIT_REACHED' || message.includes('ACTIVATION_LIMIT_REACHED')) {
    return new Error(LIVE_CAPACITY_REFUSAL)
  }
  return undefined
}

/**
 * F-1: atomic admission. Takes the per-parent admission lease; the caller
 * holds it across the creation call and releases it once creation settled
 * (success or failure). The capacity DECISION belongs to the harness pool —
 * `startActivation` throwing ACTIVATION_LIMIT_REACHED is the refusal (map it
 * through {@link capacityErrorRefusal} for the remedy copy).
 */
export async function acquireLiveCapacity(
  parent: Agent,
  signal: AbortSignal,
): Promise<AdmissionLease> {
  return acquireAdmission(String(parent.id), signal)
}
