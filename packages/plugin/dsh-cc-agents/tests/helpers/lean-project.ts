// Shared Lean fixture project and proof-evidence helper: builds a temporary
// project from the committed fixture (model plus a real bound implementation) and
// publishes a strict proof package so conformance/audit tests can start from a
// fresh, verified run without paying for a real build.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  EMPTY_SHA256, proofInputDigest, proofInputFiles, publishProof, runnerDigest, runnerFiles, runnerPackage, validateProofEvidence,
} from '../../skills/formal-design/scripts/lean-evidence.lib.mjs'
import { loadToolchain, sha256 } from '../../skills/formal-design/scripts/lean-fingerprint.lib.mjs'
import { parseLeanManifest } from '../../skills/formal-design/scripts/lean-manifest.lib.mjs'

export const FIXTURES = join(import.meta.dirname, '../fixtures/formal-design-lean')
export const SKILL = join(import.meta.dirname, '../../skills/formal-design')
export const MODEL = 'specs/lean/budget-reservation'
export const MODEL_ID = 'budget-reservation'

/** Copy the fixture project into `root`, optionally with the known-bad mutant. */
export async function fixtureProject(root: string, { mutant = false } = {}) {
  await cp(join(FIXTURES, 'project/specs'), join(root, 'specs'), { recursive: true })
  await cp(join(FIXTURES, 'project/packages'), join(root, 'packages'), { recursive: true })
  await cp(join(FIXTURES, 'project/package.json'), join(root, 'package.json'))
  if (mutant) await cp(join(FIXTURES, 'mutants/budget-omits-guard.ts'), join(root, 'packages/example/src/budget.ts'))
  return root
}

export async function toolchainRecord() {
  const pin = await loadToolchain()
  return {
    toolchain: pin.toolchain,
    platform: 'darwin-arm64',
    // The pin's archive hash keeps synthetic evidence auditable; the content
    // digest is only recomputed by preflight, not by the read-only auditor.
    archiveSha256: pin.platforms['darwin-arm64'].sha256,
    contentDigest: 'd'.repeat(64),
    version: '4.35.0',
  }
}

export function verifiedReport(manifest: any) {
  return {
    schemaVersion: 1,
    toolchainVersion: '4.35.0',
    properties: manifest.properties.map((property: any) => ({
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

/**
 * Publish a strict proof evidence package (default: verified) for the fixture
 * model so a conformance run has its prerequisites. Returns the evidence object.
 */
export async function publishFixtureProof(root: string, { verdict = 'verified' } = {}) {
  const modelDir = join(root, MODEL)
  const manifest = parseLeanManifest(await readFile(join(modelDir, 'checks.json'), 'utf8'))
  const inputFiles = await proofInputFiles(modelDir)
  const inputDigest = proofInputDigest(inputFiles)
  const runnerEntries = await runnerFiles(SKILL)
  const runId = randomUUID()
  const runDir = join(root, '.formal-design/lean', MODEL_ID, runId)
  const stream = (id: string, name: string) => ({ path: `.formal-design/lean/${MODEL_ID}/${runId}/${id}/${name}`, bytes: 0, sha256: EMPTY_SHA256 })
  const phase = async (id: string, report: any = null) => {
    const dir = join(runDir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'stdout.log'), '')
    await writeFile(join(dir, 'stderr.log'), '')
    return {
      id, argv: [id], exitCode: 0, signal: null, timedOut: false, cancelled: false, overflowed: false,
      stdout: stream(id, 'stdout.log'), stderr: stream(id, 'stderr.log'), report,
    }
  }
  const report = verdict === 'verified'
    ? verifiedReport(manifest)
    : {
        schemaVersion: 1,
        toolchainVersion: '4.35.0',
        properties: manifest.properties.map((property: any) => ({
          id: property.id, declaration: property.declaration, kind: null, statementType: null,
          theoremType: null, typesMatch: null, axioms: null, witness: null, verdict: 'not-checked',
        })),
      }
  const properties = report.properties
  const phases = []
  for (const id of ['compile-model', 'compile-properties', 'compile-reference', 'compile-inspector', 'driver']) phases.push(await phase(id))
  const inspectorPhase = await phase('inspector')
  if (verdict === 'verified') {
    const bytes = Buffer.from(JSON.stringify(report) + '\n')
    const path = join(runDir, 'inspector', 'inspector-report.json')
    await writeFile(path, bytes)
    inspectorPhase.report = { path: `.formal-design/lean/${MODEL_ID}/${runId}/inspector/inspector-report.json`, bytes: bytes.length, sha256: sha256(bytes) }
  }
  phases.push(inspectorPhase)
  const startedAt = new Date(Date.now() - 1000).toISOString()
  const evidence: any = {
    schemaVersion: 1,
    backend: 'lean',
    modelId: MODEL_ID,
    runId,
    inputFiles,
    inputDigest,
    runnerFiles: runnerEntries,
    runnerDigest: runnerDigest(runnerEntries),
    runnerPackage: await runnerPackage(),
    toolchain: await toolchainRecord(),
    proofVerdict: verdict,
    reason: verdict === 'verified' ? null : { code: 'output-invalid', detail: { phase: 'inspector', message: 'fixture rejection' } },
    properties,
    phases,
    startedAt,
    finishedAt: new Date().toISOString(),
  }
  validateProofEvidence(evidence, manifest)
  await publishProof({ modelDir, runDir, evidence })
  return evidence
}
