/**
 * Restore schedules — the detect half's per-session bookkeeping (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Detect, semantics
 * pinned by the verified model `specs/tla/compaction-pin-restore`).
 *
 * One schedule exists per `compactionId` whose summary reported at least one
 * restorable pin (`shadowedSeqs ∩ ring`). The summary is **provisional**
 * evidence: the engine appends `compaction/summary` BEFORE the checkpoint
 * commit (`packages/compaction/compaction-basic/src/region.ts`
 * `commitCompactionBody` in the pinned harness copy), so a logged summary with
 * `shadowedSeqs` can exist while nothing was actually shadowed. Two outcomes
 * settle a schedule:
 *
 * - **rule (a)** — a successful `compaction/end` arrived for that id
 *   ({@link ScheduleStore.succeed}): the checkpoint committed (the engine only
 *   reaches the end append after `commitCompactionBody` returned — the same
 *   file's `closing = true` ordering), so the pins really are gone from the
 *   surface and may be re-appended in the very same drain;
 * - **rule (b)** — the conservative rule: no end of any kind has been seen,
 *   the schedule has existed for ≥ {@link RULE_B_TURNS} turn, AND the
 *   compaction's checkpoint commit was actually WITNESSED
 *   ({@link ScheduleStore.commit}, set by the replacement `user/message` that
 *   cites the summary's seq). The commit gate is load-bearing, not decoration:
 *   the model's `RequireCheckpoint` constant is the difference between the
 *   verified convention and the red `strict-blind-rule-b` probe — without it
 *   the F3 double failure (checkpoint append fails AND the error-end append
 *   fails) leaves a summary-only phantom that rule (b) would "restore" over a
 *   live original (`NoPhantom` / `AtMostOneLivePerPin` violations). See
 *   `specs/tla/compaction-pin-restore/design.md` R4 and the model's
 *   "Notes for implementers".
 * - **cancelled** — an end carrying `error` deletes the schedule outright
 *   ({@link ScheduleStore.cancel}): the belt, §Detect.
 *
 * Schedules that never become eligible age out after
 * {@link SCHEDULE_GC_TURNS} turns ({@link ScheduleStore.gcDead}), mirroring the
 * model's `Dead` predicate — a session cannot accumulate stranded schedules
 * from compacted-away failure windows.
 *
 * @module
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * One restorable pin: the shadowed seq and the exact message object captured
 * for it. The message is the object the session published — restore re-appends
 * it verbatim (§Restore), so nothing destructured it on the way here.
 */
export interface RestoreItem {
  /** Session log seq of the shadowed `user/message` event (the drain order key). */
  readonly seq: number
  /** The verbatim captured message (§Capture verbatim rule). */
  readonly message: UserMessage
}

/** Turns a schedule must survive before rule (b) may make it eligible. */
export const RULE_B_TURNS = 1

/** Turns a non-eligible schedule survives before the drain garbage-collects it. */
export const SCHEDULE_GC_TURNS = 2

/** One pending restore schedule, keyed by the compaction that produced it. */
export interface RestoreSchedule {
  /** The `compactionId` all three lifecycle events share. */
  readonly compactionId: string
  /** Restorable pins, ascending by original seq. */
  readonly items: readonly RestoreItem[]
  /** Turn-clock value when the summary was observed (rule (b) ageing). */
  readonly createdTurn: number
  /** Rule (a): a successful `compaction/end` arrived. */
  succeeded: boolean
  /** The checkpoint replacement citing this compaction's summary was observed. */
  committed: boolean
}

/** Per-session schedule storage: the restore half's whole mutable state. */
export interface ScheduleStore {
  /** Pending schedules (diagnostics/tests). */
  readonly size: number
  /**
   * Schedule (or extend) the restores for one compaction. Re-reporting the
   * same id unions the pin sets and keeps the earliest creation turn, so a
   * duplicate summary can never rewind rule-(b) ageing.
   * @param compactionId - the lifecycle id.
   * @param items - restorable pins for this report.
   * @param createdTurn - the turn clock when the summary was observed.
   * @returns the live schedule.
   */
  arm(compactionId: string, items: readonly RestoreItem[], createdTurn: number): RestoreSchedule
  /** One schedule, without creating it. */
  get(compactionId: string): RestoreSchedule | undefined
  /** Record a successful end (rule (a)). `false` when nothing was pending. */
  succeed(compactionId: string): boolean
  /** The belt: drop the schedule for an end that carried `error`. */
  cancel(compactionId: string): boolean
  /** Record the witnessed checkpoint commit (rule (b)'s gate). */
  commit(compactionId: string): boolean
  /**
   * Whether one schedule may drain at the given turn: rule (a), or rule (b)
   * (aged at least {@link RULE_B_TURNS} turn AND a witnessed checkpoint).
   */
  isEligible(schedule: RestoreSchedule, turn: number): boolean
  /** Every eligible schedule, in creation order. */
  eligible(turn: number): RestoreSchedule[]
  /** Every pending schedule, in creation order. */
  pending(): RestoreSchedule[]
  /** Remove one schedule (the drain consumes eligible ones this way). */
  drop(compactionId: string): void
  /**
   * Drop schedules aged past the rule-(b) window without becoming eligible.
   * @param turn - the current turn-clock value.
   * @returns how many were collected.
   */
  gcDead(turn: number): number
  /** Drop every schedule (session disposal / tests). */
  clear(): void
}

/** Union two item lists by seq, ascending — later reports never duplicate a pin. */
function mergeItems(previous: readonly RestoreItem[], incoming: readonly RestoreItem[]): RestoreItem[] {
  const bySeq = new Map<number, RestoreItem>()
  for (const item of [...previous, ...incoming]) {
    if (!bySeq.has(item.seq)) bySeq.set(item.seq, item)
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/**
 * Raise one session's turn clock monotonically (the rule-(b) signal; the
 * caller documents where the value comes from). Structure-typed on purpose: the
 * clock lives on `PinningState` and this module owns no per-session state.
 * @param state - the object carrying the clock.
 * @param turn - a candidate turn value (ignored unless a safe integer).
 * @returns the clock's value after the raise.
 */
export function raiseTurn(state: { turn: number }, turn: unknown): number {
  if (typeof turn === 'number' && Number.isSafeInteger(turn) && turn > state.turn) state.turn = turn
  return state.turn
}

/**
 * Create one session's schedule store.
 * @returns the store (empty).
 */
export function createScheduleStore(): ScheduleStore {
  const schedules = new Map<string, RestoreSchedule>()

  const isEligible = (schedule: RestoreSchedule, turn: number): boolean =>
    schedule.succeeded
    || (turn - schedule.createdTurn >= RULE_B_TURNS && schedule.committed)

  return {
    get size(): number {
      return schedules.size
    },
    arm(compactionId: string, items: readonly RestoreItem[], createdTurn: number): RestoreSchedule {
      const existing = schedules.get(compactionId)
      if (existing !== undefined) {
        const merged: RestoreSchedule = {
          compactionId,
          items: mergeItems(existing.items, items),
          createdTurn: Math.min(existing.createdTurn, createdTurn),
          succeeded: existing.succeeded,
          committed: existing.committed,
        }
        schedules.set(compactionId, merged)
        return merged
      }
      const schedule: RestoreSchedule = {
        compactionId,
        items: mergeItems([], items),
        createdTurn,
        succeeded: false,
        committed: false,
      }
      schedules.set(compactionId, schedule)
      return schedule
    },
    get: (compactionId: string): RestoreSchedule | undefined => schedules.get(compactionId),
    succeed(compactionId: string): boolean {
      const existing = schedules.get(compactionId)
      if (existing === undefined) return false
      existing.succeeded = true
      return true
    },
    cancel: (compactionId: string): boolean => schedules.delete(compactionId),
    commit(compactionId: string): boolean {
      const existing = schedules.get(compactionId)
      if (existing === undefined) return false
      existing.committed = true
      return true
    },
    isEligible,
    eligible: (turn: number): RestoreSchedule[] =>
      [...schedules.values()].filter((schedule) => isEligible(schedule, turn)),
    pending: (): RestoreSchedule[] => [...schedules.values()],
    drop: (compactionId: string): void => {
      schedules.delete(compactionId)
    },
    gcDead(turn: number): number {
      let collected = 0
      for (const schedule of [...schedules.values()]) {
        if (isEligible(schedule, turn)) continue
        if (turn - schedule.createdTurn < SCHEDULE_GC_TURNS) continue
        schedules.delete(schedule.compactionId)
        collected += 1
      }
      return collected
    },
    clear: (): void => {
      schedules.clear()
    },
  }
}
