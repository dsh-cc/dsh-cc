import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile, link } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeLeanCheck, exitCode } from '../skills/formal-design/scripts/lean-check.mjs'
import { leanPreflight } from '../skills/formal-design/scripts/lean-preflight.mjs'
import { leanChildEnvironment } from '../skills/formal-design/scripts/lean-process.lib.mjs'
import { contentDigest, loadToolchain } from '../skills/formal-design/scripts/lean-fingerprint.lib.mjs'
import { ALLOWED_AXIOMS } from '../skills/formal-design/scripts/lean-manifest.lib.mjs'

// Real pinned-toolchain integration tests (design section 14). They run against
// an already provisioned installation: FORMAL_DESIGN_LEAN_ROOT, or a test root
// built from the locally installed pinned toolchain. FORMAL_DESIGN_LEAN_CI=1
// turns a missing toolchain into a failure instead of a skip.
const SKILL = join(import.meta.dirname, '../skills/formal-design')
const FIXTURES = join(import.meta.dirname, 'fixtures/formal-design-lean')
const MODEL = 'specs/lean/budget-reservation'
const MODEL_ID = 'budget-reservation'
const LOCAL_TOOLCHAIN = '/Users/bytedance/.elan/toolchains/leanprover--lean4---v4.35.0'
const REQUIRED_IN_CI = process.env.FORMAL_DESIGN_LEAN_CI === '1'
const PROVIDED_ROOT = process.env.FORMAL_DESIGN_LEAN_ROOT
const DISCOVERED = PROVIDED_ROOT ?? (existsSync(join(LOCAL_TOOLCHAIN, 'bin/lean')) ? LOCAL_TOOLCHAIN : null)
const suite = DISCOVERED || REQUIRED_IN_CI ? describe : describe.skip

const roots: string[] = []
let leanRoot: string | null = null

// Hard links (or copies) of exactly the directories the installation content
// digest enumerates, so the tree can be hashed and the binary still runs. Never
// committed: the test root lives in the platform temporary directory.
async function linkTree(source: string, target: string) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isSymbolicLink()) { await symlink(await readlink(from), to); continue }
    if (entry.isDirectory()) { await linkTree(from, to); continue }
    try { await link(from, to) } catch { await cp(from, to) }
  }
}

async function provisionTestRoot(scratch: string) {
  const destination = join(scratch, 'lean-4.35.0')
  for (const name of ['bin', 'lib']) await linkTree(join(LOCAL_TOOLCHAIN, name), join(destination, name))
  const pin = await loadToolchain()
  const platform = process.platform === 'linux' ? 'linux-x64' : 'darwin-arm64'
  await writeFile(`${destination}.receipt.json`, JSON.stringify({
    schemaVersion: 1, toolchain: pin.toolchain, archiveSha256: pin.platforms[platform].sha256, contentDigest: await contentDigest(destination),
  }))
  return destination
}

beforeAll(async () => {
  const scratch = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean integration '))
  roots.push(scratch)
  if (PROVIDED_ROOT) leanRoot = await realpath(PROVIDED_ROOT)
  else if (DISCOVERED) leanRoot = await provisionTestRoot(scratch)
  if (!leanRoot) throw new Error('FORMAL_DESIGN_LEAN_CI=1 requires a provisioned Lean installation')
}, 300_000)

afterAll(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function project(control?: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean model ')); roots.push(root)
  await cp(join(FIXTURES, 'project/specs'), join(root, 'specs'), { recursive: true })
  if (control) await cp(join(FIXTURES, 'controls', control), join(root, MODEL), { recursive: true })
  return root
}

// The installation content digest is slice-1 contract territory and costs a full
// re-hash of the toolchain on every preflight; memoize it per root here so the
// integration tests spend their time on real compilation.
const digests = new Map<string, string>()
const memoDigest = async (path: string) => {
  if (!digests.has(path)) digests.set(path, await contentDigest(path))
  return digests.get(path)!
}
const preflight = (options: any, deps: any) => leanPreflight(options, { ...deps, digest: memoDigest })

const check = (root: string) => executeLeanCheck(
  { project: root, model: MODEL, 'lean-root': leanRoot! },
  { preflight, diagnostic: () => {} },
)

const evidence = async (root: string) => JSON.parse(await readFile(join(root, MODEL, 'evidence.json'), 'utf8'))

suite('lean proof execution with the pinned toolchain', () => {
  it('verifies the worked example end to end and publishes fresh evidence', async () => {
    expect(exitCode('verified')).toBe(0)
    expect(exitCode('rejected')).toBe(1)
    expect(exitCode('blocked')).toBe(2)
    expect(exitCode('incomplete')).toBe(3)
    const root = await project()
    const result = await check(root)
    expect(result.reason).toBe(null)
    expect(result.status).toBe('verified')
    expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.properties.map((property: any) => property.verdict)).toEqual(['verified', 'verified'])

    const published = await evidence(root)
    expect(published.proofVerdict).toBe('verified')
    expect(published.toolchain.version).toBe('4.35.0')
    expect(published.phases.map((phase: any) => phase.id)).toEqual(['compile-model', 'compile-properties', 'compile-reference', 'compile-inspector', 'driver', 'inspector'])
    for (const phase of published.phases) {
      expect(phase.exitCode).toBe(0)
      expect(phase.signal).toBe(null)
      expect(phase.report === null || typeof phase.report.sha256 === 'string').toBe(true)
    }
    // The inspector's exact proposition and the granted axioms are recorded.
    for (const property of published.properties) {
      expect(property.kind).toBe('theorem')
      expect(property.typesMatch).toBe(true)
      expect(property.statementType).toBe(property.theoremType)
      expect(property.axioms.length).toBeGreaterThan(0)
      expect(property.axioms.every((axiom: string) => ALLOWED_AXIOMS.includes(axiom))).toBe(true)
      expect(property.verdict).toBe('verified')
    }
    const pointer = JSON.parse(await readFile(join(root, MODEL, 'current-run.json'), 'utf8'))
    expect(pointer.runId).toBe(published.runId)
    expect(pointer.evidenceSha256).toBe(result.evidenceSha256)
    // Every recorded stream artifact exists at its project-relative path.
    for (const phase of published.phases) {
      for (const stream of ['stdout', 'stderr']) {
        const path = join(root, phase[stream].path)
        expect((await stat(path)).size).toBe(phase[stream].bytes)
      }
    }
  }, 600_000)

  it('rejects every negative control for its own mechanism without widening the allowlist', async () => {
    const root = await project('rejected')
    const result = await check(root)
    expect(result.status).toBe('rejected')
    const published = await evidence(root)
    expect(published.proofVerdict).toBe('rejected')
    const byId = new Map(published.properties.map((property: any) => [property.id, property]))

    const axiomViolations = ['direct-sorry', 'indirect-sorry', 'admitted']
    for (const id of axiomViolations) {
      const property: any = byId.get(id)
      expect(property.verdict).toBe('rejected')
      expect(property.kind).toBe('theorem')
      expect(property.typesMatch).toBe(true)
      // Direct and indirect `sorry`/`admit` all surface `sorryAx` transitively.
      expect(property.axioms).toContain('sorryAx')
    }
    // A custom axiom is rejected, and the allowlist is never extended from the model.
    const custom: any = byId.get('custom-axiom')
    expect(custom.verdict).toBe('rejected')
    expect(custom.axioms).toContain('Formal.cheat')
    expect(custom.axioms.every((axiom: string) => ALLOWED_AXIOMS.includes(axiom))).toBe(false)
    // An unsupported computation axiom introduced by a tactic is rejected too.
    const computation: any = byId.get('computation-axiom')
    expect(computation.verdict).toBe('rejected')
    expect(computation.axioms.some((axiom: string) => axiom.includes('native_decide'))).toBe(true)

    const nonTheorem: any = byId.get('non-theorem')
    expect(nonTheorem.verdict).toBe('rejected')
    expect(nonTheorem.kind).toBe('definition')

    const missing: any = byId.get('missing-declaration')
    expect(missing.verdict).toBe('rejected')
    expect(missing.kind).toBe(null)
    // The statement still elaborates, so its type is computed; everything that
    // depends on the missing declaration is null (design section 8).
    expect(missing.statementType).toContain('Formal.reserve')
    expect(missing.theoremType).toBe(null)
    expect(missing.typesMatch).toBe(null)
    expect(missing.axioms).toBe(null)

    const mismatched: any = byId.get('type-mismatch')
    expect(mismatched.kind).toBe('theorem')
    expect(mismatched.typesMatch).toBe(false)
    expect(mismatched.statementType).not.toBe(mismatched.theoremType)

    const witness: any = byId.get('witness-not-theorem')
    expect(witness.verdict).toBe('rejected')
    expect(witness.typesMatch).toBe(true)
    expect(witness.witness.kind).toBe('definition')
    expect(witness.witness.verdict).toBe('rejected')

    // Only the allowlisted axioms are ever accepted: no rejection is presented as
    // a counterexample and the manifest cannot relax the fixed list.
    expect(JSON.stringify(published)).not.toContain('counterexample')
    expect(published.properties.every((property: any) => property.verdict !== 'verified')).toBe(true)
  }, 600_000)

  it('reports source drift as incomplete instead of a stale verdict', async () => {
    const root = await project()
    const result = await executeLeanCheck({ project: root, model: MODEL, 'lean-root': leanRoot! }, {
      preflight, diagnostic: () => {},
      hooks: { beforeInspector: async () => { await writeFile(join(root, MODEL, 'design.md'), '# changed during the run\n') } },
    })
    expect(result.status).toBe('incomplete')
    expect(result.reason.code).toBe('input-changed')
    expect((await readdir(join(root, MODEL))).sort()).toContain('evidence.json')
    expect((await evidence(root)).proofVerdict).toBe('incomplete')
  }, 600_000)

  it('blocks a concurrent run on the model lock without disturbing the holder', async () => {
    const root = await project()
    const lock = join(root, '.formal-design/locks', `lean-${MODEL_ID}.lock`)
    await mkdir(join(root, '.formal-design/locks'), { recursive: true })
    const held = JSON.stringify({ schemaVersion: 1, pid: process.pid, runId: '11111111-1111-4111-8111-111111111111', startedAt: new Date().toISOString() }) + '\n'
    await writeFile(lock, held)
    const result = await check(root)
    expect(result.status).toBe('blocked')
    expect(result.reason.code).toBe('lock-conflict')
    expect(await readFile(lock, 'utf8')).toBe(held)
    await rm(lock)
  }, 600_000)
})

suite('trusted Lean interpreter driver', () => {
  const run = (argv: string[], cwd: string, input: string) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: leanChildEnvironment(cwd, { PATH: process.env.PATH }), shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })

  async function workspace() {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean driver ')); roots.push(root)
    for (const name of ['Model.lean', 'Properties.lean', 'Reference.lean']) await cp(join(FIXTURES, 'project/specs/lean/budget-reservation', name), join(root, name))
    await cp(join(SKILL, 'lean/Driver.lean'), join(root, 'Driver.lean'))
    const lean = join(leanRoot!, 'bin/lean')
    const flags = ['-DmaxHeartbeats=2000000', '-DmaxRecDepth=2048', '-D', 'Elab.async=false']
    for (const [module, source] of [['Model', 'Model.lean'], ['Reference', 'Reference.lean']]) {
      const built = await run([lean, ...flags, '-o', `${module}.olean`, source], root, '')
      expect(built.code).toBe(0)
    }
    return { root, lean, flags }
  }

  it('answers one JSON line per input, in order, with ok and error results', async () => {
    const { root, lean, flags } = await workspace()
    const lines = [
      { id: 'exhaustion', input: [10, 3, 7] },
      { id: 'zero', input: [10, 3, 0] },
      { id: 'insufficient', input: [10, 8, 3] },
      { id: 'invalid-state', input: [5, 8, 3] },
      { id: 'malformed', input: ['ten', 3, 0] },
    ]
    const result = await run([lean, ...flags, '--run', 'Driver.lean'], root, lines.map(line => JSON.stringify(line)).join('\n') + '\n')
    expect(result.code).toBe(0)
    const answers = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line))
    expect(answers.map((answer: any) => answer.id)).toEqual(['exhaustion', 'zero', 'insufficient', 'invalid-state', 'malformed'])
    for (const answer of answers) expect(Object.keys(answer).sort()).toEqual(['id', 'result'])
    expect(answers[0].result).toEqual({ ok: '10' })
    expect(answers[1].result).toEqual({ ok: '3' })
    expect(answers[2].result).toEqual({ error: { code: 'insufficient-budget' } })
    expect(answers[3].result).toEqual({ error: { code: 'invalid-state' } })
    // Every error result carries exactly one grammar-valid code.
    for (const answer of answers.slice(2)) {
      expect(Object.keys(answer.result)).toEqual(['error'])
      expect(Object.keys(answer.result.error)).toEqual(['code'])
      expect(answer.result.error.code).toMatch(/^[a-z][a-z0-9-]{0,63}$/)
    }
  }, 600_000)

  it('fails the protocol on a malformed line instead of fabricating a result', async () => {
    const { root, lean, flags } = await workspace()
    const result = await run([lean, ...flags, '--run', 'Driver.lean'], root, '{"id":"a","input":[10,3,0]}\n{"id":7,"input":{}}\n')
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('protocol error')
  }, 600_000)
})
