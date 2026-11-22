import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as fs from 'node:fs/promises'
import { exists, fail, mathRoot, parseFlags, readUtf8, runCli } from './storage.lib.mjs'
import { openSearchDb } from './sqlite.lib.mjs'

// Mathlib premise retrieval CLI (design §4.2, LeanDojo pattern):
//   mathlib-search.mjs --query "<shape or type fragment>" [--top N]
//                        [--kind theorem,def] [--imports <proof-or-statement.lean>]
//                        [--env <env-id> | --index <path>] [--json]
// FTS5 MATCH with BM25 ranking. Empty results are a legitimate empty array
// (exit 0). FTS5 syntax errors exit 2 with the raw sqlite error.
//
// Reachability (the corrected direction): with --imports F the reachable set
// is declarations whose defining module lies in the transitive import
// closure of F's OWN import set — { decl ∈ M | M ∈ imports*(imports(F)) } —
// computed over moduleEdges(importer, imported): a module reaches the modules
// it imports. The filter runs over the file's extensible import set: add an
// import to the file and re-retrieve to widen the reachable set. Without
// --imports no filter is applied and that is flagged in the output.

const TOP_DEFAULT = 20
const TOP_MAX = 200

/** Resolve the index path: explicit --index, else --env, else a unique index-*.sqlite in the math root. */
export async function resolveIndexPath({ index = null, env = null, root = mathRoot() } = {}) {
  if (index) return resolve(index)
  if (env) return join(root, `index-${env}.sqlite`)
  if (!(await exists(root))) fail('config-invalid', `no math state root at ${root}; build an index first`)
  const candidates = (await fs.readdir(root)).filter(name => /^index-.+\.sqlite$/.test(name))
  if (candidates.length === 0) fail('config-invalid', `no index-*.sqlite under ${root}; run mathlib-index.mjs first`)
  if (candidates.length > 1) fail('config-invalid', `multiple indexes under ${root}; disambiguate with --env <env-id>`)
  return join(root, candidates[0])
}

const IMPORT_LINE = /^[ \t]*import[ \t]+([A-Z][A-Za-z0-9_.']*)/gm
/** Parse a Lean file's own import set. */
export async function parseImports(filePath) {
  let text
  try { text = await readUtf8(filePath, `--imports file ${filePath}`) }
  catch (e) { if (e.code === 'ENOENT') fail('config-invalid', `--imports file ${filePath} does not exist`); throw e }
  const seeds = []
  for (const match of text.matchAll(IMPORT_LINE)) if (!seeds.includes(match[1])) seeds.push(match[1])
  return seeds
}

function buildQuery({ query, kinds, seeds, top }) {
  const params = [query]
  let sql = `SELECT d.name AS name, d.kind AS kind, d.module AS module, d.typeText AS typeText, bm25(decls_fts) AS rank
             FROM decls_fts JOIN decls d ON d.name = decls_fts.name
             WHERE decls_fts MATCH ?`
  if (kinds.length) {
    sql += ` AND d.kind IN (${kinds.map(() => '?').join(', ')})`
    params.push(...kinds)
  }
  if (seeds !== null) {
    // imports*(imports(F)): seeds reach what they (transitively) import.
    sql += ` AND d.module IN (WITH RECURSIVE reach(module) AS (
                SELECT value FROM json_each(?)
                UNION
                SELECT e.imported FROM moduleEdges e JOIN reach r ON e.importer = r.module
              ) SELECT module FROM reach)`
    params.push(JSON.stringify(seeds))
  }
  sql += ' ORDER BY rank, d.name LIMIT ?'
  params.push(top)
  return { sql, params }
}

export function search(db, { query, kinds = [], seeds = null, top = TOP_DEFAULT }) {
  const { sql, params } = buildQuery({ query, kinds, seeds, top })
  const rows = db.prepare(sql).all(...params)
  return rows.map(row => ({ name: row.name, kind: row.kind, module: row.module, typeText: row.typeText, rank: row.rank }))
}

const KIND_NAME = /^[a-z][a-z0-9-]*$/

async function handle(argv) {
  const options = parseFlags(argv, ['query', 'top', 'kind', 'imports', 'env', 'index', 'json'], { required: ['query'], booleans: ['json'] })
  if (options.help) return 'help'
  const top = options.top === undefined ? TOP_DEFAULT : Number(options.top)
  if (options.top !== undefined && (!Number.isInteger(top) || top < 1 || top > TOP_MAX || String(top) !== options.top.trim())) fail('config-invalid', `--top must be an integer in 1..${TOP_MAX}`)
  const kinds = (options.kind ?? '').split(',').map(kind => kind.trim()).filter(Boolean)
  for (const kind of kinds) if (!KIND_NAME.test(kind)) fail('config-invalid', `invalid --kind ${kind}`)
  let seeds = null
  let importsFile = null
  if (options.imports) {
    importsFile = options.imports
    seeds = await parseImports(importsFile)
  }
  const indexPath = await resolveIndexPath({ index: options.index ?? null, env: options.env ?? null })
  if (!(await exists(indexPath))) fail('config-invalid', `no index at ${indexPath}; run mathlib-index.mjs first`)
  const db = openSearchDb(indexPath)
  let results
  try { results = search(db, { query: options.query, kinds, seeds, top }) }
  catch (error) {
    // FTS5 syntax errors and other sqlite failures report the RAW error (§4.2).
    return { exitCode: 2, report: { schemaVersion: 1, command: 'mathlib-search', status: 'blocked', reason: { code: 'query-invalid', detail: String(error.message ?? error) }, query: options.query, results: [] } }
  } finally { db.close() }
  return {
    schemaVersion: 1,
    command: 'mathlib-search',
    status: 'ok',
    query: options.query,
    importsFilter: seeds === null ? { applied: false, note: 'no --imports filter: results span every indexed module' } : { applied: true, file: importsFile, imports: seeds },
    results,
  }
}

const HELP = [
  'mathlib-search — FTS5 premise retrieval over the Mathlib index (design §4.2)',
  'usage: mathlib-search.mjs --query "<shape or type fragment>" [--top N] [--kind theorem,def] [--imports <file.lean>] [--env <env-id> | --index <path>] [--json]',
  '  --imports  restrict to declarations reachable through THAT FILE\'s transitive import closure',
  'empty results exit 0 with an empty array; FTS5 syntax errors exit 2 with the raw error; single-line JSON on stdout',
].join('\n')

export async function main(argv = process.argv.slice(2)) {
  return runCli('mathlib-search', HELP, argv, handle)
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await main()
