/**
 * Claim ledger behavioral tests (design §6.3 M0-core subset, §3.3 write
 * discipline, §9.2–9.4): chain hash over canonicalized entries detects any
 * field edit and any linkage break, the M0 transition table is enforced as an
 * explicit enumeration with exit 2 for illegal edges, typed verification
 * records are required per edge, and evidence entries are re-hashed at append
 * time (path exists + sha256 matches). Also covers the v4/v5 guard: an
 * outstanding full-isolation L1 counterexample blocks promotion to `proven`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  M0_STATES, TRANSITIONS, counterexampleGuard, main, openClaim, status, transition, verify,
} from '../skills/math-research/scripts/claim-ledger.mjs'
import { cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

const sha256Text = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

async function makeRun({ allowHumanFidelity = false } = {}) {
  const root = await roots.make('mrh-claims-')
  await writeFile(join(root, 'run-manifest.json'), JSON.stringify({ goal: 'test', createdAt: isoNow(), allowHumanFidelity }))
  return root
}

/** Real evidence file inside the run dir plus its record-shaped hash entry. */
async function evidence(root: string, rel: string, content = 'evidence') {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return { path: rel, sha256: sha256Text(content) }
}

// Typed verification records per §6.3 {kind, verdict, bindingHashes?, evidence?}.
const records = {
  l2: (bindingHashes = { combined: sha256Text('binding') }) => ({ kind: 'l2-pass' as const, verdict: 'pass', bindingHashes }),
  fidelityModelAssessed: { kind: 'fidelity' as const, verdict: 'model-assessed' },
  fidelityAnchored: { kind: 'fidelity' as const, verdict: 'anchored' },
  counterexampleFull: { kind: 'counterexample' as const, verdict: 'confirmed', mechanism: 'computation' as const, isolation: 'full' as const },
  counterexamplePartial: { kind: 'counterexample' as const, verdict: 'confirmed', mechanism: 'computation' as const, isolation: 'partial' as const },
  leanNegation: { kind: 'lean-negation' as const, verdict: 'pass' },
  correction: { kind: 'fidelity-correction' as const, verdict: 'confirmed' },
  dispute: { kind: 'dispute' as const, verdict: 'confirmed', bindingHashes: { reason: sha256Text('dispute') } },
  humanRuling: { kind: 'human-ruling' as const, verdict: 'not-faithful' },
}
// Every record a legal edge might demand; supersets satisfy subset requires.
const allRecords = [records.l2(), records.fidelityModelAssessed, records.fidelityAnchored, records.counterexampleFull, records.leanNegation, records.correction, records.dispute, records.humanRuling]

describe('claim-ledger open + chain hash', () => {
  it('genesis creates an open claim and the chain verifies', async () => {
    const root = await makeRun()
    await openClaim(root, 'c-1')
    expect((await status(root)).claims).toEqual({ 'c-1': 'open' })
    const result = await verify(root)
    expect(result.chainValid).toBe(true)
    expect(result.entries).toBe(1)
    expect(result.head).toMatch(/^[a-f0-9]{64}$/)
  })

  it('duplicate genesis is refused', async () => {
    const root = await makeRun()
    await openClaim(root, 'c-1')
    await expect(openClaim(root, 'c-1')).rejects.toMatchObject({ code: 'config-invalid' })
  })

  it('--verify detects ANY field edit: tampering with one byte of one entry breaks the chain (exit 2)', async () => {
    const root = await makeRun()
    await openClaim(root, 'c-1')
    await transition(root, 'c-1', 'proven-of-formal-statement', [records.l2(), records.fidelityModelAssessed])
    const ledger = join(root, 'claims.jsonl')
    const original = await readFile(ledger, 'utf8')
    for (const tampered of [
      original.replace('"open"', '"falsified"'), // edit the genesis target state
      original.replace('"model-assessed"', '"anchored"'), // edit a record verdict
      original.replace('"seq":1', '"seq":7'), // edit a sequence number
    ]) {
      await writeFile(ledger, tampered)
      await expect(verify(root)).rejects.toMatchObject({ code: 'chain-invalid' })
      const { exitCode, output } = await cli(main, ['verify', '--run', root])
      expect(exitCode).toBe(2)
      expect(output).toMatchObject({ status: 'blocked', reason: { code: 'chain-invalid' } })
      await writeFile(ledger, original)
    }
    expect((await verify(root)).chainValid).toBe(true)
    // Appending onto a tampered chain is refused too.
    await writeFile(ledger, original.replace('"open"', '"falsified"'))
    await expect(openClaim(root, 'c-2')).rejects.toMatchObject({ code: 'chain-invalid' })
  })
})

describe('claim-ledger typed records + evidence hashes', () => {
  it('transitions require typed verification records: open→proven without l2-pass is refused', async () => {
    const root = await makeRun()
    await openClaim(root, 'c-1')
    await expect(transition(root, 'c-1', 'proven', [records.fidelityAnchored])).rejects.toMatchObject({ code: 'missing-record' })
    await expect(transition(root, 'c-1', 'proven', [records.l2(), records.fidelityModelAssessed])).rejects.toMatchObject({ code: 'missing-record' })
  })

  it('evidence hashes are re-checked at append time (path exists + sha256 matches)', async () => {
    const root = await makeRun()
    await openClaim(root, 'c-1')
    const good = await evidence(root, 'evidence/c-1/l2/report.json', '{"status":"passed"}')
    await transition(root, 'c-1', 'proven-of-formal-statement', [{ ...records.l2(), evidence: [good] }, records.fidelityModelAssessed])
    expect((await status(root)).claims['c-1']).toBe('proven-of-formal-statement')
    // Missing path and wrong hash are both refusals.
    const root2 = await makeRun()
    await openClaim(root2, 'c-2')
    await expect(transition(root2, 'c-2', 'proven-of-formal-statement', [{ ...records.l2(), evidence: [{ path: 'evidence/nope.json', sha256: good.sha256 }] }, records.fidelityModelAssessed])).rejects.toMatchObject({ code: 'missing-evidence' })
    await expect(transition(root2, 'c-2', 'proven-of-formal-statement', [{ ...records.l2(), evidence: [await evidence(root2, 'evidence/c-2/l2/report.json', 'tampered content')].map(e => ({ ...e, sha256: good.sha256 })) }, records.fidelityModelAssessed])).rejects.toMatchObject({ code: 'evidence-mismatch' })
  })

  it('unknown record kinds and unknown states are rejected by explicit enumeration', async () => {
    const root = await makeRun()
    await openClaim(root, 'c-1')
    await expect(transition(root, 'c-1', 'experiment-supported', allRecords)).rejects.toMatchObject({ code: 'illegal-transition' })
    await expect(transition(root, 'c-1', 'proven-of-formal-statement', [{ kind: 'vibes', verdict: 'pass' }, records.fidelityModelAssessed])).rejects.toMatchObject({ code: 'config-invalid' })
  })
})

describe('claim-ledger M0 transition table (§6.3 subset)', () => {
  // Drive one fresh claim into each source state, then try every target.
  async function driveTo(root: string, claimId: string, state: string) {
    await openClaim(root, claimId)
    switch (state) {
      case 'open': return
      case 'proven-of-formal-statement':
        await transition(root, claimId, 'proven-of-formal-statement', [records.l2(), records.fidelityModelAssessed]); return
      case 'proven':
        await transition(root, claimId, 'proven-of-formal-statement', [records.l2(), records.fidelityModelAssessed])
        await transition(root, claimId, 'proven', [records.fidelityAnchored]); return
      case 'falsified':
        await transition(root, claimId, 'falsified', [records.counterexampleFull]); return
      case 'superseded':
        await transition(root, claimId, 'proven-of-formal-statement', [records.l2(), records.fidelityModelAssessed])
        await transition(root, claimId, 'superseded', [records.correction]); return
      case 'fidelity-failed':
        await transition(root, claimId, 'fidelity-failed', [records.dispute]); return
      default: throw new Error(`no path to ${state}`)
    }
  }

  it('every M0-state pair outside the table is an illegal transition (exit 2), every listed edge passes', async () => {
    const root = await makeRun()
    for (const from of M0_STATES) {
      for (const to of M0_STATES) {
        // Fresh claim per cell: a legal transition consumes the source state.
        const claimId = `f-${from}-t-${to}`.slice(0, 60)
        await driveTo(root, claimId, from)
        const legal = Object.hasOwn(TRANSITIONS, `${from}→${to}`)
        const outcome = await transition(root, claimId, to, allRecords).then(() => 'ok', (error: { code?: string }) => error.code ?? 'unknown')
        if (legal) {
          expect(outcome, `${from}→${to} should be legal`).toBe('ok')
          expect((await status(root)).claims[claimId]).toBe(to)
        } else {
          expect(outcome, `${from}→${to} should be illegal`).toBe('illegal-transition')
          expect((await status(root)).claims[claimId]).toBe(from)
        }
      }
    }
    // The full chain still verifies after the matrix (36 entries per replay rules).
    expect((await verify(root)).chainValid).toBe(true)
  })
})

describe('claim-ledger falsification and dispute rules', () => {
  it('computational falsification requires the FULL isolation tier; a lean-negation pass also falsifies', async () => {
    const root = await makeRun()
    await openClaim(root, 'c-partial')
    await expect(transition(root, 'c-partial', 'falsified', [records.counterexamplePartial])).rejects.toMatchObject({ code: 'missing-record' })
    await openClaim(root, 'c-lean')
    await transition(root, 'c-lean', 'falsified', [records.leanNegation])
    expect((await status(root)).claims['c-lean']).toBe('falsified')
  })

  it('an outstanding full-isolation counterexample blocks promotion to proven (v4/v5 guard)', async () => {
    const entries = [{ claimId: 'c-1', records: [records.counterexampleFull] }]
    let code: string | null = null
    try { counterexampleGuard(entries as never, 'c-1') } catch (error) { code = (error as { code?: string }).code ?? null }
    expect(code).toBe('counterexample-outstanding')
    expect(() => counterexampleGuard([{ claimId: 'c-1', records: [records.counterexamplePartial] }] as never, 'c-1')).not.toThrow()
    expect(() => counterexampleGuard(entries as never, 'c-other')).not.toThrow()
  })

  it('allowHumanFidelity=true: a dispute escalates; fidelity-failed additionally requires a human ruling', async () => {
    const root = await makeRun({ allowHumanFidelity: true })
    await openClaim(root, 'c-1')
    await expect(transition(root, 'c-1', 'fidelity-failed', [records.dispute])).rejects.toMatchObject({ code: 'missing-record' })
    await transition(root, 'c-1', 'fidelity-failed', [records.dispute, records.humanRuling])
    expect((await status(root)).claims['c-1']).toBe('fidelity-failed')
  })

  it('terminal states are never re-sources', async () => {
    const root = await makeRun()
    await openClaim(root, 'c-1')
    await transition(root, 'c-1', 'fidelity-failed', [records.dispute])
    await expect(transition(root, 'c-1', 'falsified', allRecords)).rejects.toMatchObject({ code: 'illegal-transition' })
    expect((await status(root)).claims['c-1']).toBe('fidelity-failed')
  })
})
