import * as fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { object, parseJson, parseManifest, assert, ID } from './manifest.lib.mjs'
import { safePath, runnerIdentity, fingerprint, hashFile, cfgState, inspectProject, digestEntries } from './fingerprint.lib.mjs'
import { FrameParser, classify, aggregate } from './tlc-output.lib.mjs'
import { probeLock } from './storage.lib.mjs'
import { BRIDGE_PATH, bridgeMatchesModel, loadBridge } from './bridge.lib.mjs'
const HASH = /^[a-f0-9]{64}$/
const RUN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const pairs = { verified: ['verified'], counterexample: ['deadlock', 'invariant', 'temporal', 'value-assert'], error: ['assumption-failed', 'property-evaluation-failed', 'config-invalid', 'unknown-error', 'tlc-bug', 'output-inconsistent', 'spawn-failed', 'io'], incomplete: ['timeout', 'log-limit', 'cancelled', 'signal-exit', 'input-changed', 'artifact-changed', 'output-invalid', 'not-run'], 'not-run': ['not-run'] }
const text = x => typeof x === 'string' && x.length > 0
const hash = x => typeof x === 'string' && HASH.test(x)
const natural = x => Number.isSafeInteger(x) && x >= 0
const time = x => { try { return typeof x === 'string' && new Date(x).toISOString() === x } catch { return false } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const eq = (a, b) => {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort()
  return same(ka, kb) && ka.every(k => eq(a[k], b[k]))
}
export function validateMarker(m) {
  object(m, ['schemaVersion', 'runId', 'inputDigest', 'state'])
  assert(m.schemaVersion === 1 && typeof m.runId === 'string' && RUN.test(m.runId) && hash(m.inputDigest) && ['running', 'finished'].includes(m.state), 'invalid current run marker')
  return m
}
export function validateEvidence(e, manifest) {
  const base = ['schemaVersion', 'runId', 'modelId', 'inputDigest', 'inputFiles', 'runnerDigest', 'runnerPackage', 'toolchainVersion', 'toolchainDigest', 'jarSha256', 'jarPath', 'javaVersion', 'javaExecutable', 'platform', 'startedAt', 'finishedAt', 'status', 'reason', 'warnings', 'cases']
  // Version two adds exactly one field, `bridgeFiles` (design section 10);
  // version one keeps its exact shape for TLA-only use.
  object(e, [1, 2].includes(e?.schemaVersion) && e.schemaVersion === 2 ? [...base, 'bridgeFiles'] : base)
  assert(e.schemaVersion === 1 || e.schemaVersion === 2, 'unknown evidence schema version')
  assert(typeof e.runId === 'string' && RUN.test(e.runId) && e.modelId === manifest.modelId && ID.test(e.modelId), 'invalid evidence identity')
  for (const k of ['inputDigest', 'runnerDigest', 'toolchainDigest', 'jarSha256']) assert(hash(e[k]), `invalid ${k}`)
  object(e.runnerPackage, ['name', 'version'])
  assert(e.runnerPackage.name === '@dsh-cc/plugin-dsh-cc-agents' && text(e.runnerPackage.version), 'invalid runner package')
  assert(Array.isArray(e.inputFiles) && e.inputFiles.length > 0, 'missing inputFiles')
  const seen = new Set()
  for (const f of e.inputFiles) { object(f, ['path', 'sha256']); assert(text(f.path) && !seen.has(f.path) && hash(f.sha256) && !isAbsolute(f.path) && !f.path.split('/').some(s => !s || s === '..' || s === '.'), 'invalid inputFile'); seen.add(f.path) }
  if (e.schemaVersion === 2) {
    assert(Array.isArray(e.bridgeFiles) && e.bridgeFiles.length > 0, 'version-two evidence must enumerate bridgeFiles')
    const bridgeSeen = new Set()
    let bridgeJson = false
    for (const f of e.bridgeFiles) {
      object(f, ['path', 'sha256'])
      assert(text(f.path) && !bridgeSeen.has(f.path) && hash(f.sha256) && !isAbsolute(f.path) && !f.path.split('/').some(s => !s || s === '..' || s === '.'), 'invalid bridgeFiles entry')
      bridgeSeen.add(f.path)
      if (BRIDGE_PATH.test(f.path)) bridgeJson = true
      // Bridge files join the input enumeration before hashing.
      assert(seen.has(f.path) && e.inputFiles.find(entry => entry.path === f.path)?.sha256 === f.sha256, 'bridgeFiles must be part of inputFiles')
    }
    assert(bridgeJson, 'bridgeFiles must contain the bridge.json entry')
  }
  assert(text(e.toolchainVersion) && text(e.jarPath) && isAbsolute(e.jarPath) && text(e.javaVersion) && (e.javaExecutable === null || (text(e.javaExecutable) && isAbsolute(e.javaExecutable))), 'invalid tool metadata')
  assert(['darwin', 'linux'].includes(e.platform) && time(e.startedAt) && time(e.finishedAt) && e.finishedAt >= e.startedAt, 'invalid platform or timestamps')
  assert(['verified', 'counterexample', 'error', 'incomplete'].includes(e.status) && pairs[e.status].includes(e.reason), 'invalid status/reason')
  assert(Array.isArray(e.warnings) && e.warnings.every(text), 'invalid warnings')
  assert(Array.isArray(e.cases) && e.cases.length === manifest.cases.length, 'case count mismatch')
  e.cases.forEach((c, i) => {
    object(c, ['id', 'coverage', 'status', 'reason', 'exitCode', 'signal', 'timedOut', 'elapsedMs', 'argv', 'statistics', 'eventCodes', 'stdoutPath', 'stderrPath', 'stdoutSha256', 'stderrSha256'])
    assert(c.id === manifest.cases[i].id && c.coverage === manifest.cases[i].coverage && pairs[c.status]?.includes(c.reason), 'invalid case identity or result')
    assert(Array.isArray(c.eventCodes) && c.eventCodes.every(Number.isSafeInteger) && c.eventCodes.every((x, n, a) => n === 0 || x > a[n - 1]), 'invalid event codes')
    if (c.status === 'not-run') {
      assert(c.eventCodes.length === 0 && ['exitCode', 'signal', 'timedOut', 'elapsedMs', 'argv', 'statistics', 'stdoutPath', 'stderrPath', 'stdoutSha256', 'stderrSha256'].every(k => c[k] === null), 'invalid not-run fields')
      return
    }
    assert((c.exitCode === null || Number.isSafeInteger(c.exitCode)) && (c.signal === null || text(c.signal)) && !(c.exitCode !== null && c.signal !== null), 'invalid process exit')
    assert(typeof c.timedOut === 'boolean' && natural(c.elapsedMs) && Array.isArray(c.argv) && c.argv.length > 0 && c.argv.every(text), 'invalid process metadata')
    if (c.reason === 'spawn-failed') assert(c.status === 'error' && c.exitCode === null && c.signal === null && c.timedOut === false && c.statistics === null, 'invalid spawn failure')
    else assert(c.exitCode !== null || c.signal !== null, 'started child needs actual close metadata')
    if (c.statistics !== null) { object(c.statistics, ['generated', 'distinct', 'queue']); assert(Object.values(c.statistics).every(x => typeof x === 'string' && DECIMAL.test(x)), 'invalid statistics') }
    for (const stream of ['stdout', 'stderr']) {
      assert(c[`${stream}Path`] === `.formal-design/runs/${e.modelId}/${e.runId}/${c.id}/${stream}.log` && hash(c[`${stream}Sha256`]), 'invalid log path or hash')
    }
  })
  return e
}
async function replayLog(path) {
  const parser = new FrameParser()
  for await (const chunk of createReadStream(path)) parser.feed(chunk)
  return parser.finish()
}
export async function auditEvidence(options, { identity = runnerIdentity, kill = process.kill, io = fs } = {}) {
  let marker = null
  const out = reason => ({ schemaVersion: 1, command: 'check-evidence', status: reason === 'valid' ? 'valid' : 'invalid', reason, fresh: reason === 'valid', verification: null, runId: marker?.runId ?? null, inputDigest: marker?.inputDigest ?? null })
  let root, model, e, manifest, paths
  try {
    if (!/^specs\/tla\/[a-z][a-z0-9-]{0,63}$/.test(options.model)) return out('runs-path-unsafe')
    root = await io.realpath(options.project); model = join(root, options.model)
    await safePath(root, model, 'runs-path-unsafe')
    await safePath(root, join(root, '.formal-design'), 'runs-path-unsafe')
    // Validate existing descendants before even parsing Evidence.
    if (await io.stat(join(root, '.formal-design')).catch(e => { if (e.code !== 'ENOENT') throw e; return null })) {
      const scan = async dir => { for (const ent of await io.readdir(dir, { withFileTypes: true })) { const p = join(dir, ent.name); await safePath(root, p, 'runs-path-unsafe'); if (ent.isDirectory()) await scan(p) } }
      await scan(join(root, '.formal-design'))
    }
  } catch (err) { return out(err.code === 'runs-path-unsafe' ? 'runs-path-unsafe' : 'io') }
  try {
    const lock = await probeLock(join(root, '.formal-design/locks', `${options.model.split('/')[2]}.lock`), kill)
    if (['present', 'indeterminate'].includes(lock.state)) return out('run-in-progress')
    let markerText
    try { markerText = await io.readFile(join(model, 'current-run.json'), 'utf8') }
    catch (err) { return out(err.code === 'ENOENT' ? 'incomplete-run' : 'io') }
    try { marker = validateMarker(parseJson(markerText)) } catch { return out('incomplete-run') }
    if (marker.state !== 'finished') return out('incomplete-run')
    let raw
    try { await safePath(root, join(model, 'evidence.json'), 'runs-path-unsafe'); raw = await io.readFile(join(model, 'evidence.json'), 'utf8') }
    catch (err) { return out(err.code === 'ENOENT' ? 'evidence-missing' : err.code === 'runs-path-unsafe' ? 'runs-path-unsafe' : 'io') }
    let runner
    try {
      e = parseJson(raw)
      paths = await inspectProject(root, options.model)
      manifest = parseManifest(await io.readFile(join(model, 'checks.json'), 'utf8'))
      if (manifest.modelId !== paths.modelId) return out('schema-invalid')
      validateEvidence(e, manifest)
      runner = await identity()
    } catch (err) { return out(err.code && !['config-invalid', 'model-path-unsafe', 'input-limit', 'ENOENT', 'ENOTDIR'].includes(err.code) ? 'io' : 'schema-invalid') }
    if (e.runId !== marker.runId || e.inputDigest !== marker.inputDigest) return out('incomplete-run')
    // Version two: the bridge package must still hash to the recorded entries and
    // join the recomputed input enumeration. Version one stays TLA-only.
    let bridgeEntries = []
    if (e.schemaVersion === 2) {
      const bridgePath = e.bridgeFiles.map(entry => entry.path).find(path => BRIDGE_PATH.test(path))
      if (options.bridge && options.bridge !== bridgePath) return out('schema-invalid')
      let loaded
      try { loaded = await loadBridge(root, bridgePath) } catch { return out('stale/input') }
      // The recorded package must apply to the model being audited.
      if (!bridgeMatchesModel(loaded, options.model)) return out('schema-invalid')
      if (!eq(loaded.entries, e.bridgeFiles)) return out('stale/input')
      bridgeEntries = loaded.entries
    } else if (options.bridge) return out('schema-invalid')
    let current
    try {
      const base = await fingerprint(model, manifest)
      const inputFiles = [...base.inputFiles, ...bridgeEntries]
      current = { inputFiles, inputDigest: digestEntries(inputFiles) }
      const cfg = await cfgState(paths, manifest)
      if (cfg.missing.length) return out('schema-invalid')
      if (cfg.blockers.length) return out('stale/input')
    } catch (err) { return out(err.code && !['config-invalid', 'model-path-unsafe', 'input-limit', 'ENOENT', 'ENOTDIR'].includes(err.code) ? 'io' : 'schema-invalid') }
    if (current.inputDigest !== e.inputDigest || !eq(current.inputFiles, e.inputFiles)) return out('stale/input')
    if (runner.runnerDigest !== e.runnerDigest || !eq(runner.runnerPackage, e.runnerPackage)) return out('stale/runner')
    if (runner.toolchainDigest !== e.toolchainDigest || runner.toolchainVersion !== e.toolchainVersion) return out('stale/toolchain')
    // Check all presence before any hash mismatch; precedence is global.
    const logs = e.cases.filter(c => c.status !== 'not-run').flatMap(c => ['stdout', 'stderr'].map(stream => ({ path: join(root, c[`${stream}Path`]), expected: c[`${stream}Sha256`] })))
    for (const log of logs) {
      try { await safePath(root, log.path, 'runs-path-unsafe'); if (!(await io.stat(log.path)).isFile()) return out('log-missing') }
      catch (err) { return out(err.code === 'ENOENT' ? 'log-missing' : err.code === 'runs-path-unsafe' ? 'runs-path-unsafe' : 'io') }
    }
    for (const log of logs) if (await hashFile(log.path) !== log.expected) return out('log-mismatch')
    const reconstructed = []
    for (const c of e.cases) {
      if (c.status === 'not-run') { reconstructed.push({ ...c, warningCodes: [] }); continue }
      const stdout = await replayLog(join(root, c.stdoutPath)); const stderr = await replayLog(join(root, c.stderrPath))
      const fields = classify({ stdout, stderr, exitCode: c.exitCode, signal: c.signal, timedOut: c.timedOut, spawnFailed: c.reason === 'spawn-failed', interruption: ['cancelled', 'log-limit', 'input-changed', 'artifact-changed', 'io'].includes(c.reason) ? c.reason : undefined })
      if (fields.status !== c.status || fields.reason !== c.reason || !eq(fields.statistics, c.statistics) || !eq(fields.eventCodes, c.eventCodes)) return out('schema-invalid')
      reconstructed.push({ ...c, warningCodes: fields.warningCodes })
    }
    const globals = ['cancelled', 'input-changed', 'artifact-changed'].includes(e.reason) && e.status === 'incomplete' ? [e.reason] : e.status === 'error' && e.reason === 'io' ? ['io'] : []
    const agg = aggregate(reconstructed, globals)
    if (agg.status !== e.status || agg.reason !== e.reason || !eq(agg.warnings, e.warnings)) return out('schema-invalid')
    return { ...out('valid'), verification: e.status }
  } catch { return out('io') }
}
