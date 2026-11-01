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
import { acquireAdmission, type AdmissionLease } from '@dsh-cc/subagent-resume-pins'

/**
 * The tree-wide resident-activation cap (UX plan §3.6), restated as the cc
 * bundle's `maxActiveSubagents` pool configuration (`cordis.patch.yml`):
 * one pool per root activation tree, shared by local and external
 * descendants; a slot is reserved at materialization and returned only at
 * disposal. Kept as a constant so the refusal copy names the real number.
 */
export const MAX_LIVE_CONTINUABLE_CHILDREN = 25

/**
 * The single runtime refusal literal for the resident-capacity cap (D4). The
 * continuation admission in `@dsh-cc/subagent-resume-pins` carries the same
 * text, so the user-visible remedy cannot drift between the spawn lanes and
 * `send_message` continuations; a test pins byte equality.
 */
export const LIVE_CAPACITY_REFUSAL = `parent has ${MAX_LIVE_CONTINUABLE_CHILDREN} resident subagents in its activation `
  + 'tree (limit reached): the harness counts every resident activation in the tree — '
  + 'running children, idle parents waiting on child settlement, and cold-resumed '
  + 'children all hold slots; send_message follow-ups to an already-resident child do '
  + 'not. Free a slot with release_agent on a listed child (or /agents release <id> '
  + 'interactively), dispose children you no longer resume, or let running children settle'

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
