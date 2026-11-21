import * as fs from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { atomicJson, atomicWrite, ensureWritable, exists, fail, parseFlags, readJson, runCli } from './storage.lib.mjs'
import { validateRunManifest } from './run-manifest.lib.mjs'
import { initLedger } from './budget-ledger.mjs'

// Run-directory initializer (design §9.1): creates the strict-schema
// `.math/runs/<run-id>/` skeleton — run-manifest.json (validated, defaults
// materialized), problems/, population/, claims.jsonl, budget.json (via the
// budget ledger's own init so caps come from the manifest), evidence/ and a
// report.md stub. Refuses to reinit over an existing run (never clobbers).

const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export async function initRun(runsRoot, runId, manifestRaw, { createdAt = new Date().toISOString(), io = fs } = {}) {
  if (!RUN_ID.test(runId ?? '')) fail('config-invalid', 'run-id must match ^[a-z0-9][a-z0-9-]{0,63}$')
  const merged = { ...(manifestRaw && typeof manifestRaw === 'object' ? manifestRaw : {}), createdAt: manifestRaw?.createdAt ?? createdAt }
  const result = validateRunManifest(merged)
  if (!result.ok) fail('config-invalid', `run manifest is invalid: ${result.errors.join('; ')}`)
  const runDir = join(resolve(runsRoot), runId)
  if (await exists(join(runDir, 'run-manifest.json'))) fail('config-invalid', `run ${runId} already exists at ${runDir}; refusing to reinitialize`)
  await io.mkdir(runDir, { recursive: true })
  for (const dir of ['problems', 'population', 'evidence']) await io.mkdir(join(runDir, dir), { recursive: true })
  await atomicJson(join(runDir, 'run-manifest.json'), result.value, io)
  await atomicWrite(join(runDir, 'claims.jsonl'), '', io)
  await atomicWrite(join(runDir, 'report.md'), `# Run ${runId}\n\n_Goal:_ ${result.value.goal}\n\nClaims and receipt verification results are recorded here at close-out.\n`, io)
  const budget = await initLedger(runDir, { io })
  return {
    schemaVersion: 1,
    command: 'init-run',
    status: 'ok',
    runDir,
    runId,
    manifest: result.value,
    budget: { reused: budget.reused, cap: budget.cap },
  }
}

const HELP = [
  'init-run — create a .math/runs/<run-id>/ skeleton (design §9.1, strict schema)',
  'usage: init-run.mjs init --runs-root <dir> --run-id <id> [--manifest <run-manifest.json>]',
  '  --runs-root  directory that holds run directories (e.g. .math/runs)',
  '  --manifest   optional raw manifest JSON; validated strictly, unknown fields rejected, defaults materialized',
  'createdAt defaults to now; goal defaults to "-". exit codes: 0 ok · 2 config-invalid · single-line JSON on stdout',
].join('\n')

async function handle(argv) {
  const options = parseFlags(argv, ['runs-root', 'run-id', 'manifest'], { required: ['runs-root', 'run-id'] })
  if (options.help) return 'help'
  if (options.subcommand !== 'init') fail('config-invalid', 'subcommand must be init')
  await ensureWritable(options['runs-root'])
  const raw = options.manifest ? await readJson(options.manifest, 'manifest file') : { goal: '-' }
  return await initRun(options['runs-root'], options['run-id'], raw)
}

export async function main(argv = process.argv.slice(2)) {
  return runCli('init-run', HELP, argv, handle)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
