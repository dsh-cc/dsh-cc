import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assert, atomicJson, ensureWritable, exists, fail, parseFlags, posix, readJson, runCli } from './storage.lib.mjs'
import { loadBinding, runLeanRun } from './lean-run.mjs'

// Reference-anchor check (design §4.3 row 2) — a THIN wrapper around lean-run's
// anchor mode. Inputs: the problem's RECORDED elaborated statement type
// (binding.json statementTypeText, written by lean-run --statement-check) and a
// trusted reference statement file from the benchmark fixtures. It synthesizes
// a comparison problem directory (reference file staged as proof.lean, the
// candidate's binding.json carried over with the reference declaration as
// proofDeclName) and lets the SAME Inspector definitional-equality path decide.
//
// Outcomes (the `anchorCheck` object the gate consumes):
//   passes      the two elaborated propositions are definitionally equal
//   fails       kernel evidence that they are not (design row 3)
//   cannot-run  no kernel verdict was produced (row 4: infra, one retry)
// A reference may be sorry-ed: type equality needs no proof, so anchor mode
// tolerates `sorry` and skips the axiom audit (the reference is trusted
// evidence, never a claim of this run).
//
// `--patch <fidelity-input.json>` records the outcome into the gate's input;
// the evidence record (default `<problem>/anchor-check.json`) is the file
// `anchorCheck.evidenceRef` points at.

const QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/
const ANCHOR_DIR = 'anchor'

const evidenceRefFor = (problemDir, evidencePath) => {
  const rel = posix(relative(problemDir, evidencePath))
  return rel.startsWith('..') ? posix(evidencePath) : rel
}

async function sha256OrNull(path, io) {
  if (!(await exists(path))) return null
  return createHash('sha256').update(await io.readFile(path)).digest('hex')
}

export async function runAnchorCheck(options, deps = {}) {
  const { io = fs, now = () => new Date().toISOString() } = deps
  const problemDir = resolve(options.problem)
  const referencePath = resolve(options.reference)
  const referenceDeclName = options.referenceDecl
  assert(typeof referenceDeclName === 'string' && QUALIFIED.test(referenceDeclName), '--reference-decl must be a dot-separated Lean identifier')
  if (!(await exists(referencePath))) fail('config-invalid', `reference statement file ${referencePath} does not exist`)
  const binding = await loadBinding(problemDir)
  const evidencePath = options.out ? resolve(options.out) : join(problemDir, 'anchor-check.json')
  const evidenceRef = evidenceRefFor(problemDir, evidencePath)
  const referenceSha256 = await sha256OrNull(referencePath, io)
  const statementPath = join(problemDir, 'statement.lean')
  const statementSha256 = await sha256OrNull(statementPath, io)

  const emit = async status => {
    const evidence = {
      schemaVersion: 1,
      command: 'anchor-check',
      status,
      anchorCheck: { status, evidenceRef },
      typesMatch: null,
      reference: { path: referencePath, declName: referenceDeclName, sha256: referenceSha256 },
      statement: { declName: binding.statementDeclName, statementTypeText: binding.statementTypeText ?? null, sha256: statementSha256 },
      leanRun: null,
      checkedAt: now(),
    }
    return evidence
  }

  const detailFor = status =>
    status === 'passes'
      ? 'the reference statement is definitionally equal to the recorded statement type'
      : status === 'fails'
        ? 'the reference statement is NOT definitionally equal to the recorded statement type'
        : 'the comparison produced no kernel verdict'

  let status = 'cannot-run'
  let evidence
  if (!binding.statementTypeText) {
    // Without a recorded type there is nothing to compare: cannot-run (row 4).
    evidence = await emit('cannot-run')
    evidence.detail = 'statementTypeText is not recorded; run lean-run --statement-check first'
  } else {
    // Synthesized comparison dir: reference file as the built module, the
    // candidate's binding carried over with the reference declaration bound.
    const anchorDir = join(problemDir, ANCHOR_DIR)
    await io.mkdir(anchorDir, { recursive: true })
    await io.copyFile(referencePath, join(anchorDir, 'proof.lean'))
    if (statementSha256 !== null) await io.copyFile(statementPath, join(anchorDir, 'statement.lean'))
    await atomicJson(join(anchorDir, 'binding.json'), {
      statementDeclName: binding.statementDeclName,
      proofDeclName: referenceDeclName,
      mathlibRev: binding.mathlibRev,
      toolchainDigest: binding.toolchainDigest,
      statementTypeText: binding.statementTypeText,
    }, io)
    const report = await runLeanRun({
      problem: anchorDir,
      env: options.env,
      anchor: true,
      buildDir: options.buildDir ?? null,
      timeoutMs: options.timeoutMs ?? null,
    }, { io, ...(deps.invokeLean ? { invokeLean: deps.invokeLean } : {}), now })
    const typesMatch = report.binding.typesMatch
    status = report.status === 'passed' && typesMatch === true ? 'passes' : report.failure?.class === 'types-differ' ? 'fails' : 'cannot-run'
    evidence = await emit(status)
    evidence.typesMatch = typesMatch ?? null
    evidence.leanRun = report
    evidence.detail = report.failure?.detail ?? detailFor(status)
  }

  await atomicJson(evidencePath, evidence, io)

  let patched = null
  if (options.patch) {
    const patchPath = resolve(options.patch)
    const existing = (await exists(patchPath)) ? await readJson(patchPath, 'fidelity-input.json') : { schemaVersion: 1 }
    assert(existing && typeof existing === 'object' && !Array.isArray(existing), 'fidelity-input.json must be a JSON object')
    await atomicJson(patchPath, { ...existing, anchorCheck: { status, evidenceRef } }, io)
    patched = patchPath
  }

  return {
    status,
    record: {
      schemaVersion: 1,
      command: 'anchor-check',
      status,
      anchorCheck: { status, evidenceRef },
      typesMatch: evidence.typesMatch,
      detail: evidence.detail,
      reference: evidence.reference,
      statement: { declName: evidence.statement.declName, statementTypeText: evidence.statement.statementTypeText },
      evidencePath,
      patchedInput: patched,
      checkedAt: evidence.checkedAt,
    },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = [
  'anchor-check — kernel-checked reference-anchor equivalence (design §4.3 row 2)',
  'usage: anchor-check.mjs --problem <dir> --env <env-dir> --reference <reference.lean> --reference-decl <name>',
  '                        [--out <evidence.json>] [--patch <fidelity-input.json>] [--build-dir <dir>] [--timeout-ms n]',
  '  compares the RECORDED statement type (binding.json statementTypeText, from lean-run --statement-check)',
  '  against the elaborated type of the reference declaration, by Inspector definitional equality',
  '  status: passes | fails (kernel evidence of a mismatch) | cannot-run (no verdict: infra, row 4)',
  '  --patch   writes {anchorCheck:{status,evidenceRef}} into the gate input file',
  'exit codes: 0 outcome recorded (passes/fails/cannot-run) · 2 blocked (config-invalid, receipt-invalid, toolchain-missing) · single-line JSON on stdout',
].join('\n')

async function handle(argv, deps = {}) {
  const options = parseFlags(argv, ['problem', 'env', 'reference', 'reference-decl', 'out', 'patch', 'build-dir', 'timeout-ms'], { required: ['problem', 'env', 'reference', 'reference-decl'] })
  if (options.help) return 'help'
  await ensureWritable(options.problem)
  const timeoutMs = options['timeout-ms'] === undefined ? null : Number(options['timeout-ms'])
  if (timeoutMs !== null && (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000)) fail('config-invalid', '--timeout-ms must be an integer in 1000..1800000')
  const result = await runAnchorCheck({
    problem: options.problem,
    env: options.env,
    reference: options.reference,
    referenceDecl: options['reference-decl'],
    out: options.out ?? null,
    patch: options.patch ?? null,
    buildDir: options['build-dir'] ?? null,
    timeoutMs,
  }, deps)
  return { exitCode: 0, report: result.record }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  return runCli('anchor-check', HELP, argv, (args => handle(args, deps)))
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
