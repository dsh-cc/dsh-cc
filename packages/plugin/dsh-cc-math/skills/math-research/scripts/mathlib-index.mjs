import { realpathSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fail, hashFile, mathRoot, parseFlags, platformKey, readJson, readUtf8, runCli, SCRIPTS_DIR } from './storage.lib.mjs'
import { openSearchDb } from './sqlite.lib.mjs'

// Mathlib declaration index (design §4.2): runs Dumper.lean inside the env's
// wrapper project, parses its JSONL (declaration lines AND per-module import
// edges — reachability needs edges, direction `importer` = the module whose
// source contains the import), and builds `index-<env-id>.sqlite`:
//   decls(name PK, kind, module, typeText), modules(module PK),
//   moduleEdges(importer, imported), decls_fts FTS5(name, typeText)
// Idempotent per env receipt: a meta row pins the receipt digest and a
// matching digest reuses the index untouched.

export function indexPathFor(envId, { root = mathRoot() } = {}) {
  return join(root, `index-${envId}.sqlite`)
}

const SCHEMA = `
CREATE TABLE decls (name TEXT PRIMARY KEY, kind TEXT NOT NULL, module TEXT NOT NULL, typeText TEXT NOT NULL);
CREATE TABLE modules (module TEXT PRIMARY KEY);
CREATE TABLE moduleEdges (importer TEXT NOT NULL, imported TEXT NOT NULL, PRIMARY KEY (importer, imported));
CREATE VIRTUAL TABLE decls_fts USING fts5(name, typeText);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/** Parse Dumper output: decl lines {name, kind, module, typeText} and edge lines {module, imports: [...]}. */
export function parseDump(text) {
  const decls = []
  const edges = []
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) }
    catch { fail('output-invalid', `dumper output line ${index + 1} is not valid JSON`) }
    if (Array.isArray(record.imports) && typeof record.module === 'string') edges.push(record)
    else if (typeof record.name === 'string' && typeof record.kind === 'string' && typeof record.module === 'string' && typeof record.typeText === 'string') decls.push(record)
    else fail('output-invalid', `dumper output line ${index + 1} matches neither the declaration nor the edge shape`)
  }
  return { decls, edges }
}

export function buildIndex(db, { decls, edges }, metaEntries) {
  const insertDecl = db.prepare('INSERT INTO decls (name, kind, module, typeText) VALUES (?, ?, ?, ?)')
  const insertFts = db.prepare('INSERT INTO decls_fts (name, typeText) VALUES (?, ?)')
  const insertModule = db.prepare('INSERT OR IGNORE INTO modules (module) VALUES (?)')
  const insertEdge = db.prepare('INSERT OR IGNORE INTO moduleEdges (importer, imported) VALUES (?, ?)')
  const insertMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
  db.exec('BEGIN')
  for (const edge of edges) {
    insertModule.run(edge.module)
    for (const imported of edge.imports) {
      if (typeof imported !== 'string') fail('output-invalid', `edge for ${edge.module} has a non-string import`)
      insertModule.run(imported)
      insertEdge.run(edge.module, imported)
    }
  }
  for (const decl of decls) {
    insertDecl.run(decl.name, decl.kind, decl.module, decl.typeText)
    insertFts.run(decl.name, decl.typeText)
    insertModule.run(decl.module)
  }
  for (const [key, value] of Object.entries(metaEntries)) insertMeta.run(key, value)
  db.exec('COMMIT')
  return { decls: decls.length, edges: edges.reduce((count, edge) => count + edge.imports.length, 0), modules: edges.length }
}

// Default dumper invocation: stage Dumper.lean into the env's wrapper and run
// it through `lake env lean --run`; it writes dumper-output.jsonl in the cwd.
async function defaultRunDumper(envDir) {
  const { spawn } = await import('node:child_process')
  const wrapper = join(envDir, 'wrapper')
  if (!(await isFile(join(wrapper, 'lakefile.lean')))) fail('toolchain-missing', `env at ${envDir} has no wrapper project`)
  await fs.copyFile(join(SCRIPTS_DIR, 'Dumper.lean'), join(wrapper, 'Dumper.lean'))
  const lake = join(envDir, 'lean', 'bin', 'lake')
  const result = await new Promise(resolveRun => {
    const child = spawn(lake, ['env', 'lean', '--run', 'Dumper.lean'], { cwd: wrapper, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', e => resolveRun({ exitCode: null, error: e.message, stdout, stderr }))
    child.once('close', exitCode => resolveRun({ exitCode, stdout, stderr }))
  })
  if (result.exitCode !== 0) fail('io', `Dumper.lean failed: ${(result.stderr || result.error || '').trim().slice(0, 400)}`)
  return readUtf8(join(wrapper, 'dumper-output.jsonl'), 'dumper output')
}
async function isFile(path) { try { return (await fs.stat(path)).isFile() } catch { return false } }

export async function indexEnv({ envDir, indexPath, jsonlPath = null }, deps = {}) {
  const { runDumper = defaultRunDumper, now = () => new Date().toISOString() } = deps
  const receiptFile = join(envDir, 'env.receipt.json')
  if (!(await isFile(receiptFile))) fail('receipt-invalid', `no env receipt at ${receiptFile}; provision the environment first`)
  const receipt = await readJson(receiptFile, 'env receipt')
  const envId = receipt.envId
  if (typeof envId !== 'string' || !envId) fail('receipt-invalid', 'env receipt has no envId')
  const receiptDigest = await hashFile(receiptFile)
  const target = indexPath ?? indexPathFor(envId)

  // Idempotence per receipt (§4.2): a matching digest reuses the index.
  if (await isFile(target)) {
    let reused = null
    try {
      const db = openSearchDb(target)
      try {
        const existing = db.prepare('SELECT value FROM meta WHERE key = ?').get('receiptDigest')
        if (existing?.value === receiptDigest) reused = db.prepare('SELECT count(*) AS n FROM decls').get().n
      } finally { db.close() }
    } catch (error) {
      // A missing schema or non-index database simply rebuilds; the FTS5
      // feature-detect failure is a hard diagnostic and must not be swallowed.
      if (error.code === 'config-invalid') throw error
    }
    if (reused !== null) return { schemaVersion: 1, command: 'mathlib-index', status: 'reused', envId, indexPath: resolve(target), decls: reused, receiptDigest }
  }
  const dumpText = jsonlPath ? await readUtf8(jsonlPath, 'dumper JSONL') : await runDumper(envDir)
  const parsed = parseDump(dumpText)
  await fs.rm(target, { force: true })
  await fs.mkdir(dirname(target), { recursive: true })
  const db = openSearchDb(target)
  try {
    db.exec(SCHEMA)
    const counts = buildIndex(db, parsed, { envId, receiptDigest, builtAt: now(), platform: platformKey() ?? 'unknown' })
    return { schemaVersion: 1, command: 'mathlib-index', status: 'fresh', envId, indexPath: resolve(target), receiptDigest, ...counts }
  } finally { db.close() }
}

const HELP = [
  'mathlib-index — build the declaration + import-edge SQLite index (design §4.2)',
  'usage: mathlib-index.mjs build --env <env-dir> [--index <path>] [--jsonl <dump.jsonl>]',
  '  --env    env dir containing env.receipt.json (index identity = receipt digest)',
  '  --index  override index path (default <MATH_HOME|.math>/index-<env-id>.sqlite)',
  '  --jsonl  consume a pre-produced Dumper JSONL instead of running Dumper.lean (fixtures/tests)',
  'exit codes: 0 ok · 2 blocked (config-invalid, receipt-invalid, output-invalid, io) · single-line JSON on stdout',
].join('\n')

async function handle(argv) {
  const options = parseFlags(argv, ['env', 'index', 'jsonl'])
  if (options.help) return 'help'
  if (options.subcommand !== 'build') fail('config-invalid', 'subcommand must be build')
  if (!options.env) fail('config-invalid', '--env is required')
  return await indexEnv({ envDir: options.env, indexPath: options.index ?? null, jsonlPath: options.jsonl ?? null })
}

export async function main(argv = process.argv.slice(2)) {
  return runCli('mathlib-index', HELP, argv, handle)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
