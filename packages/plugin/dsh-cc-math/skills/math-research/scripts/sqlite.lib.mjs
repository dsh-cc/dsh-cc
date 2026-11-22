import { fail } from './storage.lib.mjs'

// node:sqlite wrapper for the Mathlib declaration index (design §4.2).
// node:sqlite ships in Node 22.5+ (experimental) and FTS5 is verified on
// Node 24; the harness contract (§3.2, risk 9) is to FEATURE-DETECT FTS5 at
// startup and fail closed with a version diagnostic rather than produce a
// half-built index.

export function requireSqlite() {
  let sqlite
  try { sqlite = require_database() } catch { fail('config-invalid', diagnostic('node:sqlite is unavailable')) }
  return sqlite
}
// Indirection so the absence diagnostic names the requirement once.
function require_database() {
  // eslint-disable-next-line unicorn/prefer-module -- dynamic import of a builtin kept sync via node internals is unavailable; process.getBuiltinModule is stable in Node 22.3+.
  const load = process.getBuiltinModule?.bind(process)
  if (!load) throw new Error('getBuiltinModule unavailable')
  return load('node:sqlite')
}

const diagnostic = missing =>
  `${missing}: this script needs Node 24 (or Node >=22.5 with node:sqlite compiled with FTS5); detected ${process.version}`

/** Open (or create) a database after proving FTS5 works in this build. */
export function openSearchDb(path) {
  const { DatabaseSync } = requireSqlite()
  let db
  try { db = new DatabaseSync(path) }
  catch (e) { fail('io', `could not open index ${path}: ${e.message}`) }
  try {
    db.exec('CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x)')
    db.exec('DROP TABLE temp.__fts5_probe')
  } catch { fail('config-invalid', diagnostic('SQLite FTS5 is unavailable')) }
  return db
}
