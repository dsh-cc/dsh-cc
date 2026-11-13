/**
 * Ledger emission (plan doc §"GovernorRow", §"Dependencies & interactions"):
 * the governor's rows reach `@dsh-cc/input-ledger`'s append sink under
 * `<dshHome>/input-ledger/<projectKey>/<sessionId>.jsonl`, and every soft-
 * dependency path — no ledger, disabled ledger, failing sink — leaves the
 * governor's admission decision untouched.
 *
 * The landing legs drive a real cordis waterfall with the SHIPPED row sink
 * (`sink: 'ledger'` on the live rig) over a temp `DSH_HOME`, then read the
 * JSONL back. The failure leg blocks the ledger directory with a regular file,
 * so the append fails the way a read-only or wrong-owner home would.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createGovernorLedgerSink,
  cwdProjectKeyOf,
  getGovernorLedgerHealth,
  projectKeyForCwd,
  type GovernorRow,
} from '../src/index.ts'
import { messageOf } from './rig.ts'
import { agentOf, cleanupRigs, enforceSettings, liveRig, observeSettings } from './live-rig.ts'

afterEach(() => { cleanupRigs() })

/** An agent face carrying a session id AND the cwd the ledger buckets by. */
function agentWithCwd(sessionId: string, cwd: string): object {
  return { session: { id: sessionId, header: { id: sessionId, cwd } } }
}

/** Every `*.jsonl` under `<home>/input-ledger`, as absolute paths. */
function ledgerFiles(home: string): string[] {
  const root = join(home, 'input-ledger')
  if (!existsSync(root)) return []
  const out: string[] = []
  try {
    for (const bucket of readdirSync(root, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue
      for (const file of readdirSync(join(root, bucket.name), { withFileTypes: true })) {
        if (file.isFile() && file.name.endsWith('.jsonl')) out.push(join(root, bucket.name, file.name))
      }
    }
  } catch {
    // The blocked-sink leg replaces this directory with a regular file.
    return []
  }
  return out
}

/** Parse one JSONL file into rows (blank lines skipped). */
function rowsIn(file: string): GovernorRow[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as GovernorRow)
}

/** Poll a probe until it yields a value; throws a labelled timeout otherwise. */
async function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** The ledger file plus its rows, once at least `count` rows are on disk. */
function waitForRows(home: string, count = 1): Promise<{ file: string, rows: GovernorRow[] }> {
  return waitFor(() => {
    for (const file of ledgerFiles(home)) {
      const rows = rowsIn(file)
      if (rows.length >= count) return { file, rows }
    }
    return undefined
  }, `${count} governor row(s) on disk`)
}

/** A short settle, so "no row was written" assertions are not races. */
function settle(ms = 120): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('row emission — the landing path', () => {
  it('persists the enforce-mode decision row under <dshHome>/input-ledger', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) }, { sink: 'ledger' })
    const agent = agentWithCwd('ledger-enforce', rig.home)
    const decision = await rig.run([messageOf('advisor', 600), messageOf('advisor', 600)], { agent })
    // The governor still gates: one advisory message was deferred.
    expect(decision.kind === 'enter' ? decision.messages : []).toHaveLength(1)
    // Rows are captured nowhere in memory in this mode — only in the JSONL.
    expect(rig.rows).toEqual([])

    const { file, rows } = await waitForRows(rig.home)
    // Path is the ledger convention: <home>/input-ledger/<cwdProjectKey>/<sessionId>.jsonl
    const key = createHash('sha256').update(realpathSync(rig.home), 'utf8').digest('hex').slice(0, 16)
    expect(file).toBe(join(rig.home, 'input-ledger', key, 'ledger-enforce.jsonl'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      v: 1,
      type: 'governor',
      sessionId: 'ledger-enforce',
      gen: 'rig-gen',
      turn: 1,
      step: 1,
      mode: 'enforce',
      offeredBacklog: 0,
      hardOver: false,
      trimmed: [{ kind: 'advisor', bytes: 600, action: 'defer' }],
    })
    expect(rows[0]?.bytesByClass).toEqual({
      governance: 0,
      task: 0,
      memory: 0,
      advisory: 600,
      passthrough: 0,
    })
    expect(rows[0]).not.toHaveProperty('error')
  })

  it('persists the observe-mode decision row while the batch flows untouched', async () => {
    const rig = liveRig({ settings: observeSettings({ 'advisory-budget-bytes': 800 }) }, { sink: 'ledger' })
    const batch = [messageOf('advisor', 600), messageOf('advisor', 600)]
    const decision = await rig.run(batch, { agent: agentWithCwd('ledger-observe', rig.home) })
    expect(decision.kind === 'enter' ? decision.messages : []).toEqual(batch)

    const { rows } = await waitForRows(rig.home)
    expect(rows).toHaveLength(1)
    // Same fields as enforce mode, same measurement: `bytesByClass` counts the
    // DECISION batch (observe and enforce agree byte for byte), so the deferred
    // message is excluded here exactly as it is in enforce mode.
    expect(rows[0]).toMatchObject({
      type: 'governor',
      sessionId: 'ledger-observe',
      mode: 'observe',
      offeredBacklog: 0,
      trimmed: [{ kind: 'advisor', bytes: 600, action: 'defer' }],
    })
    expect(rows[0]?.bytesByClass.advisory).toBe(600)
  })
})

describe('row emission — soft dependency', () => {
  it('never blocks or throws when the append fails, and counts the dropped row', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) }, { sink: 'ledger' })
    // A regular file where the ledger directory belongs: every append fails.
    writeFileSync(join(rig.home, 'input-ledger'), 'not a directory', 'utf8')
    const before = getGovernorLedgerHealth().droppedRows
    const decision = await rig.run(
      [messageOf('advisor', 600), messageOf('advisor', 600)],
      { agent: agentWithCwd('ledger-blocked', rig.home) },
    )
    // The trim still applied: a failing sink must never change admission.
    expect(decision.kind === 'enter' ? decision.messages : []).toHaveLength(1)
    await waitFor(
      () => (getGovernorLedgerHealth().droppedRows > before ? true : undefined),
      'the dropped-row counter to tick',
    )
    expect(getGovernorLedgerHealth().droppedRows).toBe(before + 1)
    expect(ledgerFiles(rig.home)).toEqual([])
  })

  it('writes no rows when the ledger is disabled, and the governor still gates', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) }, { sink: 'ledger' })
    // The LEDGER's own kill switch, in the same user-layer file it hot-reads.
    writeFileSync(
      join(rig.home, 'settings.json'),
      JSON.stringify({ 'cc-input-ledger': { enabled: false } }),
      'utf8',
    )
    const before = getGovernorLedgerHealth().droppedRows
    const decision = await rig.run(
      [messageOf('advisor', 600), messageOf('advisor', 600)],
      { agent: agentWithCwd('ledger-disabled', rig.home) },
    )
    // Governor unaffected: the same trim, no ledger side effects.
    expect(decision.kind === 'enter' ? decision.messages : []).toHaveLength(1)
    await settle()
    expect(ledgerFiles(rig.home)).toEqual([])
    // A disabled ledger is an intentional skip, never a dropped row.
    expect(getGovernorLedgerHealth().droppedRows).toBe(before)
  })

  it('writes no rows for a session whose header carries no cwd', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) }, { sink: 'ledger' })
    const before = getGovernorLedgerHealth().droppedRows
    // No bucket → no file path, exactly as the ledger's own observers skip it.
    const decision = await rig.run(
      [messageOf('advisor', 600), messageOf('advisor', 600)],
      { agent: agentOf('ledger-no-cwd') },
    )
    expect(decision.kind === 'enter' ? decision.messages : []).toHaveLength(1)
    await settle()
    expect(ledgerFiles(rig.home)).toEqual([])
    expect(getGovernorLedgerHealth().droppedRows).toBe(before)
  })

  it('is a no-op on a host with no dsh-home at all', async () => {
    const before = getGovernorLedgerHealth().droppedRows
    const debug: string[] = []
    const emit = createGovernorLedgerSink({ home: undefined, debug: (message) => { debug.push(message) } })
    const row: GovernorRow = {
      v: 1,
      ts: Date.now(),
      sessionId: 's1',
      gen: 'g1',
      type: 'governor',
      mode: 'observe',
      bytesByClass: {},
      trimmed: [],
      offeredBacklog: 0,
      hardOver: false,
    }
    expect(() => { emit(row, 'someproject') }).not.toThrow()
    await settle(40)
    expect(getGovernorLedgerHealth().droppedRows).toBe(before)
    expect(debug).toEqual([])
  })
})

describe('project bucket (cwdProjectKey convention)', () => {
  it('hashes the canonicalized cwd, first 16 hex chars', () => {
    const key = projectKeyForCwd(process.cwd())
    expect(key).toMatch(/^[0-9a-f]{16}$/)
    // A non-canonical spelling of one physical directory lands in one bucket.
    expect(projectKeyForCwd(`${process.cwd()}/./`)).toBe(key)
  })

  it('reads the cwd off the session header and refuses a cwd-less face', () => {
    expect(cwdProjectKeyOf(agentWithCwd('s1', process.cwd()))).toBe(projectKeyForCwd(process.cwd()))
    expect(cwdProjectKeyOf(agentOf('s1'))).toBeUndefined()
    expect(cwdProjectKeyOf(undefined)).toBeUndefined()
    expect(cwdProjectKeyOf({ session: { header: { cwd: '' } } })).toBeUndefined()
  })

  it('passes the ledger row cap through and appends one row per step', async () => {
    const rig = liveRig({ settings: enforceSettings({ 'advisory-budget-bytes': 800 }) }, { sink: 'ledger' })
    writeFileSync(
      join(rig.home, 'settings.json'),
      JSON.stringify({ 'cc-input-ledger': { 'max-rows-per-file': 100 } }),
      'utf8',
    )
    for (const step of [1, 2]) {
      await rig.run([messageOf('advisor', 300)], { agent: agentWithCwd('ledger-cap', rig.home), step })
    }
    const { rows } = await waitForRows(rig.home, 2)
    // Serialized, not interleaved: the sink's per-file write chain holds.
    expect(rows.map(row => row.step)).toEqual([1, 2])
  })
})
