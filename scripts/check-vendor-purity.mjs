#!/usr/bin/env node
/**
 * check-vendor-purity.mjs — the vendored pi-tui renderer must stay pure:
 * 1. packages/ui/pi-tui/** imports nothing outside its own tree beyond its two
 *    declared npm deps (marked, get-east-asian-width) and node builtins.
 * 2. packages/ui/pi-tui/src/** is byte-identical to the VENDOR_MANIFEST.json
 *    recorded at the last re-vendor, so local edits to the vendored source fail
 *    the gate (the manifest records the upstream SHA pinned in PORTING.md).
 * Exit 0 when clean; lists offending files and exits 1 otherwise.
 *
 * Re-vendor flow: bump the SHA in PORTING.md, replace src/, then run
 *   node scripts/check-vendor-purity.mjs --update-manifest --upstream-sha <new-sha>
 * and commit the regenerated manifest together with the new source.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = join(ROOT, 'packages', 'ui', 'pi-tui')
const SRC = join(PKG, 'src')
const MANIFEST_PATH = join(PKG, 'VENDOR_MANIFEST.json')
const PORTING_PATH = join(PKG, 'PORTING.md')
const UPSTREAM_REPO = 'https://github.com/earendil-works/pi'

const args = process.argv.slice(2)
const updateManifest = args.includes('--update-manifest')
const shaArgIndex = args.indexOf('--upstream-sha')

if (!existsSync(SRC)) {
  console.log('check:vendor-purity — no packages/ui/pi-tui/src, skipping')
  process.exit(0)
}

const ALLOWED_BARE = new Set(['marked', 'get-east-asian-width'])
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(m => `node:${m.replace(/^node:/, '')}`)])

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) yield p
  }
}

function* walkAll(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) yield* walkAll(p)
    else yield p
  }
}

const IMPORT_RE = /(?:\bimport\b[^'";]*?|\bexport\b[^'";]*?\bfrom\s*)\bfrom\s*['"]([^'"]+)['"]|(?:\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g

const problems = []

// --- Part 1: import purity -------------------------------------------------
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2]
    if (spec === undefined) continue
    if (spec.startsWith('.') || spec.startsWith('#')) continue
    if (BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0])) continue
    const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (!ALLOWED_BARE.has(pkgName)) {
      problems.push(`${relative(SRC, file)} imports disallowed specifier "${spec}"`)
    }
  }
}

// --- Part 2: byte-identity against the recorded manifest -------------------
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** SHA pinned in PORTING.md's "Upstream SHA at vendor time" line. */
function portingSha() {
  const text = readFileSync(PORTING_PATH, 'utf8')
  const match = text.match(/Upstream SHA at vendor time\**: `([0-9a-f]+)`/)
  return match?.[1] ?? null
}

const treeHashes = new Map()
for (const file of walkAll(SRC)) {
  treeHashes.set(relative(SRC, file), sha256(file))
}

if (updateManifest) {
  if (shaArgIndex === -1 || !args[shaArgIndex + 1]) {
    console.error(
      'check:vendor-purity — --update-manifest requires --upstream-sha <sha> ' +
      '(the upstream commit the vendored src/ was taken from, as pinned in PORTING.md)',
    )
    process.exit(1)
  }
  const upstreamSha = args[shaArgIndex + 1]
  const manifest = {
    upstream: { repo: UPSTREAM_REPO, sha: upstreamSha },
    files: Object.fromEntries([...treeHashes.entries()].sort(([a], [b]) => a.localeCompare(b))),
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`check:vendor-purity — manifest regenerated for ${treeHashes.size} files at upstream sha ${upstreamSha}`)
  console.log('Commit it together with the vendored source and the PORTING.md SHA bump.')
  process.exit(0)
}

if (!existsSync(MANIFEST_PATH)) {
  problems.push(
    'VENDOR_MANIFEST.json is missing — regenerate it with ' +
    '`node scripts/check-vendor-purity.mjs --update-manifest --upstream-sha <sha>` (see PORTING.md)',
  )
} else {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const manifestFiles = manifest.files ?? {}
  const porting = portingSha()
  if (porting && manifest.upstream?.sha !== porting) {
    problems.push(
      `VENDOR_MANIFEST.json records upstream sha ${manifest.upstream?.sha ?? '<none>'} but PORTING.md pins ${porting} — ` +
      'regenerate the manifest at re-vendor time (they must be committed together)',
    )
  }
  for (const [rel, expected] of Object.entries(manifestFiles)) {
    const actual = treeHashes.get(rel)
    if (actual === undefined) problems.push(`${rel} is in VENDOR_MANIFEST.json but missing from src/`)
    else if (actual !== expected) problems.push(`${rel} was modified (expected sha256 ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`)
  }
  for (const rel of treeHashes.keys()) {
    if (!(rel in manifestFiles)) problems.push(`${rel} is not in VENDOR_MANIFEST.json — add it via --update-manifest at re-vendor time`)
  }
}

if (problems.length > 0) {
  console.error('check:vendor-purity — vendored pi-tui must stay pure:\n')
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log('check:vendor-purity — clean')
