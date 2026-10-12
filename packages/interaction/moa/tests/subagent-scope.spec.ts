/**
 * Subagent-scope tests: moa routes the MAIN conversation only (design §3.1 —
 * "subagent spawn / fork / workflow children: never overlaid; frontmatter
 * `model:` owns them").
 *
 * A spawned agent's model comes from its declared alias (the spawn path
 * resolves the definition's frontmatter into a routes-resolved
 * `agentOptions` override), so a child's requests must pass through
 * unclassified and unoverridden, write no ledger row, never reach the
 * acceptance judge, never claim a turn slot in the shared capture map,
 * never consume the root's queued status row, and never disarm the arming
 * machine with a foreign header pair. Root regression pins ride along
 * (origin absent → still routed, captured, and judged).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonl } from '@dsh-cc/sidecar-io'
import { isSubagentAgent } from '../src/agent-scope.ts'
import { createOpeningCapture } from '../src/capture.ts'
import { createAcceptanceJudge, type JudgeDeps } from '../src/judge.ts'
import { ArmingMachine, DEFAULT_MOA_SETTINGS, EscalationBookkeeping, type MoaCore, type MoaSettings } from '../src/index.ts'
import { textOf, type RequestPayload } from '../src/router.ts'
import { makeRig, userOpening, routes as tierRoutes, GAUGE_ROUTE, type Rig } from './rig.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0, dirs.length)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'moa-scope-'))
  dirs.push(dir)
  return dir
}

/** A subagent session header, as the harness stamps it for spawned children. */
const subagentHeader = { origin: 'subagent' as const }

/**
 * A subagent request payload: same structural shape as the rig's fake agent,
 * plus the session-header origin stamp the guard reads. The request header
 * deliberately reports a FOREIGN pair — an unguarded child request would
 * feed it to the arming machine and disarm it.
 */
function subagentPayload(turn: number, step = 1): RequestPayload {
  return {
    agent: {
      session: {
        header: { ...subagentHeader },
        requestHeader: () => ({ config: { provider: 'foreign', model: 'child-model' } }),
      },
      inject: () => {},
    } as never,
    turn,
    step,
    signal: new AbortController().signal,
  } as RequestPayload
}

/** Fire the router listener for a subagent; return the resolved config. */
async function fireSubagent(
  rig: Rig,
  turn: number,
  step = 1,
): Promise<{ provider?: string; model?: string; reasoningEffort?: unknown }> {
  return (await rig.router.listener(subagentPayload(turn, step), rig.next)) as {
    provider?: string
    model?: string
    reasoningEffort?: unknown
  }
}

describe('moa subagent scope (predicate)', () => {
  it('classifies by origin stamp or delegation depth, never by fork lineage alone', () => {
    const withHeader = (header: Record<string, unknown>): unknown => ({ session: { header } })
    expect(isSubagentAgent(withHeader({ origin: 'subagent' }))).toBe(true)
    expect(isSubagentAgent(withHeader({ delegationDepth: 2 }))).toBe(true)
    expect(isSubagentAgent(withHeader({ origin: 'subagent', delegationDepth: 1 }))).toBe(true)
    expect(isSubagentAgent(withHeader({}))).toBe(false)
    expect(isSubagentAgent(withHeader({ delegationDepth: 0 }))).toBe(false)
    // A plain root-session fork: parentSession alone, no origin/depth stamp.
    expect(isSubagentAgent(withHeader({ parentSession: 'tui-1' }))).toBe(false)
    expect(isSubagentAgent(undefined)).toBe(false)
    expect(isSubagentAgent({})).toBe(false)
    expect(isSubagentAgent({ session: {} })).toBe(false)
  })
})

describe('moa subagent scope (router)', () => {
  it('a subagent request passes through unclassified and unoverridden, and writes no ledger row', async () => {
    const rig = makeRig({ ledger: join(tempDir(), 'routing.jsonl') })
    await rig.seedCapture(1, [userOpening('child prompt')])
    const resolved = await fireSubagent(rig, 1)
    expect(resolved.model).toBe('mock') // next() passthrough, no tier override
    expect(resolved.reasoningEffort).toBe('max')
    expect(rig.classifyStates).toEqual([])
    expect(rig.injected).toEqual([]) // no status row queued
    expect(await readJsonl<{ tier?: string }>(rig.ledger)).toEqual([])
  })

  it('a subagent request must not consume the root turn: the same-numbered root turn still classifies', async () => {
    const rig = makeRig()
    // The child runs its turn 1 while the root is ON turn 1 — child turn
    // numbers restart at 1. Without the guard the child request would set
    // lastSeenTurn=1 and the root's own first request would silently skip
    // classification as a "same turn" continuation.
    await rig.seedCapture(1, [userOpening('ROOT TURN ONE')])
    await fireSubagent(rig, 1)
    const root = (await rig.router.listener(rig.payload(1, 1), rig.next)) as { model?: string }
    expect(rig.classifyStates).toEqual(['ROOT TURN ONE'])
    expect(root.model).toBe('tier-draft')
  })

  it('a subagent request must not disarm the arming machine with its foreign header pair', async () => {
    const rig = makeRig()
    // Boot pair observed first, so the machine's boot default is BOOT_PAIR.
    await rig.seedCapture(1, [userOpening('root turn one')])
    await rig.router.listener(rig.payload(1, 1), rig.next)
    // The child reports a FOREIGN pair (an explicit child model override) —
    // observing it would disarm the machine for the root's later turns.
    await fireSubagent(rig, 2)
    expect(rig.core.arming.isArmed()).toBe(true)
    // Control: the SAME foreign pair observed on a root request disarms.
    rig.setHeaderPair({ provider: 'foreign', model: 'child-model' })
    await rig.seedCapture(3, [userOpening('root turn three')])
    const root = (await rig.router.listener(rig.payload(3, 1), rig.next)) as { model?: string }
    expect(rig.core.arming.isArmed()).toBe(false)
    expect(root.model).toBe('child-model') // zero override while disarmed (pass-through = the resolved pair)
  })

  it('root regression: an agent whose session header carries no origin still routes', async () => {
    const rig = makeRig()
    await rig.seedCapture(3, [userOpening('root as usual')])
    const root = (await rig.router.listener(rig.payload(3, 1), rig.next)) as { model?: string }
    expect(rig.classifyStates).toEqual(['root as usual'])
    expect(root.model).toBe('tier-draft')
  })
})

describe('moa subagent scope (capture)', () => {
  it('a subagent pre-step never claims a turn slot; the same-numbered root pre-step still captures', async () => {
    const rig = makeRig()
    await rig.capture.listener(
      { messages: [userOpening('child prompt')], turn: 1, agent: { session: { header: { ...subagentHeader } } } } as never,
      async () => ({}),
    )
    expect(rig.capture.getCapturedOpening(1)).toBeUndefined()
    await rig.seedCapture(1, [userOpening('root prompt')])
    expect(textOf(rig.capture.getCapturedOpening(1) as never)).toBe('root prompt')
  })

  it('a subagent pre-step never consumes the root’s queued status row', async () => {
    const rig = makeRig()
    // Advertise the carried effort so the classify produces exactly one
    // queued row (no effort-degrade notice alongside it).
    rig.setResolveEfforts(async () => ['max'])
    await rig.seedCapture(1, [userOpening('ROOT TURN ONE')])
    await rig.router.listener(rig.payload(1, 1), rig.next) // classifies → queues 'moa: routed → draft'
    const nextDecision = async (): Promise<{ kind: string; messages: unknown[] }> => ({ kind: 'enter', messages: [] })
    const child = (await rig.router.preStepListener({ agent: { session: { header: { ...subagentHeader } } } } as never, nextDecision)) as {
      messages?: unknown[]
    }
    expect(child.messages).toEqual([]) // the root's row was NOT spliced into the child
    const root = (await rig.router.preStepListener({} as never, nextDecision)) as { messages?: { source?: { kind?: string } }[] }
    expect(root.messages).toHaveLength(1) // the row still lands on the root's own pre-step
    expect(root.messages?.[0]?.source).toMatchObject({ kind: 'moa' })
  })
})

/** A session-log view shared by the judge fixtures. */
interface FakeSession {
  events: { seq: number; type: string; data: Record<string, unknown> }[]
  id: string
  seq: number
}

/** Build the judge's fake agent; `origin` stamps the subagent classification. */
function judgeAgent(
  session: FakeSession,
  origin?: 'subagent',
): { session: FakeSession & Record<string, unknown>; followup: () => void } {
  return {
    session: {
      ...session,
      get seq() {
        return session.seq
      },
      get id() {
        return session.id
      },
      snapshotEvents: () => session.events,
      ...(origin === undefined ? {} : { header: { origin } }),
    },
    followup: () => {},
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('moa subagent scope (judge)', () => {
  it('a subagent turn is never judged, even with a fully judgeable turn', async () => {
    const settings: MoaSettings = {
      ...DEFAULT_MOA_SETTINGS,
      enabled: true,
      acceptance: { enabled: true, shadow: false, tau: 0.7 },
      maxEscalations: 1,
    }
    const arming = new ArmingMachine(() => settings.enabled)
    arming.arm()
    const core: MoaCore = { readSettings: () => settings, arming, bookkeeping: new EscalationBookkeeping() }
    const capture = createOpeningCapture()
    const session: FakeSession = { events: [], id: 'session-1', seq: 0 }
    const acceptStates: string[] = []
    const deps: JudgeDeps = {
      getCapturedOpening: (turnId) => capture.getCapturedOpening(turnId),
      tierFor: () => 1,
      routes: () => tierRoutes() as never,
      resolveBackend: () => ({ baseURL: 'http://127.0.0.1:9' }),
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, unknown> }
        if ('accept' in body.questions) acceptStates.push(body.state)
        return new Response(
          JSON.stringify({
            model: GAUGE_ROUTE.model,
            answers: { accept: { type: 'choice', choice: 'acceptable', probabilities: { acceptable: 0.95, unacceptable: 0.05 } } },
            usage: { input_tokens: 100, output_tokens: 5 },
          }),
          { status: 200 },
        )
      }) as typeof fetch,
      routingLedgerPath: () => join(tempDir(), 'routing.jsonl'),
      acceptanceLedgerPath: () => join(tempDir(), 'acceptance.jsonl'),
    }
    const judge = createAcceptanceJudge(core, { validation: { ok: true }, deps })

    // A completed, effect-free, eligible turn — without the guard this judge
    // WOULD run on it.
    await capture.listener({ messages: [userOpening('child prompt')], turn: 1 } as never, async () => ({}))
    session.events.push(
      { seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' } } },
      { seq: 1, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'child answer' }] } } },
    )
    session.seq = session.events.length

    const child = judgeAgent(session, 'subagent')
    judge.listener({ agent: child as never, turn: 1, signal: new AbortController().signal } as never)
    await flush()
    expect(acceptStates).toEqual([])
    expect(judge.isInFlight(child as never)).toBe(false)

    // Control: the identical turn under a root agent IS judged.
    const rootSession: FakeSession = { events: session.events.slice(), id: 'session-2', seq: session.seq }
    const root = judgeAgent(rootSession)
    await capture.listener({ messages: [userOpening('root prompt')], turn: 2 } as never, async () => ({}))
    rootSession.events.push(
      { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'root prompt' }], source: { kind: 'user' } } },
      { seq: 3, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'root answer' }] } } },
    )
    rootSession.seq = rootSession.events.length
    judge.listener({ agent: root as never, turn: 2, signal: new AbortController().signal } as never)
    await flush()
    expect(acceptStates).toHaveLength(1)
  })
})
