/**
 * Live-capacity guard for continuation admission (`send_message`).
 *
 * The 25 live-child cap is enforced on the spawn lanes in
 * `@dsh-cc/subagent-task` (`assertLiveCapacity` in `background-start.ts`).
 * Continuing a SETTLED child through `send_message` admits a fresh resident
 * activation, i.e. it needs one of the same slots — without this guard the cap
 * could be exceeded through continuations alone (a child settles, a slot
 * frees, two spawns refill it, and a continuation then overshoots).
 *
 * The refusal copy is the single runtime literal from the spawn lane; the task
 * package pins byte equality in its tests so the remedy text never drifts.
 *
 * Counting is unobservable-safe: a missing `subagents.listChildren` seam, a
 * throwing listing, or an absent `agents` registry degrades OPEN (admits),
 * mirroring the spawn guard — a hidden seam must not wedge continuations.
 */

import { acquireAdmission, type AdmissionLease } from './admission.ts'

/** Per-parent admission limit for continuable children; mirrors the spawn lane. */
export const MAX_LIVE_CONTINUABLE_CHILDREN = 25

/**
 * The one runtime refusal literal (D4 in the spawn lane). Byte-identical to
 * `LIVE_CAPACITY_REFUSAL` in `@dsh-cc/subagent-task`; pinned by test.
 */
export const LIVE_CAPACITY_REFUSAL = `parent has ${MAX_LIVE_CONTINUABLE_CHILDREN} live subagents; free a slot with `
  + 'release_agent on a running child (or /agents release <id> interactively), or '
  + 'let children settle — only running children hold slots, and only '
  + 'list_agents-visible children are releasable'

/** Structural seam shapes (duck-typed: this package cannot import the task package). */
export interface CapacitySubagentsLike {
  listChildren?(parentId: unknown, signal?: AbortSignal): Promise<{ id: string }[]>
}

export interface CapacityAgentsLike {
  get?(id: unknown): { status?: string } | undefined
}

export interface CapacityServices {
  get?(name: string, strict?: boolean): unknown
}

/**
 * Live (running) child count for a parent. `undefined` means unobservable —
 * the caller degrades open.
 */
export async function countLiveChildren(
  subagents: CapacitySubagentsLike | undefined,
  agents: CapacityAgentsLike | undefined,
  parentId: unknown,
  signal?: AbortSignal,
): Promise<number | undefined> {
  signal?.throwIfAborted()
  if (subagents?.listChildren === undefined) return undefined
  let children: { id: string }[]
  try {
    children = await subagents.listChildren(parentId, signal)
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
  signal?.throwIfAborted()
  // Only a RUNNING activation holds a slot (idle/ready rows hold none) —
  // the same predicate as the spawn lane's guard.
  return children.filter(child => agents?.get?.(child.id)?.status === 'running').length
}

/**
 * Refusal reason when admitting this continuation would exceed the cap;
 * `undefined` means admit.
 *
 * @param parent - the calling agent; an absent agent degrades open (no
 *   attributable capacity scope).
 */
export async function continuationCapacityRefusal(
  services: CapacityServices,
  parent: { id?: unknown } | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (parent === undefined || parent.id === undefined) return undefined
  const subagents = services.get?.('subagents') as CapacitySubagentsLike | undefined
  if (subagents?.listChildren === undefined) return undefined
  const agents = services.get?.('agents') as CapacityAgentsLike | undefined
  const live = await countLiveChildren(subagents, agents, parent.id, signal)
  if (live === undefined) return undefined
  return live >= MAX_LIVE_CONTINUABLE_CHILDREN ? LIVE_CAPACITY_REFUSAL : undefined
}

/** A successful admission owns the lease until the delivery settles. */
export type ContinuationAdmission =
  | { readonly admitted: true; readonly release: AdmissionLease }
  | { readonly admitted: false; readonly reason: string }

/**
 * Acquire at tools/execute, after approval. Check liveness under the same
 * parent lease as spawn; keep that lease through message acceptance (not the
 * child's epoch). Running targets need no new slot but still keep the lease:
 * they may settle while delivery waits. Child-to-parent reports need no slot.
 */
export async function admitContinuation(
  services: CapacityServices,
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
  try {
    const agents = services.get?.('agents') as CapacityAgentsLike | undefined
    if (agents?.get?.(targetId)?.status !== 'running') {
      const reason = await continuationCapacityRefusal(services, parent, signal)
      signal.throwIfAborted()
      if (reason !== undefined) { lease(); return { admitted: false, reason } }
    }
    signal.throwIfAborted()
    return { admitted: true, release: lease }
  } catch (error) {
    lease()
    throw error
  }
}
