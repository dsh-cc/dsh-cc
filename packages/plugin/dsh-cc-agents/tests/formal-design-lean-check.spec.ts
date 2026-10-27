import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeLeanCheck, main } from '../skills/formal-design/scripts/lean-check.mjs'
import { runLeanPhase, leanChildEnvironment } from '../skills/formal-design/scripts/lean-process.lib.mjs'
import {
  EMPTY_SHA256, PHASES, acquireLock, lockPathFor, publishProof, releaseLock, runnerDigest, validateProofEvidence,
} from '../skills/formal-design/scripts/lean-evidence.lib.mjs'
import { sha256 } from '../skills/formal-design/scripts/lean-fingerprint.lib.mjs'
import { loadToolchain } from '../skills/formal-design/scripts/lean-fingerprint.lib.mjs'
import { parseLeanManifest } from '../skills/formal-design/scripts/lean-manifest.lib.mjs'

const fixtureDir = join(import.meta.dirname, 'fixtures/formal-design-lean')
const MODEL = 'specs/lean/budget-reservation'
const MODEL_ID = 'budget-reservation'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function project() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean check ')); roots.push(root)
  await cp(join(fixtureDir, 'project/specs'), join(root, 'specs'), { recursive: true })
  return root
}
const modelDir = root => join(root, MODEL)
const toolchain = () => ({ toolchain: 'leanprover/lean4:v4.35.0', platform: 'darwin-arm64', archiveSha256: 'c'.repeat(64), contentDigest: 'd'.repeat(64), version: '4.35.0' })

// A preflight that reports the fixture model ready without touching a real Lean
// installation: the contract tests exercise the runner, not the toolchain.
async function readyPreflight(root, { model = MODEL, modelId = MODEL_ID } = {}) {
  const manifest = parseLeanManifest(await readFile(join(root, model, 'checks.json'), 'utf8'))
  return {
    options: {}, manifest, pin: await loadToolchain(), leanRoot: join(root, 'no-such-lean-root'),
    paths: { root, model: join(root, model), modelRelative: model, modelId, entries: new Set() },
    toolchain: toolchain(), output: { schemaVersion: 1, command: 'lean-preflight', status: 'ready', reason: 'ready', blockers: [] },
  }
}

const propertyIdFor = argv => {
  if (argv.includes('--run')) return 'inspector'
  const source = argv.at(-1).replace(/\.lean$/, '')
  // The trusted driver's compilation is recorded as the `driver` phase.
  if (source === 'Driver') return 'driver'
  return `compile-${source.toLowerCase()}`
}

// Phase identification used by the fake child: the recorded id is derived the
// same way the runner names its directories.
function verifiedReport(manifest) {
  return {
    schemaVersion: 1,
    toolchainVersion: '4.35.0',
    properties: manifest.properties.map(property => ({
      id: property.id,
      declaration: property.declaration,
      kind: 'theorem',
      statementType: 'P',
      theoremType: 'P',
      typesMatch: true,
      axioms: ['propext'],
      witness: property.witnessDeclaration === null ? null : { declaration: property.witnessDeclaration, kind: 'theorem', type: 'W', verdict: 'verified' },
      verdict: 'verified',
    })),
  }
}

/** A fake child that records its invocation and writes both stream artifacts. */
function fakePhases(manifest, overrides = {}) {
  const calls: any[] = []
  const runPhase = async (argv: string[], options: any) => {
    const id = propertyIdFor(argv)
    calls.push({ id, argv })
    await mkdir(options.dir, { recursive: true })
    const stdout = overrides.stdout?.[id] ?? ''
    const stderr = overrides.stderr?.[id] ?? ''
    await writeFile(join(options.dir, 'stdout.log'), stdout)
    await writeFile(join(options.dir, 'stderr.log'), stderr)
    if (id === 'inspector' && overrides.report !== null) {
      const report = overrides.report ?? verifiedReport(manifest)
      if (report !== undefined) await writeFile(join(options.cwd, 'inspector-report.json'), JSON.stringify(report))
    }
    const override = overrides.phases?.[id] ?? {}
    return {
      argv, exitCode: 'exitCode' in override ? override.exitCode : 0, termSignal: override.termSignal ?? null,
      timedOut: override.timedOut ?? false, cancelled: override.cancelled ?? false, overflowed: override.overflowed ?? false,
      spawnFailed: false, interrupted: null, lostOutput: false, elapsedMs: 1,
      stdoutPath: join(options.dir, 'stdout.log'), stderrPath: join(options.dir, 'stderr.log'),
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr),
      stdoutSha256: sha256(Buffer.from(stdout)), stderrSha256: sha256(Buffer.from(stderr)),
    }
  }
  return { runPhase, calls }
}

const runFixture = async (root: string, deps: any, model = MODEL, modelId = MODEL_ID) =>
  executeLeanCheck({ project: root, model, 'lean-root': join(root, 'lean') }, { preflight: () => readyPreflight(root, { model, modelId }), diagnostic: () => {}, ...deps })

const evidenceOf = async (root: string) => JSON.parse(await readFile(join(modelDir(root), 'evidence.json'), 'utf8'))

describe('lean-check phase recording', () => {
  it('records every phase with argv, exit code and both stream artifacts', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase, calls } = fakePhases(manifest)
    const result = await runFixture(root, { runPhase })
    expect(result.status).toBe('verified')
    expect(result.reason).toBe(null)
    expect(calls.map(call => call.id)).toEqual(['compile-model', 'compile-properties', 'compile-reference', 'compile-inspector', 'driver', 'inspector'])
    const evidence = await evidenceOf(root)
    expect(evidence.phases.map(phase => phase.id)).toEqual(['compile-model', 'compile-properties', 'compile-reference', 'compile-inspector', 'driver', 'inspector'])
    for (const phase of evidence.phases) {
      expect(PHASES).toContain(phase.id)
      expect(phase.argv).toEqual(calls.find(call => call.id === phase.id).argv)
      expect(phase.exitCode).toBe(0)
      expect(phase.signal).toBe(null)
      expect(phase.stdout.path).toBe(`.formal-design/lean/${MODEL_ID}/${evidence.runId}/${phase.id}/stdout.log`)
      expect(phase.stderr.bytes).toBe(0)
      expect(phase.stderr.sha256).toBe(EMPTY_SHA256)
    }
    // argv carries the runner-owned options before the input file and --run.
    const inspector = evidence.phases.at(-1)
    expect(inspector.argv.slice(1, 4)).toEqual(['-DmaxHeartbeats=2000000', '-DmaxRecDepth=2048', '-D'])
    expect(inspector.argv.slice(4)).toEqual(['Elab.async=false', '--run', 'Inspector.lean', 'inspector-inputs.json'])
    expect(inspector.report.path.endsWith('/workspace/inspector-report.json')).toBe(true)
    expect(inspector.report.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(evidence.properties.every(property => property.verdict === 'verified')).toBe(true)
    expect(validateProofEvidence(evidence, manifest)).toBe(evidence)
  })

  it('records the inspector report as a hashed phase artifact and publishes a pointer', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const result = await runFixture(root, fakePhases(manifest))
    const evidence = await evidenceOf(root)
    const pointer = JSON.parse(await readFile(join(modelDir(root), 'current-run.json'), 'utf8'))
    expect(Object.keys(pointer).sort()).toEqual(['evidenceSha256', 'inputDigest', 'runId', 'schemaVersion'])
    expect(pointer.runId).toBe(evidence.runId)
    expect(pointer.inputDigest).toBe(evidence.inputDigest)
    expect(pointer.evidenceSha256).toBe(result.evidenceSha256)
    // evidenceSha256 hashes the exact published bytes.
    expect(sha256(await readFile(join(modelDir(root), 'evidence.json')))).toBe(result.evidenceSha256)
    // No temporary publication files survive.
    expect((await readdir(modelDir(root))).filter(name => name.startsWith('.'))).toEqual([])
  })

  it('leaves a silent phase as a hashed empty artifact, never an omitted field', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    await runFixture(root, fakePhases(manifest))
    const evidence = await evidenceOf(root)
    for (const phase of evidence.phases) {
      expect(phase.stdout).toEqual({ path: phase.stdout.path, bytes: 0, sha256: EMPTY_SHA256 })
    }
  })

  it('records warnings without changing a verified verdict', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase } = fakePhases(manifest, { stderr: { 'compile-properties': 'warning: unused variable\n' } })
    const result = await runFixture(root, { runPhase })
    expect(result.status).toBe('verified')
    const evidence = await evidenceOf(root)
    const properties = evidence.phases.find(phase => phase.id === 'compile-properties')
    expect(properties.stderr.bytes).toBeGreaterThan(0)
  })

  it('fails a run whose warnings admit an incomplete proof', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase } = fakePhases(manifest, { stdout: { 'compile-properties': "warning: declaration uses 'sorry'\n" } })
    const result = await runFixture(root, { runPhase })
    expect(result.status).toBe('incomplete')
    expect(result.reason.code).toBe('output-invalid')
    expect(result.reason.detail.message).toContain('incomplete proof')
  })
})

describe('lean-check failure classification', () => {
  it.each([
    ['timeout', { phases: { 'compile-properties': { timedOut: true, exitCode: null } } }, 'incomplete', 'timeout'],
    ['cancellation', { phases: { 'compile-model': { cancelled: true, exitCode: null } } }, 'incomplete', 'cancelled'],
    ['stream overflow', { phases: { 'compile-reference': { overflowed: true, exitCode: null } } }, 'incomplete', 'stream-overflow'],
    ['child signal', { phases: { 'compile-inspector': { termSignal: 'SIGKILL', exitCode: null } } }, 'incomplete', 'signal'],
  ])('classifies %s as %s', async (_label, overrides, verdict, reason) => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase } = fakePhases(manifest, overrides)
    const result = await runFixture(root, { runPhase })
    expect(result.status).toBe(verdict)
    expect(result.reason.code).toBe(reason)
    const evidence = await evidenceOf(root)
    expect(evidence.proofVerdict).toBe(verdict)
    expect(evidence.properties.every(property => property.verdict === 'not-checked')).toBe(true)
  })

  it('treats a Lean error in a compile phase as rejected', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase } = fakePhases(manifest, { phases: { 'compile-properties': { exitCode: 1 } }, stdout: { 'compile-properties': 'Properties.lean:1:1: error: unknown identifier\n' } })
    const result = await runFixture(root, { runPhase })
    expect(result.status).toBe('rejected')
    expect(result.reason.detail.phase).toBe('compile-properties')
    expect((await evidenceOf(root)).properties.every(property => property.verdict === 'not-checked')).toBe(true)
  })

  it('reports a missing inspector report as incomplete', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase } = fakePhases(manifest, { report: null })
    const result = await runFixture(root, { runPhase })
    expect(result.status).toBe('incomplete')
    expect(result.reason.detail.message).toContain('missing')
    expect((await evidenceOf(root)).properties.every(property => property.verdict === 'not-checked')).toBe(true)
  })

  it('reports a truncated inspector report as incomplete, naming the property', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const report = verifiedReport(manifest)
    report.properties[1].verdict = 'not-checked'
    const { runPhase } = fakePhases(manifest, { report })
    const result = await runFixture(root, { runPhase })
    expect(result.status).toBe('incomplete')
    expect(result.reason.code).toBe('output-invalid')
    expect((await evidenceOf(root)).properties[1].verdict).toBe('not-checked')
  })

  it('rejects a run whose properties the inspector rejected', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const report = verifiedReport(manifest)
    report.properties[1] = { ...report.properties[1], axioms: ['sorryAx'], verdict: 'rejected' }
    const { runPhase } = fakePhases(manifest, { report })
    const result = await runFixture(root, { runPhase })
    expect(result.status).toBe('rejected')
    expect(result.reason.detail.properties).toEqual([{ id: manifest.properties[1].id, declaration: manifest.properties[1].declaration }])
    const evidence = await evidenceOf(root)
    expect(evidence.proofVerdict).toBe('rejected')
    // A rejected property is never reported as a counterexample.
    expect(JSON.stringify(evidence)).not.toContain('counterexample')
  })

  it('marks the run incomplete when inputs change during the run', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase } = fakePhases(manifest)
    const result = await runFixture(root, { runPhase, hooks: { beforeInspector: async () => { await writeFile(join(modelDir(root), 'design.md'), 'changed\n') } } })
    expect(result.status).toBe('incomplete')
    expect(result.reason.code).toBe('input-changed')
  })

  it('blocks a concurrent run without touching the other run', async () => {
    const root = await project()
    const lock = lockPathFor(root, MODEL_ID)
    const held = await acquireLock(lock, '11111111-1111-4111-8111-111111111111', new Date().toISOString())
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase, calls } = fakePhases(manifest)
    const result = await runFixture(root, { runPhase })
    expect(result.status).toBe('blocked')
    expect(result.reason.code).toBe('lock-conflict')
    expect(calls).toEqual([])
    expect(await readFile(lock, 'utf8')).toBe(held.bytes)
    await releaseLock(held)
  })
})

describe('lean process lifecycle', () => {
  const scratch = async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean phase ')); roots.push(root)
    return root
  }
  const node = (script: string) => [process.execPath, '-e', script]
  const options = (root: string, extra = {}) => ({ cwd: root, env: {}, dir: join(root, 'phase'), timeoutMs: 30000, ...extra })

  it('caps each stream at the configured limit and terminates the phase', async () => {
    const root = await scratch()
    const result = await runLeanPhase(node('process.stdout.write("x".repeat(200000))'), options(root, { streamLimit: 1000 }))
    expect(result.overflowed).toBe(true)
    expect(result.termSignal === null || typeof result.termSignal === 'string').toBe(true)
    const bytes = (await stat(result.stdoutPath)).size
    expect(bytes).toBeLessThanOrEqual(1000)
    expect(await readFile(result.stderrPath, 'utf8')).toBe('')
  })

  it('enforces the phase timeout, including startup, and records the kill', async () => {
    const root = await scratch()
    const result = await runLeanPhase(node('setTimeout(() => {}, 60000)'), options(root, { timeoutMs: 300 }))
    expect(result.timedOut).toBe(true)
    expect(result.exitCode === null || Number.isSafeInteger(result.exitCode)).toBe(true)
  })

  it('cancels a running phase through the shared abort signal', async () => {
    const root = await scratch()
    const controller = new AbortController()
    const run = runLeanPhase(node('setTimeout(() => {}, 60000)'), options(root, { signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    const result = await run
    expect(result.cancelled).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  it('constructs a child environment with only PATH, locale and LEAN_PATH', () => {
    const env = leanChildEnvironment('/abs/workspace', { PATH: '/bin', LANG: 'en_US.UTF-8', LEAN_SRC_PATH: '/x', LEAN_SYSROOT: '/y', HOME: '/home' })
    expect(env).toEqual({ PATH: '/bin', LANG: 'en_US.UTF-8', LEAN_PATH: '/abs/workspace' })
  })
})

describe('proof evidence contract', () => {
  const tamper = async (root: string, mutate: (evidence: any) => void) => {
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase } = fakePhases(manifest)
    await runFixture(root, { runPhase })
    const evidence = await evidenceOf(root)
    mutate(evidence)
    return () => validateProofEvidence(evidence, manifest)
  }

  it('rejects unknown, missing, duplicated and inconsistent records', async () => {
    const cases: ((evidence: any) => void)[] = [
      evidence => { evidence.extra = true },
      evidence => { delete evidence.runnerPackage },
      evidence => { evidence.inputFiles.push({ ...evidence.inputFiles[0] }) },
      evidence => { evidence.inputDigest = 'f'.repeat(64) },
      evidence => { evidence.toolchain.platform = 'win32-x64' },
      evidence => { evidence.proofVerdict = 'verified'; evidence.reason = { code: 'io', detail: {} } },
      evidence => { evidence.phases.reverse() },
      evidence => { evidence.phases[0].stdout.path = '.formal-design/lean/other/run/compile-model/stdout.log' },
      evidence => { evidence.properties[0].verdict = 'rejected' },
      evidence => { evidence.startedAt = 'yesterday' },
      evidence => { evidence.runId = 'not-a-uuid' },
    ]
    for (const mutate of cases) {
      const root = await project()
      const validate = await tamper(root, mutate)
      expect(validate).toThrow()
    }
  })

  it('publishes evidence and pointer atomically and leaves no temporary files', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readFile(join(modelDir(root), 'checks.json'), 'utf8'))
    const { runPhase } = fakePhases(manifest)
    await runFixture(root, { runPhase })
    const evidence = await evidenceOf(root)
    const published = await publishProof({ modelDir: modelDir(root), runDir: join(root, '.formal-design/lean', MODEL_ID, evidence.runId), evidence })
    expect(published.evidenceSha256).toBe(sha256(await readFile(join(modelDir(root), 'evidence.json'))))
    expect((await readdir(modelDir(root))).filter(name => name.startsWith('.'))).toEqual([])
  })
})

describe('lean-check command contract', () => {
  const capture = async (argv: string[]) => {
    const writes: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (chunk: any) => { writes.push(String(chunk)); return true }
    try { return { code: await main(argv), text: writes.join('') } } finally { process.stdout.write = original }
  }
  it('prints plain help text and executes nothing', async () => {
    const { code, text } = await capture(['--help'])
    expect(code).toBe(0)
    expect(text).toContain('lean-check --project <root> --model specs/lean/<id>')
    expect(text.trim().startsWith('{')).toBe(false)
  })
  it('answers invalid arguments with exactly one JSON object and exit 2', async () => {
    for (const argv of [['--project'], ['--project', 'a', '--model', MODEL, '--nope', 'x'], ['--project', 'a', '--project', 'b']]) {
      const { code, text } = await capture(argv)
      expect(code).toBe(2)
      expect(text.trimEnd().split('\n')).toHaveLength(1)
      expect(JSON.parse(text)).toMatchObject({ command: 'lean-check', status: 'blocked', reason: { code: 'config-invalid' } })
    }
  })
})

describe('runner identity', () => {
  it('enumerates exactly the shipped Lean runner files', async () => {
    const files = (await import('../skills/formal-design/scripts/lean-evidence.lib.mjs')).runnerFiles
    const entries = await files(join(import.meta.dirname, '../skills/formal-design'))
    const paths = entries.map(entry => entry.path)
    expect(paths).toContain('lean/Inspector.lean')
    expect(paths).toContain('lean/Driver.lean')
    expect(paths).toContain('scripts/lean-toolchain.json')
    expect(paths).toContain('scripts/lean-check.mjs')
    expect(paths.every(path => path.startsWith('scripts/lean-') || path.startsWith('lean/'))).toBe(true)
    expect(runnerDigest(entries)).toMatch(/^[a-f0-9]{64}$/)
  })
})
