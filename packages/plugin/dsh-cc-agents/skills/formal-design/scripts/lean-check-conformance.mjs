import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { leanEnvironment, leanPreflight, parseLeanSyntax } from './lean-preflight.mjs'
import { PROOF_SOURCES, REASON_CODES as CONFIG_REASON_CODES, canonicalJson } from './lean-manifest.lib.mjs'
import { hashFile, posix, readUtf8, sha256 } from './lean-fingerprint.lib.mjs'
import { loadBridge } from './bridge.lib.mjs'
import { leanChildEnvironment, runLeanPhase } from './lean-process.lib.mjs'
import { acquireLock, lockPathFor, releaseLock } from './lean-evidence.lib.mjs'
import {
  compareOutputs, executionDigestOf, executionFilesFor, firstMismatchOf, nodeIdentity, parseCorpus, parseOutput,
  protocolInput, publishConformance, readCurrentProof, reportPath, runnerIdentityOf, validateConformanceEvidence,
} from './lean-conformance.lib.mjs'

const SKILL_DIR = fileURLToPath(new URL('..', import.meta.url))
const SKILL_LEAN = join(SKILL_DIR, 'lean')
// Missing prerequisites are blockers (design section 8); a blocked run never
// overwrites evidence published by an earlier run.
const BLOCKING = new Set([...CONFIG_REASON_CODES, 'lock-conflict'])
// Compilation for this run is `Model` and `Reference`; the trusted driver is
// compiled and executed by one `--run` invocation (design section 7).
const REBUILD = [['compile-model', 'Model'], ['compile-reference', 'Reference']]

const output = (status, fields = {}) => ({
  schemaVersion: 1, command: 'lean-check-conformance', status, reason: null, runId: null, model: null,
  proofRunId: null, executionDigest: null, caseCount: 0, matchedCount: 0, firstMismatch: null, phases: [], blockers: [], ...fields,
})
const blockedOutput = (reason, blockers) => output('blocked', { reason: { code: reason, detail: { message: blockers[0]?.detail ?? reason } }, blockers })
const relativePath = (root, path) => posix(relative(root, path))

function phaseRecord(root, id, result, report = null) {
  return {
    id,
    argv: result.argv,
    exitCode: result.exitCode,
    signal: result.termSignal ?? null,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    overflowed: result.overflowed,
    stdout: { path: relativePath(root, result.stdoutPath), bytes: result.stdoutBytes, sha256: result.stdoutSha256 },
    stderr: { path: relativePath(root, result.stderrPath), bytes: result.stderrBytes, sha256: result.stderrSha256 },
    report,
  }
}

/**
 * One conformance run (design section 7): require a fresh verified proof, rebuild
 * the reference from the pinned proof inputs, run the trusted driver over the
 * whole corpus, run the adapter in place over the whole corpus, then compare both
 * streams in corpus order and publish conformance evidence.
 */
export async function executeLeanConformance(options, deps = {}) {
  const {
    preflight = leanPreflight, runPhase = runLeanPhase, io = fs, signal, hooks = {},
    diagnostic = message => process.stderr.write(message + '\n'),
  } = deps
  const cancelled = () => signal?.aborted
  let lock = null
  let runId = null
  let startedAt = null
  let paths = null
  let manifest = null
  let corpus = []
  try {
    if (cancelled()) return output('incomplete', { reason: { code: 'cancelled', detail: { message: 'cancelled before start' } } })
    const ready = await preflight(options, { signal })
    if (ready.output.status === 'blocked') return blockedOutput(ready.output.reason, ready.output.blockers)
    ;({ paths, manifest } = ready)
    const { leanRoot, toolchain } = ready
    const bridge = ready.bridge ?? (options.bridge ? await loadBridge(paths.root, options.bridge) : null)
    if (!toolchain) return blockedOutput('toolchain-missing', [{ code: 'toolchain-missing', detail: 'installation identity is unavailable' }])
    if (!manifest.conformance) return blockedOutput('config-invalid', [{ code: 'config-invalid', detail: 'the manifest declares no conformance contract' }])

    startedAt = new Date().toISOString()
    runId = randomUUID()
    try { lock = await acquireLock(lockPathFor(paths.root, paths.modelId), runId, startedAt, { io }) } catch (error) {
      if (error.code === 'lock-conflict') return blockedOutput('lock-conflict', [{ code: 'lock-conflict', detail: error.detail ?? 'model lock conflict' }])
      throw error
    }

    // A stale or non-verified proof is a missing prerequisite, never a partial run.
    let proof
    try { proof = await readCurrentProof(paths.root, paths.model, paths.modelRelative, manifest, io) } catch (error) {
      if (BLOCKING.has(error.code) || ['artifact-changed', 'input-changed'].includes(error.code)) {
        return blockedOutput(error.code, [{ code: error.code, detail: error.detail ?? 'missing proof prerequisites' }])
      }
      throw error
    }
    // Combined mode: conformance must bind the same bridge package the current
    // proof recorded, and TLA-only mode must not audit a bridged proof.
    if (Boolean(bridge) !== (proof.evidence.schemaVersion === 2)) {
      return blockedOutput('config-invalid', [{ code: 'config-invalid', detail: '--bridge must match the current proof evidence version' }])
    }
    if (bridge && canonicalJson(proof.evidence.bridgeFiles) !== canonicalJson(bridge.entries)) {
      return blockedOutput('config-invalid', [{ code: 'config-invalid', detail: '--bridge package does not match the current proof evidence' }])
    }

    let corpusText
    try { corpusText = await readUtf8(join(paths.model, manifest.conformance.corpus), 'corpus') } catch (error) {
      if (BLOCKING.has(error.code)) return blockedOutput(error.code, [{ code: error.code, detail: error.detail ?? 'the corpus is unreadable' }])
      throw error
    }
    try { corpus = parseCorpus(corpusText, manifest) } catch (error) {
      if (BLOCKING.has(error.code)) return blockedOutput(error.code, [{ code: error.code, detail: error.detail ?? 'the corpus is invalid' }])
      throw error
    }

    // 2. snapshot the execution closure before anything executes.
    let executionFiles
    try { executionFiles = await executionFilesFor(paths.root, paths.modelRelative, manifest, io, bridge?.entries ?? []) } catch (error) {
      if (BLOCKING.has(error.code)) return blockedOutput(error.code, [{ code: error.code, detail: error.detail ?? 'the execution closure is incomplete' }])
      throw error
    }
    const node = nodeIdentity()
    const executionDigestValue = executionDigestOf(executionFiles, node, proof.evidence.inputDigest)
    const runner = await runnerIdentityOf(SKILL_DIR)
    if (cancelled()) return output('incomplete', { reason: { code: 'cancelled', detail: { message: 'cancelled before execution' } }, runId, model: paths.modelRelative })

    const runDir = join(paths.root, '.formal-design/lean', paths.modelId, runId)
    const workspace = join(runDir, 'workspace')
    const phases = []
    const finish = async ({ conformanceVerdict, reason, caseCount = corpus.length, matchedCount = 0, firstMismatch = null }) => {
      const evidence = {
        schemaVersion: bridge ? 2 : 1,
        backend: 'lean',
        modelId: manifest.modelId,
        runId,
        proofRunId: proof.evidence.runId,
        proofInputDigest: proof.evidence.inputDigest,
        executionFiles,
        executionDigest: executionDigestValue,
        ...(bridge ? { bridgeFiles: bridge.entries } : {}),
        runnerDigest: runner.digest,
        toolchain,
        conformanceVerdict,
        reason,
        caseCount,
        matchedCount,
        firstMismatch,
        phases,
        startedAt,
        finishedAt: new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString(),
      }
      validateConformanceEvidence(evidence, manifest)
      const { evidenceSha256 } = await publishConformance({ modelDir: paths.model, runDir, evidence, io })
      return output(conformanceVerdict, {
        reason: evidence.reason,
        runId,
        model: paths.modelRelative,
        proofRunId: evidence.proofRunId,
        executionDigest: executionDigestValue,
        evidenceSha256,
        caseCount,
        matchedCount,
        firstMismatch,
        phases: phases.map(({ id, exitCode, timedOut, cancelled: wasCancelled, overflowed }) => ({ id, exitCode, timedOut, cancelled: wasCancelled, overflowed })),
      })
    }
    const stopFailure = (error, verdict = 'incomplete') => finish({
      conformanceVerdict: error.verdict ?? verdict,
      reason: { code: error.code, detail: { phase: phases.at(-1)?.id ?? null, message: error.detail } },
      matchedCount: 0,
    })

    // 3. fresh workspace with only the three project sources and the trusted driver.
    await io.mkdir(workspace, { recursive: true })
    for (const name of [...PROOF_SOURCES, 'Driver.lean']) {
      const source = name === 'Driver.lean' ? join(SKILL_LEAN, 'Driver.lean') : join(paths.model, name)
      await io.copyFile(source, join(workspace, name))
    }
    // The bytes compiled must be the bytes the proof run hashed.
    for (const entry of proof.evidence.inputFiles) {
      if (!PROOF_SOURCES.includes(entry.path)) continue
      if (await hashFile(join(workspace, entry.path)) !== entry.sha256) {
        return finish({ conformanceVerdict: 'incomplete', reason: { code: 'input-changed', detail: { phase: 'snapshot', message: `${entry.path} changed between snapshot and staging` } } })
      }
    }

    // The whole comparison phase shares one budget, process startup included.
    const leanBinary = join(leanRoot, 'bin', 'lean')
    const leanOptions = [`-DmaxHeartbeats=${manifest.limits.maxHeartbeats}`, `-DmaxRecDepth=${manifest.limits.maxRecDepth}`, '-D', 'Elab.async=false']
    const deadline = Date.now() + manifest.limits.conformanceTimeoutMs
    const runStep = (id, argv, cwd, env, stdin) => runPhase(argv, {
      cwd, env, stdin, timeoutMs: Math.max(0, deadline - Date.now()), signal, dir: join(runDir, id),
    })
    const stopReason = result => {
      if (result.timedOut) return { code: 'timeout', detail: `phase exceeded the ${manifest.limits.conformanceTimeoutMs}ms conformance budget` }
      if (result.cancelled) return { code: 'cancelled', detail: 'phase cancelled' }
      if (result.overflowed) return { code: 'stream-overflow', detail: 'phase stream exceeded the 50 MiB cap' }
      if (result.termSignal) return { code: 'signal', detail: `phase terminated by ${result.termSignal}` }
      if (result.spawnFailed) return { code: 'io', detail: 'phase could not start its child process' }
      return null
    }

    for (const [id, module] of REBUILD) {
      if (cancelled()) return finish({ conformanceVerdict: 'incomplete', reason: { code: 'cancelled', detail: { phase: id, message: 'cancelled before phase' } } })
      const result = await runStep(id, [leanBinary, ...leanOptions, '-o', `${module}.olean`, `${module}.lean`], workspace, leanChildEnvironment(workspace))
      phases.push(phaseRecord(paths.root, id, result))
      if (result.lostOutput) return stopFailure({ code: 'io', detail: `phase ${id} stream persistence failed` })
      const stopped = stopReason(result)
      if (stopped) return stopFailure(stopped)
      // The proof was already accepted; a rebuild failure is not a proof verdict.
      if (result.exitCode !== 0) return stopFailure({ code: 'output-invalid', detail: `Lean reported an error while rebuilding ${module}.lean` })
    }

    // Driver phase: the trusted reference over the whole corpus, stdin closed after it.
    await hooks.beforeDriver?.({ workspace })
    const stdin = protocolInput(corpus)
    const driver = await runStep('driver', [leanBinary, ...leanOptions, '--run', 'Driver.lean'], workspace, leanChildEnvironment(workspace), stdin)
    phases.push(phaseRecord(paths.root, 'driver', driver))
    if (driver.lostOutput) return stopFailure({ code: 'io', detail: 'the driver phase stream persistence failed' })
    const driverStopped = stopReason(driver)
    if (driverStopped) return stopFailure(driverStopped)
    // The reference is runner-side: its own protocol failure cannot prove an
    // implementation mismatch, so it is incomplete rather than failed.
    if (driver.exitCode !== 0) return stopFailure({ code: 'output-invalid', detail: 'the reference driver did not complete cleanly' })
    let reference
    try { reference = parseOutput(await readUtf8(join(runDir, 'driver', 'stdout.log'), 'driver output'), corpus, 'reference') } catch (error) {
      return stopFailure({ code: error.code === 'protocol-invalid' ? 'protocol-invalid' : 'output-invalid', detail: error.detail ?? 'the reference output is invalid' })
    }

    // Adapter phase in place: cwd is the model directory, so conformance/adapter.mjs
    // resolves exactly as declared (design section 7).
    await hooks.beforeAdapter?.({ model: paths.model })
    const adapter = await runStep('adapter', [...manifest.conformance.command], paths.model, leanEnvironment(), stdin)
    phases.push(phaseRecord(paths.root, 'adapter', adapter))
    if (adapter.lostOutput) return stopFailure({ code: 'io', detail: 'the adapter phase stream persistence failed' })
    const adapterStopped = stopReason(adapter)
    if (adapterStopped) return stopFailure(adapterStopped)
    // A thrown exception or a nonzero exit fails even when prior lines matched;
    // its text is never compared (design section 7).
    if (adapter.exitCode !== 0) return stopFailure({ code: 'protocol-invalid', detail: `the adapter exited with code ${adapter.exitCode}`, verdict: 'failed' })
    let implementation
    try { implementation = parseOutput(await readUtf8(join(runDir, 'adapter', 'stdout.log'), 'adapter output'), corpus, 'implementation') } catch (error) {
      return stopFailure({ code: 'protocol-invalid', detail: error.detail ?? 'the implementation output is invalid', verdict: 'failed' })
    }

    // Execution closure: any change during the phase means the run is not evidence.
    await hooks.afterAdapter?.({ runDir })
    let after = null
    try { after = await executionFilesFor(paths.root, paths.modelRelative, manifest, io, bridge?.entries ?? []) } catch { after = null }
    if (after === null || executionDigestOf(after, node, proof.evidence.inputDigest) !== executionDigestValue) {
      return stopFailure({ code: 'input-changed', detail: 'the execution closure changed during the conformance run' })
    }
    const runnerAgain = await runnerIdentityOf(SKILL_DIR).catch(() => null)
    if (!runnerAgain || runnerAgain.digest !== runner.digest || JSON.stringify(runnerAgain.package) !== JSON.stringify(runner.package)) {
      return stopFailure({ code: 'artifact-changed', detail: 'runner artifacts changed during the conformance run' })
    }

    // Compare phase: canonical comparison in corpus order, persisted as a hashed
    // phase artifact (design section 8).
    await hooks.beforeCompare?.({ runDir })
    const report = compareOutputs(reference, implementation, corpus)
    const compareDir = join(runDir, 'compare')
    await io.mkdir(compareDir, { recursive: true })
    await io.writeFile(join(compareDir, 'stdout.log'), '')
    await io.writeFile(join(compareDir, 'stderr.log'), '')
    const reportBytes = Buffer.from(JSON.stringify(report) + '\n')
    await io.writeFile(join(compareDir, 'comparison-report.json'), reportBytes)
    phases.push({
      id: 'compare',
      // In-process runner step, not a child process (there is no `compare` child).
      argv: ['compare'],
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      overflowed: false,
      stdout: { path: relativePath(paths.root, join(compareDir, 'stdout.log')), bytes: 0, sha256: sha256(Buffer.alloc(0)) },
      stderr: { path: relativePath(paths.root, join(compareDir, 'stderr.log')), bytes: 0, sha256: sha256(Buffer.alloc(0)) },
      report: { path: reportPath(manifest.modelId, runId), bytes: reportBytes.length, sha256: sha256(reportBytes) },
    })
    const firstMismatch = firstMismatchOf(report, corpus)
    if (firstMismatch === null) return finish({ conformanceVerdict: 'passed', reason: null, matchedCount: report.matchedCount })
    // The closed reason list has no implementation-mismatch code, so the record
    // carries `output-invalid` plus the earliest differing case in firstMismatch.
    return finish({
      conformanceVerdict: 'failed',
      reason: { code: 'output-invalid', detail: { phase: 'compare', caseId: firstMismatch.id, message: 'the implementation result differs from the reference' } },
      matchedCount: report.matchedCount,
      firstMismatch,
    })
  } catch (error) {
    diagnostic(error.detail ?? error.message ?? 'lean-check-conformance failed')
    if (BLOCKING.has(error.code)) return blockedOutput(error.code, [{ code: error.code, detail: error.detail ?? 'conformance run blocked' }])
    if (cancelled()) return output('incomplete', { reason: { code: 'cancelled', detail: { message: 'cancelled' } }, runId })
    return output('incomplete', { reason: { code: 'io', detail: { message: error.detail ?? error.message ?? 'conformance run failed' } }, runId })
  } finally {
    try { await releaseLock(lock, { io }) } catch { diagnostic('owned-lock cleanup failed; inspect recorded ownership before removal') }
  }
}

export const exitCode = status => ({ passed: 0, failed: 1, blocked: 2, incomplete: 3 })[status]

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseLeanSyntax(argv) } catch (error) {
    process.stdout.write(JSON.stringify(output('blocked', { reason: { code: 'config-invalid', detail: { message: error.detail ?? 'invalid arguments' } }, blockers: [{ code: 'config-invalid', detail: error.detail ?? 'invalid arguments' }] })) + '\n')
    return 2
  }
  if (options.help) {
    process.stdout.write('lean-check-conformance --project <root> --model specs/lean/<id> --lean-root <root> [--bridge specs/formal/<id>/bridge.json]\n')
    return 0
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  const result = await executeLeanConformance(options, { signal: controller.signal })
  process.stdout.write(JSON.stringify(result) + '\n')
  return exitCode(result.status)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
