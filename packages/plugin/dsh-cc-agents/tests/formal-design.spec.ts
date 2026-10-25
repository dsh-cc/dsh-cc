import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { parseManifest, parseJson, canonicalValue, generateCfg, RESERVED, sortBlockers } from '../skills/formal-design/scripts/manifest.lib.mjs'
import { inspectProject, fingerprint, sha256 } from '../skills/formal-design/scripts/fingerprint.lib.mjs'

const manifest = () => ({ schemaVersion: 1, modelId: 'test', module: 'Model', cases: [{ id: 'small', coverage: 'core', specification: 'Spec', constants: { Z: '{1,2, ok}', A: '2' }, invariants: ['TypeOK'], properties: [], limits: { timeoutMs: 1000, heapMiB: 256 } }] })
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
async function project() {
  // The runner realpath-normalizes every resolved path; build fixtures under a
  // canonical temp base so expected values compare equal on symlinked tmpdirs
  // (macOS /var/folders vs /private/var/folders).
  const root = await mkdtemp(join(await realpath(tmpdir()), 'formal design ')); roots.push(root)
  const model = join(root, 'specs/tla/test'); await mkdir(join(model, 'cases'), { recursive: true })
  await writeFile(join(model, 'checks.json'), JSON.stringify(manifest()))
  await writeFile(join(model, 'design.md'), 'bounded design')
  await writeFile(join(model, 'Model.tla'), '---- MODULE Model ----\n====')
  return { root, model }
}
describe('formal-design manifest and cfg contract', () => {
  it('requires exact fields, core coverage, unique names and bounded limits', () => {
    expect(parseManifest(JSON.stringify(manifest())).modelId).toBe('test')
    const mutations = [
      (m: any) => { delete m.cases[0].properties },
      (m: any) => { m.cases[0].required = true },
      (m: any) => { m.cases[0].coverage = 'optional' },
      (m: any) => { m.cases[0].coverage = 'expansion' },
      (m: any) => { m.cases[0].invariants = [] },
      (m: any) => { m.cases.push(m.cases[0]) },
      (m: any) => { m.cases[0].limits.timeoutMs = 999 },
      (m: any) => { m.cases[0].limits.heapMiB = 4097 },
      (m: any) => { m.module = '../Model' },
      (m: any) => { m.cases[0].specification = 'INIT' },
    ]
    for (const mutate of mutations) { const m = manifest(); mutate(m); expect(() => parseManifest(JSON.stringify(m))).toThrow() }
  })
  it('rejects duplicate keys including escaped spellings and nested objects', () => {
    for (const s of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":[{"a":1,"a":2}]}']) expect(() => parseJson(s)).toThrow()
    expect(parseJson('{"__proto__":{"a":1}}')).toHaveProperty('__proto__')
  })
  it('consumes the complete constant grammar and preserves element order', () => {
    for (const v of ['0', '2147483647', 'TRUE', 'FALSE', 'Derived', '{}', '{1,2, ok}', '{ok,ok}']) expect(canonicalValue(v)).toBe(v.replace(/, ?/g, ', '))
    for (const v of ['', '01', '-1', '2147483648', '99999999999999999999', ' 2', '2 ', '2\n', '"x"', '{{1}}', '{ 1}', '{1,  2}', '2 CONSTRAINT Prune', 'TRUE PROPERTY', 'x;', ...RESERVED]) expect(() => canonicalValue(v)).toThrow()
  })
  it('renders exactly the reviewed cfg format', () => {
    expect(generateCfg(manifest().cases[0])).toBe('SPECIFICATION Spec\nCONSTANTS\nA = 2\nZ = {1, 2, ok}\nINVARIANT TypeOK\nCHECK_DEADLOCK TRUE\n')
    const c = manifest().cases[0]; c.constants = {}; c.properties = ['Live']
    expect(generateCfg(c)).toBe('SPECIFICATION Spec\nINVARIANT TypeOK\nPROPERTY Live\nCHECK_DEADLOCK TRUE\n')
  })
  it('sorts blockers by scalar codepoints and internal keys, deduplicating public diagnostics', () => {
    const entries = [
      { code: 'io', detail: 'last' },
      { code: 'config-drift', detail: 'z', relativePath: 'z', caseId: 'a' },
      { code: 'config-drift', detail: 'a', relativePath: 'a', caseId: 'z' },
      { code: 'config-drift', detail: 'a', relativePath: 'b' },
      { code: 'config-drift', detail: 'bmp', relativePath: '\uE000' },
      { code: 'config-drift', detail: 'astral', relativePath: '😀' },
    ]
    expect(sortBlockers(entries)).toEqual(sortBlockers([...entries].reverse()))
    expect(sortBlockers(entries).map((b: any) => b.detail)).toEqual(['a', 'z', 'bmp', 'astral', 'last'])
    expect(Object.keys(sortBlockers(entries)[0])).toEqual(['code', 'detail'])
  })
})
describe('formal-design input boundary and fingerprint', () => {
  it('enumerates only inputs, includes helpers, and fingerprints exact bytes', async () => {
    const { root, model } = await project()
    const paths = await inspectProject(root, 'specs/tla/test')
    const m = parseManifest(await readFile(join(model, 'checks.json'), 'utf8'))
    await writeFile(join(model, 'cases/small.cfg'), generateCfg(m.cases[0]))
    await writeFile(join(model, 'Helpers.tla'), 'helper')
    await writeFile(join(model, 'implementation.md'), 'not input')
    await writeFile(join(model, 'cases/old.cfg'), 'not declared')
    const f = await fingerprint(paths.model, m)
    expect(f.inputFiles.map((x: any) => x.path)).toEqual(['Helpers.tla', 'Model.tla', 'cases/small.cfg', 'checks.json', 'design.md'])
    expect(f.inputDigest).toBe(sha256(Buffer.from(JSON.stringify(f.inputFiles.map((x: any) => [x.path, x.sha256])))))
    await writeFile(join(model, 'implementation.md'), 'progress')
    expect((await fingerprint(paths.model, m)).inputDigest).toBe(f.inputDigest)
  })
  it('rejects unsafe roots, symlinks, nested TLA and Java overrides', async () => {
    const { root, model } = await project()
    for (const p of ['/specs/tla/test', 'specs/../tla/test', 'specs//tla/test']) await expect(inspectProject(root, p)).rejects.toMatchObject({ code: 'model-path-unsafe' })
    await symlink(join(model, 'design.md'), join(model, 'link'))
    await expect(inspectProject(root, 'specs/tla/test')).rejects.toMatchObject({ code: 'model-path-unsafe' })
    await rm(join(model, 'link')); await writeFile(join(model, 'cases/Nested.tla'), 'nested')
    await expect(inspectProject(root, 'specs/tla/test')).rejects.toMatchObject({ code: 'config-invalid' })
    await rm(join(model, 'cases/Nested.tla')); await writeFile(join(model, 'Override.class'), 'x')
    await expect(inspectProject(root, 'specs/tla/test')).rejects.toMatchObject({ code: 'config-invalid' })
  })
})

// Pinned event framing; no prose can establish success.
import { FrameParser, classify, aggregate } from '../skills/formal-design/scripts/tlc-output.lib.mjs'
const frame = (code: number, severity = 0, body = '') => `@!@!@STARTMSG ${code}:${severity} @!@!@\n${body}\n@!@!@ENDMSG ${code} @!@!@\n`
const success = frame(2187) + frame(2193) + frame(2199, 0, '4 states generated, 3 distinct states found, 0 states left on queue.') + frame(2186)
const parse = (s: string) => { const p = new FrameParser(); for (const byte of Buffer.from(s)) p.feed(Buffer.from([byte])); return p.finish() }
const classifyText = (s: string, exitCode = 0, extra = {}) => classify({ stdout: parse(s), stderr: parse(''), exitCode, signal: null, timedOut: false, ...extra })
describe('formal-design TLC frame and classifier contract', () => {
  it('parses arbitrary byte splits, Unicode, CRLF and nested frames', () => {
    const nested = frame(1000, 1, frame(5006, 1, 'é 😀'))
    const p = parse(nested.replace(/\n/g, '\r\n'))
    expect(p.invalid).toBe(false); expect(p.events.map((e: any) => e.code).sort()).toEqual([1000, 5006])
    expect(classifyText(nested, 255)).toMatchObject({ status: 'error', reason: 'config-invalid' })
  })
  it('accepts only ordered MC/success/final-statistics/finished with positive explored state count', () => {
    expect(classifyText(success)).toMatchObject({ status: 'verified', reason: 'verified', statistics: { generated: '4', distinct: '3', queue: '0' } })
    for (const s of [success.replace(frame(2187), ''), success.replace(frame(2186), '') + frame(2187), success.replace('4 states', '0 states').replace('3 distinct', '0 distinct'), success.replace('0 states left', '1 states left'), success.replace('4 states generated', '4,000 states generated'), success.replace(frame(2186), frame(2199, 0, 'bad') + frame(2186))]) expect(classifyText(s).status).not.toBe('verified')
    expect(classifyText(success).eventCodes).not.toContain(2267)
  })
  it('does not count STATE/WARNING-severity flow frames as the ordered success sequence or statistics', () => {
    for (const severity of [3, 4]) {
      const forged = frame(2187, severity) + frame(2193, severity) + frame(2199, severity, '4 states generated, 3 distinct states found, 0 states left on queue.') + frame(2186, severity)
      const parsed = parse(forged)
      expect(parsed.ordered).toBe(false); expect(parsed.statistics).toBe(null)
      expect(classifyText(forged)).toMatchObject({ status: 'incomplete', reason: 'output-invalid' })
    }
  })
  it.each([
    [11, 2114, 'counterexample', 'deadlock'], [12, 2110, 'counterexample', 'invariant'], [12, 2107, 'counterexample', 'invariant'],
    [13, 2116, 'counterexample', 'temporal'], [13, 2113, 'error', 'property-evaluation-failed'], [14, 2132, 'counterexample', 'value-assert'],
    [10, 2104, 'error', 'assumption-failed'], [75, 0, 'error', 'property-evaluation-failed'], [76, 0, 'error', 'property-evaluation-failed'], [77, 0, 'error', 'property-evaluation-failed'],
    [150, 2171, 'error', 'config-invalid'], [151, 2222, 'error', 'config-invalid'], [255, 5006, 'error', 'config-invalid'],
  ])('classifies exit %i with event %i', (exit, code, status, reason) => {
    expect(classifyText(code ? frame(code, 1) : '', exit)).toMatchObject({ status, reason })
  })
  it('implements the combined-error precedence before known violation classification', () => {
    const violation = frame(2110, 1)
    for (const s of [frame(99999, 1), success + frame(99999, 1)]) expect(classifyText(s)).toMatchObject({ status: 'error', reason: 'output-inconsistent' })
    expect(classifyText(violation + '@!@!@ENDMSG 1 @!@!@\n', 12).reason).toBe('output-invalid')
    expect(classifyText(violation + frame(99999, 2), 12).reason).toBe('tlc-bug')
    expect(classifyText(violation + success, 12).reason).toBe('output-inconsistent')
    expect(classifyText(violation + frame(99999, 1), 12).reason).toBe('unknown-error')
    expect(classifyText(frame(2113, 1) + frame(2116, 1), 13).reason).toBe('property-evaluation-failed')
    expect(classifyText(frame(99999, 2), 12, { timedOut: true }).reason).toBe('timeout')
    expect(classifyText('', 0, { timedOut: true, interruption: 'cancelled' }).reason).toBe('cancelled')
    expect(classifyText('', null, { spawnFailed: true }).reason).toBe('spawn-failed')
    expect(classifyText('', null, { signal: 'SIGKILL' }).reason).toBe('signal-exit')
  })
  it('rejects unclosed, mismatched and invalid-severity frames; warnings and STATE do not fail', () => {
    for (const s of ['@!@!@STARTMSG 1:0 @!@!@\n', frame(2187).replace('ENDMSG 2187', 'ENDMSG 2193'), frame(1, 5)]) expect(parse(s).invalid).toBe(true)
    expect(classifyText(success + frame(99999, 3) + frame(99998, 4))).toMatchObject({ status: 'verified', warningCodes: [99999] })
  })
  it('aggregates every configured case and prioritizes global causes', () => {
    const cases = [ { id: 'a', coverage: 'core', status: 'verified', reason: 'verified', warningCodes: [2, 1] }, { id: 'b', coverage: 'expansion', status: 'incomplete', reason: 'timeout', warningCodes: [] } ]
    expect(aggregate(cases)).toEqual({ status: 'incomplete', reason: 'timeout', warnings: ['tlc-warning:a:1', 'tlc-warning:a:2', 'expansion-incomplete:b:timeout'] })
    expect(aggregate(cases, ['artifact-changed', 'input-changed', 'cancelled']).reason).toBe('cancelled')
    expect(aggregate([{ ...cases[0], status: 'error', reason: 'unknown-error' }, { ...cases[1], status: 'counterexample', reason: 'invariant' }]).status).toBe('counterexample')
  })
})

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { vi } from 'vitest'
import { scrubEnvironment, parseJavaVersion, probeJava, runCase } from '../skills/formal-design/scripts/process.lib.mjs'
import { parseArguments, normalizeArguments, preflight } from '../skills/formal-design/scripts/preflight.lib.mjs'
function fakeChild() {
  const child = new EventEmitter() as any
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = vi.fn(() => true)
  return child
}
describe('formal-design bounded process control and CLI', () => {
  it('accepts standard Java versions and rejects malformed, conflicting or lower headers', () => {
    for (const s of ['openjdk version "17.0.12" 2024-07-16', 'java version "21" 2023', 'java version "1.17.0_02"', 'openjdk version "24-ea+12"']) expect(parseJavaVersion(s)).toBe(s.match(/"(.*?)"/)![1])
    for (const s of ['openjdk 17', 'java version "17oops"', 'java version "16.0.1"', 'java version "1"', 'java version "17"\njava version "21"']) expect(() => parseJavaVersion(s)).toThrow()
  })
  it('scrubs Java option injection without losing locating environment', () => {
    expect(scrubEnvironment({ PATH: 'p', JAVA_HOME: 'j', JAVA_TOOL_OPTIONS: '-agent', JDK_JAVA_OPTIONS: 'x', _JAVA_OPTIONS: 'x', CLASSPATH: 'x', TLA_LIBRARY: 'x', OTHER: 'yes' })).toEqual({ PATH: 'p', JAVA_HOME: 'j', OTHER: 'yes' })
  })
  it('requires unique arguments and rejects pass-through flags and auditor env flags', async () => {
    for (const args of [[], ['--help', '--model', 'x'], ['--project', 'x', '--project', 'y'], ['--project', '--model', 'x'], ['--unknown', 'x']]) await expect(parseArguments(args, 'check')).rejects.toMatchObject({ code: 'usage-invalid' })
    await expect(parseArguments(['--project', '.', '--model', 'specs/tla/test', '--jar', 'x'], 'check-evidence')).rejects.toMatchObject({ code: 'usage-invalid' })
    expect(await parseArguments(['--help'], 'check')).toEqual({ help: true })
  })
  it('bounds Java probing, kills at the deadline, then waits for close', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild(); const spawn = vi.fn(() => child)
      const result = probeJava('java', '/tmp', { spawn })
      await vi.advanceTimersByTimeAsync(10000); expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      await vi.advanceTimersByTimeAsync(2000); expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      child.emit('close', null, 'SIGKILL')
      await expect(result).resolves.toMatchObject({ code: 'java-version' })
      expect(spawn.mock.calls[0][1]).toEqual(['-version'])
      expect(spawn.mock.calls[0][2]).toMatchObject({ shell: false, cwd: '/tmp' })
    } finally { vi.useRealTimers() }
  })
  it('handles probe spawn errors, output ceilings and cancellation without creating logs', async () => {
    const child = fakeChild()
    const result = probeJava('java', '/tmp', { spawn: () => child })
    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }))
    await expect(result).resolves.toMatchObject({ code: 'java-missing' })
    const big = fakeChild(); const output = probeJava('java', '/tmp', { spawn: () => big })
    big.stdout.write(Buffer.alloc(1048577)); expect(big.kill).toHaveBeenCalledWith('SIGTERM'); big.emit('close', 0, null)
    await expect(output).resolves.toMatchObject({ code: 'java-version' })
    const aborted = new AbortController(); aborted.abort()
    const spawn = vi.fn()
    await expect(probeJava('java', '/tmp', { spawn, signal: aborted.signal })).resolves.toMatchObject({ code: 'cancelled' }); expect(spawn).not.toHaveBeenCalled()
  })
  it('opens both logs before spawn and persists exact bytes before returning classification', async () => {
    const { root } = await project(); const child = fakeChild()
    const r = runCase({ id: 'small', coverage: 'core', limits: { timeoutMs: 1000, heapMiB: 256 } }, ['java', 'args'], root, join(root, 'logs'), { spawn: () => { queueMicrotask(() => { child.emit('spawn'); child.stdout.write(success); child.emit('close', 0, null) }); return child } })
    const record = await r
    expect(record).toMatchObject({ status: 'verified', reason: 'verified', exitCode: 0, timedOut: false })
    expect(await readFile(join(root, 'logs/stdout.log'), 'utf8')).toBe(success)
    expect(record.stdoutSha256).toBe(sha256(Buffer.from(success)))
  })
  it('preflight is read-only and lists missing cfgs only when every prerequisite passes', async () => {
    const { root, model } = await project()
    const p = await preflight({ project: root, model: 'specs/tla/test', java: 'java' }, { probe: async () => ({ version: '17' }) })
    expect(p.output).toMatchObject({ status: 'blocked', reason: 'jar-missing', willGenerate: [] })
    await expect(readFile(join(model, 'cases/small.cfg'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, '.formal-design/locks/test.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

import { executeCheck, generateMissing } from '../skills/formal-design/scripts/check.lib.mjs'
import { auditEvidence } from '../skills/formal-design/scripts/evidence.lib.mjs'
import { probeLock } from '../skills/formal-design/scripts/storage.lib.mjs'
import * as fs from 'node:fs/promises'
function readyPreflight(root: string, model: string) {
  return async (options: any) => {
    const { runnerIdentity, cfgState } = await import('../skills/formal-design/scripts/fingerprint.lib.mjs')
    const paths = await inspectProject(root, 'specs/tla/test'); const m = parseManifest(await readFile(join(model, 'checks.json'), 'utf8'))
    const state = await cfgState(paths, m)
    return { options, paths, manifest: m, runner: await runnerIdentity(), javaVersion: '17', jarSha256: sha256(Buffer.from('jar')), output: { schemaVersion: 1, command: 'preflight', status: state.blockers.length ? 'blocked' : 'ready-for-check', reason: state.blockers[0]?.code ?? 'ready-for-check', blockers: state.blockers, willGenerate: state.missing } }
  }
}
const fakeRun = async (c: any, argv: string[], cwd: string, dir: string) => {
  await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'stdout.log'), success); await writeFile(join(dir, 'stderr.log'), '')
  return { id: c.id, coverage: c.coverage, ...classifyText(success), exitCode: 0, signal: null, timedOut: false, elapsedMs: 1, argv, stdoutPath: join(dir, 'stdout.log'), stderrPath: join(dir, 'stderr.log'), stdoutSha256: sha256(Buffer.from(success)), stderrSha256: sha256(Buffer.from('')) }
}
async function checked(deps: any = {}) {
  const { root, model } = await project(); const jar = join(root, 'tool.jar'); await writeFile(jar, 'jar')
  const options = { project: root, model: 'specs/tla/test', jar, java: 'java' }
  const result = await executeCheck(options, { preflight: readyPreflight(root, model), runCase: fakeRun, ...deps })
  return { root, model, options, result }
}
describe('formal-design check lifecycle, publication and replay', () => {
  it('publishes one finished run, audits logs, detects tampered replay fields and staleness', async () => {
    const { root, model, options, result } = await checked()
    expect(result).toMatchObject({ status: 'verified', reason: 'verified', blockers: [], summary: { status: 'verified' } })
    expect(await auditEvidence(options)).toMatchObject({ status: 'valid', fresh: true, verification: 'verified' })
    const e = result.summary; e.cases[0].eventCodes = []
    await writeFile(join(model, 'evidence.json'), JSON.stringify(e))
    expect(await auditEvidence(options)).toMatchObject({ status: 'invalid', reason: 'schema-invalid' })
    await writeFile(join(model, 'design.md'), 'changed')
    expect(await auditEvidence(options)).toMatchObject({ status: 'invalid', reason: 'stale/input' })
    await expect(readFile(join(root, '.formal-design/locks/test.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('does not overwrite drifted cfgs, and preserves existing finished evidence before the new marker', async () => {
    const { model, options, result } = await checked()
    await writeFile(join(model, 'cases/small.cfg'), 'reviewed different cfg')
    const blocked = await executeCheck(options, { preflight: readyPreflight(options.project, model) })
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'config-drift', summary: null })
    expect(JSON.parse(await readFile(join(model, 'evidence.json'), 'utf8')).runId).toBe(result.summary.runId)
    expect(await readFile(join(model, 'cases/small.cfg'), 'utf8')).toBe('reviewed different cfg')
  })
  it('retains atomically completed cfgs if the second generation fails and retries only missing paths', async () => {
    const { root, model } = await project(); const m = manifest(); m.cases.push({ ...m.cases[0], id: 'second' }, { ...m.cases[0], id: 'third' })
    let links = 0
    const io = { ...fs, link: async (a: string, b: string) => { if (++links === 2) throw new Error('injected'); await fs.link(a, b) } }
    await expect(generateMissing({ root, model }, m, { io, diagnostic: () => {} })).rejects.toThrow()
    expect(await readFile(join(model, 'cases/small.cfg'), 'utf8')).toBe(generateCfg(m.cases[0]))
    await expect(readFile(join(model, 'cases/second.cfg'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(model, 'cases/third.cfg'))).rejects.toMatchObject({ code: 'ENOENT' })
    await generateMissing({ root, model }, m)
    expect(await readFile(join(model, 'cases/third.cfg'), 'utf8')).toBe(generateCfg(m.cases[2]))
  })
  it('cancellation before the running marker returns null evidence and starts no JVM', async () => {
    const controller = new AbortController(); controller.abort(); const run = vi.fn()
    const { result } = await checked({ signal: controller.signal, runCase: run })
    expect(result).toMatchObject({ status: 'incomplete', reason: 'cancelled', summary: null, blockers: [] }); expect(run).not.toHaveBeenCalled()
  })
  it('snapshot/input change starts no child and leaves a valid incomplete record', async () => {
    const run = vi.fn()
    const { options, result } = await checked({ runCase: run, hooks: { afterSnapshot: async (ctx: any) => writeFile(join(ctx.snapshot, 'design.md'), 'changed copy') } })
    expect(result).toMatchObject({ status: 'incomplete', reason: 'input-changed' }); expect(run).not.toHaveBeenCalled()
    expect(result.summary.cases[0]).toMatchObject({ status: 'not-run', argv: null, eventCodes: [] })
    expect(await auditEvidence(options)).toMatchObject({ status: 'valid', verification: 'incomplete' })
  })
  it('cancellation after all cases verify still overrides the run before publication', async () => {
    const controller = new AbortController()
    const { options, result } = await checked({ signal: controller.signal, hooks: { beforePublication: () => controller.abort() } })
    expect(result).toMatchObject({ status: 'incomplete', reason: 'cancelled' })
    expect(result.summary.cases[0].status).toBe('verified')
    expect(await auditEvidence(options)).toMatchObject({ status: 'valid', verification: 'incomplete' })
  })
  it('finished marker failure cannot turn a written success summary into reusable evidence', async () => {
    const { options, result } = await checked({ hooks: { beforeFinishedMarker: () => { throw new Error('marker publication failed') } } })
    expect(result).toMatchObject({ status: 'error', reason: 'io', summary: null })
    expect(await auditEvidence(options)).toMatchObject({ status: 'invalid', reason: 'incomplete-run' })
  })
  it('keeps post-publication results committed even when cancellation arrives during lock cleanup', async () => {
    const controller = new AbortController()
    const { options, result } = await checked({ signal: controller.signal, hooks: { afterPublication: () => controller.abort() } })
    expect(result.status).toBe('verified'); expect((await auditEvidence(options)).status).toBe('valid')
  })
  it('does not auto-delete stale locks and probes present/absent/indeterminate PIDs conservatively', async () => {
    const { root } = await project(); const lock = join(root, 'lock')
    await writeFile(lock, JSON.stringify({ schemaVersion: 1, pid: 99, runId: 'r', startedAt: new Date().toISOString() }))
    expect((await probeLock(lock, () => {})).state).toBe('present')
    expect((await probeLock(lock, () => { throw Object.assign(new Error(), { code: 'ESRCH' }) })).state).toBe('absent')
    expect((await probeLock(lock, () => { throw Object.assign(new Error(), { code: 'EPERM' }) })).state).toBe('indeterminate')
    await writeFile(lock, '{}'); expect((await probeLock(lock)).state).toBe('indeterminate')
  })
})

// Failure injections target observation/publication boundaries, never wall sleeps.
describe('formal-design recovery and complete evidence contract', () => {
  it('keeps fresh counterexample evidence valid, distinct from verification success', async () => {
    const violation = frame(2110, 1)
    const run = async (c: any, argv: any, cwd: any, dir: string) => {
      const r = await fakeRun(c, argv, cwd, dir); await writeFile(join(dir, 'stdout.log'), violation)
      return { ...r, ...classifyText(violation, 12), exitCode: 12, stdoutSha256: sha256(Buffer.from(violation)) }
    }
    const { options, result } = await checked({ runCase: run })
    expect(result.status).toBe('counterexample')
    expect(await auditEvidence(options)).toMatchObject({ status: 'valid', verification: 'counterexample', fresh: true })
  })
  it.each(['counterexample', 'error', 'incomplete', 'not-run'])('does not ignore an expansion %s in aggregate or replay', async status => {
    const { root, model } = await project(); const m = manifest(); m.cases.push({ ...m.cases[0], id: 'expanded', coverage: 'expansion' }); await writeFile(join(model, 'checks.json'), JSON.stringify(m))
    const jar = join(root, 'tool.jar'); await writeFile(jar, 'jar')
    const options = { project: root, model: 'specs/tla/test', jar, java: 'java' }
    const run = async (c: any, argv: any, cwd: any, dir: any) => {
      const r = await fakeRun(c, argv, cwd, dir)
      if (c.id === 'small') return r
      const log = status === 'counterexample' ? frame(2110, 1) : ''
      await writeFile(join(dir, 'stdout.log'), log)
      const exitCode = status === 'counterexample' ? 12 : status === 'error' ? 255 : null
      return { ...r, ...classifyText(log, exitCode, { signal: status === 'incomplete' ? 'SIGKILL' : null }), exitCode, signal: status === 'incomplete' ? 'SIGKILL' : null, stdoutSha256: sha256(Buffer.from(log)) }
    }
    const result = await executeCheck(options, { preflight: readyPreflight(root, model), runCase: run, hooks: status === 'not-run' ? { beforeCase: (ctx: any, i: number) => { if (i === 1) throw new Error('unstarted IO') } } : {} })
    expect(result.status).not.toBe('verified')
    expect(result.summary.warnings.some((w: string) => w.startsWith(`expansion-${status}:expanded:`))).toBe(true)
    expect(await auditEvidence(options)).toMatchObject({ status: 'valid', verification: result.status })
  })
  it('detects changed original input and preserves the non-verified attempt', async () => {
    const { result, options } = await checked({ hooks: { afterCase: (ctx: any) => writeFile(join(ctx.paths.model, 'New.tla'), 'new helper') } })
    expect(result).toMatchObject({ status: 'incomplete', reason: 'input-changed' })
    expect((await auditEvidence(options)).reason).toBe('stale/input')
  })
  it('reports input change before artifact change and cancellation before either', async () => {
    const controller = new AbortController()
    const { result } = await checked({ signal: controller.signal, hooks: { afterCase: async (ctx: any) => { await writeFile(ctx.options.jar, 'changed jar'); await writeFile(join(ctx.paths.model, 'design.md'), 'changed'); controller.abort() } } })
    expect(result).toMatchObject({ status: 'incomplete', reason: 'cancelled' })
  })
  it('log open failure is not-run with recoverable error/io; lost output cannot publish a finished run', async () => {
    const unstarted = await checked({ runCase: async () => { throw new Error('log open') } })
    expect(unstarted.result).toMatchObject({ status: 'error', reason: 'io', summary: { cases: [{ status: 'not-run' }] } })
    expect((await auditEvidence(unstarted.options)).status).toBe('valid')
    const lost = await checked({ runCase: async () => { throw Object.assign(new Error('lost bytes'), { lostOutput: true }) } })
    expect(lost.result).toMatchObject({ status: 'error', reason: 'io', summary: null })
    expect((await auditEvidence(lost.options)).reason).toBe('incomplete-run')
  })
  it('rejects missing logs, hash mismatch, duplicate evidence keys and missing declared cfg', async () => {
    const { root, model, options, result } = await checked()
    const stdout = join(root, result.summary.cases[0].stdoutPath); const stderr = join(root, result.summary.cases[0].stderrPath)
    await writeFile(stdout, 'tampered'); await rm(stderr)
    expect((await auditEvidence(options)).reason).toBe('log-missing')
    await writeFile(stderr, '')
    expect((await auditEvidence(options)).reason).toBe('log-mismatch')
    await writeFile(join(model, 'evidence.json'), JSON.stringify(result.summary).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))
    expect((await auditEvidence(options)).reason).toBe('schema-invalid')
    await writeFile(join(model, 'evidence.json'), JSON.stringify(result.summary)); await rm(join(model, 'cases/small.cfg'))
    expect((await auditEvidence(options)).reason).toBe('schema-invalid')
  })
  it('rejects mismatched markers and unsafe log trees before lock/evidence checks', async () => {
    const { root, model, options, result } = await checked()
    await writeFile(join(model, 'current-run.json'), JSON.stringify({ schemaVersion: 1, runId: 'different', inputDigest: result.summary.inputDigest, state: 'finished' }))
    expect((await auditEvidence(options)).reason).toBe('incomplete-run')
    await symlink(model, join(root, '.formal-design/escape'))
    expect((await auditEvidence(options)).reason).toBe('runs-path-unsafe')
  })
  it('prevents overwrite when cfg publication races with a different destination and accepts identical bytes', async () => {
    for (const identical of [false, true]) {
      const { root, model } = await project(); const m = manifest()
      const io = { ...fs, link: async (a: string, b: string) => { await writeFile(b, identical ? generateCfg(m.cases[0]) : 'concurrent reviewed'); return fs.link(a, b) } }
      const generation = generateMissing({ root, model }, m, { io, diagnostic: () => {} })
      if (identical) await generation
      else await expect(generation).rejects.toMatchObject({ code: 'config-drift' })
      expect(await readFile(join(model, 'cases/small.cfg'), 'utf8')).toBe(identical ? generateCfg(m.cases[0]) : 'concurrent reviewed')
    }
  })
  it('audits all replay-derived fields, including statistics, warnings, case verdict and aggregate', async () => {
    const { model, result, options } = await checked()
    const mutations = [
      (e: any) => { e.cases[0].statistics.generated = '999' },
      (e: any) => { e.warnings.push('tlc-warning:small:999') },
      (e: any) => { e.cases[0].status = 'incomplete'; e.cases[0].reason = 'output-invalid' },
      (e: any) => { e.status = 'counterexample'; e.reason = 'invariant' },
      (e: any) => { e.cases[0].extra = true },
      (e: any) => { e.extra = true },
      (e: any) => { e.cases[0].timedOut = null },
      (e: any) => { e.cases[0].coverage = 'optional' },
    ]
    for (const mutate of mutations) { const e = structuredClone(result.summary); mutate(e); await writeFile(join(model, 'evidence.json'), JSON.stringify(e)); expect((await auditEvidence(options)).reason).toBe('schema-invalid') }
  })
  it('handles cancellation during async preparation and staging without publishing the pre-cancel verdict', async () => {
    for (const point of ['afterPreflight', 'afterSnapshot', 'afterStaging']) {
      const controller = new AbortController()
      const { result, options } = await checked({ signal: controller.signal, hooks: { [point]: () => controller.abort() } })
      expect(result).toMatchObject({ status: 'incomplete', reason: 'cancelled' })
      if (point === 'afterPreflight') expect(result.summary).toBe(null)
      else expect(await auditEvidence(options)).toMatchObject({ status: 'valid', verification: 'incomplete' })
    }
  })
})

describe('formal-design process persistence boundaries', () => {
  it('does not relabel a started child not-run when log hashing fails', async () => {
    const { root } = await project(); const child = fakeChild(); const dir = join(root, 'lost-hash')
    const r = runCase({ id: 'a', coverage: 'core', limits: { timeoutMs: 1000 } }, ['java'], root, dir, { spawn: () => { queueMicrotask(async () => { child.emit('spawn'); child.stdout.write(success); await rm(join(dir, 'stdout.log')); child.emit('close', 0, null) }); return child } })
    await expect(r).rejects.toMatchObject({ lostOutput: true })
  })
  it('starts no child when cancellation arrives while opening logs', async () => {
    const { root } = await project(); const controller = new AbortController(); const spawn = vi.fn()
    const io = { ...fs, open: async (p: string, mode: string) => { const handle = await fs.open(p, mode); if (p.endsWith('stderr.log')) controller.abort(); return handle } }
    await expect(runCase({ id: 'a', coverage: 'core', limits: { timeoutMs: 1000 } }, ['java'], root, join(root, 'cancelled'), { io, spawn, signal: controller.signal })).rejects.toMatchObject({ cancelledBeforeSpawn: true })
    expect(spawn).not.toHaveBeenCalled()
  })
  it('recognizes pinned distributed events but treats exit-status numbers as unknown event codes', () => {
    expect(classifyText(frame(2110, 1) + frame(7001, 1), 12).reason).toBe('invariant')
    expect(classifyText(frame(2110, 1) + frame(75, 1), 12).reason).toBe('unknown-error')
  })
})

describe('formal-design case termination and log I/O', () => {
  it.each(['timeout', 'log-limit', 'cancelled'])('uses TERM then KILL for %s and awaits close', async reason => {
    const { root } = await project(); const child = fakeChild(); const controller = new AbortController()
    let spawned!: () => void; const observedSpawn = new Promise<void>(r => { spawned = r })
    vi.useFakeTimers()
    try {
      const result = runCase({ id: 'a', coverage: 'core', limits: { timeoutMs: reason === 'log-limit' ? 10000 : 1000 } }, ['java'], root, join(root, reason), { signal: controller.signal, logLimit: 8, spawn: () => { spawned(); return child } })
      await observedSpawn; child.emit('spawn')
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(1000)
      if (reason === 'log-limit') child.stdout.write(Buffer.from('123456789'))
      if (reason === 'cancelled') controller.abort()
      expect(child.kill).toHaveBeenCalledWith('SIGTERM')
      await vi.advanceTimersByTimeAsync(2000); expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      let settled = false; result.then(() => { settled = true }); await Promise.resolve(); expect(settled).toBe(false)
      child.emit('close', null, 'SIGKILL')
      expect(await result).toMatchObject({ status: 'incomplete', reason, signal: 'SIGKILL' })
      if (reason === 'log-limit') expect(await readFile(join(root, reason, 'stdout.log'), 'utf8')).toBe('12345678')
    } finally { vi.useRealTimers() }
  })
  it.each(['write', 'sync', 'close'])('refuses completed evidence when child log %s fails', async method => {
    const { root } = await project(); const child = fakeChild(); let spawned!: () => void; const observedSpawn = new Promise<void>(r => { spawned = r })
    const io = { ...fs, open: async (p: string, flags: string) => {
      const h = await fs.open(p, flags)
      return { write: method === 'write' ? async () => { throw new Error('lost output') } : h.write.bind(h), sync: method === 'sync' ? async () => { throw new Error('flush failed') } : h.sync.bind(h), close: async () => { await h.close(); if (method === 'close') throw new Error('close failed') } }
    } }
    const result = runCase({ id: 'a', coverage: 'core', limits: { timeoutMs: 1000 } }, ['java'], root, join(root, method), { io, spawn: () => { spawned(); return child } })
    const rejected = expect(result).rejects.toMatchObject({ lostOutput: true })
    await observedSpawn; child.emit('spawn'); child.stdout.write(success); child.emit('close', 0, null)
    await rejected
  })
  it('bounds the Java probe wait after KILL and reports unconfirmed process control', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild(); const result = probeJava('java', '/tmp', { spawn: () => child })
      await vi.advanceTimersByTimeAsync(14000)
      expect(await result).toMatchObject({ code: 'io', detail: expect.stringContaining('unconfirmed') })
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})

import { runnerIdentity } from '../skills/formal-design/scripts/fingerprint.lib.mjs'
describe('formal-design identity and audit precedence', () => {
  it('compares runner identity and toolchain independently and audits without the old JAR', async () => {
    const { options } = await checked()
    await rm(options.jar)
    expect((await auditEvidence(options)).status).toBe('valid')
    const r = await runnerIdentity()
    expect((await auditEvidence(options, { identity: async () => ({ ...r, runnerPackage: { ...r.runnerPackage, version: 'new' } }) })).reason).toBe('stale/runner')
    expect((await auditEvidence(options, { identity: async () => ({ ...r, runnerDigest: '0'.repeat(64) }) })).reason).toBe('stale/runner')
    expect((await auditEvidence(options, { identity: async () => ({ ...r, toolchainDigest: '0'.repeat(64) }) })).reason).toBe('stale/toolchain')
    expect((await auditEvidence(options, { identity: async () => { throw new Error('wrong manifest identity') } })).reason).toBe('schema-invalid')
  })
  it('blocks live or indeterminate locks before evidence but ignores only a well-formed absent PID for auditing', async () => {
    const { root, options, model } = await checked(); const lock = join(root, '.formal-design/locks/test.lock')
    const contents = JSON.stringify({ schemaVersion: 1, pid: 123456789, runId: 'old-run', startedAt: new Date().toISOString() })
    await writeFile(lock, contents)
    expect((await auditEvidence(options, { kill: () => {} })).reason).toBe('run-in-progress')
    expect((await auditEvidence(options, { kill: () => { throw Object.assign(new Error(), { code: 'EPERM' }) } })).reason).toBe('run-in-progress')
    const absent = () => { throw Object.assign(new Error(), { code: 'ESRCH' }) }
    expect((await auditEvidence(options, { kill: absent })).status).toBe('valid')
    const refused = await executeCheck(options, { preflight: readyPreflight(root, model), diagnostic: () => {} })
    expect(refused).toMatchObject({ status: 'blocked', reason: 'model-locked' })
    expect(await readFile(lock, 'utf8')).toBe(contents)
  })
  it('normalizes explicit Java/JAR symlinks once, and reports missing files independently', async () => {
    const { root } = await project(); const target = join(root, 'target'); await writeFile(target, 'bytes'); await symlink(target, join(root, 'alias'))
    const parsed = await parseArguments(['--project', root, '--model', 'specs/tla/test', '--java', join(root, 'alias'), '--jar', join(root, 'alias')], 'check')
    expect(parsed).toMatchObject({ java: target, jar: target, argumentBlockers: [] })
    const missing = await parseArguments(['--project', root, '--model', 'specs/tla/test', '--java', join(root, 'missing-java'), '--jar', join(root, 'missing-jar')], 'check')
    expect(missing.argumentBlockers.map((b: any) => b.code)).toEqual(['java-missing', 'jar-missing'])
  })
  it('rejects over-limit inputs and output ancestor symlinks without writing', async () => {
    const { root, model } = await project(); await writeFile(join(model, 'Model.tla'), Buffer.alloc(1048577))
    const p = await preflight({ project: root, model: 'specs/tla/test', java: 'java' }, { probe: async () => ({ version: '17' }) })
    expect(p.output.blockers.map((b: any) => b.code)).toContain('input-limit')
    await symlink(model, join(root, '.formal-design'))
    await expect(inspectProject(root, 'specs/tla/test')).rejects.toMatchObject({ code: 'model-path-unsafe' })
  })
  it('validates distinct manifest names with equal versions and rejects missing/wrong/mismatched identities', async () => {
    const { root } = await project(); const pkg = join(root, 'pkg'); const scripts = join(pkg, 'skills/formal-design/scripts')
    await mkdir(scripts, { recursive: true }); await mkdir(join(pkg, '.claude-plugin'), { recursive: true })
    await writeFile(join(scripts, 'runner.mjs'), '// runner')
    await writeFile(join(scripts, 'toolchain.json'), JSON.stringify({ version: '1.7.4', downloadUrl: 'https://example.invalid/pinned', sha1: 'a'.repeat(40) }))
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@dsh-cc/plugin-dsh-cc-agents', version: '1' }))
    const pluginPath = join(pkg, '.claude-plugin/plugin.json')
    await writeFile(pluginPath, JSON.stringify({ name: 'dsh-cc-agents', version: '1' }))
    expect((await runnerIdentity(scripts)).runnerPackage).toEqual({ name: '@dsh-cc/plugin-dsh-cc-agents', version: '1' })
    for (const plugin of [{ name: '@dsh-cc/plugin-dsh-cc-agents', version: '1' }, { name: 'dsh-cc-agents', version: '2' }, { name: 'dsh-cc-agents' }]) {
      await writeFile(pluginPath, JSON.stringify(plugin)); await expect(runnerIdentity(scripts)).rejects.toMatchObject({ code: 'config-invalid' })
    }
  })
})

describe('formal-design real nested exception framing regression', () => {
  it('recognizes nested STARTMSG inline after exception punctuation, not only at line starts', () => {
    const log = frame(1000, 1, 'The exception was a tlc2.tool.ConfigFileException\n: ' + frame(5006, 0, 'It was expecting = or <-')) + frame(2186)
    expect(parse(log).invalid).toBe(false)
    expect(classifyText(log, 255)).toMatchObject({ status: 'error', reason: 'config-invalid' })
  })
})

describe('formal-design captured pinned TLC logs', () => {
  it('replays actual raw logs, including nested exceptions, empty Init, safety PROPERTY and error exits', async () => {
    const dir = join(import.meta.dirname, 'fixtures/formal-design/protocol-captures')
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
    expect(index.toolchainVersion).toBe('1.7.4')
    for (const c of index.cases) {
      const stdout = parse(await readFile(join(dir, `${c.id}.stdout.txt`), 'utf8')); const stderr = parse(await readFile(join(dir, `${c.id}.stderr.txt`), 'utf8'))
      expect(classify({ stdout, stderr, exitCode: c.exitCode, signal: null, timedOut: false }), c.id).toMatchObject({ status: c.status, reason: c.reason, statistics: c.statistics, eventCodes: c.eventCodes })
    }
  })
})

describe('formal-design lock acquisition failures', () => {
  it('releases the exclusively owned lock even after a partial lock write fails', async () => {
    const { root, model } = await project(); const jar = join(root, 'jar'); await writeFile(jar, 'jar')
    const io = { ...fs, open: async (p: string, flags: string) => {
      const h = await fs.open(p, flags)
      if (!p.endsWith('.lock')) return h
      return { stat: h.stat.bind(h), close: h.close.bind(h), sync: h.sync.bind(h), writeFile: async () => { await h.writeFile('{'); throw new Error('partial lock write') } }
    } }
    const result = await executeCheck({ project: root, model: 'specs/tla/test', jar, java: 'java' }, { io, preflight: readyPreflight(root, model), diagnostic: () => {} })
    expect(result).toMatchObject({ status: 'blocked', reason: 'lock-io' })
    await expect(readFile(join(root, '.formal-design/locks/test.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('still removes its own fully written lock when creation-time identity capture fails', async () => {
    const { root, model } = await project(); const jar = join(root, 'jar'); await writeFile(jar, 'jar')
    const io = { ...fs, lstat: async (p: string) => { if (p.endsWith('.lock')) throw new Error('identity capture failed'); return fs.lstat(p) } }
    const result = await executeCheck({ project: root, model: 'specs/tla/test', jar, java: 'java' }, { io, preflight: readyPreflight(root, model), runCase: fakeRun, diagnostic: () => {} })
    expect(result).toMatchObject({ status: 'verified', reason: 'verified' })
    await expect(readFile(join(root, '.formal-design/locks/test.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('never removes a replacement lock on identity-capture failure when contents are not its own', async () => {
    const { root, model } = await project(); const jar = join(root, 'jar'); await writeFile(jar, 'jar')
    const io = { ...fs, lstat: async (p: string) => { if (p.endsWith('.lock')) throw new Error('identity capture failed'); return fs.lstat(p) } }
    const result = await executeCheck({ project: root, model: 'specs/tla/test', jar, java: 'java' }, { io, preflight: readyPreflight(root, model), runCase: fakeRun, diagnostic: () => {} })
    expect(result).toMatchObject({ status: 'verified', reason: 'verified' })
    await writeFile(join(root, '.formal-design/locks/test.lock'), JSON.stringify({ schemaVersion: 1, pid: 1, runId: 'someone-else', startedAt: new Date().toISOString() }) + '\n')
    // A second run that cannot capture identity must not remove that foreign lock by content.
    const again = await executeCheck({ project: root, model: 'specs/tla/test', jar, java: 'java' }, { io, preflight: readyPreflight(root, model), diagnostic: () => {} })
    expect(again).toMatchObject({ status: 'blocked', reason: 'model-locked' })
    expect(await readFile(join(root, '.formal-design/locks/test.lock'), 'utf8')).toContain('someone-else')
  })
})

describe('formal-design audit read failures', () => {
  it('distinguishes unexpected I/O from malformed schemas without launching Java', async () => {
    const { options } = await checked()
    for (const file of ['checks.json', 'current-run.json']) {
      const io = { ...fs, readFile: async (p: string, ...args: any[]) => {
        if (p.endsWith(file)) throw Object.assign(new Error('injected read failure'), { code: 'EIO' })
        return fs.readFile(p, ...args)
      } }
      expect((await auditEvidence(options, { io })).reason).toBe('io')
    }
  })
})

import * as syncFs from 'node:fs'
describe('formal-design runner write set', () => {
  it('writes only cfg/current evidence/marker under the model, and project .formal-design', async () => {
    const { root, model } = await project(); const jar = join(root, 'jar'); await writeFile(jar, 'jar')
    const writes: string[] = []
    const watch = (path: string) => {
      writes.push(path)
      expect(path === join(model, 'cases') || path.startsWith(join(model, 'cases') + '/') || path.startsWith(join(root, '.formal-design') + '/') || path === join(model, 'evidence.json') || path === join(model, 'current-run.json') || /\/\.(?:evidence|current-run)\.json\..*\.tmp$/.test(path)).toBe(true)
    }
    const io = { ...fs,
      mkdir: async (p: string, options: any) => { watch(p); return fs.mkdir(p, options) },
      open: async (p: string, flags: string) => { if (flags.includes('w')) watch(p); return fs.open(p, flags) },
      link: async (a: string, b: string) => { watch(b); return fs.link(a, b) },
      copyFile: async (a: string, b: string) => { watch(b); return fs.copyFile(a, b) },
      rename: async (a: string, b: string) => { watch(b); return fs.rename(a, b) },
    }
    const syncIO = { ...syncFs, renameSync: (a: string, b: string) => { watch(b); return syncFs.renameSync(a, b) } }
    const result = await executeCheck({ project: root, model: 'specs/tla/test', java: 'java', jar }, { io, syncIO, preflight: readyPreflight(root, model), runCase: fakeRun })
    expect(result.status).toBe('verified'); expect(writes.length).toBeGreaterThan(10)
  })
})

describe('formal-design Java probe stream independence', () => {
  it('does not interleave stdout and stderr chunks inside version headers', async () => {
    const child = fakeChild(); const result = probeJava('java', '/tmp', { spawn: () => child })
    child.stdout.write('openjdk ver'); child.stderr.write('launcher diagnostic\n'); child.stdout.write('sion "17.0.12"\n')
    child.emit('close', 0, null)
    expect(await result).toEqual({ version: '17.0.12' })
  })
})

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
describe('formal-design source integrity', () => {
  it('keeps runner, examples and captured protocol fixtures visible to git without ignore overrides', () => {
    const walk = (p: string): string[] => readdirSync(p, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)])
    const files = [...walk(join(import.meta.dirname, '../skills/formal-design')), ...walk(join(import.meta.dirname, 'fixtures/formal-design'))]
    let status = 0; let ignored = ''
    try { ignored = execFileSync('git', ['check-ignore', '--no-index', ...files], { encoding: 'utf8' }) } catch (e: any) { status = e.status; ignored = e.stdout ?? '' }
    expect(ignored).toBe(''); expect(status).toBe(1)
  })
  it('runs and emits JSON when the script path resolves through a symlink', async () => {
    // argv[1] through a symlink must still trigger the CLI entrypoint;
    // a mismatch makes every command a silent zero-byte exit 0.
    const { root } = await project()
    for (const command of ['preflight', 'check', 'check-evidence']) {
      const linked = join(root, command + '.mjs')
      await symlink(join(import.meta.dirname, `../skills/formal-design/scripts/${command}.mjs`), linked)
      const out = execFileSync(process.execPath, [linked, '--help'], { encoding: 'utf8' })
      expect(out).toContain(command + ' --project')
    }
  })
})


describe('formal-design bundled TLC resolution', () => {
  const bundled = join(import.meta.dirname, '../skills/formal-design/toolchain/tla2tools.jar')
  it('uses the bundled pinned JAR without an option or environment variable', async () => {
    const { root } = await project()
    const options = await normalizeArguments({ project: root, model: 'specs/tla/test' }, 'check', { env: {} })
    expect(options.jar).toBe(await fs.realpath(bundled))
    expect(options.argumentBlockers).toEqual([])
  })
  it('prefers explicit JAR over environment and environment over the bundle', async () => {
    const { root } = await project(); const explicit = join(root, 'explicit.jar'); const environment = join(root, 'environment.jar')
    await writeFile(explicit, 'explicit'); await writeFile(environment, 'environment')
    const env = { TLA2TOOLS_JAR: environment }
    expect((await normalizeArguments({ project: root, model: 'specs/tla/test', jar: explicit }, 'check', { env })).jar).toBe(explicit)
    expect((await normalizeArguments({ project: root, model: 'specs/tla/test' }, 'preflight', { env })).jar).toBe(environment)
  })
  it('never falls back when an explicitly configured path is missing', async () => {
    const { root } = await project()
    for (const explicit of [true, false]) {
      const missing = join(root, 'missing.jar')
      const input = { project: root, model: 'specs/tla/test', ...(explicit ? { jar: missing } : {}) }
      const options = await normalizeArguments(input, 'check', { env: { TLA2TOOLS_JAR: explicit ? bundled : missing } })
      expect(options.jar).toBeNull()
      expect(options.argumentBlockers.map((b: any) => b.code)).toEqual(['jar-missing'])
    }
  })
  it('reports a missing bundled resource without networking or rewriting configuration', async () => {
    const { root } = await project()
    const options = await normalizeArguments({ project: root, model: 'specs/tla/test' }, 'check', { env: {}, bundledJar: join(root, 'absent-bundle.jar') })
    expect(options.jar).toBeNull()
    expect(options.argumentBlockers.map((b: any) => b.code)).toEqual(['jar-missing'])
  })
  it('does not silently replace a configured JAR with a checksum mismatch', async () => {
    const { root } = await project(); const wrong = join(root, 'wrong.jar'); await writeFile(wrong, 'not the pinned bytes')
    const options = await normalizeArguments({ project: root, model: 'specs/tla/test', jar: wrong }, 'preflight', { env: {} })
    const result = await preflight(options, { probe: async () => ({ version: '17' }) })
    expect(options.jar).toBe(wrong)
    expect(result.output).toMatchObject({ status: 'blocked', reason: 'jar-checksum', willGenerate: [] })
  })
})
