/**
 * Detect specs (design
 * docs/plans/2026-11-12-compaction-governed-pinning.md §Detect, §Verification):
 *
 * - the summary is PROVISIONAL evidence: a `compaction/summary` carrying
 *   `shadowedSeqs` arms a schedule from `shadowedSeqs ∩ ring` and nothing else;
 * - an empty intersection is a no-op;
 * - the BELT is load-bearing and regression-pinned: `compaction/end` carrying
 *   `error` CANCELS the schedule, so nothing is ever appended for that id even
 *   turns later (the failed-commit path logs a summary first — that is exactly
 *   the premise the belt rejects);
 * - rule (a): a clean `compaction/end` makes the schedule restorable at once;
 * - rule (b): no end at all + ≥ 1 turn + a WITNESSED checkpoint commit restores
 *   conservatively, while the same schedule without a witnessed commit never
 *   restores (the F3 double-failure window — the phantom guard the verified
 *   model `specs/tla/compaction-pin-restore` calls `RequireCheckpoint`);
 * - dead schedules age out (bounded memory).
 *
 * Everything runs against the REAL session log/surface validator (see
 * `./rig.ts`); the compaction lifecycle is appended exactly as the engine
 * records it.
 *
 * @module
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as Plugin from '../src/index.ts'
import {
  appendCompaction,
  derivedUserTexts,
  governanceMessage,
  humanMessage,
  liveRig,
  publish,
  resetCompactionIds,
  rigSettings,
  runPreStep,
  startTurn,
  type Rig,
} from './rig.ts'

beforeEach(() => {
  // The health counters are process-wide (task A's specs share them).
  Plugin.resetPinningHealth()
  resetCompactionIds()
})

/** The pending schedules of the rig's one session. */
function schedules(rig: Rig): Plugin.ScheduleStore {
  const state = rig.states.peek('cp-root')
  expect(state).toBeDefined()
  return state!.schedules
}

describe('detect — the summary is provisional scheduling evidence', () => {
  it('arms a schedule from shadowedSeqs ∩ ring, ascending by original seq', async () => {
    const rig = await liveRig()
    const first = publish(rig.agent, governanceMessage('pin one'))
    const noise = publish(rig.agent, humanMessage('a human prompt'))
    const second = publish(rig.agent, governanceMessage('pin two', 'edit-recovery-hint'))
    startTurn(rig.agent.session, 1)

    // Start + summary only (no checkpoint, no end): the summary is all the
    // detect half is allowed to trust at this point.
    const record = appendCompaction(rig.agent.session, {
      turn: 1,
      omitEnd: true,
      checkpoint: false,
      // The engine reports shadowed seqs in SURFACE order; the schedule must
      // come back ordered by the ORIGINAL seq regardless.
      shadowedSeqs: [second.seq, noise.seq, first.seq],
    })

    const schedule = schedules(rig).get(record.compactionId)
    expect(schedule).toBeDefined()
    // The human prompt is shadowed but was never pinned → not restorable.
    expect(schedule!.items.map((item) => item.seq)).toEqual([first.seq, second.seq])
    expect(schedule!.createdTurn).toBe(1)
    expect(schedule!.succeeded).toBe(false)
    expect(schedule!.committed).toBe(false)
  })

  it('no-ops when the shadowed range holds no pinned message', async () => {
    const rig = await liveRig()
    publish(rig.agent, humanMessage('just a prompt'))
    startTurn(rig.agent.session, 1)

    appendCompaction(rig.agent.session, { turn: 1, omitEnd: true, checkpoint: false })

    // No pinned message was ever captured, so no per-session state exists at
    // all — detect is strictly downstream of capture.
    expect(rig.states.peek('cp-root')).toBeUndefined()
  })

  it('no-ops when the summary carries no shadowedSeqs at all', async () => {
    const rig = await liveRig()
    publish(rig.agent, governanceMessage('pin one'))
    startTurn(rig.agent.session, 1)

    // A producer that logs a summary without a shadowed set: nothing to schedule.
    rig.agent.session.append('compaction/summary', {
      compactionId: 'cp-no-seqs',
      summary: [{ type: 'text', text: 'no seqs' }],
      shadowedRange: { start: 0, end: 0 },
      provider: 'mock',
      model: 'mock',
    } as never)

    expect(schedules(rig).size).toBe(0)
  })

  it('ignores shadowed seqs the ring no longer holds (evicted before the summary)', async () => {
    const rig = await liveRig({ maxPinned: 1 })
    const evicted = publish(rig.agent, governanceMessage('pin one'))
    const kept = publish(rig.agent, governanceMessage('pin two'))
    startTurn(rig.agent.session, 1)

    const record = appendCompaction(rig.agent.session, {
      turn: 1,
      omitEnd: true,
      checkpoint: false,
      shadowedSeqs: [evicted.seq, kept.seq],
    })

    expect(schedules(rig).get(record.compactionId)!.items.map((item) => item.seq)).toEqual([kept.seq])
  })
})

describe('detect — the belt: end-with-error cancels (load-bearing regression)', () => {
  it('BELT: a failed commit logs a summary, then end(error) cancels the schedule → nothing is ever appended', async () => {
    const rig = await liveRig()
    const pin = publish(rig.agent, governanceMessage('Always run the focused test before claiming a fix.'))
    startTurn(rig.agent.session, 1)
    const before = derivedUserTexts(rig.agent.session)

    // The F1 failed-commit path (engine `region.ts`): summary already logged,
    // checkpoint append throws, so the catch appends `compaction/end` with
    // `error` — the shadowing never happened.
    const record = appendCompaction(rig.agent.session, { turn: 1, failEnd: true, checkpoint: false })
    expect(rig.seen.some((event) => event.type === 'compaction/summary'
      && (event.data as { compactionId?: string }).compactionId === record.compactionId)).toBe(true)

    // The belt ran: the schedule is gone.
    expect(schedules(rig).size).toBe(0)
    expect(schedules(rig).get(record.compactionId)).toBeUndefined()

    // And it stays gone: even several turns later (where rule (b) would
    // otherwise have fired) the drain appends nothing.
    for (const turn of [1, 2, 3, 5]) await runPreStep(rig, { turn })
    expect(derivedUserTexts(rig.agent.session)).toEqual(before)
    expect(Plugin.getPinningHealth().restored).toBe(0)
    expect(rig.states.peek('cp-root')!.ring.has(pin.seq)).toBe(true)
  })

  it('BELT: cancellation also covers the committed-then-failed window (checkpoint landed, end(error) arrived)', async () => {
    const rig = await liveRig()
    publish(rig.agent, governanceMessage('pin survives'))
    startTurn(rig.agent.session, 1)

    // A checkpoint that landed and an error end: nothing in the model permits a
    // restore here (the engine never pairs those, but a cancel is unconditional).
    appendCompaction(rig.agent.session, { turn: 1, failEnd: true })

    expect(schedules(rig).size).toBe(0)
    await runPreStep(rig, { turn: 2 })
    expect(Plugin.getPinningHealth().restored).toBe(0)
  })
})

describe('detect — eligibility (rule (a) and the committed rule (b))', () => {
  it('rule (a): a clean end makes the schedule eligible at the same turn', async () => {
    const rig = await liveRig()
    publish(rig.agent, governanceMessage('pin one'))
    startTurn(rig.agent.session, 1)

    const record = appendCompaction(rig.agent.session, { turn: 1 })

    const schedule = schedules(rig).get(record.compactionId)!
    expect(schedule.succeeded).toBe(true)
    expect(schedules(rig).isEligible(schedule, 1)).toBe(true)
  })

  it('rule (b): no end + ≥ 1 turn + a witnessed checkpoint commit → conservative eligibility drains', async () => {
    const rig = await liveRig()
    const pin = publish(rig.agent, governanceMessage('conservative pin'))
    startTurn(rig.agent.session, 1)

    // Summary + checkpoint, and NO end ever (the F2 window: end append failed).
    const record = appendCompaction(rig.agent.session, { turn: 1, omitEnd: true })
    const schedule = schedules(rig).get(record.compactionId)!
    expect(schedule.succeeded).toBe(false)
    expect(schedule.committed).toBe(true)
    // Same turn: not yet (rule (b) needs one full turn).
    expect(schedules(rig).isEligible(schedule, 1)).toBe(false)
    await runPreStep(rig, { turn: 1 })
    expect(Plugin.getPinningHealth().restored).toBe(0)
    expect(schedules(rig).size).toBe(1)

    // Next turn: rule (b) fires and the pin comes back.
    await runPreStep(rig, { turn: 2 })
    expect(Plugin.getPinningHealth().restored).toBe(1)
    expect(derivedUserTexts(rig.agent.session)).toContain('conservative pin')
    expect(schedules(rig).size).toBe(0)
    expect(rig.states.peek('cp-root')!.ring.has(pin.seq)).toBe(true)
  })

  it('rule (b) NEVER fires without a witnessed checkpoint commit (F3 phantom guard)', async () => {
    const rig = await liveRig()
    publish(rig.agent, governanceMessage('never shadowed pin'))
    startTurn(rig.agent.session, 1)
    const before = derivedUserTexts(rig.agent.session)

    // F3: the checkpoint append failed AND the error-end append failed — a
    // summary with shadowedSeqs and no durable proof that anything was replaced.
    const record = appendCompaction(rig.agent.session, { turn: 1, omitEnd: true, checkpoint: false })
    expect(schedules(rig).get(record.compactionId)!.committed).toBe(false)

    for (const turn of [1, 2, 3, 4]) await runPreStep(rig, { turn })

    // Restoring here would duplicate a message the surface still holds
    // (`NoPhantom` / `AtMostOneLivePerPin` in the verified model).
    expect(derivedUserTexts(rig.agent.session)).toEqual(before)
    expect(Plugin.getPinningHealth().restored).toBe(0)
    // …and the stranded schedule ages out instead of lingering.
    expect(schedules(rig).size).toBe(0)
  })

  it('only a replacement that CITES the summary witnesses the commit', async () => {
    const rig = await liveRig()
    publish(rig.agent, governanceMessage('pin one'))
    startTurn(rig.agent.session, 1)
    const record = appendCompaction(rig.agent.session, { turn: 1, omitEnd: true, checkpoint: false })

    // A replacement over the same surface range that does not cite the summary
    // seq (the engine always cites `[start, summary, ...shadowed]`) — the
    // witness needs the citation, not merely a replace op.
    const nodes = [...rig.agent.session.surface.nodes]
    rig.agent.session.append('user/message', humanMessage('[summary of the compacted range]'), {
      surfaceOp: { op: 'replace', startSeq: nodes[0]!, endSeq: nodes[nodes.length - 1]! },
      sourceEventSeqs: [...nodes],
    })

    expect(schedules(rig).get(record.compactionId)!.committed).toBe(false)
  })

  it('captures nothing while disabled: the compaction still commits but nothing is scheduled', async () => {
    const rig = await liveRig({ enabled: false })
    publish(rig.agent, governanceMessage('not captured'))
    startTurn(rig.agent.session, 1)

    appendCompaction(rig.agent.session, { turn: 1 })

    expect(rig.states.peek('cp-root')).toBeUndefined()
    await runPreStep(rig, { turn: 2 })
    expect(Plugin.getPinningHealth().restored).toBe(0)
  })
})

describe('detect — containment', () => {
  it('never throws across the firehose on a malformed compaction payload', () => {
    // A stub context: the containment contract is the listener's own, and a
    // hand-built event has no business entering a real session's projections.
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const ctx = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(name, handler)
        return () => {}
      },
      logger: { debug: () => {}, warn: () => {} },
    } as unknown as Context
    const settings = rigSettings()
    const states = Plugin.createPinningStateRegistry(() => settings)
    Plugin.registerDetect(ctx, () => settings, states)
    states.stateOf('s-1')

    const fire = (data: unknown): void => {
      handlers.get('session/event')!({ header: { id: 's-1' } }, { type: 'compaction/summary', seq: 9, time: 1, data })
    }

    expect(() => fire({ compactionId: 'cp-malformed', shadowedSeqs: 'nope' })).not.toThrow()
    expect(() => fire({ compactionId: 42, shadowedSeqs: [1] })).not.toThrow()
    expect(() => fire(undefined)).not.toThrow()
    expect(states.peek('s-1')!.schedules.size).toBe(0)
  })

  it('the documented defaults ship an enabled feature (no settings file → detect runs)', () => {
    // Four-surface discipline: detect is gated by the same resolved settings
    // object capture uses, whose defaults come from the DEFAULT_* constants.
    expect(rigSettings().enabled).toBe(Plugin.DEFAULT_ENABLED)
    expect(rigSettings().enabled).toBe(true)
  })
})
