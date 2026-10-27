import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeLeanConformance, exitCode, main as conformanceMain } from '../skills/formal-design/scripts/lean-check-conformance.mjs'
import { auditLeanEvidence, main as auditMain } from '../skills/formal-design/scripts/lean-check-evidence.mjs'
import { readUtf8, sha256, loadToolchain } from '../skills/formal-design/scripts/lean-fingerprint.lib.mjs'
import { parseLeanManifest } from '../skills/formal-design/scripts/lean-manifest.lib.mjs'
import { MODEL, MODEL_ID, fixtureProject, publishFixtureProof, toolchainRecord } from './helpers/lean-project'

// Contract tests for the conformance protocol, execution closure and both audit
// stages (design sections 7 and 8). Fake child processes exercise the runner; the
// real-tool acceptance lives in formal-design-lean-conformance.spec.ts.
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function project({ proof = true, verdict = 'verified' } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean conformance contract '))
  roots.push(root)
  await fixtureProject(root)
  if (proof) await publishFixtureProof(root, { verdict })
  return root
}
const modelDir = (root: string) => join(root, MODEL)
const corpusPath = (root: string) => join(modelDir(root), 'conformance/cases.jsonl')
const writeCorpus = (root: string, text: string) => writeFile(corpusPath(root), text)
const evidenceOf = async (root: string) => JSON.parse(await readFile(join(modelDir(root), 'conformance-evidence.json'), 'utf8'))

async function readyPreflight(root: string) {
  const manifest = parseLeanManifest(await readUtf8(join(modelDir(root), 'checks.json'), 'checks.json'))
  return {
    options: {}, manifest, pin: await loadToolchain(), leanRoot: join(root, 'no-such-lean-root'),
    paths: { root, model: modelDir(root), modelRelative: MODEL, modelId: MODEL_ID, entries: new Set() },
    toolchain: await toolchainRecord(), output: { schemaVersion: 1, command: 'lean-preflight', status: 'ready', reason: 'ready', blockers: [] },
  }
}

const phaseIdFor = (argv: string[]) => argv[0] === 'node'
  ? 'adapter'
  : argv.includes('--run') ? 'driver' : `compile-${argv.at(-1)!.replace(/\.lean$/, '').toLowerCase()}`

/** A fake child that records its invocation and writes both stream artifacts. */
function fakePhases(outputs: any = {}) {
  const calls: any[] = []
  const runPhase = async (argv: string[], options: any) => {
    const id = phaseIdFor(argv)
    calls.push({ id, argv })
    await mkdir(options.dir, { recursive: true })
    const stdout = outputs.stdout?.[id] ?? ''
    const stderr = outputs.stderr?.[id] ?? ''
    await writeFile(join(options.dir, 'stdout.log'), stdout)
    await writeFile(join(options.dir, 'stderr.log'), stderr)
    const override = outputs.phases?.[id] ?? {}
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

const runFixture = async (root: string, deps: any = {}) => {
  const { runPhase, calls } = fakePhases(deps.outputs)
  const result = await executeLeanConformance({ project: root, model: MODEL, 'lean-root': join(root, 'lean') }, {
    preflight: () => readyPreflight(root), runPhase, diagnostic: () => {}, hooks: deps.hooks,
  })
  return { result, calls }
}

const TWO = [
  '{"id":"case-a","input":{"budget":"10","reserved":"3","amount":"0"},"covers":["budget-bound"]}',
  '{"id":"case-b","input":{"budget":"10","reserved":"3","amount":"3"},"covers":["zero-request"]}',
].join('\n') + '\n'
const MATCHED = '{"id":"case-a","result":{"ok":"3"}}\n{"id":"case-b","result":{"ok":"6"}}\n'
const passing = async () => {
  const root = await project()
  await writeCorpus(root, TWO)
  const { result, calls } = await runFixture(root, { outputs: { stdout: { driver: MATCHED, adapter: MATCHED } } })
  return { root, result, calls }
}

describe('conformance corpus validation', () => {
  const invalid = {
    'a blank line': '{"id":"case-a","input":{},"covers":["budget-bound"]}\n\n{"id":"case-b","input":{},"covers":["zero-request"]}\n',
    'a duplicate decoded key': '{"id":"case-a","id":"case-a","input":{},"covers":["budget-bound"]}\n{"id":"case-b","input":{},"covers":["zero-request"]}\n',
    'a duplicate case id': '{"id":"case-a","input":{},"covers":["budget-bound"]}\n{"id":"case-a","input":{},"covers":["zero-request"]}\n',
    'an undeclared covered property': '{"id":"case-a","input":{},"covers":["budget-bound","nope"]}\n{"id":"case-b","input":{},"covers":["zero-request"]}\n',
    'empty covers': '{"id":"case-a","input":{},"covers":[]}\n{"id":"case-b","input":{},"covers":["zero-request"]}\n',
    'an uncovered declared property': '{"id":"case-a","input":{},"covers":["budget-bound"]}\n{"id":"case-b","input":{},"covers":["budget-bound"]}\n',
    'an extra field': '{"id":"case-a","input":{},"covers":["budget-bound"],"note":1}\n{"id":"case-b","input":{},"covers":["zero-request"]}\n',
    'a negative zero': '{"id":"case-a","input":-0,"covers":["budget-bound"]}\n{"id":"case-b","input":{},"covers":["zero-request"]}\n',
    'a fraction': '{"id":"case-a","input":1.5,"covers":["budget-bound"]}\n{"id":"case-b","input":{},"covers":["zero-request"]}\n',
    'an exponent': '{"id":"case-a","input":1e3,"covers":["budget-bound"]}\n{"id":"case-b","input":{},"covers":["zero-request"]}\n',
    'an unsafe integer': '{"id":"case-a","input":9007199254740993,"covers":["budget-bound"]}\n{"id":"case-b","input":{},"covers":["zero-request"]}\n',
  }
  for (const [label, corpus] of Object.entries(invalid)) {
    it(`blocks ${label} before executing anything`, async () => {
      const root = await project()
      await writeCorpus(root, corpus)
      const { result, calls } = await runFixture(root)
      expect(result.status).toBe('blocked')
      expect(result.reason.code).toBe('config-invalid')
      expect(calls).toEqual([])
    })
  }

  it('blocks a corpus over maxCases', async () => {
    const root = await project()
    const manifest = parseLeanManifest(await readUtf8(join(modelDir(root), 'checks.json'), 'checks.json'))
    manifest.limits.maxCases = 1
    await writeFile(join(modelDir(root), 'checks.json'), JSON.stringify(manifest))
    await publishFixtureProof(root)
    await writeCorpus(root, TWO)
    const { result } = await runFixture(root)
    expect(result.status).toBe('blocked')
    expect(result.reason.code).toBe('config-invalid')
  }, 60_000)
})

describe('conformance protocol failures', () => {
  const failures: Record<string, string> = {
    'a missing line': '{"id":"case-a","result":{"ok":"3"}}\n',
    'an extra line': `${MATCHED}{"id":"case-c","result":{"ok":"1"}}\n`,
    'reordered ids': '{"id":"case-b","result":{"ok":"6"}}\n{"id":"case-a","result":{"ok":"3"}}\n',
    'a duplicated line': `{"id":"case-a","result":{"ok":"3"}}\n{"id":"case-a","result":{"ok":"3"}}\n`,
    'malformed JSON': '{"id":"case-a","result":{"ok":"3"}}\n{not json\n',
    'an invalid error code': '{"id":"case-a","result":{"error":{"code":"Bad_Code"}}}\n{"id":"case-b","result":{"ok":"6"}}\n',
    'a malformed result shape': '{"id":"case-a","result":{"ok":"3","error":{"code":"x"}}}\n{"id":"case-b","result":{"ok":"6"}}\n',
    'a fraction in the result': '{"id":"case-a","result":{"ok":3.5}}\n{"id":"case-b","result":{"ok":"6"}}\n',
  }
  for (const [label, adapter] of Object.entries(failures)) {
    it(`fails on ${label} without fabricating a mismatch`, async () => {
      const root = await project()
      await writeCorpus(root, TWO)
      const { result } = await runFixture(root, { outputs: { stdout: { driver: MATCHED, adapter } } })
      expect(result.status).toBe('failed')
      expect(result.reason.code).toBe('protocol-invalid')
      expect(result.firstMismatch).toBe(null)
      const evidence = await evidenceOf(root)
      expect(evidence.conformanceVerdict).toBe('failed')
      expect(evidence.firstMismatch).toBe(null)
      expect(evidence.phases.some((phase: any) => phase.id === 'compare')).toBe(false)
    })
  }

  it('fails on a nonzero adapter exit even when every prior line matched', async () => {
    const root = await project()
    await writeCorpus(root, TWO)
    const { result } = await runFixture(root, {
      outputs: { stdout: { driver: MATCHED, adapter: MATCHED }, stderr: { adapter: 'Error: boom\n    at reserve (budget.ts:1:1)\n' }, phases: { adapter: { exitCode: 1 } } },
    })
    expect(result.status).toBe('failed')
    expect(result.reason.code).toBe('protocol-invalid')
    const evidence = await evidenceOf(root)
    expect(evidence.firstMismatch).toBe(null)
    // Exception text is never compared and never published as a result.
    expect(JSON.stringify(evidence)).not.toContain('boom')
    expect(JSON.stringify(evidence)).not.toContain('budget.ts:1:1')
    const stderr = await readFile(join(root, `.formal-design/lean/${MODEL_ID}/${evidence.runId}/adapter/stderr.log`), 'utf8')
    expect(stderr).toContain('boom')
  })

  it('reports an adapter timeout as incomplete with lifecycle metadata', async () => {
    const root = await project()
    await writeCorpus(root, TWO)
    const { result } = await runFixture(root, { outputs: { stdout: { driver: MATCHED }, phases: { adapter: { exitCode: null, timedOut: true } } } })
    expect(result.status).toBe('incomplete')
    expect(result.reason.code).toBe('timeout')
    expect((await evidenceOf(root)).conformanceVerdict).toBe('incomplete')
  })

  it('reports an oversized adapter stream as incomplete', async () => {
    const root = await project()
    await writeCorpus(root, TWO)
    const { result } = await runFixture(root, { outputs: { stdout: { driver: MATCHED }, phases: { adapter: { exitCode: null, overflowed: true } } } })
    expect(result.status).toBe('incomplete')
    expect(result.reason.code).toBe('stream-overflow')
  })

  it('reports a reference driver failure as incomplete, never as a mismatch', async () => {
    const root = await project()
    await writeCorpus(root, TWO)
    const { result } = await runFixture(root, { outputs: { phases: { driver: { exitCode: 1 } } } })
    expect(result.status).toBe('incomplete')
    expect(result.reason.code).toBe('output-invalid')
    expect(result.firstMismatch).toBe(null)
  })

  it('fails on a real difference and records the earliest differing case', async () => {
    const root = await project()
    await writeCorpus(root, TWO)
    const adapter = '{"id":"case-a","result":{"ok":"4"}}\n{"id":"case-b","result":{"ok":"6"}}\n'
    const { result } = await runFixture(root, { outputs: { stdout: { driver: MATCHED, adapter } } })
    expect(result.status).toBe('failed')
    expect(result.reason.code).toBe('output-invalid')
    expect(result.firstMismatch).toEqual({
      id: 'case-a', input: { budget: '10', reserved: '3', amount: '0' },
      referenceResult: { ok: '3' }, implementationResult: { ok: '4' },
    })
    expect(result.matchedCount).toBe(1)
    const evidence = await evidenceOf(root)
    const compare = evidence.phases.find((phase: any) => phase.id === 'compare')
    expect((await readFile(join(root, compare.report.path))).length).toBe(compare.report.bytes)
  })
})

describe('conformance execution closure and prerequisites', () => {
  it('records every phase, both streams and the comparison report on success', async () => {
    const { root, result, calls } = await passing()
    expect(result.status).toBe('passed')
    expect(result.reason).toBe(null)
    expect(calls.map(call => call.id)).toEqual(['compile-model', 'compile-reference', 'driver', 'adapter'])
    const evidence = await evidenceOf(root)
    expect(Object.keys(evidence).sort()).toEqual([
      'backend', 'caseCount', 'conformanceVerdict', 'executionDigest', 'executionFiles', 'finishedAt', 'firstMismatch',
      'matchedCount', 'modelId', 'phases', 'proofInputDigest', 'proofRunId', 'reason', 'runId', 'runnerDigest',
      'schemaVersion', 'startedAt', 'toolchain',
    ])
    expect(evidence.caseCount).toBe(2)
    expect(evidence.matchedCount).toBe(2)
    expect(evidence.phases.map((phase: any) => phase.id)).toEqual(['compile-model', 'compile-reference', 'driver', 'adapter', 'compare'])
    for (const phase of evidence.phases) {
      for (const stream of ['stdout', 'stderr']) expect((await readFile(join(root, phase[stream].path))).length).toBe(phase[stream].bytes)
    }
    // The digest enumerates the corpus, the adapter and every declared file.
    expect(evidence.executionFiles.map((entry: any) => entry.path)).toEqual([
      'package.json', 'packages/example/src/budget.ts',
      'specs/lean/budget-reservation/conformance/adapter.mjs', 'specs/lean/budget-reservation/conformance/cases.jsonl',
    ])
    expect(exitCode('passed')).toBe(0)
  })

  it('reports an execution-closure change during the run as incomplete', async () => {
    const root = await project()
    await writeCorpus(root, TWO)
    const { result } = await runFixture(root, {
      outputs: { stdout: { driver: MATCHED, adapter: MATCHED } },
      hooks: { afterAdapter: async () => { await writeFile(join(root, 'packages/example/src/budget.ts'), '// changed during the run\n') } },
    })
    expect(result.status).toBe('incomplete')
    expect(result.reason.code).toBe('input-changed')
    expect((await evidenceOf(root)).conformanceVerdict).toBe('incomplete')
  })

  it('blocks a stale proof and a non-verified proof without publishing evidence', async () => {
    const stale = await project()
    await writeFile(join(modelDir(stale), 'design.md'), '# changed\n')
    const staleRun = await runFixture(stale)
    expect(staleRun.result.status).toBe('blocked')
    expect(staleRun.result.reason.code).toBe('input-changed')
    expect(staleRun.calls).toEqual([])

    const rejected = await project({ verdict: 'rejected' })
    const rejectedRun = await runFixture(rejected)
    expect(rejectedRun.result.status).toBe('blocked')
    expect(rejectedRun.result.reason.code).toBe('config-invalid')
    expect(rejectedRun.result.reason.detail.message).toContain('missing proof prerequisites')
    expect(rejectedRun.calls).toEqual([])
  })

  it('blocks when the proof evidence is missing entirely', async () => {
    const root = await project({ proof: false })
    const { result } = await runFixture(root)
    expect(result.status).toBe('blocked')
    expect(result.reason.code).toBe('missing-input')
    await expect(readFile(join(modelDir(root), 'conformance-evidence.json'))).rejects.toThrow()
  })

  it('blocks when a declared implementation file is missing', async () => {
    const root = await project()
    await rm(join(root, 'packages/example/src/budget.ts'))
    const { result } = await runFixture(root)
    expect(result.status).toBe('blocked')
    expect(result.reason.code).toBe('missing-input')
  })
})

describe('conformance evidence auditing', () => {
  const proofAudit = (root: string) => auditLeanEvidence({ project: root, model: MODEL, stage: 'proof' })
  const acceptance = (root: string) => auditLeanEvidence({ project: root, model: MODEL, stage: 'acceptance' })

  it('accepts fresh, matching evidence and rejects every tampered artifact', async () => {
    const { root } = await passing()
    expect((await proofAudit(root)).status).toBe('valid')
    const accepted = await acceptance(root)
    expect(accepted.status).toBe('valid')
    expect(accepted.acceptanceReady).toBe(true)
    expect(accepted.integrity).toBe('valid')
    expect(accepted.fresh).toBe(true)

    const evidence = await evidenceOf(root)
    const compare = evidence.phases.find((phase: any) => phase.id === 'compare')
    const driver = evidence.phases.find((phase: any) => phase.id === 'driver')

    const tamperedReport = await copyOf(root)
    const reportPath = join(tamperedReport, compare.report.path)
    await writeFile(reportPath, JSON.stringify({ ...JSON.parse(await readFile(reportPath, 'utf8')), matchedCount: 1 }) + '\n')
    expect((await acceptance(tamperedReport)).reason).toBe('hash-mismatch')

    const tamperedLog = await copyOf(root)
    await writeFile(join(tamperedLog, driver.stdout.path), 'x')
    expect((await acceptance(tamperedLog)).reason).toBe('hash-mismatch')

    const extraField = await copyOf(root)
    await writeFile(join(extraField, MODEL, 'conformance-evidence.json'), JSON.stringify({ ...evidence, note: 'x' }) + '\n')
    expect((await acceptance(extraField)).reason).toBe('schema-invalid')

    const unknownSchema = await copyOf(root)
    await writeFile(join(unknownSchema, MODEL, 'conformance-evidence.json'), JSON.stringify({ ...evidence, schemaVersion: 2 }) + '\n')
    expect((await acceptance(unknownSchema)).reason).toBe('schema-invalid')

    const badCounts = await copyOf(root)
    await writeFile(join(badCounts, MODEL, 'conformance-evidence.json'), JSON.stringify({ ...evidence, matchedCount: 1 }) + '\n')
    expect((await acceptance(badCounts)).reason).toBe('schema-invalid')

    const missing = await copyOf(root)
    await rm(join(missing, MODEL, 'conformance-evidence.json'))
    expect((await acceptance(missing)).reason).toBe('missing-conformance')
  }, 120_000)

  it('rejects tampered proof evidence and a mismatched run', async () => {
    const { root } = await passing()
    const tampered = await copyOf(root)
    await writeFile(join(tampered, MODEL, 'design.md'), '# changed after the run\n')
    expect((await proofAudit(tampered)).reason).toBe('stale/input')

    const pointer = await copyOf(root)
    const current = JSON.parse(await readFile(join(pointer, MODEL, 'current-run.json'), 'utf8'))
    await writeFile(join(pointer, MODEL, 'current-run.json'), JSON.stringify({ ...current, runId: '11111111-1111-4111-8111-111111111111' }) + '\n')
    expect((await proofAudit(pointer)).reason).toBe('run-mismatch')
  }, 120_000)

  it('keeps the CLI contract: help text, one JSON result and 0/2 exits', async () => {
    const { root } = await passing()
    const written: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { written.push(String(chunk)); return true })
    try {
      expect(await conformanceMain(['--help'])).toBe(0)
      expect(written.at(-1)).toContain('lean-check-conformance')
      written.length = 0
      expect(await conformanceMain(['--project', root, '--model', MODEL, '--lean-root', join(root, 'lean'), '--nope', 'x'])).toBe(2)
      expect(JSON.parse(written.at(-1)!).reason.code).toBe('config-invalid')
      written.length = 0
      expect(await auditMain(['--help'])).toBe(0)
      expect(written.at(-1)).toContain('lean-check-evidence')
      written.length = 0
      expect(await auditMain(['--project', root, '--model', MODEL, '--stage', 'acceptance'])).toBe(0)
      expect(JSON.parse(written.at(-1)!).acceptanceReady).toBe(true)
      written.length = 0
      const stale = await copyOf(root)
      await writeFile(join(stale, MODEL, 'evidence.json'), '{}\n')
      expect(await auditMain(['--project', stale, '--model', MODEL, '--stage', 'proof'])).toBe(2)
      expect(JSON.parse(written.at(-1)!).status).toBe('invalid')
    } finally { spy.mockRestore() }
  }, 120_000)
})

async function copyOf(source: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'formal design lean conformance copy '))
  roots.push(root)
  await rm(root, { recursive: true, force: true })
  await cp(source, root, { recursive: true })
  return root
}
