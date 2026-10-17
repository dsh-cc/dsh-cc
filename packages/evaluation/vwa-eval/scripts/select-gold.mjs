#!/usr/bin/env node
/**
 * select-gold.mjs — deterministic gold-set selection (VWA plan §8).
 *
 * Sample: exactly 30 documents from this repo — ~15 from docs/** and ~15
 * package READMEs (packages/<group>/<pkg>/README.md). Stratified, with a
 * size mix inside each stratum: candidates are sorted by byte size and
 * picked at even strides, then the final list is re-sorted by path.
 * All sorts are plain code-unit comparisons (never localeCompare) so the
 * list is stable across machines and locales.
 *
 * Modes:
 *   default   — print the selection as JSON to stdout;
 *   --write   — re-select from the live repo, write
 *               packages/evaluation/vwa-eval/gold-set.json AND snapshot each
 *               selected document into fixtures/gold/<path> (replacing the
 *               previous snapshot);
 *   --check   — verify the committed gold-set.json against the committed
 *               SNAPSHOT only (exactly 30 entries, 15 docs + 15 READMEs,
 *               every fixtures/gold/<path> present with matching sha256 and
 *               byte count, no stray snapshot files). Live docs/ and READMEs
 *               are deliberately NOT consulted: adding, editing or deleting a
 *               repo document must never turn this check red. Re-pinning is
 *               an explicit `--write`.
 *
 * Pure node stdlib, regex-free selection.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const PKG = join(ROOT, 'packages', 'evaluation', 'vwa-eval')
const OUT = join(PKG, 'gold-set.json')
const SNAP = join(PKG, 'fixtures', 'gold')
const DOCS_N = 15
const README_N = 15

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function* walk(dir, skip) {
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p, skip)
    else yield p
  }
}

/** Even-stride pick of n entries from a size-sorted list (deterministic). */
function stridePick(sorted, n) {
  if (sorted.length <= n) return [...sorted]
  const picked = []
  for (let i = 0; i < n; i++) {
    picked.push(sorted[Math.floor((i * sorted.length) / n)])
  }
  return picked
}

function select() {
  // Exclude this evaluation slice's own artifacts so pinning the gold set
  // does not perturb the selection itself.
  const docs = [...walk(join(ROOT, 'docs'), new Set(['vwa']))].sort()
  // Package READMEs: exactly packages/<group>/<pkg>/README.md.
  const pkgReadmes = [...walk(join(ROOT, 'packages'), new Set(['node_modules', 'lib']))]
    .filter((p) => {
      if (p.startsWith(PKG)) return false
      const rel = relative(join(ROOT, 'packages'), p).split(sep)
      return rel.length === 3 && rel[2] === 'README.md'
    })

  const byBytes = (p) => statSync(p).size
  const pickDocs = stridePick([...docs].sort((a, b) => byBytes(a) - byBytes(b) || (a < b ? -1 : 1)), DOCS_N)
  const pickReadmes = stridePick([...pkgReadmes].sort((a, b) => byBytes(a) - byBytes(b) || (a < b ? -1 : 1)), README_N)

  return [...pickDocs, ...pickReadmes]
    .sort()
    .map((p) => ({ path: relative(ROOT, p).split(sep).join('/'), sha256: sha256(p), bytes: statSync(p).size }))
}

function check() {
  if (!existsSync(OUT)) {
    console.error(`check FAILED: ${relative(ROOT, OUT)} does not exist`)
    process.exit(1)
  }
  const committed = JSON.parse(readFileSync(OUT, 'utf8'))
  const problems = []
  if (committed.length !== DOCS_N + README_N) problems.push(`expected ${DOCS_N + README_N} entries, got ${committed.length}`)
  const docsN = committed.filter((e) => e.path.startsWith('docs/')).length
  if (docsN !== DOCS_N) problems.push(`expected ${DOCS_N} docs/** entries, got ${docsN}`)
  const paths = committed.map((e) => e.path)
  if ([...paths].sort().join('\n') !== paths.join('\n')) problems.push('gold-set.json is not sorted by path')
  for (const e of committed) {
    const p = join(SNAP, e.path)
    if (!existsSync(p)) { problems.push(`snapshot missing: fixtures/gold/${e.path}`); continue }
    if (sha256(p) !== e.sha256) problems.push(`sha256 MISMATCH (snapshot edited): fixtures/gold/${e.path}`)
    if (statSync(p).size !== e.bytes) problems.push(`bytes changed: fixtures/gold/${e.path}`)
  }
  const pinned = new Set(paths)
  if (existsSync(SNAP)) {
    for (const p of walk(SNAP, new Set())) {
      const rel = relative(SNAP, p).split(sep).join('/')
      if (!pinned.has(rel)) problems.push(`stray snapshot file not in gold-set.json: fixtures/gold/${rel}`)
    }
  }
  if (problems.length) {
    console.error(`gold-set check FAILED (${problems.length} problem(s)):`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error('  re-pin deliberately with: node packages/evaluation/vwa-eval/scripts/select-gold.mjs --write')
    process.exit(1)
  }
  console.log(`gold-set check OK: ${committed.length} entries, all sha256s match the fixtures/gold snapshot`)
}

function write() {
  const sel = select()
  rmSync(SNAP, { recursive: true, force: true })
  for (const e of sel) {
    const dest = join(SNAP, e.path)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(join(ROOT, e.path), dest)
  }
  writeFileSync(OUT, JSON.stringify(sel, null, 2) + '\n')
  console.log(`wrote ${relative(ROOT, OUT)} + ${sel.length} snapshot files under ${relative(ROOT, SNAP)}`)
}

const mode = process.argv[2] ?? ''
if (mode === '--check') check()
else if (mode === '--write') write()
else console.log(JSON.stringify(select(), null, 2))
