/**
 * Turn-stopping evaluator pins (design
 * docs/plans/2026-10-12-verifiable-workspace-agent.md §4.5): window
 * anchoring + turn guard (abort ⇒ no receipt, no older-turn substitution),
 * artifact-set derivation (window edits, whitelist filter, pending
 * recovery), receipt write with real sidecar-io, nudge trigger + budgets
 * (per artifact per turn ≤ 1, per turn ≤ 2, per session nudge-budget with
 * the process latch mirror), and the evaluate-time settings hot read
 * (§4.4).
 *
 * @module
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEvaluatorState,
  evaluateTurnStopping,
  type EvalEvent,
  type EvaluatorState,
} from '../src/evaluator.ts'
import { receiptLedgerPath } from '../src/receipt.ts'
import { readUserSettingsSync, DEFAULT_VWA_EVIDENCE_SETTINGS, type VwaEvidenceSettings } from '../src/settings.ts'
import type { Executor } from '../src/gates.ts'
import { readJsonl } from '@dsh-cc/sidecar-io'

const roots: string[] = []
const homes: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  for (const home of homes.splice(0)) rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const passExec: Executor = async () => ({ code: 0, stdout: '', stderr: '' })

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'vwa-eval-'))
  roots.push(root)
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs', 'b.md'), '# Beta\nsource line\n', 'utf8')
  return root
}

async function dshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'vwa-home-'))
  homes.push(home)
  return home
}

function userEvent(text = 'please update the docs'): EvalEvent {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}

function editEvent(turn: number, path: string): EvalEvent {
  return { type: 'tool/call', data: { turn, name: 'edit', arguments: JSON.stringify({ file_path: path }) } }
}

function assistantEvent(turn: number, interrupted?: true): EvalEvent {
  return { type: 'assistant/message', data: { turn, ...(interrupted === undefined ? {} : { interrupted }), message: { content: [{ type: 'text', text: 'done' }] } } }
}

function fakeAgent(id: string, events: EvalEvent[]): { agent: any; injected: any[] } {
  const injected: any[] = []
  return {
    agent: {
      session: { header: { id }, snapshotEvents: () => events },
      inject: (message: unknown) => injected.push(message),
    },
    injected,
  }
}

interface EvalEnv {
  root: string
  home: string
  settings: VwaEvidenceSettings
  state: EvaluatorState
  debug: string[]
}

async function env(overrides?: Partial<VwaEvidenceSettings>): Promise<EvalEnv> {
  return {
    root: await workspace(),
    home: await dshHome(),
    settings: { ...DEFAULT_VWA_EVIDENCE_SETTINGS, ...overrides },
    state: createEvaluatorState(),
    debug: [],
  }
}

function run(e: EvalEnv, agent: unknown, turn: number, events?: EvalEvent[]) {
  void events
  return evaluateTurnStopping({
    agent: agent as never,
    turn,
    settings: e.settings,
    workspaceRoot: e.root,
    exec: passExec,
    dshHome: e.home,
    state: e.state,
    debug: (m) => e.debug.push(m),
  })
}

const OK_DOC = 'ships 42 files 〔src:ws:docs/b.md#L1-L2〕 per run.'

describe('turn guard + window anchoring (§4.5)', () => {
  it('an aborted turn (no assistant/message for the turn) writes no receipt', async () => {
    const e = await env()
    const { agent } = fakeAgent('s1', [userEvent(), editEvent(1, 'docs/a.md')])
    await writeFile(join(e.root, 'docs', 'a.md'), OK_DOC, 'utf8')
    expect(await run(e, agent, 1)).toEqual({ action: 'skip', reason: 'turn-guard' })
    await expect(readFile(receiptLedgerPath(e.home, 's1'), 'utf8')).rejects.toThrow()
  })

  it('an interrupted tail message counts as an abort — no receipt', async () => {
    const e = await env()
    const { agent } = fakeAgent('s1', [userEvent(), editEvent(1, 'docs/a.md'), assistantEvent(1, true)])
    await writeFile(join(e.root, 'docs', 'a.md'), OK_DOC, 'utf8')
    expect(await run(e, agent, 1)).toEqual({ action: 'skip', reason: 'turn-guard' })
  })

  it('the window anchor is the LAST genuine user message — an older turn tail edit is excluded', async () => {
    const e = await env()
    // The edit BEFORE the genuine user message belongs to the previous turn;
    // anchoring by turn boundary would wrongly re-evaluate it every turn.
    const { agent } = fakeAgent('s1', [
      editEvent(0, 'docs/a.md'),
      userEvent(),
      editEvent(1, 'docs/other.md'),
      assistantEvent(1),
    ])
    await writeFile(join(e.root, 'docs', 'a.md'), OK_DOC, 'utf8')
    await writeFile(join(e.root, 'docs', 'other.md'), 'no claims', 'utf8')
    const outcome = await run(e, agent, 1)
    // docs/a.md still evaluates via the pending replay (stale against the
    // empty ledger) — but ONLY once; the receipt then matches. The abstained
    // one (docs/other.md, zero detected claims) lands a receipt WITHOUT a
    // nudge: a no-claim document has no valid self-repair target.
    expect(outcome).toEqual({ action: 'receipts', receipts: 2 })
    const rows = await readJsonl(receiptLedgerPath(e.home, 's1'))
    expect(rows.map(r => r.artifactId).sort()).toEqual(['docs/a.md', 'docs/other.md'])
    expect(rows.every(r => r.nudge.round === 0)).toBe(true)
  })

  it('a fresh receipt (matching hash) is not re-evaluated via pending replay when out of the window', async () => {
    const e = await env()
    const events: EvalEvent[] = [userEvent(), editEvent(1, 'docs/a.md'), assistantEvent(1)]
    const { agent } = fakeAgent('s1', events)
    await writeFile(join(e.root, 'src', 'x.ts'), 'export {}', 'utf8').catch(async () => {
      await mkdir(join(e.root, 'src'), { recursive: true })
      await writeFile(join(e.root, 'src', 'x.ts'), 'export {}', 'utf8')
    })
    await writeFile(join(e.root, 'docs', 'a.md'), OK_DOC, 'utf8')
    await run(e, agent, 1)
    // Turn 2 edits only a non-whitelisted file: the window has no artifacts
    // and docs/a.md's receipt already matches — nothing pending, no receipts.
    events.push(userEvent('again'), editEvent(2, 'src/x.ts'), assistantEvent(2))
    const fresh = createEvaluatorState()
    expect(await evaluateTurnStopping({
      agent: agent as never, turn: 2, settings: e.settings, workspaceRoot: e.root, exec: passExec,
      dshHome: e.home, state: fresh, debug: () => {},
    })).toEqual({ action: 'skip', reason: 'no-artifacts' })
  })
})

describe('artifact set derivation (§4.3)', () => {
  it('only whitelist members inside the workspace are evaluated', async () => {
    const e = await env()
    const { agent } = fakeAgent('s1', [
      userEvent(),
      editEvent(1, 'src/code.ts'),
      editEvent(1, 'docs/a.md'),
      assistantEvent(1),
    ])
    await writeFile(join(e.root, 'src', 'code.ts'), 'export {}', 'utf8').catch(async () => {
      await mkdir(join(e.root, 'src'), { recursive: true })
      await writeFile(join(e.root, 'src', 'code.ts'), 'export {}', 'utf8')
    })
    await writeFile(join(e.root, 'docs', 'a.md'), OK_DOC, 'utf8')
    const outcome = await run(e, agent, 1)
    expect(outcome).toMatchObject({ action: 'receipts', receipts: 1 })
    const rows = await readJsonl(receiptLedgerPath(e.home, 's1'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.artifactId).toBe('docs/a.md')
    expect(rows[0]!.gates.map(g => g.gate).sort()).toEqual(['exec', 'link', 'style'])
  })
})

describe('nudge trigger + budgets (§4.5)', () => {
  async function failingSetup(): Promise<EvalEnv> {
    const e = await env()
    await writeFile(join(e.root, 'docs', 'a.md'), 'runs 99 files 〔src:ws:../x.md#L1-L2〕 now.', 'utf8')
    return e
  }

  it('out-of-bounds claim ⇒ fail receipt + sync nudge with the vwa-evidence source', async () => {
    const e = await failingSetup()
    const { agent, injected } = fakeAgent('s1', [userEvent(), editEvent(1, 'docs/a.md'), assistantEvent(1)])
    const outcome = await run(e, agent, 1)
    expect(outcome).toEqual({ action: 'nudge', receipts: 1, nudged: ['docs/a.md'] })
    expect(injected).toHaveLength(1)
    expect(injected[0].source.kind).toBe('vwa-evidence')
    expect(injected[0].content[0].text).toContain('Self-repair once')
    const rows = await readJsonl(receiptLedgerPath(e.home, 's1'))
    expect(rows[0]!.nudge.round).toBe(1)
    expect(rows[0]!.overall).toBe('fail')
  })

  it('per-artifact-per-turn budget: the self-repair re-run nudges at most once (receipt still lands)', async () => {
    const e = await failingSetup()
    const events: EvalEvent[] = [userEvent(), editEvent(1, 'docs/a.md'), assistantEvent(1)]
    const { agent, injected } = fakeAgent('s1', events)
    // First evaluation fires; the continuation keeps the same turn number.
    expect(await run(e, agent, 1)).toMatchObject({ action: 'nudge' })
    // The self-repair re-evaluation (same turn): receipt yes, nudge no.
    const second = await run(e, agent, 1)
    expect(second).toEqual({ action: 'receipts', receipts: 1 })
    expect(injected).toHaveLength(1)
    const rows = await readJsonl(receiptLedgerPath(e.home, 's1'))
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.nudge.round)).toEqual([1, 0])
  })

  it('per-turn budget ≤ 2 across three failing artifacts', async () => {
    const e = await env()
    for (const name of ['a.md', 'b.md', 'c.md']) {
      await writeFile(join(e.root, 'docs', name), 'runs 99 files 〔src:ws:../x.md#L1-L2〕 now.', 'utf8')
    }
    const { agent, injected } = fakeAgent('s1', [
      userEvent(),
      editEvent(1, 'docs/a.md'), editEvent(1, 'docs/b.md'), editEvent(1, 'docs/c.md'),
      assistantEvent(1),
    ])
    const outcome = await run(e, agent, 1)
    expect(outcome).toMatchObject({ action: 'nudge' })
    expect(injected).toHaveLength(2)
    expect((outcome as { nudged: string[] }).nudged).toHaveLength(2)
  })

  it('session nudge-budget is hot-read and counted from the ledger projection (restart-safe)', async () => {
    const e = await env({ 'nudge-budget': 1 })
    await writeFile(join(e.root, 'docs', 'a.md'), 'runs 99 files 〔src:ws:../x.md#L1-L2〕 now.', 'utf8')
    const events: EvalEvent[] = [userEvent(), editEvent(1, 'docs/a.md'), assistantEvent(1)]
    const { agent } = fakeAgent('s1', events)
    expect(await run(e, agent, 1)).toMatchObject({ action: 'nudge' })
    // A RESTART (fresh state, same ledger): the projection counts the round-1
    // row, so the budget stays consumed and no nudge re-fires.
    events.push(assistantEvent(2))
    const fresh: EvaluatorState = createEvaluatorState()
    const outcome = await evaluateTurnStopping({
      agent: agent as never, turn: 2, settings: e.settings, workspaceRoot: e.root, exec: passExec,
      dshHome: e.home, state: fresh, debug: () => {},
    })
    expect(outcome).toEqual({ action: 'receipts', receipts: 1 })
  })
})

describe('evaluate-time settings hot read (§4.4)', () => {
  it('readUserSettingsSync defaults ON and re-reads the raw user file per call', async () => {
    const home = await dshHome()
    // Absent file ⇒ ship defaults (enabled true, §4.4).
    expect(readUserSettingsSync(home)).toEqual(DEFAULT_VWA_EVIDENCE_SETTINGS)
    await writeFile(join(home, 'settings.json'), JSON.stringify({ 'vwa-evidence': { enabled: false, 'nudge-budget': 2 } }), 'utf8')
    expect(readUserSettingsSync(home)).toEqual({ enabled: false, 'nudge-budget': 2, 'gate-timeout-ms': 30_000, 'coverage-threshold': 0.9 })
    // Hot update: no restart, next read sees the new values (§4.4).
    await writeFile(join(home, 'settings.json'), JSON.stringify({ 'vwa-evidence': { enabled: true } }), 'utf8')
    expect(readUserSettingsSync(home).enabled).toBe(true)
  })

  it('enabled=false short-circuits the evaluator before any IO', async () => {
    const e = await env({ enabled: false })
    await writeFile(join(e.root, 'docs', 'a.md'), 'runs 99 files 〔src:ws:../x.md#L1-L2〕 now.', 'utf8')
    const { agent } = fakeAgent('s1', [userEvent(), editEvent(1, 'docs/a.md'), assistantEvent(1)])
    expect(await run(e, agent, 1)).toEqual({ action: 'skip', reason: 'disabled' })
    await expect(readFile(receiptLedgerPath(e.home, 's1'), 'utf8')).rejects.toThrow()
  })
})
