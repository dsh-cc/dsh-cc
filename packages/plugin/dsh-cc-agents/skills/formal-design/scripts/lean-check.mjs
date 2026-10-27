import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { leanPreflight, parseLeanSyntax } from './lean-preflight.mjs'
import { LEAN_SPEC_VERSION, PROOF_SOURCES, REASON_CODES as CONFIG_REASON_CODES, parseJsonTokens } from './lean-manifest.lib.mjs'
import { hashFile, posix } from './lean-fingerprint.lib.mjs'
import { leanChildEnvironment, runLeanPhase } from './lean-process.lib.mjs'
import {
  acquireLock, incompleteInspectorReport, lockPathFor, proofInputDigest, proofInputFiles,
  publishProof, releaseLock, runnerDigest, runnerFiles, runnerPackage, validateInspectorReport, validateProofEvidence,
} from './lean-evidence.lib.mjs'

const SKILL_DIR = fileURLToPath(new URL('..', import.meta.url))
const SKILL_LEAN = join(SKILL_DIR, 'lean')
const SHIPPED = ['Inspector.lean', 'Driver.lean']
// A warning that admits an incomplete proof is a failure even when the axiom
// audit is clean (design section 6, step 7).
const INCOMPLETE_PROOF = /declaration uses '(?:sorry|admit)'|sorryAx|usesSorry/

function output(status, fields = {}) {
  return { schemaVersion: 1, command: 'lean-check', status, reason: null, runId: null, model: null, inputDigest: null, evidenceSha256: null, properties: [], phases: [], blockers: [], ...fields }
}
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
 * One proof run: lock, snapshot, fresh workspace, the fixed build sequence, the
 * shipped inspector, then atomic evidence publication (design section 6).
 */
export async function executeLeanCheck(options, deps = {}) {
  const {
    preflight = leanPreflight, runPhase = runLeanPhase, io = fs, signal, hooks = {},
    diagnostic = message => process.stderr.write(message + '\n'),
  } = deps
  const cancelled = () => signal?.aborted
  let lock = null
  let runId = null
  let startedAt = null
  try {
    if (cancelled()) return output('incomplete', { reason: { code: 'cancelled', detail: { message: 'cancelled before start' } } })
    const ready = await preflight(options, { signal })
    if (cancelled()) return output('incomplete', { reason: { code: 'cancelled', detail: { message: 'cancelled during preflight' } } })
    if (ready.output.status === 'blocked') return blockedOutput(ready.output.reason, ready.output.blockers)
    const { paths, manifest, leanRoot, toolchain } = ready
    if (!toolchain) return blockedOutput('toolchain-missing', [{ code: 'toolchain-missing', detail: 'installation identity is unavailable' }])

    // 1. exclusive per-model lock.
    startedAt = new Date().toISOString()
    runId = randomUUID()
    try { lock = await acquireLock(lockPathFor(paths.root, paths.modelId), runId, startedAt, { io }) }
    catch (error) {
      if (error.code === 'lock-conflict') return blockedOutput('lock-conflict', [{ code: 'lock-conflict', detail: error.detail ?? 'model lock conflict' }])
      throw error
    }

    // 2. snapshot exact input bytes and identity before compiling anything.
    const inputFiles = await proofInputFiles(paths.model)
    const inputDigest = proofInputDigest(inputFiles)
    const runnerEntries = await runnerFiles(SKILL_DIR)
    const runnerDigestValue = runnerDigest(runnerEntries)
    const runner = await runnerPackage()
    if (cancelled()) return output('incomplete', { reason: { code: 'cancelled', detail: { message: 'cancelled before execution' } }, runId, inputDigest })

    const runDir = join(paths.root, '.formal-design/lean', paths.modelId, runId)
    const workspace = join(runDir, 'workspace')
    const phases = []
    const finish = async (evidenceFields) => {
      const evidence = {
        schemaVersion: 1,
        backend: 'lean',
        modelId: manifest.modelId,
        runId,
        inputFiles,
        inputDigest,
        runnerFiles: runnerEntries,
        runnerDigest: runnerDigestValue,
        runnerPackage: runner,
        toolchain,
        proofVerdict: evidenceFields.proofVerdict,
        reason: evidenceFields.reason,
        properties: evidenceFields.properties,
        phases,
        startedAt,
        finishedAt: new Date(Math.max(Date.now(), Date.parse(startedAt))).toISOString(),
      }
      validateProofEvidence(evidence, manifest)
      const { evidenceSha256 } = await publishProof({ modelDir: paths.model, runDir, evidence, io })
      return output(evidence.proofVerdict, {
        reason: evidence.reason,
        runId,
        model: paths.modelRelative,
        inputDigest,
        evidenceSha256,
        properties: evidence.properties.map(({ id, declaration, verdict }) => ({ id, declaration, verdict })),
        phases: phases.map(({ id, exitCode, timedOut, cancelled: wasCancelled, overflowed }) => ({ id, exitCode, timedOut, cancelled: wasCancelled, overflowed })),
      })
    }

    // 3. fresh empty workspace with only the three project sources and the two
    // shipped runner sources; never `.olean`, native libraries, C output or
    // Lake artifacts.
    await io.mkdir(workspace, { recursive: true })
    for (const name of [...PROOF_SOURCES, ...SHIPPED]) {
      const source = PROOF_SOURCES.includes(name) ? join(paths.model, name) : join(SKILL_LEAN, name)
      await io.copyFile(source, join(workspace, name))
    }
    // The bytes compiled must be the bytes hashed (step 2).
    for (const entry of inputFiles) {
      if (!PROOF_SOURCES.includes(entry.path)) continue
      if (await hashFile(join(workspace, entry.path)) !== entry.sha256) {
        return finish({ proofVerdict: 'incomplete', reason: { code: 'input-changed', detail: { message: `${entry.path} changed between snapshot and staging` } }, properties: incompleteInspectorReport(null, manifest.properties).properties })
      }
    }

    const inspectorInputs = {
      schemaVersion: 1,
      properties: manifest.properties.map(({ id, declaration, statement, witnessDeclaration }) => ({ id, declaration, statement, witnessDeclaration })),
    }
    await io.writeFile(join(workspace, 'inspector-inputs.json'), JSON.stringify(inspectorInputs) + '\n')

    // 4-5. the fixed build sequence under one proof budget that covers startup.
    const leanBinary = join(leanRoot, 'bin', 'lean')
    const options_ = [`-DmaxHeartbeats=${manifest.limits.maxHeartbeats}`, `-DmaxRecDepth=${manifest.limits.maxRecDepth}`, '-D', 'Elab.async=false']
    const deadline = Date.now() + manifest.limits.proofTimeoutMs
    const runStep = async (id, argv) => {
      const remaining = deadline - Date.now()
      const result = await runPhase(argv, {
        cwd: workspace, env: leanChildEnvironment(workspace), timeoutMs: remaining, signal, dir: join(runDir, id),
      })
      return result
    }
    // Classify one phase that did not complete cleanly, in design section 8 order.
    const stopReason = result => {
      if (result.timedOut) return { code: 'timeout', detail: `phase exceeded the ${manifest.limits.proofTimeoutMs}ms proof budget` }
      if (result.cancelled) return { code: 'cancelled', detail: 'phase cancelled' }
      if (result.overflowed) return { code: 'stream-overflow', detail: 'phase stream exceeded the 50 MiB cap' }
      if (result.termSignal) return { code: 'signal', detail: `phase terminated by ${result.termSignal}` }
      if (result.spawnFailed) return { code: 'io', detail: 'phase could not start its child process' }
      return null
    }
    const notChecked = () => incompleteInspectorReport(null, manifest.properties).properties

    const compile = async (id, module) => {
      if (cancelled()) return { code: 'cancelled', detail: 'cancelled before phase' }
      const result = await runStep(id, [leanBinary, ...options_, '-o', `${module}.olean`, `${module}.lean`])
      phases.push(phaseRecord(paths.root, id, result))
      if (result.lostOutput) return { code: 'io', detail: `phase ${id} stream persistence failed`, verdict: 'incomplete' }
      const stopped = stopReason(result)
      if (stopped) return { ...stopped, verdict: 'incomplete' }
      if (result.exitCode !== 0) return { code: 'output-invalid', detail: `Lean reported an error while compiling ${module}.lean`, verdict: 'rejected' }
      return null
    }

    let inspectorReport = null
    let inspectorReportArtifact = null
    let failure = null
    for (const [id, module] of [['compile-model', 'Model'], ['compile-properties', 'Properties'], ['compile-reference', 'Reference'], ['compile-inspector', 'Inspector'], ['driver', 'Driver']]) {
      failure = await compile(id, module)
      if (failure) break
    }
    if (failure) {
      return finish({ proofVerdict: failure.verdict ?? 'incomplete', reason: { code: failure.code, detail: { phase: phases.at(-1)?.id ?? null, message: failure.detail } }, properties: notChecked() })
    }

    // 5. run the shipped inspector in the same workspace.
    await hooks.beforeInspector?.({ workspace })
    {
      const result = await runStep('inspector', [leanBinary, ...options_, '--run', 'Inspector.lean', 'inspector-inputs.json'])
      const reportPath = join(workspace, 'inspector-report.json')
      let raw = null
      try { raw = await io.readFile(reportPath, 'utf8') } catch { /* reported as a missing report below */ }
      if (raw !== null) {
        const stat = await io.stat(reportPath)
        inspectorReportArtifact = { path: relativePath(paths.root, reportPath), bytes: stat.size, sha256: await hashFile(reportPath) }
      }
      phases.push(phaseRecord(paths.root, 'inspector', result, inspectorReportArtifact))
      const stopped = stopReason(result)
      if (stopped) return finish({ proofVerdict: 'incomplete', reason: { code: stopped.code, detail: { phase: 'inspector', message: stopped.detail } }, properties: notChecked() })
      if (result.exitCode !== 0) return finish({ proofVerdict: 'incomplete', reason: { code: 'output-invalid', detail: { phase: 'inspector', message: 'the inspector did not complete cleanly' } }, properties: notChecked() })
      if (raw === null) return finish({ proofVerdict: 'incomplete', reason: { code: 'output-invalid', detail: { phase: 'inspector', message: 'the inspector report is missing' } }, properties: notChecked() })
      try {
        inspectorReport = validateInspectorReport(parseJsonTokens(raw), manifest.properties)
        if (inspectorReport.toolchainVersion !== LEAN_SPEC_VERSION) throw Object.assign(new Error('toolchain mismatch'), { detail: `the inspector reported toolchain ${JSON.stringify(inspectorReport.toolchainVersion)}` })
      } catch (error) {
        return finish({ proofVerdict: 'incomplete', reason: { code: 'output-invalid', detail: { phase: 'inspector', message: error.detail ?? error.message ?? 'the inspector report is invalid' } }, properties: notChecked() })
      }
    }

    // 6-7. audit result and warnings.
    const properties = inspectorReport.properties
    // A property the inspector could not check is missing report coverage, not a
    // rejection (design section 8); a reported rejection names its properties.
    const unchecked = properties.filter(property => property.verdict === 'not-checked')
    const rejected = properties.filter(property => property.verdict === 'rejected')
    let warningsIncompleteProof = false
    for (const phase of phases) {
      // Lean reports diagnostics on both streams depending on the invocation.
      for (const stream of ['stdout', 'stderr']) {
        const text = await io.readFile(join(paths.root, phase[stream].path), 'utf8')
        if (INCOMPLETE_PROOF.test(text)) warningsIncompleteProof = true
      }
    }
    if (unchecked.length) {
      return finish({
        proofVerdict: 'incomplete',
        reason: { code: 'output-invalid', detail: { phase: 'inspector', properties: unchecked.map(({ id }) => id), message: 'the inspector report does not cover every property' } },
        properties,
      })
    }
    if (rejected.length) {
      return finish({
        proofVerdict: 'rejected',
        // The closed reason list carries no proof-rejection code, so a rejected
        // run is reported as `output-invalid` and the detail names the rejecting
        // properties and mechanisms; `properties[].verdict` carries the rest.
        reason: { code: 'output-invalid', detail: { phase: 'inspector', properties: rejected.map(({ id, declaration }) => ({ id, declaration })), message: 'the inspector rejected the recorded proof' } },
        properties,
      })
    }
    if (warningsIncompleteProof) {
      return finish({ proofVerdict: 'incomplete', reason: { code: 'output-invalid', detail: { message: 'a phase reported an incomplete proof warning' } }, properties })
    }

    // 8. hash the inputs again before publishing.
    let currentInputDigest = null
    try { currentInputDigest = proofInputDigest(await proofInputFiles(paths.model)) } catch { currentInputDigest = null }
    if (currentInputDigest !== inputDigest) {
      return finish({ proofVerdict: 'incomplete', reason: { code: 'input-changed', detail: { message: 'proof inputs changed during the run' } }, properties })
    }
    // A changed runner is also not evidence for this run.
    try {
      const again = await runnerFiles(SKILL_DIR)
      const againPackage = await runnerPackage()
      if (runnerDigest(again) !== runnerDigestValue || JSON.stringify(againPackage) !== JSON.stringify(runner)) {
        return finish({ proofVerdict: 'incomplete', reason: { code: 'artifact-changed', detail: { message: 'runner artifacts changed during the run' } }, properties })
      }
    } catch {
      return finish({ proofVerdict: 'incomplete', reason: { code: 'artifact-changed', detail: { message: 'runner identity could not be recomputed' } }, properties })
    }

    // 9. atomically publish evidence and its pointer.
    await hooks.beforePublication?.({ runDir })
    return finish({ proofVerdict: 'verified', reason: null, properties })
  } catch (error) {
    diagnostic(error.detail ?? error.message ?? 'lean-check failed')
    if (CONFIG_REASON_CODES.includes(error.code)) return blockedOutput(error.code, [{ code: error.code, detail: error.detail ?? 'proof run blocked' }])
    if (error.code === 'lock-conflict') return blockedOutput('lock-conflict', [{ code: 'lock-conflict', detail: error.detail }])
    if (cancelled()) return output('incomplete', { reason: { code: 'cancelled', detail: { message: 'cancelled' } }, runId })
    return output('incomplete', { reason: { code: 'io', detail: { message: error.detail ?? error.message ?? 'proof run failed' } }, runId })
  } finally {
    try { await releaseLock(lock, { io }) } catch { diagnostic('owned-lock cleanup failed; inspect recorded ownership before removal') }
  }
}

export const exitCode = status => ({ verified: 0, rejected: 1, blocked: 2, incomplete: 3 })[status]

export async function main(argv = process.argv.slice(2)) {
  let options
  try { options = parseLeanSyntax(argv) }
  catch (error) {
    process.stdout.write(JSON.stringify(output('blocked', { reason: { code: 'config-invalid', detail: { message: error.detail ?? 'invalid arguments' } }, blockers: [{ code: 'config-invalid', detail: error.detail ?? 'invalid arguments' }] })) + '\n')
    return 2
  }
  if (options.help) {
    process.stdout.write('lean-check --project <root> --model specs/lean/<id> --lean-root <root>\n')
    return 0
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on('SIGINT', cancel)
  process.on('SIGTERM', cancel)
  const result = await executeLeanCheck(options, { signal: controller.signal })
  process.stdout.write(JSON.stringify(result) + '\n')
  return exitCode(result.status)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
