import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bridgeMarkdownFor, cfgDeclares, derivedInvariant, loadBridge, moduleDeclares, validateBridgeContract,
} from '../skills/formal-design/scripts/bridge.lib.mjs'
import { executeCheck } from '../skills/formal-design/scripts/check.lib.mjs'
import { auditEvidence } from '../skills/formal-design/scripts/evidence.lib.mjs'
import { preflight as tlcPreflight } from '../skills/formal-design/scripts/preflight.lib.mjs'
import { executeLeanCheck } from '../skills/formal-design/scripts/lean-check.mjs'
import { executeLeanConformance } from '../skills/formal-design/scripts/lean-check-conformance.mjs'
import { leanPreflight } from '../skills/formal-design/scripts/lean-preflight.mjs'
import { contentDigest, hashFile } from '../skills/formal-design/scripts/lean-fingerprint.lib.mjs'
import { parseCorpus } from '../skills/formal-design/scripts/lean-conformance.lib.mjs'
import { parseLeanManifest } from '../skills/formal-design/scripts/lean-manifest.lib.mjs'
import { auditCombined } from '../skills/formal-design/scripts/check-combined-evidence.mjs'
import { REQUIRED_IN_CI, TOOLCHAIN_AVAILABLE, resolveLeanRoot } from './helpers/lean-root'
import { fixtureProject, MODEL as LEAN_MODEL } from './helpers/lean-project'

// Combined TLA+/Lean bridge contract (design section 10) and the opt-in
// version-two evidence both backends add without changing version one.
const FIXTURES = join(import.meta.dirname, 'fixtures/formal-design-bridge')
const BRIDGE = 'specs/formal/budget-guard/bridge.json'
const TLA_MODEL = 'specs/tla/budget-guard'
const bundledJar = resolve(import.meta.dirname, '../skills/formal-design/toolchain/tla2tools.jar')
const jar = process.env.TLA2TOOLS_JAR || bundledJar
const tlcSuite = describe.skipIf(!jar)
const TOOLS = (TOOLCHAIN_AVAILABLE || REQUIRED_IN_CI) && Boolean(jar)
const combinedSuite = TOOLS ? describe : describe.skip

const roots: string[] = []
let leanRoot: string | null = null
const digests = new Map<string, string>()
const memoDigest = async (path: string) => {
  if (!digests.has(path)) digests.set(path, await contentDigest(path))
  return digests.get(path)!
}
const preflight = (options: any, deps: any) => leanPreflight(options, { ...deps, digest: memoDigest })
afterAll(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function scratch(label: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), `${label} `))
  roots.push(root)
  return root
}
// A project with the committed Lean fixture model, its implementation, and the
// bridge/TLA fixtures.
async function project() {
  const root = await scratch('formal design bridge')
  await fixtureProject(root)
  await cp(join(FIXTURES, 'project/specs'), join(root, 'specs'), { recursive: true })
  return root
}
const bridgeFile = (root: string) => join(root, BRIDGE)
const readBridge = async (root: string) => JSON.parse(await readFile(bridgeFile(root), 'utf8'))
const writeBridge = async (root: string, value: any) => writeFile(bridgeFile(root), JSON.stringify(value, null, 2) + '\n')
const casesFile = (root: string) => join(root, 'specs/formal/budget-guard/cases.json')
const readCases = async (root: string) => JSON.parse(await readFile(casesFile(root), 'utf8'))
const writeCases = async (root: string, value: any) => writeFile(casesFile(root), JSON.stringify(value, null, 2) + '\n')
async function contract(root: string) {
  const loaded = await loadBridge(root, BRIDGE)
  const manifest = parseLeanManifest(await readFile(join(root, LEAN_MODEL, 'checks.json'), 'utf8'))
  const corpus = parseCorpus(await readFile(join(root, LEAN_MODEL, 'conformance/cases.jsonl'), 'utf8'), manifest)
  return { loaded, manifest, corpus }
}
const rejected = async (promise: () => Promise<unknown>, pattern: RegExp, code = 'config-invalid') => {
  await expect(promise()).rejects.toMatchObject({ code })
  await expect(promise()).rejects.toThrow(pattern)
}

describe('strict bridge schema and cases files', () => {
  it('accepts the committed fixture and enumerates bridge.json, bridge.md and the cases file', async () => {
    const root = await project()
    const { loaded, manifest, corpus } = await contract(root)
    expect(loaded.entries.map(entry => entry.path)).toEqual([
      'specs/formal/budget-guard/bridge.json', 'specs/formal/budget-guard/bridge.md', 'specs/formal/budget-guard/cases.json',
    ])
    for (const entry of loaded.entries) expect(entry.sha256).toBe(await hashFile(join(root, entry.path)))
    const { rows } = await validateBridgeContract(root, loaded, { manifest, corpus })
    expect(rows.map(row => row.id)).toEqual(['boundary-exhaustion', 'zero-request', 'excess-by-one'])
    expect(bridgeMarkdownFor(BRIDGE)).toBe('specs/formal/budget-guard/bridge.md')
    expect(derivedInvariant('excess-by-one')).toBe('Bridge_excess_by_one')
  })

  it('rejects unknown fields, duplicate operation ids and an operation field set mismatch', async () => {
    const root = await project()
    const bridge = await readBridge(root)
    await writeBridge(root, { ...bridge, extra: 1 })
    await rejected(() => loadBridge(root, BRIDGE), /bridge fields must be exactly/)
    await writeBridge(root, bridge)
    await writeBridge(root, { ...bridge, operations: [...bridge.operations, bridge.operations[0]] })
    await rejected(() => loadBridge(root, BRIDGE), /operation id invalid or duplicate/)
    await writeBridge(root, bridge)
    const [first, ...rest] = bridge.operations
    await writeBridge(root, { ...bridge, operations: [{ ...first, note: 'x' }, ...rest] })
    await rejected(() => loadBridge(root, BRIDGE), /bridge operation fields must be exactly/)
  })

  it('rejects propertyIds that do not equal the corpus covers set or name an undeclared property', async () => {
    const root = await project()
    const branch = await readBridge(root)
    const mutate = (propertyIds: string[]) => writeBridge(root, { ...branch, operations: branch.operations.map((row: any) => row.id === 'boundary-exhaustion' ? { ...row, propertyIds } : row) })
    await mutate(['zero-request'])
    let current = await contract(root)
    await rejected(() => validateBridgeContract(root, current.loaded, current), /propertyIds must equal the corpus case covers set/)
    await mutate(['not-declared'])
    current = await contract(root)
    await rejected(() => validateBridgeContract(root, current.loaded, current), /undeclared property/)
  })

  it('rejects implementationFiles outside the Lean manifest closure', async () => {
    const root = await project()
    const bridge = await readBridge(root)
    await writeBridge(root, { ...bridge, operations: bridge.operations.map((row: any) => ({ ...row, implementationFiles: ['packages/example/src/other.ts'] })) })
    const current = await contract(root)
    await rejected(() => validateBridgeContract(root, current.loaded, current), /outside the Lean implementation closure/)
  })

  it('rejects cases-file ID join mismatches, canonical input inequality and a bad expected shape', async () => {
    const root = await project()
    const cases = await readCases(root)
    const run = async () => { const current = await contract(root); return validateBridgeContract(root, current.loaded, current) }
    await writeCases(root, [{ ...cases[0], id: 'not-a-corpus-case' }, ...cases.slice(1)])
    await rejected(run, /id must equal a committed Lean corpus case id/)
    await writeCases(root, [{ ...cases[0], input: { budget: '11', reserved: '3', amount: '7' } }, ...cases.slice(1)])
    await rejected(run, /input is not canonically equal/)
    await writeCases(root, [{ ...cases[0], expected: { ok: '10', note: 'x' } }, ...cases.slice(1)])
    await rejected(run, /expected must be exactly/)
    await writeCases(root, [{ ...cases[0], expected: { error: { code: 'Bad_Code' } } }, ...cases.slice(1)])
    await rejected(run, /expected error code must match/)
    await writeCases(root, [{ ...cases[0], tlaExpression: '' }, ...cases.slice(1)])
    await rejected(run, /tlaExpression must be authored source text/)
    await writeCases(root, [...cases, cases[0]])
    await rejected(run, /duplicate bridge case id/)
  })

  it('rejects a missing bridge.md, a missing cases file and a case file over 1 MiB', async () => {
    const root = await project()
    await rm(join(root, 'specs/formal/budget-guard/bridge.md'))
    await rejected(() => loadBridge(root, BRIDGE), /bridge input is missing/, 'missing-input')
    await cp(join(FIXTURES, 'project/specs/formal/budget-guard/bridge.md'), join(root, 'specs/formal/budget-guard/bridge.md'))
    const cases = await readCases(root)
    await rm(casesFile(root))
    await rejected(() => loadBridge(root, BRIDGE), /bridge input is missing/, 'missing-input')
    await writeFile(casesFile(root), JSON.stringify(cases) + ' '.repeat(1024 * 1024))
    await rejected(() => loadBridge(root, BRIDGE), /case file exceeds 1 MiB/)
  })

  it('matches a cfg identifier as a complete token, never a substring', () => {
    expect(cfgDeclares('INVARIANT TypeOK\nINVARIANT Bridge_a\n', 'Bridge_a')).toBe(true)
    expect(cfgDeclares('INVARIANT Bridge_a_b\n', 'Bridge_a')).toBe(false)
    expect(cfgDeclares('INVARIANT Bridge_a_b\n', 'Bridge_a_b')).toBe(true)
    expect(cfgDeclares('INVARIANT XBridge_a\n', 'Bridge_a')).toBe(false)
    expect(moduleDeclares('Bridge_a_b == TRUE', 'Bridge_a')).toBe(false)
    expect(moduleDeclares('Bridge_a == TRUE', 'Bridge_a')).toBe(true)
  })

  it('forbids --bridge with a nonmatching Lean model', async () => {
    const root = await project()
    await cp(join(root, LEAN_MODEL), join(root, 'specs/lean/other'), { recursive: true })
    const ready = await leanPreflight({ project: root, model: 'specs/lean/other', bridge: BRIDGE })
    expect(ready.output.status).toBe('blocked')
    expect(ready.output.reason).toBe('config-invalid')
  })

  it('rejects an incomplete project instead of accepting missing backend evidence', async () => {
    const root = await project()
    await expect(auditCombined(root, BRIDGE)).rejects.toMatchObject({ code: 'tlc-evidence-invalid' })
  })
})

// ---------------------------------------------------------------------------
// Opt-in TLC version-two evidence.
// ---------------------------------------------------------------------------
const V1_TLC_KEYS = ['schemaVersion', 'runId', 'modelId', 'inputDigest', 'inputFiles', 'runnerDigest', 'runnerPackage', 'toolchainVersion', 'toolchainDigest', 'jarSha256', 'jarPath', 'javaVersion', 'javaExecutable', 'platform', 'startedAt', 'finishedAt', 'status', 'reason', 'warnings', 'cases']
const V1_LEAN_KEYS = ['schemaVersion', 'backend', 'modelId', 'runId', 'inputFiles', 'inputDigest', 'runnerFiles', 'runnerDigest', 'runnerPackage', 'toolchain', 'proofVerdict', 'reason', 'properties', 'phases', 'startedAt', 'finishedAt']
const V1_CONFORMANCE_KEYS = ['schemaVersion', 'backend', 'modelId', 'runId', 'proofRunId', 'proofInputDigest', 'executionFiles', 'executionDigest', 'runnerDigest', 'toolchain', 'conformanceVerdict', 'reason', 'caseCount', 'matchedCount', 'firstMismatch', 'phases', 'startedAt', 'finishedAt']
const tlcEvidence = async (root: string) => JSON.parse(await readFile(join(root, TLA_MODEL, 'evidence.json'), 'utf8'))

tlcSuite('TLC opt-in bridge evidence (schema two)', () => {
  it('keeps version-one shape without --bridge and adds exactly bridgeFiles with it', async () => {
    const root = await project()
    const options = { project: root, model: TLA_MODEL, jar, java: 'java' }
    const plain = await executeCheck(options)
    expect(plain.status, JSON.stringify(plain)).toBe('verified')
    expect(Object.keys(await tlcEvidence(root)).sort()).toEqual([...V1_TLC_KEYS].sort())
    expect((await auditEvidence({ project: root, model: TLA_MODEL })).status).toBe('valid')
    // A bridge flag against version-one evidence is a version mismatch.
    expect((await auditEvidence({ project: root, model: TLA_MODEL, bridge: BRIDGE })).status).toBe('invalid')

    const bridged = await executeCheck({ ...options, bridge: BRIDGE })
    expect(bridged.status, JSON.stringify(bridged)).toBe('verified')
    const evidence = await tlcEvidence(root)
    expect(Object.keys(evidence).sort()).toEqual([...V1_TLC_KEYS, 'bridgeFiles'].sort())
    expect(evidence.bridgeFiles).toEqual((await contract(root)).loaded.entries)
    expect((await auditEvidence({ project: root, model: TLA_MODEL })).status).toBe('valid')
    expect((await auditEvidence({ project: root, model: TLA_MODEL, bridge: BRIDGE })).status).toBe('valid')
    // A changed bridge file stales the recorded package.
    await writeFile(join(root, 'specs/formal/budget-guard/bridge.md'), 'changed\n')
    expect((await auditEvidence({ project: root, model: TLA_MODEL })).reason).toBe('stale/input')
  }, 60000)

  it('forbids --bridge with a nonmatching TLA model', async () => {
    const root = await project()
    await cp(join(root, TLA_MODEL), join(root, 'specs/tla/other'), { recursive: true })
    const ready = await tlcPreflight({ project: root, model: 'specs/tla/other', bridge: BRIDGE, jar, java: 'java' }, { probe: async () => ({ version: '17' }) })
    expect(ready.output.status).toBe('blocked')
    expect(ready.output.reason).toBe('config-invalid')
  })
})

// ---------------------------------------------------------------------------
// Combined TLA+/Lean acceptance with real tools.
// ---------------------------------------------------------------------------
combinedSuite('combined bridge acceptance with real tools', () => {
  beforeAll(async () => {
    const seed = await scratch('formal design bridge lean root')
    leanRoot = await resolveLeanRoot(seed)
    if (!leanRoot) throw new Error('FORMAL_DESIGN_LEAN_CI=1 requires a provisioned Lean installation')
  }, 300_000)

  it('produces both version-two packages and accepts them together', async () => {
    const root = await project()
    const tlc = await executeCheck({ project: root, model: TLA_MODEL, jar, java: 'java', bridge: BRIDGE })
    expect(tlc.status, JSON.stringify(tlc)).toBe('verified')

    const leanOptions = { project: root, model: LEAN_MODEL, 'lean-root': leanRoot!, bridge: BRIDGE }
    const proof = await executeLeanCheck(leanOptions, { preflight, diagnostic: () => {} })
    expect(proof.status, JSON.stringify(proof)).toBe('verified')
    const conformance = await executeLeanConformance(leanOptions, { preflight, diagnostic: () => {} })
    expect(conformance.status, JSON.stringify(conformance)).toBe('passed')

    const proofEvidence = JSON.parse(await readFile(join(root, LEAN_MODEL, 'evidence.json'), 'utf8'))
    expect(Object.keys(proofEvidence).sort()).toEqual([...V1_LEAN_KEYS, 'bridgeFiles'].sort())
    const conformanceEvidence = JSON.parse(await readFile(join(root, LEAN_MODEL, 'conformance-evidence.json'), 'utf8'))
    expect(Object.keys(conformanceEvidence).sort()).toEqual([...V1_CONFORMANCE_KEYS, 'bridgeFiles'].sort())

    const result = await auditCombined(root, BRIDGE)
    expect(result).toMatchObject({ status: 'valid', acceptanceReady: true, bridge: 'budget-guard' })

    // A changed bridge package stales both evidence packages.
    await writeFile(join(root, 'specs/formal/budget-guard/bridge.md'), 'changed\n')
    await expect(auditCombined(root, BRIDGE)).rejects.toMatchObject({ code: 'tlc-evidence-invalid' })
  }, 900_000)

  it('keeps Lean version-one evidence without --bridge and blocks mixed versions', async () => {
    const root = await project()
    const base = { project: root, model: LEAN_MODEL, 'lean-root': leanRoot! }
    const proof = await executeLeanCheck(base, { preflight, diagnostic: () => {} })
    expect(proof.status, JSON.stringify(proof)).toBe('verified')
    expect(Object.keys(JSON.parse(await readFile(join(root, LEAN_MODEL, 'evidence.json'), 'utf8'))).sort()).toEqual([...V1_LEAN_KEYS].sort())
    // Conformance cannot silently audit a bridged model against version one.
    const conformance = await executeLeanConformance({ ...base, bridge: BRIDGE }, { preflight, diagnostic: () => {} })
    expect(conformance.status).toBe('blocked')
    expect((conformance.reason as any).code).toBe('config-invalid')
  }, 900_000)
})
