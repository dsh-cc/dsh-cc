/**
 * Restart-recovery pins (design docs/plans/2026-10-12-verifiable-workspace-agent.md
 * §4.5, DoD case 6): pending = session-wide EDITING_TOOLS hits with no
 * receipt row whose artifactHash matches the current file; consumed nudge
 * budget recovered from the ledger projection (`nudge.round > 0` rows).
 * Replay sources are the session's events and the ledger file on disk —
 * exercised here over a REAL tmpdir ledger written through sidecar-io
 * (write-then-read-back included).
 *
 * @module
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEvaluatorState, evaluateTurnStopping, type EvalEvent } from '../src/evaluator.ts'
import { receiptLedgerPath } from '../src/receipt.ts'
import { DEFAULT_VWA_EVIDENCE_SETTINGS } from '../src/settings.ts'
import { readJsonl } from '@dsh-cc/sidecar-io'
import type { Executor } from '../src/gates.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

const passExec: Executor = async () => ({ code: 0, stdout: '', stderr: '' })

function userEvent(text = 'update the doc'): EvalEvent {
  return { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }
}
function editEvent(turn: number, path: string): EvalEvent {
  return { type: 'tool/call', data: { turn, name: 'edit', arguments: JSON.stringify({ file_path: path }) } }
}
function assistantEvent(turn: number): EvalEvent {
  return { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text: 'done' }] } } }
}

const OK_DOC = 'ships 42 files 〔src:ws:docs/b.md#L1-L2〕 per run.'

describe('restart recovery over a real ledger (§4.5)', () => {
  it('a stale post-restart edit re-enters evaluation via the pending replay; the old row reads stale by hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-recovery-'))
    roots.push(root)
    const home = join(root, 'home')
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'b.md'), '# Beta\nsource line\n', 'utf8')
    await writeFile(join(root, 'docs', 'a.md'), OK_DOC, 'utf8')

    // Turn 1 evaluates and writes the receipt.
    const events1: EvalEvent[] = [userEvent(), editEvent(1, 'docs/a.md'), assistantEvent(1)]
    const agent1 = { session: { header: { id: 's-recover' }, snapshotEvents: () => events1 } }
    await evaluateTurnStopping({
      agent: agent1 as never, turn: 1, settings: DEFAULT_VWA_EVIDENCE_SETTINGS, workspaceRoot: root,
      exec: passExec, dshHome: home, state: createEvaluatorState(), debug: () => {},
    })
    const rows1 = await readJsonl(receiptLedgerPath(home, 's-recover'))
    expect(rows1).toHaveLength(1)

    // RESTART: the artifact is edited again after the last receipt (DoD case 1
    // stale-receipt driver) — the new turn's window contains no edit events
    // for it (fresh process, fabricated pending state), yet the pending
    // replay recovers it from the session events + the on-disk ledger.
    const newDoc = 'ships 43 files 〔src:ws:docs/b.md#L1-L2〕 per run.'
    await writeFile(join(root, 'docs', 'a.md'), newDoc, 'utf8')
    const events2: EvalEvent[] = [...events1, userEvent('and again'), assistantEvent(2)]
    const agent2 = { session: { header: { id: 's-recover' }, snapshotEvents: () => events2 } }
    const outcome = await evaluateTurnStopping({
      agent: agent2 as never, turn: 2, settings: DEFAULT_VWA_EVIDENCE_SETTINGS, workspaceRoot: root,
      exec: passExec, dshHome: home, state: createEvaluatorState(), debug: () => {},
    })
    expect(outcome).toEqual({ action: 'receipts', receipts: 1 })
    const rows2 = await readJsonl(receiptLedgerPath(home, 's-recover'))
    expect(rows2).toHaveLength(2)
    // The NEW row matches the current file; the OLD row is stale by hash.
    expect(rows2[1]!.artifactHash).not.toBe(rows1[0]!.artifactHash)
    expect(rows2[1]!.claims[0]!.status).toBe('marked-ok')
  })

  it('consumed nudge budget survives the restart: projection rows with nudge.round > 0 stay spent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vwa-budget-'))
    roots.push(root)
    const home = join(root, 'home')
    await mkdir(join(root, 'docs'), { recursive: true })
    await writeFile(join(root, 'docs', 'b.md'), '# Beta\nsource line\n', 'utf8')
    await writeFile(join(root, 'docs', 'a.md'), 'runs 99 files 〔src:ws:../x.md#L1-L2〕 now.', 'utf8')

    const events: EvalEvent[] = [userEvent(), editEvent(1, 'docs/a.md'), assistantEvent(1), assistantEvent(2)]
    const agent = { session: { header: { id: 's-budget' }, snapshotEvents: () => events } }
    // Pre-restart: the failing artifact nudges (round 1 row lands).
    await evaluateTurnStopping({
      agent: agent as never, turn: 1, settings: { ...DEFAULT_VWA_EVIDENCE_SETTINGS, 'nudge-budget': 1 },
      workspaceRoot: root, exec: passExec, dshHome: home, state: createEvaluatorState(), debug: () => {},
    })
    // Post-restart (fresh in-memory state, budget 1): the ledger projection
    // already shows one consumed nudge — no re-fire, receipt only.
    const outcome = await evaluateTurnStopping({
      agent: agent as never, turn: 2, settings: { ...DEFAULT_VWA_EVIDENCE_SETTINGS, 'nudge-budget': 1 },
      workspaceRoot: root, exec: passExec, dshHome: home, state: createEvaluatorState(), debug: () => {},
    })
    expect(outcome).toEqual({ action: 'receipts', receipts: 1 })
  })
})
