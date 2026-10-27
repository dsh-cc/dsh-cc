import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it, expect } from 'vitest'
import { canonicalJson, hasTopLevelArrow, parseJsonTokens, parseLeanManifest, statementMatrix } from '../skills/formal-design/scripts/lean-manifest.lib.mjs'
import { contentDigest, digestEntries, executionDigest, installationEntries, loadToolchain, receiptPath, sha256 } from '../skills/formal-design/scripts/lean-fingerprint.lib.mjs'
import { parseManifest } from '../skills/formal-design/scripts/manifest.lib.mjs'

const fixtureDir = join(import.meta.dirname, 'fixtures/formal-design-lean')
const checksPath = join(fixtureDir, 'project/specs/lean/budget-reservation/checks.json')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const codeOf = (fn: () => unknown) => { try { fn() } catch (e: any) { return e.code } return 'ok' }
const base = async () => JSON.parse(await readFile(checksPath, 'utf8'))
const rejects = async (mutate: (m: any) => void) => { const m = await base(); mutate(m); expect(codeOf(() => parseLeanManifest(JSON.stringify(m)))).toBe('config-invalid') }

describe('lean manifest version-one contract', () => {
  it('accepts the committed fixture and keeps its witness bindings', async () => {
    const manifest = parseLeanManifest(await readFile(checksPath, 'utf8'))
    expect(manifest.modelId).toBe('budget-reservation')
    expect(manifest.properties.map((p: any) => p.id)).toEqual(['budget-bound', 'zero-request'])
    expect(manifest.properties[0]).toMatchObject({ requirementId: 'REQ-1', declaration: 'Formal.reserve_preserves_bound', witnessDeclaration: 'Formal.admissible_example' })
  })
  it('rejects unknown fields, missing fields and a wrong identity', async () => {
    await rejects(m => { m.extra = true })
    await rejects(m => { m.properties[0].note = 'x' })
    await rejects(m => { delete m.properties[0].witnessDeclaration })
    await rejects(m => { delete m.limits.maxCases })
    await rejects(m => { m.schemaVersion = 2 })
    await rejects(m => { m.backend = 'tla' })
    await rejects(m => { m.modelId = 'Budget' })
    await rejects(m => { m.properties = [] })
    await rejects(m => { m.properties = Array.from({ length: 65 }, (_, i) => ({ ...m.properties[0], id: `p-${i}` })) })
  })
  it('enforces the ID, requirement, declaration and statement grammars', async () => {
    await rejects(m => { m.properties.push(m.properties[0]) })
    await rejects(m => { m.properties[0].id = 'budget_bound' })
    await rejects(m => { m.properties[0].requirementId = 'REQ-0' })
    await rejects(m => { m.properties[0].requirementId = 'req-1' })
    await rejects(m => { m.properties[0].declaration = 'Formal.∀x' })
    await rejects(m => { m.properties[0].declaration = 'Formal..x' })
    await rejects(m => { m.properties[0].statement = '' })
    await rejects(m => { m.properties[0].statement = 'x'.repeat(16385) })
    await rejects(m => { m.properties[0].witnessDeclaration = 'Formal.a b' })
  })
  it.each([
    ['proofTimeoutMs', 999], ['proofTimeoutMs', 600001], ['proofTimeoutMs', 1000.5],
    ['conformanceTimeoutMs', 999], ['maxHeartbeats', 999], ['maxHeartbeats', 10000001],
    ['maxRecDepth', 127], ['maxRecDepth', 4097], ['maxCases', 0], ['maxCases', 100001],
  ])('rejects limits %s = %s', async (field, value) => { await rejects(m => { m.limits[field] = value }) })
  it('accepts the boundary values of every limit', async () => {
    const m = await base()
    m.limits = { proofTimeoutMs: 1000, conformanceTimeoutMs: 600000, maxHeartbeats: 1000, maxRecDepth: 4096, maxCases: 100000 }
    expect(parseLeanManifest(JSON.stringify(m)).limits.maxCases).toBe(100000)
  })
  it('pins the conformance block to the fixed paths, command and comparison', async () => {
    await rejects(m => { m.conformance.adapter = 'adapter.mjs' })
    await rejects(m => { m.conformance.corpus = 'cases.jsonl' })
    await rejects(m => { m.conformance.command = ['sh', 'conformance/adapter.mjs'] })
    await rejects(m => { m.conformance.command = ['node', 'conformance/adapter.mjs', '--fast'] })
    await rejects(m => { m.conformance.comparison = 'json' })
    await rejects(m => { m.conformance.implementationFiles = [] })
    await rejects(m => { m.conformance.executionFiles = 'package.json' })
    await rejects(m => { m.conformance.extra = [] })
  })
  it('rejects absolute, traversal, duplicated and unnormalized declared paths', async () => {
    await rejects(m => { m.conformance.implementationFiles = ['/etc/passwd'] })
    await rejects(m => { m.conformance.implementationFiles = ['../outside.ts'] })
    await rejects(m => { m.conformance.implementationFiles = ['a/../b.ts'] })
    await rejects(m => { m.conformance.implementationFiles = ['a//b.ts'] })
    await rejects(m => { m.conformance.implementationFiles = ['a/'] })
    await rejects(m => { m.conformance.implementationFiles = ['a\\b.ts'] })
    await rejects(m => { m.conformance.implementationFiles = ['C:/tmp/b.ts'] })
    await rejects(m => { m.conformance.executionFiles = ['packages/example/src/budget.ts'] })
    await rejects(m => { m.conformance.implementationFiles = ['a.ts', 'a.ts'] })
  })
  it('makes the conformance block optional so a proof-only model can be checked', async () => {
    const m = await base(); delete m.conformance
    expect(parseLeanManifest(JSON.stringify(m)).conformance).toBeUndefined()
  })
})

describe('witness top-level arrow scan', () => {
  it('scans the matrix so a forall telescope cannot hide an implication', () => {
    expect(statementMatrix('forall b r a : Nat, r + a <= b')).toBe('r + a <= b')
    expect(statementMatrix('∀ x : Nat, ∀ y : Nat, x = y')).toBe('x = y')
    expect(hasTopLevelArrow('forall b r a : Nat, r <= b -> r + a <= b')).toBe(true)
    expect(hasTopLevelArrow('∀ b r a : Nat, r <= b → r + a <= b')).toBe(true)
    expect(hasTopLevelArrow('forall b r : Nat, r <= b')).toBe(false)
  })
  it('does not treat an arrow inside a binder type as the top-level arrow', () => {
    expect(statementMatrix('forall f : Nat -> Nat, f = f')).toBe('f = f')
    expect(hasTopLevelArrow('forall f : Nat -> Nat, f = f')).toBe(false)
    expect(hasTopLevelArrow('forall f : List Nat → Nat, f = f')).toBe(false)
  })
  it('blocks a null witness on an implication and a witness on a plain statement', async () => {
    await rejects(m => { m.properties[0].witnessDeclaration = null })
    const plain = await base()
    plain.properties[0].statement = 'forall n : Nat, n = n'
    expect(codeOf(() => parseLeanManifest(JSON.stringify(plain)))).toBe('config-invalid')
    plain.properties[0].witnessDeclaration = null
    expect(codeOf(() => parseLeanManifest(JSON.stringify(plain)))).toBe('ok')
  })
})

describe('raw JSON token grammar and canonical serialization', () => {
  it('rejects duplicate decoded keys at every depth, including escaped spellings', () => {
    for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":[{"b":1,"b":2}]}', '{"a":{"k":1,"\\u006b":2}}']) expect(codeOf(() => parseJsonTokens(text))).toBe('config-invalid')
    expect(parseJsonTokens('{"__proto__":{"a":1}}')).toHaveProperty('__proto__')
  })
  it('rejects fractions, exponents, leading zeros, -0 and unsafe integers', () => {
    for (const text of ['{"n":1.0}', '{"n":1.5}', '{"n":1e3}', '{"n":01}', '{"n":-0}', '{"n":9007199254740992}', '{"n":-9007199254740992}', '{"n":+1}']) expect(codeOf(() => parseJsonTokens(text))).toBe('config-invalid')
    expect(parseJsonTokens('{"n":-3,"m":9007199254740991}')).toEqual({ n: -3, m: 9007199254740991 })
  })
  it('rejects strings that are not sequences of Unicode scalar values and trailing content', () => {
    for (const text of ['{"a":"\\ud800"}', '{"a":"\\udc00x"}', '{"a":1} {}', '{"a":1} x']) expect(codeOf(() => parseJsonTokens(text))).toBe('config-invalid')
    expect(parseJsonTokens('{"a":"😀"}')).toEqual({ a: '😀' })
  })
  it('serializes canonically with code-point sorted keys and preserved array order', () => {
    const value = parseJsonTokens('{"b":1,"a":[2,{"d":null,"c":true}],"A":"x","😀":0,"\uE000":1}')
    expect(canonicalJson(value)).toBe('{"A":"x","a":[2,{"c":true,"d":null}],"b":1,"\uE000":1,"😀":0}')
  })
  it('refuses to canonicalize non-integer and -0 numbers', () => {
    expect(codeOf(() => canonicalJson({ n: 1.5 }))).toBe('config-invalid')
    expect(codeOf(() => canonicalJson({ n: -0 }))).toBe('config-invalid')
  })
})

describe('toolchain pin, digests and installation enumeration', () => {
  it('pins exactly the section 6 release assets and axioms', async () => {
    const pin = await loadToolchain()
    expect(pin).toEqual({
      schemaVersion: 1,
      toolchain: 'leanprover/lean4:v4.35.0',
      platforms: {
        'linux-x64': { archiveUrl: 'https://github.com/leanprover/lean4/releases/download/v4.35.0/lean-4.35.0-linux.tar.zst', sha256: '7289597a44543246c9227b8cae501767e095ce17f6d448b95fc4a8dc97268f6d' },
        'darwin-arm64': { archiveUrl: 'https://github.com/leanprover/lean4/releases/download/v4.35.0/lean-4.35.0-darwin_aarch64.tar.zst', sha256: 'c0c6f34f35ba1dcc5c4a5fd106fefab9eb5e8469712624dd2c868d51b63177c2' },
      },
      allowedAxioms: ['propext', 'Classical.choice', 'Quot.sound'],
    })
  })
  it('rejects a mutated pin instead of widening it silently', async () => {
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'lean pin ')); roots.push(dir)
    const pin = JSON.parse(await readFile(join(import.meta.dirname, '../skills/formal-design/scripts/lean-toolchain.json'), 'utf8'))
    pin.platforms['linux-x64'].sha256 = 'deadbeef'
    await writeFile(join(dir, 'lean-toolchain.json'), JSON.stringify(pin))
    await expect(loadToolchain(dir)).rejects.toMatchObject({ code: 'config-invalid' })
    pin.platforms['linux-x64'].sha256 = 'a'.repeat(64); pin.allowedAxioms.push('Lean.ofReduceBool')
    await writeFile(join(dir, 'lean-toolchain.json'), JSON.stringify(pin))
    await expect(loadToolchain(dir)).rejects.toMatchObject({ code: 'config-invalid' })
  })
  it('keeps the existing digestEntries algorithm and builds the execution digest payload', () => {
    const entries = [{ path: 'b', sha256: '2' }, { path: 'a', sha256: '1' }]
    expect(digestEntries(entries)).toBe(sha256(Buffer.from(JSON.stringify([['b', '2'], ['a', '1']]))))
    expect(executionDigest(entries, '/usr/bin/node|v22.19.0', 'ff')).toBe(sha256(Buffer.from('{"files":[["b","2"],["a","1"]],"node":"/usr/bin/node|v22.19.0","proofInputDigest":"ff"}')))
  })
  it('enumerates bin/ and lib/ plus top-level shared libraries in code-point order', async () => {
    const { root } = await installation()
    const entries = await installationEntries(root)
    expect(entries.map(e => e.path)).toEqual(['bin/lean', 'lib/lean/library/Init.olean', 'libleanshared.so'])
    expect(receiptPath(root)).toBe(`${root}.receipt.json`)
  })
  it('hashes a symlink inside the root as its target bytes and rejects an escaping symlink', async () => {
    const { base, root } = await installation()
    await symlink(join(root, 'lib/lean/library/Init.olean'), join(root, 'lib/lean/library/Alias.olean'))
    const entries = await installationEntries(root)
    const alias = entries.find(e => e.path === 'lib/lean/library/Alias.olean')
    expect(alias.sha256).toBe(sha256(Buffer.from('fake-olean-bytes\n')))
    const outside = join(base, 'outside.bin'); await writeFile(outside, 'outside')
    await symlink(outside, join(root, 'lib/lean/library/Escape.olean'))
    await expect(contentDigest(root)).rejects.toMatchObject({ code: 'io' })
  })
  it('digests the tree stably and changes when installation bytes change', async () => {
    const { root } = await installation()
    const first = await contentDigest(root)
    expect(await contentDigest(root)).toBe(first)
    await writeFile(join(root, 'lib/lean/library/Init.olean'), 'tampered\n')
    expect(await contentDigest(root)).not.toBe(first)
  })
})

async function installation() {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'lean digest ')); roots.push(base)
  const root = join(base, 'lean-4.35.0')
  await cp(join(fixtureDir, 'fake-lean'), root, { recursive: true })
  return { base, root }
}

describe('legacy TLC contract untouched', () => {
  it('still parses a TLC manifest through the unchanged TLC module', () => {
    const tlc = { schemaVersion: 1, modelId: 'test', module: 'Model', cases: [{ id: 'small', coverage: 'core', specification: 'Spec', constants: {}, invariants: ['TypeOK'], properties: [], limits: { timeoutMs: 1000, heapMiB: 256 } }] }
    expect(parseManifest(JSON.stringify(tlc)).modelId).toBe('test')
  })
})
