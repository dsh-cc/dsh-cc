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
 *   --write   — write packages/evaluation/vwa-eval/gold-set.json;
 *   --check   — verify the committed gold-set.json matches a fresh run:
 *               same paths, same sha256, same byte counts. Any file that
 *               changed since pinning fails LOUDLY with its path.
 *
 * Pure node stdlib, regex-free selection.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const OUT = join(ROOT, 'packages', 'evaluation', 'vwa-eval', 'gold-set.json')
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
      if (p.startsWith(join(ROOT, 'packages', 'evaluation', 'vwa-eval'))) return false
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
  const fresh = select()
  const problems = []
  const committedMap = new Map(committed.map((e) => [e.path, e]))
  const freshMap = new Map(fresh.map((e) => [e.path, e]))
  for (const [path, e] of freshMap) {
    const old = committedMap.get(path)
    if (!old) problems.push(`missing from committed gold set: ${path}`)
    else {
      if (old.sha256 !== e.sha256) problems.push(`sha256 MISMATCH (file changed since pinning): ${path}`)
      if (old.bytes !== e.bytes) problems.push(`bytes changed: ${path}`)
    }
  }
  for (const path of committedMap.keys()) {
    if (!freshMap.has(path)) problems.push(`no longer selected (selection rule or repo changed): ${path}`)
  }
  if (problems.length) {
    console.error(`gold-set check FAILED (${problems.length} problem(s)):`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log(`gold-set check OK: ${fresh.length} entries, all sha256s match live files`)
}

const mode = process.argv[2] ?? ''
if (mode === '--check') check()
else if (mode === '--write') {
  writeFileSync(OUT, JSON.stringify(select(), null, 2) + '\n')
  console.log(`wrote ${relative(ROOT, OUT)}`)
} else console.log(JSON.stringify(select(), null, 2))
