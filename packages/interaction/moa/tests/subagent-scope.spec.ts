/**
 * Subagent-scope tests (harness-0.2.2 D3.2 form): moa routes the MAIN
 * conversation only (design §3.1 — "subagent spawn / fork / workflow
 * children: never overlaid; frontmatter `model:` owns them").
 *
 * A spawned agent's model comes from its declared alias (the spawn path
 * resolves the definition's frontmatter into a routes-resolved
 * `agentOptions` override), so a child's ADMISSION never classifies and
 * never selects, writes no ledger row, never claims a turn slot in the
 * shared capture map, never consumes the root's queued status row, never
 * disturbs the boot baseline, and never reaches the acceptance judge. Root
 * regression pins ride along (origin absent → still routed, captured, and
 * judged).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonl } from '@dsh-cc/sidecar-io'
import { isSubagentAgent } from '../src/agent-scope.ts'
import { createAcceptanceJudge, type JudgeDeps } from '../src/judge.ts'
import { ArmingMachine, DEFAULT_MOA_SETTINGS, EscalationBookkeeping, type MoaCore, type MoaSettings } from '../src/index.ts'
import { textOf } from '../src/router.ts'
import { getCapturedOpening, resetRuntimeCore } from '../src/runtime-state.ts'
import { BOOT_PAIR, makeRig, userOpening, routes as tierRoutes, GAUGE_ROUTE, type FakeAgent } from './rig.ts'

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

/** The rig's fake agent re-headed as a spawned child (foreign session stamp). */
function subagentOf(rig: { agent: FakeAgent }): FakeAgent {
  return { ...rig.agent, session: { ...rig.agent.session, header: { ...subagentHeader } } }
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

describe('moa subagent scope (admission)', () => {
  it('a subagent admission never classifies, never selects, and writes no ledger row', async () => {
    const rig = makeRig({ ledger: join(tempDir(), 'routing.jsonl') })
    await rig.router.routeBeforeAdmission(subagentOf(rig) as never, userOpening('child prompt'))
    expect(rig.classifyStates).toEqual([])
    expect(rig.agent.model.selections).toEqual([])
    expect(await readJsonl<{ tier?: string }>(rig.ledger)).toEqual([])
    // The root's boot baseline is NOT captured from a child's pair.
    expect(rig.core.arming.getBootDefaultModel()).toBeUndefined()
  })

  it('a subagent claim never binds a turn nor consumes the root’s queued status row', async () => {
    const rig = makeRig({ effort: 'max' })
    // Advertise the carried effort so the classify produces exactly one
    // queued row (no effort-degrade notice alongside it).
    rig.setResolveEfforts(async () => ['max'])
    const opening = userOpening('ROOT TURN ONE')
    await rig.admit(opening)
    await rig.claim(1, [opening]) // binds → queues 'moa: routed → draft'
    // A child's pre-step above the row: NOT spliced (independent of the bind).
    const child = await rig.router.preStepListener({ agent: { session: { header: { ...subagentHeader } } } } as never, async () => ({ kind: 'enter', messages: [] }) as never)
    expect((child as { messages?: unknown[] }).messages).toEqual([])
    // The row still lands on the root's own pre-step.
    const root = await rig.deliverRows()
    expect(root).toHaveLength(1)
    expect(root[0]?.source).toMatchObject({ kind: 'moa' })
  })

  it('a subagent claim never writes the shared capture map; the same-numbered root claim still captures', async () => {
    const rig = makeRig()
    const sub = subagentOf(rig)
    rig.router.noteClaimed(sub as never, userOpening('child prompt'), 1)
    expect(getCapturedOpening(1)).toBeUndefined()
    await rig.claim(1, [userOpening('root prompt')])
    expect(textOf(getCapturedOpening(1) as never)).toBe('root prompt')
  })

  it('root regression: an agent whose session header carries no origin still routes at admission', async () => {
    const rig = makeRig()
    await rig.admit(userOpening('root as usual'))
    expect(rig.classifyStates).toEqual(['root as usual'])
    expect(rig.agent.model.current()).toMatchObject({ model: 'tier-draft' })
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
): { session: FakeSession & Record<string, unknown> } & Record<string, unknown> {
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
    model: {
      current: () => undefined,
      select: () => {},
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
    const core: MoaCore = { arming, bookkeeping: new EscalationBookkeeping(), warnedReasons: new Set<string>() }
    resetRuntimeCore()
    const session: FakeSession = { events: [], id: 'session-1', seq: 0 }
    const acceptStates: string[] = []
    const deps: JudgeDeps = {
      readSettings: () => settings,
      getCapturedOpening: (turnId) => getCapturedOpening(turnId),
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
    const { captureClaimed } = await import('../src/runtime-state.ts')
    captureClaimed(undefined, userOpening('child prompt'), 1)
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
    captureClaimed(undefined, userOpening('root prompt'), 2)
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

describe('moa subagent scope (boot baseline)', () => {
  it('a foreign child pair never disarms the machine; only explicit root signals do', async () => {
    const rig = makeRig()
    await rig.admit(userOpening('root turn one'))
    expect(rig.core.arming.isArmed()).toBe(true)
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
    // A child with a FOREIGN live pair: admission skips it entirely.
    const sub = subagentOf(rig)
    sub.options = { provider: 'foreign', model: 'child-model' }
    await rig.router.routeBeforeAdmission(sub as never, userOpening('child turn'))
    expect(rig.core.arming.isArmed()).toBe(true)
    expect(rig.core.arming.getBootDefaultModel()).toEqual(BOOT_PAIR)
  })
})
