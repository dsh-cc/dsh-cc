#!/usr/bin/env node
// write-build-fingerprints.mjs — record what each package's lib/ was BUILT from.
//
// The profile sync (scripts/sync-local-profile.sh) copies lib/ into the
// profile pool and stamps the pool with the sync-time git commit. A checkout
// that was pulled but not rebuilt therefore ships OLD code labeled as the new
// commit (real incident, 2026-11-02: a pre-migration session-cwd lost the
// {{cwd}} prompt-variable registration and every main-conversation turn
// failed at system-prompt assembly). mtime cannot gate this — a content-clean
// rebuild skips rewriting outputs — so the build itself records a fingerprint
// of the exact sources it compiled, and the sync compares it before copying.
//
// For every packages/*/*/ that has both src/ and lib/, write
// lib/.dsh-cc-build-fingerprint holding the SHA-256 over the package's
// sources (src/** plus package.json; relative paths and contents both
// hashed, order-stable). The file is inert to runtime resolution.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const repoRoot = join(new URL('..', import.meta.url).pathname)

/** Order-stable source fingerprint for one package directory. */
function fingerprint(pkgDir) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'lib') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.push(full)
    }
  }
  walk(join(pkgDir, 'src'))
  files.push(join(pkgDir, 'package.json'))
  files.sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(relative(pkgDir, file))
    hash.update('\0')
    hash.update(createHash('sha256').update(readFileSync(file)).digest('hex'))
    hash.update('\0')
  }
  return hash.digest('hex')
}

let written = 0
for (const group of readdirSync(join(repoRoot, 'packages'))) {
  const groupDir = join(repoRoot, 'packages', group)
  if (!statSync(groupDir).isDirectory()) continue
  for (const name of readdirSync(groupDir)) {
    const pkgDir = join(groupDir, name)
    if (!existsSync(join(pkgDir, 'package.json'))) continue
    if (!existsSync(join(pkgDir, 'src'))) continue
    if (!existsSync(join(pkgDir, 'lib'))) continue // never built: the sync's existing no-lib path owns that case
    writeFileSync(
      join(pkgDir, 'lib', '.dsh-cc-build-fingerprint'),
      `${fingerprint(pkgDir)}\n`,
    )
    written += 1
  }
}
console.log(`write-build-fingerprints: recorded ${written} package fingerprints`)
