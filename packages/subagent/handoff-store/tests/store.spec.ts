import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HandoffStore, MAX_ENTRIES, TTL_MS, projectKeyOf } from '../src/store.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10 }) })

function newStore(now: () => number = Date.now): { store: HandoffStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'handoff-store-'))
  dirs.push(root)
  return { store: new HandoffStore(root, now), root }
}

describe('HandoffStore', () => {
  it('round-trips with metadata', async () => {
    const { store } = newStore()
    const pk = projectKeyOf('/some/project')
    const id = await store.put(pk, 'hello 世界', { label: 'review', agent: 'critic' })
    expect(id).toMatch(/^[0-9a-f]{20}$/)
    const out = await store.get(pk, id)
    expect(out).toEqual({ ok: true, text: 'hello 世界', label: 'review', agent: 'critic' })
  })

  it('same content twice yields distinct ids (4-hex collision suffix)', async () => {
    const { store } = newStore()
    const pk = 'a'.repeat(16)
    const id1 = await store.put(pk, 'same')
    const id2 = await store.put(pk, 'same')
    expect(id1.slice(0, 16)).toBe(id2.slice(0, 16))
    expect(id1).not.toBe(id2)
    expect((await store.get(pk, id1)).ok).toBe(true)
    expect((await store.get(pk, id2)).ok).toBe(true)
  })

  it('expires via the stored envelope ts (injectable clock) and deletes lazily', async () => {
    let t = 1_000_000
    const { store, root } = newStore(() => t)
    const pk = 'b'.repeat(16)
    const id = await store.put(pk, 'x')
    t += TTL_MS + 1
    expect(await store.get(pk, id)).toEqual({ ok: false, error: 'expired' })
    // Lazy delete: a SECOND store instance (fresh process simulation) sees it gone.
    const second = new HandoffStore(root, () => t)
    expect(await second.get(pk, id)).toEqual({ ok: false, error: 'unknown_id' })
    expect(existsSync(join(root, pk, `${id}.md`))).toBe(false)
  })

  it('LRU eviction is disk-based and visible to a fresh store instance', async () => {
    let t = 1_000_000
    const { store, root } = newStore(() => t)
    const pk = 'c'.repeat(16)
    const ids: string[] = []
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      ids.push(await store.put(pk, `value-${i}`))
      t += 1000 // each put older than the next
    }
    // A NEW store instance — no shared memory — observes the same eviction.
    const second = new HandoffStore(root, () => t)
    expect(await second.get(pk, ids[0])).toEqual({ ok: false, error: 'unknown_id' })
    expect(await second.get(pk, ids[MAX_ENTRIES])).toEqual({ ok: true, text: `value-${MAX_ENTRIES}` })
  })

  it('sweep drops files past the TTL (mtime proxy)', async () => {
    let t = 1_000_000
    const { store, root } = newStore(() => t)
    const pk = 'd'.repeat(16)
    const old = await store.put(pk, 'old')
    const fresh = await store.put(pk, 'fresh')
    // Age the first file beyond TTL.
    utimesSync(join(root, pk, `${old}.md`), new Date(0), new Date(0))
    t += 2 * TTL_MS
    await store.sweep(pk)
    expect(existsSync(join(root, pk, `${old}.md`))).toBe(false)
    expect(existsSync(join(root, pk, `${fresh}.md`))).toBe(true)
  })

  it('typed errors: corrupt and unknown; malformed ids never touch the fs', async () => {
    const { store, root } = newStore()
    const pk = 'e'.repeat(16)
    mkdirSync(join(root, pk), { recursive: true })
    writeFileSync(join(root, pk, 'deadbeefdeadbeef0000.md'), '\x00garbage{{{', 'utf8')
    expect(await store.get(pk, 'deadbeefdeadbeef0000')).toEqual({ ok: false, error: 'corrupt' })
    expect(await store.get(pk, 'f'.repeat(20))).toEqual({ ok: false, error: 'unknown_id' })
    // Fail-closed: traversal and wrong shapes are unknown_id without reads.
    expect(await store.get(pk, '../escape')).toEqual({ ok: false, error: 'unknown_id' })
    expect(await store.get(pk, 'NOTAHASH')).toEqual({ ok: false, error: 'unknown_id' })
    expect(await store.get(pk, 'deadbeefdeadbeef000')).toEqual({ ok: false, error: 'unknown_id' })
    // The store never wrote outside its root.
    expect(readdirSync(root)).toEqual([pk])
  })

  it('handles unicode and a 10 MB payload', async () => {
    const { store } = newStore()
    const pk = 'f'.repeat(16)
    const big = '🚀'.repeat(2_000_000) + 'x'.repeat(8_000_000)
    expect(big.length).toBeGreaterThan(10_000_000)
    const id = await store.put(pk, big)
    const out = await store.get(pk, id)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.text).toBe(big)
  })

  it('atomic writes leave no temp residue', async () => {
    const { store, root } = newStore()
    const pk = 'a'.repeat(16)
    const id = await store.put(pk, 'persisted')
    expect(existsSync(join(root, pk, `${id}.md`))).toBe(true)
    expect(readdirSync(join(root, pk)).filter((f) => f.includes('.tmp-'))).toEqual([])
  })
})
