import { cp, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeLeanCheck } from '../skills/formal-design/scripts/lean-check.mjs'
import { executeLeanConformance, exitCode } from '../skills/formal-design/scripts/lean-check-conformance.mjs'
import { auditLeanEvidence } from '../skills/formal-design/scripts/lean-check-evidence.mjs'
import { leanPreflight } from '../skills/formal-design/scripts/lean-preflight.mjs'
import { contentDigest } from '../skills/formal-design/scripts/lean-fingerprint.lib.mjs'
import { REQUIRED_IN_CI, TOOLCHAIN_AVAILABLE, resolveLeanRoot } from './helpers/lean-root'
import { MODEL, fixtureProject } from './helpers/lean-project'

// Real-tool acceptance (design sections 7, 8 and 14): proof, conformance and both
// audit stages against the committed fixture model, its real bound
// implementation, and the known-bad implementation mutant.
const suite = TOOLCHAIN_AVAILABLE || REQUIRED_IN_CI ? describe : describe.skip
const roots: string[] = []
let leanRoot: string | null = null
let template: string | null = null

beforeAll(async () => {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean conformance '))
  roots.push(scratch)
  leanRoot = await resolveLeanRoot(scratch)
  if (!leanRoot) throw new Error('FORMAL_DESIGN_LEAN_CI=1 requires a provisioned Lean installation')
}, 300_000)

afterAll(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

// The installation content digest costs a full re-hash of the toolchain on every
// preflight; memoize it per root so these tests spend their time on Lean.
const digests = new Map<string, string>()
const memoDigest = async (path: string) => {
  if (!digests.has(path)) digests.set(path, await contentDigest(path))
  return digests.get(path)!
}
const preflight = (options: any, deps: any) => leanPreflight(options, { ...deps, digest: memoDigest })
const options = (root: string) => ({ project: root, model: MODEL, 'lean-root': leanRoot! })
const proof = (root: string) => executeLeanCheck(options(root), { preflight, diagnostic: () => {} })
const conformance = (root: string) => executeLeanConformance(options(root), { preflight, diagnostic: () => {} })
const audit = (root: string, stage: string) => auditLeanEvidence({ project: root, model: MODEL, stage })

async function newProject({ mutant = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), mutant ? 'formal design lean mutant ' : 'formal design lean model '))
  roots.push(root)
  return fixtureProject(root, { mutant })
}

/** An exact copy of an already-run project (artifacts included). */
async function copyOf(source: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean copy '))
  roots.push(root)
  await rm(root, { recursive: true, force: true })
  await cp(source, root, { recursive: true })
  return root
}

const evidenceOf = async (root: string) => JSON.parse(await readFile(join(root, MODEL, 'conformance-evidence.json'), 'utf8'))

suite('Lean conformance and acceptance with the pinned toolchain', () => {
  it('runs proof, conformance and both audit stages to acceptanceReady', async () => {
    const root = await newProject()
    expect(exitCode('passed')).toBe(0)
    expect(exitCode('failed')).toBe(1)
    expect(exitCode('blocked')).toBe(2)
    expect(exitCode('incomplete')).toBe(3)

    const proofResult = await proof(root)
    expect(proofResult.status).toBe('verified')
    const proofEvidence = JSON.parse(await readFile(join(root, MODEL, 'evidence.json'), 'utf8'))

    const result = await conformance(root)
    expect(result.status).toBe('passed')
    expect(result.reason).toBe(null)
    expect(result.caseCount).toBe(8)
    expect(result.matchedCount).toBe(8)
    expect(result.proofRunId).toBe(proofEvidence.runId)

    const published = await evidenceOf(root)
    expect(published.conformanceVerdict).toBe('passed')
    expect(published.proofRunId).toBe(proofEvidence.runId)
    expect(published.proofInputDigest).toBe(proofEvidence.inputDigest)
    expect(published.firstMismatch).toBe(null)
    expect(published.phases.map((phase: any) => phase.id)).toEqual(['compile-model', 'compile-reference', 'driver', 'adapter', 'compare'])
    for (const phase of published.phases) {
      expect(phase.exitCode).toBe(0)
      expect(phase.signal).toBe(null)
    }
    // The execution closure enumerates the corpus, the adapter, the bound
    // implementation and the declared execution file.
    expect(published.executionFiles.map((entry: any) => entry.path)).toEqual([
      'package.json',
      'packages/example/src/budget.ts',
      'specs/lean/budget-reservation/conformance/adapter.mjs',
      'specs/lean/budget-reservation/conformance/cases.jsonl',
    ])

    // The reference and the implementation agree on every recorded case,
    // including the canonical-decimal boundary values.
    const compare = published.phases.find((phase: any) => phase.id === 'compare')
    const report = JSON.parse(await readFile(join(root, compare.report.path), 'utf8'))
    expect(report.cases.map((entry: any) => entry.id)).toEqual([
      'boundary-exhaustion', 'zero-request', 'above-safe-integer', 'excess-by-one',
      'invalid-prior-state', 'malformed-amount', 'negative-amount', 'malformed-shape',
    ])
    const byId = new Map(report.cases.map((entry: any) => [entry.id, entry]))
    expect(byId.get('boundary-exhaustion')).toEqual({ id: 'boundary-exhaustion', referenceResult: { ok: '10' }, implementationResult: { ok: '10' }, matched: true })
    expect(byId.get('zero-request')).toMatchObject({ referenceResult: { ok: '3' }, matched: true })
    expect(byId.get('above-safe-integer')).toMatchObject({ referenceResult: { ok: '9007199254740993' }, matched: true })
    expect(byId.get('excess-by-one')).toMatchObject({ referenceResult: { error: { code: 'insufficient-budget' } }, matched: true })
    expect(byId.get('invalid-prior-state')).toMatchObject({ referenceResult: { error: { code: 'invalid-state' } }, matched: true })
    for (const id of ['malformed-amount', 'negative-amount', 'malformed-shape']) {
      expect(byId.get(id)).toMatchObject({ referenceResult: { error: { code: 'invalid-amount' } }, matched: true })
    }

    const proofAudit = await audit(root, 'proof')
    expect(proofAudit.status).toBe('valid')
    expect(proofAudit.proofVerdict).toBe('verified')
    expect(proofAudit.acceptanceReady).toBe(null)

    const acceptance = await audit(root, 'acceptance')
    expect(acceptance.status).toBe('valid')
    expect(acceptance.acceptanceReady).toBe(true)
    expect(acceptance.conformanceVerdict).toBe('passed')
    template = root
  }, 900_000)

  it('fails the known-bad implementation mutant on the recorded case ID', async () => {
    const root = await newProject({ mutant: true })
    expect((await proof(root)).status).toBe('verified')
    const result = await conformance(root)
    expect(result.status).toBe('failed')
    expect(result.matchedCount).toBe(7)
    expect(result.firstMismatch.id).toBe('invalid-prior-state')
    expect(result.firstMismatch.referenceResult).toEqual({ error: { code: 'invalid-state' } })
    expect(result.firstMismatch.implementationResult).toEqual({ error: { code: 'insufficient-budget' } })

    const published = await evidenceOf(root)
    expect(published.conformanceVerdict).toBe('failed')
    expect(published.firstMismatch.id).toBe('invalid-prior-state')
    // The proof is untouched and fresh; only acceptance is refused.
    expect((await audit(root, 'proof')).status).toBe('valid')
    const acceptance = await audit(root, 'acceptance')
    expect(acceptance.status).toBe('invalid')
    expect(acceptance.acceptanceReady).toBe(false)
    expect(acceptance.reason).toBe('conformance-not-passed')
  }, 900_000)

  it('blocks conformance when the proof inputs are stale', async () => {
    const root = await newProject()
    expect((await proof(root)).status).toBe('verified')
    await writeFile(join(root, MODEL, 'design.md'), '# changed after the proof run\n')
    const result = await conformance(root)
    expect(result.status).toBe('blocked')
    expect(result.reason.code).toBe('input-changed')
    expect(result.reason.detail.message).toContain('missing proof prerequisites')
  }, 900_000)

  it('stales conformance when a bound implementation file changes', async () => {
    const copy = await copyOf(template!)
    await writeFile(join(copy, 'packages/example/src/budget.ts'), `${await readFile(join(copy, 'packages/example/src/budget.ts'), 'utf8')}\n// changed\n`)
    const acceptance = await audit(copy, 'acceptance')
    expect(acceptance.status).toBe('invalid')
    expect(acceptance.acceptanceReady).toBe(false)
    expect(acceptance.reason).toBe('stale/execution')
  }, 300_000)

  it('invalidates the conformance binding when a new proof run lands', async () => {
    const copy = await copyOf(template!)
    // A fresh, independent proof run: same inputs, new run ID.
    expect((await proof(copy)).status).toBe('verified')
    expect((await audit(copy, 'proof')).status).toBe('valid')
    const acceptance = await audit(copy, 'acceptance')
    expect(acceptance.status).toBe('invalid')
    expect(acceptance.acceptanceReady).toBe(false)
    expect(acceptance.reason).toBe('binding-invalid')
  }, 900_000)
})
