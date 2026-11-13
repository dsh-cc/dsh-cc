/**
 * Integration (real boot) — the design's Verification section
 * (docs/plans/2026-11-12-per-step-input-ledger.md §"Verification"): the real
 * agent loop over `JsonlSessionPersistence` + MockAdapter, three model
 * requests against a temp `DSH_HOME`, then the emitted rows read back through
 * the package's own readers. The rig itself (boot, settling, file readers)
 * lives in `tests/real-boot-rig.ts`.
 *
 * The cache-health leg boots the same rig twice — ledger mounted and ledger
 * absent — so the "unchanged output with the ledger present" claim is an A/B,
 * not a self-assertion: the ledger's `llm/stream` listener is prepend+global
 * exactly like cache-health's.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  bootAndRun,
  cacheHealthRowsOf,
  cleanupRoots,
  filesUnder,
  ledgerRowsOf,
  newSharedRoots,
  readJsonl,
  waitFor,
} from './real-boot-rig.ts'

afterEach(cleanupRoots)

describe('input-ledger real boot (design §Verification)', () => {
  it('three requests emit three request rows and at least one assemble row under a temp DSH_HOME', async () => {
    const boot = await bootAndRun(true)
    const { requests, assembles } = await waitFor(async () => {
      const rows = await ledgerRowsOf(boot.home)
      return rows.requests.length >= 3 ? rows : undefined
    }, 'three request rows')

    // ── request rows: one per outgoing model call, all main-loop ───────────
    expect(requests).toHaveLength(3)
    expect(requests.every((row) => row.type === 'request')).toBe(true)
    expect(requests.every((row) => row.mainLoop)).toBe(true)
    expect(requests.every((row) => row.sessionId === String(boot.sessionId))).toBe(true)
    // gen: one non-empty process boot id shared by every row of the mount.
    const gens = new Set(requests.map((row) => row.gen))
    expect(gens.size).toBe(1)
    expect([...gens][0]!.length).toBeGreaterThan(0)

    // ── seqPerGen is monotonic per (sessionId, gen) ────────────────────────
    const seqs = requests.map((row) => row.seqPerGen)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)

    // ── system metrics come from MESSAGES, not options.system ──────────────
    // The r1 acceptance check that previously could not pass: a loop-built
    // request carries the system prompt inside `options.messages`, so a
    // non-empty systemHash8 proves the messages walk ran.
    for (const row of requests) {
      expect(row.systemBytes).toBeGreaterThan(0)
      expect(row.systemHash8).toMatch(/^[0-9a-f]{8}$/)
      expect(row.provider).toBe('mock')
      expect(row.model).toBe('mock')
      expect(row.purpose).toBeUndefined()
      // attribution recorded by Observer C from the pre-step payload
      expect(typeof row.turn).toBe('number')
      expect(typeof row.step).toBe('number')
      expect(row.messages.count).toBeGreaterThan(0)
      expect(row.messages.bytesTotal).toBeGreaterThan(0)
      expect(Object.keys(row.messages.bySourceKind).length).toBeGreaterThan(0)
      // §Privacy: a request row carries no message text at all — the
      // structural guarantee, re-checked on the real wire shapes.
      expect(JSON.stringify(row)).not.toContain('turn 0')
    }

    // ── assemble rows: at least one, content-free, with real sections ──────
    expect(assembles.length).toBeGreaterThanOrEqual(1)
    for (const row of assembles) {
      expect(row.type).toBe('assemble')
      expect(row.sessionId).toBe(String(boot.sessionId))
      expect(row.isSubagent).toBe(false)
      expect(row.sections.length).toBeGreaterThan(0)
      expect(row.totalBytes).toBe(row.sections.reduce((sum, section) => sum + section.bytes, 0))
      for (const section of row.sections) {
        expect(section.name.length).toBeGreaterThan(0)
        expect(section.hash8).toMatch(/^[0-9a-f]{8}$/)
      }
    }

    await boot.ctx.fiber.dispose()
  }, 30_000)

  it('leaves cache-health output unchanged (A/B against a ledger-less boot)', async () => {
    const shared = newSharedRoots()
    const withLedger = await bootAndRun(true, shared)
    await waitFor(async () => {
      const rows = await ledgerRowsOf(withLedger.home)
      return rows.requests.length >= 3 ? rows : undefined
    }, 'three request rows (ledger boot)')
    const withRows = await waitFor(
      () => (cacheHealthRowsOf(withLedger.home, withLedger.sessionId).length >= 3
        ? cacheHealthRowsOf(withLedger.home, withLedger.sessionId)
        : undefined),
      'three cache-health rows (ledger boot)',
    )

    const without = await bootAndRun(false, shared)
    const withoutRows = await waitFor(
      () => (cacheHealthRowsOf(without.home, without.sessionId).length >= 3
        ? cacheHealthRowsOf(without.home, without.sessionId)
        : undefined),
      'three cache-health rows (ledger-less boot)',
    )

    // Same row count, same deterministic payload. `stablePrefixHash` is the
    // one excluded field: it digests the whole message JSON, which carries a
    // per-session random message id minted by the assemble step, so two
    // sessions can never share it. Everything the observation decides —
    // segment counts, token estimates, prefixChanged, drift markers,
    // provider/model/purpose — IS compared.
    expect(withRows).toHaveLength(withoutRows.length)
    const stableFields = (rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
      rows.map((row) => {
        const copy = { ...row }
        delete copy.ts
        delete copy.stablePrefixHash
        return copy
      })
    expect(stableFields(withRows)).toEqual(stableFields(withoutRows))

    // Writer separation in both directions: the ledger never lands a row in
    // cache-health's tree, and cache-health never lands one in the ledger's.
    for (const file of filesUnder(join(withLedger.home, 'cache-health'))) {
      for (const row of readJsonl(file)) expect(row.type).toBeUndefined()
    }
    for (const file of filesUnder(join(withLedger.home, 'input-ledger'))) {
      for (const row of readJsonl(file)) expect(row.stablePrefixHash).toBeUndefined()
    }

    await withLedger.ctx.fiber.dispose()
    await without.ctx.fiber.dispose()
  }, 60_000)
})
