/**
 * The §3.6 live-capacity cap and its guards, shared by every spawn lane
 * (`startBackground`, `collectForeground`, the ephemeral dispatch). Split out
 * of `background-start.ts` so the cap, its single refusal literal, and the F-1
 * atomic admission live in one place.
 *
 * @module
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { acquireAdmission, pendingContinuations, type AdmissionLease } from '@dsh-cc/subagent-resume-pins'
import type { SubagentsLike } from './background-start.ts'

/**
 * Per-parent admission limit for continuable children (UX plan §3.6). As of
 * rc.2 the upstream subagent seam caps per-epoch resident activations
 * (`maxActiveSubagents`, default 8) and fails bare ACTIVATION_LIMIT_REACHED with
 * no remedy pointer; this cap counts a different thing — cross-epoch live
 * children (`listChildren` rows with a live running activation; the catalog row
 * no longer carries `activity`) — so the refusal can name the user-visible
 * remedy (release_agent / `/agents release`). A safety valve, not a
 * scheduling policy.
 */
export const MAX_LIVE_CONTINUABLE_CHILDREN = 25

/**
 * The single runtime refusal literal for the live-capacity cap (D4). The
 * continuation guard in `@dsh-cc/subagent-resume-pins` reuses the same text
 * for the same cap, so the user-visible remedy cannot drift between the spawn
 * lanes and `send_message` continuations; a test pins byte equality.
 */
export const LIVE_CAPACITY_REFUSAL = `parent has ${MAX_LIVE_CONTINUABLE_CHILDREN} live subagents; free a slot with `
  + 'release_agent on a running child (or /agents release <id> interactively), or '
  + 'let children settle — only running children hold slots, and only '
  + 'list_agents-visible children are releasable'

/**
 * The §3.6 capacity guard (both `startBackground` and the collect path):
 * refuse a new continuable child when the parent already has
 * {@link MAX_LIVE_CONTINUABLE_CHILDREN} live children. rc.2 dropped the
 * catalog's `activity` field, so liveness is re-derived from the live agents
 * registry (`agents.get(id)?.status === 'running'`) — the same derivation
 * rc.2's own consumer uses. Degrades open on seam/listing/registry trouble:
 * a safety valve never blocks starts on its own infrastructure.
 */
export async function assertLiveCapacity(
  seam: SubagentsLike,
  parent: Agent,
  signal: AbortSignal,
  /** Lane-specific refusal (the ephemeral branch names one-shot runs); default keeps the D4 continuable literal. */
  refuse?: (live: number) => Error,
): Promise<void> {
  if (typeof seam.listChildren !== 'function') return
  let children: { id: string; mode?: string }[]
  try {
    children = await seam.listChildren(parent.id, signal)
  } catch {
    return
  }
  // The live registry sits beside the subagents seam on the same context;
  // an absent registry (or a bare fixture agent without a ctx) degrades the
  // guard open (no false blocks).
  const agents = parent.ctx?.get?.('agents') as { get?(id: string): { status?: string } | undefined } | undefined
  const isRunning = (id: string): boolean => agents?.get?.(id)?.status === 'running'
  // Slots already promised to in-flight `send_message` continuations count too:
  // the same admission (resume-pins/admission.ts) guards both lanes.
  const live = children.filter(child => isRunning(child.id)).length + pendingContinuations(String(parent.id), isRunning)
  if (live >= MAX_LIVE_CONTINUABLE_CHILDREN) {
    // Single runtime literal (D4; T16 pins full equality against exactly it):
    // the copy names the real release path — /agents stop cannot free a slot.
    throw refuse !== undefined ? refuse(live) : new Error(LIVE_CAPACITY_REFUSAL)
  }
}

/**
 * F-1: atomic admission. Takes the per-parent admission lease, THEN runs the
 * capacity guard under it; the caller holds the lease across the creation
 * call and releases it once creation settled (success or failure). A refusal
 * releases the lease before throwing, so a refused admission never blocks the
 * queue. Same refusal copy and degrade-open behavior as {@link assertLiveCapacity}.
 */
export async function acquireLiveCapacity(
  seam: SubagentsLike,
  parent: Agent,
  signal: AbortSignal,
  refuse?: (live: number) => Error,
): Promise<AdmissionLease> {
  const lease = await acquireAdmission(String(parent.id), signal)
  try {
    await assertLiveCapacity(seam, parent, signal, refuse)
  } catch (error) {
    lease()
    throw error
  }
  return lease
}
