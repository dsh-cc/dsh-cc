import { spawn as nodeSpawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicJson, ensureWritable, exists, fail, hashFile, parseFlags, readJson, runCli, sha256Text, SCRIPTS_DIR } from './storage.lib.mjs'
import { prepareAttemptBuild } from './mathlib-env.mjs'

// L2 formal proof check with proof binding (design §4.1, §4.4) — the
// soundness core. Two modes:
//
//   --statement-check: elaborates statement.lean (which declares the theorem
//     with `:= sorry`) in the env wrapper project, tolerates the `sorry`
//     warning IN THIS MODE ONLY, and records the elaborated type of
//     statementDeclName into binding.json (statementTypeText).
//   default (proof check): builds proof.lean — self-contained, never
//     importing the sorry-ed statement — in the attempt's OWN build directory
//     with its own wrapper-lakefile copy (per-attempt isolation, §4.2), then
//     consumes the report JSON produced by Inspector.lean: statementDeclName
//     and proofDeclName declaration checks, definitional-equality of the two
//     recorded elaborated propositions, and the scoped axiom audit of
//     proofDeclName admitting only {propext, Classical.choice, Quot.sound}.
//
// Scoped failure semantics (§4.4): L2 fails on ANY error, on ANY
// sorry-bearing diagnostic — matched by the structured diagnostic's message
// code where Lean provides one, otherwise by substring on the message text
// (the pinned version's sorry warning reads "declaration uses 'sorry'" and is
// unit-tested below) — on axiom-whitelist violation, and on any binding
// failure. Other warnings (unused variable, deprecation, linter) do NOT
// fail. An unparseable run is a failed attempt with the raw text preserved.
//
// Hash binding: the verdict records sha256 of statement.lean + proof.lean +
// binding.json + the env receipt digest; --expect-hashes re-checks them and
// any change invalidates (status failed, class hash-mismatch).

export const ALLOWED_AXIOMS = Object.freeze(['propext', 'Classical.choice', 'Quot.sound'])
// Message codes checked FIRST when Lean's structured output provides one
// (substring is the documented fallback for the pinned toolchain's text).
export const SORRY_MESSAGE_CODES = Object.freeze(['declaration_uses_sorry', 'Lean.declarationUsesSorry'])
export const SORRY_TEXT = /declaration uses '(?:sorry|admit)'|declaration uses sorry|sorryAx/
const QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/
const HEX64 = /^[a-f0-9]{64}$/
const BINDING_FIELDS = ['statementDeclName', 'proofDeclName', 'mathlibRev', 'toolchainDigest', 'statementTypeText', 'statementRecordedAt', 'timeoutMs']
export const DEFAULT_TIMEOUT_MS = 300000

const SUBJECT = 'Attempt' // staged module name inside the attempt build dir

// ---------------------------------------------------------------------------
// Diagnostics parsing (§4.4 own-report-JSON; unparseable preserved verbatim)
// ---------------------------------------------------------------------------
const HUMAN_DIAG = /^(.+?):([0-9]+):([0-9]+): (info|information|warning|error): (.*)$/

export function parseDiagnostics(text) {
  const diagnostics = []
  const rawLines = []
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue
    const human = HUMAN_DIAG.exec(line)
    if (human) {
      diagnostics.push({ file: human[1], line: Number(human[2]), col: Number(human[3]), severity: human[4] === 'information' ? 'info' : human[4], message: human[5], code: null })
      continue
    }
    if (line.startsWith('{')) {
      try {
        const message = JSON.parse(line)
        if (message && typeof message === 'object' && (message.severity || message.data || message.message)) {
          diagnostics.push({
            file: message.pos?.fileName ?? message.file ?? '<unknown>',
            line: Number(message.pos?.line ?? message.line ?? 0),
            col: Number(message.pos?.column ?? message.col ?? 0),
            severity: message.severity ?? 'error',
            message: [message.caption, message.data ?? message.message].filter(part => typeof part === 'string' && part).join('\n'),
            code: typeof message.code === 'string' ? message.code : null,
          })
          continue
        }
      } catch { /* not a JSON diagnostic: falls through to continuation/raw */ }
    }
    const last = diagnostics.at(-1)
    if (last && /^\s/.test(line)) last.message += `\n${line}`
    else rawLines.push(line)
  }
  return { diagnostics, raw: rawLines.length ? rawLines.join('\n') : null }
}

/** Message code first (when Lean provides one), substring fallback otherwise. */
export const isSorryDiagnostic = diagnostic =>
  diagnostic.code !== null
    ? SORRY_MESSAGE_CODES.includes(diagnostic.code)
    : SORRY_TEXT.test(diagnostic.message)

// ---------------------------------------------------------------------------
// binding.json (§4.1)
// ---------------------------------------------------------------------------
export const bindingPath = problemDir => join(problemDir, 'binding.json')

export async function loadBinding(problemDir) {
  const binding = await readJson(bindingPath(problemDir), 'binding.json')
  assert(binding && typeof binding === 'object' && !Array.isArray(binding), 'binding.json must be an object')
  const unknown = Object.keys(binding).filter(key => !BINDING_FIELDS.includes(key))
  assert(unknown.length === 0, `binding.json has unknown field(s): ${unknown.join(',')}`)
  assert(QUALIFIED.test(binding.statementDeclName ?? ''), 'binding.json statementDeclName must be a dot-separated Lean identifier')
  assert(QUALIFIED.test(binding.proofDeclName ?? ''), 'binding.json proofDeclName must be a dot-separated Lean identifier')
  assert(typeof binding.mathlibRev === 'string' && binding.mathlibRev.length > 0, 'binding.json mathlibRev is required')
  assert(HEX64.test(binding.toolchainDigest ?? ''), 'binding.json toolchainDigest must be lowercase sha256 hex (the env receipt leanDigest)')
  if (binding.statementTypeText !== undefined) assert(typeof binding.statementTypeText === 'string' && binding.statementTypeText.length > 0, 'binding.json statementTypeText must be a non-empty string')
  if (binding.timeoutMs !== undefined) assert(Number.isInteger(binding.timeoutMs) && binding.timeoutMs >= 1000 && binding.timeoutMs <= 1800000, 'binding.json timeoutMs must be in 1000..1800000')
  return binding
}

/** sha256 of statement.lean + proof.lean + binding.json + env receipt digest (§4.4). */
export async function computeHashBinding(problemDir, receiptDigest) {
  const statementPath = join(problemDir, 'statement.lean')
  const proofPath = join(problemDir, 'proof.lean')
  const statement = (await exists(statementPath)) ? await hashFile(statementPath) : null
  const proof = (await exists(proofPath)) ? await hashFile(proofPath) : null
  const binding = await hashFile(bindingPath(problemDir))
  const hashes = { statement, proof, binding, envReceiptDigest: receiptDigest }
  return { ...hashes, combined: sha256Text(JSON.stringify(hashes)) }
}

async function loadReceipt(envDir) {
  const path = join(envDir, 'env.receipt.json')
  try { return await readJson(path, 'env receipt') }
  catch (e) { if (e.code === 'ENOENT') fail('toolchain-missing', `no env receipt at ${path}; provision the environment first`); throw e }
}

// ---------------------------------------------------------------------------
// Default Lean invocation (subprocess timeout/signal discipline,
// lean-process.lib precedent): SIGTERM then SIGKILL, per-stream caps.
// ---------------------------------------------------------------------------
const STREAM_CAP = 10 * 1024 * 1024
async function defaultInvokeLean({ phase, argv, cwd, timeoutMs }) {
  const started = Date.now()
  return new Promise(resolveRun => {
    let child
    try { child = nodeSpawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (e) { resolveRun({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: e.message, elapsedMs: 0 }); return }
    let stdout = ''
    let stderr = ''
    let capped = false
    const append = (which, chunk) => {
      const text = chunk.toString('utf8')
      if (which === 0) { if (stdout.length < STREAM_CAP) stdout += text.slice(0, STREAM_CAP - stdout.length) } else if (stderr.length < STREAM_CAP) stderr += text.slice(0, STREAM_CAP - stderr.length)
      if (text.length > (which === 0 ? STREAM_CAP - stdout.length : STREAM_CAP - stderr.length) && !capped) capped = true
    }
    child.stdout.on('data', chunk => append(0, chunk))
    child.stderr.on('data', chunk => append(1, chunk))
    let timedOut = false
    const kill = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, 2000).unref()
    }, timeoutMs)
    child.once('error', e => { clearTimeout(kill); resolveRun({ exitCode: null, stdout, stderr, timedOut: false, spawnError: e.message, elapsedMs: Date.now() - started }) })
    child.once('close', exitCode => { clearTimeout(kill); resolveRun({ exitCode, stdout, stderr, timedOut, capped, elapsedMs: Date.now() - started }) })
  })
}

// ---------------------------------------------------------------------------
// Inspector report (produced by Inspector.lean at runtime; mocked in tests)
// ---------------------------------------------------------------------------
function readInspectorReport(text) {
  let report
  try { report = JSON.parse(text) } catch { fail('unparseable', 'the inspector report is not valid JSON') }
  assert(report && report.schemaVersion === 1, 'inspector report must be schemaVersion 1', 'unparseable')
  return report
}

function assembleReport({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure, typeInfo = {}, axioms = null }) {
  return {
    schemaVersion: 1,
    command: 'lean-run',
    mode,
    status: failure ? 'failed' : 'passed',
    failure: failure ?? null,
    problem: resolve(problemDir),
    buildDir,
    diagnostics,
    rawDiagnostics: raw,
    binding: {
      statementDeclName: binding.statementDeclName,
      proofDeclName: binding.proofDeclName,
      statementTypeText: typeInfo.statementTypeText ?? binding.statementTypeText ?? null,
      proofTypeText: typeInfo.proofTypeText ?? null,
      typesMatch: typeInfo.typesMatch ?? null,
    },
    axioms,
    hashes,
  }
}

/**
 * The full L2 check. `deps.invokeLean` runs one `phase` ('build' |
 * 'inspector') in the prepared attempt build dir and returns
 * { exitCode, stdout, stderr, timedOut }; the inspector phase additionally
 * leaves <build>/inspector-report.json, whose defeq/axiom verdict this
 * function consumes (Inspector pattern, §3.2).
 */
export async function runLeanRun(options, deps = {}) {
  const { io = fs, invokeLean = defaultInvokeLean, now = () => new Date().toISOString() } = deps
  const mode = options.statementCheck ? 'statement-check' : 'proof-check'
  const problemDir = resolve(options.problem)
  const binding = await loadBinding(problemDir)
  const receipt = await loadReceipt(resolve(options.env))
  assert(receipt?.pin?.mathlib?.rev === binding.mathlibRev, `env receipt rev ${receipt?.pin?.mathlib?.rev} does not match binding mathlibRev ${binding.mathlibRev}`, 'receipt-invalid')
  assert(receipt?.leanDigest === binding.toolchainDigest, 'env receipt leanDigest does not match binding toolchainDigest', 'receipt-invalid')
  const receiptDigest = await hashFile(join(resolve(options.env), 'env.receipt.json'))
  const hashes = await computeHashBinding(problemDir, receiptDigest)
  if (!options.statementCheck) assert(hashes.proof !== null, 'proof.lean is missing in the problem dir')

  const buildDir = options.buildDir
    ? resolve(options.buildDir)
    : join(problemDir, 'attempts', options.statementCheck ? '_statement-check' : (options.attemptId ?? '_check'), 'build')
  await prepareAttemptBuild(resolve(options.env), buildDir, { io })
  const sourceName = options.statementCheck ? 'statement.lean' : 'proof.lean'
  await io.copyFile(join(problemDir, sourceName), join(buildDir, `${SUBJECT}.lean`))
  await io.copyFile(join(SCRIPTS_DIR, 'Inspector.lean'), join(buildDir, 'Inspector.lean'))

  // Hash-binding invalidation first: any input change voids the expectation.
  if (options.expectHashes) {
    const expected = await readJson(options.expectHashes, 'expected hashes')
    const mismatches = Object.entries(expected).filter(([key, value]) => key in hashes && hashes[key] !== value).map(([key]) => key)
    if (mismatches.length) {
      return finish({ mode, problemDir, buildDir, diagnostics: [], raw: null, binding, hashes, axioms: null, failure: { class: 'hash-mismatch', detail: `hash binding invalidated: ${mismatches.join(', ')} changed` } })
    }
  }

  const inputs = options.statementCheck
    ? { schemaVersion: 1, mode: 'statement', statementDeclName: binding.statementDeclName }
    : { schemaVersion: 1, mode: 'binding', statementDeclName: binding.statementDeclName, statementTypeText: binding.statementTypeText ?? null, proofDeclName: binding.proofDeclName }
  if (!options.statementCheck && !binding.statementTypeText) {
    return finish({ mode, problemDir, buildDir, diagnostics: [], raw: null, binding, hashes, failure: { class: 'binding', detail: 'statementTypeText is not recorded; run --statement-check first' } })
  }
  await io.writeFile(join(buildDir, 'inspector-inputs.json'), JSON.stringify(inputs) + '\n')

  const timeoutMs = options.timeoutMs ?? binding.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const lake = join(resolve(options.env), 'lean', 'bin', 'lake')
  const build = await invokeLean({ phase: 'build', argv: [lake, 'env', 'lean', `${SUBJECT}.lean`], cwd: buildDir, timeoutMs })
  const combinedOutput = `${build.stdout ?? ''}\n${build.stderr ?? ''}`
  const { diagnostics, raw } = parseDiagnostics(combinedOutput)

  if (build.timedOut) return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'timeout', detail: `build exceeded the ${timeoutMs}ms budget` } })
  if (build.spawnError || build.exitCode === null) return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'io', detail: `lean could not run: ${build.spawnError ?? 'unknown spawn failure'}` } })
  // (a) any error fails, in BOTH modes.
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  if (errors.length) return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'lean-error', detail: `${errors.length} error diagnostic(s)` } })
  // (b) sorry-bearing diagnostics fail proof mode; statement-check tolerates
  // exactly these and no other failure class.
  const sorries = diagnostics.filter(isSorryDiagnostic)
  if (!options.statementCheck && sorries.length) return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'sorry', detail: 'proof mode tolerates no sorry-bearing diagnostic' } })
  if (raw !== null) return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'unparseable', detail: 'unparseable diagnostics output; raw text preserved' } })
  if (build.exitCode !== 0) return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'lean-error', detail: `lean exited ${build.exitCode} without a structured error diagnostic` } })

  // Inspector phase: declaration existence/kind, defeq of the two recorded
  // propositions, scoped axiom audit (proof mode).
  const inspector = await invokeLean({ phase: 'inspector', argv: [lake, 'env', 'lean', '--run', 'Inspector.lean', 'inspector-inputs.json'], cwd: buildDir, timeoutMs })
  if (inspector.timedOut) return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'timeout', detail: 'the inspector exceeded the time budget' } })
  if (inspector.exitCode !== 0 && inspector.exitCode !== null || inspector.spawnError) {
    return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'unparseable', detail: `the inspector did not complete cleanly${inspector.spawnError ? `: ${inspector.spawnError}` : ''}` } })
  }
  let reportText = null
  try { reportText = await io.readFile(join(buildDir, 'inspector-report.json'), 'utf8') } catch { /* handled below */ }
  if (reportText === null) return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'unparseable', detail: 'the inspector report is missing' } })
  let report
  try { report = readInspectorReport(reportText) }
  catch (error) { return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'unparseable', detail: error.detail ?? 'the inspector report is invalid' } }) }

  if (options.statementCheck) {
    // Record the elaborated type into binding.json (§4.1 statement-check).
    const statement = report.statement ?? {}
    if (statement.declaration !== binding.statementDeclName || !statement.kind || typeof statement.type !== 'string' || !statement.type) {
      return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'binding', detail: `${binding.statementDeclName} was not elaborated in statement.lean` } })
    }
    const updated = { ...binding, statementTypeText: statement.type, statementRecordedAt: now() }
    await atomicJson(bindingPath(problemDir), updated, io)
    const finalHashes = await computeHashBinding(problemDir, receiptDigest)
    return finish({ mode, problemDir, buildDir, diagnostics, raw, binding: updated, hashes: finalHashes, typeInfo: { statementTypeText: statement.type, typesMatch: null } })
  }

  // (c) binding: proofDeclName is a theorem; the elaborated propositions are
  // definitionally equal (the two exact terms, never strings).
  const proof = report.proof ?? {}
  if (proof.declaration !== binding.proofDeclName || proof.kind === null || proof.kind === undefined) {
    return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, failure: { class: 'binding', detail: `${binding.proofDeclName} is not declared in proof.lean` } })
  }
  if (proof.kind !== 'theorem') {
    return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, typeInfo: { proofTypeText: proof.type ?? null }, failure: { class: 'binding', detail: `${binding.proofDeclName} is ${proof.kind}, not a theorem` } })
  }
  if (report.typesMatch !== true) {
    return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, typeInfo: { proofTypeText: proof.type ?? null, typesMatch: report.typesMatch ?? null }, failure: { class: 'binding', detail: 'the elaborated proposition of proofDeclName is not definitionally equal to the recorded statement type' } })
  }
  // (d) scoped axiom audit of proofDeclName only.
  const axioms = Array.isArray(report.axioms) ? report.axioms.map(String) : null
  if (axioms === null) return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, typeInfo: { proofTypeText: proof.type ?? null, typesMatch: true }, failure: { class: 'binding', detail: 'the inspector did not audit the axioms of proofDeclName' } })
  const bad = axioms.filter(name => !ALLOWED_AXIOMS.includes(name))
  if (bad.length) {
    return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, axioms, typeInfo: { proofTypeText: proof.type ?? null, typesMatch: true }, failure: { class: 'axiom-violation', detail: `axioms outside the whitelist: ${bad.join(', ')}` } })
  }
  return finish({ mode, problemDir, buildDir, diagnostics, raw, binding, hashes, axioms, typeInfo: { proofTypeText: proof.type ?? null, typesMatch: true } })

  function finish(fields) { return assembleReport({ ...fields, binding: fields.binding ?? binding }) }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'lean-run — single-file Lean check with proof binding (design §4.1, §4.4)',
  'usage: lean-run.mjs --problem <dir> --env <env-dir> [--statement-check] [--build-dir <dir>] [--attempt-id <id>] [--timeout-ms n] [--expect-hashes <hashes.json>]',
  '  --statement-check  elaborate statement.lean (sorry tolerated HERE ONLY) and record its type in binding.json',
  '  default mode       build proof.lean in the per-attempt build dir; binding + scoped axiom audit via Inspector.lean',
  'failures: lean-error · sorry · unparseable · binding · axiom-violation · timeout · io · hash-mismatch',
  'exit codes: 0 passed · 1 failed · 2 blocked (config-invalid, receipt-invalid, toolchain-missing) · single-line JSON on stdout',
].join('\n')

async function handle(argv, deps = {}) {
  const options = parseFlags(argv, ['problem', 'env', 'statement-check', 'build-dir', 'attempt-id', 'timeout-ms', 'expect-hashes'], { required: ['problem', 'env'], booleans: ['statement-check'] })
  if (options.help) return 'help'
  await ensureWritable(options.problem)
  const timeoutMs = options['timeout-ms'] === undefined ? undefined : Number(options['timeout-ms'])
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000)) fail('config-invalid', '--timeout-ms must be an integer in 1000..1800000')
  const report = await runLeanRun({
    problem: options.problem,
    env: options.env,
    statementCheck: Boolean(options['statement-check']),
    buildDir: options['build-dir'] ?? null,
    attemptId: options['attempt-id'] ?? null,
    timeoutMs,
    expectHashes: options['expect-hashes'] ?? null,
  }, deps)
  return { exitCode: report.status === 'passed' ? 0 : 1, report }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli('lean-run', HELP, argv, (args => handle(args, deps)))
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
