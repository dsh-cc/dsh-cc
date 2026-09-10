import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CrusherStore, STORE_MAX_ENTRIES, shortHash } from '../src/store.ts'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function newStore(now: () => number = Date.now): { store: CrusherStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'ccr-store-'))
  dirs.push(root)
  return { store: new CrusherStore(root, now), root }
}

describe('CrusherStore', () => {
  it('round-trips and hashes deterministically', async () => {
    const { store } = newStore()
    const pk = shortHash('/some/project')
    const h1 = await store.put(pk, 'hello 世界')
    const h2 = await store.put(pk, 'hello 世界')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{16}$/)
    const out = await store.get(pk, h1)
    expect(out).toEqual({ ok: true, text: 'hello 世界' })
  })

  it('expires via the injectable clock without sleeping', async () => {
    let t = 1_000_000
    const { store } = newStore(() => t)
    const pk = 'p'.repeat(16)
    const h = await store.put(pk, 'x')
    t += 3600_000 + 1
    expect(await store.get(pk, h)).toEqual({ ok: false, error: 'expired' })
  })

  it('evicts LRU beyond the 200-entry cap', async () => {
    const { store } = newStore()
    const pk = 'p'.repeat(16)
    const hashes: string[] = []
    for (let i = 0; i <= STORE_MAX_ENTRIES; i++) hashes.push(await store.put(pk, `value-${i}`))
    await store.sweep()
    // The oldest entry was evicted.
    expect(await store.get(pk, hashes[0])).toEqual({ ok: false, error: 'unknown_hash' })
    expect(await store.get(pk, hashes[STORE_MAX_ENTRIES])).toEqual({ ok: true, text: `value-${STORE_MAX_ENTRIES}` })
  })

  it('returns typed corrupt for a garbage file and unknown_hash for a missing one', async () => {
    const { store, root } = newStore()
    const pk = 'p'.repeat(16)
    mkdirSync(join(root, pk), { recursive: true })
    writeFileSync(join(root, pk, 'deadbeefdeadbeef'), '\x00garbage{{{', 'utf8')
    expect(await store.get(pk, 'deadbeefdeadbeef')).toEqual({ ok: false, error: 'corrupt' })
    expect(await store.get(pk, '0000000000000000')).toEqual({ ok: false, error: 'unknown_hash' })
  })

  it('writes atomically (temp + rename; no temp residue) and never leaves the store root', async () => {
    const { store, root } = newStore()
    const pk = 'a'.repeat(16)
    const h = await store.put(pk, 'persisted')
    expect(existsSync(join(root, pk, h))).toBe(true)
    const dir = join(root, pk)
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'))
    expect(leftovers).toEqual([])
    // The written file is plain UTF-8 JSON envelope.
    const raw = readFileSync(join(root, pk, h), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ v: 1, text: 'persisted' })
  })

  it('rejects malformed hashes without touching the filesystem', async () => {
    const { store } = newStore()
    expect(await store.get('p'.repeat(16), '../escape')).toEqual({ ok: false, error: 'unknown_hash' })
    expect(await store.get('p'.repeat(16), 'NOTAHASH')).toEqual({ ok: false, error: 'unknown_hash' })
  })
})
