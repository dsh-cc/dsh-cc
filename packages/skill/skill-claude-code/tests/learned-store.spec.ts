import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  LEARNED_NAME_SOURCE,
  LearnedSkillStore,
  MAX_LEARNED_SKILL_BYTES,
  isLearnedSkillName,
  learnedSkillPath,
  sanitizeLearnedDescription,
  serializeLearnedSkill,
} from '../src/learned-store.ts'

async function tempDir(name: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `dsh-cc-learned-${name}-`))
}

interface FakeHarness {
  claimants: { name: string; provider: string; source: string }[]
  onChangedCalls: number
  store: LearnedSkillStore
  home: string
}

async function makeStore(claimants: FakeHarness['claimants'] = []): Promise<FakeHarness> {
  const home = await tempDir('home')
  const harness: FakeHarness = { claimants, onChangedCalls: 0, store: undefined!, home }
  harness.store = new LearnedSkillStore({
    dshHome: home,
    listClaimants: async () => harness.claimants,
    onChanged: () => {
      harness.onChangedCalls += 1
    },
  })
  return harness
}

const VALID = { name: 'release-dance', description: 'Release dance steps', learnedFrom: 'manage_skill 2026-09-24', body: 'Step one.' }

describe('learned skill name + sanitize units', () => {
  it('name charset', () => {
    expect(isLearnedSkillName('ok-name1')).toBe(true)
    expect(isLearnedSkillName('a'.repeat(64))).toBe(true)
    expect(isLearnedSkillName('-bad')).toBe(false)
    expect(isLearnedSkillName('Bad')).toBe(false)
    expect(isLearnedSkillName('a'.repeat(65))).toBe(false)
    expect(LEARNED_NAME_SOURCE.source).toBe('^[a-z0-9][a-z0-9-]{0,63}$')
  })

  it('description sanitize strips control/format chars and brackets, one line', () => {
    expect(sanitizeLearnedDescription('a  <b>`c`\n\td\u0000\u200b e')).toBe('a b c d e')
  })
})

describe('learned store', () => {
  it('create writes file, enforces size cap on full file, fires onChanged once', async () => {
    const h = await makeStore()
    const result = await h.store.create(VALID)
    expect(result.ok).toBe(true)
    const raw = await readFile(learnedSkillPath(h.home, VALID.name), 'utf8')
    expect(raw).toContain('name: release-dance')
    expect(raw).toContain('learnedFrom: manage_skill 2026-09-24')
    expect(h.onChangedCalls).toBe(1)

    // cap measured over the serialized file bytes
    const big = await makeStore()
    const tooBig = await big.store.create({ ...VALID, name: 'big-one', body: 'x'.repeat(MAX_LEARNED_SKILL_BYTES) })
    expect(tooBig).toMatchObject({ ok: false, code: 'too_large' })
    expect(big.onChangedCalls).toBe(0)
  })

  it('rejects empty-after-sanitize descriptions', async () => {
    const h = await makeStore()
    const result = await h.store.create({ ...VALID, description: '<>`\u0000' })
    expect(result).toMatchObject({ ok: false, code: 'invalid_params' })
  })

  it('invalid names are refused before any claim or write', async () => {
    const h = await makeStore()
    const result = await h.store.create({ ...VALID, name: 'BAD_NAME' })
    expect(result).toMatchObject({ ok: false, code: 'invalid_name' })
  })

  it('create → already_exists when the learned file is on disk', async () => {
    const h = await makeStore()
    await h.store.create(VALID)
    h.claimants.push({ name: VALID.name, provider: 'claude-code', source: 'learned' })
    const again = await h.store.create({ ...VALID, body: 'Other.' })
    expect(again).toMatchObject({ ok: false, code: 'already_exists' })
  })

  it('create → already_exists from the on-disk file even with no claimant', async () => {
    const h = await makeStore()
    await h.store.create(VALID)
    const again = await h.store.create({ ...VALID, body: 'Other.' })
    expect(again).toMatchObject({ ok: false, code: 'already_exists' })
  })

  it('create → shadowed when a claimant with source !== learned exists (no file)', async () => {
    const h = await makeStore()
    h.claimants.push({ name: VALID.name, provider: 'runtime', source: 'user-dsh' })
    const result = await h.store.create(VALID)
    expect(result).toMatchObject({ ok: false, code: 'shadowed' })
    if (!result.ok) expect(result.detail).toContain('runtime (source user-dsh)')
  })

  it('create proceeds past a stale learned claimant whose file is gone', async () => {
    const h = await makeStore()
    h.claimants.push({ name: VALID.name, provider: 'claude-code', source: 'learned' })
    const result = await h.store.create(VALID)
    expect(result.ok).toBe(true)
    await expect(readFile(learnedSkillPath(h.home, VALID.name), 'utf8')).resolves.toContain('name: release-dance')
  })

  it('wx EEXIST race → already_exists', async () => {
    const home = await tempDir('home')
    // Simulate the race: the file appears after the claim check but before
    // the wx write — the fake claimant list materializes it mid-flight.
    const harness: FakeHarness = { claimants: [], onChangedCalls: 0, store: undefined!, home }
    harness.store = new LearnedSkillStore({
      dshHome: home,
      listClaimants: async () => {
        await mkdir(dirname(learnedSkillPath(home, VALID.name)), { recursive: true })
        await writeFile(learnedSkillPath(home, VALID.name), 'raced')
        return harness.claimants
      },
      onChanged: () => {
        harness.onChangedCalls += 1
      },
    })
    const race = await harness.store.create(VALID)
    expect(race).toMatchObject({ ok: false, code: 'already_exists' })
  })

  it('update preserves unknown frontmatter keys', async () => {
    const h = await makeStore()
    await h.store.create(VALID)
    const path = learnedSkillPath(h.home, VALID.name)
    await writeFile(path, (await readFile(path, 'utf8')).replace('name: release-dance\n', 'name: release-dance\ncustom-key: keep-me\n'))
    const result = await h.store.update({ name: VALID.name, body: 'New body.' })
    expect(result.ok).toBe(true)
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('custom-key: keep-me')
    expect(raw).toContain('New body.')
    expect(raw).toContain('Release dance steps')
  })

  it('update on new description sanitizes and rejects empty', async () => {
    const h = await makeStore()
    await h.store.create(VALID)
    const ok = await h.store.update({ name: VALID.name, description: '  a\nb  ' })
    expect(ok.ok).toBe(true)
    const raw = await readFile(learnedSkillPath(h.home, VALID.name), 'utf8')
    expect(raw).toContain('description: a b')
    const bad = await h.store.update({ name: VALID.name, description: '`<>`' })
    expect(bad).toMatchObject({ ok: false, code: 'invalid_params' })
  })

  it('update missing params → invalid_params', async () => {
    const h = await makeStore()
    await h.store.create(VALID)
    const result = await h.store.update({ name: VALID.name })
    expect(result).toMatchObject({ ok: false, code: 'invalid_params' })
  })

  it('update/delete not_found without any claimant', async () => {
    const h = await makeStore()
    const plain = await h.store.update({ name: VALID.name, body: 'x' })
    expect(plain).toMatchObject({ ok: false, code: 'not_found' })
    const deleted = await h.store.delete(VALID.name)
    expect(deleted).toMatchObject({ ok: false, code: 'not_found' })
    expect(h.onChangedCalls).toBe(0)
  })

  it('not_found gains authored hint when a claimant with source !== learned exists', async () => {
    const h = await makeStore()
    h.claimants.push({ name: VALID.name, provider: 'runtime', source: 'user-dsh' })
    const result = await h.store.update({ name: VALID.name, body: 'x' })
    expect(result).toMatchObject({ ok: false, code: 'not_found' })
    if (!result.ok) {
      expect(result.detail).toContain('authored skill with that name is provided by runtime (source user-dsh) and is not managed by this tool')
    }
    const deleted = await h.store.delete(VALID.name)
    if (!deleted.ok) expect(deleted.detail).toContain('authored skill')
  })

  it('delete removes the skill directory and fires onChanged', async () => {
    const h = await makeStore()
    await h.store.create(VALID)
    const result = await h.store.delete(VALID.name)
    expect(result.ok).toBe(true)
    await expect(readFile(learnedSkillPath(h.home, VALID.name), 'utf8')).rejects.toThrow()
    expect(h.onChangedCalls).toBe(2) // create + delete
  })

  it('list returns name/description/bytes/path entries', async () => {
    const h = await makeStore()
    const empty = await h.store.list()
    expect(empty).toMatchObject({ ok: true, value: [] })
    await h.store.create(VALID)
    const result = await h.store.list()
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toHaveLength(1)
      expect(result.value[0]).toMatchObject({ name: VALID.name, description: VALID.description })
      expect(result.value[0]?.bytes).toBeGreaterThan(0)
      expect(result.value[0]?.path).toBe(learnedSkillPath(h.home, VALID.name))
    }
  })
})

describe('serializeLearnedSkill', () => {
  it('round-trips through frontmatter parse', async () => {
    const { parseCcFrontmatterDocument } = await import('../src/frontmatter.ts')
    const raw = serializeLearnedSkill(VALID)
    const doc = parseCcFrontmatterDocument(raw)
    expect(doc?.data).toMatchObject({ name: VALID.name, description: VALID.description, learnedFrom: VALID.learnedFrom })
    expect(doc?.body).toContain('Step one.')
  })
})
