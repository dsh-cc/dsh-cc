/**
 * Experience-store behavioral tests (design §7.2 verifier gating, risk 7
 * experience pollution, §3.3 lock discipline, §8.3 ablation write-blocking):
 *
 *  - a success record is admitted ONLY with a `formal_proof_valid` typed
 *    verification record whose verdict is pass; anything else exits 2;
 *  - the store is append-only and chain-hashed: editing any field of any
 *    entry breaks `--verify`;
 *  - `.lock` is single-writer, stale after 60s, fail-closed on conflict;
 *  - an ablation run's write-block refuses test-split writes, from the lock
 *    content, from `--write-blocked`, and from the manifest env;
 *  - FTS5 retrieval returns the stored records (real node:sqlite FTS5, no
 *    network, no models).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOCK_STALE_MS, acquireLock, addFailure, addSuccess, block, main, query, readLock, status, storePaths, unblock, verify,
} from '../skills/math-research/scripts/experience.mjs'
import { HEX, cli, isoNow, workspaces } from './helpers.ts'

const roots = workspaces()
afterEach(() => roots.cleanup())

const store = () => roots.make('mrh-experience-')

const successRecord = (over: Record<string, unknown> = {}) => ({
  goalShape: 'forall n : Nat, n + 0 = n',
  premises: ['Nat.add_zero'],
  tacticSkeleton: 'intro n; rfl',
  sourceProblem: 'p-001',
  verifiedAt: isoNow(),
  bindingHashes: { combined: HEX('a') },
  verification: { kind: 'formal-proof-valid', verdict: 'pass', bindingHashes: { combined: HEX('a') } },
  ...over,
})

const failureRecord = (over: Record<string, unknown> = {}) => ({
  goalShape: 'forall n : Nat, n * 0 = n',
  failedApproach: 'induction without a case split on the successor',
  errorClass: 'type-mismatch',
  ...over,
})

async function writeRecord(root: string, name: string, record: unknown) {
  const path = join(root, name)
  await writeFile(path, JSON.stringify(record) + '\n')
  return path
}

describe('experience store: verifier gating (§7.2)', () => {
  it('admits a success record carrying a formal_proof_valid pass record', async () => {
    const dir = await store()
    const added = await addSuccess(dir, successRecord())
    expect(added).toMatchObject({ subcommand: 'add-success', seq: 0, goalShape: 'forall n : Nat, n + 0 = n' })
    expect(added.hash).toMatch(/^[a-f0-9]{64}$/)
    expect((await verify(dir)).success).toBe(1)
  })

  it('REFUSES a record without the typed verification record (exit 2)', async () => {
    const dir = await store()
    const cases = [
      { ...successRecord(), verification: undefined }, // no verification at all
      { ...successRecord(), verification: { kind: 'l2-pass', verdict: 'pass' } }, // the wrong kind
      { ...successRecord(), verification: { kind: 'formal-proof-valid', verdict: 'fail' } }, // a failing verdict
      successRecord({ bindingHashes: {} }), // no hash binding
    ]
    for (const [index, record] of cases.entries()) {
      const path = await writeRecord(dir, `bad-${index}.json`, record)
      const { exitCode, output } = await cli(main, ['add-success', '--store', dir, '--record', path])
      expect(exitCode, `case ${index}`).toBe(2)
      expect(output).toMatchObject({ status: 'blocked' })
    }
    // Nothing was written by any refused call.
    await expect(verify(dir)).resolves.toMatchObject({ entries: 0 })
    await expect(addSuccess(dir, successRecord({ verification: undefined }))).rejects.toMatchObject({ code: 'unverified-record' })
  })

  it('failure records need no verification — they make no correctness claim', async () => {
    const dir = await store()
    const added = await addFailure(dir, failureRecord())
    expect(added.subcommand).toBe('add-failure')
    await expect(addFailure(dir, failureRecord({ errorClass: '' }))).rejects.toMatchObject({ code: 'config-invalid' })
    await expect(addFailure(dir, failureRecord({ verification: { kind: 'formal-proof-valid', verdict: 'pass' } }))).rejects.toMatchObject({ code: 'config-invalid' })
  })
})

describe('experience store: append-only chain hash', () => {
  it('every entry links to the previous hash and any field edit breaks the chain', async () => {
    const dir = await store()
    await addSuccess(dir, successRecord())
    await addFailure(dir, failureRecord())
    const paths = storePaths(dir)
    const original = await readFile(paths.ledger, 'utf8')
    expect(original.trim().split('\n')).toHaveLength(2)
    expect((await verify(dir)).chainValid).toBe(true)
    for (const tampered of [
      original.replace('"type-mismatch"', '"no-match"'), // edit a record field
      original.replace('"seq":1', '"seq":4'), // edit a sequence number
      original.replace(/"hash":"[a-f0-9]{64}"/u, `"hash":"${HEX('b')}"`), // edit a hash
    ]) {
      await writeFile(paths.ledger, tampered)
      const { exitCode, output } = await cli(main, ['verify', '--store', dir])
      expect(exitCode).toBe(2)
      expect(output).toMatchObject({ status: 'blocked', reason: { code: 'chain-invalid' } })
      await writeFile(paths.ledger, original)
    }
    // Appending onto a tampered chain is refused rather than extended.
    await writeFile(paths.ledger, original.replace('"type-mismatch"', '"no-match"'))
    await expect(addFailure(dir, failureRecord({ goalShape: 'another goal' }))).rejects.toMatchObject({ code: 'chain-invalid' })
  })
})

describe('experience store: lockfile discipline (§3.3)', () => {
  it('a live lock makes a concurrent write fail closed; a stale one is taken over', async () => {
    const dir = await store()
    const paths = storePaths(dir)
    await mkdir(dir, { recursive: true })
    // A live holder (now) blocks.
    await writeFile(paths.lock, JSON.stringify({ pid: 4242, at: new Date().toISOString(), command: 'add-success' }) + '\n')
    const blocked = await cli(main, ['add-failure', '--store', dir, '--record', await writeRecord(dir, 'f.json', failureRecord())])
    expect(blocked.exitCode).toBe(2)
    expect(blocked.output).toMatchObject({ status: 'blocked', reason: { code: 'experience-locked' } })
    // Stale after 60s: the lock is taken over and the write proceeds.
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1000).toISOString()
    await writeFile(paths.lock, JSON.stringify({ pid: 4242, at: stale, command: 'add-success' }) + '\n')
    await addFailure(dir, failureRecord())
    expect(await readLock(paths.lock)).toBeNull() // released after the write
    expect((await verify(dir)).entries).toBe(1)
  })

  it('acquire/release is exclusive and leaves no lock behind on failure', async () => {
    const dir = await store()
    const paths = storePaths(dir)
    await mkdir(dir, { recursive: true })
    const first = await acquireLock(paths, { command: 'test' })
    await expect(acquireLock(paths, { command: 'test' })).rejects.toMatchObject({ code: 'experience-locked' })
    await first.release()
    const second = await acquireLock(paths, { command: 'test' })
    await second.release()
    expect(await readLock(paths.lock)).toBeNull()
  })
})

describe('experience store: ablation write-blocking (§8.3)', () => {
  it('a writeBlocked lock refuses test-split writes with exit 2 until unblocked', async () => {
    const dir = await store()
    await block(dir, { reason: 'F vs G ablation' })
    const recordPath = await writeRecord(dir, 'ok.json', successRecord())
    const blocked = await cli(main, ['add-success', '--store', dir, '--record', recordPath])
    expect(blocked.exitCode).toBe(2)
    expect(blocked.output).toMatchObject({ status: 'blocked', reason: { code: 'write-blocked' } })
    for (const command of ['add-success', 'add-failure']) {
      const result = await cli(main, [command, '--store', dir, '--record', recordPath])
      expect(result.exitCode).toBe(2)
    }
    // A writeBlocked lock never expires by age: only `unblock` clears it.
    const paths = storePaths(dir)
    const content = JSON.parse(await readFile(paths.lock, 'utf8'))
    await writeFile(paths.lock, JSON.stringify({ ...content, at: new Date(Date.now() - LOCK_STALE_MS * 1000).toISOString() }) + '\n')
    expect((await cli(main, ['add-success', '--store', dir, '--record', recordPath])).exitCode).toBe(2)
    await unblock(dir)
    await addSuccess(dir, successRecord())
    expect((await status(dir)).entries).toBe(1)
  })

  it('the --write-blocked flag and MATH_EXPERIENCE_WRITE_BLOCKED=1 also refuse writes', async () => {
    const dir = await store()
    const recordPath = await writeRecord(dir, 'ok.json', successRecord())
    const flagged = await cli(main, ['add-success', '--store', dir, '--record', recordPath, '--write-blocked'])
    expect(flagged.exitCode).toBe(2)
    expect(flagged.output).toMatchObject({ reason: { code: 'write-blocked' } })
    await expect(addSuccess(dir, successRecord(), { env: { MATH_EXPERIENCE_WRITE_BLOCKED: '1' } })).rejects.toMatchObject({ code: 'write-blocked' })
    await expect(addFailure(dir, failureRecord(), { writeBlocked: true })).rejects.toMatchObject({ code: 'write-blocked' })
    expect((await verify(dir)).entries).toBe(0)
    // A plain live lock is not a write-block: unblock refuses to clear it.
    const paths = storePaths(dir)
    await writeFile(paths.lock, JSON.stringify({ pid: 1, at: new Date().toISOString(), command: 'add-success' }) + '\n')
    await expect(unblock(dir)).rejects.toMatchObject({ code: 'experience-locked' })
  })
})

describe('experience store: FTS5 retrieval (§7.2)', () => {
  it('--query retrieves by goal shape, premise and tactic skeleton, filtered by kind', async () => {
    const dir = await store()
    await addSuccess(dir, successRecord({ goalShape: 'continuous_at_zero', premises: ['ContinuousAt.add'], tacticSkeleton: 'continuity' }))
    await addSuccess(dir, successRecord({ goalShape: 'injective_successor', premises: ['Nat.succ.inj'], tacticSkeleton: 'exact Nat.succ.inj h' }))
    await addFailure(dir, failureRecord({ goalShape: 'injective_successor', failedApproach: 'cases b', errorClass: 'unsolved-goals' }))
    const byShape = await query(dir, { query: 'injective_successor' })
    // BM25 orders by relevance, not insertion: assert the membership, then the
    // kind filter, which is the contract that matters.
    expect(byShape.results.map((result: { kind: string }) => result.kind).sort()).toEqual(['failure', 'success'])
    expect(byShape.results.every((result: { record: { goalShape: string } }) => result.record.goalShape === 'injective_successor')).toBe(true)
    const onlyFailures = await query(dir, { query: 'injective_successor', kind: 'failure' })
    expect(onlyFailures.results).toHaveLength(1)
    expect(onlyFailures.results[0]?.record.errorClass).toBe('unsolved-goals')
    const byPremise = await query(dir, { query: 'ContinuousAt' })
    expect(byPremise.results.map((result: { record: { goalShape: string } }) => result.record.goalShape)).toEqual(['continuous_at_zero'])
    const byTactic = await query(dir, { query: 'succ' })
    expect(byTactic.results.length).toBeGreaterThan(0)
    // Empty result set is a legitimate empty array (exit 0).
    const none = await query(dir, { query: 'riemann_hypothesis' })
    expect(none.results).toEqual([])
    // An FTS5 syntax error exits 2 with the raw error.
    const { exitCode, output } = await cli(main, ['query', '--store', dir, '--query', 'Nat.add_zero'])
    expect(exitCode).toBe(2)
    expect(output).toMatchObject({ reason: { code: 'query-invalid' } })
  })

  it('the index is rebuilt when the chain head moved and reports the store status', async () => {
    const dir = await store()
    await addSuccess(dir, successRecord({ goalShape: 'first_goal' }))
    expect((await query(dir, { query: 'first_goal' })).index).toBe('rebuilt')
    await addSuccess(dir, successRecord({ goalShape: 'second_goal' }))
    const second = await query(dir, { query: 'second_goal' })
    expect(second.index).toBe('rebuilt')
    expect((await query(dir, { query: 'second_goal' })).index).toBe('current')
    const report = await status(dir)
    expect(report).toMatchObject({ entries: 2, lock: null })
    // The CLI prints exactly one line of JSON per result.
    const { raw } = await cli(main, ['status', '--store', dir])
    expect(raw.trim().split('\n')).toHaveLength(1)
  })
})
